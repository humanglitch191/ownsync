// What the sync engine needs from the outside world. The Obsidian plugin implements these with IndexedDB,
// the vault and the encrypted connection; the tests implement them in memory.

/** "index" (the vault's note map and snapshot ledger) or a note's or attachment's ID. */
export type DocId = string;

/** A deleted markdown note whose text is stored on this device. */
export interface DeletedNote {
	id: string;
	path: string;
	/** Milliseconds since the epoch on the deleting device. Older tombstones have no timestamp. */
	deletedAt?: number;
}

/**
 * What a device tells the Worker about one version-scoped attachment version (DESIGN.md section 10): it is current
 * (in some live attachment), or it stopped being: replaced by a newer version, or its attachment was deleted.
 */
export type MarkState = "current" | "replaced" | "deleted";

/** An encrypted vault snapshot recorded in the synced index. */
export interface SnapshotLedgerEntry {
	/** The Worker's UTC day number (days since the epoch). */
	day: number;
	epoch: number;
	/** SHA-256 hashes of the sealed part envelopes, in order. */
	parts: string[];
	notesOnly: boolean;
	/** Milliseconds since the epoch on the device that took the snapshot. */
	takenAt: number;
}

/** A Yjs update for one document. A snapshot is the whole document; the server may drop what it replaces. */
export interface Entry {
	doc: DocId;
	kind: "update" | "snapshot";
	data: Uint8Array;
}

/**
 * The device's local database. `commit` is atomic: all of it is stored or none of it.
 * Keys: "meta", "index", "note:<id>" (NoteMeta), "state:<id>" and "base:<id>" (Yjs state), "out:<n>" (unsent Entry),
 * "up:<id>" (Upload), "cur:<id>" (an attachment's scoped versions, as last counted) and "mark:<u>" (a MarkState the
 * Worker hasn't confirmed yet).
 */
export interface Store {
	get<T>(key: string): Promise<T | undefined>;
	list<T>(prefix: string): Promise<[key: string, value: T][]>;
	commit(puts: Map<string, unknown>, deletes: Iterable<string>): Promise<void>;
}

export interface DiskFile {
	path: string;
	mtime: number;
	size: number;
}

/** The vault's files: markdown notes (".md") and attachments (every other file). */
export interface Disk {
	list(): Promise<DiskFile[]>;
	stat(path: string): Promise<DiskFile | undefined>;
	read(path: string): Promise<string>;
	readBinary(path: string): Promise<Uint8Array>;
	/** Creates missing folders. Returns the file's stat after the write. */
	write(path: string, content: string): Promise<DiskFile>;
	writeBinary(path: string, content: Uint8Array): Promise<DiskFile>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

export type ClientMsg =
	| { t: "subscribe"; after: number }
	/** Store and relay this entry without replacing older rows. `id` comes back in the ack. */
	| { t: "publish"; id: number; entry: Entry }
	/** `base`: the sender has applied every entry up to this seq, so the snapshot contains them. */
	| { t: "snapshot"; doc: DocId; base: number; data: Uint8Array }
	/** Relay this edit to the other devices now; it is not stored (a publish follows). */
	| { t: "live"; entry: Entry }
	/**
	 * Store one chunk of an attachment under its name. A name is stored once, however often it is put. With `tag`, the
	 * chunk belongs to that version (its scoped name already says so), and the name is recorded under it.
	 */
	| { t: "put"; name: string; data: Uint8Array; tag?: string }
	| { t: "get"; name: string }
	/**
	 * These versions (by tag) are current, or stopped being; `start` begins and `last` ends this device's full list
	 * of current ones. "ask" changes nothing: only the answer is wanted.
	 */
	| { t: "mark"; id: number; state: MarkState | "ask"; start?: boolean; last?: boolean; tags: string[] };

export type ServerMsg =
	| { t: "entry"; seq: number; entry: Entry }
	/** One page of the catch-up, up to `seq`; subscribe again from there. */
	| { t: "more"; seq: number }
	/** Catch-up is complete up to `seq`; what follows is live. */
	| { t: "synced"; seq: number }
	| { t: "ack"; id: number; seq: number }
	| { t: "live"; entry: Entry }
	| { t: "stored"; name: string }
	| { t: "chunk"; name: string; data: Uint8Array }
	/** The server has no such chunk (after a get), or couldn't store it (after a put). */
	| { t: "missing"; name: string }
	/** The answer to a mark: each version it called current, or asked about, that is missing a chunk on the server. */
	| { t: "marked"; id: number; tags: string[] };

/** An open connection to the server. Messages arrive in order or the connection drops. */
export interface Link {
	send(msg: ClientMsg): void;
}

/** One version of an attachment's content. An attachment's document holds these (array "v"), not text. */
export interface Ref {
	/** `chunkName` of the whole content. */
	h: string;
	/** Size in bytes. */
	n: number;
	/** The chunks' names, in order. */
	c: string[];
	/** Unique to this version: the ID it becomes an attachment of its own under, if it loses a conflict. */
	u: string;
	/** 1: its chunks are this version's alone, named with `u` and their place (DESIGN.md section 10). */
	s?: 1;
}

/** An attachment's new version on this device, published once the server has stored all its chunks. */
export interface Upload {
	ref: Ref;
	/** The version it replaces (its `h`), if any. */
	base?: string;
	/** Hidden copies the original save replaced, even if the file was saved again while uploading. */
	seen?: { id: string; u: string[] }[];
}

/** What this device knows about one note's (or attachment's) file. */
export interface NoteMeta {
	/** Where the note is on this device's disk, if it is. */
	diskPath?: string;
	/** Hash of the text (of an attachment: its `h`) that disk and document last agreed on, and the file's stat then. */
	baseHash?: string;
	mtime?: number;
	size?: number;
	/** The note is open in an editor. Still set at startup means the app stopped while it was open. */
	open?: boolean;
	/** This note is a "(recovered …)" copy of that note's unsaved editor text. */
	copyOf?: string;
	/** The engine is about to write, or has just written, this note's file, and hasn't recorded the result. */
	writing?: boolean;
	/** This attachment's identical projected file was verified and is about to be unlinked. */
	removingHidden?: boolean;
	/** The file is an editor's save that the document must overwrite (after a close, or after a crash). */
	owed?: "doc" | "recover";
}

export interface Meta {
	/** Every entry up to this seq has been applied. */
	cursor: number;
	/** False until the first catch-up finishes: until then, local files are not yet compared with the vault. */
	synced: boolean;
	nextOut: number;
	/** When this device last sent the Worker its full list of current versions (its own clock). */
	listedAt?: number;
}
