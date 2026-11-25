import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { applyText } from "../src/core/text";

// Exhaustive check over short base texts B (0..3 words) and all single edits B->X and B->Y
// (insert, delete, replace including mid-word replacements like ab->ax and <d0.1>-><d0.2>, extend),
// using the same Yjs fork/merge pattern as engine.ts takeFile.
//
// Properties checked on every merged (B, X, Y):
// (1) Every run of characters a device inserted appears contiguous and intact in the merged text.
// (2) No base character is missing unless one of the devices deleted it.
// (3) No base character appears twice (and unchanged base words are not deleted and retyped).

const BASE_TOKENS = ["a", "ab", "b", "<d0.1>"] as const;

type EditKind = "insert" | "delete" | "replace" | "extend";

interface InsertedRun {
	startClock: number;
	endClock: number;
	text: string;
}

interface Edit {
	kind: EditKind;
	pos: number;
	text: string;
	update: Uint8Array;
	deleted: Set<number>;
	insertedRuns: InsertedRun[];
}

function makeBase(text: string): Uint8Array {
	const doc = new Y.Doc();
	doc.clientID = 1;
	if (text) doc.getText("t").insert(0, text);
	const state = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return state;
}

function collectClientRuns(ytext: Y.Text, clientID: number): InsertedRun[] {
	const runs: InsertedRun[] = [];
	let cur: InsertedRun | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let item: any = (ytext as any)._start;
	while (item) {
		if (!item.deleted) {
			if (item.id.client === clientID) {
				const str = typeof item.content?.str === "string" ? item.content.str : "";
				if (cur && cur.endClock === item.id.clock) {
					cur.endClock += item.length;
					cur.text += str;
				} else {
					if (cur) runs.push(cur);
					cur = { startClock: item.id.clock, endClock: item.id.clock + item.length, text: str };
				}
			} else if (cur) {
				runs.push(cur);
				cur = null;
			}
		}
		item = item.right;
	}
	if (cur) runs.push(cur);
	return runs;
}

function makeEdit(baseState: Uint8Array, clientID: number, next: string): {
	update: Uint8Array;
	deleted: Set<number>;
	insertedRuns: InsertedRun[];
} {
	const fork = new Y.Doc();
	fork.clientID = clientID;
	Y.applyUpdate(fork, baseState);
	const before = Y.encodeStateVector(fork);
	const ytext = fork.getText("t");
	applyText(ytext, next);
	assert.equal(ytext.toString(), next, `applyText round-trip failed for ${JSON.stringify(next)}`);
	const update = Y.encodeStateAsUpdate(fork, before);
	const insertedRuns = collectClientRuns(ytext, clientID);
	fork.destroy();
	const deleted = new Set<number>();
	for (const d of Y.decodeUpdate(update).ds.clients.get(1) ?? []) {
		for (let c = d.clock; c < d.clock + d.len; c++) deleted.add(c);
	}
	return { update, deleted, insertedRuns };
}

function mergeAndInspect(baseState: Uint8Array, edit1: Uint8Array, edit2: Uint8Array): {
	merged: string;
	baseClocks: number[];
	dev1Runs: InsertedRun[];
	dev2Runs: InsertedRun[];
} {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, baseState);
	Y.applyUpdate(doc, edit1);
	Y.applyUpdate(doc, edit2);
	const ytext = doc.getText("t");
	const merged = ytext.toString();
	const baseClocks: number[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let item: any = (ytext as any)._start;
	while (item) {
		if (!item.deleted && item.id.client === 1) {
			for (let k = 0; k < item.length; k++) baseClocks.push(item.id.clock + k);
		}
		item = item.right;
	}
	const dev1Runs = collectClientRuns(ytext, 2);
	const dev2Runs = collectClientRuns(ytext, 3);
	doc.destroy();
	return { merged, baseClocks, dev1Runs, dev2Runs };
}

function generateBaseTexts(): string[] {
	const out: string[] = [""];
	for (const w1 of BASE_TOKENS) {
		out.push(w1);
		for (const w2 of BASE_TOKENS) {
			out.push(`${w1} ${w2}`);
			for (const w3 of BASE_TOKENS) {
				out.push(`${w1} ${w2} ${w3}`);
			}
		}
	}
	return out;
}

function midWordReplaces(orig: string, freshTag: string): string[] {
	if (orig === "ab") return [`a${freshTag}`, `${freshTag}b`];
	if (orig === "<d0.1>") return ["<d0.2>", "<d1.1>", "<d0.10>", `<d0.${freshTag}>`];
	return [];
}

function generateEdits(base: string, baseState: Uint8Array, clientID: number, freshTag: string): Edit[] {
	const words = base ? base.split(" ") : [];
	const insertPool = [...BASE_TOKENS, freshTag];
	const edits: Edit[] = [];
	const seen = new Set<string>();

	const push = (kind: EditKind, pos: number, nextWords: string[]) => {
		const text = nextWords.join(" ");
		if (text === base) return;
		const key = `${kind}:${pos}:${text}`;
		if (seen.has(key)) return;
		seen.add(key);
		const { update, deleted, insertedRuns } = makeEdit(baseState, clientID, text);
		edits.push({ kind, pos, text, update, deleted, insertedRuns });
	};

	for (let pos = 0; pos <= words.length; pos++) {
		for (const w of insertPool) {
			const next = [...words];
			next.splice(pos, 0, w);
			push("insert", pos, next);
		}
	}

	for (let pos = 0; pos < words.length; pos++) {
		const orig = words[pos]!;
		{
			const next = [...words];
			next.splice(pos, 1);
			push("delete", pos, next);
		}
		for (const w of [...BASE_TOKENS, freshTag, ...midWordReplaces(orig, freshTag)]) {
			if (w === orig) continue;
			const next = [...words];
			next[pos] = w;
			push("replace", pos, next);
		}
		for (const extended of [`${freshTag}${orig}`, `${orig}${freshTag}`]) {
			const next = [...words];
			next[pos] = extended;
			push("extend", pos, next);
		}
	}

	return edits;
}

function hasRun(actual: InsertedRun[], expected: InsertedRun): boolean {
	return actual.some(
		(r) => r.startClock === expected.startClock && r.endClock === expected.endClock && r.text === expected.text,
	);
}

test("exhaustive check: concurrent edits preserve inserted runs intact and keep every undeleted base char exactly once", () => {
	const bases = generateBaseTexts();
	let totalCases = 0;
	let failures = 0;
	let minimal: { B: string; X: string; Y: string; merged: string; reason: string } | null = null;

	const record = (B: string, X: string, Y: string, merged: string, reason: string) => {
		failures++;
		const score = (c: { B: string; X: string; Y: string }) => c.B.length + c.X.length + c.Y.length;
		if (!minimal || score({ B, X, Y }) < score(minimal)) {
			minimal = { B, X, Y, merged, reason };
		}
	};

	for (const base of bases) {
		const baseState = makeBase(base);
		const edits1 = generateEdits(base, baseState, 2, "x");
		const edits2 = generateEdits(base, baseState, 3, "y");

		// Sanity check (3b): insert and extend edits never delete any base character.
		for (const e of [...edits1, ...edits2]) {
			if ((e.kind === "insert" || e.kind === "extend") && e.deleted.size > 0) {
				record(base, e.text, base, e.text, `${e.kind} unexpectedly deleted base chars`);
			}
		}

		for (const e1 of edits1) {
			for (const e2 of edits2) {
				totalCases++;
				const { merged, baseClocks, dev1Runs, dev2Runs } = mergeAndInspect(baseState, e1.update, e2.update);

				// (1) Every run of characters a device inserted appears contiguous and intact in merged.
				for (const r of e1.insertedRuns) {
					if (!hasRun(dev1Runs, r) || !merged.includes(r.text)) {
						record(base, e1.text, e2.text, merged, `dev1 inserted run ${JSON.stringify(r.text)} broken or missing`);
					}
				}
				for (const r of e2.insertedRuns) {
					if (!hasRun(dev2Runs, r) || !merged.includes(r.text)) {
						record(base, e1.text, e2.text, merged, `dev2 inserted run ${JSON.stringify(r.text)} broken or missing`);
					}
				}

				// (2) No base character is missing unless one of the devices deleted it.
				const present = new Set(baseClocks);
				for (let k = 0; k < base.length; k++) {
					if (!e1.deleted.has(k) && !e2.deleted.has(k) && !present.has(k)) {
						record(base, e1.text, e2.text, merged, `base char [${k}]=${JSON.stringify(base[k])} missing`);
					}
				}

				// (3) No base character appears twice (and no deleted base char remains).
				if (present.size !== baseClocks.length) {
					record(base, e1.text, e2.text, merged, "base char appeared twice");
				}
				for (const k of baseClocks) {
					if (e1.deleted.has(k) || e2.deleted.has(k)) {
						record(base, e1.text, e2.text, merged, `deleted base char [${k}] still present`);
					}
				}
			}
		}
	}

	assert.equal(
		failures,
		0,
		`Checked ${totalCases} cases across ${bases.length} base texts; ${failures} failures. Minimal: ${JSON.stringify(minimal)}`,
	);
	console.log(`PASS: checked ${totalCases} cases across ${bases.length} base texts`);
});

test("closed-file edits against an unchanged table base round-trip through the Yjs update", () => {
	for (const base of generateBaseTexts()) {
		const state = makeBase(base);
		for (const {text} of generateEdits(base, state, 2, "x")) {
			const local = new Y.Doc(), receiver = new Y.Doc();
			try {
				Y.applyUpdate(local, state);
				Y.applyUpdate(receiver, state);
				applyText(local.getText("t"), text);
				Y.applyUpdate(receiver, Y.encodeStateAsUpdate(local, Y.encodeStateVector(receiver)));
				assert.equal(receiver.getText("t").toString(), text);
			} finally { local.destroy(); receiver.destroy(); }
		}
	}
});
