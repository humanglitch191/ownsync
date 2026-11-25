import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	checkNoteInvariants,
	emptyVaultNoteState,
	hasUnresolvedConflict,
	step,
	type DiskObsFile,
	type NoteAction,
	type NoteEntry,
	type NoteInput,
	type NoteIntent,
	type NoteRequest,
	type StepEnv,
	type TextCrdt,
	type VaultNoteState,
} from "../src/core/table/notePlanner";
import type { NoteRow } from "../src/core/table/notes";
import { conflictName } from "../src/core/places";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const te = new TextEncoder();
const td = new TextDecoder();

// --- Compact Item-ID / Delete-Set Stand-in CRDT (RGA + causal deps + snapshot) ---

type ItemId = [number, number]; // [clientId, seq]
interface RgaItem {
	id: ItemId;
	origin: ItemId | null;
	ch: string;
}
interface StandInDoc {
	items: RgaItem[];
	deleted: string[]; // "client:seq"
	sv: Record<string, number>; // clientId -> nextSeq
	pending: { ops: RgaItem[]; dels: string[]; reqSv: Record<string, number>; adds: [number, number][] }[];
}

const idKey = ([c, s]: ItemId) => `${c}:${s}`;
const cmpId = ([c1, s1]: ItemId, [c2, s2]: ItemId) => (c1 !== c2 ? c1 - c2 : s1 - s2);
const encDoc = (d: StandInDoc) => te.encode(JSON.stringify(d));
const decDoc = (b: Uint8Array): StandInDoc => JSON.parse(td.decode(b));

function emptyStandIn(): StandInDoc {
	return { items: [], deleted: [], sv: {}, pending: [] };
}

function applyRgaItems(doc: StandInDoc, ops: RgaItem[], dels: string[]): void {
	const existing = new Set(doc.items.map(x => idKey(x.id)));
	const delSet = new Set(doc.deleted);
	for (const item of ops) {
		const k = idKey(item.id);
		if (!existing.has(k)) {
			const originIdx = item.origin ? doc.items.findIndex(x => idKey(x.id) === idKey(item.origin!)) : -1;
			let pos = originIdx + 1;
			while (pos < doc.items.length) {
				const cur = doc.items[pos]!;
				const curOriginIdx = cur.origin ? doc.items.findIndex(x => idKey(x.id) === idKey(cur.origin!)) : -1;
				if (curOriginIdx < originIdx) break;
				if (curOriginIdx === originIdx && cmpId(cur.id, item.id) < 0) break;
				pos++;
			}
			doc.items.splice(pos, 0, item);
			existing.add(k);
		}
		const prev = doc.sv[String(item.id[0])] ?? 0;
		if (item.id[1] + 1 > prev) doc.sv[String(item.id[0])] = item.id[1] + 1;
	}
	for (const d of dels) delSet.add(d);
	doc.deleted = [...delSet].sort();
}

function hasDeps(doc: StandInDoc, reqSv: Record<string, number>): boolean {
	for (const [c, need] of Object.entries(reqSv)) {
		if ((doc.sv[c] ?? 0) < need) return false;
	}
	return true;
}

function drainStandInPending(doc: StandInDoc): void {
	let progressed = true;
	while (progressed) {
		progressed = false;
		const still: StandInDoc["pending"] = [];
		for (const p of doc.pending) {
			const batchIds = new Set(p.ops.map(o => idKey(o.id)));
			const opsReady = p.ops.every(op => !op.origin || batchIds.has(idKey(op.origin)) || doc.items.some(x => idKey(x.id) === idKey(op.origin!)));
			if (hasDeps(doc, p.reqSv) && opsReady) {
				applyRgaItems(doc, p.ops, p.dels);
				for (const [c, next] of p.adds) {
					const k = String(c);
					if (next > (doc.sv[k] ?? 0)) doc.sv[k] = next;
				}
				progressed = true;
			} else {
				still.push(p);
			}
		}
		doc.pending = still;
	}
}

export function mergeStandIn(state: Uint8Array | undefined, update: Uint8Array): Uint8Array {
	const doc = state ? decDoc(state) : emptyStandIn();
	const up = decDoc(update);
	if (up.pending.length) {
		doc.pending.push(...up.pending);
	}
	// If update is a full snapshot/state, merge items and deleted directly when causally complete.
	if (up.items.length || up.deleted.length) {
		doc.pending.push({
			ops: up.items,
			dels: up.deleted,
			reqSv: {},
			adds: Object.entries(up.sv).map(([c, n]) => [Number(c), n]),
		});
	}
	drainStandInPending(doc);
	return encDoc(doc);
}

function editStandIn(baseBytes: Uint8Array, nextText: string, clientId: number): { update: Uint8Array; agreement: Uint8Array } {
	const doc = decDoc(baseBytes);
	const delSet = new Set(doc.deleted);
	const visible = doc.items.filter(x => !delSet.has(idKey(x.id)));
	const prev = visible.map(x => x.ch).join("");
	let pre = 0;
	while (pre < prev.length && pre < nextText.length && prev[pre] === nextText[pre]) pre++;
	let suf = 0;
	while (suf < prev.length - pre && suf < nextText.length - pre && prev[prev.length - 1 - suf] === nextText[nextText.length - 1 - suf]) suf++;

	const reqSv = { ...doc.sv };
	const dels: string[] = [];
	for (let i = pre; i < prev.length - suf; i++) {
		dels.push(idKey(visible[i]!.id));
	}
	let origin: ItemId | null = pre > 0 ? visible[pre - 1]!.id : null;
	let nextSeq = doc.sv[String(clientId)] ?? 0;
	const ops: RgaItem[] = [];
	const inserted = nextText.slice(pre, nextText.length - suf);
	for (const ch of inserted) {
		const id: ItemId = [clientId, nextSeq++];
		ops.push({ id, origin, ch });
		origin = id;
	}
	const upd: StandInDoc = {
		items: [],
		deleted: [],
		sv: {},
		pending: [{ ops, dels, reqSv, adds: inserted.length ? [[clientId, nextSeq]] : [] }],
	};
	const update = encDoc(upd);
	const agreement = mergeStandIn(baseBytes, update);
	return { update, agreement };
}

function snapshotStandIn(state: Uint8Array): { sv: Record<string, number>; deleted: string[] } {
	const doc = decDoc(state);
	return { sv: { ...doc.sv }, deleted: [...new Set(doc.deleted)].sort() };
}

export const standInCrdt: TextCrdt = {
	create(text, clientId) {
		const doc = emptyStandIn();
		const ops: RgaItem[] = [];
		let origin: ItemId | null = null;
		for (let i = 0; i < text.length; i++) {
			const id: ItemId = [clientId, i];
			ops.push({ id, origin, ch: text[i]! });
			origin = id;
		}
		applyRgaItems(doc, ops, []);
		doc.sv[String(clientId)] = text.length;
		return encDoc(doc);
	},
	completeText(state) {
		if (!state) return undefined;
		const doc = decDoc(state);
		if (doc.pending.length > 0) return undefined;
		const delSet = new Set(doc.deleted);
		return doc.items.filter(x => !delSet.has(idKey(x.id))).map(x => x.ch).join("");
	},
	applyToUnchangedBase(base, diskText, clientId) {
		return editStandIn(base, diskText, clientId);
	},
	onlyInserts(from, to) {
		let i = 0;
		for (const ch of to) if (i < from.length && ch === from[i]) i++;
		return i === from.length;
	},
	sameDocState(a, b) {
		if (a === b) return true;
		if (!a || !b) return false;
		return standInCrdt.snapshot(a) === standInCrdt.snapshot(b);
	},
	snapshot(state) {
		return Buffer.from(JSON.stringify(snapshotStandIn(state))).toString("base64");
	},
	outsideDeletion(row, state) {
		const doc = decDoc(state);
		if (row.snapshot !== undefined) {
			const snap = JSON.parse(Buffer.from(row.snapshot, "base64").toString("utf8")) as { sv: Record<string, number>; deleted: string[] };
			for (const [c, n] of Object.entries(doc.sv)) {
				if (n > (snap.sv[c] ?? 0)) return true;
			}
			const snapDel = new Set(snap.deleted);
			for (const d of doc.deleted) {
				if (!snapDel.has(d)) return true;
			}
			return false;
		}
		if (row.vector !== undefined) {
			const seen = JSON.parse(Buffer.from(row.vector, "base64").toString("utf8")) as Record<string, number>;
			return Object.entries(doc.sv).some(([c, n]) => n > (seen[c] ?? 0));
		}
		return false;
	},
};

// --- Exhaustive 2-Device x 2-Note Model with Fine-Grained Async Boundaries & Crash Points ---

interface DiskJournal {
	kind: "write" | "move" | "remove";
	path: string;
	from?: string;
	text?: string;
	expectedHash: string | null;
	displacedText?: string;
	displacedHash?: string;
}

interface SimDisk {
	files: Map<string, { text: string; mtime: number; unreadable?: boolean }>;
	pendingEvents: { event: "changed" | "deleted" | "renamed"; path?: string; from?: string; to?: string; mayDelete?: boolean }[];
	journal?: DiskJournal;
	effectApplied?: boolean; // distinguishes CrashBeforeDiskEffect vs CrashAfterDiskEffect
	nextMtime: number;
}

interface DeviceModel {
	name: string;
	clientId: number;
	nextIdSeq: number;
	state: VaultNoteState;
	disk: SimDisk;
	editorOpen: Map<string, string>; // noteId -> live buffer text
	editorSavedBuffer: Map<string, string>; // noteId -> buffered text for EditorSave
	outbox: { seq: number; docId: string; update: Uint8Array }[];
	sentReqs: { id: string; request: NoteRequest }[];
	pendingAnswers: { req: string; ok?: number; refused?: { row: NoteRow | null; missing: boolean } }[];
	rowCursor: number;
	textCursor: number;
	actions: NoteAction[];
}

interface WorkerModel {
	seq: number;
	rows: Map<string, NoteRow>; // keyed by file
	pathIndex: Map<string, string>; // live path -> file
	answers: Map<string, number>; // req -> ok seq
	rowLog: NoteRow[];
	textLog: { docId: string; update: Uint8Array }[];
	storedDocs: Set<string>;
}

interface UserActionRecord {
	kind: "create" | "edit" | "type" | "rename" | "delete" | "restore" | "join" | "brakeDecline" | "brakeApprove";
	device: number;
	path: string;
	noteId?: string;
	text?: string;
	concurrentConflict?: boolean;
}

interface World {
	devices: [DeviceModel, DeviceModel];
	worker: WorkerModel;
	history: UserActionRecord[];
	brake: { minCount: number; minFraction: number };
}

function makeDevice(name: string, clientId: number, firstSync = false): DeviceModel {
	return {
		name,
		clientId,
		nextIdSeq: 1,
		state: emptyVaultNoteState(firstSync),
		disk: { files: new Map(), pendingEvents: [], nextMtime: 1 },
		editorOpen: new Map(),
		editorSavedBuffer: new Map(),
		outbox: [],
		sentReqs: [],
		pendingAnswers: [],
		rowCursor: 0,
		textCursor: 0,
		actions: [],
	};
}

function cloneDevice(d: DeviceModel): DeviceModel {
	return {
		...d,
		state: {
			...d.state,
			notes: new Map([...d.state.notes].map(([k, v]) => [k, { ...v }])),
			byPath: new Map(d.state.byPath),
			rowsByPath: new Map(d.state.rowsByPath),
			filesToDocs: new Map(d.state.filesToDocs),
			docs: new Map([...d.state.docs].map(([k, v]) => [k, v.slice()])),
			observed: new Map([...d.state.observed].map(([k, v]) => [k, { ...v, stat: { ...v.stat } }])),
			dirtyPaths: new Map(d.state.dirtyPaths),
			blocked: new Map(d.state.blocked),
			forget: new Map(d.state.forget),
			brakePaused: d.state.brakePaused ? { ...d.state.brakePaused } : undefined,
			pendingProblems: [...d.state.pendingProblems],
		},
		disk: {
			files: new Map([...d.disk.files].map(([k, v]) => [k, { ...v }])),
			pendingEvents: d.disk.pendingEvents.map(e => ({ ...e })),
			journal: d.disk.journal ? { ...d.disk.journal } : undefined,
			effectApplied: d.disk.effectApplied,
			nextMtime: d.disk.nextMtime,
		},
		editorOpen: new Map(d.editorOpen),
		editorSavedBuffer: new Map(d.editorSavedBuffer),
		outbox: d.outbox.map(o => ({ ...o, update: o.update.slice() })),
		sentReqs: d.sentReqs.map(r => ({ ...r, request: { ...r.request } })),
		pendingAnswers: d.pendingAnswers.map(a => ({ ...a })),
		actions: [...d.actions],
	};
}

function cloneWorld(w: World): World {
	return {
		devices: [cloneDevice(w.devices[0]), cloneDevice(w.devices[1])],
		worker: {
			seq: w.worker.seq,
			rows: new Map([...w.worker.rows].map(([k, v]) => [k, { ...v }])),
			pathIndex: new Map(w.worker.pathIndex),
			answers: new Map(w.worker.answers),
			rowLog: w.worker.rowLog.map(r => ({ ...r })),
			textLog: w.worker.textLog.map(t => ({ ...t, update: t.update.slice() })),
			storedDocs: new Set(w.worker.storedDocs),
		},
		history: w.history.map(h => ({ ...h })),
		brake: { ...w.brake },
	};
}

function makeEnv(d: DeviceModel, w: World): StepEnv {
	return {
		crdt: standInCrdt,
		clientId: d.clientId,
		newId: () => `${d.clientId.toString(16).padStart(8, "0")}${(d.nextIdSeq++).toString(16).padStart(24, "0")}`,
		hash: sha,
		brake: w.brake,
	};
}

function dispatchDevice(d: DeviceModel, w: World, input: NoteInput): NoteAction[] {
	const res = step(d.state, input, makeEnv(d, w));
	checkNoteInvariants(res.state);
	d.state = res.state;
	d.actions = res.actions;
	for (const act of res.actions) {
		if (act.t === "yjsMerge") {
			// Ensure local state:<id> holds merged doc and outbox carries update/snapshot.
			d.state.docs.set(act.id, act.agreement);
			d.outbox.push({ seq: d.nextIdSeq++, docId: act.id, update: act.update });
		} else if (act.t === "closeEditor") {
			if (d.editorOpen.has(act.id)) {
				d.editorOpen.delete(act.id);
				d.editorSavedBuffer.delete(act.id);
				return [...res.actions, ...dispatchDevice(d, w, { t: "editorClose", id: act.id })];
			}
		}
	}
	return res.actions;
}

function diskView(disk: SimDisk): Map<string, DiskObsFile> {
	const m = new Map<string, DiskObsFile>();
	for (const [p, f] of disk.files) {
		if (f.unreadable) {
			m.set(p, { stat: { path: p, size: f.text.length, mtime: f.mtime }, unreadable: true });
		} else {
			m.set(p, { stat: { path: p, size: f.text.length, mtime: f.mtime }, text: f.text, hash: sha(f.text) });
		}
	}
	return m;
}

function finishTableDiskRecovery(disk: SimDisk): void {
	if (!disk.journal) return;
	const j = disk.journal;
	if (j.displacedText !== undefined && !disk.effectApplied) {
		// Crashed after moving from -> displaced, before finishing: putBack if mismatch or write incomplete.
		if (!disk.files.has(j.path)) {
			disk.files.set(j.path, { text: j.displacedText, mtime: disk.nextMtime++ });
		} else {
			let copy = conflictName(j.path, j.displacedHash!);
			while (disk.files.has(copy)) copy = conflictName(copy, j.displacedHash!);
			disk.files.set(copy, { text: j.displacedText, mtime: disk.nextMtime++ });
		}
	}
	disk.journal = undefined;
	disk.effectApplied = undefined;
}

// --- Fine-grained Async Boundary Transitions ---

type StepKind =
	| { t: "sendRowReq"; dev: number }
	| { t: "workerApplyReq"; dev: number }
	| { t: "deliverAnswer"; dev: number }
	| { t: "deliverRow"; dev: number }
	| { t: "deliverTextAck"; dev: number }
	| { t: "deliverTextEntry"; dev: number }
	| { t: "deliverDiskEvent"; dev: number }
	| { t: "execIntentStart"; dev: number }
	| { t: "execIntentFinish"; dev: number }
	| { t: "crashBeforeDiskEffect"; dev: number }
	| { t: "crashAfterDiskEffect"; dev: number }
	| { t: "crashBeforeIntentDone"; dev: number }
	| { t: "brakeApprove"; dev: number }
	| { t: "brakeDecline"; dev: number };

function applyWorkerRequest(w: WorkerModel, req: NonNullable<NoteEntryReq>): { ok?: number; refused?: { row: NoteRow | null; missing: boolean } } {
	const prevOk = w.answers.get(req.req);
	if (prevOk !== undefined) return { ok: prevOk };

	const existing = w.rows.get(req.file);
	if (req.action === "set") {
		if (req.base === null ? !!existing : (!existing || existing.seq !== req.base)) {
			return { refused: { row: existing ?? null, missing: false } };
		}
		const occFile = w.pathIndex.get(req.path);
		if (occFile && occFile !== req.file) {
			return { refused: { row: w.rows.get(occFile) ?? null, missing: false } };
		}
		// Assert Worker invariant: never store a live NoteRow without stored Yjs text.
		const docId = existing?.id ?? req.file; // Wait: we pass docId separately in real wire; find from device/stored!
		void docId;
	}
	return {};
}
type NoteEntryReq = NoteRequest | undefined;

function runAsyncStep(w: World, sk: StepKind): void {
	const d = w.devices[sk.dev]!;
	switch (sk.t) {
		case "sendRowReq": {
			for (const n of d.state.notes.values()) {
				if (n.inFlight && n.inFlight.accepted === undefined && !d.sentReqs.some(s => s.request.req === n.inFlight!.req)) {
					d.sentReqs.push({ id: n.id, request: { ...n.inFlight } });
					break;
				}
			}
			return;
		}
		case "workerApplyReq": {
			const item = d.sentReqs.shift();
			if (!item) return;
			const req = item.request;
			const prevOk = w.worker.answers.get(req.req);
			if (prevOk !== undefined) {
				d.pendingAnswers.push({ req: req.req, ok: prevOk });
				return;
			}
			const existing = w.worker.rows.get(req.file);
			if (req.action === "set") {
				if (req.base === null ? !!existing : (!existing || existing.seq !== req.base)) {
					d.pendingAnswers.push({ req: req.req, refused: { row: existing ?? null, missing: false } });
					return;
				}
				const occFile = w.worker.pathIndex.get(req.path);
				if (occFile && occFile !== req.file) {
					d.pendingAnswers.push({ req: req.req, refused: { row: w.worker.rows.get(occFile) ?? null, missing: false } });
					return;
				}
				assert.ok(w.worker.storedDocs.has(item.id), `Worker invariant violated: live NoteRow ${item.id} at ${req.path} created without stored Yjs text`);
				const seq = ++w.worker.seq;
				if (existing) w.worker.pathIndex.delete(existing.path);
				const row: NoteRow = { kind: "note", id: item.id, file: req.file, path: req.path, seq, deleted: null };
				w.worker.rows.set(req.file, row);
				w.worker.pathIndex.set(req.path, req.file);
				w.worker.answers.set(req.req, seq);
				w.worker.rowLog.push(row);
				d.pendingAnswers.push({ req: req.req, ok: seq });
				return;
			}
			if (req.action === "del") {
				if (!existing || existing.seq !== req.base || existing.deleted !== null) {
					d.pendingAnswers.push({ req: req.req, refused: { row: existing ?? null, missing: false } });
					return;
				}
				const seq = ++w.worker.seq;
				w.worker.pathIndex.delete(existing.path);
				const row: NoteRow = {
					kind: "note",
					id: existing.id,
					file: req.file,
					path: existing.path,
					seq,
					deleted: 1000 + seq,
					...(req.change.t === "del" && req.change.snapshot ? { snapshot: req.change.snapshot } : {}),
				};
				w.worker.rows.set(req.file, row);
				w.worker.answers.set(req.req, seq);
				w.worker.rowLog.push(row);
				d.pendingAnswers.push({ req: req.req, ok: seq });
				return;
			}
			// restore
			if (!existing || existing.seq !== req.base || existing.deleted === null) {
				d.pendingAnswers.push({ req: req.req, refused: { row: existing ?? null, missing: false } });
				return;
			}
			const occFile = w.worker.pathIndex.get(req.path);
			if (occFile && occFile !== req.file) {
				d.pendingAnswers.push({ req: req.req, refused: { row: w.worker.rows.get(occFile) ?? null, missing: false } });
				return;
			}
			assert.ok(w.worker.storedDocs.has(item.id), `Worker invariant violated: restored live NoteRow ${item.id} without stored text`);
			const seq = ++w.worker.seq;
			const row: NoteRow = { kind: "note", id: existing.id, file: req.file, path: req.path, seq, deleted: null };
			w.worker.rows.set(req.file, row);
			w.worker.pathIndex.set(req.path, req.file);
			w.worker.answers.set(req.req, seq);
			w.worker.rowLog.push(row);
			d.pendingAnswers.push({ req: req.req, ok: seq });
			return;
		}
		case "deliverAnswer": {
			const ans = d.pendingAnswers.shift();
			if (!ans) return;
			dispatchDevice(d, w, { t: "answer", ...ans });
			return;
		}
		case "deliverRow": {
			const row = w.worker.rowLog[d.rowCursor];
			if (!row) return;
			d.rowCursor++;
			dispatchDevice(d, w, { t: "row", row });
			return;
		}
		case "deliverTextAck": {
			const out = d.outbox.shift();
			if (!out) return;
			w.worker.textLog.push({ docId: out.docId, update: out.update });
			w.worker.storedDocs.add(out.docId);
			const cur = d.state.docs.get(out.docId);
			if (cur) dispatchDevice(d, w, { t: "yjsUpdate", id: out.docId, docState: cur, isFirstTextAck: true });
			return;
		}
		case "deliverTextEntry": {
			const entry = w.worker.textLog[d.textCursor];
			if (!entry) return;
			d.textCursor++;
			const merged = mergeStandIn(d.state.docs.get(entry.docId), entry.update);
			d.state.docs.set(entry.docId, merged);
			if (d.editorOpen.has(entry.docId)) {
				const txt = standInCrdt.completeText(merged);
				if (txt !== undefined) d.editorOpen.set(entry.docId, txt);
			}
			dispatchDevice(d, w, { t: "yjsUpdate", id: entry.docId, docState: merged });
			return;
		}
		case "deliverDiskEvent": {
			const ev = d.disk.pendingEvents.shift();
			if (!ev) return;
			dispatchDevice(d, w, {
				t: "diskObs",
				event: ev.event,
				path: ev.path,
				from: ev.from,
				to: ev.to,
				mayDelete: ev.mayDelete,
				listingComplete: true,
				files: diskView(d.disk),
			});
			return;
		}
		case "execIntentStart": {
			const op = d.state.intent;
			if (!op || d.disk.journal) return;
			// Enforce open-editor & held invariant!
			const note = d.state.notes.get(op.id);
			assert.notEqual(note?.editor, "open", "Invariant violated: disk intent targeting open editor");
			if (op.kind === "write") assert.notEqual(note?.held, true, "Invariant violated: writing held note");
			const targetPath = op.kind === "move" ? op.from : op.path;
			const cur = op.expectedHash !== null ? d.disk.files.get(targetPath) : undefined;
			if (cur) d.disk.files.delete(targetPath); // moved privately into displaced
			d.disk.journal = {
				kind: op.kind,
				path: op.path,
				from: op.kind === "move" ? op.from : undefined,
				text: op.kind === "write" ? op.text : undefined,
				expectedHash: op.expectedHash,
				displacedText: cur?.text,
				displacedHash: cur ? sha(cur.text) : undefined,
			};
			d.disk.effectApplied = false;
			return;
		}
		case "execIntentFinish": {
			const op = d.state.intent;
			const j = d.disk.journal;
			if (!op || !j) return;
			const curAtDest = d.disk.files.get(op.path);
			const matched = j.expectedHash === null ? !curAtDest : j.displacedHash === j.expectedHash;
			if (!d.disk.effectApplied) {
				if (matched) {
					applyDiskEffect(d.disk, op, j);
				} else if (j.displacedText !== undefined) {
					// Put back displaced user bytes safely (TableDisk.putBack)
					const putAt = op.kind === "move" ? op.from : op.path;
					if (!d.disk.files.has(putAt)) d.disk.files.set(putAt, { text: j.displacedText, mtime: d.disk.nextMtime++ });
					else {
						let copy = conflictName(putAt, j.displacedHash!);
						while (d.disk.files.has(copy)) copy = conflictName(copy, j.displacedHash!);
						d.disk.files.set(copy, { text: j.displacedText, mtime: d.disk.nextMtime++ });
					}
				}
			}
			const outcome = matched ? "applied" : "preconditionFailed";
			d.disk.journal = undefined;
			d.disk.effectApplied = undefined;
			const after = op.kind === "remove" ? undefined : diskView(d.disk).get(op.path);
			dispatchDevice(d, w, { t: "intentDone", intent: op, outcome, after });
			return;
		}
		case "crashBeforeDiskEffect": {
			// Journal written (or intent committed), disk NOT mutated yet -> crashRestart + discardTemp + startup scan
			d.disk.journal = undefined;
			d.disk.effectApplied = undefined;
			crashAndRestart(d, w);
			return;
		}
		case "crashAfterDiskEffect": {
			// Mutate disk under journal, then crash BEFORE journal is cleared / BEFORE intentDone
			const op = d.state.intent;
			if (op && !d.disk.journal) runAsyncStep(w, { t: "execIntentStart", dev: sk.dev });
			if (op && d.disk.journal && !d.disk.effectApplied) applyDiskEffect(d.disk, op, d.disk.journal);
			crashAndRestart(d, w);
			return;
		}
		case "crashBeforeIntentDone": {
			// Finish disk mutation & clear journal, crash BEFORE NoteDevice commits intentDone!
			const op = d.state.intent;
			if (op && !d.disk.journal) runAsyncStep(w, { t: "execIntentStart", dev: sk.dev });
			if (op && d.disk.journal) {
				if (!d.disk.effectApplied) applyDiskEffect(d.disk, op, d.disk.journal);
				d.disk.journal = undefined;
				d.disk.effectApplied = undefined;
			}
			crashAndRestart(d, w);
			return;
		}
		case "brakeApprove": {
			dispatchDevice(d, w, { t: "brakeApproved" });
			return;
		}
		case "brakeDecline": {
			dispatchDevice(d, w, { t: "brakeDeclined" });
			return;
		}
	}
}

function applyDiskEffect(disk: SimDisk, op: NoteIntent, j: DiskJournal): void {
	disk.effectApplied = true;
	const curAtDest = disk.files.get(op.path);
	const matched = j.expectedHash === null ? !curAtDest : j.displacedHash === j.expectedHash;
	if (!matched) {
		// TableDisk precondition check failed before writing temp/move: putBack displaced bytes without overwriting disk.
		if (j.displacedText !== undefined) {
			const putAt = op.kind === "move" ? op.from : op.path;
			if (!disk.files.has(putAt)) disk.files.set(putAt, { text: j.displacedText, mtime: disk.nextMtime++ });
		}
		return;
	}
	if (op.kind === "write") {
		if (!disk.files.has(op.path)) {
			disk.files.set(op.path, { text: op.text, mtime: disk.nextMtime++ });
		}
	} else if (op.kind === "move") {
		if (!disk.files.has(op.path) && j.displacedText !== undefined) {
			disk.files.set(op.path, { text: j.displacedText, mtime: disk.nextMtime++ });
		}
	} else if (op.kind === "remove") {
		// already removed from visible path into displaced
	}
}

function crashAndRestart(d: DeviceModel, w: World): void {
	finishTableDiskRecovery(d.disk);
	d.editorOpen.clear();
	d.editorSavedBuffer.clear();
	d.sentReqs = [];
	d.pendingAnswers = [];
	d.disk.pendingEvents = [];
	dispatchDevice(d, w, { t: "crashRestart" });
	dispatchDevice(d, w, { t: "diskObs", event: "startup", listingComplete: true, files: diskView(d.disk) });
}

function quiesceWorld(w: World, maxTicks = 200): void {
	for (let tick = 0; tick < maxTicks; tick++) {
		let did = false;
		for (let dev = 0; dev < 2; dev++) {
			const d = w.devices[dev]!;
			if (d.outbox.length) { runAsyncStep(w, { t: "deliverTextAck", dev }); did = true; }
			if (d.textCursor < w.worker.textLog.length) { runAsyncStep(w, { t: "deliverTextEntry", dev }); did = true; }
			if ([...d.state.notes.values()].some(n => n.inFlight && n.inFlight.accepted === undefined && !d.sentReqs.some(s => s.request.req === n.inFlight!.req))) {
				runAsyncStep(w, { t: "sendRowReq", dev }); did = true;
			}
			if (d.sentReqs.length) { runAsyncStep(w, { t: "workerApplyReq", dev }); did = true; }
			if (d.pendingAnswers.length) { runAsyncStep(w, { t: "deliverAnswer", dev }); did = true; }
			if (d.rowCursor < w.worker.rowLog.length) { runAsyncStep(w, { t: "deliverRow", dev }); did = true; }
			if (d.disk.pendingEvents.length) { runAsyncStep(w, { t: "deliverDiskEvent", dev }); did = true; }
			if (d.state.intent) {
				if (!d.disk.journal) runAsyncStep(w, { t: "execIntentStart", dev });
				runAsyncStep(w, { t: "execIntentFinish", dev });
				did = true;
			}
			if (d.state.forget.size) { d.state.forget.clear(); did = true; }
		}
		if (!did) return;
	}
	throw new Error("World failed to quiesce");
}

// --- Exact-Set Conflict & Base-Advancement Oracle ---

interface ExpectedResult {
	liveTexts: Map<string, string>; // path -> expected exact text
	exactConflictCount: number;
	exactConflictTexts: Set<string>;
	anyOrderTexts?: Set<string>;
}

function verifyWorld(w: World, expected?: ExpectedResult): void {
	// 1. Worker invariant: no live row without stored text
	for (const row of w.worker.rows.values()) {
		if (row.deleted === null) {
			assert.ok(w.worker.storedDocs.has(row.id), `Worker holds live row ${row.id} without stored text`);
		}
	}

	// 2. Convergence across both devices
	const [d0, d1] = w.devices;
	const live0 = [...d0.disk.files.entries()].filter(([, f]) => !f.unreadable).map(([p, f]) => [p, f.text]).sort();
	const live1 = [...d1.disk.files.entries()].filter(([, f]) => !f.unreadable).map(([p, f]) => [p, f.text]).sort();
	if (!d0.state.brakePaused?.declined && !d1.state.brakePaused?.declined && !hasAnyHeld(d0) && !hasAnyHeld(d1)) {
		assert.deepEqual(live0, live1, `Devices diverged:\nD0: ${JSON.stringify(live0)}\nD1: ${JSON.stringify(live1)}`);
	}

	// 3. Base-advancement check: when settled and disk == docText, baseState MUST match docState!
	for (const d of w.devices) {
		for (const n of d.state.notes.values()) {
			if (!n.diskPath || n.editor !== "closed" || n.held || d.state.blocked.has(n.id) || d.state.intent?.id === n.id) continue;
			const diskFile = d.disk.files.get(n.diskPath);
			const docState = d.state.docs.get(n.id);
			const docText = standInCrdt.completeText(docState);
			if (diskFile && !diskFile.unreadable && docState && docText !== undefined && diskFile.text === docText) {
				assert.ok(
					standInCrdt.sameDocState(n.baseState, docState),
					`Stale baseState on ${d.name} for ${n.diskPath} (${n.id}) even though disk == docText`,
				);
			}
			// 4. One-copy cap invariant: at most 1 unresolved conflict copy per source note on each device
			const unresolvedForN = [...d.state.notes.values()].filter(
				c => c.copyOf === n.id && c.conflictOriginPath !== undefined && c.row?.deleted == null && c.change?.t !== "del",
			);
			assert.ok(unresolvedForN.length <= 1, `Conflict storm on ${d.name}: ${unresolvedForN.length} unresolved copies for ${n.id}`);
		}
	}

	// 5. Exact-set conflict oracle & expected texts (when provided)
	if (expected) {
		const actualMap = new Map(live0 as [string, string][]);
		for (const [p, t] of expected.liveTexts) {
			assert.equal(actualMap.get(p), t, `Expected exact text at ${p}`);
		}
		const conflictById = new Map<string, NoteEntry>();
		for (const d of w.devices) {
			for (const n of d.state.notes.values()) {
				if (n.copyOf !== undefined && n.row?.deleted == null) conflictById.set(n.id, n);
			}
		}
		const actualConflicts = [...conflictById.values()];
		assert.equal(
			actualConflicts.length,
			expected.exactConflictCount,
			`Conflict count mismatch: got ${actualConflicts.length}, expected ${expected.exactConflictCount} (${actualConflicts.map(c => c.row?.path)})`,
		);
		if (expected.anyOrderTexts) {
			assert.deepEqual(new Set(actualMap.values()), expected.anyOrderTexts, "Expected exact text set");
			assert.equal(actualMap.size, expected.anyOrderTexts.size + expected.exactConflictCount, `Unexpected extra files: ${JSON.stringify(live0)}`);
		} else {
			assert.equal(
				actualMap.size,
				expected.liveTexts.size + expected.exactConflictCount,
				`Unexpected extra live files: got ${JSON.stringify(live0)}, expected ${JSON.stringify([...expected.liveTexts])}`,
			);
		}
		for (const c of actualConflicts) {
			const txt = standInCrdt.completeText(d0.state.docs.get(c.id))!;
			assert.ok(expected.exactConflictTexts.has(txt), `Unexpected conflict text: ${JSON.stringify(txt)}`);
		}
	}
}

function hasAnyHeld(d: DeviceModel): boolean {
	return [...d.state.notes.values()].some(n => n.held);
}

// --- Minimizer (Delta-Debugging over Interleaving Sequences) ---

function minimizeTrace(init: () => World, steps: StepKind[], check: (w: World) => void): StepKind[] {
	const fails = (cand: StepKind[]) => {
		const w = init();
		try {
			for (const s of cand) runAsyncStep(w, s);
			quiesceWorld(w);
			check(w);
			return false;
		} catch {
			return true;
		}
	};
	if (fails([])) return [];
	let current = [...steps];
	let chunk = Math.max(1, Math.floor(current.length / 2));
	while (chunk >= 1 && current.length > 1) {
		let reduced = false;
		for (let i = 0; i < current.length; i += chunk) {
			const candidate = [...current.slice(0, i), ...current.slice(i + chunk)];
			if (fails(candidate)) {
				current = candidate;
				reduced = true;
				break;
			}
		}
		if (!reduced) chunk = Math.floor(chunk / 2);
	}
	return current;
}

// --- Scenario & Exhaustive Interleaving Driver ---

function canonicalKey(w: World): string {
	return JSON.stringify({
		r0: w.devices[0].rowCursor,
		r1: w.devices[1].rowCursor,
		t0: w.devices[0].textCursor,
		t1: w.devices[1].textCursor,
		wSeq: w.worker.seq,
		d0: [...w.devices[0].disk.files].map(([k, v]) => [k, v.text]),
		d1: [...w.devices[1].disk.files].map(([k, v]) => [k, v.text]),
		j0: w.devices[0].disk.journal ? [w.devices[0].disk.journal.kind, w.devices[0].disk.effectApplied] : null,
		j1: w.devices[1].disk.journal ? [w.devices[1].disk.journal.kind, w.devices[1].disk.effectApplied] : null,
		n0: [...w.devices[0].state.notes.values()].map(n => [n.id, n.diskPath, n.editor, n.held, n.change?.t, n.inFlight?.action, n.row?.seq, n.intendedHash]),
		n1: [...w.devices[1].state.notes.values()].map(n => [n.id, n.diskPath, n.editor, n.held, n.change?.t, n.inFlight?.action, n.row?.seq, n.intendedHash]),
		i0: w.devices[0].state.intent?.kind,
		i1: w.devices[1].state.intent?.kind,
		b0: [...w.devices[0].state.blocked.keys()],
		b1: [...w.devices[1].state.blocked.keys()],
		o0: w.devices[0].outbox.length,
		o1: w.devices[1].outbox.length,
		s0: w.devices[0].sentReqs.length,
		s1: w.devices[1].sentReqs.length,
		a0: w.devices[0].pendingAnswers.length,
		a1: w.devices[1].pendingAnswers.length,
		de0: w.devices[0].disk.pendingEvents.length,
		de1: w.devices[1].disk.pendingEvents.length,
	});
}

function enabledAsyncSteps(w: World, includeCrashes: boolean): StepKind[] {
	const out: StepKind[] = [];
	for (let dev = 0; dev < 2; dev++) {
		const d = w.devices[dev]!;
		if (d.outbox.length) out.push({ t: "deliverTextAck", dev });
		if (d.textCursor < w.worker.textLog.length) out.push({ t: "deliverTextEntry", dev });
		if ([...d.state.notes.values()].some(n => n.inFlight && n.inFlight.accepted === undefined && !d.sentReqs.some(s => s.request.req === n.inFlight!.req))) {
			out.push({ t: "sendRowReq", dev });
		}
		if (d.sentReqs.length) out.push({ t: "workerApplyReq", dev });
		if (d.pendingAnswers.length) out.push({ t: "deliverAnswer", dev });
		if (d.rowCursor < w.worker.rowLog.length) out.push({ t: "deliverRow", dev });
		if (d.disk.pendingEvents.length) out.push({ t: "deliverDiskEvent", dev });
		if (d.state.intent) {
			if (!d.disk.journal) {
				out.push({ t: "execIntentStart", dev });
				if (includeCrashes) out.push({ t: "crashBeforeDiskEffect", dev });
			} else {
				out.push({ t: "execIntentFinish", dev });
				if (includeCrashes) {
					if (!d.disk.effectApplied) out.push({ t: "crashAfterDiskEffect", dev });
					out.push({ t: "crashBeforeIntentDone", dev });
				}
			}
		}
	}
	return out;
}

function exploreAllInterleavings(
	name: string,
	init: () => World,
	expected: ExpectedResult,
	maxDepth = 18,
	includeCrashes = true,
	maxStates = 4000,
): { visited: number; terminal: number } {
	const seen = new Set<string>();
	const queue: { world: World; trace: StepKind[]; crashesLeft: number }[] = [{ world: init(), trace: [], crashesLeft: includeCrashes ? 1 : 0 }];
	let head = 0;
	let visited = 0;
	let terminal = 0;

	while (head < queue.length && visited < maxStates) {
		const { world, trace, crashesLeft } = queue[head++]!;
		const key = canonicalKey(world) + "|" + crashesLeft;
		if (seen.has(key)) continue;
		seen.add(key);
		visited++;

		const nexts = trace.length >= maxDepth ? [] : enabledAsyncSteps(world, crashesLeft > 0);
		if (nexts.length === 0) {
			terminal++;
			const finalW = cloneWorld(world);
			try {
				quiesceWorld(finalW);
				verifyWorld(finalW, expected);
			} catch (err) {
				const min = minimizeTrace(init, trace, w => verifyWorld(w, expected));
				throw new Error(
					`Counterexample in [${name}] (${min.length} steps): ${JSON.stringify(min)}\nRoot cause: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			continue;
		}
		for (const sk of nexts) {
			const child = cloneWorld(world);
			const isCrash = sk.t === "crashBeforeDiskEffect" || sk.t === "crashAfterDiskEffect" || sk.t === "crashBeforeIntentDone";
			runAsyncStep(child, sk);
			if (isCrash) {
				const postCrash = cloneWorld(child);
				try {
					quiesceWorld(postCrash);
					verifyWorld(postCrash, expected);
				} catch (err) {
					const fullTrace = [...trace, sk];
					const min = minimizeTrace(init, fullTrace, w => verifyWorld(w, expected));
					throw new Error(
						`Counterexample in [${name}] (${min.length} steps): ${JSON.stringify(min)}\nRoot cause: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			queue.push({ world: child, trace: [...trace, sk], crashesLeft: isCrash ? crashesLeft - 1 : crashesLeft });
		}
	}
	return { visited, terminal };
}

function userCreate(w: World, dev: number, path: string, text: string): void {
	const d = w.devices[dev]!;
	d.disk.files.set(path, { text, mtime: d.disk.nextMtime++ });
	d.disk.pendingEvents.push({ event: "changed", path });
}

function userOutsideEdit(w: World, dev: number, path: string, text: string): void {
	const d = w.devices[dev]!;
	d.disk.files.set(path, { text, mtime: d.disk.nextMtime++ });
	d.disk.pendingEvents.push({ event: "changed", path });
}

function userDelete(w: World, dev: number, path: string): void {
	const d = w.devices[dev]!;
	d.disk.files.delete(path);
	d.disk.pendingEvents.push({ event: "deleted", path, mayDelete: true });
}

function userRename(w: World, dev: number, from: string, to: string): void {
	const d = w.devices[dev]!;
	const cur = d.disk.files.get(from);
	if (!cur) return;
	d.disk.files.delete(from);
	d.disk.files.set(to, { text: cur.text, mtime: d.disk.nextMtime++ });
	d.disk.pendingEvents.push({ event: "renamed", from, to });
}

function userOpenEditor(w: World, dev: number, noteId: string): boolean {
	const d = w.devices[dev]!;
	const acts = dispatchDevice(d, w, { t: "editorOpen", id: noteId });
	const ok = acts.some(a => a.t === "openResult" && a.id === noteId && a.allowed);
	if (ok) {
		const txt = standInCrdt.completeText(d.state.docs.get(noteId))!;
		d.editorOpen.set(noteId, txt);
		d.editorSavedBuffer.set(noteId, txt);
	}
	return ok;
}

function userEditorType(w: World, dev: number, noteId: string, newText: string): void {
	const d = w.devices[dev]!;
	const cur = d.state.docs.get(noteId)!;
	const { update, agreement } = standInCrdt.applyToUnchangedBase(cur, newText, d.clientId);
	d.editorOpen.set(noteId, newText);
	d.outbox.push({ seq: d.nextIdSeq++, docId: noteId, update });
	dispatchDevice(d, w, { t: "yjsUpdate", id: noteId, docState: agreement });
}

function userEditorSave(w: World, dev: number, noteId: string, explicitText?: string): void {
	const d = w.devices[dev]!;
	const n = d.state.notes.get(noteId)!;
	if (!n.diskPath) return;
	const text = explicitText ?? d.editorOpen.get(noteId) ?? d.editorSavedBuffer.get(noteId)!;
	d.disk.files.set(n.diskPath, { text, mtime: d.disk.nextMtime++ });
	d.disk.pendingEvents.push({ event: "changed", path: n.diskPath, mayDelete: false });
}

function userCloseEditor(w: World, dev: number, noteId: string): void {
	const d = w.devices[dev]!;
	d.editorOpen.delete(noteId);
	d.editorSavedBuffer.delete(noteId);
	dispatchDevice(d, w, { t: "editorClose", id: noteId });
}

function makeFreshWorld(brake = { minCount: 20, minFraction: 0.25 }): World {
	return {
		devices: [makeDevice("D0", 1), makeDevice("D1", 2)],
		worker: { seq: 0, rows: new Map(), pathIndex: new Map(), answers: new Map(), rowLog: [], textLog: [], storedDocs: new Set() },
		history: [],
		brake,
	};
}

function seedTwoSyncedNotes(): { w: World; idA: string; idB: string } {
	const w = makeFreshWorld();
	userCreate(w, 0, "a.md", "alpha");
	userCreate(w, 0, "b.md", "beta");
	quiesceWorld(w);
	const idA = w.devices[0].state.byPath.get("a.md")!;
	const idB = w.devices[0].state.byPath.get("b.md")!;
	return { w, idA, idB };
}

// --- Exhaustive Checker Suite ---

test("exhaustive checker: 2x2 async interleavings, crash points, exact-set oracle, and bug regressions", () => {
	const startTime = Date.now();
	let totalStates = 0;
	let totalTerminals = 0;

	const failures: string[] = [];
	const record = (fn: () => { visited: number; terminal: number }) => {
		try {
			const res = fn();
			totalStates += res.visited;
			totalTerminals += res.terminal;
		} catch (e) {
			failures.push(e instanceof Error ? e.message : String(e));
		}
	};

	// 1. Concurrent creation on same path -> exact 2 distinct user notes, zero lost text, Worker never lacks text
	record(() => exploreAllInterleavings("concurrent-create-same-path", () => {
		const w = makeFreshWorld();
		userCreate(w, 0, "a.md", "from zero");
		userCreate(w, 1, "a.md", "from one");
		return w;
	}, {
		liveTexts: new Map(),
		exactConflictCount: 0,
		exactConflictTexts: new Set(),
		anyOrderTexts: new Set(["from zero", "from one"]),
	}));

	// 1b. First placement crash recovery (Reviewer Blocker 1: crash after disk effect before IntentDone)
	record(() => exploreAllInterleavings("first-placement-crash-recovery", () => {
		const w = makeFreshWorld();
		userCreate(w, 0, "a.md", "alpha");
		// Deliver D0 to Worker, deliver row & text to D1 so D1 enters first-placement write intent
		runAsyncStep(w, { t: "deliverDiskEvent", dev: 0 });
		runAsyncStep(w, { t: "deliverTextAck", dev: 0 });
		runAsyncStep(w, { t: "sendRowReq", dev: 0 });
		runAsyncStep(w, { t: "workerApplyReq", dev: 0 });
		runAsyncStep(w, { t: "deliverAnswer", dev: 0 });
		runAsyncStep(w, { t: "deliverRow", dev: 0 });
		runAsyncStep(w, { t: "deliverRow", dev: 1 });
		runAsyncStep(w, { t: "deliverTextEntry", dev: 1 });
		return w;
	}, {
		liveTexts: new Map([["a.md", "alpha"]]),
		exactConflictCount: 0,
		exactConflictTexts: new Set(),
	}));

	// 2. Closed-file single-sided edit + base advancement (exact 0 conflicts!)
	record(() => exploreAllInterleavings("single-sided-closed-edit-and-base-advance", () => {
		const { w } = seedTwoSyncedNotes();
		userOutsideEdit(w, 0, "a.md", "alpha one");
		return w;
	}, {
		liveTexts: new Map([["a.md", "alpha one"], ["b.md", "beta"]]),
		exactConflictCount: 0,
		exactConflictTexts: new Set(),
	}));

	// 3. Concurrent remote edit + closed-file edit -> exact 1 conflict copy with copyOf holding disk text verbatim
	record(() => exploreAllInterleavings("concurrent-closed-edit-vs-remote", () => {
		const { w, idA } = seedTwoSyncedNotes();
		// D0 edits in open editor and publishes to Worker; D1 edits closed disk file before seeing D0's update
		assert.ok(userOpenEditor(w, 0, idA));
		userEditorType(w, 0, idA, "alpha remote");
		userEditorSave(w, 0, idA);
		userCloseEditor(w, 0, idA);
		runAsyncStep(w, { t: "deliverDiskEvent", dev: 0 });
		runAsyncStep(w, { t: "deliverTextAck", dev: 0 });
		// D1 gets D0's remote Yjs update BEFORE D1's closed-file edit event arrives (so D1's doc != baseState!)
		runAsyncStep(w, { t: "deliverTextEntry", dev: 1 });
		userOutsideEdit(w, 1, "a.md", "alpha local");
		return w;
	}, {
		liveTexts: new Map([["a.md", "alpha remote"], ["b.md", "beta"]]),
		exactConflictCount: 1,
		exactConflictTexts: new Set(["alpha local"]),
	}, 22, true, 4000));

	// 4. Bug: Edits behind a pending request (rename in flight + live typing + disk edit)
	record(() => exploreAllInterleavings("edits-behind-pending-request", () => {
		const { w, idA } = seedTwoSyncedNotes();
		userRename(w, 0, "a.md", "a2.md");
		runAsyncStep(w, { t: "deliverDiskEvent", dev: 0 });
		runAsyncStep(w, { t: "sendRowReq", dev: 0 });
		// Edit before Worker applies or answers!
		userOutsideEdit(w, 0, "a2.md", "alpha renamed edited");
		return w;
	}, {
		liveTexts: new Map([["a2.md", "alpha renamed edited"], ["b.md", "beta"]]),
		exactConflictCount: 0,
		exactConflictTexts: new Set(),
	}));

	// 5. Bug: Transient missing file during atomic save (mayDelete=false) + remote update settle
	record(() => exploreAllInterleavings("transient-missing-file-no-delete", () => {
		const { w, idA } = seedTwoSyncedNotes();
		// D0 transient missing with mayDelete=false followed by restored save; D1 types concurrently
		const d0 = w.devices[0];
		d0.disk.files.delete("a.md");
		d0.disk.pendingEvents.push({ event: "changed", path: "a.md", mayDelete: false });
		assert.ok(userOpenEditor(w, 1, idA));
		userEditorType(w, 1, idA, "alpha peer");
		userEditorSave(w, 1, idA);
		userCloseEditor(w, 1, idA);
		d0.disk.files.set("a.md", { text: "alpha", mtime: d0.disk.nextMtime++ });
		d0.disk.pendingEvents.push({ event: "changed", path: "a.md", mayDelete: false });
		return w;
	}, {
		liveTexts: new Map([["a.md", "alpha peer"], ["b.md", "beta"]]),
		exactConflictCount: 0,
		exactConflictTexts: new Set(),
	}));

	// 6. Bug: Delete after typing in open editor -> full doc snapshot prevents resurrection, closes cleanly
	record(() => exploreAllInterleavings("delete-after-typing-open-editor", () => {
		const { w, idA } = seedTwoSyncedNotes();
		assert.ok(userOpenEditor(w, 0, idA));
		userEditorType(w, 0, idA, "alpha typed before delete");
		userDelete(w, 0, "a.md");
		runAsyncStep(w, { t: "deliverDiskEvent", dev: 0 });
		userCloseEditor(w, 0, idA);
		return w;
	}, {
		liveTexts: new Map([["b.md", "beta"]]),
		exactConflictCount: 0,
		exactConflictTexts: new Set(),
	}));

	// 7. Bug: Snapshot tombstone vs concurrent edit (both insertion AND deletion on peer revive via restore!)
	record(() => exploreAllInterleavings("snapshot-tombstone-revives-unseen-delete", () => {
		const { w, idA } = seedTwoSyncedNotes();
		// D0 deletes a.md (snapshot of "alpha"); D1 concurrently deletes a word/char in open editor ("alph") -> outsideDeletion!
		assert.ok(userOpenEditor(w, 1, idA));
		userEditorType(w, 1, idA, "alph");
		userEditorSave(w, 1, idA);
		userCloseEditor(w, 1, idA);
		userDelete(w, 0, "a.md");
		return w;
	}, {
		liveTexts: new Map([["a.md", "alph"], ["b.md", "beta"]]),
		exactConflictCount: 0,
		exactConflictTexts: new Set(),
	}));

	// 8b. Bug: Stale editor save behind remote update (Reviewer Blocker 3)
	record(() => exploreAllInterleavings("stale-editor-save-behind-remote-update", () => {
		const { w, idA } = seedTwoSyncedNotes();
		assert.ok(userOpenEditor(w, 0, idA));
		userEditorType(w, 0, idA, "alpha 1");
		userEditorSave(w, 0, idA);
		userCloseEditor(w, 0, idA);
		// Deliver D0's edit to D1 and materialize on D1, then D1 extends to "alpha 1 2" and pushes before D0's stale EditorSave event delivers
		runAsyncStep(w, { t: "deliverTextAck", dev: 0 });
		runAsyncStep(w, { t: "deliverTextEntry", dev: 1 });
		runAsyncStep(w, { t: "execIntentStart", dev: 1 });
		runAsyncStep(w, { t: "execIntentFinish", dev: 1 });
		assert.ok(userOpenEditor(w, 1, idA));
		userEditorType(w, 1, idA, "alpha 1 2");
		userEditorSave(w, 1, idA);
		userCloseEditor(w, 1, idA);
		return w;
	}, {
		liveTexts: new Map([["a.md", "alpha 1 2"], ["b.md", "beta"]]),
		exactConflictCount: 0,
		exactConflictTexts: new Set(),
	}));
	// 8. Bug: Recovery provenance & stale flush (owed-recover after crash while open)
	record(() => exploreAllInterleavings("owed-recover-unrecorded-save-vs-stale-flush", () => {
		const { w, idA } = seedTwoSyncedNotes();
		assert.ok(userOpenEditor(w, 0, idA));
		userEditorType(w, 0, idA, "alpha typed");
		// External/unrecorded save on disk before crash
		const d0 = w.devices[0];
		d0.disk.files.set("a.md", { text: "alpha unrecorded", mtime: d0.disk.nextMtime++ });
		crashAndRestart(d0, w);
		return w;
	}, {
		liveTexts: new Map([["a.md", "alpha typed"], ["b.md", "beta"]]),
		exactConflictCount: 1,
		exactConflictTexts: new Set(["alpha unrecorded"]),
	}));

	// 9. Bug: First-sync join with pre-existing disk files (both matching and differing text; row before text order)
	record(() => exploreAllInterleavings("first-sync-join-preexisting-disk", () => {
		const w = makeFreshWorld();
		// D0 creates a.md ("same") and b.md ("remote") on Worker
		userCreate(w, 0, "a.md", "same");
		userCreate(w, 0, "b.md", "remote");
		quiesceWorld(w);
		// D1 starts fresh with firstSync=true: catches up on Worker rows before startup disk scan,
		// with matching a.md ("same") and differing b.md ("local different") on disk; texts arrive via exploreAllInterleavings!
		w.devices[1] = makeDevice("D1", 2, true);
		runAsyncStep(w, { t: "deliverRow", dev: 1 });
		runAsyncStep(w, { t: "deliverRow", dev: 1 });
		w.devices[1].disk.files.set("a.md", { text: "same", mtime: 1 });
		w.devices[1].disk.files.set("b.md", { text: "local different", mtime: 1 });
		dispatchDevice(w.devices[1], w, {
			t: "diskObs",
			event: "startup",
			listingComplete: true,
			files: diskView(w.devices[1].disk),
		});
		return w;
	}, {
		liveTexts: new Map(),
		exactConflictCount: 0,
		exactConflictTexts: new Set(),
		anyOrderTexts: new Set(["same", "remote", "local different"]),
	}, 24, true, 5000));

	// 10. Bug: Conflict-copy storm (1-copy cap -> held, no 2nd fork, resolves once 1st copy deleted/renamed)
	record(() => {
		const { w, idA } = seedTwoSyncedNotes();
		// Force first conflict copy on D1: D0 pushes alpha r1 to D1 first, then D1 edits closed disk file concurrently
		assert.ok(userOpenEditor(w, 0, idA));
		userEditorType(w, 0, idA, "alpha r1");
		userEditorSave(w, 0, idA);
		userCloseEditor(w, 0, idA);
		runAsyncStep(w, { t: "deliverDiskEvent", dev: 0 });
		runAsyncStep(w, { t: "deliverTextAck", dev: 0 });
		runAsyncStep(w, { t: "deliverTextEntry", dev: 1 });
		userOutsideEdit(w, 1, "a.md", "alpha c1");
		quiesceWorld(w);
		const copy = [...w.devices[1].state.notes.values()].find(n => n.copyOf === idA)!;
		assert.ok(copy);
		// Second concurrent clash on D1 -> must hold, NOT fork 2nd copy!
		assert.ok(userOpenEditor(w, 0, idA));
		userEditorType(w, 0, idA, "alpha r2");
		userEditorSave(w, 0, idA);
		userCloseEditor(w, 0, idA);
		runAsyncStep(w, { t: "deliverDiskEvent", dev: 0 });
		runAsyncStep(w, { t: "deliverTextAck", dev: 0 });
		runAsyncStep(w, { t: "deliverTextEntry", dev: 1 });
		userOutsideEdit(w, 1, "a.md", "alpha c2");
		quiesceWorld(w);
		assert.equal([...w.devices[1].state.notes.values()].filter(n => n.copyOf === idA).length, 1);
		assert.equal(w.devices[1].state.notes.get(idA)?.held, true);
		assert.equal(w.devices[1].disk.files.get("a.md")?.text, "alpha c2", "held disk text must not be overwritten");
		// Live typing still syncs in D0 and reaches D1's Yjs doc
		assert.ok(userOpenEditor(w, 0, idA));
		userEditorType(w, 0, idA, "alpha r3");
		userEditorSave(w, 0, idA);
		userCloseEditor(w, 0, idA);
		quiesceWorld(w);
		assert.equal(standInCrdt.completeText(w.devices[1].state.docs.get(idA)), "alpha r3");
		assert.equal(w.devices[1].disk.files.get("a.md")?.text, "alpha c2");
		// Resolve conflict copy by deleting it -> held clears and c2 forks once cleanly, converging!
		userDelete(w, 1, copy.diskPath!);
		quiesceWorld(w);
		verifyWorld(w);
		assert.equal(w.devices[1].disk.files.get("a.md")?.text, "alpha r3");
		assert.equal([...w.devices[1].state.notes.values()].filter(n => n.copyOf === idA).length, 2);
		return { visited: 1, terminal: 1 };
	});

	// 11. BrakeDeclined ("undo my side, hold theirs") & BrakeApproved with small env thresholds
	record(() => {
		const w2 = makeFreshWorld({ minCount: 1, minFraction: 0.25 });
		userCreate(w2, 0, "a.md", "alpha");
		userCreate(w2, 0, "b.md", "beta");
		userCreate(w2, 0, "c.md", "gamma");
		quiesceWorld(w2);
		userDelete(w2, 1, "b.md");
		userDelete(w2, 1, "c.md");
		// Deliver D1 deletes to Worker only
		for (let i = 0; i < 10; i++) {
			runAsyncStep(w2, { t: "deliverDiskEvent", dev: 1 });
			runAsyncStep(w2, { t: "sendRowReq", dev: 1 });
			runAsyncStep(w2, { t: "workerApplyReq", dev: 1 });
			runAsyncStep(w2, { t: "deliverAnswer", dev: 1 });
			runAsyncStep(w2, { t: "deliverRow", dev: 1 });
		}
		// Now D0 sees D1's two tombstones (b.md dirty first so both accumulate) + D0 deletes a.md -> brake triggers!
		dispatchDevice(w2.devices[0], w2, { t: "pathDirty", path: "b.md", delta: 1 });
		runAsyncStep(w2, { t: "deliverRow", dev: 0 });
		runAsyncStep(w2, { t: "deliverRow", dev: 0 });
		w2.devices[0].disk.files.delete("a.md");
		crashAndRestart(w2.devices[0], w2);
		assert.ok(w2.devices[0].actions.some(a => a.t === "massChangeBrake"));
		// Decline brake: a.md writes back to disk, while b.md & c.md stay held on D0!
		runAsyncStep(w2, { t: "brakeDecline", dev: 0 });
		assert.ok(w2.devices[0].actions.some(a => a.t === "problem" && /2 deleted files held/.test(a.message)));
		quiesceWorld(w2);
		assert.equal(w2.devices[0].disk.files.get("a.md")?.text, "alpha", "cancelled outgoing delete wrote back to disk");
		assert.equal(w2.devices[0].disk.files.get("b.md")?.text, "beta", "incoming deletion held on D0");
		assert.equal(w2.devices[0].disk.files.get("c.md")?.text, "gamma", "incoming deletion held on D0");
		assert.equal(w2.devices[1].disk.files.get("a.md")?.text, "alpha", "a.md stayed live across vault");
		// Approve brake: b.md and c.md are removed on D0 and vault converges
		runAsyncStep(w2, { t: "brakeApprove", dev: 0 });
		quiesceWorld(w2);
		verifyWorld(w2, {
			liveTexts: new Map([["a.md", "alpha"]]),
			exactConflictCount: 0,
			exactConflictTexts: new Set(),
		});
		return { visited: 1, terminal: 1 };
	});

	// 12. Out-of-order Yjs updates (deliver update 2 before update 1) + crash recovery
	record(() => {
		const { w, idA } = seedTwoSyncedNotes();
		assert.ok(userOpenEditor(w, 0, idA));
		userEditorType(w, 0, idA, "alpha 1");
		userEditorType(w, 0, idA, "alpha 1 2");
		userCloseEditor(w, 0, idA);
		// Ack both to Worker textLog, then deliver update 2 to D1 BEFORE update 1
		runAsyncStep(w, { t: "deliverTextAck", dev: 0 });
		runAsyncStep(w, { t: "deliverTextAck", dev: 0 });
		const log = w.worker.textLog;
		const u1 = log[log.length - 2]!;
		const u2 = log[log.length - 1]!;
		const d1 = w.devices[1];
		const m1 = mergeStandIn(d1.state.docs.get(idA), u2.update);
		dispatchDevice(d1, w, { t: "yjsUpdate", id: idA, docState: m1 });
		assert.equal(standInCrdt.completeText(d1.state.docs.get(idA)), undefined, "incomplete doc waits for missing dependency");
		const m2 = mergeStandIn(d1.state.docs.get(idA), u1.update);
		dispatchDevice(d1, w, { t: "yjsUpdate", id: idA, docState: m2 });
		d1.textCursor = log.length;
		quiesceWorld(w);
		verifyWorld(w, {
			liveTexts: new Map([["a.md", "alpha 1 2"], ["b.md", "beta"]]),
			exactConflictCount: 0,
			exactConflictTexts: new Set(),
		});
		return { visited: 1, terminal: 1 };
	});

	// 13. Blocker 2 regression: crash after NoteDevice state:<id> commit before outbox commit recovers via durable unpublished marker
	record(() => {
		const w = makeFreshWorld();
		const d0 = w.devices[0];
		d0.disk.files.set("a.md", { text: "alpha", mtime: 1 });
		// Simulate step() committing NoteEntry (with unpublished) without pushing to d0.outbox (crash right before outbox!)
		const res = step(d0.state, {
			t: "diskObs",
			event: "changed",
			path: "a.md",
			listingComplete: true,
			files: diskView(d0.disk),
		}, makeEnv(d0, w));
		d0.state = res.state;
		assert.equal(d0.outbox.length, 0);
		assert.ok([...d0.state.notes.values()][0]?.unpublished);
		// Crash and restart -> CrashRestart re-emits yjsMerge from unpublished, outbox queues, note syncs!
		crashAndRestart(d0, w);
		assert.equal(d0.outbox.length, 1);
		quiesceWorld(w);
		verifyWorld(w, {
			liveTexts: new Map([["a.md", "alpha"]]),
			exactConflictCount: 0,
			exactConflictTexts: new Set(),
		});
		return { visited: 1, terminal: 1 };
	});

	// 14. Sticky brakeDeclined + exact-set brakeApproved (stuck approved deletion doesn't disable brake for new mass deletes)
	record(() => {
		const w = makeFreshWorld({ minCount: 1, minFraction: 0.25 });
		userCreate(w, 0, "a.md", "alpha");
		userCreate(w, 0, "b.md", "beta");
		userCreate(w, 0, "c.md", "gamma");
		userCreate(w, 0, "d.md", "delta");
		quiesceWorld(w);
		// D1 deletes b, c -> D0 sees both tombstones + D0 deletes a -> brake triggers
		userDelete(w, 1, "b.md");
		userDelete(w, 1, "c.md");
		for (let i = 0; i < 10; i++) {
			runAsyncStep(w, { t: "deliverDiskEvent", dev: 1 });
			runAsyncStep(w, { t: "sendRowReq", dev: 1 });
			runAsyncStep(w, { t: "workerApplyReq", dev: 1 });
			runAsyncStep(w, { t: "deliverAnswer", dev: 1 });
			runAsyncStep(w, { t: "deliverRow", dev: 1 });
		}
		dispatchDevice(w.devices[0], w, { t: "pathDirty", path: "b.md", delta: 1 });
		runAsyncStep(w, { t: "deliverRow", dev: 0 });
		runAsyncStep(w, { t: "deliverRow", dev: 0 });
		w.devices[0].disk.files.delete("a.md");
		crashAndRestart(w.devices[0], w);
		assert.ok(w.devices[0].actions.some(a => a.t === "massChangeBrake"));
		// Decline: a.md restores, b & c stay held; then D0 deletes d.md (1 <= 1) -> does NOT re-prompt for held b & c!
		runAsyncStep(w, { t: "brakeDecline", dev: 0 });
		quiesceWorld(w);
		userDelete(w, 0, "d.md");
		runAsyncStep(w, { t: "deliverDiskEvent", dev: 0 });
		assert.equal(w.devices[0].actions.some(a => a.t === "massChangeBrake"), false, "declined b/c stay sticky and do not trigger prompt for 1 new delete");
		quiesceWorld(w);
		assert.equal(w.devices[0].disk.files.get("b.md")?.text, "beta");
		assert.equal(w.devices[0].disk.files.get("c.md")?.text, "gamma");
		// Now approve: held b & c are removed cleanly
		runAsyncStep(w, { t: "brakeApprove", dev: 0 });
		quiesceWorld(w);
		verifyWorld(w, {
			liveTexts: new Map([["a.md", "alpha"]]),
			exactConflictCount: 0,
			exactConflictTexts: new Set(),
		});
		return { visited: 1, terminal: 1 };
	});

	const elapsedMs = Date.now() - startTime;
	console.log(`# Exhaustive model checker: ${totalStates} states explored (${totalTerminals} terminal interleavings) in ${elapsedMs}ms`);
	assert.deepEqual(failures, [], `Model checker found ${failures.length} counterexamples:\n${failures.join("\n\n")}`);
});
