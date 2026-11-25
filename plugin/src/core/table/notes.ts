// Rows and Yjs updates have independent cursors. A row identifies a document;
// its path never supplies text, and receiving text never allocates a file.
import type { Store } from "../ports";

export interface NoteRecord {
	kind: "note";
	path: string;
	id: string; // stable Yjs document ID, including across key rotations
	vector?: string; // base64 deletion state vector
}
export interface NoteRow extends NoteRecord {
	file: string;
	seq: number;
	deleted: number | null;
}

export class NoteRows {
	private files = new Map<string, NoteRow>();
	private documents = new Map<string, NoteRow>();
	private paths = new Map<string, NoteRow>();

	constructor(private store: Store) {}

	private loaded?: Promise<void>;
	load() {
		return this.loaded ??= this.store.list<NoteRow>("table/note/").then(rows => {
			for (const [, row] of rows) this.index(row);
		}).catch(error => { this.loaded = undefined; throw error; });
	}

	private index(row: NoteRow) {
		const old = this.files.get(row.file);
		if (old && this.paths.get(old.path) === old) this.paths.delete(old.path);
		this.files.set(row.file, row);
		this.documents.set(row.id, row);
		if (row.deleted === null && (this.paths.get(row.path)?.seq ?? 0) < row.seq) this.paths.set(row.path, row);
	}

	async receive(row: NoteRow) {
		const old = this.files.get(row.file), doc = this.documents.get(row.id);
		if ((old && old.id !== row.id) || (doc && doc.file !== row.file))
			throw new Error("A note's file and document IDs must stay together");
		if (old && old.seq >= row.seq) return;
		// Commit before exposing the path to editors or acknowledging the table cursor.
		await this.store.commit(new Map([["table/note/" + row.file, row]]), []);
		this.index(row);
	}

	at(path: string) { return this.paths.get(path); }
	get(id: string) { return this.documents.get(id); }
	ids() { return this.documents.keys(); }
}
