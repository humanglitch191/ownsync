// Table note events, live Yjs documents, their durable outbox and the snapshot ledger.
import * as Y from "yjs";
import type { IndexValue } from "./places";
import { yjsTextCrdt, type NoteAction, type NoteInput } from "./table/notePlanner";
import { observeNotes, executeNote } from "./table/noteFiles";
import type { NoteSession } from "./table/noteSession";
import type { DiskPort } from "./table/disk";
import { legacyBases } from "./table/migration";

import type { ClientMsg, DeletedNote, DocId, Entry, Link, Meta, NoteMeta, ServerMsg, SnapshotLedgerEntry, Store } from "./ports";
const completeText = yjsTextCrdt.completeText;
const INDEX: DocId = "index";
const REMOTE = "ownsync-remote"; // transaction origin for changes that didn't start on this device
const SNAPSHOT_ID = /^[0-9a-f]{32}$/;
const PART_HASH = /^[0-9a-f]{64}$/i;
// Recently deleted lists at most this many notes, from at most this many days back (as local history keeps them).
const MAX_DELETED = 200, DELETED_DAYS = 30, DAY_MS = 24 * 60 * 60 * 1000;
export interface EngineOptions {
	tableNotes: NoteSession;
	onBrake?(count: number, decide: (approved: boolean) => void): void;
	noteDisk: DiskPort;
	onNoteReady?(): void;
	onNoteWork?(): void;
	onLegacyNotePlacements?(placed: ReadonlyMap<string, string>): Promise<void>;
	tableHistory?: {
		deleted(): Promise<DeletedNote[]>;
		restore(id: string): Promise<string | undefined>;
	};
	newId(): string;
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

	private snapshots = this.index.getMap<unknown>("snapshots");

	private opened = new Map<string, Y.Doc>();
	private scanned = false;
	private finishStartup!: (ready: boolean) => void;
	readonly startupScan = new Promise<boolean>(resolve => { this.finishStartup = resolve; });
	private waitingOpens = new Map<string, Promise<Y.Doc | undefined>>();
	get readyForEditors() { return this.scanned; }
	private outbox: { id: number; entry: Entry }[] = [];
	private liveOut: Entry[] = []; // this input's edits, to relay to other devices right away
	private lastPublish = 0;
	private paceTimer: number | null = null;
	private indexOut: Uint8Array[] = []; // this input's index changes, sent as one entry
	private indexDirty = false;
	private link: Link | null = null;
	private live = false; // caught up on this link
	private sent = 0; // highest outbox ID sent on this link
	private committedCursor = 0; // the cursor as last committed
	private replayFrom: number | undefined; // a commit failed: read again from here once one works
	private tail = new Map<DocId, number>();
	private puts = new Map<string, unknown>();
	private dels = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private dirty = new Map<string, number>(); // paths with file events announced but not handled yet

	// One Yjs client ID per run, so a crash or a copied profile can never reuse an ID with different edits.
	private clientId: number;
	private table = false;
	private oldAttachments = new Set<string>();
	private noteAuthority = false;
	get tableNotesReady() { return this.noteAuthority && this.scanned; }
	get tableActive() { return this.table; }

	constructor(private readonly store: Store, private readonly opts: EngineOptions) {
		this.clientId = this.newClientId();
		this.index.clientID = this.clientId;
		this.index.on("update", (update: Uint8Array, origin: unknown) => {
			this.indexDirty = true;
			if (origin !== REMOTE) this.indexOut.push(update);
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
			if (this.table) {
				await this.opts.tableNotes.load();
				this.attachNoteSession();
				this.noteAuthority = !!this.opts.tableNotes.state?.noteAuthority;
				await this.opts.noteDisk.discardTemp();
			}
			this.meta = (await this.store.get<Meta>("meta")) ?? this.meta;
			this.committedCursor = this.meta.cursor;
			const index = await this.store.get<Uint8Array>("index");
			if (index) Y.applyUpdate(this.index, index, REMOTE);
			this.indexDirty = false;
			this.readLegacyAttachmentIds();
			this.outbox = (await this.store.list<Entry>("out:")).map(([key, entry]) => ({ id: Number(key.slice(4)), entry })).sort((a, b) => a.id - b.id);
			if (this.table) await this.noteStep({ t: "crashRestart" });
			// Before the first catch-up, local files can't be told apart from the vault's notes yet.
			if (this.table && this.noteAuthority && !this.opts.tableNotes.state?.firstSync) await this.inventoryNotes(false);
		}, true);
	}

	private readLegacyAttachmentIds() {
		for (const [id, v] of this.index.getMap<IndexValue>("notes")) if (!isNote(v.p)) this.oldAttachments.add(id);
	}

	/** Capture the old agreements before the table planners take ownership of disk. */
	useTable(nameKey: Uint8Array): Promise<void> {
		const work = this.queue.then(async () => {
			if (this.table) return;
			const bases = await legacyBases(this.store,nameKey);
			if (this.opts.onLegacyNotePlacements) {
				const placements = new Map<string, string>();
				for (const [key, meta] of await this.store.list<NoteMeta>("note:"))
					if (meta.diskPath && isNote(meta.diskPath)) placements.set(meta.diskPath, key.slice(5));
				await this.opts.onLegacyNotePlacements(placements);
			}
			bases.set("table/first-sync", !this.meta.synced);
			const obsolete = this.outbox.filter(o => this.oldAttachments.has(o.entry.doc));
			await this.store.commit(bases,obsolete.map(o => "out:" + o.id));
			this.table = true;
			await this.opts.tableNotes.load();
			this.attachNoteSession();
			this.outbox = this.outbox.filter(o => !this.oldAttachments.has(o.entry.doc));
		});
		this.queue = work.catch(err => this.opts.onProblem?.("adopting the table",err));
		return work;
	}

	/**
	 * A file was created, changed or deleted. File events tell the engine to look at a path, and by the time
	 * it looks, later events may already have changed what is there. So a path with events still waiting is
	 * not trusted (`dirty`), and anything that needs it waits for those events.
	 */
	diskChanged(path: string, mayDelete = true): void {
		if (!this.table || !isNote(path)) return;
		this.mark(path, 1);
		this.later(() => void this.run(`disk ${path}`, async () => {
			this.mark(path, -1);
			if (this.noteAuthority && !this.dirty.has(path)) {
				const input = await observeNotes(this.opts.noteDisk, mayDelete ? "deleted" : "changed", path);
				if (input.files.has(path)) input.event = "changed";
				await this.noteStep(input);
			}
		}));
	}

	/** The file at `from` is now at `to`. Whatever was at `to` before is no longer there. */
	diskRenamed(from: string, to: string): void {
		if (!this.table || (!isNote(from) && !isNote(to))) return;
		// A note renamed to an attachment, or back: one file gone, an unrelated one new.
		if (isNote(from) !== isNote(to)) return void (this.diskChanged(from), this.diskChanged(to));
		this.mark(from, 1);
		this.mark(to, 1);
		this.later(() => void this.run(`rename ${from}`, async () => {
			this.mark(from, -1);
			this.mark(to, -1);
			if (this.noteAuthority) await this.noteStep(await observeNotes(this.opts.noteDisk, "renamed", from, to));
		}));
	}

	/** Folder events carry the same identity evidence as observed file renames. */
	tableFolderRenamed(from: string, to: string) {
		if (!this.noteAuthority) return;
		for (const path of this.opts.tableNotes.state?.byPath.keys() ?? []) if (path.startsWith(from + "/"))
			this.diskRenamed(path, to + path.slice(from.length));
	}

	/** Load a note for an editor. Edits to the returned document are synced; remote edits appear in it. */
	open(id: string): Promise<Y.Doc | undefined> {
		if (this.scanned) return this.openAfterScan(id);
		const waiting = this.waitingOpens.get(id);
		if (waiting) return waiting;
		const path = this.opts.tableNotes.state?.notes.get(id)?.diskPath;
		// Wait outside the input queue so catch-up can run the scan that resolves this open.
		const pending = this.startupScan.then(ready => {
			if (this.waitingOpens.get(id) !== pending) return undefined;
			this.waitingOpens.delete(id);
			return ready ? this.openAfterScan(id, path) : undefined;
		});
		this.waitingOpens.set(id, pending);
		return pending;
	}

	private openAfterScan(id: string, requestedPath?: string): Promise<Y.Doc | undefined> {
		let doc: Y.Doc | undefined;
		return this.run(`open ${id}`, async () => {
			if (requestedPath !== undefined && this.noteAt(requestedPath) !== id) return;
			if (!this.noteAuthority) return;
			if (this.opened.has(id)) { doc = this.opened.get(id); return; }
			const result = await this.noteStep({t: "editorOpen", id});
			if (result.some(a => a.t === "openResult" && a.allowed)) doc = await this.bindDocument(id);
		}).then(() => doc);
	}
	private async bindDocument(id: string) {
		const existing = this.opened.get(id);
		if (existing) return existing;
		const state = await this.state(id);
		if (!state) return;
		const doc = this.load(state, this.clientId);
		if (doc.store.pendingStructs || doc.store.pendingDs) {
			doc.destroy();
			return;
		}
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE && this.opened.get(id) === doc) void this.run(`edit ${id}`, async () => {
				await this.merge(id, update, true);
			});
		});
		this.opened.set(id, doc);
		return doc;
	}

	private releaseDocument(id: string) {
		const doc = this.opened.get(id);
		if (!doc) return false;
		this.opened.delete(id);
		doc.destroy();
		return true;
	}

	close(id: string): Promise<void> {
		this.waitingOpens.delete(id);
		return this.run(`close ${id}`, async () => {
			if (!this.releaseDocument(id)) return;
			await this.noteStep({ t: "editorClose", id });
		});
	}

	async deletedNotes(): Promise<DeletedNote[]> {
		const deleted: DeletedNote[] = [];
		await this.run("list deleted notes", async () => {
			const since = (this.opts.now?.() ?? Date.now()) - DELETED_DAYS * DAY_MS;
			for (const id of this.opts.tableNotes.ids()) {
				const row = this.opts.tableNotes.get(id)!;
				if (row.deleted !== null && row.deleted >= since)
					deleted.push({ id, path: row.path, deletedAt: row.deleted, deletionSeq: row.seq });
			}
		});
		if (this.table) {
			if (this.opts.attachments !== false && this.opts.tableHistory) deleted.push(...await this.opts.tableHistory.deleted());
			deleted.sort((a,b) => (b.deletedAt ?? -Infinity) - (a.deletedAt ?? -Infinity));
		}
		return deleted.slice(0,MAX_DELETED);
	}

	/** The text of a deleted note, if this device holds it. */
	deletedText(id: string): Promise<string | undefined> {
		let text: string | undefined;
		return this.run(`read deleted ${id}`, async () => {
			if (this.opts.tableNotes.get(id)?.deleted != null) text = completeText(await this.state(id));
		}).then(() => text);
	}

	restoreDeleted(id: string, path?: string, deletionSeq?: number): Promise<string | undefined> {
		let restored: string | undefined;
		return this.run(`restore ${id}`, async () => {
			const row = this.opts.tableNotes.get(id), state = await this.state(id);
			if (!this.noteAuthority || !row || row.deleted === null || (deletionSeq !== undefined && row.seq !== deletionSeq)
				|| !state || completeText(state) === undefined || (path !== undefined && !isNote(path))) return;
			await this.noteStep({t: "userRestore", id, path, deletionSeq});
			const change = this.opts.tableNotes.state?.notes.get(id)?.change;
			if (change?.t === "restore") restored = change.path;
		}).then(() => restored);
	}

	async restoreAttachment(id: string) {
		if (this.table && this.opts.attachments !== false) return this.opts.tableHistory?.restore(id);
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
			link.send({ t: "subscribe", after: this.replayFrom ?? this.meta.cursor });
			this.replayFrom = undefined;
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
		this.waitingOpens.clear();
		this.finishStartup(false);
		if (this.paceTimer) window.clearTimeout(this.paceTimer);
	}

	receive(msg: ServerMsg): Promise<void> {
		return this.run(`receive ${msg.t}`, async () => {
			if (msg.t === "entry" || msg.t === "live") {
				// A live update is the same edit that arrives again shortly as a stored entry; only that one moves the cursor.
				if (msg.t === "entry") {
					if (msg.seq > this.meta.cursor) this.setCursor(msg.seq);
					this.tail.set(msg.entry.doc, msg.entry.kind === "snapshot" ? 0 : (this.tail.get(msg.entry.doc) ?? 0) + 1);
				}
				if (msg.entry.doc === INDEX) {
					Y.applyUpdate(this.index, msg.entry.data, REMOTE);
					this.indexDirty = true; // includes updates waiting for Yjs dependencies
				} else if (!this.oldAttachments.has(msg.entry.doc)) {
					await this.merge(msg.entry.doc, msg.entry.data, false);
					if (this.isTableNote(msg.entry.doc) && !this.opened.has(msg.entry.doc)) this.opts.onNoteReady?.();
				}
			} else if (msg.t === "more") {
				// One page of the catch-up is in; everything up to `seq` has been sent. Ask for the next.
				if (msg.seq > this.meta.cursor) this.setCursor(msg.seq);
				await this.flush();
				this.link?.send({ t: "subscribe", after: this.meta.cursor });
			} else if (msg.t === "synced") {
				if (msg.seq > this.meta.cursor) this.setCursor(msg.seq);
				this.live = true;
			} else {
				// One publish carries every edit to its document that was waiting, up to `id`.
				const doc = this.outbox.find((o) => o.id === msg.id)?.entry.doc;
				if (doc === undefined) return;
				if (this.opts.tableNotes.state?.notes.get(doc)?.firstTextPending
					&& !this.outbox.some(o => o.entry.doc === doc && o.id > msg.id)) {
					const state = await this.state(doc);
					if (state) await this.noteStep({t: "yjsUpdate", id: doc, docState: state, isFirstTextAck: true});
				}
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
			if (!this.tableNotesReady) return;
			const ids = this.opts.tableNotes.state!.notes.keys();
			for (const doc of [INDEX, ...ids]) {
				const data = doc === INDEX ? Y.encodeStateAsUpdate(this.index) : await this.state(doc);
				if (!data) continue;
				this.tail.set(doc, 0);
				this.link.send({ t: "snapshot", doc, base: this.meta.cursor, data });
			}
			sent = true;
		}).then(() => sent);
	}

	/** Snapshot confirmed row identities and their Yjs text, including live typing
	 * which an editor has not saved to disk. Never silently skip a missing stream. */
	async *tableSnapshotNotes() {
		await this.idle();
		if (!this.tableNotesReady) throw new Error("Waiting for the note table");
		const rows = Array.from(this.opts.tableNotes.ids(), id => this.opts.tableNotes.get(id)!);
		for (const row of rows) if (row.deleted === null) {
			const text = completeText(await this.store.get<Uint8Array>("state:" + row.id));
			if (text === undefined) throw new Error("Waiting for the text of " + row.path);
			yield { id: row.id, path: row.path, text };
		}
	}

	/** Resolves when every input so far has been handled. */
	idle(): Promise<void> {
		return this.queue;
	}

	noteAt(path: string): string | undefined {
		if (!this.table) return;
		const state = this.opts.tableNotes.state;
		const id = state?.byPath.get(path), n = id && state?.notes.get(id);
		return n && (n.row?.deleted == null && (!n.row || n.row.path === path || n.change?.t === "set")) ? id : undefined;
	}
	pathOf(id: string) {
		if (!this.table) return;
		const n = this.opts.tableNotes.state?.notes.get(id);
		return n?.row?.deleted != null ? undefined : n?.change?.t === "set" ? n.diskPath : n?.row?.path ?? n?.diskPath;
	}
	private isTableNote(id: string) { return !!this.opts.tableNotes.state?.notes.has(id); }

	isOpen(id: string): boolean {
		return this.opened.has(id);
	}

	// --- one input at a time, committed, then sent ---

	private run(what: string, fn: () => Promise<void>, readLegacyAtStart = false): Promise<void> {
		const next = this.queue.then(async () => {
			if (!this.table && !readLegacyAtStart) return;
			try {
				await fn();
			} catch (err) {
				this.opts.onProblem?.(what, err);
			}
			if (!this.table) return;

			await this.flush();
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

	private send(doc: DocId, data: Uint8Array): void {
		const entry: Entry = { doc, kind: "update", data };
		const item = { id: this.meta.nextOut++, entry };
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
			if (this.oldAttachments.has(o.entry.doc)) continue;
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
		if (doc !== INDEX && !this.isTableNote(doc)) return;
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

	private async merge(id: string, update: Uint8Array, local: boolean): Promise<void> {
		const before = await this.state(id);
		// Built from the stored state, never from the live editor document: that one may already hold
		// keystrokes whose turn to be recorded and sent hasn't come yet.
		const doc = this.load(before);
		// A live edit arrives again as a stored entry (and in snapshots): one that adds nothing leaves the document where it was.
		Y.applyUpdate(doc, update, REMOTE);
		const after = Y.encodeStateAsUpdate(doc); // also drops the content of deleted text
		doc.destroy();
		this.put("state:" + id, after);
		if (local) this.send(id, update);
		await this.flush();
		const open = this.opened.get(id);
		if (open && !local) Y.applyUpdate(open, update, REMOTE);
		await this.noteStep({t: "yjsUpdate", id, docState: after});
	}

	private attachNoteSession() {
		const session = this.opts.tableNotes;
		session.env.clientId = this.clientId;
		session.env.newId = () => this.opts.newId() + this.opts.newId();
		session.env.announcedPaths = this.dirty;
		session.deliver = input => {
			const work = this.queue.then(async () => { await this.noteStep(input); this.pump(); });
			this.queue = work.catch(err => this.opts.onProblem?.("note sync", err));
			return work;
		};
	}

	private async noteStep(input: NoteInput): Promise<NoteAction[]> {
		const session = this.opts.tableNotes, device = session.device;
		if (!device) return [];
		if (input.t === "row" && !session.state?.docs.has(input.row.id)) {
			const state = await this.state(input.row.id);
			if (state) await this.noteStep({t: "yjsUpdate", id: input.row.id, docState: state});
		}
		const published: typeof this.outbox = [];
		await this.flush();
		const result = await device.dispatch(input, session.env, (puts, doc, data, snapshot) => {
			const id = this.meta.nextOut + published.length;
			const entry: Entry = { doc, data, kind: snapshot ? "snapshot" : "update" };
			puts.set("out:" + id, entry);
			puts.set("meta", { ...this.meta, nextOut: id + 1 });
			published.push({id, entry});
		});
		this.meta.nextOut += published.length;
		this.outbox.push(...published);
		for (const p of published) this.liveOut.push(p.entry);
		for (const a of result.actions) {
			if (a.t === "diskIntent" && this.noteAuthority) {
				const busy = this.dirty.has(a.intent.path) || (a.intent.kind === "move" && this.dirty.has(a.intent.from));
				await this.noteStep(busy ? { t: "intentDeferred" } : await executeNote(this.opts.noteDisk, a.intent));
			} else if (a.t === "closeEditor") {
				this.releaseDocument(a.id);
				this.opts.onClosed?.(a.id);
				await this.noteStep({t: "editorClose", id: a.id});
			} else if (a.t === "massChangeBrake") {
				this.reviewDeletions(result.state.brakePaused?.reviewIds ?? []);
			} else if (a.t === "problem") this.opts.onProblem?.(a.path, new Error(a.message));
		}
		if (result.actions.some(a => a.t === "workerReq" || a.t === "forget")) this.opts.onNoteWork?.();
		return result.actions;
	}

	private reviewDeletions(ids: string[]) {
		if (!ids.length) return;
		this.opts.onBrake?.(ids.length, approve => {
			void this.opts.tableNotes.input({ t: approve ? "brakeApproved" : "brakeDeclined", ids })
				.then(() => this.opts.onNoteWork?.()).catch(err => this.opts.onProblem?.("reviewing deletions", err));
		});
	}
	reviewHeldDeletions(checking: boolean) {
		const ids = this.opts.tableNotes.state?.brakePaused?.declinedIds;
		if (!ids?.length) return false;
		if (!checking) this.reviewDeletions(ids);
		return true;
	}

	initializeNoteFiles(firstSync?: boolean) {
		return this.run("starting note planner", async () => {
			if (this.tableNotesReady) return;
			await this.inventoryNotes(firstSync ?? !!await this.store.get("table/first-sync"));
		});
	}
	private async inventoryNotes(first: boolean) {
		const session = this.opts.tableNotes;
		await session.beforeInventory?.();
		for (const id of session.state?.notes.keys() ?? []) {
			if (!session.state!.docs.has(id)) {
				const state = await this.state(id);
				if (state) await this.noteStep({t:"yjsUpdate", id, docState: state});
			}
		}
		this.noteAuthority = true;
		await this.noteStep({t: "setFirstSync", firstSync: first, noteAuthority: true});
		const scan = await observeNotes(this.opts.noteDisk, "startup", undefined, undefined, stat => {
			const id = session.state?.byPath.get(stat.path);
			const n = id && session.state?.notes.get(id);
			if (!n || !n.baseStat || n.baseStat.mtime !== stat.mtime || n.baseStat.size !== stat.size ||
				n.intended || n.editor !== "closed") return;
			const text = session.env.crdt.completeText(n.baseState);
			if (text !== undefined && session.env.hash(text) === n.baseStat.hash) return { stat, text, hash: n.baseStat.hash };
		});
		await this.noteStep(scan);
		if (!scan.listingComplete) throw new Error("Could not list notes. Waiting for a complete vault listing.");
		if (first) await this.noteStep({t: "finishFirstSync"});
		this.scanned = true; this.finishStartup(true); this.opts.onNoteReady?.();
	}
}
