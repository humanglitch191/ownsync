// What the sync engine needs from the outside world. The Obsidian plugin implements these with IndexedDB,
// the vault and the encrypted connection; the tests implement them in memory.

/** "index" (the vault's note map and snapshot ledger) or a note's or attachment's ID. */
export type DocId = string;

/** A deleted markdown note whose text is stored on this device. */
export interface DeletedNote {
	/** The exact table deletion selected in Recently deleted. */
	deletionSeq?: number;
	id: string;
	path: string;
	/** Milliseconds since the epoch on the deleting device. Older tombstones have no timestamp. */
	deletedAt?: number;
}

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
 * Text states, the snapshot ledger and the unsent Yjs entries share this store with the table planners.
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

export type ClientMsg =
	| { t: "subscribe"; after: number }
	/** Store and relay this entry without replacing older rows. `id` comes back in the ack. */
	| { t: "publish"; id: number; entry: Entry }
	/** `base`: the sender has applied every entry up to this seq, so the snapshot contains them. */
	| { t: "snapshot"; doc: DocId; base: number; data: Uint8Array }
	/** Relay this edit to the other devices now; it is not stored (a publish follows). */
	| { t: "live"; entry: Entry };

export type ServerMsg =
	| { t: "entry"; seq: number; entry: Entry }
	/** One page of the catch-up, up to `seq`; subscribe again from there. */
	| { t: "more"; seq: number }
	/** Catch-up is complete up to `seq`; what follows is live. */
	| { t: "synced"; seq: number }
	| { t: "ack"; id: number; seq: number }
	| { t: "live"; entry: Entry };

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

/** Placement and agreement fields read from a legacy note:<id> during migration. */
export interface NoteMeta {
	/** Where the note is on this device's disk, if it is. */
	diskPath?: string;
	/** Hash of the text (of an attachment: its `h`) that disk and document last agreed on. */
	baseHash?: string;
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
