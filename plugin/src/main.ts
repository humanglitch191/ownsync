import { type App, type EventRef, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, debounce, requestUrl } from "obsidian";
import { cleanName } from "./collab";
import { hex, randomBytes, sha256 } from "../../protocol/ownsync";
import { Engine } from "./core/engine";
import { RecoverModal, chooseFork, createVault, removeDevice, replaceRecovery } from "./devices";
import { Editors, editorBinding } from "./editors";
import { IdbStore } from "./idbStore";
import { type KeyPorts, type KeyState, VaultKeys, shortId } from "./keys";
import { parseSetupLink, trimHost } from "./links";
import { handlePairLink, showPairingCode } from "./pairing";
import { SetupModal, openDashboard, showVaultCode } from "./setup";
import { type Status, Transport } from "./transport";
import { VaultDisk } from "./vaultDisk";

type State = Status | "not set up" | "starting";
const STATUS_TEXT: Record<State, string> = {
	"not set up": "not set up",
	starting: "starting",
	connecting: "connecting",
	"catching up": "catching up",
	synced: "synced",
	offline: "offline",
	unauthorized: "the server rejected this vault's key",
	"needs owner code": "the server refused this vault's code",
	removed: "this device was removed from the vault",
	frozen: "paused: choose between two changes to the device list",
	deleted: "deleted on the server",
};

/** One running sync for the vault: its database, keys, the engine, the editors and the connection. */
interface Session {
	keys: VaultKeys;
	engine: Engine;
	editors: Editors;
	transport: Transport;
	stop(): Promise<void>;
}

export default class OwnsyncPlugin extends Plugin {
	// createdHere: the vault this device created. Only then does it send the Worker's owner code: pairing joins a
	// vault and must never create one, or a pairing link could make it upload notes under someone else's key.
	// welcomed: the setup screen opened by itself once, on the first start.
	settings = { host: "", vaultId: "", deviceName: "", createdHere: "", maxFileMB: 20, attachments: true, welcomed: false };
	session: Session | null = null;
	status: State = "not set up";
	problems: string[] = []; // the most recent, newest last
	private statusEl!: HTMLElement;

	// The key ring lives in Obsidian's secret storage, not in the vault folder, so it never ends up in iCloud,
	// Dropbox or git along with the notes.
	private ringId(vaultId: string): string {
		return `ownsync-ring-${vaultId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
	}

	hasKey(): boolean {
		return !!this.settings.vaultId && !!this.app.secretStorage.getSecret(this.ringId(this.settings.vaultId));
	}

	/** Shown next to this device's cursor on the others. It travels encrypted, like the notes. */
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
		this.settings = { host: data.host ?? "", vaultId: data.vaultId ?? "", deviceName: data.deviceName ?? "", createdHere: data.createdHere ?? "", maxFileMB: data.maxFileMB ?? 20, attachments: data.attachments ?? true, welcomed: data.welcomed ?? !!data.host };
		// Earlier versions kept the key (of epoch 0: there were no rotations) in local storage.
		const legacy = this.app.loadLocalStorage("ownsync-vault-key") as string | null;
		if (legacy) {
			if (this.settings.vaultId && !this.hasKey()) this.app.secretStorage.setSecret(this.ringId(this.settings.vaultId), JSON.stringify({ 0: legacy }));
			this.app.saveLocalStorage("ownsync-vault-key", null);
		}
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("mod-clickable");
		this.registerDomEvent(this.statusEl, "click", () => (this.hasKey() ? new Notice(this.describe(), 10000) : this.openSetup()));
		this.addSettingTab(new OwnsyncSettingTab(this.app, this));
		this.registerEditorExtension(editorBinding.of([]));
		this.registerObsidianProtocolHandler("ownsync-pair", (params) => void handlePairLink(this, params));
		this.registerObsidianProtocolHandler("ownsync-setup", (params) => {
			if (this.hasKey()) return void new Notice("This vault already syncs with Ownsync, so the setup link was ignored.", 8000);
			this.openSetup(parseSetupLink(params) ?? "");
		});
		this.addCommand({ id: "set-up", name: "Set up", checkCallback: (checking) => !this.hasKey() && (checking || this.openSetup(), true) });
		this.addCommand({ id: "pair-device", name: "Add a device", checkCallback: (checking) => this.hasKey() && (checking || void showPairingCode(this), true) });
		this.addCommand({ id: "open-dashboard", name: "Open dashboard", checkCallback: (checking) => this.hasKey() && (checking || openDashboard(this), true) });
		this.addCommand({ id: "another-vault", name: "Set up another vault", checkCallback: (checking) => this.hasKey() && (checking || void showVaultCode(this), true) });
		// Phones have no status bar, so the status is also a command.
		this.addCommand({ id: "show-status", name: "Show sync status", callback: () => new Notice(this.describe(), 10000) });
		// Phones suspend the app and drop its connection without telling it: reconnect when it comes back.
		const wake = () => { if (document.visibilityState === "visible" && this.status === "offline") void this.session?.transport.connect().catch(() => {}); };
		this.registerDomEvent(document, "visibilitychange", wake);
		this.registerDomEvent(window, "online", wake);
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

	openSetup(code = ""): void {
		new SetupModal(this, code).open();
	}

	onunload(): void {
		void this.session?.stop();
	}

	async restart(): Promise<void> {
		await this.session?.stop();
		this.session = null;
		this.problems = [];
		const { host, vaultId } = this.settings;
		if (!host || !vaultId || !this.hasKey()) return this.setStatus("not set up");
		this.setStatus("starting");
		try {
			this.session = await this.start(host, vaultId);
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
				this.setStatus(s);
				if (s === "frozen") void chooseFork(this);
			},
			onProblem: problem,
			onPresence: (note, update) => editors.receivePresence(note, update),
			// The dashboard shows a phone as a phone, and a notes-only device as one. Older servers show it as part of the version.
			version: `${this.manifest.version}${Platform.isMobile ? " mobile" : ""}${this.settings.attachments ? "" : " notes-only"}`,
			conflicts: () => vault.getFiles().filter((f) => disk.synced(f) && (f.path.includes(" (conflict ") || f.path.includes(" (recovered "))).length,
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
			keys, engine, editors, transport,
			stop: async () => {
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
			throw new Error(res?.status === 401 ? "the server rejected this vault's key" : "couldn't reach the server");
		}
		await this.leave();
	}

	/** Starts this device afresh in a vault (created, paired or recovered): new device keys, then `init`. */
	async setUp(host: string, vaultId: string, ring: Map<number, Uint8Array>, init?: (keys: VaultKeys) => Promise<void>, pin?: KeyState["pin"]): Promise<void> {
		await this.session?.stop();
		this.session = null;
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

	private setStatus(status: State): void {
		this.status = status;
		this.statusEl.setText(`Ownsync: ${STATUS_TEXT[status]}${this.problems.length ? ` (${this.problems.length} problem${this.problems.length > 1 ? "s" : ""})` : ""}`);
		if (status === "unauthorized") new Notice("Ownsync: the server rejected this vault's key. Pair this device again from one that syncs.", 15000);
		if (status === "needs owner code") new Notice("Ownsync: the server refused this vault's code: it was already used or has expired. Use Settings → Ownsync → Leave this vault, then connect again with a new code from your server's dashboard.", 15000);
		if (status === "deleted") new Notice("Ownsync: This vault was deleted from the server. Your notes stay on this device. Use Leave this vault, then set up again.", 15000);
	}

	// One note failing must not stop the rest, but the user must be able to find out.
	private problem(what: string, err: unknown): void {
		const line = `${what}: ${err instanceof Error ? err.message : String(err)}`;
		console.error("[ownsync]", what, err);
		if (!this.problems.includes(line)) new Notice(`Ownsync: ${line}`, 10000);
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

	display(): void {
		const { containerEl, plugin } = this;
		containerEl.empty();
		if (!plugin.hasKey()) {
			new Setting(containerEl)
				.setName("Set up Ownsync")
				.setDesc("Sync this vault between your devices, end-to-end encrypted, through your own server.")
				.addButton((b) => b.setButtonText("Set up").setCta().onClick(() => plugin.openSetup()));
			new Setting(containerEl)
				.setName("Recover a vault")
				.setDesc("Lost every device? Use the recovery kit you saved when you set up the vault.")
				.addButton((b) => b.setButtonText("Recover").onClick(() => new RecoverModal(plugin, () => this.display()).open()));
			this.advanced(containerEl);
			return;
		}
		new Setting(containerEl).setName("Status").setDesc(`${plugin.describe()}\nServer: ${plugin.settings.host}`);
		new Setting(containerEl)
			.setName("Add a device")
			.setDesc("Your phone, tablet or another computer: shows a one-time code to scan.")
			.addButton((b) => b.setButtonText("Add a device").setCta().onClick(() => void showPairingCode(plugin)));
		new Setting(containerEl)
			.setName("Dashboard")
			.setDesc("See your devices, when each last synced, conflicts, and how much of Cloudflare's free plan you use. Opens your server's page in the browser; sign in with your passkey.")
			.addButton((b) => b.setButtonText("Open dashboard").onClick(() => openDashboard(plugin)));
		new Setting(containerEl)
			.setName("Set up another vault")
			.setDesc("Sync a different Obsidian vault through the same server: gives you a code to paste into its setup screen.")
			.addButton((b) => b.setButtonText("Get a code").onClick(() => void showVaultCode(plugin)));
		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown next to this device's cursor on your other devices.")
			.addText((t) => t.setPlaceholder(plugin.deviceName).setValue(plugin.settings.deviceName).onChange(async (v) => {
				plugin.settings.deviceName = v;
				await plugin.saveData(plugin.settings);
				plugin.session?.editors.setName(plugin.deviceName);
			}));
		this.devices(containerEl);
		this.advanced(containerEl);
		new Setting(containerEl)
			.setName("Leave this vault")
			.setDesc("This device stops syncing and forgets the vault's key. Your notes stay here as ordinary files, and the vault keeps syncing on your other devices.")
			.addButton((b) => b.setButtonText("Leave").setWarning().onClick(() => {
				const modal = new Modal(this.app);
				modal.titleEl.setText("Leave this vault?");
				modal.contentEl.createEl("p", { text: "This device stops syncing and forgets the vault's key. To sync it again, add it from another device. If this is your only device, the copy on your server can no longer be opened." });
				const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
				buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
				buttons.createEl("button", { text: "Leave", cls: "mod-warning" }).addEventListener("click", async () => {
					modal.close();
					await plugin.leave();
					this.display();
				});
				modal.open();
			}));
	}

	private advanced(containerEl: HTMLElement): void {
		const { plugin } = this;
		new Setting(containerEl)
			.setName("Sync attachments")
			.setDesc("Images, PDFs and other files. Off: this device syncs notes only, and leaves attachments on your other devices alone.")
			.addToggle((t) => t.setValue(plugin.attachments).onChange(async (on) => { await plugin.setAttachments(on); this.display(); }));
		new Setting(containerEl).setName("Advanced").setHeading();
		if (!plugin.attachments) return this.vaultFacts(containerEl);
		let mb = String(plugin.settings.maxFileMB);
		new Setting(containerEl)
			.setName("Largest attachment (MB)")
			.setDesc("Larger files are reported and not synced. The server holds at most about 1 GB in all.")
			.addText((t) => t.setValue(mb).onChange((v) => { mb = v.trim(); }))
			.addButton((b) => b.setButtonText("Save").onClick(async () => {
				const n = Number(mb);
				if (!(n > 0)) return void new Notice("Enter a number of megabytes.");
				plugin.settings.maxFileMB = n;
				await plugin.saveData(plugin.settings);
				await plugin.restart();
				this.display();
			}));
		this.vaultFacts(containerEl);
	}

	private vaultFacts(containerEl: HTMLElement): void {
		const { plugin } = this;
		if (!plugin.hasKey()) return;
		// The server, and its dashboard, know the vault by a hash of its ID; the short form is what the user types to delete it.
		const keys = plugin.session?.keys, short = keys ? shortId(keys.vaultId) : "";
		new Setting(containerEl).setName("Vault ID").setDesc(short ? `${plugin.settings.vaultId}\nOn the server and its dashboard: ${short}` : plugin.settings.vaultId);
		if (short) new Setting(containerEl)
			.setName("Delete this vault from the server")
			.setDesc("Sync stops on every device, and the server's copy is gone for good. The notes on your devices stay.")
			.addButton((b) => b.setButtonText("Delete from server").setWarning().onClick(() => this.confirmDelete(short)));
	}

	private confirmDelete(short: string): void {
		const { plugin } = this;
		const modal = new Modal(this.app);
		modal.titleEl.setText("Delete this vault from the server?");
		modal.contentEl.createEl("p", { text: "Sync stops on every device of this vault. The notes on each device stay there as ordinary files. The copy on your server is deleted and can't be restored, and this vault can't be synced again: to sync these notes, set up a new vault." });
		modal.contentEl.createEl("p", { text: `To confirm, type the vault's short ID: ${short}` });
		new Setting(modal.contentEl).setName("Short ID").addText((t) => t.onChange((v) => { del.disabled = v.trim().toUpperCase() !== short; }));
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
		const del = buttons.createEl("button", { text: "Delete from server", cls: "mod-warning" });
		del.disabled = true;
		del.addEventListener("click", async () => {
			modal.close();
			try {
				await plugin.deleteFromServer();
				new Notice("Ownsync: the vault was deleted from the server. Your notes stay on this device.", 10000);
			} catch (err) {
				new Notice(`Ownsync: couldn't delete the vault: ${err instanceof Error ? err.message : String(err)}`, 10000);
			}
			this.display();
		});
		modal.open();
	}

	private devices(containerEl: HTMLElement): void {
		const { plugin } = this;
		const keys = plugin.session?.keys, head = keys?.state.head;
		if (!keys || !head) return;
		const me = hex(keys.me.id);
		const name = (id: Uint8Array) => (hex(id) === me ? "this device" : shortId(id));
		new Setting(containerEl).setName("Devices").setDesc("When and by which device each was paired is what the pairing device reported; it isn't verified. A stolen device can pair others before you remove it.").setHeading();
		for (const m of head.members) {
			const row = new Setting(containerEl)
				.setName(`${shortId(m.id)}${hex(m.id) === me ? " (this device)" : ""}`)
				.setDesc(`Paired ${new Date(m.pairedAt).toLocaleString()} by ${hex(m.pairedBy) === hex(m.id) ? "itself" : name(m.pairedBy)}.`);
			if (hex(m.id) !== me) row.addButton((b) => b.setButtonText("Remove").setWarning().onClick(async () => { await removeDevice(plugin, m.id); this.display(); }));
		}
		new Setting(containerEl)
			.setName("Recovery key")
			.setDesc(head.recoveryPub ? "Set up. Replace it if the code may have been seen by someone else." : "None. Without one, losing every device loses the vault.")
			.addButton((b) => b.setButtonText(head.recoveryPub ? "Replace" : "Set up").onClick(async () => { await replaceRecovery(plugin); this.display(); }));
	}
}
