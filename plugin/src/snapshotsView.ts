import { type App, type Command, type EventRef, type Vault, Modal, Setting, normalizePath } from "obsidian";
import { say } from "./notice";
import { diffLines } from "./historyRules";
import type { createSnapshots, SnapshotContent, SnapshotInfo, SnapshotNote } from "./snapshots";

export type SnapshotsApi = ReturnType<typeof createSnapshots>;

export interface SnapshotsHost {
	app: App;
	addCommand(command: Command): unknown;
	registerInterval(id: number): unknown;
	registerEvent(ref: EventRef): void;
	register(cleanup: () => void): void;
	/** Whether this device takes daily snapshots: the vault's setting, from the Worker (DESIGN.md section 9). */
	snapshotsOn(): boolean;
	snapshots(): SnapshotsApi | undefined;
	/** True when the vault is set up, caught up, and sync is running. */
	snapshotsSynced(): boolean;
	/** Fires after the session or its sync status changes. */
	onSnapshotSyncChange(callback: () => void): EventRef;
	pathOf?(noteId: string): string | undefined;
	noteAt?(path: string): string | undefined;
}

const HOUR = 60 * 60_000;

export function restoreFolderName(date: string, exists: (path: string) => boolean): string {
	const base = `Restored ${date}`;
	let path = base;
	for (let suffix = 2; exists(path); suffix++) path = `${base} ${suffix}`;
	return path;
}

export function safeSnapshotPath(path: string, configDir: string): boolean {
	const lower = path.toLowerCase(), config = configDir.toLowerCase();
	return !/[\\:]/.test(path) && ![...path].some((c) => c.charCodeAt(0) < 0x20) // no backslash, colon or control character
		&& (!config || (lower !== config && !lower.startsWith(`${config}/`)))
		&& path.split("/").every((part) => part && !part.startsWith(".") && !/[. ]$/.test(part));
}

interface Folder {
	path: string;
	folders: Map<string, Folder>;
	notes: SnapshotNote[];
}

export function snapshotTree(notes: readonly SnapshotNote[], configDir: string): Folder {
	const root: Folder = { path: "", folders: new Map(), notes: [] };
	for (const note of [...notes].sort((a, b) => a.path.localeCompare(b.path))) {
		if (!safeSnapshotPath(note.path, configDir)) continue;
		let parent = root;
		for (const name of note.path.split("/").slice(0, -1)) {
			let next = parent.folders.get(name);
			if (!next) {
				next = { path: parent.path ? `${parent.path}/${name}` : name, folders: new Map(), notes: [] };
				parent.folders.set(name, next);
			}
			parent = next;
		}
		parent.notes.push(note);
	}
	return root;
}

export function differingSnapshotNotes<T extends { note: SnapshotNote; current: string | undefined }>(notes: readonly T[]): T[] {
	return notes.filter(({ note, current }) => current !== note.text);
}

/** The local date the snapshot was taken; the UTC day it is filed under when that time isn't known. */
export function snapshotDate(day: number, takenAt?: number): string | undefined {
	if (takenAt === undefined) return new Date(day * 24 * HOUR).toJSON()?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
	const date = new Date(takenAt), pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sizeLabel(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function noteCount(count: number): string {
	return `${count} ${count === 1 ? "note" : "notes"}`;
}

function isNotePath(path: string, vault: Vault): boolean {
	return /\.md$/i.test(path) && safeSnapshotPath(path, vault.configDir) && normalizePath(path) === path;
}

function noteTarget(plugin: SnapshotsHost, note: SnapshotNote): string | undefined {
	const { vault } = plugin.app;
	if (!isNotePath(note.path, vault)) return;
	const path = plugin.pathOf?.(note.id) ?? note.path;
	if (isNotePath(path, vault)) return path;
}

function replacementTarget(plugin: SnapshotsHost, note: SnapshotNote): string | undefined {
	const path = noteTarget(plugin, note);
	if (!path) return;
	const occupant = plugin.noteAt?.(path);
	if (occupant === note.id || (occupant === undefined && !plugin.app.vault.getFileByPath(path))) return path;
}

function showDiff(container: HTMLElement, current: string | undefined, text: string): void {
	const diff = diffLines(current ?? "", text);
	const label = current === undefined ? "New note" : current === text ? "Same as the current note" : "Changes";
	const summary = diff ? `+${diff.added} / −${diff.removed} lines` : "Diff is too large to display";
	container.createEl("p", { text: current === text ? label : `${label} · ${summary}`, cls: "ownsync-lead" });
	if (!diff?.changes.length) return;
	const pre = container.createEl("pre", { cls: "ownsync-snapshot-text", attr: { "aria-label": "Line changes" } });
	for (const { type, text } of diff.changes) {
		pre.createSpan({ cls: `ownsync-snapshot-${type}`, text: `${type === "added" ? "+" : "−"} ${text}\n` });
	}
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
	if (!path || vault.getFolderByPath(path)) return;
	try {
		await vault.createFolder(path);
	} catch (err) {
		if (!vault.getFolderByPath(path)) throw err;
	}
}

const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const pathKey = (path: string) => path.normalize("NFC").toLowerCase();

async function occupiedPath(vault: Vault, path: string): Promise<boolean> {
	if (await vault.adapter.exists(path)) return true;
	const key = pathKey(path);
	return vault.getAllLoadedFiles().some((file) => pathKey(file.path) === key);
}

async function copyIntoFolder(vault: Vault, date: string, notes: readonly SnapshotNote[], active: () => boolean): Promise<void> {
	const names = new Set(vault.getRoot().children.map(({ name }) => pathKey(name)));
	const root = restoreFolderName(date, (path) => names.has(pathKey(path)));
	if (!active()) return;
	const folder = await vault.createFolder(root);
	const canCopy = () => active() && vault.getFolderByPath(root) === folder;
	let written = 0, occupied = 0;
	for (const note of notes) {
		if (!canCopy()) break;
		if (!isNotePath(note.path, vault)) continue;
		const path = `${root}/${note.path}`;
		try {
			await ensureFolder(vault, parentPath(path));
			if (await occupiedPath(vault, path)) {
				occupied++;
				continue;
			}
			if (!canCopy()) break;
			await vault.create(path, note.text);
			written++;
		} catch { /* A blocked path doesn't prevent other notes from being restored. */ }
	}
	say(`Restored ${noteCount(written)} into the folder "${root}".${skippedNotice(notes.length - written, occupied)}`);
}

function skippedNotice(skipped: number, occupied: number): string {
	if (!skipped) return "";
	return ` Skipped ${noteCount(skipped)}.${occupied ? ` ${occupied} had an occupied destination.` : ""}`;
}

interface Replacement {
	note: SnapshotNote;
	path: string;
	file: ReturnType<Vault["getFileByPath"]>;
	current: string | undefined;
}

async function planReplacements(plugin: SnapshotsHost, notes: readonly SnapshotNote[], active: () => boolean) {
	const { vault } = plugin.app;
	const destinations = notes.map((note) => ({ note, path: replacementTarget(plugin, note) }));
	const counts = new Map<string, number>();
	for (const { path } of destinations) {
		if (path) counts.set(pathKey(path), (counts.get(pathKey(path)) ?? 0) + 1);
	}
	const candidates: Replacement[] = [];
	const occupied: string[] = [];
	for (const { note, path } of destinations) {
		if (!active()) break;
		if (!path) {
			const target = noteTarget(plugin, note);
			if (target) occupied.push(target);
			continue;
		}
		if (counts.get(pathKey(path)) !== 1) continue;
		const file = vault.getFileByPath(path);
		try {
			if (!file && await occupiedPath(vault, path)) {
				occupied.push(path);
				continue;
			}
			candidates.push({ note, path, file, current: file ? await vault.read(file) : undefined });
		} catch { /* Only review files whose current text could be read. */ }
	}
	return { changes: differingSnapshotNotes(candidates), skipped: notes.length - candidates.length, occupied };
}

async function replaceNotes(plugin: SnapshotsHost, changes: readonly Replacement[], active: () => boolean): Promise<void> {
	const { vault } = plugin.app;
	let written = 0, occupied = 0;
	for (const { note, path, file, current } of changes) {
		if (!active()) break;
		const sameTarget = () => active() && replacementTarget(plugin, note) === path && vault.getFileByPath(path) === file;
		if (!sameTarget()) {
			if (!file && noteTarget(plugin, note) === path && replacementTarget(plugin, note) !== path) occupied++;
			continue;
		}
		try {
			if (file) {
				await vault.process(file, (latest) => {
					if (latest !== current || !sameTarget()) throw new Error("The note changed after review.");
					return note.text;
				});
			} else {
				await ensureFolder(vault, parentPath(path));
				if (await occupiedPath(vault, path)) {
					occupied++;
					continue;
				}
				if (!sameTarget()) continue;
				await vault.create(path, note.text);
			}
			written++;
		} catch { /* Continue with the other reviewed targets. */ }
	}
	say(`Restored ${noteCount(written)} in place.${skippedNotice(changes.length - written, occupied)}`);
}

type Selection = { kind: "all" } | { kind: "folder"; path: string } | { kind: "note"; note: SnapshotNote };

// Obsidian supplies Modal at runtime. Defer subclass creation so the pure helpers also run in Node.
const snapshotsModal = () => class SnapshotsModal extends Modal {
	private showing = false;
	private busy = false;
	private confirmation?: Modal;
	private replaceButton?: HTMLButtonElement;
	private syncHint?: HTMLElement;

	constructor(private readonly plugin: SnapshotsHost, private readonly api: SnapshotsApi) { super(plugin.app); }

	onOpen(): void {
		this.showing = true;
		this.modalEl.addClass("ownsync-snapshots-modal");
		void this.showList();
	}

	onClose(): void {
		this.showing = false;
		this.confirmation?.close();
		this.contentEl.empty();
	}

	private active = () => this.showing && this.plugin.snapshots() === this.api;
	private canReplace = () => this.active() && this.plugin.snapshotsSynced();

	updateSync(): void {
		if (this.replaceButton) this.replaceButton.disabled = this.busy || !this.canReplace();
		if (this.syncHint) this.syncHint.hidden = this.canReplace();
	}

	private async showList(): Promise<void> {
		this.setTitle("Vault snapshots");
		this.replaceButton = undefined;
		this.syncHint = undefined;
		this.contentEl.empty();
		const status = this.contentEl.createEl("p", { text: "Loading…", attr: { role: "status" } });
		try {
			const list = await this.api.list();
			if (!this.showing) return;
			if (!this.active()) return status.setText("The sync session changed. Reopen Vault snapshots.");
			if (!list.length) return status.setText(this.plugin.snapshotsOn() ? "No vault snapshots yet. Ownsync takes one a day while this device syncs." : "No vault snapshots yet. Turn them on in your Worker's dashboard.");
			status.setText("Encrypted copies of the whole vault, on your Worker. Pick one to see its notes.");
			status.addClass("ownsync-lead");
			const rows = this.contentEl.createDiv({ cls: "ownsync-snapshot-list" });
			for (const info of [...list].sort((a, b) => b.day - a.day)) {
				const flags = [snapshotDate(info.day, info.takenAt) ?? "Date unknown", info.missingOnServer ? "Size unknown" : sizeLabel(info.size)];
				if (info.notesOnly) flags.push("Notes only");
				if (!info.verified) flags.push("Can't be verified");
				if (info.missingOnServer) flags.push("Missing on Worker");
				if (!info.complete) flags.push("Incomplete");
				const row = rows.createEl("button", { text: flags.join(" · "), cls: "ownsync-snapshot-row" });
				row.disabled = !info.verified;
				row.onclick = () => { if (info.verified && this.active()) void this.openSnapshot(info); };
			}
		} catch {
			status.setText("Couldn't load vault snapshots.");
		}
	}

	private async openSnapshot(info: SnapshotInfo): Promise<void> {
		this.contentEl.empty();
		const status = this.contentEl.createEl("p", { text: "Opening snapshot…", attr: { role: "status" } });
		try {
			const snapshot = await this.api.open(info.id);
			if (!this.showing) return;
			if (!this.active()) return status.setText("The sync session changed. Reopen Vault snapshots.");
			const date = snapshotDate(snapshot.day, snapshot.takenAt);
			if (!date) throw new Error("Invalid snapshot date");
			this.showSnapshot(snapshot, date);
		} catch {
			if (!this.showing) return;
			this.contentEl.empty();
			this.contentEl.createEl("p", { text: info.missingOnServer ? "This snapshot is missing on the Worker." : "Couldn't open this snapshot." });
			this.backButton(this.contentEl);
		}
	}

	private backButton(container: HTMLElement): HTMLButtonElement {
		const back = container.createEl("button", { text: "All snapshots" });
		back.onclick = () => { if (!this.busy) void this.showList(); };
		return back;
	}

	private showSnapshot(snapshot: SnapshotContent, date: string): void {
		const { vault } = this.app;
		const notes = snapshot.notes.filter(({ path }) => isNotePath(path, vault));
		this.setTitle(`Vault snapshot · ${date}`);
		this.contentEl.empty();
		const header = this.contentEl.createDiv({ cls: "ownsync-snapshot-actions" });
		const back = this.backButton(header);
		const count = [noteCount(notes.length)];
		if (snapshot.notesOnly) count.push("Notes only");
		if (snapshot.attachments.length) count.push(`${snapshot.attachments.length} attachment references`);
		header.createSpan({ text: count.join(" · "), cls: "ownsync-lead" });
		const body = this.contentEl.createDiv({ cls: "ownsync-snapshot-browser" });
		const side = body.createDiv({ cls: "ownsync-snapshot-sidebar" });
		const search = side.createEl("input", { type: "search", placeholder: "Search note paths", attr: { "aria-label": "Search note paths" } });
		const all = side.createEl("button", { text: "All notes", cls: "ownsync-snapshot-row" });
		const tree = side.createDiv({ cls: "ownsync-snapshot-tree" });
		const view = body.createDiv({ cls: "ownsync-snapshot-view" });
		const title = view.createEl("h3");
		const preview = view.createDiv({ cls: "ownsync-snapshot-preview" });
		this.syncHint = view.createEl("p", { text: "Replacing notes in place works once sync is caught up and running.", cls: "ownsync-quiet" });
		const actions = view.createDiv({ cls: "ownsync-history-actions" });
		const replace = actions.createEl("button");
		const copy = actions.createEl("button", { text: "Restore to a folder", cls: "mod-cta" });
		if (notes.length) this.replaceButton = replace;
		else replace.disabled = true;

		let selection: Selection = { kind: "all" };
		let selectedNotes: readonly SnapshotNote[] = notes;
		let pressed: HTMLButtonElement | undefined;
		const press = (button: HTMLButtonElement) => {
			pressed?.setAttribute("aria-pressed", "false");
			button.setAttribute("aria-pressed", "true");
			pressed = button;
		};
		const select = (next: Selection, button: HTMLButtonElement) => {
			if (this.busy) return;
			selection = next;
			press(button);
			selectedNotes = next.kind === "note" ? [next.note] : next.kind === "folder" ? notes.filter(({ path }) => path.startsWith(`${next.path}/`)) : notes;
			title.setText(next.kind === "note" ? next.note.path : next.kind === "folder" ? next.path : "All notes");
			replace.setText(next.kind === "note" ? "Replace current note" : next.kind === "folder" ? "Replace folder" : "Replace everything in place");
			copy.disabled = !selectedNotes.length || !this.active();
			this.updateSync();
			preview.empty();
			if (next.kind !== "note") {
				preview.createEl("p", { text: `${noteCount(selectedNotes.length)}. Select a note to see its text.`, cls: "ownsync-lead" });
				return;
			}
			preview.createEl("pre", { text: next.note.text, cls: "ownsync-snapshot-text", attr: { "aria-label": "Snapshot text" } });
			const comparison = preview.createDiv();
			void this.compareNote(next.note, comparison);
		};
		all.onclick = () => select({ kind: "all" }, all);
		const render = (folder: Folder, parent: HTMLElement) => {
			for (const [name, child] of folder.folders) {
				const branch = parent.createEl("details");
				branch.open = true;
				branch.createEl("summary", { text: name });
				const button = branch.createEl("button", { text: "Select folder", cls: "ownsync-snapshot-row", attr: { "aria-label": `Select folder ${child.path}`, "aria-pressed": "false" } });
				button.onclick = () => select({ kind: "folder", path: child.path }, button);
				if (selection.kind === "folder" && selection.path === child.path) press(button);
				render(child, branch.createDiv({ cls: "ownsync-snapshot-branch" }));
			}
			for (const note of folder.notes) {
				const button = parent.createEl("button", { text: note.path.split("/").pop(), cls: "ownsync-snapshot-row", attr: { "aria-pressed": "false" } });
				button.onclick = () => select({ kind: "note", note }, button);
				if (selection.kind === "note" && selection.note === note) press(button);
			}
		};
		const renderSearch = () => {
			const query = search.value.trim().toLowerCase();
			const matches = query ? notes.filter(({ path }) => path.toLowerCase().includes(query)) : notes;
			tree.empty();
			if (!matches.length) tree.createEl("p", { text: "No matching notes.", cls: "ownsync-lead" });
			else render(snapshotTree(matches, vault.configDir), tree);
		};
		search.oninput = renderSearch;
		select(selection, all);
		renderSearch();

		const lock = (busy: boolean) => {
			this.busy = busy;
			back.disabled = busy;
			copy.disabled = busy || !selectedNotes.length || !this.active();
			this.updateSync();
		};
		copy.onclick = async () => {
			if (this.busy || !this.active()) return;
			lock(true);
			try {
				await copyIntoFolder(vault, date, selectedNotes, this.active);
			} catch {
				say("Couldn't create a restore folder. Try again.");
			} finally {
				lock(false);
			}
		};
		replace.onclick = () => {
			if (this.busy || !this.canReplace()) return;
			lock(true);
			this.reviewReplacement(replace.textContent ?? "Replace in place", date, selection.kind === "all", selectedNotes, () => lock(false));
		};
	}

	private async compareNote(note: SnapshotNote, container: HTMLElement): Promise<void> {
		const path = noteTarget(this.plugin, note);
		if (!path) return void container.createEl("p", { text: "This note has an unsafe destination." });
		if (path !== note.path) container.createEl("p", { text: `Current path · ${path}`, cls: "ownsync-lead" });
		try {
			const file = this.app.vault.getFileByPath(path);
			if (!replacementTarget(this.plugin, note) || (!file && await occupiedPath(this.app.vault, path))) {
				if (this.active() && container.isConnected) container.createEl("p", { text: "The destination is already occupied.", cls: "ownsync-lead" });
				return;
			}
			const current = file ? await this.app.vault.read(file) : undefined;
			if (this.active() && container.isConnected) showDiff(container, current, note.text);
		} catch {
			if (container.isConnected) container.createEl("p", { text: "Couldn't read the current note." });
		}
	}

	private reviewReplacement(label: string, date: string, all: boolean, notes: readonly SnapshotNote[], done: () => void): void {
		const review = this.confirmation = new Modal(this.app);
		review.modalEl.addClass("ownsync-snapshots-modal");
		review.setTitle(label);
		const status = review.contentEl.createEl("p", { text: "Comparing notes…", attr: { role: "status" } });
		const details = review.contentEl.createDiv({ cls: "ownsync-snapshot-review" });
		const actions = review.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = actions.createEl("button", { text: "Cancel" });
		const confirm = actions.createEl("button", { text: label, cls: "mod-warning" });
		confirm.disabled = true;
		cancel.onclick = () => review.close();
		let applying = false;
		const active = () => this.confirmation === review && this.canReplace();
		review.onClose = () => {
			this.confirmation = undefined;
			if (!applying) done();
		};
		review.open();
		void planReplacements(this.plugin, notes, active).then(({ changes, skipped, occupied }) => {
			if (this.confirmation !== review) return;
			if (!active()) return status.setText("Sync stopped. Reopen this review when sync is running.");
			const created = changes.filter(({ file }) => !file).length;
			const unchanged = notes.length - changes.length - skipped;
			const counts = [`${noteCount(changes.length - created)} to replace`, `${noteCount(created)} to create`];
			if (unchanged) counts.push(`${noteCount(unchanged)} unchanged`);
			if (skipped) counts.push(`${noteCount(skipped)} skipped`);
			status.setText(counts.join(" · "));
			for (const path of occupied) details.createEl("p", { text: `Destination already occupied · ${path}` });
			if (!changes.length) return;
			for (const { path, current, note } of changes) {
				const row = details.createEl("details");
				row.createEl("summary", { text: `${current === undefined ? "Create" : "Replace"} ${path}` });
				if (changes.length === 1) {
					row.open = true;
					showDiff(row, current, note.text);
				} else {
					row.addEventListener("toggle", () => showDiff(row, current, note.text), { once: true });
				}
			}
			let typed: HTMLInputElement | undefined;
			if (all) {
				const field = review.contentEl.createEl("label", { text: `Type ${date} to confirm`, cls: "ownsync-snapshot-confirm" });
				typed = field.createEl("input", { type: "text", attr: { autocomplete: "off" } });
				actions.before(field);
				typed.oninput = () => { confirm.disabled = typed?.value.trim() !== date; };
			} else confirm.disabled = false;
			confirm.onclick = async () => {
				if (applying || (all && typed?.value.trim() !== date)) return;
				if (!active()) return status.setText("Sync stopped. Reopen this review when sync is running.");
				applying = true;
				confirm.disabled = true;
				cancel.setText("Stop");
				if (typed) typed.disabled = true;
				try {
					await replaceNotes(this.plugin, changes, active);
				} finally {
					if (this.confirmation === review) review.close();
					done();
				}
			};
		}, () => {
			if (this.confirmation === review) status.setText("Couldn't compare the snapshot with the vault.");
		});
	}
};

export function installSnapshots(plugin: SnapshotsHost): void {
	let running = false, stopped = false, tooLarge = false;
	let modal: InstanceType<ReturnType<typeof snapshotsModal>> | undefined;
	const tick = async () => {
		const api = plugin.snapshots();
		if (running || stopped || !api || !plugin.snapshotsSynced() || !plugin.snapshotsOn()) return;
		running = true;
		try {
			if (await api.takeIfDue() === "too large" && !tooLarge && !stopped && api === plugin.snapshots()) {
				tooLarge = true;
				say("This vault exceeds the daily snapshot size limit.", 8000);
			}
		} catch { /* A background attempt can be retried on the next tick. */ }
		finally {
			running = false;
			if (!stopped && api !== plugin.snapshots()) void tick();
		}
	};
	const update = () => { modal?.updateSync(); void tick(); };
	plugin.registerEvent(plugin.onSnapshotSyncChange(update));
	plugin.app.workspace.onLayoutReady(update);
	plugin.registerInterval(window.setInterval(update, HOUR));
	plugin.register(() => {
		stopped = true;
		modal?.close();
	});
	plugin.addCommand({
		id: "vault-snapshots",
		name: "Vault snapshots",
		callback: () => {
			const api = plugin.snapshots();
			if (!api) return void say("Set up Ownsync to view vault snapshots.");
			modal?.close();
			const View = snapshotsModal();
			modal = new View(plugin, api);
			modal.open();
		},
	});
}

export function snapshotSettings(containerEl: HTMLElement, plugin: SnapshotsHost): void {
	new Setting(containerEl).setName("Delete all snapshots")
		.setDesc("Removes every vault snapshot from your Worker.")
		.addButton((button) => button.setButtonText("Delete all snapshots").onClick(() => {
			const api = plugin.snapshots();
			if (!api) return void say("Connect to your Worker to delete snapshots.");
			const modal = new Modal(plugin.app);
			modal.setTitle("Delete all snapshots?");
			modal.contentEl.createEl("p", { text: "This permanently deletes all vault snapshots from your Worker." });
			const actions = modal.contentEl.createDiv({ cls: "modal-button-container" });
			const cancel = actions.createEl("button", { text: "Cancel" });
			const remove = actions.createEl("button", { text: "Delete all snapshots", cls: "mod-warning" });
			cancel.onclick = () => modal.close();
			remove.onclick = async () => {
				if (api !== plugin.snapshots()) return void say("The sync session changed. Reopen snapshot settings.");
				remove.disabled = true;
				try {
					await api.remove();
					modal.close();
					say("Vault snapshots deleted.");
				} catch {
					remove.disabled = false;
					say("Couldn't delete vault snapshots.");
				}
			};
			modal.open();
		}));
}
