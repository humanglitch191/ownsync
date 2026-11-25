export interface NoteRecord {
	kind: "note";
	path: string;
	id: string; // stable Yjs document ID, including across key rotations
	snapshot?: string; // base64 Yjs snapshot at deletion
	vector?: string; // legacy tombstones only
}

export interface NoteRow extends NoteRecord {
	file: string;
	seq: number;
	deleted: number | null;
}
