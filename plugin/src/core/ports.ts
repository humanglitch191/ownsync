// What the sync engine needs from the outside world. The Obsidian plugin implements these with IndexedDB,
// the vault and the encrypted connection; the tests implement them in memory.

/** "index" (the map from note ID to path) or a note's or attachment's ID. */
export type DocId = string;

/** A deleted markdown note whose text is stored on this device. */
export interface DeletedNote {
	id: string;
	path: string;
	/** Milliseconds since the epoch on the deleting device. Older tombstones have no timestamp. */
	deletedAt?: number;
	text: string;
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
 * "up:<id>" (Upload).
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
	/** Store one chunk of an attachment under its name. A name is stored once, however often it is put. */
	| { t: "put"; name: string; data: Uint8Array }
	| { t: "get"; name: string };

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
	| { t: "missing"; name: string };

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
}

/** An attachment's new version on this device, published once the server has stored all its chunks. */
export interface Upload {
	ref: Ref;
	/** The version it replaces (its `h`), if any. */
	base?: string;
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
	/** The file is an editor's save that the document must overwrite (after a close, or after a crash). */
	owed?: "doc" | "recover";
}

export interface Meta {
	/** Every entry up to this seq has been applied. */
	cursor: number;
	/** False until the first catch-up finishes: until then, local files are not yet compared with the vault. */
	synced: boolean;
	nextOut: number;
}
