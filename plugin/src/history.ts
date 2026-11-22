// Note history stays in this device's IndexedDB. Only an explicit restore writes to the vault.

import { type App, type Command, type EventRef, Modal, Notice, TFile, TFolder } from "obsidian";
import { MAX_BYTES, type Copy, keepCopies, whenLabel } from "./historyRules";

export interface HistoryHost {
	app: App;
	manifest: { id: string };
	registerEvent(ref: EventRef): void;
	addCommand(command: Command): unknown;
	register(callback: () => void): void;
}

const EVERY = 10 * 60_000;
const META = "meta", TEXT = "text";

interface Entry extends Copy { id: string; mtime: number }
interface Sample { path: string; text: string; mtime: number }
interface Pending { sample: Sample; timer?: number }

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

interface HistoryEdit {
	entries: Map<string, Entry>;
	read(id: string): Promise<string | undefined>;
	add(sample: Sample, time: number, deleted?: boolean): void;
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
					if (size > MAX_BYTES) return;
					const id = crypto.randomUUID();
					entries.set(id, { id, path, time, mtime, size, deleted });
					additions.set(id, text);
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
		if (!!e.deleted !== deleted) continue;
		const previous = newest.get(e.path);
		if (!previous || previous.time < e.time) newest.set(e.path, e);
	}
	return newest;
}

class History {
	private readonly db: HistoryDb;
	private readonly pending = new Map<string, Pending>();
	private work = Promise.resolve();
	private reported = false;
	stopped = false;

	constructor(private readonly app: App, name: string) {
		this.db = new HistoryDb(name, this.problem);
	}

	private problem = (err: unknown): void => {
		console.error("[ownsync] note history", err);
		if (this.reported) return;
		this.reported = true;
		new Notice("Ownsync couldn't save note history.");
	};

	private queue(work: () => Promise<void>): Promise<void> {
		this.work = this.work.then(work).catch(this.problem);
		return this.work;
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
		// Start reading before waiting for the previous event's transaction. A delete may already be next.
		const read = this.capture(file);
		void this.queue(async () => {
			const sample = await read;
			if (sample) await this.track([sample]);
		});
	}

	private async track(samples: Sample[]): Promise<void> {
		const ready: string[] = [];
		for (const sample of samples) {
			const existing = this.pending.get(sample.path);
			if (existing) existing.sample = sample;
			else this.pending.set(sample.path, { sample });
			if (existing?.timer === undefined) ready.push(sample.path);
		}
		await this.flush(ready);
	}

	private async flush(paths: string[], force = false): Promise<void> {
		const samples = paths.flatMap((path) => {
			const pending = this.pending.get(path);
			if (!pending) return [];
			this.cancelTimer(pending);
			return [pending.sample];
		});
		if (!samples.length) return;
		const due = await this.db.edit(async ({ entries, read, add }) => {
			const newest = newestByPath(entries.values());
			const now = Date.now();
			const due = new Map<string, number>();
			for (const sample of samples) {
				const last = newest.get(sample.path);
				if (last && !force && last.time + EVERY > now) {
					due.set(sample.path, last.time + EVERY);
				} else if (last && await read(last.id) === sample.text) {
					if (last.mtime !== sample.mtime) entries.set(last.id, { ...last, mtime: sample.mtime });
				} else {
					add(sample, Math.max(now, (last?.time ?? -Infinity) + 1));
				}
			}
			return due;
		});
		for (const { path } of samples) {
			const time = due.get(path);
			if (time === undefined) this.pending.delete(path);
			else if (!this.stopped) {
				const pending = this.pending.get(path)!;
				const timer = window.setTimeout(() => void this.queue(async () => {
					if (this.pending.get(path)?.timer === timer) await this.flush([path]);
				}), Math.max(0, time - Date.now()));
				pending.timer = timer;
			}
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
				return paths;
			});
			for (const p of cleared) this.clearPending(p);
		});
	}

	renamed(from: string, to: string, folder: boolean): void {
		if (this.stopped) return;
		const move = (path: string) => (folder ? path.startsWith(`${from}/`) : path === from) ? to + path.slice(from.length) : undefined;
		void this.queue(async () => {
			await this.db.edit(({ entries }) => {
				for (const e of entries.values()) {
					if (e.deleted) continue;
					const path = move(e.path);
					if (path !== undefined) entries.set(e.id, { ...e, path, size: e.size + 2 * (path.length - e.path.length) });
				}
			});
			const moved: string[] = [];
			for (const [path, { sample }] of [...this.pending]) {
				const next = move(path);
				if (next === undefined) continue;
				this.clearPending(path);
				this.clearPending(next);
				this.pending.set(next, { sample: { ...sample, path: next } });
				moved.push(next);
			}
			await this.flush(moved);
		});
	}

	async list(path?: string): Promise<Entry[]> {
		await this.work;
		const entries = keepCopies(await this.db.entries(), Date.now());
		return entries.filter((e) => path === undefined ? e.deleted : !e.deleted && e.path === path);
	}

	text(entry: Entry): Promise<string | undefined> {
		return this.db.text(entry.id);
	}

	async forget(entry: Entry): Promise<void> {
		await this.db.edit(({ entries }) => { entries.delete(entry.id); }).catch(this.problem);
	}

	stop(): void {
		this.stopped = true;
		void this.queue(async () => {
			try {
				await this.flush([...this.pending.keys()], true);
			} finally {
				this.pending.clear();
				await this.db.close();
			}
		});
	}
}

function isNote(file: unknown): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() === "md";
}

class HistoryModal extends Modal {
	private showing = false;
	private restoring = false;
	private confirmation?: Modal;

	constructor(app: App, private readonly history: History, private readonly file?: TFile) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.showing = true;
		this.modalEl.addClass("ownsync-history-modal");
		this.titleEl.setText(this.file ? "Note history" : "Recently deleted notes");
		const status = this.contentEl.createEl("p", { text: "Loading note history…", cls: "ownsync-quiet", attr: { role: "status" } });
		try {
			const entries = await this.history.list(this.file?.path);
			if (!this.showing) return;
			if (!entries.length) {
				status.setText(this.file ? "No saved copies of this note yet." : "No recently deleted notes.");
				return;
			}
			status.remove();
			this.showEntries(entries);
		} catch {
			if (this.showing) status.setText("Couldn't load note history.");
		}
	}

	private showEntries(entries: Entry[]): void {
		const body = this.contentEl.createDiv({ cls: "ownsync-history" });
		const list = body.createDiv({ cls: "ownsync-history-list", attr: { role: "group", "aria-label": this.file ? "Saved copies" : "Deleted notes" } });
		const right = body.createDiv({ cls: "ownsync-history-right" });
		const preview = right.createEl("pre", { cls: "ownsync-history-preview", attr: { tabindex: "0", "aria-label": "Note preview" } });
		const restore = right.createEl("button", { text: "Restore", cls: "mod-cta" });
		let selected: HTMLButtonElement | undefined;
		const select = async (entry: Entry, button: HTMLButtonElement) => {
			selected?.removeClass("is-active");
			selected?.setAttribute("aria-pressed", "false");
			selected = button;
			button.addClass("is-active");
			button.setAttribute("aria-pressed", "true");
			restore.disabled = true;
			preview.setText("Loading copy…");
			try {
				const text = await this.history.text(entry);
				if (!this.showing || selected !== button) return;
				preview.setText(text ?? "This copy is no longer available.");
				restore.disabled = text === undefined;
				restore.onclick = () => this.confirm(entry, restore);
			} catch {
				if (this.showing && selected === button) preview.setText("Couldn't load this copy.");
			}
		};
		const now = Date.now();
		for (const entry of entries) {
			const when = whenLabel(entry.time, now);
			const button = list.createEl("button", {
				text: this.file ? when : `${entry.path} (${when})`,
				cls: "ownsync-history-item",
				attr: { "aria-pressed": "false" },
			});
			button.onclick = () => void select(entry, button);
			if (!selected) void select(entry, button);
		}
	}

	private confirm(entry: Entry, button: HTMLButtonElement): void {
		if (this.confirmation || this.restoring) return;
		const modal = new Modal(this.app);
		this.confirmation = modal;
		modal.onClose = () => { this.confirmation = undefined; };
		modal.titleEl.setText("Restore this copy?");
		modal.contentEl.createEl("p", { text: this.file ? "This replaces the current text of the note." : `Restore ${entry.path} to the vault?` });
		const actions = modal.contentEl.createDiv({ cls: "modal-button-container" });
		actions.createEl("button", { text: "Cancel" }).onclick = () => modal.close();
		actions.createEl("button", { text: "Restore", cls: this.file ? "mod-warning" : "mod-cta" }).onclick = () => {
			modal.close();
			button.disabled = true;
			this.restoring = true;
			void this.restore(entry).finally(() => {
				this.restoring = false;
				if (this.showing) button.disabled = false;
			});
		};
		modal.open();
	}

	private async restore(entry: Entry): Promise<void> {
		try {
			const text = await this.history.text(entry);
			if (text === undefined) {
				new Notice("This copy is no longer available.");
				return;
			}
			const { vault } = this.app;
			if (this.file) {
				if (!isNote(this.file) || vault.getFileByPath(this.file.path) !== this.file) throw new Error("The note is gone.");
				await vault.modify(this.file, text);
			} else {
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
			this.close();
		} catch (err) {
			new Notice(err instanceof Error ? `Couldn't restore the note. ${err.message}` : "Couldn't restore the note.");
		}
	}

	onClose(): void {
		this.showing = false;
		this.confirmation?.close();
		this.contentEl.empty();
	}
}

export function installHistory(plugin: HistoryHost): void {
	const { app } = plugin, { vault, workspace } = app;
	const key = `${plugin.manifest.id}-history-id`;
	const existing: unknown = app.loadLocalStorage(key);
	const id = typeof existing === "string" && existing ? existing : crypto.randomUUID();
	if (id !== existing) app.saveLocalStorage(key, id);
	const history = new History(app, `ownsync-history-${id}`);

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
		history.seed();
	});

	let modal: HistoryModal | undefined;
	const open = (file?: TFile) => {
		modal?.close();
		modal = new HistoryModal(app, history, file);
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
