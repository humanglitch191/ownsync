import { type App, type EventRef, Events, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, debounce, apiVersion, normalizePath, requestUrl, setIcon } from "obsidian";
import { say } from "./notice";
import { cleanName, deviceNames } from "./collab";
import { docTag, hex, randomBytes, sha256 } from "../../protocol/ownsync";
import { Engine } from "./core/engine";
import { RecoverModal, chooseFork, createVault, removeDevice, replaceRecovery } from "./devices";
import { installConflictNotice } from "./conflicts";
import { installHistory } from "./history";
import { createHistoryBackup, type HistoryBackupDeps } from "./historyBackup";
import { redactProblem } from "./diagnostics";
import { Editors, editorBinding } from "./editors";
import { IdbStore } from "./idbStore";
import { type KeyPorts, type KeyState, VaultKeys, shortId } from "./keys";
import { noteUrl, parseOpenLink, parseSetupLink, trimHost } from "./links";
import { handlePairLink, showPairingCode } from "./pairing";
import { SetupModal, openDashboard } from "./setup";
import { createSnapshots } from "./snapshots";
import { installSnapshots, snapshotSettings } from "./snapshotsView";
import { type Status, Transport } from "./transport";
import { VaultDisk } from "./vaultDisk";

type State = Status | "not set up" | "starting";
const STATUS_ICON: Record<State, string> = {
	"not set up": "circle-dashed",
	starting: "refresh-cw",
	connecting: "refresh-cw",
	"catching up": "refresh-cw",
	synced: "circle-check",
	offline: "cloud-off",
	unauthorized: "circle-alert",
	"needs owner code": "circle-alert",
	removed: "circle-alert",
	frozen: "circle-alert",
	deleted: "circle-alert",
};
/** The states only leaving the vault gets out of. */
const STUCK: State[] = ["unauthorized", "needs owner code", "deleted"];
const STATUS_TEXT: Record<State, string> = {
	"not set up": "not set up",
	starting: "starting",
	connecting: "connecting",
	"catching up": "catching up",
	synced: "synced",
	offline: "offline",
	unauthorized: "the Worker rejected this vault's key",
	"needs owner code": "the Worker refused this vault's code",
	removed: "this device was removed from the vault",
	frozen: "paused: choose between two changes to the device list",
	deleted: "deleted on the Worker",
};

/** One running sync for the vault: its database, keys, the engine, the editors and the connection. */
interface Session {
	keys: VaultKeys;
	engine: Engine;
	editors: Editors;
	transport: Transport;
	historyBackup: ReturnType<typeof createHistoryBackup>;
	snapshots: ReturnType<typeof createSnapshots>;
	stop(): Promise<void>;
}

export default class OwnsyncPlugin extends Plugin {
	// createdHere: the vault this device created. Only then does it send the Worker's owner code: pairing joins a
	// vault and must never create one, or a pairing link could make it upload notes under someone else's key.
	// welcomed: the setup screen opened by itself once, on the first start.
	settings = { host: "", vaultId: "", deviceName: "", createdHere: "", maxFileMB: 20, attachments: true, backUpHistoryToWorker: true, snapshots: false, snapshotsOffered: false, welcomed: false, skipUpdate: "" };
	session: Session | null = null;
	status: State = "not set up";
	problems: string[] = []; // the most recent, newest last
	private statusEl!: HTMLElement;
	private ribbonEl!: HTMLElement;
	private snapshotSyncEvents = new Events();
	onStatusChange: (() => void) | null = null; // the open settings tab, if any

	// The key ring lives in Obsidian's secret storage, not in the vault folder, so it never ends up in iCloud,
	// Dropbox or git along with the notes.
	private ringId(vaultId: string): string {
		return `ownsync-ring-${vaultId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
	}

	hasKey(): boolean {
		return !!this.settings.vaultId && !!this.app.secretStorage.getSecret(this.ringId(this.settings.vaultId));
	}

	/** Shown next to this device's cursor on the others. It travels encrypted, like the notes. */
	/** Named while pairing ("Anna's iPhone 17 Pro"): shown next to its cursor and on the Worker's dashboard. */
	async setDeviceName(name: string): Promise<void> {
		this.settings.deviceName = name;
		await this.saveData(this.settings);
		this.session?.editors.setName(this.deviceName);
		this.namesChanged();
	}

	get deviceName(): string {
		const os = Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "";
		return cleanName(this.settings.deviceName) || (os ? `Obsidian on ${os}` : "Obsidian");
	}

	// The Worker's owner code: only needed to create a vault, and forgotten once the vault exists.
	get ownerCode(): string {
		return (this.app.loadLocalStorage("ownsync-owner-code") as string | null) ?? "";
	}

	async onload(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<typeof this.settings>;
		this.settings = { host: data.host ?? "", vaultId: data.vaultId ?? "", deviceName: data.deviceName ?? "", createdHere: data.createdHere ?? "", maxFileMB: data.maxFileMB ?? 20, attachments: data.attachments ?? true, backUpHistoryToWorker: data.backUpHistoryToWorker ?? true, snapshots: data.snapshots ?? false, snapshotsOffered: data.snapshotsOffered ?? false, welcomed: data.welcomed ?? !!data.host, skipUpdate: data.skipUpdate ?? "" };
		// Earlier versions kept the key (of epoch 0: there were no rotations) in local storage.
		const legacy = this.app.loadLocalStorage("ownsync-vault-key") as string | null;
		if (legacy) {
			if (this.settings.vaultId && !this.hasKey()) this.app.secretStorage.setSecret(this.ringId(this.settings.vaultId), JSON.stringify({ 0: legacy }));
			this.app.saveLocalStorage("ownsync-vault-key", null);
		}
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("mod-clickable");
		const showStatus = () => (this.hasKey() ? say(this.describe(), 10000) : this.openSetup());
		this.registerDomEvent(this.statusEl, "click", showStatus);
		// Phones hide the status bar: the ribbon (the menu there) carries the status.
		this.ribbonEl = this.addRibbonIcon(STATUS_ICON[this.status], "Ownsync", showStatus);
		this.addSettingTab(new OwnsyncSettingTab(this.app, this));
		installConflictNotice(this);
		this.addCommand({ id: "copy-diagnostics", name: "Copy diagnostics", callback: () => this.showDiagnostics() });
		this.registerEditorExtension(editorBinding.of([]));
		// Paired from a link opened elsewhere (a QR code, the browser): the Set up screen has nothing left to do.
		this.registerObsidianProtocolHandler("ownsync-pair", (params) => void handlePairLink(this, params).then((ok) => { if (ok) this.setup?.close(); }));
		// Any web page can open this link: it only ever opens a note of this vault.
		this.registerObsidianProtocolHandler("ownsync-open", (params) => void this.openNoteLink(params));
		this.addCommand({ id: "copy-url", name: "Copy URL", checkCallback: (checking) => {
			const file = this.app.workspace.getActiveFile(), id = file && this.noteAt(file.path);
			return !!id && (checking || this.copyUrl(id), true);
		} });
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			const id = this.noteAt(file.path);
			if (id) menu.addItem((item) => item.setTitle("Copy URL").setIcon("link").onClick(() => this.copyUrl(id)));
		}));
		this.registerObsidianProtocolHandler("ownsync-setup", (params) => {
			if (this.hasKey()) return void say("This vault already syncs with Ownsync, so the setup link was ignored.", 8000);
			this.openSetup(parseSetupLink(params) ?? "");
		});
		this.addCommand({ id: "set-up", name: "Set up", checkCallback: (checking) => !this.hasKey() && (checking || this.openSetup(), true) });
		this.addCommand({ id: "pair-device", name: "Add a device", checkCallback: (checking) => this.hasKey() && (checking || void showPairingCode(this), true) });
		this.addCommand({ id: "open-dashboard", name: "Open dashboard", checkCallback: (checking) => this.hasKey() && (checking || openDashboard(this), true) });
		// Phones have no status bar, so the status is also a command.
		this.addCommand({ id: "show-status", name: "Show sync status", callback: () => say(this.describe(), 10000) });
		// Phones suspend the app and drop its connection without telling it: reconnect when it comes back.
		const wake = () => { if (document.visibilityState === "visible" && this.status === "offline") void this.session?.transport.connect().catch(() => {}); };
		this.registerDomEvent(document, "visibilitychange", wake);
		this.registerDomEvent(window, "online", wake);
		installHistory(this, () => this.session && {
			client: this.session.historyBackup,
			connected: this.session.transport.status === "synced",
		});
		installSnapshots(this);
		this.app.workspace.onLayoutReady(async () => {
			await this.restart();
			if (!this.hasKey() && !this.settings.welcomed) {
				this.settings.welcomed = true;
				await this.saveData(this.settings);
				this.openSetup();
			}
		});
	}

	get attachments(): boolean {
		return this.settings.attachments;
	}

	/** Attachments on or off for this device; a running sync restarts with the new choice. */
	async setAttachments(on: boolean): Promise<void> {
		if (this.settings.attachments === on) return;
		this.settings.attachments = on;
		await this.saveData(this.settings);
		if (this.session) await this.restart();
	}

	// What was last told to the server, so it's only told again when something changes.
	/** The running engine, for the history screens (undefined while the vault isn't set up). */
	engine = () => this.session?.engine;
	snapshots = () => this.session?.snapshots;
	pairedAt = () => { const keys = this.session?.keys; return keys?.state.head?.members.find((m) => hex(m.id) === hex(keys.me.id))?.pairedAt; };
	snapshotsSynced = () => this.status === "synced" && this.session?.transport.status === "synced";
	onSnapshotSyncChange = (callback: () => void) => this.snapshotSyncEvents.on("change", callback);
	noteAt = (path: string) => this.session?.engine.noteAt(path);
	pathOf = (id: string) => this.session?.engine.pathOf(id);

	private sentNames = "";
	readonly namesChanged = debounce(() => void this.reportNames(), 1500, true);

	/**
	 * This device's name and the vault's, as Obsidian has them, for the owner's dashboard. Unlike the name next to
	 * the cursor, which travels encrypted, these are stored readable on the server. An older server (no such
	 * address) just doesn't show them.
	 */
	async reportNames(): Promise<void> {
		const keys = this.session?.keys;
		if (!keys) return;
		const json = JSON.stringify({ device: shortId(keys.me.id), name: cleanName(this.settings.deviceName), vault: this.app.vault.getName() });
		if (json === this.sentNames) return;
		const body = new Uint8Array([...(await keys.token()), ...new TextEncoder().encode(json)]);
		const res = await requestUrl({ url: `${this.settings.host}/vault/${hex(keys.vaultId)}/names`, method: "POST", body: body.buffer, throw: false }).catch(() => null);
		if (res?.status !== 200) return;
		this.sentNames = json;
		const reply = res.json as { latest?: unknown; worker?: unknown; names?: unknown };
		this.deviceNames = deviceNames(reply.names);
		this.offerUpdate(reply);
	}

	/** Names the devices gave themselves, by short ID, as the Worker last reported them (unverified, like "paired by"). */
	deviceNames = new Map<string, string>();

	/** Asks the Worker again, for the Devices list. True if a name changed. */
	async refreshNames(): Promise<boolean> {
		const before = JSON.stringify([...this.deviceNames]);
		this.sentNames = "";
		await this.reportNames().catch(() => {});
		return JSON.stringify([...this.deviceNames]) !== before;
	}

	/**
	 * One notice per new release. Obsidian doesn't let a plugin update itself, so the notice points to where Obsidian
	 * does it (or, when only the Worker is behind, to the dashboard). An older Worker sends no versions: nothing shows.
	 */
	private offerUpdate({ latest, worker }: { latest?: unknown; worker?: unknown }): void {
		const behind = (v: unknown) => typeof latest === "string" && /^\d+\.\d+\.\d+$/.test(latest) && typeof v === "string" && latest.localeCompare(v, undefined, { numeric: true }) > 0;
		const plugin = behind(this.manifest.version);
		if ((!plugin && !behind(worker)) || latest === this.settings.skipUpdate) return;
		const notice = new Notice(createFragment((f) => {
			f.createDiv({ text: plugin ? `Ownsync ${latest} is out.` : `Your Worker runs Ownsync ${worker as string}; ${latest as string} is out.` });
			const row = f.createDiv({ cls: "ownsync-notice-actions" });
			row.createEl("button", { text: plugin ? "Update" : "Open dashboard", cls: "mod-cta" }).addEventListener("click", () => {
				if (plugin) window.open("obsidian://show-plugin?id=ownsync");
				else openDashboard(this);
				notice.hide();
			});
			row.createEl("button", { text: "Not now" }).addEventListener("click", () => {
				this.settings.skipUpdate = latest as string;
				void this.saveData(this.settings);
				notice.hide();
			});
		}), 0);
	}

	/** A note's web link, for anyone who syncs this vault. */
	private copyUrl(noteId: string): void {
		const url = noteUrl(this.settings.host, this.settings.vaultId, noteId);
		void navigator.clipboard.writeText(url).then(() => say("Link copied. It opens this note for anyone in this vault."), () => say("Failed to copy the link.", 6000));
	}

	private async openNoteLink(params: Record<string, string>): Promise<void> {
		const link = parseOpenLink(params);
		if (!link) return void say("This Ownsync link is incomplete.", 6000);
		if (!this.hasKey() || link.vaultId !== this.settings.vaultId) return void say("This link is for another vault.", 6000);
		if (!this.session) return void say("Ownsync is still starting. Open the link again in a moment.", 6000);
		const path = this.pathOf(link.noteId), file = path ? this.app.vault.getFileByPath(path) : null;
		if (!file) return void say("That note was deleted. Look in Recently deleted.", 8000);
		await this.app.workspace.getLeaf().openFile(file);
	}

	private setup?: SetupModal;
	openSetup(code = ""): void {
		this.setup?.close();
		(this.setup = new SetupModal(this, code)).open();
	}

	onunload(): void {
		void this.session?.stop();
	}

	private setSession(session: Session | null): void {
		this.session = session;
		this.snapshotSyncEvents.trigger("change");
	}

	async restart(): Promise<void> {
		await this.session?.stop();
		this.setSession(null);
		this.problems = [];
		const { host, vaultId } = this.settings;
		if (!host || !vaultId || !this.hasKey()) return this.setStatus("not set up");
		this.setStatus("starting");
		try {
			this.setSession(await this.start(host, vaultId));
		} catch (err) {
			this.problem("starting sync", err);
		}
	}

	private ports(store: IdbStore, vaultId: string): KeyPorts {
		const id = this.ringId(vaultId);
		return {
			load: () => store.get<KeyState>("keys"),
			save: (state) => store.commit(new Map([["keys", state]]), []),
			loadRing: () => this.app.secretStorage.getSecret(id),
			saveRing: (ring) => this.app.secretStorage.setSecret(id, ring),
		};
	}

	private async start(host: string, vaultId: string): Promise<Session> {
		const { vault, workspace } = this.app;
		const store = new IdbStore(`ownsync:${vaultId}`);
		const problem = (what: string, err: unknown) => this.problem(what, err);
		const keys = await VaultKeys.open(vaultId, this.ports(store, vaultId), { onAlert: (m) => this.alert(m), onProblem: problem }).catch(async (err) => {
			await store.close();
			throw err;
		});
		const disk = new VaultDisk(this.app);
		const engine = new Engine(store, disk, {
			hash: async (text) => hex(await sha256(new TextEncoder().encode(text))),
			chunkName: (data): Promise<string> => transport.chunkName(data),
			newId: () => hex(randomBytes(8)),
			maxFileSize: this.settings.maxFileMB * 2 ** 20,
			attachments: this.settings.attachments,
			pace: 3000,
			onProblem: problem,
			onClosed: () => editors.refresh(),
		});
		const editors = new Editors(this.app, engine, problem, (note, update) => transport.presence(note, update), this.deviceName);
		const transport = new Transport(host, keys, engine, {
			// Only the device creating the vault sends the owner code: pairing joins a vault and never creates one.
			owner: this.settings.createdHere === vaultId ? this.ownerCode : "",
			onStatus: (s) => {
				// The vault now exists on the Worker: the owner code that created it isn't needed again.
				if (s === "synced" && this.ownerCode) this.app.saveLocalStorage("ownsync-owner-code", null);
				if (s === "synced") void this.reportNames();
				this.setStatus(s);
				if (s === "frozen") void chooseFork(this);
			},
			onProblem: problem,
			onPresence: (note, update) => editors.receivePresence(note, update),
			// The dashboard shows a phone as a phone, and a notes-only device as one. Older servers show it as part of the version.
			version: `${this.manifest.version}${Platform.isMobile ? " mobile" : ""}${this.settings.attachments ? "" : " notes-only"}`,
			conflicts: () => vault.getFiles().filter((f) => disk.synced(f) && (f.path.includes(" (conflict ") || f.path.includes(" (recovered "))).length,
		});
		const connected = () => this.session?.transport === transport && transport.status === "synced";
		const backupConnection = {
			host, vaultId: keys.vaultId, keys, token: () => keys.token(),
			requestUrl: async (request: Parameters<HistoryBackupDeps["requestUrl"]>[0]) => {
				if (!connected()) throw new Error("Ownsync is offline.");
				return requestUrl(request);
			},
		};
		const historyBackup = createHistoryBackup({
			...backupConnection,
			enabled: () => this.settings.backUpHistoryToWorker,
			docTag: (id) => docTag(keys.vmk, keys.vaultId, id),
			allDocTags: (id) => Promise.all(keys.vmks.map((vmk) => docTag(vmk, keys.vaultId, id))),
			noteIdForPath: (path) => engine.noteAt(path),
		});
		const snapshots = createSnapshots({
			...backupConnection,
			mobile: Platform.isMobile,
			ready: () => connected() && !keys.state.removed && !keys.state.fork,
			vmkFor: keys.keyFor,
			async *listNotes(maxBytes) {
				let bytes = 0;
				for (const file of vault.getMarkdownFiles()) {
					if (!disk.synced(file)) continue;
					const { path } = file;
					const id = engine.noteAt(path);
					if (!id) continue;
					bytes += file.stat.size;
					if (bytes > maxBytes) throw new RangeError("snapshot notes exceed the size limit");
					yield { id, path, text: await vault.cachedRead(file) };
				}
			},
			// The engine keeps attachment references private. Use notes-only mode if any would be omitted.
			listAttachments: () => !this.attachments || vault.getFiles().some((file) => disk.synced(file) && !file.path.endsWith(".md")) ? undefined : [],
			snapshotLedger: () => engine.snapshotLedger(),
			recordSnapshot: (id, entry) => engine.recordSnapshot(id, entry),
			forgetSnapshots: (ids) => engine.forgetSnapshots(ids),
			configDir: vault.configDir,
			normalizePath,
		});
		const refresh = debounce(() => { editors.refresh(); report(); }, 50, true);
		const report = debounce(() => transport.report(), 5000);
		const refs: [{ offref(ref: EventRef): void }, EventRef][] = [
			[vault, vault.on("create", (f) => { if (disk.synced(f)) { engine.diskChanged(f.path); refresh(); } })],
			[vault, vault.on("modify", (f) => { if (disk.synced(f)) engine.diskChanged(f.path); })],
			[vault, vault.on("delete", (f) => { if (disk.synced(f)) { engine.diskChanged(f.path); refresh(); } })],
			[vault, vault.on("rename", (f, from) => {
				if (!(f instanceof TFile)) return;
				// A file moved into or out of the settings folder appears or disappears. (The engine takes a note
				// renamed to an attachment, or back, for one file gone and another new.)
				const was = !from.startsWith(`${vault.configDir}/`), is = disk.synced(f);
				if (was && is) engine.diskRenamed(from, f.path);
				else if (was) engine.diskChanged(from);
				else if (is) engine.diskChanged(f.path);
				refresh();
			})],
			[workspace, workspace.on("layout-change", () => editors.refresh())],
			[workspace, workspace.on("file-open", () => editors.refresh())],
			[workspace, workspace.on("active-leaf-change", () => editors.refresh())],
		];
		await engine.start();
		void transport.connect().catch((err) => problem("connecting", err));
		editors.refresh();
		return {
			keys, engine, editors, transport, historyBackup, snapshots,
			stop: async () => {
				// Drop unsent uploads and give in-flight requests and pending clears up to 5 s to finish.
				await Promise.race([historyBackup.idle(), new Promise((done) => window.setTimeout(done, 5000))]);
				for (const [owner, ref] of refs) owner.offref(ref);
				await editors.stop();
				transport.disconnect();
				engine.stop();
				await engine.idle();
				await store.close();
			},
		};
	}

	async saveConnection(host: string, vaultId: string): Promise<void> {
		this.settings = { ...this.settings, host, vaultId, createdHere: this.settings.createdHere === vaultId ? vaultId : "" };
		await this.saveData(this.settings);
		await this.restart();
	}

	// A new vault on the Worker, with a fresh vault ID and key; the Worker lets only its owner create one.
	async createVault(host: string, ownerCode: string): Promise<void> {
		this.app.saveLocalStorage("ownsync-owner-code", ownerCode || null);
		const vaultId = hex(randomBytes(16));
		this.settings.createdHere = vaultId;
		await createVault(this, host, vaultId);
	}

	/** This device stops syncing the vault and forgets its key ring. The notes stay as ordinary files. */
	async leave(): Promise<void> {
		const { vaultId } = this.settings;
		if (vaultId) this.app.secretStorage.setSecret(this.ringId(vaultId), "");
		await this.saveConnection(this.settings.host, "");
	}

	/** Deletes the vault from the server, which stops sync on every device, then leaves it here. Notes stay on every device. */
	async deleteFromServer(): Promise<void> {
		const session = this.session;
		if (!session) throw new Error("Ownsync isn't running for this vault");
		const token = await session.keys.token();
		session.transport.disconnect(); // this device leaves anyway: it needn't be told "deleted" like the others
		const res = await requestUrl({ url: `${trimHost(this.settings.host)}/vault/${hex(session.keys.vaultId)}/delete`, method: "POST", body: token.buffer.slice(token.byteOffset, token.byteOffset + token.byteLength) as ArrayBuffer, throw: false }).catch(() => null);
		// 410: already deleted, from another device.
		if (res?.status !== 200 && res?.status !== 410) {
			await this.restart();
			throw new Error(res?.status === 401 ? "the Worker rejected this vault's key" : "couldn't reach the Worker");
		}
		await this.leave();
	}

	/** Starts this device afresh in a vault (created, paired or recovered): new device keys, then `init`. */
	async setUp(host: string, vaultId: string, ring: Map<number, Uint8Array>, init?: (keys: VaultKeys) => Promise<void>, pin?: KeyState["pin"]): Promise<void> {
		await this.session?.stop();
		this.setSession(null);
		const store = new IdbStore(`ownsync:${vaultId}`);
		try {
			const keys = await VaultKeys.fresh(vaultId, this.ports(store, vaultId), { onProblem: (what, err) => this.problem(what, err) }, ring, pin);
			await init?.(keys);
		} catch (err) {
			await this.restart(); // nothing changed: carry on with the vault this device had
			throw err;
		} finally {
			await store.close();
		}
		await this.saveConnection(host, vaultId);
	}

	describe(): string {
		return [`Ownsync: ${STATUS_TEXT[this.status]}`, ...this.problems.slice(-5)].join("\n");
	}

	/** What a bug report may carry: no vault ID, server, device IDs, keys, or note names. */
	diagnostics(): string {
		const { vault } = this.app, notes = vault.getMarkdownFiles().length;
		const os = Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "other";
		const devices = this.session?.keys.state.head?.members.length;
		return [
			`Ownsync ${this.manifest.version}`,
			`Obsidian API ${apiVersion}`,
			`Platform: ${Platform.isMobile ? "mobile" : "desktop"}, ${os}`,
			`Status: ${STATUS_TEXT[this.status]}`,
			`Attachments: ${this.settings.attachments ? "on" : "off"}`,
			`Notes: ${notes}, attachments: ${vault.getFiles().length - notes}${devices ? `, devices: ${devices}` : ""}`,
			`Recent problems (details removed): ${this.problems.length ? "" : "none"}`,
			...this.problems.slice(-5).map((p) => `- ${redactProblem(p)}`),
		].join("\n");
	}

	showDiagnostics(): void {
		const report = this.diagnostics();
		const modal = new Modal(this.app);
		modal.titleEl.setText("Diagnostics");
		modal.contentEl.createEl("p", { text: "Nothing here names your vault, Worker, devices or notes. Read it, then copy it into your report." });
		const text = modal.contentEl.createEl("textarea");
		text.value = report;
		text.readOnly = true;
		text.rows = 10;
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy", cls: "mod-cta" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(report).then(() => say("Diagnostics copied."), () => say("Failed to copy the diagnostics.", 6000));
		});
		modal.open();
	}

	private setStatus(status: State): void {
		const changed = status !== this.status;
		this.status = status;
		setIcon(this.ribbonEl, STATUS_ICON[status]);
		this.ribbonEl.setAttribute("aria-label", `Ownsync: ${STATUS_TEXT[status]}`);
		this.onStatusChange?.();
		this.statusEl.setText(`Ownsync: ${STATUS_TEXT[status]}${this.problems.length ? ` (${this.problems.length} problem${this.problems.length > 1 ? "s" : ""})` : ""}`);
		if (!changed) return; // problems call this again in the same state: tell once per change
		this.snapshotSyncEvents.trigger("change");
		if (status === "unauthorized") say("Ownsync: the Worker rejected this vault's key. Pair this device again from one that syncs.", 15000);
		if (status === "needs owner code") say("Ownsync: the Worker refused this vault's code: it was already used or has expired. Use Settings → Ownsync → Leave this vault, then connect again with a new code from your Worker's dashboard.", 15000);
		if (status === "deleted") say("Ownsync: This vault was deleted from the Worker. Your notes stay on this device. Use Leave this vault, then set up again.", 15000);
	}

	// One note failing must not stop the rest, but the user must be able to find out.
	private problem(what: string, err: unknown): void {
		const line = `${what}: ${err instanceof Error ? err.message : String(err)}`;
		console.error("[ownsync]", what, err);
		if (!this.problems.includes(line)) say(`Ownsync: ${line}`, 10000);
		this.problems = [...this.problems.filter((p) => p !== line), line].slice(-20);
		this.setStatus(this.status);
	}

	// About the vault's devices: stays on screen until dismissed.
	private alert(message: string): void {
		console.warn("[ownsync]", message);
		new Notice(`Ownsync: ${message}`, 0);
		this.problems = [...this.problems.filter((p) => p !== message), message].slice(-20);
		this.setStatus(this.status);
	}
}

class OwnsyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: OwnsyncPlugin) {
		super(app, plugin);
	}

	private namesAsked = false; // the Worker is asked for device names once per opening of the settings

	hide(): void {
		this.plugin.onStatusChange = null;
		this.namesAsked = false;
	}

	display(): void {
		const { containerEl, plugin } = this;
		containerEl.empty();
		containerEl.addClass("ownsync-settings");
		plugin.onStatusChange = null;
		if (!plugin.hasKey()) {
			new Setting(containerEl)
				.setName("Set up Ownsync")
				.setDesc("Sync this vault between your devices, end-to-end encrypted, through your own Worker.")
				.addButton((b) => b.setButtonText("Set up").setCta().onClick(() => plugin.openSetup()));
			new Setting(containerEl)
				.setName("Recover a vault")
				.setDesc("Lost every device? Use the recovery kit you saved when you set up the vault.")
				.addButton((b) => b.setButtonText("Recover").onClick(() => new RecoverModal(plugin, () => this.display()).open()));
			this.thisDevice(containerEl);
			this.history(containerEl);
			this.advanced(containerEl);
			return;
		}
		const status = new Setting(containerEl).setName("Status");
		const showStatus = () => {
			status.setDesc(`${plugin.describe()}\nWorker: ${plugin.settings.host}`);
			status.controlEl.empty();
			if (STUCK.includes(plugin.status)) status.addButton((b) => b.setButtonText("Leave this vault").setWarning().onClick(() => this.confirmLeave()));
		};
		showStatus();
		plugin.onStatusChange = showStatus;
		this.thisDevice(containerEl);
		this.devices(containerEl);
		this.history(containerEl);
		new Setting(containerEl).setName("Snapshots").setHeading();
		snapshotSettings(containerEl, plugin);
		this.recovery(containerEl);
		this.advanced(containerEl);
		new Setting(containerEl).setName("Leave or delete").setHeading();
		new Setting(containerEl)
			.setName("Leave this vault")
			.setDesc("This device stops syncing and forgets the vault's key. Your notes stay here as ordinary files; your other devices keep syncing.")
			.addButton((b) => b.setButtonText("Leave").setWarning().onClick(() => this.confirmLeave()));
		this.deleteFromServer(containerEl);
	}

	private thisDevice(containerEl: HTMLElement): void {
		const { plugin } = this;
		new Setting(containerEl).setName("This device").setHeading();
		new Setting(containerEl)
			.setName("Device name")
			.setDesc("How your other devices, and your Worker's dashboard, show this one.")
			.addText((t) => t.setPlaceholder(plugin.deviceName).setValue(plugin.settings.deviceName).onChange((v) => plugin.setDeviceName(v)));
		new Setting(containerEl)
			.setName("Sync attachments")
			.setDesc("Images, PDFs and other files. Off: this device syncs notes only, and leaves attachments on your other devices alone.")
			.addToggle((t) => t.setValue(plugin.attachments).onChange(async (on) => { await plugin.setAttachments(on); this.display(); }));
	}

	private history(containerEl: HTMLElement): void {
		const { plugin } = this;
		new Setting(containerEl).setName("History").setHeading();
		new Setting(containerEl)
			.setName("Back up history to your Worker")
			.setDesc("Encrypted copies of the notes you edit here, kept 30 days on your Worker. Each device has its own setting.")
			.addToggle((toggle) => toggle.setValue(plugin.settings.backUpHistoryToWorker).onChange(async (on) => {
				const { host, vaultId } = plugin.settings;
				plugin.settings.backUpHistoryToWorker = on;
				if (!on) plugin.session?.historyBackup.discardUploads();
				toggle.setDisabled(true);
				try {
					await plugin.saveData(plugin.settings);
				} catch {
					plugin.settings.backUpHistoryToWorker = !on;
					toggle.setValue(!on);
					say("Couldn't save the history backup setting.");
					return;
				} finally {
					toggle.setDisabled(false);
				}
				if (!on && plugin.hasKey() && plugin.settings.host === host && plugin.settings.vaultId === vaultId) {
					this.confirmDeleteHistoryBackups(host, vaultId);
				}
			}));
	}

	private confirmLeave(): void {
		const modal = new Modal(this.app);
		modal.titleEl.setText("Leave this vault?");
		modal.contentEl.createEl("p", { text: "This device stops syncing and forgets the vault's key. To sync it again, add it from another device. If this is your only device, the copy on your Worker can no longer be opened." });
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
		buttons.createEl("button", { text: "Leave", cls: "mod-warning" }).addEventListener("click", async () => {
			modal.close();
			await this.plugin.leave();
			this.display();
		});
		modal.open();
	}

	private advanced(containerEl: HTMLElement): void {
		const { plugin } = this;
		new Setting(containerEl).setName("Advanced").setHeading();
		if (plugin.attachments) {
			let mb = String(plugin.settings.maxFileMB);
			new Setting(containerEl)
				.setName("Largest attachment (MB)")
				.setDesc("Larger files are reported and not synced. The Worker holds at most about 1 GB in all.")
				.addText((t) => { t.inputEl.addClass("ownsync-narrow"); t.setValue(mb).onChange((v) => { mb = v.trim(); }); })
				.addButton((b) => b.setButtonText("Save").onClick(async () => {
					const n = Number(mb);
					if (!(n > 0)) return void say("Enter a number of megabytes.");
					plugin.settings.maxFileMB = n;
					await plugin.saveData(plugin.settings);
					await plugin.restart();
					this.display();
				}));
		}
		if (plugin.hasKey()) new Setting(containerEl)
			.setName("Add another vault")
			.setDesc("Sync a different Obsidian vault through the same Worker. Your dashboard walks you through it.")
			.addButton((b) => b.setButtonText("Connect another vault").onClick(() => openDashboard(plugin, "connect")));
		this.vaultFacts(containerEl);
	}

	private confirmDeleteHistoryBackups(host: string, vaultId: string): void {
		const { plugin } = this;
		const modal = new Modal(this.app);
		modal.titleEl.setText("Delete history backups?");
		modal.contentEl.createEl("p", { text: "Also delete the history backups on your Worker? That removes the copies from all your devices." });
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Keep backups" }).onclick = () => modal.close();
		buttons.createEl("button", { text: "Delete backups", cls: "mod-warning" }).onclick = async () => {
			modal.close();
			if (plugin.settings.backUpHistoryToWorker || plugin.settings.host !== host || plugin.settings.vaultId !== vaultId) return;
			const cleared = await plugin.session?.historyBackup.forgetAll().catch(() => false);
			say(cleared ? "History backups deleted from the Worker." : "Couldn't delete history backups from the Worker.");
		};
		modal.open();
	}

	private vaultFacts(containerEl: HTMLElement): void {
		const { plugin } = this;
		if (!plugin.hasKey()) return;
		// The server, and its dashboard, know the vault by a hash of its ID; the short form is what the user types to delete it.
		const keys = plugin.session?.keys, short = keys ? shortId(keys.vaultId) : "";
		new Setting(containerEl).setName("Vault ID").setDesc(short ? `${plugin.settings.vaultId}\nOn the Worker and its dashboard: ${short}` : plugin.settings.vaultId);
		new Setting(containerEl)
			.setName("Copy diagnostics")
			.setDesc("A short report for a bug report. It names no vault, Worker, device or note, and you read it before copying.")
			.addButton((b) => b.setButtonText("Show").onClick(() => plugin.showDiagnostics()));
	}

	private deleteFromServer(containerEl: HTMLElement): void {
		const keys = this.plugin.session?.keys, short = keys ? shortId(keys.vaultId) : "";
		if (short) new Setting(containerEl)
			.setName("Delete this vault from the Worker")
			.setDesc("Sync stops on every device, and the Worker's copy is gone for good. The notes on your devices stay.")
			.addButton((b) => b.setButtonText("Delete from Worker").setWarning().onClick(() => this.confirmDelete(short)));
	}

	private confirmDelete(short: string): void {
		const { plugin } = this;
		const modal = new Modal(this.app);
		modal.titleEl.setText("Delete this vault from the Worker?");
		modal.contentEl.createEl("p", { text: "Sync stops on every device of this vault. The notes on each device stay there as ordinary files. The copy on your Worker is deleted and can't be restored, and this vault can't be synced again: to sync these notes, set up a new vault." });
		modal.contentEl.createEl("p", { text: `To confirm, type the vault's short ID: ${short}` });
		new Setting(modal.contentEl).setName("Short ID").addText((t) => t.onChange((v) => { del.disabled = v.trim().toUpperCase() !== short; }));
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
		const del = buttons.createEl("button", { text: "Delete from Worker", cls: "mod-warning" });
		del.disabled = true;
		del.addEventListener("click", async () => {
			modal.close();
			try {
				await plugin.deleteFromServer();
				say("Ownsync: the vault was deleted from the Worker. Your notes stay on this device.", 10000);
			} catch (err) {
				say(`Ownsync: couldn't delete the vault: ${err instanceof Error ? err.message : String(err)}`, 10000);
			}
			this.display();
		});
		modal.open();
	}

	private devices(containerEl: HTMLElement): void {
		const { plugin } = this;
		const keys = plugin.session?.keys, head = keys?.state.head;
		new Setting(containerEl).setName("Devices").setDesc("Who paired each device, and when, is what the pairing device reported; it isn't verified. A stolen device can pair others until you remove it.").setHeading();
		if (keys && head) {
			const me = hex(keys.me.id);
			const label = (id: Uint8Array) => { const short = shortId(id), given = plugin.deviceNames.get(short); return given ? `${given} (${short})` : short; };
			const name = (id: Uint8Array) => (hex(id) === me ? "this device" : label(id));
			if (!this.namesAsked) {
				this.namesAsked = true;
				void plugin.refreshNames().then((changed) => { if (changed) this.display(); });
			}
			for (const m of head.members) {
				const row = new Setting(containerEl)
					.setName(`${label(m.id)}${hex(m.id) === me ? " (this device)" : ""}`)
					.setDesc(`Paired ${new Date(m.pairedAt).toLocaleString()} by ${hex(m.pairedBy) === hex(m.id) ? "itself" : name(m.pairedBy)}.`);
				if (hex(m.id) !== me) row.addButton((b) => b.setButtonText("Remove").onClick(async () => { await removeDevice(plugin, m.id); this.display(); }));
			}
		}
		new Setting(containerEl)
			.setName("Add a device")
			.setDesc("Your phone, tablet or another computer. Anyone you add can read and change every note.")
			.addButton((b) => b.setButtonText("Add a device").setCta().onClick(() => void showPairingCode(plugin)));
		new Setting(containerEl)
			.setName("Dashboard")
			.setDesc("When each device last synced, conflicts, and how much of Cloudflare's free plan you use. Sign in with your passkey.")
			.addButton((b) => b.setButtonText("Open dashboard").onClick(() => openDashboard(plugin)));
	}

	private recovery(containerEl: HTMLElement): void {
		const head = this.plugin.session?.keys.state.head;
		if (!head) return;
		new Setting(containerEl).setName("Recovery key").setHeading();
		new Setting(containerEl)
			.setName(head.recoveryPub ? "Replace the recovery key" : "Set up a recovery key")
			.setDesc(head.recoveryPub ? "One is set up. Replace it if someone else may have seen it." : "Without one, losing every device loses the vault.")
			.addButton((b) => b.setButtonText(head.recoveryPub ? "Replace" : "Set up").onClick(async () => { await replaceRecovery(this.plugin); this.display(); }));
	}

}
