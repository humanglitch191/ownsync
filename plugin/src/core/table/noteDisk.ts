// A path can identify a placed file, never an unplaced document. The only exception
// is an exact path/text pair captured in the device's first catch-up inventory.
import * as Y from "yjs";
import { applyText, onlyInserts } from "../text";

function load(state: Uint8Array) {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, state);
	return doc;
}

export function completeText(state: Uint8Array | undefined): string | undefined {
	if (!state) return;
	const doc = load(state);
	try {
		if (!doc.store.pendingStructs && !doc.store.pendingDs) return doc.getText("t").toString();
	} finally { doc.destroy(); }
}

type ContentPlan =
	| { kind: "wait" | "agree" | "separate" }
	| { kind: "write"; landed?: Uint8Array }
	| { kind: "merge"; update: Uint8Array; agreement: Uint8Array };

// The caller records 'intended' before changing disk and clears it in the same
// commit as the new agreement. 'agreed' is absent for a first materialization.
export function planNoteContent(disk: string | undefined, latest: string | undefined,
	agreed: Uint8Array | undefined, intended?: Uint8Array): ContentPlan {
	if (latest === undefined) return { kind: "wait" };
	const write = { kind: "write" } as const;
	if (disk === undefined) return write;
	const before = completeText(agreed);
	let base = agreed;
	if (intended) {
		const wanted = completeText(intended);
		if (wanted === undefined || (agreed && before === undefined)) return { kind: "wait" };
		if (disk === wanted) return disk === latest ? { kind: "agree" } : { kind: "write", landed: intended };
		if (disk === before) return disk === latest ? { kind: "agree" } : write;
		if (onlyInserts(wanted, disk)) base = intended;
		else if (before === undefined || !onlyInserts(before, disk)) return { kind: "separate" };
	} else {
		if (disk === latest) return { kind: "agree" };
		if (disk === before) return write;
		if (agreed && before === undefined) return { kind: "wait" };
	}
	if (!base) return { kind: "separate" };

	// A fresh client edits the historical state. Reusing a writer which has advanced
	// in 'current' could give different insertions the same Yjs struct ID.
	const doc = load(base);
	try {
		const from = Y.encodeStateVector(doc);
		applyText(doc.getText("t"), disk);
		return { kind: "merge", update: Y.encodeStateAsUpdate(doc, from), agreement: Y.encodeStateAsUpdate(doc) };
	} finally { doc.destroy(); }
}

export type NoteStructure =
	| { t: "set"; path: string; basePath?: string; legacyRestore?: true }
	| ({ t: "del"; path: string } & ({ snapshot: string; vector?: never } | { vector: string; snapshot?: never }))
	| { t: "restore"; path: string; base: number };

// No cross-path pairing, even when the old and new files have identical bytes.
// Missing owners and unknown files produce independent actions. An explicit live
// rename instead updates the recorded placement before the next scan.
export function noteInventory(files: Iterable<string>, placements: ReadonlyMap<string, string>) {
	const present = new Set(files);
	return {
		missing: [...placements].filter(([path]) => !present.has(path)),
		unknown: [...present].filter(path => !placements.has(path)),
	};
}

// One immutable CAS per document. The desired change may advance while it is in flight.
export interface NoteRequest {
	req: string;
	file: string;
	base: number | null;
	action: NoteStructure["t"];
	path: string;
	change: NoteStructure;
	accepted?: number;
}
