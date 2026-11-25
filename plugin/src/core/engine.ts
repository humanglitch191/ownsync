// The sync engine. It knows nothing about Obsidian: it sees a local database, a folder of notes and a
// connection (ports.ts), and keeps them in agreement.
//
// Model
//   - The index: one Yjs document with a "notes" map from a permanent note ID to { p: path } or, for a
//     deleted note, { p, d: the state vector the deleting device had seen, t: when it deleted the note
//     (if known) }, and a "snapshots" map that records hashes of encrypted vault snapshots.
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
//   - From 0.2.0 a version's chunks can be its own (Ref.s, DESIGN.md section 10), so the owner can remove old
//     versions on the dashboard (Clean up). Every device reports which versions stop or start being current, and
//     once a day all it holds current; only the Worker's clock and its answers decide anything.
//
// Not done yet
//   - Deleted notes keep their state forever (a device may still need it to bring the note back).
//   - A live edit is relayed before it is stored, and other devices build on it. If the sending device is
//     destroyed in the seconds before it stores that edit, the others keep it, but it reaches the server
//     only with one of their snapshots. Edits built on it wait (inside Yjs) until then.

import * as Y from "yjs";
import { conflictName, places, type IndexValue } from "./places";
import { legacyBases } from "./table/migration";
import { applyText } from "./text";
import type { ClientMsg, DeletedNote, Disk, DiskFile, DocId, Entry, Link, MarkState, Meta, NoteMeta, Ref, ServerMsg, SnapshotLedgerEntry, Store, Upload } from "./ports";

const INDEX: DocId = "index";
const REMOTE = "ownsync-remote"; // transaction origin for changes that didn't start on this device
const SNAPSHOT_ID = /^[0-9a-f]{32}$/;
const PART_HASH = /^[0-9a-f]{64}$/i;
// Recently deleted lists at most this many notes, from at most this many days back (as local history keeps them).
const MAX_DELETED = 200, DELETED_DAYS = 30, DAY_MS = 24 * 60 * 60 * 1000;
/** Chunks in flight each way: enough to keep the line busy, few enough that memory holds one file plus these. */
const WINDOW = 4;
/** Versions in one report to the Worker, and the most chunks the Worker records for one version. */
const MAX_MARK = 1024;

export interface EngineOptions {
	tableHistory?: {
		deleted(): Promise<DeletedNote[]>;
		restore(id: string): Promise<string | undefined>;
	};
	hash(text: string): Promise<string>;
	/**
	 * Names content by a keyed hash (the server can't test guesses): a chunk, and an attachment's version. With
	 * `scope`, chunk `i` of version `u` only: the name of a version-scoped chunk (DESIGN.md section 10).
	 */
	chunkName(data: Uint8Array, scope?: { u: string; i: number }): Promise<string>;
	/** A version's tag, which the Worker files its scoped chunks under. Without it, nothing is scoped or reported. */
	versionTag?(u: string): Promise<string>;
	/** Whether the Worker takes reports about versions (it is 0.2.0 or later); until it does, they wait. */
	reports?(): boolean;
	/** Whether a new version's chunks may be scoped now: every device lately seen can read them (the Worker says). */
	scoped?(): boolean;
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
	/** Clock used for deletion timestamps. Defaults to Date.now. */
	now?(): number;
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
 * Whether `text` is `older` with things typed into it: each word of `older`, in order, is in a word of `text`
 * (letters may have been typed into a word since). Whitespace alone is not compared.
 */
function grewFrom(older: string, text: string): boolean {
	const words = text.split(/\s+/);
	const inWord = (w: string, x: string) => { let i = 0; for (const c of x) if (c === w[i]) i++; return i === w.length; };
	let j = 0;
	for (const w of older.split(/\s+/)) {
		if (!w) continue;
		while (j < words.length && !inWord(w, words[j]!)) j++;
		if (j++ === words.length) return false;
	}
	return true;
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
/** Everything else is an attachment. Exactly Obsidian's rule, so a file is the same kind everywhere. */
const isNote = (path: string) => path.endsWith(".md");

function parseSnapshotLedgerEntry(value: unknown): SnapshotLedgerEntry | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	const { day, epoch, parts, notesOnly, takenAt } = value as Partial<SnapshotLedgerEntry>;
	if (typeof day !== "number" || !Number.isSafeInteger(day) ||
		typeof epoch !== "number" || !Number.isSafeInteger(epoch) ||
		typeof takenAt !== "number" || !Number.isSafeInteger(takenAt) || typeof notesOnly !== "boolean" ||
		!Array.isArray(parts) || parts.length < 1 || parts.length > 512) return;
	const hashes: string[] = [];
	for (const part of parts) {
		if (typeof part !== "string" || !PART_HASH.test(part)) return;
		hashes.push(part);
	}
	return { day, epoch, parts: hashes, notesOnly, takenAt };
}

export class Engine {
	private meta: Meta = { cursor: 0, synced: false, nextOut: 1 };
	private index = new Y.Doc();
	private notes = this.index.getMap<IndexValue>("notes");
	private snapshots = this.index.getMap<unknown>("snapshots");
	private metas = new Map<string, NoteMeta>();
	private byPath = new Map<string, string>(); // disk path → note ID
	private opened = new Map<string, Y.Doc>();
	private outbox: { id: number; entry: Entry }[] = [];
	private liveOut: Entry[] = []; // this input's edits, to relay to other devices right away
	private lastPublish = 0;
	private paceTimer: number | null = null;
	private indexOut: Uint8Array[] = []; // this input's index changes, sent as one entry
	private renameSources = new Map<string, string>(); // pre-rename disk paths for a handoff before the index ack
	private indexDirty = false;
	/** Where every live note's file belongs, worked out from the index alone, so every device agrees. */
	private layout: { paths: Map<string, string>; owners: Map<string, string>; groups: Map<string, string[]> } | null = null;
	private claimed = new Map<string, number>(); // index path → how many live notes claim it
	private shifted = new Map<string, Set<string>>(); // index path → notes this device moved onto or off it, this input
	private link: Link | null = null;
	private live = false; // caught up on this link
	private sent = 0; // highest outbox ID sent on this link
	private committedCursor = 0; // the cursor as last committed
	private replayFrom: number | undefined; // a commit failed: read again from here once one works
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
	private uploading: { id: string; ref: Ref; bytes: Uint8Array; asked: Set<string>; stored: Set<string>; stalled?: boolean; tag?: string } | null = null;
	private fetching: { id: string; ref: Ref; asked: Set<string>; got: Map<string, Uint8Array> } | null = null;
	private toFetch = new Set<string>(); // attachments waiting for their turn to download
	private retry = new Set<string>(); // downloads the server was missing a chunk for: tried again on the next connection
	// Version-scoped chunks (DESIGN.md section 10): each live attachment's scoped versions as last counted ("cur:"),
	// how many attachments hold each version, documents whose versions may have changed since, reports the Worker
	// hasn't answered ("mark:"), what is in flight on this link, and versions the Worker is missing chunks of.
	private cur = new Map<string, string[]>();
	private holders = new Map<string, number>();
	private touched = new Set<string>();
	private marks = new Map<string, MarkState>();
	private marking = new Map<string, MarkState>();
	private markFrames = new Map<number, { u: string; state: MarkState }[]>();
	private nextMark = 1;
	private listing = false; // this input sends the daily full list
	private checks = new Map<number, (missing: string[] | undefined) => void>(); // questions waiting for the Worker's answer
	private repairs = new Set<string>();
	private tags = new Map<string, Promise<string>>();
	// One Yjs client ID per run, so a crash or a copied profile can never reuse an ID with different edits.
	private clientId: number;
	private table = false;
	get tableActive() { return this.table; }

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
				this.touched.add(id);
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
			this.table = !!await this.store.get("table/migrated");
			this.meta = (await this.store.get<Meta>("meta")) ?? this.meta;
			this.committedCursor = this.meta.cursor;
			const index = await this.store.get<Uint8Array>("index");
			if (index) Y.applyUpdate(this.index, index, REMOTE);
			this.indexDirty = false;
			for (const [key, m] of await this.store.list<NoteMeta>("note:")) {
				this.metas.set(key.slice(5), m);
				if (m.diskPath && (!this.table || isNote(m.diskPath))) this.byPath.set(m.diskPath, key.slice(5));
			}
			if (this.notesOnly && !this.table) for (const [id, m] of this.metas) if (m.diskPath && !isNote(m.diskPath)) await this.forget(id);
			this.outbox = (await this.store.list<Entry>("out:")).map(([key, entry]) => ({ id: Number(key.slice(4)), entry })).sort((a, b) => a.id - b.id);
			if (!this.table) {
				for (const [key] of await this.store.list("up:")) this.ups.add(key.slice(3));
				for (const [key, us] of await this.store.list<string[]>("cur:")) {
					this.cur.set(key.slice(4), us);
					for (const u of us) this.holders.set(u, (this.holders.get(u) ?? 0) + 1);
				}
				for (const [key, state] of await this.store.list<MarkState>("mark:")) this.marks.set(key.slice(5), state);
			}
			// Before the first catch-up, local files can't be told apart from the vault's notes yet.
			if (this.meta.synced) await this.scan();
		});
	}

	/** Capture the old agreements while the legacy input queue is stopped at this boundary. */
	useTable(nameKey: Uint8Array): Promise<void> {
		const work = this.queue.then(async () => {
			if (this.table) return;
			await this.flush();
			const bases = await legacyBases(this.store,nameKey);
			const obsolete = this.outbox.filter(o => this.isAttachment(o.entry.doc));
			await this.store.commit(bases,obsolete.map(o => "out:" + o.id));
			this.table = true;
			for (const path of this.byPath.keys()) if (!isNote(path)) this.byPath.delete(path);
			this.uploading = null; this.fetching = null; this.ups.clear(); this.toFetch.clear(); this.retry.clear();
			this.cur.clear(); this.holders.clear(); this.marks.clear();
			this.outbox = this.outbox.filter(o => !this.isAttachment(o.entry.doc));
			this.unmark();
		});
		this.queue = work.catch(err => this.opts.onProblem?.("switching attachments",err));
		return work;
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
			if (this.table && !isNote(path)) return;
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
			if (this.table && !isNote(from) && !isNote(to)) return;
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

	/**
	 * Deleted notes and attachments (unless it syncs notes only) of the last 30 days that this device can preview, less
	 * attachments whose file Clean up removed; most recent first, at most 200. Texts are read one at a
	 * time with `deletedText`, so a phone never decodes them all at once.
	 */
	async deletedNotes(): Promise<DeletedNote[]> {
		const deleted: DeletedNote[] = [], candidates: DeletedNote[] = [];
		await this.run("list deleted notes", async () => {
			const since = (this.opts.now?.() ?? Date.now()) - DELETED_DAYS * DAY_MS;
			for (const [id, v] of this.notes) {
				if (v.d === undefined || (this.notesOnly && !isNote(v.p))) continue;
				const deletedAt = Number.isSafeInteger(v.t) ? v.t : undefined;
				if (deletedAt === undefined || deletedAt >= since) candidates.push({ id, path: v.p, deletedAt });
			}
			candidates.sort((a, b) => (b.deletedAt ?? -Infinity) - (a.deletedAt ?? -Infinity));
		});
		// A page at a time, as many as are still wanted. Whether Clean up removed an attachment's file only the Worker
		// can say; offline, or with no answer, it is listed, and restoring it says so.
		for (let i = 0; i < candidates.length && deleted.length < MAX_DELETED;) {
			const page = candidates.slice(i, (i += MAX_DELETED - deleted.length)), held: DeletedNote[] = [], tags = new Map<string, string[]>();
			const answers: Promise<string[] | undefined>[] = [];
			await this.run("check deleted", async () => {
				for (const note of page) {
					if (!(await this.state(note.id))) continue; // without it, only another device can bring the note back
					held.push(note);
					if (isNote(note.path) || !this.link || !this.live || !this.opts.versionTag || !this.opts.reports?.()) continue;
					const tag = await this.headTag(note.id);
					if (tag) tags.set(note.id, [tag]);
				}
				const all = [...tags.values()].flat();
				for (let j = 0; j < all.length; j += MAX_MARK) answers.push(this.ask("ask", all.slice(j, j + MAX_MARK)));
			});
			const gone = new Set((await Promise.all(answers)).flatMap((missing) => missing ?? []));
			for (const note of held) if (!tags.get(note.id)?.some((tag) => gone.has(tag))) deleted.push(note);
		}
		if (this.table && this.opts.attachments !== false && this.opts.tableHistory) {
			deleted.push(...await this.opts.tableHistory.deleted());
			deleted.sort((a,b) => (b.deletedAt ?? -Infinity) - (a.deletedAt ?? -Infinity));
		}
		return deleted.slice(0,MAX_DELETED);
	}

	/** The text of a deleted note, if this device holds it. */
	deletedText(id: string): Promise<string | undefined> {
		let text: string | undefined;
		return this.run(`read deleted ${id}`, async () => {
			if (this.notes.get(id)?.d !== undefined) text = await this.storedText(id);
		}).then(() => text);
	}

	/**
	 * Bring a deleted markdown note back at its old path or another markdown path. If another note uses the
	 * old path now, it comes back as "<name> (restored).md": the path tie-break would rename the live note.
	 * Resolves to the path it was given.
	 */
	restoreDeleted(id: string, path?: string): Promise<string | undefined> {
		let restored: string | undefined;
		return this.run(`restore ${id}`, async () => {
			const v = this.notes.get(id);
			if (v?.d === undefined || !isNote(v.p) || (path !== undefined && !isNote(path))) return;
			restored = await this.bringBack(id, path);
		}).then(() => restored);
	}

	/**
	 * Bring a deleted attachment back, as restoreDeleted does a note, at its old path or "<name> (restored).<ext>".
	 * Online only: Clean up may have removed its content, and only the Worker can say. So its versions are reported
	 * current first, and it comes back only if the answer says nothing is missing. Resolves to the path it was given,
	 * "gone" (its file is no longer stored: nothing was restored), or "offline".
	 */
	async restoreAttachment(id: string): Promise<string | "gone" | "offline" | undefined> {
		if (this.table) return this.opts.attachments === false ? undefined : this.opts.tableHistory?.restore(id);
		let us: string[] = [], head: string | undefined, answer: Promise<string[] | undefined> | undefined, offline = false, ours = false;
		await this.run(`check ${id}`, async () => {
			const v = this.notes.get(id);
			if (v?.d === undefined || isNote(v.p) || this.notesOnly) return;
			ours = true;
			us = await this.scopedVersions(id);
			if (!us.length) return; // chunks from before 0.2.0: never removed
			if (!this.link || !this.live || !this.opts.versionTag || !this.opts.reports?.()) return void (offline = true);
			head = await this.headTag(id);
			answer = this.ask("current", await Promise.all(us.map((u) => this.tagOf(u))));
		});
		if (!ours) return undefined;
		if (offline) return "offline";
		// Only the head's chunks are downloaded: another version missing some is put back from the file later.
		const answered = answer ? await answer : [], missing = answered && head !== undefined && answered.includes(head); // undefined: no answer
		let restored: string | undefined;
		await this.run(`restore ${id}`, async () => {
			if (missing === false && this.notes.get(id)?.d !== undefined) restored = await this.bringBack(id);
			// Not back: the check made its versions current on the Worker again, so they are retired again.
			if (!restored) for (const u of us) if (!this.holders.has(u)) this.report(u, "deleted");
		});
		return missing === undefined ? "offline" : missing ? "gone" : restored;
	}

	private async bringBack(id: string, path?: string): Promise<string | undefined> {
		const v = this.notes.get(id), state = await this.state(id);
		if (v?.d === undefined || !state) return undefined;
		let to = path ?? v.p;
		for (let n = 1; path === undefined && (this.claimed.get(to) || this.byPath.has(to) || await this.disk.stat(to)); n++) {
			to = v.p.replace(/(\.[^./]*)?$/, ` (restored${n === 1 ? "" : ` ${n}`})$1`);
		}
		// Publish the full state with an ack: live devices may no longer hold it, and an offline
		// restore must keep it in the outbox. Compaction snapshots don't reach live devices.
		this.send(id, state, "snapshot");
		this.notes.set(id, { p: to });
		await this.settle(id);
		return to;
	}

	/** Record the ordered part hashes of an encrypted vault snapshot in the synced index. */
	recordSnapshot(id: string, entry: SnapshotLedgerEntry): Promise<void> {
		return this.run("record snapshot", async () => {
			if (typeof id !== "string" || !SNAPSHOT_ID.test(id)) return;
			const snapshot = parseSnapshotLedgerEntry(entry);
			if (!snapshot) return;
			if (this.snapshots.has(id)) {
				const previous = parseSnapshotLedgerEntry(this.snapshots.get(id));
				if (!previous || previous.parts.length !== snapshot.parts.length ||
					previous.parts.some((part, i) => part !== snapshot.parts[i])) return;
			}
			this.snapshots.set(id, snapshot);
		});
	}

	snapshotLedger(): Promise<Map<string, SnapshotLedgerEntry>> {
		const ledger = new Map<string, SnapshotLedgerEntry>();
		return this.run("read snapshot ledger", async () => {
			for (const [id, value] of this.snapshots) {
				if (!SNAPSHOT_ID.test(id)) continue;
				const snapshot = parseSnapshotLedgerEntry(value);
				if (snapshot) ledger.set(id, snapshot);
			}
		}).then(() => ledger);
	}

	forgetSnapshots(ids?: string[]): Promise<void> {
		return this.run("forget snapshots", async () => {
			this.index.transact(() => {
				for (const id of ids ?? this.snapshots.keys()) this.snapshots.delete(id);
			});
		});
	}

	connected(link: Link): Promise<void> {
		return this.run("connected", async () => {
			this.link = link;
			this.live = false;
			this.sent = 0;
			// Whatever was in flight on the old link is asked again; what the server lacked is tried again.
			if (this.uploading) Object.assign(this.uploading, { asked: new Set(), stalled: false });
			this.unmark();
			this.fetching?.asked.clear();
			for (const id of this.retry) this.toFetch.add(id);
			this.retry.clear();
			link.send({ t: "subscribe", after: this.replayFrom ?? this.meta.cursor });
			this.replayFrom = undefined;
		});
	}

	disconnected(): Promise<void> {
		return this.run("disconnected", async () => {
			this.link = null;
			this.live = false;
			this.unmark();
		});
	}

	/** Stop timers. The engine must not be used afterwards. */
	stop(): void {
		if (this.paceTimer) window.clearTimeout(this.paceTimer);
	}

	receive(msg: ServerMsg): Promise<void> {
		return this.run(`receive ${msg.t}`, async () => {
			if (msg.t === "stored" || msg.t === "chunk" || msg.t === "missing") await this.transferred(msg);
			else if (msg.t === "marked") await this.marked(msg);
			else if (msg.t === "entry" || msg.t === "live") {
				// A live update is the same edit that arrives again shortly as a stored entry; only that one moves the cursor.
				if (msg.t === "entry") {
					if (msg.seq > this.meta.cursor) this.setCursor(msg.seq);
					this.tail.set(msg.entry.doc, msg.entry.kind === "snapshot" ? 0 : (this.tail.get(msg.entry.doc) ?? 0) + 1);
				}
				if (msg.entry.doc === INDEX) await this.applyIndex(msg.entry.data);
				else if (!this.table || !this.isAttachment(msg.entry.doc)) {
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
				if (this.table && this.isAttachment(doc)) continue;
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

	pathOf(id: string): string | undefined {
		return this.effectivePath(id);
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
			await this.listDue();
			await this.flush();
			await this.sendMarks().catch((err) => this.opts.onProblem?.("reporting attachment versions", err));
			// An input cut short by a failed commit may not have finished (an editor not shown an edit, a catch-up
			// page not asked for): read again from what is on record. Merging an entry twice changes nothing.
			if (this.replayFrom !== undefined && this.link) {
				this.link.send({ t: "subscribe", after: this.replayFrom });
				this.replayFrom = undefined;
			}
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
		await this.track(); // reports go in the same commit as the change that causes them
		if (this.indexOut.length) {
			this.send(INDEX, Y.mergeUpdates(this.indexOut));
			this.indexOut = [];
		}
		if (this.indexDirty) {
			this.put("index", Y.encodeStateAsUpdate(this.index));
			this.indexDirty = false;
		}
		if (!this.puts.size && !this.dels.size) return;
		try {
			await this.store.commit(this.puts, this.dels);
		} catch (err) {
			// Kept, to go with the next commit: dropped, the cursor would later be committed past entries never stored.
			this.replayFrom ??= this.committedCursor;
			this.live = false; // nothing sent, and no snapshot offered, until it's read again
			throw err;
		}
		this.puts = new Map();
		this.dels = new Set();
		this.committedCursor = this.meta.cursor;
	}

	private send(doc: DocId, data: Uint8Array, kind: Entry["kind"] = "update"): void {
		const item = { id: this.meta.nextOut++, entry: { doc, kind, data } };
		this.outbox.push(item);
		this.liveOut.push(item.entry);
		this.put("meta", this.meta);
		if (doc === INDEX && this.renameSources.size) {
			this.put(`out:${item.id}`, { ...item.entry, renameSources: [...this.renameSources] });
			this.renameSources.clear();
		} else this.put(`out:${item.id}`, item.entry);
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
		for (const entry of live) if (!this.table || !this.isAttachment(entry.doc)) this.link.send({ t: "live", entry });
		if (!this.table) this.sendChunks();
		const wait = this.lastPublish + (this.opts.pace ?? 0) - Date.now();
		if (wait > 0) {
			this.paceTimer ??= window.setTimeout(() => {
				this.paceTimer = null;
				void this.run("publish", async () => {});
			}, wait);
			return;
		}
		const groups = new Map<DocId, { id: number; kind: Entry["kind"]; data: Uint8Array[] }>();
		for (const o of this.outbox) {
			if (this.table && this.isAttachment(o.entry.doc)) continue;
			if (o.id <= this.sent) continue;
			const g = groups.get(o.entry.doc);
			if (g) {
				g.id = o.id;
				if (o.entry.kind === "snapshot") g.kind = "snapshot";
				g.data.push(o.entry.data);
			} else groups.set(o.entry.doc, { id: o.id, kind: o.entry.kind, data: [o.entry.data] });
			this.sent = o.id;
		}
		for (const [doc, g] of groups) {
			this.link.send({ t: "publish", id: g.id, entry: { doc, kind: g.kind, data: g.data.length === 1 ? g.data[0]! : Y.mergeUpdates(g.data) } });
			this.lastPublish = Date.now();
		}
	}

	private setCursor(seq: number): void {
		this.meta.cursor = seq;
		this.put("meta", this.meta);
	}

	// Once enough small entries have piled up for a document, give the server the whole thing so it can drop them.
	private async offerSnapshot(doc: DocId): Promise<void> {
		if (this.table && this.isAttachment(doc)) return;
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
		return this.storedText(id);
	}

	private async storedText(id: string): Promise<string | undefined> {
		return this.textFrom(await this.state(id));
	}

	private textFrom(state: Uint8Array | undefined): string | undefined {
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
		// A live edit arrives again as a stored entry (and in snapshots): one that adds nothing leaves the document where it was.
		let changed = false;
		doc.on("update", () => (changed = true));
		Y.applyUpdate(doc, update, REMOTE);
		const after = Y.encodeStateAsUpdate(doc); // also drops the content of deleted text
		doc.destroy();
		this.touched.add(id);
		const m = this.metaOf(id);
		// A first write interrupted before agreement can already be on disk. Keep the text it wrote
		// when a remote edit advances the document, just as for an agreed file.
		if (changed && !fromDisk && before && (m.baseHash !== undefined || (m.writing && isNote(m.diskPath ?? ""))) &&
			!(await this.read(`base:${id}`))) this.put(`base:${id}`, before);
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
		return (this.layout = places(this.notes));
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
		const from = this.metaOf(id).diskPath;
		this.metaOf(id).writing = undefined; // a file of this note's was there to move: its write landed
		this.place(id, path, file);
		if (this.effectivePath(id) !== path) {
			if (from && !isNote(path) && !this.renameSources.has(id)) this.renameSources.set(id, from);
			this.notes.set(id, { p: path });
		}
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
	private async forget(id: string): Promise<void> {
		Object.assign(this.metaOf(id), { baseHash: undefined, mtime: undefined, size: undefined, owed: undefined, writing: undefined });
		this.place(id, undefined);
		this.del(`base:${id}`);
		await this.dropUpload(id); // its content went with the file
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
			if (this.table && !isNote(path)) continue;
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
				// A deleted note's file had to go: a different text there is a new note.
				if (m.baseHash !== undefined && this.notes.get(id)?.d === undefined) home.set(id, path);
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
			await this.forget(id);
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
		for (const id of todo) await this.settle(id);
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
			await this.forget(id);
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
		// A note still marked open was in an editor when the app stopped: its file is that editor's last save. Here, not
		// only at startup's scan, which waits for the first catch-up: an editor can open the note before that.
		if (m.open && !this.opened.has(id)) this.owe(id, "recover");
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
				// A file an editor left behind (step 3 below) may hold typing that was never recorded: deleted elsewhere,
				// it would go with the file, so it stays as its own note.
				if (mode !== "merge" && isNote(m.diskPath) && seen) {
					const current = await this.disk.read(m.diskPath);
					if (await this.unrecorded(id, mode, current, (await this.text(id)) ?? "")) await this.keepCopy(m.diskPath, id, current);
				}
				// The deletion on record before the file goes: else, after a crash here, a new file the user puts
				// at this path would be taken for this note, rewritten, and its edit would erase a later restore.
				await this.flush();
				await this.disk.remove(m.diskPath);
				await this.forget(id);
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
			// A save the document has only typed past holds nothing new. (The agreed hash can't say: an editor's save that the
			// document had already moved past when it was taken in never updates it.)
			if (mode !== "merge" && (await this.unrecorded(id, mode, current, text))) await this.keepCopy(want, id, current);
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
			if (fresh) await this.forget(id); // something else appeared there: it isn't this note's file
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
		if (m.writing && m.baseHash === undefined) {
			// A remote edit may have arrived after the first write landed. Its base is the
			// text we meant to write. An unrelated file at the old path belongs to the user.
			if (this.textFrom(await this.read<Uint8Array>(`base:${id}`)) !== text) {
				await this.forget(id);
				if (path !== this.effectivePath(id) && await this.disk.stat(path)) {
					const other = await this.takeUnknown(path);
					if (other) this.deferred.add(other);
				}
				return;
			}
			m.baseHash = hash;
			m.writing = undefined;
		}
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

	/** Whether a file an editor left (`current`) may hold typing the document (`text`) never recorded. */
	private async unrecorded(id: string, mode: "doc" | "recover", current: string, text: string): Promise<boolean> {
		return !grewFrom(current, text) && (mode === "doc" || (await this.opts.hash(current)) !== this.metaOf(id).baseHash);
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
		this.notes.set(id, { p: v.p, d: b64(await this.stateVector(id)), t: this.opts.now?.() ?? Date.now() });
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
		return this.table || this.opts.attachments === false;
	}

	legacyAttachment(id: string) { return this.isAttachment(id); }

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
			await this.dropUpload(id);
			return this.agree(id, file, h);
		}
		// Scoped once every device lately seen can read it: then its chunks are this version's alone. A file of more
		// chunks than the Worker records for one version goes the old way.
		const size = this.opts.chunkSize ?? 2 ** 20, c: string[] = [];
		const scoped = !!this.opts.versionTag && !!this.opts.reports?.() && !!this.opts.scoped?.() && Math.ceil(bytes.length / size) <= MAX_MARK, u = scoped ? this.opts.newId() : "";
		for (let at = 0; at < bytes.length; at += size) c.push(await this.opts.chunkName(bytes.subarray(at, at + size), scoped ? { u, i: c.length } : undefined));
		const ref: Ref = scoped ? { h, n: bytes.length, c, u, s: 1 } : { h, n: bytes.length, c, u: this.opts.newId() };
		const up = await this.read<Upload>(`up:${id}`);
		// An earlier version still uploading never reached the vault: whatever of it the Worker holds is retired.
		if (up?.ref.s === 1 && !this.holders.has(up.ref.u)) this.report(up.ref.u, "replaced");
		// It replaces what the file showed before.
		this.put(`up:${id}`, { ref, base: up ? up.base : m.baseHash } satisfies Upload);
		this.ups.add(id);
		const was = this.uploading, tag = scoped ? await this.tagOf(u) : undefined;
		// Saved again mid-upload: chunks it shares with the version before are stored, or on their way, already.
		if (!was || was.id === id) this.uploading = { id, ref, bytes, asked: new Set(c.filter((n) => was?.asked.has(n))), stored: new Set(c.filter((n) => was?.stored.has(n))), tag };
		this.agree(id, file, h);
	}

	/** `published`: its version is in the document now; otherwise it never will be, and is retired. */
	private async dropUpload(id: string, published = false): Promise<void> {
		const up = published || !this.ups.has(id) ? undefined : await this.read<Upload>(`up:${id}`);
		if (up?.ref.s === 1 && !this.holders.has(up.ref.u)) this.report(up.ref.u, "replaced");
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
		await this.dropUpload(id, true);
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
		// The same content can be another version's chunks (scoped to it): what to ask for is the chunks, not the content.
		if (!f || f.ref.h !== ref.h || f.ref.c.join() !== ref.c.join()) this.fetching = f = { id, ref, asked: new Set(), got: new Map([...(f?.got ?? [])].filter(([name]) => ref.c.includes(name))) };
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
		if (this.table) return;
		await this.nextUpload();
		if (!this.uploading && this.link && this.live) await this.nextRepair();
	}

	private async nextUpload(): Promise<void> {
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
			if ((await this.opts.chunkName(bytes)) === up.ref.h) {
				const tag = up.ref.s === 1 ? await this.tagOf(up.ref.u) : undefined;
				return void (this.uploading = { id, ref: up.ref, bytes, asked: new Set(), stored: new Set(), tag });
			}
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
			const data = up.bytes.subarray(i * size, (i + 1) * size);
			this.link!.send(up.tag ? { t: "put", name, data, tag: up.tag } : { t: "put", name, data });
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
			const ref = f!.ref, scope = ref.s === 1 ? { u: ref.u, i: ref.c.indexOf(msg.name) } : undefined;
			if ((await this.opts.chunkName(msg.data, scope)) === msg.name) {
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

	// --- version-scoped chunks: reports for Clean up (DESIGN.md section 10) ---

	/** The tag of the attachment's head, the version its file is downloaded from, if scoped (old-style chunks are never removed). */
	private async headTag(id: string): Promise<string | undefined> {
		const ref = await this.head(id);
		return ref?.s === 1 && typeof ref.u === "string" ? this.tagOf(ref.u) : undefined;
	}

	/** The attachment's version-scoped versions (their `u`), head first. */
	private async scopedVersions(id: string): Promise<string[]> {
		const doc = this.load(await this.state(id));
		const us = doc.getArray<Ref>("v").toArray().filter((r) => r?.s === 1 && typeof r.u === "string" && r.u.length <= 64).map((r) => r.u);
		doc.destroy();
		return [...new Set(us)];
	}

	/**
	 * Which versions left or joined the live attachments among the documents changed since the last look (`all`: every
	 * one). Every `u` in `v` counts, not only the head: split moves a version to a copy under the same `u`. A version
	 * no attachment holds any more is retired; one that joins any is current again. On record as reports ("mark:").
	 */
	private async track(all = false): Promise<void> {
		if (this.table) return;
		const ids = all ? new Set([...this.notes.keys(), ...this.cur.keys()]) : this.touched;
		this.touched = new Set();
		for (const id of ids) {
			const v = this.notes.get(id), was = this.cur.get(id) ?? [];
			if (!was.length && (!v || isNote(v.p))) continue;
			const now = v && v.d === undefined && !isNote(v.p) ? await this.scopedVersions(id) : [];
			if (now.length === was.length && now.every((u, i) => u === was[i])) continue;
			for (const u of now) if (!was.includes(u)) this.hold(u, 1);
			for (const u of was) if (!now.includes(u)) this.hold(u, -1, v?.d === undefined ? "replaced" : "deleted");
			if (now.length) {
				this.cur.set(id, now);
				this.put(`cur:${id}`, now);
			} else {
				this.cur.delete(id);
				this.del(`cur:${id}`);
			}
		}
	}

	private hold(u: string, by: 1 | -1, gone: MarkState = "replaced"): void {
		const n = (this.holders.get(u) ?? 0) + by;
		if (n > 0) this.holders.set(u, n);
		else this.holders.delete(u);
		if (n === (by > 0 ? 1 : 0)) this.report(u, by > 0 ? "current" : gone);
	}

	/** The latest state per version is what the Worker gets; it is kept until the Worker has answered it. */
	private report(u: string, state: MarkState): void {
		this.marks.set(u, state);
		this.put(`mark:${u}`, state);
	}

	// shortcut: a version's tag stays in memory for the run once computed; drop old ones if vaults with 100,000s of versions turn up.
	private tagOf(u: string): Promise<string> {
		let tag = this.tags.get(u);
		if (!tag) this.tags.set(u, (tag = this.opts.versionTag!(u)));
		return tag;
	}

	/**
	 * Once a day, caught up, every version this device holds current goes to the Worker, the last report flagged: a
	 * report lost or overtaken is put right, and the Worker knows which retirements are confirmed. Counted afresh.
	 */
	private async listDue(): Promise<void> {
		if (this.table) return;
		const now = this.opts.now?.() ?? Date.now();
		if (!this.link || !this.live || !this.opts.versionTag || !this.opts.reports?.() || now - (this.meta.listedAt ?? -Infinity) < DAY_MS) return;
		await this.track(true);
		this.meta.listedAt = now;
		this.put("meta", this.meta);
		this.listing = true;
	}

	/** Reports not answered yet, then the daily list if it's due. Only once caught up. */
	private async sendMarks(): Promise<void> {
		if (this.table) return;
		const listing = this.listing;
		this.listing = false;
		if (!this.link || !this.live || !this.opts.versionTag || !this.opts.reports?.()) return;
		const waiting = new Map<MarkState, string[]>();
		for (const [u, state] of this.marks) {
			if (this.marking.get(u) === state) continue; // on its way
			let us = waiting.get(state);
			if (!us) waiting.set(state, (us = []));
			us.push(u);
		}
		for (const [state, us] of waiting) for (let i = 0; i < us.length; i += MAX_MARK) await this.sendMark(state, us.slice(i, i + MAX_MARK));
		if (!listing) return;
		const current = [...this.holders.keys()]; // an empty list still says nothing is current
		for (let i = 0; i === 0 || i < current.length; i += MAX_MARK) await this.sendMark("current", current.slice(i, i + MAX_MARK), i + MAX_MARK >= current.length, i === 0);
	}

	/** Versions (by tag) that have a chunk missing on the Worker; undefined if the link went first. "current" also says they are. */
	private ask(state: "ask" | "current", tags: string[]): Promise<string[] | undefined> {
		const id = this.nextMark++, answer = new Promise<string[] | undefined>((resolve) => this.checks.set(id, resolve));
		this.link!.send({ t: "mark", id, state, tags });
		return answer;
	}

	private async sendMark(state: MarkState, us: string[], last = false, start = false): Promise<void> {
		const id = this.nextMark++, tags = await Promise.all(us.map((u) => this.tagOf(u)));
		this.markFrames.set(id, us.map((u) => ({ u, state })));
		for (const u of us) this.marking.set(u, state);
		// The list's first frame says so: the Worker dates the list from it, not from an earlier report.
		this.link!.send({ t: "mark", id, state, ...(start && { start }), ...(last && { last }), tags });
	}

	private async marked({ id, tags }: Extract<ServerMsg, { t: "marked" }>): Promise<void> {
		const check = this.checks.get(id);
		if (check) return void (this.checks.delete(id), check(tags));
		const frame = this.markFrames.get(id);
		if (!frame) return;
		this.markFrames.delete(id);
		const missing = new Set(tags);
		for (const { u, state } of frame) {
			if (this.marking.get(u) === state) this.marking.delete(u);
			if (this.marks.get(u) === state) {
				this.marks.delete(u);
				this.del(`mark:${u}`);
			}
			// Current, and missing chunks on the Worker (Clean up removed them): put back from the file, if it's here.
			if (state === "current" && missing.size && missing.has(await this.tagOf(u))) this.repairs.add(u);
		}
	}

	/** A new link, or none: what was in flight goes again, and a restore waiting for an answer gets none. */
	private unmark(): void {
		this.marking.clear();
		this.markFrames.clear();
		for (const done of this.checks.values()) done(undefined);
		this.checks.clear();
	}

	/** A version the Worker is missing chunks of, uploaded again from this device's file if it is exactly that version. */
	private async nextRepair(): Promise<void> {
		for (const u of this.repairs) {
			this.repairs.delete(u);
			const id = [...this.cur].find(([, us]) => us.includes(u))?.[0], m = id === undefined ? undefined : this.metaOf(id);
			if (id === undefined || !m?.diskPath || this.ups.has(id) || this.dirty.has(m.diskPath) || !(await this.disk.stat(m.diskPath))) continue;
			const doc = this.load(await this.state(id)), ref = doc.getArray<Ref>("v").toArray().find((r) => r?.u === u && r.s === 1);
			doc.destroy();
			if (!ref || m.baseHash !== ref.h) continue;
			const bytes = await this.disk.readBinary(m.diskPath);
			if ((await this.opts.chunkName(bytes)) !== ref.h) continue;
			const size = this.opts.chunkSize ?? 2 ** 20, c: string[] = [];
			for (let at = 0; at < bytes.length; at += size) c.push(await this.opts.chunkName(bytes.subarray(at, at + size), { u, i: c.length }));
			// The names it computes must be exactly the ones the version refers to: never another version's chunks.
			if (c.length !== ref.c.length || c.some((name, i) => name !== ref.c[i])) continue;
			return void (this.uploading = { id, ref, bytes, asked: new Set(), stored: new Set(), tag: await this.tagOf(u) });
		}
	}
}
