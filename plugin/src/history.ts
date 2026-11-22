// Local copies live in IndexedDB. Only an explicit restore writes to the vault.

import { type App, type Command, type EventRef, FileView, Modal, Notice, TFile, TFolder } from "obsidian";
import { type EditorState, type Extension, StateField, type Text, Transaction } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import { ySyncAnnotation, ySyncFacet } from "y-codemirror.next";
import { type Doc, type Transaction as YTransaction, UndoManager } from "yjs";
import type { createHistoryBackup } from "./historyBackup";
import { MAX_BYTES, type Copy, deletedWhenLabel, diffLines, keepCopies, mergeCopies, whenLabel } from "./historyRules";

interface DeletedNotesEngine {
	deletedNotes(): Promise<{ id: string; path: string; deletedAt?: number }[]>;
	deletedText(id: string): Promise<string | undefined>;
	restoreDeleted(id: string, path?: string): Promise<string | undefined>;
}

export interface HistoryHost {
	app: App;
	manifest: { id: string };
	registerEvent(ref: EventRef): void;
	registerEditorExtension(extension: Extension): void;
	addCommand(command: Command): unknown;
	register(callback: () => void): void;
	engine?(): DeletedNotesEngine | undefined;
}

type ActiveBackup = () => { client: ReturnType<typeof createHistoryBackup>; connected: boolean } | null;

// The editor event also fires for sync and file reloads. Yjs presents local undo/redo to
// CodeMirror the same way as remote changes, but exposes the undo manager as the origin.
const undoing = new WeakSet<Doc>();
const undoOrigin = ViewPlugin.fromClass(class {
	private doc?: Doc | null;
	constructor(view: EditorView) { this.bind(view.state); }
	update({ state }: { state: EditorState }): void { this.bind(state); }
	private bind(state: EditorState): void {
		const doc = state.facet(ySyncFacet)?.ytext.doc;
		if (doc === this.doc) return;
		this.destroy();
		this.doc = doc;
		doc?.on("beforeObserverCalls", this.before);
		doc?.on("afterTransaction", this.after);
	}
	private before = (tr: YTransaction): void => {
		if (tr.origin instanceof UndoManager) undoing.add(tr.doc);
	};
	private after = (tr: YTransaction): void => { undoing.delete(tr.doc); };
	destroy(): void {
		this.doc?.off("beforeObserverCalls", this.before);
		this.doc?.off("afterTransaction", this.after);
	}
});
const localEdit = StateField.define<boolean>({
	create: () => false,
	update: (local, tr) => {
		if (!tr.docChanged) return local;
		const synced = tr.annotation(ySyncAnnotation);
		if (synced) return !!synced.ytext.doc && undoing.has(synced.ytext.doc);
		return !tr.annotation(Transaction.remote) && tr.annotation(Transaction.userEvent) !== undefined;
	},
});

const EVERY = 10 * 60_000;
const META = "meta", TEXT = "text";

/** `gone`: a copy of a note since deleted, kept only for its deleted copy's sake; another note at its path doesn't list it. */
interface Entry extends Copy { id: string; mtime: number; gone?: boolean }
interface Sample { path: string; text: string; mtime: number }
interface LocalEdit { text: Text; consumed?: boolean }
interface Pending { sample: Sample; edit?: LocalEdit; timer?: number }

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

interface HistoryEdit {
	entries: Map<string, Entry>;
	read(id: string): Promise<string | undefined>;
	add(sample: Sample, time: number, deleted?: boolean): boolean;
}

class HistoryDb {
	private readonly db: Promise<IDBDatabase>;

	constructor(name: string, onError: (err: unknown) => void) {
		const open = indexedDB.open(name, 1);
		open.onupgradeneeded = () => {
			open.result.createObjectStore(META, { keyPath: "id" });
			open.result.createObjectStore(TEXT);
		};
		this.db = request(open);
		void this.db.catch(onError);
	}

	async entries(): Promise<Entry[]> {
		return request((await this.db).transaction(META).objectStore(META).getAll());
	}

	async text(id: string): Promise<string | undefined> {
		return request((await this.db).transaction(TEXT).objectStore(TEXT).get(id));
	}

	/** Read the metadata and commit edits, text, and eviction together, including across windows. */
	async edit<T>(update: (edit: HistoryEdit) => T | Promise<T>): Promise<T> {
		const tx = (await this.db).transaction([META, TEXT], "readwrite");
		const meta = tx.objectStore(META), texts = tx.objectStore(TEXT);
		const done = new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error ?? new Error("History write stopped."));
		});
		try {
			const original = new Map((await request<Entry[]>(meta.getAll())).map((e) => [e.id, e]));
			const entries = new Map(original);
			const additions = new Map<string, string>();
			const result = await update({
				entries,
				read: (id) => request(texts.get(id)),
				add: ({ path, text, mtime }, time, deleted) => {
					// Budget UTF-16 text and path plus the metadata for each entry, including empty notes.
					const size = 2 * (text.length + path.length) + 128;
					if (size > MAX_BYTES) return false;
					const id = crypto.randomUUID();
					entries.set(id, { id, path, time, mtime, size, deleted });
					additions.set(id, text);
					return true;
				},
			});
			const kept = keepCopies([...entries.values()], Date.now());
			for (const e of kept) {
				const previous = original.get(e.id);
				original.delete(e.id);
				if (e !== previous) meta.put(e);
				if (!previous) texts.put(additions.get(e.id), e.id);
			}
			for (const id of original.keys()) {
				meta.delete(id);
				texts.delete(id);
			}
			await done;
			return result;
		} catch (err) {
			try { tx.abort(); } catch { /* Already finished. */ }
			await done.catch(() => {});
			throw err;
		}
	}

	async close(): Promise<void> {
		(await this.db).close();
	}
}

function newestByPath(entries: Iterable<Entry>, deleted = false): Map<string, Entry> {
	const newest = new Map<string, Entry>();
	for (const e of entries) {
		if (!!e.deleted !== deleted || e.gone) continue;
		const previous = newest.get(e.path);
		if (!previous || previous.time < e.time) newest.set(e.path, e);
	}
	return newest;
}

class History {
	private readonly db: HistoryDb;
	private readonly pending = new Map<string, Pending>();
	private readonly localEdits = new Map<string, LocalEdit>();
	private work = Promise.resolve();
	private reported = false;
	stopped = false;

	constructor(private readonly app: App, name: string, private readonly backup: ActiveBackup) {
		this.db = new HistoryDb(name, this.problem);
	}

	private problem = (err: unknown): void => {
		console.error("[ownsync] note history", err);
		if (this.reported) return;
		this.reported = true;
		new Notice("Ownsync couldn't save note history.");
	};

	private queue<T>(work: () => Promise<T>): Promise<T | undefined> {
		const next = this.work.then(work).catch((err: unknown) => { this.problem(err); return undefined; });
		this.work = next.then(() => {});
		return next;
	}

	private async capture(file: TFile): Promise<Sample | undefined> {
		const { path, stat: { mtime, size } } = file;
		if (size > MAX_BYTES) return;
		try {
			return { path, mtime, text: await this.app.vault.cachedRead(file) };
		} catch (err) {
			if (this.app.vault.getFileByPath(path) === file) this.problem(err);
		}
	}

	seed(): void {
		void this.seedExisting().catch(this.problem);
	}

	/** Existing notes need a first copy too: the delete event arrives after the file is removed. */
	private async seedExisting(): Promise<void> {
		const newest = newestByPath(await this.db.entries());
		const batch: { file: TFile; sample: Sample }[] = [];
		let characters = 0;
		const saveBatch = () => this.queue(async () => {
			if (this.stopped) return;
			const { vault } = this.app;
			const samples = batch.splice(0).filter(({ file, sample }) =>
				vault.getFileByPath(sample.path) === file && file.stat.mtime === sample.mtime && !this.pending.has(sample.path));
			characters = 0;
			await this.track(samples.map(({ sample }) => sample));
		});
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.stopped) return;
			if (newest.get(file.path)?.mtime === file.stat.mtime) continue;
			const sample = await this.capture(file);
			if (sample) {
				batch.push({ file, sample });
				characters += sample.text.length;
			}
			if (batch.length >= 32 || characters >= 512 * 1024) await saveBatch();
		}
		if (!this.stopped) await saveBatch();
	}

	changed(file: TFile): void {
		if (this.stopped) return;
		const edited = this.localEdits.get(file.path);
		const editorText = edited?.text;
		// Start reading before waiting for the previous event's transaction. A delete may already be next.
		const read = this.capture(file);
		void this.queue(async () => {
			const sample = await read;
			if (sample) {
				// A timer or an older disk event can still hold text from before the editor saved.
				const edit = edited && !edited.consumed && editorText?.toString() === sample.text.replace(/\r\n/g, "\n")
					? edited : undefined;
				await this.track([sample], edit);
			}
		});
	}

	edited(path: string, text: Text, local: boolean): void {
		if (this.stopped) return;
		const edit = this.localEdits.get(path);
		if (local && edit?.text !== text) this.localEdits.set(path, { text });
		else if (edit) edit.text = text;
	}

	left(path: string): void {
		if (!this.stopped) void this.queue(() => this.flush([path], true));
	}

	private async track(samples: Sample[], edit?: LocalEdit): Promise<void> {
		const ready: string[] = [];
		for (const sample of samples) {
			const existing = this.pending.get(sample.path);
			if (existing) {
				existing.sample = sample;
				if (edit) existing.edit = edit;
			} else this.pending.set(sample.path, { sample, edit });
			if (existing?.timer === undefined) ready.push(sample.path);
		}
		await this.flush(ready);
	}

	private async flush(paths: string[], force = false): Promise<void> {
		const samples = paths.flatMap((path) => {
			const pending = this.pending.get(path);
			if (!pending) return [];
			this.cancelTimer(pending);
			return [pending];
		});
		if (!samples.length) return;
		const noteIds = new Map(samples.map(({ sample: { path } }) => [path, this.backupFor(path)?.noteId]));
		const { due, uploads } = await this.db.edit(async ({ entries, read, add }) => {
			const newest = newestByPath(entries.values());
			const now = Date.now();
			const due = new Map<string, number>();
			const uploads: { sample: Sample; takenAt: number }[] = [];
			for (const { sample, edit } of samples) {
				const last = newest.get(sample.path);
				if (last && !force && last.time + EVERY > now) {
					due.set(sample.path, last.time + EVERY);
				} else if (last && await read(last.id) === sample.text) {
					if (last.mtime !== sample.mtime) entries.set(last.id, { ...last, mtime: sample.mtime });
				} else {
					const takenAt = Math.max(now, (last?.time ?? -Infinity) + 1);
					if (add(sample, takenAt) && edit) uploads.push({ sample, takenAt });
				}
			}
			return { due, uploads };
		});
		for (const { sample: { path }, edit } of samples) {
			const time = due.get(path);
			if (time === undefined) {
				this.pending.delete(path);
				if (edit) {
					edit.consumed = true;
					if (edit === this.localEdits.get(path)) this.localEdits.delete(path);
				}
			} else if (!this.stopped) {
				const pending = this.pending.get(path)!;
				const timer = window.setTimeout(() => void this.queue(async () => {
					if (this.pending.get(path)?.timer === timer) await this.flush([path]);
				}), Math.max(0, time - Date.now()));
				pending.timer = timer;
			}
		}
		for (const { sample: { path, text }, takenAt } of uploads) {
			const target = this.backupFor(path);
			// The same note's before and after the wait: the path can change hands meanwhile (a rename moves another note onto it).
			if (target?.connected && target.noteId === noteIds.get(path)) void target.client.upload(target.noteId, text, takenAt).catch(() => {});
		}
	}

	private cancelTimer(pending: Pending): void {
		if (pending.timer !== undefined) window.clearTimeout(pending.timer);
		pending.timer = undefined;
	}

	private clearPending(path: string): void {
		const pending = this.pending.get(path);
		if (!pending) return;
		this.cancelTimer(pending);
		this.pending.delete(path);
	}

	removed(path: string, file: TFile | TFolder): void {
		if (this.stopped) return;
		const matches = file instanceof TFolder ? (p: string) => p.startsWith(`${path}/`) : (p: string) => p === path;
		for (const p of this.localEdits.keys()) if (matches(p)) this.localEdits.delete(p);
		// Obsidian may still have this file's text cached when it emits delete.
		const lastRead = file instanceof TFile ? this.capture(file) : undefined;
		void this.queue(async () => {
			const observed = await lastRead;
			const captured = observed && (observed.path !== path || !this.app.vault.getFileByPath(path)) ? observed : undefined;
			const cleared = await this.db.edit(async ({ entries, read, add }) => {
				const newest = newestByPath(entries.values());
				const deleted = newestByPath(entries.values(), true);
				const paths = [...new Set([...newest.keys(), ...this.pending.keys()])].filter(matches);
				if (captured && !paths.includes(path)) paths.push(path);
				const now = Date.now();
				for (const p of paths) {
					const last = newest.get(p);
					const previous = deleted.get(p);
					let sample = (p === path ? captured : undefined) ?? this.pending.get(p)?.sample;
					if (!sample) {
						if (!last || last.time <= (previous?.time ?? -Infinity)) continue;
						const text = await read(last.id);
						if (text === undefined) continue;
						sample = { path: p, text, mtime: last.mtime };
					}
					if (previous?.mtime === sample.mtime && (last?.time ?? -Infinity) <= previous.time &&
						await read(previous.id) === sample.text) continue;
					add({ ...sample, path: p }, now, true);
				}
				// A note that comes to this path later (a new note with the old name) starts a history of its own.
				for (const e of [...entries.values()]) if (!e.deleted && !e.gone && matches(e.path)) entries.set(e.id, { ...e, gone: true });
				return paths;
			});
			for (const p of cleared) this.clearPending(p);
		});
	}

	renamed(from: string, to: string, folder: boolean): void {
		if (this.stopped) return;
		const move = (path: string) => (folder ? path.startsWith(`${from}/`) : path === from) ? to + path.slice(from.length) : undefined;
		for (const [path, edit] of [...this.localEdits]) {
			const next = move(path);
			if (next === undefined) continue;
			this.localEdits.delete(path);
			this.localEdits.set(next, edit);
		}
		void this.queue(async () => {
			await this.db.edit(({ entries }) => {
				for (const e of entries.values()) {
					if (e.deleted) continue;
					const path = move(e.path);
					if (path !== undefined) entries.set(e.id, { ...e, path, size: e.size + 2 * (path.length - e.path.length) });
				}
			});
			const moved: string[] = [];
			for (const [path, { sample, edit }] of [...this.pending]) {
				const next = move(path);
				if (next === undefined) continue;
				this.clearPending(path);
				this.clearPending(next);
				this.pending.set(next, { sample: { ...sample, path: next }, edit });
				moved.push(next);
			}
			await this.flush(moved);
		});
	}

	async list(path?: string): Promise<Entry[]> {
		await this.work;
		const entries = keepCopies(await this.db.entries(), Date.now());
		return entries.filter((e) => path === undefined ? e.deleted : !e.deleted && !e.gone && e.path === path);
	}

	text(entry: Entry): Promise<string | undefined> {
		return this.db.text(entry.id);
	}

	async forget(entry: Entry): Promise<void> {
		await this.db.edit(({ entries }) => { entries.delete(entry.id); }).catch(this.problem);
	}

	backupFor(path: string) {
		const backup = this.backup();
		if (!backup || !backup.client.enabled() || backup.client.supported() === false) return;
		const noteId = backup.client.noteIdForPath(path);
		if (noteId) return { ...backup, noteId };
	}

	forgetNote(path: string) {
		const target = this.backupFor(path);
		const edit = this.localEdits.get(path);
		if (edit) edit.consumed = true;
		this.localEdits.delete(path);
		return this.queue(async () => {
			await this.db.edit(({ entries }) => {
				for (const [id, entry] of entries) if (!entry.deleted && entry.path === path) entries.delete(id);
			});
			this.clearPending(path);
			// The client orders this after earlier uploads. Its HTTP request stays off the local queue.
			const remote = target && (target.connected ? target.client.forget(target.noteId).catch(() => false) : Promise.resolve(false));
			return { remote };
		});
	}

	stop(): void {
		this.stopped = true;
		void this.queue(async () => {
			try {
				await this.flush([...this.pending.keys()], true);
			} finally {
				this.pending.clear();
				this.localEdits.clear();
				await this.db.close();
			}
		});
	}
}

function isNote(file: unknown): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() === "md";
}

interface RestoreAction {
	prompt: string;
	comparePrompt?: string;
	compare(): Promise<string | undefined>;
	apply(copy: string, current: string | undefined): Promise<void>;
}

interface HistoryRow {
	label: string;
	backup?: boolean;
	read(): Promise<string | undefined>;
	restore?: RestoreAction;
}

function showComparison(preview: HTMLElement, current: string, copy: string, context?: string): string {
	const diff = diffLines(current, copy);
	const summary = diff ? `${diff.added} ${diff.added === 1 ? "line" : "lines"} added, ${diff.removed} removed.` : "Too long to compare.";
	preview.setText("");
	if (context) preview.createEl("span", { text: context, cls: "ownsync-history-diff-summary" });
	preview.createEl("span", { text: summary, cls: "ownsync-history-diff-summary" });
	if (!diff) {
		preview.createEl("span", { text: copy.length > 8_000 ? `${copy.slice(0, 8_000)}…` : copy });
		return summary;
	}
	for (const { type, text } of diff.changes.slice(0, 200)) {
		const sign = type === "added" ? "+" : "−";
		const line = text.length > 500 ? `${text.slice(0, 500)}…` : text;
		preview.createEl("span", { text: `${sign} ${line}`, cls: `ownsync-history-diff-${type}` });
	}
	if (diff.changes.length > 200) preview.createEl("span", { text: "Showing the first 200 changed lines." });
	return summary;
}

class HistoryModal extends Modal {
	private showing = false;
	private acting = false;
	private confirmation?: Modal;

	constructor(private readonly plugin: HistoryHost, private readonly history: History, private readonly file?: TFile) {
		super(plugin.app);
	}

	async onOpen(): Promise<void> {
		this.showing = true;
		this.modalEl.addClass("ownsync-history-modal");
		const file = this.file;
		const engine = file ? undefined : this.plugin.engine?.();
		this.titleEl.setText(file ? "Note history" : "Recently deleted notes");
		if (file) return this.showNote(file);
		if (engine) this.contentEl.createEl("p", { text: "This list is the same on every device.", cls: "ownsync-lead" });
		const status = this.contentEl.createEl("p", { text: "Loading…", cls: "ownsync-quiet", attr: { role: "status" } });
		let rows: HistoryRow[] = [];
		try {
			if (engine) {
				const entries = await engine.deletedNotes();
				const now = Date.now();
				rows = [...entries].sort((a, b) => (b.deletedAt ?? -Infinity) - (a.deletedAt ?? -Infinity)).map((entry) => ({
					label: `${entry.path} (${deletedWhenLabel(entry.deletedAt, now)})`,
					read: () => engine.deletedText(entry.id),
					restore: {
						prompt: `Restore ${entry.path} to the vault?`,
						comparePrompt: "A note already uses this path. The restored note will get a new name.",
						compare: () => this.readAtPath(entry.path),
						apply: async (_, current) => {
							if (await this.readAtPath(entry.path) !== current) throw new Error("The note at this path changed. Select the copy again to review it.");
							if (this.plugin.engine?.() !== engine) throw new Error("Reopen Recently deleted notes and try again.");
							const path = await engine.restoreDeleted(entry.id);
							new Notice(path ? `Restored ${path}.` : "Note restored.");
						},
					},
				}));
			} else {
				const entries = await this.history.list();
				const now = Date.now();
				rows = entries.map((entry) => this.localDeletedRow(entry, now));
			}
			if (!this.showing) return;
			if (rows.length) status.remove();
			else status.setText("No recently deleted notes.");
		} catch {
			if (!this.showing) return;
			status.setText("Couldn't load recently deleted notes.");
		}
		if (rows.length) this.showEntries()(rows);
	}

	private async showNote(file: TFile): Promise<void> {
		const path = file.path;
		const now = Date.now();
		const target = this.history.backupFor(path);
		const fetching = target?.connected ? target.client.list(target.noteId).catch(() => []) : undefined;
		this.contentEl.createEl("p", {
			text: "This device saves copies up to once every 10 minutes and when you leave the note.",
			cls: "ownsync-lead",
		});
		const status = this.contentEl.createEl("p", { text: "Loading…", cls: "ownsync-quiet", attr: { role: "status" } });
		const show = this.showEntries();
		const current: HistoryRow = { label: "Now", read: () => this.app.vault.read(file) };
		show([current]);
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const forget = actions.createEl("button", { text: "Forget this note's history" });
		forget.onclick = () => {
			const prompt = this.history.backupFor(file.path) ? "Delete this device's copies and clear the note's backup?" : "Delete this device's copies?";
			this.confirm(forget, "Forget this note's history?", "Forget",
				`${prompt} Snapshots still hold this note's text until they expire or you delete them.`,
				async () => {
					const result = await this.history.forgetNote(file.path);
					if (!result) return;
					if (this.showing) this.close();
					if (await result.remote === false) new Notice("Local history cleared. Couldn't clear the backup.");
				}, true);
		};
		const local = await this.history.list(path).then((entries) => Promise.all(entries.map(async (entry) => {
			const read = () => this.history.text(entry);
			const text = await read();
			if (text !== undefined) return { takenAt: entry.time, text, row: this.noteRow(file, entry.time, now, read) };
		}))).then((copies) => {
			status.remove();
			return copies.filter((copy) => copy !== undefined);
		}, () => {
			if (this.showing) status.setText("Couldn't load saved copies.");
			return [];
		});
		if (!this.showing) return;
		show([current, ...mergeCopies(local, []).map(({ row }) => row)]);

		const copies = await fetching;
		if (!this.showing || !copies?.length) return;
		const active = this.history.backupFor(file.path);
		if (!active || active.client !== target?.client || active.noteId !== target.noteId) return;
		const backedUp = copies.map(({ takenAt, text }) => ({ takenAt, text, row: this.noteRow(file, takenAt, now, async () => text, true) }));
		show([current, ...mergeCopies(local, backedUp).map(({ row }) => row)]);
	}

	private noteRow(file: TFile, takenAt: number, now: number, read: HistoryRow["read"], backup = false): HistoryRow {
		return {
			label: whenLabel(takenAt, now),
			backup,
			read,
			restore: {
				prompt: "This replaces the current text of the note.",
				compare: () => this.app.vault.read(file),
				apply: async (text, current) => {
					const { vault } = this.app;
					if (!isNote(file) || vault.getFileByPath(file.path) !== file) throw new Error("The note is gone.");
					await vault.process(file, (latest) => {
						if (latest !== current) throw new Error("The note changed. Select the copy again to review it.");
						return text;
					});
				},
			},
		};
	}

	private localDeletedRow(entry: Entry, now: number): HistoryRow {
		const read = () => this.history.text(entry);
		return {
			label: `${entry.path} (${deletedWhenLabel(entry.time, now)})`,
			read,
			restore: {
				prompt: `Restore ${entry.path} to the vault?`,
				comparePrompt: "A note already uses this path. The restored note will get a new name.",
				compare: () => this.readAtPath(entry.path),
				apply: (text) => this.restoreLocalDeleted(entry, text),
			},
		};
	}

	private async readAtPath(path: string): Promise<string | undefined> {
		const file = this.app.vault.getFileByPath(path);
		if (isNote(file)) return this.app.vault.read(file);
	}

	private showEntries(): (entries: HistoryRow[]) => void {
		const body = this.contentEl.createDiv({ cls: "ownsync-history" });
		const list = body.createDiv({ cls: "ownsync-history-list", attr: { role: "group", "aria-label": this.file ? "Note copies" : "Deleted notes" } });
		const right = body.createDiv({ cls: "ownsync-history-right" });
		const preview = right.createEl("pre", { cls: "ownsync-history-preview", attr: { tabindex: "0", "aria-label": "Note preview" } });
		const restore = right.createEl("button", { text: "Restore", cls: "mod-cta" });
		const buttons = new Map<HistoryRow, HTMLButtonElement>();
		let selected: HTMLButtonElement | undefined;
		let selection = 0;
		const select = async (entry: HistoryRow, button: HTMLButtonElement) => {
			if (this.acting || this.confirmation) return;
			const version = ++selection;
			selected?.removeClass("is-active");
			selected?.setAttribute("aria-pressed", "false");
			selected = button;
			button.addClass("is-active");
			button.setAttribute("aria-pressed", "true");
			const action = entry.restore;
			restore.hidden = !action;
			restore.disabled = true;
			restore.onclick = null;
			preview.setText("Loading preview…");
			try {
				const text = await entry.read();
				if (!this.showing || selection !== version) return;
				const current = text === undefined ? undefined : await action?.compare();
				if (!this.showing || selection !== version) return;
				let prompt = action?.prompt ?? "";
				if (current !== undefined && text !== undefined) {
					const summary = showComparison(preview, current, text, action?.comparePrompt);
					if (action?.comparePrompt) prompt += ` ${action.comparePrompt}`;
					prompt += ` ${summary}`;
				} else preview.setText(text ?? "This copy is no longer available.");
				preview.scrollTop = 0;
				if (action && text !== undefined) {
					restore.disabled = false;
					restore.onclick = () => this.confirm(restore, "Restore this copy?", "Restore", prompt, () => this.restore(async () => {
						if (await entry.read() !== text) throw new Error("This copy is no longer available.");
						await action.apply(text, current);
					}), !!this.file);
				}
			} catch {
				if (this.showing && selection === version) preview.setText("Couldn't load the preview.");
			}
		};
		return (entries) => {
			// Later backup rows can be inserted without replacing the current selection or preview.
			entries.forEach((entry, index) => {
				let button = buttons.get(entry);
				if (!button) {
					button = list.createEl("button", {
						text: entry.label,
						cls: "ownsync-history-item",
						attr: { "aria-pressed": "false" },
					});
					if (entry.backup) button.createSpan({ text: " (from backup)", cls: "ownsync-quiet" });
					const rowButton = button;
					button.onclick = () => void select(entry, rowButton);
					buttons.set(entry, button);
				}
				if (list.children[index] !== button) list.insertBefore(button, list.children[index] ?? null);
				if (!selected) void select(entry, button);
			});
		};
	}

	private confirm(button: HTMLButtonElement, title: string, label: string, prompt: string, apply: () => Promise<void>, warning: boolean): void {
		if (this.confirmation || this.acting) return;
		const modal = new Modal(this.app);
		this.confirmation = modal;
		modal.onClose = () => { this.confirmation = undefined; };
		modal.titleEl.setText(title);
		modal.contentEl.createEl("p", { text: prompt });
		const actions = modal.contentEl.createDiv({ cls: "modal-button-container" });
		actions.createEl("button", { text: "Cancel" }).onclick = () => modal.close();
		actions.createEl("button", { text: label, cls: warning ? "mod-warning" : "mod-cta" }).onclick = () => {
			modal.close();
			button.disabled = true;
			this.acting = true;
			void apply().finally(() => {
				this.acting = false;
				if (this.showing) button.disabled = false;
			});
		};
		modal.open();
	}

	private async restore(apply: () => Promise<void>): Promise<void> {
		try {
			await apply();
			this.close();
		} catch (err) {
			new Notice(err instanceof Error ? `Couldn't restore the note. ${err.message}` : "Couldn't restore the note.");
		}
	}

	private async restoreLocalDeleted(entry: Entry, text: string): Promise<void> {
		const { vault } = this.app;
		const folder = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")));
		if (folder && !vault.getFolderByPath(folder)) {
			await vault.createFolder(folder).catch((err) => { if (!vault.getFolderByPath(folder)) throw err; });
		}
		const base = entry.path.replace(/\.md$/i, "");
		let path = entry.path, n = 1;
		while (await vault.adapter.exists(path)) {
			path = `${base} (restored${n === 1 ? "" : ` ${n}`}).md`;
			n++;
		}
		await vault.create(path, text);
		await this.history.forget(entry);
		new Notice(`Restored ${path}.`);
	}

	onClose(): void {
		this.showing = false;
		this.confirmation?.close();
		this.contentEl.empty();
	}
}

export function installHistory(plugin: HistoryHost, backup: ActiveBackup): void {
	const { app } = plugin, { vault, workspace } = app;
	const key = `${plugin.manifest.id}-history-id`;
	const existing: unknown = app.loadLocalStorage(key);
	const id = typeof existing === "string" && existing ? existing : crypto.randomUUID();
	if (id !== existing) app.saveLocalStorage(key, id);
	const history = new History(app, `ownsync-history-${id}`, backup);
	plugin.registerEditorExtension([undoOrigin, localEdit]);
	plugin.registerEvent(workspace.on("editor-change", (editor, { file }) => {
		if (!isNote(file)) return;
		const cm = (editor as unknown as { cm?: EditorView }).cm;
		if (cm) history.edited(file.path, cm.state.doc, cm.state.field(localEdit, false) === true);
	}));

	const changed = (file: unknown) => { if (isNote(file)) history.changed(file); };
	plugin.registerEvent(vault.on("modify", changed));
	plugin.registerEvent(vault.on("delete", (file) => {
		if (isNote(file) || file instanceof TFolder) history.removed(file.path, file);
	}));
	plugin.registerEvent(vault.on("rename", (file, from) => {
		if (file instanceof TFolder) history.renamed(from, file.path, true);
		else if (/\.md$/i.test(from)) {
			if (isNote(file)) history.renamed(from, file.path, false);
			else if (file instanceof TFile) history.removed(from, file);
		} else changed(file);
	}));
	workspace.onLayoutReady(() => {
		if (history.stopped) return;
		plugin.registerEvent(vault.on("create", changed));
		let active = workspace.getActiveViewOfType(FileView)?.file;
		const saveOnLeave = () => {
			const next = workspace.getActiveViewOfType(FileView)?.file;
			if (active !== next && isNote(active)) history.left(active.path);
			active = next;
		};
		plugin.registerEvent(workspace.on("active-leaf-change", saveOnLeave));
		plugin.registerEvent(workspace.on("file-open", saveOnLeave));
		history.seed();
	});

	let modal: HistoryModal | undefined;
	const open = (file?: TFile) => {
		modal?.close();
		modal = new HistoryModal(plugin, history, file);
		modal.open();
	};
	plugin.register(() => { modal?.close(); history.stop(); });
	plugin.addCommand({
		id: "show-note-history",
		name: "Show note history",
		checkCallback: (checking) => {
			const file = workspace.getActiveFile();
			if (!isNote(file)) return false;
			if (!checking) open(file);
			return true;
		},
	});
	plugin.addCommand({ id: "recently-deleted-notes", name: "Recently deleted notes", callback: () => open() });
	plugin.registerEvent(workspace.on("file-menu", (menu, file) => {
		if (isNote(file)) menu.addItem((item) => item.setTitle("Show history").setIcon("history").onClick(() => open(file)));
	}));
}
