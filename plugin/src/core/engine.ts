// The sync engine. It knows nothing about Obsidian: it sees a local database, a folder of notes and a
// connection (ports.ts), and keeps them in agreement.
//
// Model
//   - The index: one Yjs map from a permanent note ID to { p: path } or, for a deleted note,
//     { p, d: the state vector the deleting device had seen }.
//   - One Yjs document per note (text "t"). Only notes open in an editor stay loaded.
//   - Per note, this device remembers where the file is and a hash of the text that file and document last
//     agreed on. "base:<id>" holds the note's state at that agreement for as long as the document is ahead
//     of the file; it is both the "a write is pending" marker and the common ancestor for merging.
//
// Rules
//   - Every input is handled one at a time, to completion. Its database writes are committed together,
//     before anything is sent, so a crash never leaves a sent edit that the device doesn't remember.
//   - The document is committed before the file is written. After a crash the file is either still the
//     agreed text (write it again) or already the document's text (agree).
//   - A file the user changed while the document also changed is merged, on top of the agreed version.
//   - A deletion only holds against devices that had nothing the deleter hadn't seen; otherwise the note
//     comes back.
//   - Two notes claiming one path both survive: the smaller ID keeps the path, the other gets a suffix.
//     Every device computes that the same way, so no extra edit is needed.
//   - File events say "look at this path", and the disk may have moved on by the time the engine looks. A
//     path with events still waiting isn't trusted; a rename says which note moved, so it is believed over
//     what the path happens to hold.
//   - At startup there are no events, so a note is matched to its file by content, as git matches renames.
//   - A note open in an editor is the editor's: its file is that editor's save, never merged back in. If
//     the app stops while it's open, the document wins, and a save that might hold unrecorded typing is
//     kept as a separate "(recovered …)" note.
//
// Attachments (every file that isn't ".md") are notes whose document holds versions (Ref) instead of text,
// so IDs, paths, renames, deletions and the startup scan are the notes' own. What differs:
//   - Content is chunks on the server. A new version is published only once the server has stored every
//     chunk; a file is written only once every chunk is here and the whole content checks out.
//   - Nothing can be merged. A new version deletes the one it was made from and adds itself, so versions
//     made concurrently both stay in the document. The first keeps the attachment; each other one becomes
//     an attachment of its own named "(conflict …)", under an ID the version carries, so every device that
//     splits them makes the same copy.
//   - At startup, an attachment is matched to a file by exact content only.
//
// Not done yet
//   - Deleted notes keep their state forever (a device may still need it to bring the note back).
//   - A live edit is relayed before it is stored, and other devices build on it. If the sending device is
//     destroyed in the seconds before it stores that edit, the others keep it, but it reaches the server
//     only with one of their snapshots. Edits built on it wait (inside Yjs) until then.

import * as Y from "yjs";
import { applyText } from "./text";
import type { ClientMsg, Disk, DiskFile, DocId, Entry, Link, Meta, NoteMeta, Ref, ServerMsg, Store, Upload } from "./ports";

const INDEX: DocId = "index";
const REMOTE = "ownsync-remote"; // transaction origin for changes that didn't start on this device
type IndexValue = { p: string; d?: string };
/** Chunks in flight each way: enough to keep the line busy, few enough that memory holds one file plus these. */
const WINDOW = 4;

export interface EngineOptions {
	hash(text: string): Promise<string>;
	/** Names content by a keyed hash (the server can't test guesses): a chunk, and an attachment's version. */
	chunkName(data: Uint8Array): Promise<string>;
	newId(): string;
	/** Default 1 MiB. */
	chunkSize?: number;
	/** Larger attachments are reported and left alone. Default 20 MB. */
	maxFileSize?: number;
	/**
	 * False: this device syncs notes only. It neither uploads, downloads nor deletes attachments, and forgets
	 * the ones it knew, so turning attachments back on later finds them by content and downloads the rest.
	 */
	attachments?: boolean;
	/** Entries applied to one document before this device offers the server a snapshot of it. */
	snapshotAfter?: number;
	/** Least time in ms between storing edits on the server; edits made meanwhile go together. Default 0. */
	pace?: number;
	/** Something went wrong with one note or message; sync continues with the rest. */
	onProblem?(what: string, err: unknown): void;
	/** A note that was open in an editor was deleted on another device. */
	onClosed?(id: string): void;
	/** Source of Yjs client IDs; tests pass a seeded one. */
	random?(): number;
	/** When to start handling a file event. Tests delay it to model a busy engine; by default, at once. */
	defer?(start: () => void): void;
}

/**
 * How to treat a file that differs from its note's document.
 * - "merge": the user edited the file; merge their edit in.
 * - "doc": the file can only be an older save of the document (the note is, or was just, open in an editor).
 *   Known limit: another program writing the file in the instant its editor closes is taken for such a save
 *   and overwritten. While a note is open, Obsidian itself merges outside changes into the editor.
 * - "recover": the note was open when the app last stopped. The file is the editor's last save, which may
 *   hold typing that was never recorded. If that can't be ruled out, the file's text is kept as a separate note.
 */
export type Mode = "merge" | "doc" | "recover";

const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** How alike two texts must be (0 to 1) to count as the same note, edited. */
const ALIKE = 0.5;
/** A text as a set of lines, or of words when it has few lines. */
function units(text: string): Set<string> {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	return new Set(lines.length >= 4 ? lines : text.split(/\s+/).filter(Boolean));
}
/**
 * How much of the smaller text is in the larger one: a note that grew or shrank a lot is still the same note.
 * (A small note matching a big unrelated file is harmless: it would otherwise have counted as deleted.)
 * The share of the larger text breaks ties, so an exact copy beats a superset.
 */
function alike(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return a.size === b.size ? 1 : 0;
	let shared = 0;
	for (const u of a) if (b.has(u)) shared++;
	return shared / Math.min(a.size, b.size) + shared / Math.max(a.size, b.size) / 1000;
}
// Before the extension, so a copy keeps its file type.
const conflictName = (path: string, id: string) => path.replace(/(\.[^./]*)?$/, ` (conflict ${id.slice(0, 6)})$1`);
/** Everything else is an attachment. Exactly Obsidian's rule, so a file is the same kind everywhere. */
const isNote = (path: string) => path.endsWith(".md");

export class Engine {
	private meta: Meta = { cursor: 0, synced: false, nextOut: 1 };
	private index = new Y.Doc();
	private notes = this.index.getMap<IndexValue>("notes");
	private metas = new Map<string, NoteMeta>();
	private byPath = new Map<string, string>(); // disk path → note ID
	private opened = new Map<string, Y.Doc>();
	private outbox: { id: number; entry: Entry }[] = [];
	private liveOut: Entry[] = []; // this input's edits, to relay to other devices right away
	private lastPublish = 0;
	private paceTimer: number | null = null;
	private indexOut: Uint8Array[] = []; // this input's index changes, sent as one entry
	private indexDirty = false;
	/** Where every live note's file belongs, worked out from the index alone, so every device agrees. */
	private layout: { paths: Map<string, string>; owners: Map<string, string>; groups: Map<string, string[]> } | null = null;
	private claimed = new Map<string, number>(); // index path → how many live notes claim it
	private shifted = new Map<string, Set<string>>(); // index path → notes this device moved onto or off it, this input
	private link: Link | null = null;
	private live = false; // caught up on this link
	private sent = 0; // highest outbox ID sent on this link
	private tail = new Map<DocId, number>();
	private puts = new Map<string, unknown>();
	private dels = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private settling = new Set<string>();
	private unknown = new Map<string, string>(); // within one input: hashes of files read while looking for a moved note
	private dirty = new Map<string, number>(); // paths with file events announced but not handled yet
	private deferred = new Set<string>(); // notes waiting for those events before their file is touched
	private losing = new Set<string>();
	private joining = false; // the first look at this device's files after it first caught up with the vault
	private ownRenames = new Map<string, string>(); // to → from, for moves the engine made itself
	// Attachments move one file at a time each way, a few chunks in flight: a file is in memory whole only
	// while it is read or written (Obsidian has no partial reads or writes).
	private ups = new Set<string>(); // attachments with an "up:" record
	private uploading: { id: string; ref: Ref; bytes: Uint8Array; asked: Set<string>; stored: Set<string>; stalled?: boolean } | null = null;
	private fetching: { id: string; ref: Ref; asked: Set<string>; got: Map<string, Uint8Array> } | null = null;
	private toFetch = new Set<string>(); // attachments waiting for their turn to download
	private retry = new Set<string>(); // downloads the server was missing a chunk for: tried again on the next connection
	// One Yjs client ID per run, so a crash or a copied profile can never reuse an ID with different edits.
	private clientId: number;

	constructor(private readonly store: Store, private readonly disk: Disk, private readonly opts: EngineOptions) {
		this.clientId = this.newClientId();
		this.index.clientID = this.clientId;
		this.index.on("update", (update: Uint8Array, origin: unknown) => {
			this.indexDirty = true;
			this.layout = null;
			if (origin !== REMOTE) this.indexOut.push(update);
		});
		// Which index paths have live notes, kept up to date cheaply: most lookups only need to know whether
		// a path is claimed at all, and recomputing the whole layout for each of 10,000 imported notes is slow.
		this.notes.observe((e) => {
			for (const [id, change] of e.changes.keys) {
				const was = change.oldValue as IndexValue | undefined, now = this.notes.get(id);
				if (was && was.d === undefined) this.claimed.set(was.p, (this.claimed.get(was.p) ?? 1) - 1);
				if (now && now.d === undefined) this.claimed.set(now.p, (this.claimed.get(now.p) ?? 0) + 1);
				if (e.transaction.origin !== REMOTE) for (const p of new Set([was?.p, now?.p])) if (p !== undefined) this.shifted.set(p, (this.shifted.get(p) ?? new Set()).add(id));
			}
		});
	}

	private mark(path: string, by: number): void {
		const n = (this.dirty.get(path) ?? 0) + by;
		if (n > 0) this.dirty.set(path, n);
		else this.dirty.delete(path);
	}

	private later(start: () => void): void {
		(this.opts.defer ?? ((f: () => void) => f()))(start);
	}

	private newClientId(): number {
		return Math.floor((this.opts.random ?? Math.random)() * 0xffffffff);
	}

	// --- inputs ---

	start(): Promise<void> {
		return this.run("start", async () => {
			this.meta = (await this.store.get<Meta>("meta")) ?? this.meta;
			const index = await this.store.get<Uint8Array>("index");
			if (index) Y.applyUpdate(this.index, index, REMOTE);
			this.indexDirty = false;
			for (const [key, m] of await this.store.list<NoteMeta>("note:")) {
				this.metas.set(key.slice(5), m);
				if (m.diskPath) this.byPath.set(m.diskPath, key.slice(5));
			}
			if (this.notesOnly) for (const [id, m] of this.metas) if (m.diskPath && !isNote(m.diskPath)) this.forget(id);
			this.outbox = (await this.store.list<Entry>("out:")).map(([key, entry]) => ({ id: Number(key.slice(4)), entry })).sort((a, b) => a.id - b.id);
			for (const [key] of await this.store.list("up:")) this.ups.add(key.slice(3));
			// Before the first catch-up, local files can't be told apart from the vault's notes yet.
			if (this.meta.synced) await this.scan();
		});
	}

	/**
	 * A file was created, changed or deleted. File events tell the engine to look at a path, and by the time
	 * it looks, later events may already have changed what is there. So a path with events still waiting is
	 * not trusted (`dirty`), and anything that needs it waits for those events.
	 */
	diskChanged(path: string): void {
		if (this.notesOnly && !isNote(path)) return;
		this.mark(path, 1);
		this.later(() => void this.run(`disk ${path}`, async () => {
			this.mark(path, -1);
			if (!this.meta.synced || this.dirty.has(path)) return; // a later event covers this path
			const id = this.byPath.get(path);
			if (id) await this.settle(id);
			else if (await this.disk.stat(path)) {
				const taken = await this.takeUnknown(path);
				if (taken) await this.settleGroup(taken);
			}
		}));
	}

	/** The file at `from` is now at `to`. Whatever was at `to` before is no longer there. */
	diskRenamed(from: string, to: string): void {
		if (this.ownRenames.get(to) === from) return void this.ownRenames.delete(to); // the engine's own move, already recorded
		if (this.notesOnly && !isNote(from) && !isNote(to)) return;
		// A note renamed to an attachment, or back: one file gone, an unrelated one new.
		if (isNote(from) !== isNote(to)) return void (this.diskChanged(from), this.diskChanged(to));
		this.mark(from, 1);
		this.mark(to, 1);
		this.later(() => void this.run(`rename ${from}`, async () => {
			this.mark(from, -1);
			this.mark(to, -1);
			if (!this.meta.synced) return;
			const id = this.byPath.get(from), occupant = this.byPath.get(to);
			if (occupant && occupant !== id) await this.lost(occupant);
			if (id) {
				this.movedTo(id, to);
				await this.settleGroup(id);
			} else if (!this.dirty.has(to) && !this.byPath.has(to) && (await this.disk.stat(to))) {
				const taken = await this.takeUnknown(to);
				if (taken) await this.settleGroup(taken);
			}
			if (occupant && occupant !== id) await this.settle(occupant);
		}));
	}

	/** Load a note for an editor. Edits to the returned document are synced; remote edits appear in it. */
	open(id: string): Promise<Y.Doc | undefined> {
		let doc: Y.Doc | undefined;
		return this.run(`open ${id}`, async () => {
			if (this.opened.has(id)) return void (doc = this.opened.get(id));
			await this.settle(id); // the editor is about to show the file: take in what's on disk first
			if (this.effectivePath(id) === undefined) return;
			doc = this.load(await this.state(id), this.clientId);
			const opened = doc;
			opened.on("update", (update: Uint8Array, origin: unknown) => {
				if (origin !== REMOTE) void this.run(`edit ${id}`, async () => { if (this.opened.get(id) === opened) await this.merge(id, update, true); });
			});
			this.opened.set(id, doc);
			this.metaOf(id).open = true;
			this.put(`note:${id}`, this.metaOf(id));
		}).then(() => doc);
	}

	close(id: string): Promise<void> {
		return this.run(`close ${id}`, async () => {
			const doc = this.opened.get(id);
			if (!doc) return;
			this.opened.delete(id);
			doc.destroy();
			// Every keystroke is on record by now, so the file is at most an older save of the document.
			this.owe(id, "doc");
			await this.settle(id);
		});
	}

	connected(link: Link): Promise<void> {
		return this.run("connected", async () => {
			this.link = link;
			this.live = false;
			this.sent = 0;
			// Whatever was in flight on the old link is asked again; what the server lacked is tried again.
			if (this.uploading) Object.assign(this.uploading, { asked: new Set(), stalled: false });
			this.fetching?.asked.clear();
			for (const id of this.retry) this.toFetch.add(id);
			this.retry.clear();
			link.send({ t: "subscribe", after: this.meta.cursor });
		});
	}

	disconnected(): Promise<void> {
		return this.run("disconnected", async () => {
			this.link = null;
			this.live = false;
		});
	}

	/** Stop timers. The engine must not be used afterwards. */
	stop(): void {
		if (this.paceTimer) window.clearTimeout(this.paceTimer);
	}

	receive(msg: ServerMsg): Promise<void> {
		return this.run(`receive ${msg.t}`, async () => {
			if (msg.t === "stored" || msg.t === "chunk" || msg.t === "missing") await this.transferred(msg);
			else if (msg.t === "entry" || msg.t === "live") {
				// A live update is the same edit that arrives again shortly as a stored entry; only that one moves the cursor.
				if (msg.t === "entry") {
					if (msg.seq > this.meta.cursor) this.setCursor(msg.seq);
					this.tail.set(msg.entry.doc, msg.entry.kind === "snapshot" ? 0 : (this.tail.get(msg.entry.doc) ?? 0) + 1);
				}
				if (msg.entry.doc === INDEX) await this.applyIndex(msg.entry.data);
				else {
					await this.merge(msg.entry.doc, msg.entry.data, false);
					if (this.meta.synced) await this.settle(msg.entry.doc);
				}
			} else if (msg.t === "more") {
				// One page of the catch-up is in; everything up to `seq` has been sent. Ask for the next.
				if (msg.seq > this.meta.cursor) this.setCursor(msg.seq);
				await this.flush();
				this.link?.send({ t: "subscribe", after: this.meta.cursor });
			} else if (msg.t === "synced") {
				if (msg.seq > this.meta.cursor) this.setCursor(msg.seq);
				this.live = true;
				if (!this.meta.synced) {
					this.meta.synced = true;
					this.put("meta", this.meta);
					this.joining = true;
					await this.scan().finally(() => (this.joining = false));
				}
			} else {
				// One publish carries every edit to its document that was waiting, up to `id`.
				const doc = this.outbox.find((o) => o.id === msg.id)?.entry.doc;
				if (doc === undefined) return;
				for (const o of this.outbox) if (o.entry.doc === doc && o.id <= msg.id) this.del(`out:${o.id}`);
				this.outbox = this.outbox.filter((o) => !(o.entry.doc === doc && o.id <= msg.id));
				// The link is ordered, so everything before our own entry has already arrived.
				if (msg.seq > this.meta.cursor) this.setCursor(msg.seq);
				this.tail.set(doc, (this.tail.get(doc) ?? 0) + 1);
				await this.offerSnapshot(doc);
			}
		});
	}

	/**
	 * Send the server a snapshot of every document, so all of it is there under the vault's new key after a
	 * rotation. Resolves to whether they were sent (only while caught up on a connection).
	 */
	snapshotAll(): Promise<boolean> {
		let sent = false;
		return this.run("snapshot all", async () => {
			if (!this.link || !this.live) return;
			await this.flush(); // the cursor they name must be on record first
			for (const doc of [INDEX, ...this.notes.keys()]) {
				const data = doc === INDEX ? Y.encodeStateAsUpdate(this.index) : await this.state(doc);
				if (!data) continue;
				this.tail.set(doc, 0);
				this.link.send({ t: "snapshot", doc, base: this.meta.cursor, data });
			}
			sent = true;
		}).then(() => sent);
	}

	/** Resolves when every input so far has been handled. */
	idle(): Promise<void> {
		return this.queue;
	}

	noteAt(path: string): string | undefined {
		return this.byPath.get(path);
	}

	isOpen(id: string): boolean {
		return this.opened.has(id);
	}

	// --- one input at a time, committed, then sent ---

	private run(what: string, fn: () => Promise<void>): Promise<void> {
		const next = this.queue.then(async () => {
			try {
				await fn();
			} catch (err) {
				this.opts.onProblem?.(what, err);
			}
			// Notes that were waiting for file events: try again now that this one is handled. And notes whose
			// place a change made here moved: no remote update will come to say so.
			for (let ids = [...this.deferred, ...this.regrouped()]; ids.length; ids = this.regrouped()) {
				for (const id of ids) {
					this.deferred.delete(id);
					await this.settle(id);
				}
			}
			await this.nextTransfers().catch((err) => this.opts.onProblem?.("attachments", err));
			this.unknown.clear();
			await this.flush();
			this.pump();
		});
		this.queue = next.catch((err) => this.opts.onProblem?.(`commit after ${what}`, err));
		return this.queue;
	}

	private put(key: string, value: unknown): void {
		this.puts.set(key, value);
		this.dels.delete(key);
	}

	private del(key: string): void {
		this.dels.add(key);
		this.puts.delete(key);
	}

	private async read<T>(key: string): Promise<T | undefined> {
		if (this.puts.has(key)) return this.puts.get(key) as T;
		if (this.dels.has(key)) return undefined;
		return this.store.get<T>(key);
	}

	private async flush(): Promise<void> {
		if (this.indexOut.length) {
			this.send(INDEX, Y.mergeUpdates(this.indexOut));
			this.indexOut = [];
		}
		if (this.indexDirty) {
			this.put("index", Y.encodeStateAsUpdate(this.index));
			this.indexDirty = false;
		}
		if (!this.puts.size && !this.dels.size) return;
		const puts = this.puts, dels = this.dels;
		this.puts = new Map();
		this.dels = new Set();
		await this.store.commit(puts, dels);
	}

	private send(doc: DocId, data: Uint8Array): void {
		const item = { id: this.meta.nextOut++, entry: { doc, kind: "update" as const, data } };
		this.outbox.push(item);
		this.liveOut.push(item.entry);
		this.put("meta", this.meta);
		this.put(`out:${item.id}`, item.entry);
	}

	/**
	 * Send what's waiting. Each edit goes out at once as a live frame, which the server relays to the other
	 * devices and forgets. For storing, the edits to one document go as one entry, and no more often than
	 * `pace`: typing then costs the server a row every few seconds, not every keystroke.
	 */
	private pump(): void {
		const live = this.liveOut;
		this.liveOut = [];
		if (!this.link || !this.live) return;
		for (const entry of live) this.link.send({ t: "live", entry });
		this.sendChunks();
		const wait = this.lastPublish + (this.opts.pace ?? 0) - Date.now();
		if (wait > 0) {
			this.paceTimer ??= window.setTimeout(() => {
				this.paceTimer = null;
				void this.run("publish", async () => {});
			}, wait);
			return;
		}
		const groups = new Map<DocId, { id: number; data: Uint8Array[] }>();
		for (const o of this.outbox) {
			if (o.id <= this.sent) continue;
			const g = groups.get(o.entry.doc);
			if (g) { g.id = o.id; g.data.push(o.entry.data); }
			else groups.set(o.entry.doc, { id: o.id, data: [o.entry.data] });
			this.sent = o.id;
		}
		for (const [doc, g] of groups) {
			this.link.send({ t: "publish", id: g.id, entry: { doc, kind: "update", data: g.data.length === 1 ? g.data[0]! : Y.mergeUpdates(g.data) } });
			this.lastPublish = Date.now();
		}
	}

	private setCursor(seq: number): void {
		this.meta.cursor = seq;
		this.put("meta", this.meta);
	}

	// Once enough small entries have piled up for a document, give the server the whole thing so it can drop them.
	private async offerSnapshot(doc: DocId): Promise<void> {
		if (!this.link || !this.live || (this.tail.get(doc) ?? 0) < (this.opts.snapshotAfter ?? 50)) return;
		if (this.outbox.some((o) => o.entry.doc === doc)) return; // wait until our own edits are acknowledged
		const data = doc === INDEX ? Y.encodeStateAsUpdate(this.index) : await this.state(doc);
		if (!data) return;
		this.tail.set(doc, 0);
		const msg: ClientMsg = { t: "snapshot", doc, base: this.meta.cursor, data };
		await this.flush(); // the cursor it names must be on record first
		this.link?.send(msg);
	}

	// --- documents ---

	/** `clientId`: set it only on a document that is about to make edits of its own. */
	private load(state?: Uint8Array, clientId?: number): Y.Doc {
		const doc = new Y.Doc({ guid: "note" }); // a fixed guid: the default costs a random UUID per document
		if (state) Y.applyUpdate(doc, state, REMOTE);
		if (clientId !== undefined) doc.clientID = clientId; // after loading: the state may hold this run's earlier edits
		return doc;
	}

	private state(id: string): Promise<Uint8Array | undefined> {
		return this.read<Uint8Array>(`state:${id}`);
	}

	private async text(id: string): Promise<string | undefined> {
		const open = this.opened.get(id);
		if (open) return open.getText("t").toString();
		const state = await this.state(id);
		if (!state) return undefined;
		const doc = this.load(state);
		const text = doc.getText("t").toString();
		doc.destroy();
		return text;
	}

	private metaOf(id: string): NoteMeta {
		let m = this.metas.get(id);
		if (!m) this.metas.set(id, (m = {}));
		return m;
	}

	/**
	 * Add an update to a note. `local`: it was made on this device and must be sent. Unless it came from the
	 * note's own file, the document is now ahead of the file, so the agreed state is kept for merging.
	 */
	private async merge(id: string, update: Uint8Array, local: boolean, fromDisk = false): Promise<void> {
		const before = await this.state(id);
		// Built from the stored state, never from the live editor document: that one may already hold
		// keystrokes whose turn to be recorded and sent hasn't come yet.
		const doc = this.load(before);
		Y.applyUpdate(doc, update, REMOTE);
		const after = Y.encodeStateAsUpdate(doc); // also drops the content of deleted text
		doc.destroy();
		if (!fromDisk && before && this.metaOf(id).baseHash !== undefined && !(await this.read(`base:${id}`))) this.put(`base:${id}`, before);
		this.put(`state:${id}`, after);
		if (local) return this.send(id, update);
		const open = this.opened.get(id);
		if (!open) return;
		// On record before the editor shows it: whatever an editor saves to disk is then always already known.
		await this.flush();
		if (this.opened.get(id) === open) Y.applyUpdate(open, update, REMOTE);
	}

	private async applyIndex(update: Uint8Array): Promise<void> {
		const touched = new Set<string>();
		const watch = (e: Y.YMapEvent<IndexValue>) => e.keysChanged.forEach((k) => touched.add(k));
		this.notes.observe(watch);
		Y.applyUpdate(this.index, update, REMOTE);
		this.notes.unobserve(watch);
		// Always save: an update that has to wait for one this device hasn't got yet changes nothing visible
		// (and fires no event), but must not be forgotten once the cursor has moved past it.
		this.indexDirty = true;
		if (!this.meta.synced) return;
		// A path gained or lost a claimant, so other notes' places may have changed too.
		for (const [id, m] of this.metas) if (m.diskPath !== this.effectivePath(id)) touched.add(id);
		for (const id of touched) await this.settle(id);
	}

	private places() {
		if (this.layout) return this.layout;
		const groups = new Map<string, string[]>(); // index path → the notes claiming it
		for (const [id, v] of this.notes) {
			if (v.d !== undefined) continue;
			const g = groups.get(v.p);
			if (g) g.push(id);
			else groups.set(v.p, [id]);
		}
		// The smallest ID keeps the path; the others get a suffix, and again if that name is itself claimed.
		const paths = new Map<string, string>(), owners = new Map<string, string>();
		for (const [path, g] of groups) owners.set(path, g.sort()[0]!);
		for (const path of [...groups.keys()].sort()) {
			for (const id of groups.get(path)!.slice(1)) {
				let name = conflictName(path, id);
				while (owners.has(name)) name = conflictName(name, id);
				owners.set(name, id);
			}
		}
		for (const [path, id] of owners) paths.set(id, path);
		return (this.layout = { paths, owners, groups });
	}

	private effectivePath(id: string): string | undefined {
		return this.places().paths.get(id);
	}

	// --- disk ---

	private place(id: string, path: string | undefined, file?: DiskFile): void {
		const m = this.metaOf(id);
		if (m.diskPath && this.byPath.get(m.diskPath) === id) this.byPath.delete(m.diskPath);
		m.diskPath = path;
		// One path, one note. Whoever was recorded there no longer is; its file will be settled afresh.
		const before = path === undefined ? undefined : this.byPath.get(path);
		if (before !== undefined && before !== id) {
			this.metaOf(before).diskPath = undefined;
			this.put(`note:${before}`, this.metaOf(before));
			this.deferred.add(before);
		}
		if (path) this.byPath.set(path, id);
		if (file) { m.mtime = file.mtime; m.size = file.size; }
		this.put(`note:${id}`, m);
	}

	/**
	 * The note's file is at `path` now. That is a move by the user, to be recorded in the index, unless
	 * `path` is simply where the index already puts the note (its own conflict-suffixed name included).
	 */
	private movedTo(id: string, path: string, file?: DiskFile): void {
		this.place(id, path, file);
		if (this.effectivePath(id) !== path) this.notes.set(id, { p: path });
	}

	/**
	 * The note's editor is gone, and its file is that editor's save, not an outside edit: the document must
	 * overwrite it. Kept on record until file and document agree, so no crash or delay can turn the save
	 * into something that gets merged in a second time.
	 */
	private owe(id: string, mode: "doc" | "recover"): void {
		const m = this.metaOf(id);
		m.open = undefined;
		if (m.owed !== "recover") m.owed = mode;
		this.put(`note:${id}`, m);
	}

	/** The note has no file on this device any more. */
	private forget(id: string): void {
		Object.assign(this.metaOf(id), { baseHash: undefined, mtime: undefined, size: undefined, owed: undefined, writing: undefined });
		this.place(id, undefined);
		this.del(`base:${id}`);
		this.dropUpload(id); // its content went with the file
	}

	private agree(id: string, file: DiskFile, hash: string): void {
		const m = this.metaOf(id);
		Object.assign(m, { baseHash: hash, mtime: file.mtime, size: file.size, owed: undefined, writing: undefined });
		this.put(`note:${id}`, m);
		this.del(`base:${id}`);
	}

	/**
	 * Startup: find what changed on disk while the engine wasn't running, and finish interrupted writes.
	 *
	 * There were no file events to say what moved where, so identity is worked out from content, as git does
	 * for renames: a file that is mostly some other note's text is that note, moved (and perhaps edited).
	 * Without this, a note renamed and edited while the app was closed would be taken for a deletion plus an
	 * unrelated new note, and an edit made to it on another device meanwhile would bring back a second copy.
	 */
	private async scan(): Promise<void> {
		const files = (await this.disk.list()).filter((f) => !this.notesOnly || isNote(f.path));
		const onDisk = new Map(files.map((f) => [f.path, f]));
		const atStart = async (id: string) => {
			// A note still marked open was in an editor when the app stopped: its file is that editor's last save.
			if (this.metaOf(id).open && !this.opened.has(id)) this.owe(id, "recover");
			await this.settle(id);
		};
		const todo = new Set<string>();

		// Notes that can't be sure of their file, and files that can't be sure of their note.
		// A note is compared by its text now and by the text its file last agreed on: when the document has moved
		// ahead (typing that was never saved, a remote edit), the file is closer to the latter.
		const adrift = new Map<string, Set<string>[]>(); // note → the words of those texts
		const like = (mine: Set<string>[], theirs: Set<string>) => Math.max(...mine.map((m) => alike(m, theirs)));
		const loose = new Map<string, Set<string>>(); // path → the words of the file's text
		const home = new Map<string, string>(); // note → its path, when a file is still there
		const changed = new Map<string, string>(); // attachment → its path, where its file now has other content
		for (const [path, id] of [...this.byPath]) {
			const f = onDisk.get(path), m = this.metaOf(id);
			if (f && m.mtime === f.mtime && m.size === f.size) continue; // untouched
			// An attachment changed in place is a new version of it. One that's gone is matched by exact content
			// below; it is alike no file (no units).
			if (!isNote(path)) {
				if (f) changed.set(id, path);
				else adrift.set(id, []);
				continue;
			}
			const base = await this.read<Uint8Array>(`base:${id}`);
			const mine = [units((await this.text(id)) ?? "")];
			if (base) {
				const doc = this.load(base);
				mine.push(units(doc.getText("t").toString()));
				doc.destroy();
			}
			if (f) {
				const theirs = units(await this.disk.read(path));
				if (like(mine, theirs) >= ALIKE) { todo.add(id); continue; } // an ordinary edit, or an editor's save
				loose.set(path, theirs); // perhaps a different file now sits at the note's path
				// Only a note whose file was here can claim it however much it changed. One that was only about to be
				// written here (the engine stopped first) has no file yet: a different text here is someone else's.
				if (m.baseHash !== undefined) home.set(id, path);
			}
			adrift.set(id, mine);
		}
		for (const f of files) if (isNote(f.path) && !this.byPath.has(f.path)) loose.set(f.path, units(await this.disk.read(f.path)));
		// An attachment's file with other content is a new version of it, unless that content is exactly another
		// attachment's whose file isn't where it was: then that one moved here (two swapped places, say), and this
		// one's own file is looked for like any that is gone.
		const swapped = new Map<string, string>(); // attachment → the path its file moved to
		for (const [id, path] of changed) {
			const h = await this.disk.readBinary(path).then((b) => this.opts.chunkName(b), () => undefined);
			const other = [...adrift.keys(), ...changed.keys()].find((o) => o !== id && !swapped.has(o) && this.metaOf(o).baseHash === h && !isNote(this.metaOf(o).diskPath ?? ""));
			if (other === undefined) { todo.add(id); continue; }
			swapped.set(other, path);
			adrift.set(id, []);
		}
		for (const id of swapped.keys()) if (changed.has(id) && !adrift.has(id)) adrift.set(id, []); // its own path now holds someone else's file

		// Pair them up, best match first.
		const pairs: [score: number, id: string, path: string][] = [];
		for (const [id, mine] of adrift) for (const [path, theirs] of loose) {
			// The note's own recovered copy, written just before the engine stopped and not yet on record, is never the note.
			if (path.includes(` (recovered ${id.slice(0, 6)}`)) continue;
			// A recovery copy holds its note's text too: when both match a file, the file is the note's.
			const score = like(mine, theirs) - (this.metaOf(id).copyOf ? 0.01 : 0);
			if (score >= ALIKE) pairs.push([score, id, path]);
		}
		pairs.sort((x, y) => y[0] - x[0] || (x[1] + x[2] < y[1] + y[2] ? -1 : 1));
		const moved = new Map<string, string>(swapped);
		for (const [, id, path] of pairs) if (!moved.has(id) && ![...moved.values()].includes(path)) moved.set(id, path);
		// Nothing better claimed the file still at a note's own path: then it is that note, however much it changed.
		for (const [id, path] of home) if (!moved.has(id) && ![...moved.values()].includes(path)) moved.set(id, path);
		// An attachment that moved has exactly its agreed content; only files of its size need reading.
		for (const [id, mine] of adrift) {
			if (mine.length || moved.has(id)) continue;
			const m = this.metaOf(id);
			for (const f of files) {
				if (isNote(f.path) || this.byPath.has(f.path) || f.size !== m.size || [...moved.values()].includes(f.path)) continue;
				const h = await this.disk.readBinary(f.path).then((b) => this.opts.chunkName(b), () => undefined);
				if (h === m.baseHash) { moved.set(id, f.path); break; }
			}
		}
		for (const id of adrift.keys()) this.place(id, undefined); // everyone out, then into their new places
		for (const [id, path] of moved) {
			this.movedTo(id, path);
			todo.add(id);
		}
		// A note with no file left was deleted, unless the document has an edit the file never showed.
		for (const id of adrift.keys()) {
			if (moved.has(id)) continue;
			const pending = await this.ahead(id);
			this.forget(id);
			if (!pending) await this.tombstone(id);
			todo.add(id);
		}
		// A file that is nobody's is a new note (or, on a device joining the vault, a note it already has).
		for (const f of files) {
			const id = this.byPath.has(f.path) ? undefined : await this.takeUnknown(f.path);
			if (id) todo.add(id);
		}

		for (const [key] of await this.store.list("base:")) todo.add(key.slice(5)); // a write was pending
		for (const [id, v] of this.notes) if (v.d === undefined && !this.metaOf(id).diskPath) todo.add(id); // never written
		for (const [id, m] of this.metas) if (m.diskPath !== this.effectivePath(id) || m.open || m.owed) todo.add(id);
		for (const id of todo) await atStart(id);
	}

	/**
	 * Where did a note's file go? A file with exactly the note's agreed text (`hash`), at a path nobody
	 * knows, or at another note's path whose file has changed (this note's file was moved onto it).
	 */
	private async findMoved(hash: string, id: string): Promise<DiskFile | undefined> {
		const note = !this.isAttachment(id), size = this.metaOf(id).size;
		for (const f of await this.disk.list()) {
			if (this.dirty.has(f.path)) continue; // waiting events will say what that file is
			if (isNote(f.path) !== note || (!note && f.size !== size)) continue; // can't be it: no need to read it
			const owner = this.byPath.get(f.path);
			if (owner !== undefined) {
				const om = this.metaOf(owner);
				if (owner === id || this.losing.has(owner) || this.opened.has(owner) || (om.mtime === f.mtime && om.size === f.size)) continue;
			}
			let h = this.unknown.get(f.path);
			if (h === undefined) {
				try {
					this.unknown.set(f.path, (h = note ? await this.opts.hash(await this.disk.read(f.path)) : await this.opts.chunkName(await this.disk.readBinary(f.path))));
				} catch {
					continue; // gone again
				}
			}
			if (h !== hash) continue;
			if (owner !== undefined) await this.lost(owner); // the note that lived there has lost its file to this one
			return f;
		}
		return undefined;
	}

	/**
	 * The note's file is no longer where this device had it. Moved, if its agreed text turns up elsewhere;
	 * otherwise deleted, unless the document has an edit the file never showed: then the file comes back.
	 */
	private async lost(id: string): Promise<void> {
		if (this.losing.has(id)) return;
		this.losing.add(id);
		try {
			const hash = this.metaOf(id).baseHash;
			const moved = hash !== undefined ? await this.findMoved(hash, id) : undefined;
			if (moved) {
				this.movedTo(id, moved.path, moved);
				return;
			}
			const pending = await this.ahead(id);
			this.forget(id);
			if (!pending) await this.tombstone(id);
		} finally {
			this.losing.delete(id);
		}
	}

	/**
	 * The document holds something this device's file never showed, so the file's deletion can't hold against it:
	 * a write still owed, or, for an attachment, a version other than the one the file showed or was made from.
	 * (An attachment's own new version keeps the file as it is, so a version arriving meanwhile is never written.)
	 */
	private async ahead(id: string): Promise<boolean> {
		if ((await this.read(`base:${id}`)) || this.metaOf(id).writing) return true;
		if (!this.isAttachment(id)) return false;
		const up = await this.read<Upload>(`up:${id}`), shown = up ? up.base : this.metaOf(id).baseHash;
		const doc = this.load(await this.state(id)), versions = doc.getArray<Ref>("v").toArray();
		doc.destroy();
		return versions.some((r) => r.h !== shown);
	}

	/**
	 * A file at a path no note of this device lives at. If the vault has a note that belongs exactly there
	 * with exactly this text, it is that note. Otherwise it is a new note. Returns the note's ID, or nothing
	 * for an attachment too large to sync.
	 */
	private async takeUnknown(path: string): Promise<string | undefined> {
		// Stat first: if the file changes while it's being read, the older timestamp makes the next look catch it.
		const file = (await this.disk.stat(path))!;
		if (!isNote(path)) return this.notesOnly ? undefined : this.takeAttachment(file);
		const text = await this.disk.read(path);
		const hash = await this.opts.hash(text);
		const owner = this.ownerOf(path);
		const mine = owner && !this.metaOf(owner).diskPath ? await this.text(owner) : undefined;
		if (owner && mine === text) {
			this.place(owner, path);
			this.agree(owner, file, hash);
			return owner;
		}
		// Exactly where an unplaced note belongs, and mostly its text: the engine wrote this file and stopped
		// before recording it, and the user has edited it since. Not on a device just joining the vault: there
		// a near-match may be a stale copy, and both versions are kept.
		if (owner && mine !== undefined && !this.joining && alike(units(mine), units(text)) >= ALIKE) {
			this.place(owner, path);
			await this.takeFile(owner, path, file, "merge");
			return owner;
		}
		const id = this.opts.newId();
		const doc = this.load(undefined, this.clientId);
		doc.getText("t").insert(0, text);
		const state = Y.encodeStateAsUpdate(doc);
		doc.destroy();
		this.put(`state:${id}`, state);
		this.send(id, state);
		this.notes.set(id, { p: path });
		this.place(id, path);
		this.agree(id, file, hash);
		return id;
	}

	/** The live note the index puts at `path`. */
	private ownerOf(path: string): string | undefined {
		// Nobody claims the path in the index (the usual case for a new note): no need to work out the layout.
		// (A conflict-suffixed name is no index path, so it always takes the full lookup.)
		return this.claimed.get(path) || path.includes(" (conflict ") ? this.places().owners.get(path) : undefined;
	}

	/**
	 * The other notes claiming a path that a note here just joined or left (deleted, renamed, brought back):
	 * one of them may now own it, or lose it. Nobody else claiming it, as for a new note, is the usual case.
	 */
	private regrouped(): string[] {
		const ids: string[] = [];
		for (const [p, changed] of this.shifted) {
			const own = [...changed].filter((id) => { const v = this.notes.get(id); return v?.d === undefined && v?.p === p; }).length;
			if ((this.claimed.get(p) ?? 0) > own) for (const id of this.places().groups.get(p) ?? []) if (!changed.has(id)) ids.push(id);
		}
		this.shifted.clear();
		return ids;
	}

	/** Settle a note and every note claiming the same path (their places depend on each other). */
	private async settleGroup(id: string): Promise<void> {
		const path = this.notes.get(id)?.p;
		for (const other of new Set([id, ...((path !== undefined && this.places().groups.get(path)) || [])])) await this.settle(other);
	}

	/**
	 * Bring one note's file and document into agreement, and put the file where the index says.
	 */
	private async settle(id: string): Promise<void> {
		if (this.settling.has(id) || (this.notesOnly && this.isAttachment(id))) return;
		this.settling.add(id);
		this.deferred.delete(id);
		try {
			let blocked = false;
			for (let attempt = 0; attempt < 3; attempt++) {
				const done = await this.settleOnce(id);
				if (done === true) return;
				blocked = done === "blocked";
			}
			// A file that kept changing announces itself again; a path that stays occupied does not.
			if (blocked) this.opts.onProblem?.(`note ${id}`, new Error(`another file is in the way at ${this.effectivePath(id)}`));
		} catch (err) {
			this.opts.onProblem?.(`note ${id}`, err);
		} finally {
			this.settling.delete(id);
		}
	}

	/** True: settled. False: the file changed meanwhile. "blocked": another file occupies the note's place. */
	private async settleOnce(id: string): Promise<boolean | "blocked"> {
		const m = this.metaOf(id);
		const mode: Mode = m.owed ?? "merge";
		const open = this.opened.get(id);
		if (m.diskPath && this.dirty.has(m.diskPath)) {
			this.deferred.add(id); // wait for the file's events
			return true;
		}
		let seen = m.diskPath ? await this.disk.stat(m.diskPath) : undefined;

		// 1. Take in what the user did to the file.
		if (m.diskPath && !seen && !m.writing) {
			// A file can be seen missing before its rename is announced, so look for it before calling it deleted.
			// (With `writing` set, the engine's own write never landed: step 3 writes it.)
			await this.lost(id);
			seen = m.diskPath ? await this.disk.stat(m.diskPath) : undefined;
		} else if (m.diskPath && seen && (seen.mtime !== m.mtime || seen.size !== m.size)) {
			if (this.tooLarge(seen)) return true;
			await this.takeFile(id, m.diskPath, seen, open ? "doc" : mode);
		}
		await this.resurrect(id);
		if (this.isAttachment(id)) await this.split(id);

		// 2. Put the file where the index says the note lives.
		const want = this.effectivePath(id);
		if (want !== undefined && this.dirty.has(want)) {
			this.deferred.add(id);
			return true;
		}
		if (m.diskPath && m.diskPath !== want) {
			if (want === undefined) {
				// Only a recorded deletion removes the file. A note missing from the index altogether is one whose index
				// entry hasn't arrived yet (it waits inside Yjs for an update this device lacks): leave it be until then.
				if (this.notes.get(id) === undefined) return true;
				await this.disk.remove(m.diskPath);
				this.forget(id);
				if (open) {
					this.opened.delete(id);
					open.destroy();
					this.opts.onClosed?.(id);
				}
				return true;
			}
			if (!(await this.vacate(want, id))) return this.deferred.has(id) || "blocked"; // waiting, or places shifted: look again
			if (!(await this.disk.stat(m.diskPath))) return false; // gone while its place was made: look again
			this.ownRenames.set(want, m.diskPath);
			await this.disk.rename(m.diskPath, want);
			// The agreed timestamp stays as it was: a move doesn't change the text, and an edit that landed
			// just before the move must still show up as a change.
			this.place(id, want);
			seen = await this.disk.stat(want);
		}
		if (want === undefined || open) return true; // an open note's editor shows the document, and saves it
		if (!isNote(want)) return this.settleAttachment(id, want, seen);

		// 3. Make the file's text the document's.
		const text = await this.text(id);
		if (text === undefined) return true; // the note's text hasn't arrived yet
		const fresh = m.diskPath !== want || !seen; // no file of this note's is there yet
		if (!fresh) {
			if (seen!.mtime !== m.mtime || seen!.size !== m.size) return false; // changed since step 1 looked: take that in first
			if (mode === "merge" && !(await this.read(`base:${id}`))) {
				// Nothing pending: file and document agree, unless the file changed again while we looked.
				const now = await this.disk.stat(want);
				return !!now && now.mtime === seen!.mtime && now.size === seen!.size;
			}
			const current = await this.disk.read(want);
			if (current === text) {
				const now = await this.disk.stat(want);
				if (!now || now.mtime !== seen!.mtime || now.size !== seen!.size) return false;
				this.agree(id, now, await this.opts.hash(text));
				return true;
			}
			// After a crash, an editor's save newer than the last agreement might hold typing that was never
			// recorded. And after an editor closed, the file counts as its last save, but one holding text the
			// document never had was edited from outside since. Either is about to be overwritten: keep it as its own note.
			const doc = units(text), outside = mode === "doc" && [...units(current)].some((u) => !doc.has(u));
			if ((mode === "recover" && (await this.opts.hash(current)) !== m.baseHash) || outside) await this.keepCopy(want, id, current);
		} else if (m.diskPath !== want) {
			if (!(await this.vacate(want, id))) return this.deferred.has(id) || "blocked"; // waiting, or places shifted: look again
			if (m.diskPath === want) return true; // the file there turned out to be this note
		}
		return this.writeFile(id, want, seen, fresh, () => this.disk.write(want, text), await this.opts.hash(text));
	}

	/** Step 3's write, for notes and attachments alike. False: the file changed meanwhile. */
	private async writeFile(id: string, want: string, seen: DiskFile | undefined, fresh: boolean, write: () => Promise<DiskFile>, hash: string): Promise<boolean> {
		const m = this.metaOf(id);
		// On record before the file changes: the document, and where its file is about to be. If the engine
		// stops right after the write, the file is then already known to be this note's, wherever it ends up.
		this.place(id, want);
		m.writing = true;
		this.put(`note:${id}`, m);
		await this.flush();
		// Last look before writing: if the file changed since step 1 read it, start over and take that in.
		const now = await this.disk.stat(want);
		if (fresh ? !!now : !now || now.mtime !== seen!.mtime || now.size !== seen!.size) {
			if (fresh) this.forget(id); // something else appeared there: it isn't this note's file
			return false;
		}
		this.agree(id, await write(), hash);
		return true;
	}

	/** Make sure `path` is free for note `id`: move the note that's there, or take in a file nobody knows. */
	private async vacate(path: string, id: string): Promise<boolean> {
		if (!(await this.disk.stat(path))) return true;
		const other = this.byPath.get(path);
		if (other === id) return true;
		if (other && this.settling.has(other)) {
			// Two notes are trading places: park the other one's file; its own settle moves it on from there.
			const parked = `${path}.ownsync-${other.slice(0, 6)}${isNote(path) ? ".md" : ""}`; // still the same kind of file
			this.ownRenames.set(parked, path);
			await this.disk.rename(path, parked);
			this.place(other, parked);
		} else if (other && this.notes.get(other) === undefined) {
			// That note's index entry hasn't arrived yet, so it stays where it is (see settleOnce): wait for it.
			this.deferred.add(id);
			return false;
		} else if (other) {
			await this.settle(other);
			if (this.deferred.has(other)) this.deferred.add(id); // it is waiting for file events, so this note waits too
		} else {
			const taken = await this.takeUnknown(path);
			if (taken === id) return true;
			if (taken) await this.settleGroup(taken);
		}
		return this.byPath.get(path) === id || !(await this.disk.stat(path));
	}

	/** The note's file changed. Agree, note a stale file, or merge the user's edit into the document. */
	private async takeFile(id: string, path: string, file: DiskFile, mode: Mode): Promise<void> {
		if (!isNote(path)) return this.stage(id, file);
		const m = this.metaOf(id);
		const text = await this.disk.read(path);
		const hash = await this.opts.hash(text);
		if ((await this.text(id)) === text) return this.agree(id, file, hash);
		if (hash === m.baseHash || mode !== "merge") {
			// Same text as last agreed, or an editor's older save: the document is ahead and will be written.
			Object.assign(m, { mtime: file.mtime, size: file.size });
			this.put(`note:${id}`, m);
			return;
		}
		// The user edited the file. Their edit was made on top of the agreed version, so apply it there and
		// merge the result: a remote edit made meanwhile survives alongside it.
		let base = await this.read<Uint8Array>(`base:${id}`);
		if (base) {
			// The engine may have crashed after writing the document to the file but before recording that
			// they agree. Then the file already shows the document, and the user's edit sits on top of that,
			// not of the older agreed version. Whichever the file is closer to is what they edited.
			const agreed = this.load(base);
			const far = (from: string) => { const x = units(from), y = units(text); let n = 0; for (const u of x) if (!y.has(u)) n++; for (const u of y) if (!x.has(u)) n++; return n; };
			if (far((await this.text(id)) ?? "") < far(agreed.getText("t").toString())) base = undefined;
			agreed.destroy();
		}
		const fork = this.load(base ?? (await this.state(id)), base ? this.newClientId() : this.clientId);
		const before = Y.encodeStateVector(fork);
		applyText(fork.getText("t"), text);
		const edit = Y.encodeStateAsUpdate(fork, before);
		const forked = Y.encodeStateAsUpdate(fork);
		fork.destroy();
		await this.merge(id, edit, true, true);
		Object.assign(m, { baseHash: hash, mtime: file.mtime, size: file.size });
		this.put(`note:${id}`, m);
		if ((await this.text(id)) === text) this.del(`base:${id}`);
		else this.put(`base:${id}`, forked); // the file now shows the fork; the merged document still has to be written
	}

	/** Save `text` next to the note as its own note, so nothing typed is lost when the two can't be merged. */
	private async keepCopy(path: string, id: string, text: string): Promise<void> {
		const stem = path.replace(/(\.md)?$/i, ` (recovered ${id.slice(0, 6)}`);
		let copy = `${stem}).md`;
		// Free on disk, not a path some note is recorded at or the index puts a note at (an earlier copy whose file
		// was deleted may still be coming back there), and with no file events waiting.
		for (let n = 2; (await this.disk.stat(copy)) || this.byPath.has(copy) || this.ownerOf(copy) !== undefined || this.dirty.has(copy); n++) copy = `${stem} ${n}).md`;
		await this.disk.write(copy, text);
		const kept = (await this.takeUnknown(copy))!; // a note: always taken
		this.metaOf(kept).copyOf = id;
		this.put(`note:${kept}`, this.metaOf(kept));
		await this.settleGroup(kept);
	}

	private async stateVector(id: string): Promise<Uint8Array> {
		const doc = this.load(await this.state(id));
		const sv = Y.encodeStateVector(doc);
		doc.destroy();
		return sv;
	}

	private async tombstone(id: string): Promise<void> {
		const v = this.notes.get(id);
		if (!v || v.d !== undefined) return;
		this.notes.set(id, { p: v.p, d: b64(await this.stateVector(id)) });
	}

	/** A deleted note that this device holds edits for which the deleter never saw is not deleted. */
	private async resurrect(id: string): Promise<void> {
		const v = this.notes.get(id);
		if (!v || v.d === undefined) return;
		if (await this.read(`up:${id}`)) return void this.notes.set(id, { p: v.p }); // a new version, still uploading
		const seen = Y.decodeStateVector(unb64(v.d));
		for (const [client, clock] of Y.decodeStateVector(await this.stateVector(id))) {
			if (clock > (seen.get(client) ?? 0)) return void this.notes.set(id, { p: v.p });
		}
	}

	// --- attachments ---

	private get notesOnly(): boolean {
		return this.opts.attachments === false;
	}

	private isAttachment(id: string): boolean {
		const v = this.notes.get(id);
		return !!v && !isNote(v.p);
	}

	/** Reported, and left alone: neither synced nor overwritten until it shrinks. */
	private tooLarge(file: DiskFile): boolean {
		const max = this.opts.maxFileSize ?? 20 * 2 ** 20;
		if (isNote(file.path) || file.size <= max) return false;
		this.opts.onProblem?.(`attachment ${file.path}`, new Error(`larger than ${Math.round(max / 2 ** 20)} MB, so not synced`));
		return true;
	}

	/** The attachment's content as the vault has it: its first version (there is more than one only until split). */
	private async head(id: string): Promise<Ref | undefined> {
		const doc = this.load(await this.state(id)), ref = doc.getArray<Ref>("v").get(0);
		doc.destroy();
		return ref;
	}

	/** takeUnknown for an attachment: the vault's one that belongs exactly there with exactly this content, or a new one. */
	private async takeAttachment(file: DiskFile): Promise<string | undefined> {
		if (this.tooLarge(file)) return undefined;
		const bytes = await this.disk.readBinary(file.path), hash = await this.opts.chunkName(bytes), owner = this.ownerOf(file.path);
		if (owner && !this.metaOf(owner).diskPath && (await this.head(owner))?.h === hash) {
			this.place(owner, file.path);
			this.agree(owner, file, hash);
			return owner;
		}
		const id = this.opts.newId();
		this.notes.set(id, { p: file.path });
		this.place(id, file.path);
		await this.stage(id, file, bytes);
		return id;
	}

	/**
	 * The attachment's file has content the vault hasn't: it becomes this device's next version, recorded now and
	 * published once the server holds every chunk. Until then the file is ahead of the document: never overwritten.
	 */
	private async stage(id: string, file: DiskFile, bytes?: Uint8Array): Promise<void> {
		bytes ??= await this.disk.readBinary(file.path);
		const m = this.metaOf(id), h = await this.opts.chunkName(bytes);
		if (h === m.baseHash) {
			Object.assign(m, { mtime: file.mtime, size: file.size }); // touched, not changed
			return this.put(`note:${id}`, m);
		}
		if (h === (await this.head(id))?.h) {
			// What the vault has: the engine's own write, unrecorded when it stopped, or the user undid their change.
			this.dropUpload(id);
			return this.agree(id, file, h);
		}
		const size = this.opts.chunkSize ?? 2 ** 20, c: string[] = [];
		for (let at = 0; at < bytes.length; at += size) c.push(await this.opts.chunkName(bytes.subarray(at, at + size)));
		const ref: Ref = { h, n: bytes.length, c, u: this.opts.newId() };
		const up = await this.read<Upload>(`up:${id}`);
		// It replaces what the file showed before; an earlier version still uploading never reached the vault.
		this.put(`up:${id}`, { ref, base: up ? up.base : m.baseHash } satisfies Upload);
		this.ups.add(id);
		const was = this.uploading;
		// Saved again mid-upload: chunks it shares with the version before are stored, or on their way, already.
		if (!was || was.id === id) this.uploading = { id, ref, bytes, asked: new Set(c.filter((n) => was?.asked.has(n))), stored: new Set(c.filter((n) => was?.stored.has(n))) };
		this.agree(id, file, h);
	}

	private dropUpload(id: string): void {
		this.del(`up:${id}`);
		this.ups.delete(id);
		if (this.uploading?.id === id) this.uploading = null;
	}

	/** Every chunk of this device's new version is stored: now the version may be referenced. */
	private async publish(id: string, { ref, base }: Upload): Promise<void> {
		const doc = this.load(await this.state(id), this.clientId), v = doc.getArray<Ref>("v"), before = Y.encodeStateVector(doc);
		// It replaces the version it was made from. One another device made meanwhile stays: a conflict, for split.
		doc.transact(() => {
			for (let i = v.length - 1; i >= 0; i--) if (v.get(i).h === base) v.delete(i);
			v.push([ref]);
		});
		const update = Y.encodeStateAsUpdate(doc, before);
		doc.destroy();
		this.dropUpload(id);
		await this.merge(id, update, true, true);
	}

	/**
	 * Versions made concurrently: the first keeps the attachment, and each other one becomes an attachment of its
	 * own, under the ID it carries. Every device that splits makes the same copies, so two at once do no harm.
	 */
	private async split(id: string): Promise<void> {
		const state = await this.state(id), entry = this.notes.get(id);
		if (!state || !entry || entry.d !== undefined) return;
		const doc = this.load(state, this.clientId), v = doc.getArray<Ref>("v"), [first, ...rest] = v.toArray();
		if (!first || rest.every((r) => r.h === first.h)) {
			doc.destroy();
			// No version left: two devices split it at once, each keeping one the other had replaced or split off.
			// The copies hold every version, so the attachment itself goes, on every device alike.
			if (!first && !(await this.read(`up:${id}`))) await this.tombstone(id);
			return;
		}
		const before = Y.encodeStateVector(doc), done = new Set([first.h]);
		for (const r of rest) {
			if (done.has(r.h)) continue;
			done.add(r.h);
			if (this.notes.has(r.u)) continue; // made already, here or elsewhere
			const copy = this.load(undefined, this.clientId);
			copy.getArray<Ref>("v").push([r]);
			const made = Y.encodeStateAsUpdate(copy);
			copy.destroy();
			this.put(`state:${r.u}`, made);
			this.send(r.u, made);
			this.notes.set(r.u, { p: conflictName(entry.p, r.u) });
			this.deferred.add(r.u);
		}
		doc.transact(() => { for (let i = v.length - 1; i > 0; i--) if (v.get(i).h !== first.h) v.delete(i); });
		const update = Y.encodeStateAsUpdate(doc, before);
		doc.destroy();
		const m = this.metaOf(id);
		if (m.baseHash !== undefined && m.baseHash !== first.h && !(await this.read(`base:${id}`))) this.put(`base:${id}`, state); // the file now owes a write
		await this.merge(id, update, true, true);
	}

	/** Step 3 for an attachment: make the file the vault's version, once all of it is here. */
	private async settleAttachment(id: string, want: string, seen: DiskFile | undefined): Promise<boolean | "blocked"> {
		const m = this.metaOf(id);
		if (await this.read(`up:${id}`)) return true; // the file is ahead of the document until its upload is done
		const ref = await this.head(id);
		if (!ref) return true; // its content hasn't arrived yet
		const fresh = m.diskPath !== want || !seen;
		if (!fresh) {
			if (seen!.mtime !== m.mtime || seen!.size !== m.size) return false; // changed since step 1 looked: take that in first
			if (ref.h === m.baseHash) {
				if (await this.read(`base:${id}`)) this.agree(id, seen!, ref.h);
				return true;
			}
		} else if (m.diskPath !== want) {
			if (!(await this.vacate(want, id))) return this.deferred.has(id) || "blocked";
			if (m.diskPath === want) return true; // the file there turned out to be this attachment
		}
		if (this.tooLarge({ path: want, mtime: 0, size: ref.n })) return true;
		const bytes = await this.fetch(id, ref);
		return !bytes || this.writeFile(id, want, seen, fresh, () => this.disk.writeBinary(want, bytes), ref.h);
	}

	/** The version's content, once every chunk is here and the whole checks out; until then undefined. */
	private async fetch(id: string, ref: Ref): Promise<Uint8Array | undefined> {
		let f = this.fetching;
		if (f && f.id !== id) return void this.toFetch.add(id); // one at a time
		if (!f || f.ref.h !== ref.h) this.fetching = f = { id, ref, asked: new Set(), got: new Map([...(f?.got ?? [])].filter(([name]) => ref.c.includes(name))) };
		if (ref.c.some((name) => !f.got.has(name))) return undefined; // pump asks for them
		this.fetching = null;
		const parts = ref.c.map((name) => f.got.get(name)!);
		if (parts.reduce((n, p) => n + p.length, 0) === ref.n) {
			const bytes = new Uint8Array(ref.n);
			let at = 0;
			for (const p of parts) { bytes.set(p, at); at += p.length; }
			if ((await this.opts.chunkName(bytes)) === ref.h) return bytes;
		}
		throw new Error(`attachment ${id}: its chunks don't add up to its content`);
	}

	/** Downloads waiting for their turn, and an upload to start (its file is read again: only one is in memory). */
	private async nextTransfers(): Promise<void> {
		while (!this.fetching && this.toFetch.size) {
			const id = this.toFetch.values().next().value!;
			this.toFetch.delete(id);
			await this.settle(id);
		}
		if (this.uploading || !this.link || !this.live) return;
		for (const id of [...this.ups]) {
			const up = await this.read<Upload>(`up:${id}`), path = this.metaOf(id).diskPath;
			if (!up) { this.ups.delete(id); continue; }
			if (!path || this.dirty.has(path)) continue; // its file events come first
			const file = await this.disk.stat(path);
			if (!file) { this.deferred.add(id); continue; } // gone: its settle says where
			const bytes = await this.disk.readBinary(path);
			if ((await this.opts.chunkName(bytes)) === up.ref.h) return void (this.uploading = { id, ref: up.ref, bytes, asked: new Set(), stored: new Set() });
			await this.stage(id, file, bytes); // changed unannounced: this is its newest version
			if (this.uploading) return;
		}
	}

	/** Part of pump: a few chunks in flight each way. */
	private sendChunks(): void {
		const up = this.uploading, f = this.fetching, size = this.opts.chunkSize ?? 2 ** 20;
		if (up && !up.stalled) up.ref.c.forEach((name, i) => {
			if (up.asked.size >= WINDOW || up.stored.has(name) || up.asked.has(name)) return;
			up.asked.add(name);
			this.link!.send({ t: "put", name, data: up.bytes.subarray(i * size, (i + 1) * size) });
		});
		if (f) for (const name of f.ref.c) {
			if (f.asked.size >= WINDOW || f.got.has(name) || f.asked.has(name)) continue;
			f.asked.add(name);
			this.link!.send({ t: "get", name });
		}
	}

	private async transferred(msg: Extract<ServerMsg, { name: string }>): Promise<void> {
		const up = this.uploading, f = this.fetching;
		if (msg.t === "stored") {
			if (!up?.asked.delete(msg.name)) return;
			up.stored.add(msg.name);
			if (up.ref.c.some((name) => !up.stored.has(name))) return;
			this.uploading = null;
			const rec = await this.read<Upload>(`up:${up.id}`);
			if (rec?.ref.u === up.ref.u) await this.publish(up.id, rec); // else a newer version replaced it, and goes next
			return this.settle(up.id);
		}
		const wanted = !!f?.asked.delete(msg.name);
		if (msg.t === "chunk") {
			if (!wanted) return;
			// A chunk is checked against its name: neither the server nor a stale reply can slip in other bytes.
			if ((await this.opts.chunkName(msg.data)) === msg.name) {
				f!.got.set(msg.name, msg.data);
				if (f!.ref.c.some((name) => !f!.got.has(name))) return;
				await this.settle(f!.id);
				if (this.fetching === f) this.fetching = null; // complete, but not wanted any more
				return;
			}
		} else if (up?.asked.has(msg.name)) {
			up.stalled = true;
			this.opts.onProblem?.("uploading an attachment", new Error("the server didn't store a chunk (is it full?); trying again after reconnecting"));
		}
		if (!wanted) return;
		// Never written in part: it waits, and is tried again on the next connection.
		this.fetching = null;
		this.retry.add(f!.id);
		this.opts.onProblem?.(`attachment ${f!.id}`, new Error(`a chunk is ${msg.t === "chunk" ? "damaged" : "missing"} on the server; trying again after reconnecting`));
	}
}
