// Pure vault-level state machine for table notes: apply(state, input, env) updates
// VaultNoteState only; next(state, env) derives all actions purely from current state.
import * as Y from "yjs";
import { conflictName } from "../places";
import type { DiskFile, Store } from "../ports";
import { applyText, onlyInserts } from "../text";
import type { NoteRow } from "./notes";

export type NoteStructure =
	| { t: "set"; path: string; basePath?: string; legacyRestore?: true }
	| ({ t: "del"; path: string } & ({ snapshot: string; vector?: never } | { vector: string; snapshot?: never }))
	| { t: "restore"; path: string; base: number };

export interface NoteRequest {
	req: string;
	file: string;
	base: number | null;
	action: NoteStructure["t"];
	path: string;
	change: NoteStructure;
	accepted?: number;
}

export interface TextCrdt {
	create(text: string, clientId: number): Uint8Array;
	completeText(state: Uint8Array | undefined): string | undefined;
	/** Single-sided diff ONLY when docs[id] == baseState. Disk text enters Yjs as diffs, never whole-text replace. */
	applyToUnchangedBase(base: Uint8Array, diskText: string, clientId: number): { update: Uint8Array; agreement: Uint8Array };
	/** True when `to` contains all of `from` with zero deletions (stale editor flush behind live typing). */
	onlyInserts(from: string, to: string): boolean;
	sameDocState(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean;
	snapshot(state: Uint8Array): string;
	outsideDeletion(row: { snapshot?: string; vector?: string }, state: Uint8Array): boolean;
}

const b64 = (bytes: Uint8Array) => {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function loadDoc(state?: Uint8Array, clientId?: number) {
	const doc = new Y.Doc();
	if (clientId !== undefined) doc.clientID = clientId;
	if (state) Y.applyUpdate(doc, state);
	return doc;
}

export const yjsTextCrdt: TextCrdt = {
	create(text, clientId) {
		const doc = loadDoc(undefined, clientId);
		try {
			doc.getText("t").insert(0, text);
			return Y.encodeStateAsUpdate(doc);
		} finally { doc.destroy(); }
	},
	completeText(state) {
		if (!state) return undefined;
		const doc = loadDoc(state);
		try {
			if (!doc.store.pendingStructs && !doc.store.pendingDs) return doc.getText("t").toString();
		} finally { doc.destroy(); }
	},
	applyToUnchangedBase(base, diskText, clientId) {
		const doc = loadDoc(base, clientId);
		try {
			const from = Y.encodeStateVector(doc);
			applyText(doc.getText("t"), diskText);
			return { update: Y.encodeStateAsUpdate(doc, from), agreement: Y.encodeStateAsUpdate(doc) };
		} finally { doc.destroy(); }
	},
	onlyInserts(from, to) {
		return onlyInserts(from, to);
	},
	sameDocState(a, b) {
		if (a === b) return true;
		if (!a || !b) return false;
		return yjsTextCrdt.snapshot(a) === yjsTextCrdt.snapshot(b);
	},
	snapshot(state) {
		const doc = loadDoc(state);
		try { return b64(Y.encodeSnapshot(Y.snapshot(doc))); }
		finally { doc.destroy(); }
	},
	outsideDeletion(row, state) {
		if (row.snapshot !== undefined) return !Y.snapshotContainsUpdate(Y.decodeSnapshot(unb64(row.snapshot)), state);
		if (row.vector === undefined) return false;
		const seen = Y.decodeStateVector(unb64(row.vector));
		return [...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(state))].some(([client, clock]) => clock > (seen.get(client) ?? 0));
	},
};

export type EditorMode = "closed" | "open" | "owed-doc" | "owed-recover";

export interface NoteEntry {
	id: string;
	file: string;
	row?: NoteRow;
	diskPath?: string;
	basePath?: string;
	baseState?: Uint8Array;
	baseStat?: { mtime: number; size: number; hash: string };
	intended?: Uint8Array;
	intendedHash?: string;
	editor: EditorMode;
	missing?: { path: string; snapshot: string };
	// Note: The one-copy cap is per device, because copyOf and conflictOriginPath are local state.
	copyOf?: string;
	conflictOriginPath?: string;
	/** Hash of disk text already preserved in a newly created conflict copy while awaiting rewrite. */
	forkedHash?: string;
	held?: boolean;
	change?: NoteStructure;
	inFlight?: NoteRequest;
	join?: { path: string; hash: string };
	firstTextPending?: boolean;
	needsInitialPublish?: boolean;
	needsSnapshotPublish?: boolean;
	/** Durable unqueued/unacked merge payload so crash between NoteDevice commit and outbox commit never loses a publish. */
	unpublished?: { update: Uint8Array; isSnapshot?: boolean };
}

export interface DiskObsFile {
	stat: DiskFile;
	text?: string;
	hash?: string;
	unreadable?: boolean;
}

export type NoteIntent =
	| { kind: "write"; id: string; path: string; text: string; expectedHash: string | null; seq: number }
	| { kind: "move"; id: string; from: string; path: string; expectedHash: string; seq: number; park?: true }
	| { kind: "remove"; id: string; path: string; expectedHash: string; seq: number };

export interface NoteBlocked {
	authority: string;
	seq: number;
	endpoints: [string, { mtime: number; size: number; hash?: string } | null][];
}

export interface BrakeState {
	count: number;
	approvedIds?: string[]; // exact note IDs covered by the owner's approval
	declined?: boolean;
	declinedIds?: string[]; // incoming deletion note IDs held by decline (stop counting toward new prompts)
}

export interface VaultNoteState {
	notes: Map<string, NoteEntry>;
	byPath: Map<string, string>;
	rowsByPath: Map<string, string>;
	filesToDocs: Map<string, string>;
	docs: Map<string, Uint8Array>;
	observed: Map<string, DiskObsFile>;
	listingComplete: boolean;
	dirtyPaths: Map<string, number>;
	blocked: Map<string, NoteBlocked>;
	forget: Map<string, true>;
	intent?: NoteIntent;
	brakePaused?: BrakeState;
	firstSync: boolean;
	noteAuthority: boolean;
	lastOpenResult?: { id: string; allowed: boolean };
	pendingProblems: [string, string][];
	emittedNotices: Set<string>;
	touched: Set<string>; // note IDs touched since last next(), or null/all via fullScan
	fullScan: boolean;
}

export interface LegacyNoteSeed {
	notes: NoteEntry[];
	docs: Map<string, Uint8Array>;
	forget?: Map<string, true>;
	firstSync: boolean;
}

export type NoteInput =
	| { t: "crashRestart" }
	| { t: "finishFirstSync" }
	| { t: "migrateFromLegacy"; seed: LegacyNoteSeed }
	| {
		t: "diskObs";
		event: "startup" | "settle" | "changed" | "deleted" | "renamed";
		path?: string;
		from?: string;
		to?: string;
		mayDelete?: boolean;
		listingComplete: boolean;
		files: Map<string, DiskObsFile>;
	}
	| { t: "yjsUpdate"; id: string; docState: Uint8Array; isFirstTextAck?: boolean; textQueued?: boolean }
	| { t: "editorOpen"; id: string }
	| { t: "editorClose"; id: string }
	| { t: "row"; row: NoteRow }
	| { t: "userRestore"; id: string; path?: string; deletionSeq?: number }
	| { t: "answer"; req: string; ok?: number; refused?: { row: NoteRow | null; missing: boolean } }
	| {
		t: "intentDone";
		intent: NoteIntent;
		outcome: "applied" | "landed" | "preconditionFailed" | "unreadable" | "caseClash";
		after?: DiskObsFile;
	}
	| { t: "brakeApproved" }
	| { t: "brakeDeclined" }
	| { t: "pathDirty"; path: string; delta: 1 | -1 };

export type NoteAction =
	| { t: "forget"; req: string }
	| { t: "yjsMerge"; id: string; update: Uint8Array; agreement: Uint8Array; isInitial?: boolean; isSnapshot?: boolean }
	| { t: "workerReq"; id: string; request: NoteRequest }
	| { t: "diskIntent"; intent: NoteIntent }
	| { t: "closeEditor"; id: string }
	| { t: "openResult"; id: string; allowed: boolean }
	| { t: "massChangeBrake"; count: number; message: string }
	| { t: "problem"; path: string; message: string };

export interface StepEnv {
	crdt: TextCrdt;
	clientId: number;
	newId(): string;
	hash(text: string): string;
	brake?: { minCount: number; minFraction: number };
	attachmentPendingDeletes?: number;
	attachmentTotalLive?: number;
}

const DEFAULT_BRAKE = { minCount: 20, minFraction: 0.25 };

const textCache = new WeakMap<TextCrdt, WeakMap<Uint8Array, string | undefined>>();
const snapCache = new WeakMap<TextCrdt, WeakMap<Uint8Array, string>>();

function cachedText(crdt: TextCrdt, state: Uint8Array | undefined): string | undefined {
	if (!state) return undefined;
	let perCrdt = textCache.get(crdt);
	if (!perCrdt) textCache.set(crdt, perCrdt = new WeakMap());
	if (perCrdt.has(state)) return perCrdt.get(state);
	const t = crdt.completeText(state);
	perCrdt.set(state, t);
	return t;
}

function cachedSnap(crdt: TextCrdt, state: Uint8Array): string {
	let perCrdt = snapCache.get(crdt);
	if (!perCrdt) snapCache.set(crdt, perCrdt = new WeakMap());
	let snap = perCrdt.get(state);
	if (snap === undefined) {
		snap = crdt.snapshot(state);
		perCrdt.set(state, snap);
	}
	return snap;
}

export function emptyVaultNoteState(firstSync = false): VaultNoteState {
	return {
		notes: new Map(),
		byPath: new Map(),
		rowsByPath: new Map(),
		filesToDocs: new Map(),
		docs: new Map(),
		observed: new Map(),
		listingComplete: true,
		dirtyPaths: new Map(),
		blocked: new Map(),
		forget: new Map(),
		firstSync,
		noteAuthority: true,
		pendingProblems: [],
		emittedNotices: new Set(),
		touched: new Set(),
		fullScan: false,
	};
}

export function checkNoteInvariants(state: VaultNoteState): void {
	const diskPaths = new Map<string, string>();
	const files = new Map<string, string>();
	for (const [id, n] of state.notes) {
		if (n.id !== id) throw new Error("NoteEntry key mismatch for " + id);
		const prevDoc = files.get(n.file);
		if (prevDoc && prevDoc !== id) throw new Error("Multiple document IDs for file " + n.file);
		files.set(n.file, id);
		if (n.diskPath !== undefined) {
			const prev = diskPaths.get(n.diskPath);
			if (prev) throw new Error("Multiple notes claim disk path " + n.diskPath);
			diskPaths.set(n.diskPath, id);
		}
	}
}

function cloneState(s: VaultNoteState): VaultNoteState {
	return {
		...s,
		notes: new Map(s.notes),
		byPath: new Map(s.byPath),
		rowsByPath: new Map(s.rowsByPath),
		filesToDocs: new Map(s.filesToDocs),
		docs: new Map(s.docs),
		observed: new Map(s.observed),
		dirtyPaths: new Map(s.dirtyPaths),
		blocked: new Map(s.blocked),
		forget: new Map(s.forget),
		brakePaused: s.brakePaused ? {
			...s.brakePaused,
			approvedIds: s.brakePaused.approvedIds ? [...s.brakePaused.approvedIds] : undefined,
			declinedIds: s.brakePaused.declinedIds ? [...s.brakePaused.declinedIds] : undefined,
		} : undefined,
		pendingProblems: [...s.pendingProblems],
		emittedNotices: new Set(s.emittedNotices),
		touched: new Set(s.touched),
	};
}

function setEntry(s: VaultNoteState, next: NoteEntry): void {
	const old = s.notes.get(next.id);
	if (old?.diskPath && s.byPath.get(old.diskPath) === next.id && old.diskPath !== next.diskPath) {
		s.byPath.delete(old.diskPath);
	}
	if (next.diskPath !== undefined) s.byPath.set(next.diskPath, next.id);
	const knownDoc = s.filesToDocs.get(next.file);
	if (knownDoc && knownDoc !== next.id) throw new Error("A note's file and document IDs must stay together");
	s.filesToDocs.set(next.file, next.id);
	s.notes.set(next.id, next);
	s.touched.add(next.id);
	if (next.copyOf) s.touched.add(next.copyOf);
	if (old?.copyOf) s.touched.add(old.copyOf);

	// Rebuild affected row path index using highest-seq winner (catch-up can deliver swap seqs out of path order).
	const touched = new Set<string>();
	if (old?.row?.deleted === null) touched.add(old.row.path);
	if (next.row?.deleted === null) touched.add(next.row.path);
	for (const p of touched) {
		let best: NoteRow | undefined;
		for (const candidate of s.notes.values()) {
			if (candidate.row?.deleted === null && candidate.row.path === p && (!best || candidate.row.seq > best.seq)) {
				best = candidate.row;
			}
		}
		if (best) s.rowsByPath.set(p, best.id);
		else s.rowsByPath.delete(p);
	}
}

/**
 * True when `id` currently has an unresolved local conflict/recovered copy (`copyOf === id`)
 * that the user has not deleted or renamed away. Per-device because `copyOf` is local state.
 * Note: conflictOriginPath is only cleared on deletion or user rename after placement, so
 * Worker row path negotiation before placement never lifts the cap prematurely.
 */
export function hasUnresolvedConflict(state: VaultNoteState, id: string): boolean {
	for (const c of state.notes.values()) {
		if (c.copyOf !== id || c.conflictOriginPath === undefined) continue;
		if (c.row?.deleted != null || c.change?.t === "del") continue;
		if (!c.diskPath || c.diskPath === c.conflictOriginPath) return true;
	}
	return false;
}

const withRecoveredSuffix = (path: string, id: string, n: number) =>
	path.replace(/(\.[^./]*)?$/, (_, ext) => ` (recovered ${id.slice(0, 6)}${n === 1 ? "" : " " + n})${ext ?? ""}`);

const withRestoredSuffix = (path: string, n: number) =>
	path.replace(/(\.[^./]*)?$/, (_, ext) => ` (restored${n === 1 ? "" : " " + n})${ext ?? ""}`);

function pathOccupied(state: VaultNoteState, path: string, exceptId: string): boolean {
	const diskOwner = state.byPath.get(path);
	if (diskOwner && diskOwner !== exceptId) return true;
	const rowOwner = state.rowsByPath.get(path);
	if (rowOwner && rowOwner !== exceptId) return true;
	if (state.observed.has(path) && state.byPath.get(path) !== exceptId) return true;
	for (const other of state.notes.values()) {
		if (other.id === exceptId) continue;
		if ((other.change?.t === "set" || other.change?.t === "restore") && other.change.path === path) return true;
		if (other.inFlight?.path === path && other.inFlight.action !== "del") return true;
	}
	return false;
}

function pickCopyPath(state: VaultNoteState, path: string, sourceId: string, recovered: boolean): string {
	let candidate = recovered ? withRecoveredSuffix(path, sourceId, 1) : conflictName(path, sourceId);
	for (let n = 2; pathOccupied(state, candidate, sourceId); n++) {
		candidate = recovered ? withRecoveredSuffix(path, sourceId, n) : conflictName(candidate, sourceId);
	}
	return candidate;
}

function pickLiveRowPath(state: VaultNoteState, basePath: string, id: string, restoreMode: boolean): string {
	let candidate = basePath;
	for (let n = 1; ; n++) {
		const rowOwner = state.rowsByPath.get(candidate);
		if (!rowOwner || rowOwner === id) return candidate;
		candidate = restoreMode ? withRestoredSuffix(basePath, n) : conflictName(candidate, id);
	}
}

function caseClashPath(state: VaultNoteState, want: string): string | undefined {
	const lower = want.toLowerCase();
	if (state.observed.has(want)) return undefined;
	for (const p of state.observed.keys()) if (p !== want && p.toLowerCase() === lower) return p;
	for (const p of state.byPath.keys()) if (p !== want && p.toLowerCase() === lower) return p;
	return undefined;
}

function desiredPath(n: NoteEntry): string | undefined {
	if (n.row?.deleted != null) return n.change?.t === "restore" ? n.change.path : undefined;
	if (n.inFlight && n.inFlight.action !== "del") return n.inFlight.path;
	let want = n.row?.path ?? n.diskPath;
	if (n.change?.t === "set" && (!n.row || n.row.path === n.change.basePath)) want = n.change.path;
	if (n.change?.t === "restore") want = n.change.path;
	if (n.change?.t === "del" && !n.diskPath) return undefined;
	return want;
}

function captureSnapshot(state: VaultNoteState, n: NoteEntry, env: StepEnv): string | undefined {
	if (n.missing && n.missing.path === n.diskPath) return n.missing.snapshot;
	const src = (n.editor !== "open" ? n.baseState : undefined) ?? state.docs.get(n.id);
	if (!src || cachedText(env.crdt, src) === undefined) return undefined;
	return cachedSnap(env.crdt, src);
}

function markMissingNote(state: VaultNoteState, n: NoteEntry, path: string, env: StepEnv): void {
	if (n.editor === "open") {
		if (n.missing?.path === path) return;
		const doc = state.docs.get(n.id);
		if (!doc || cachedText(env.crdt, doc) === undefined) return;
		setEntry(state, { ...n, missing: { path, snapshot: cachedSnap(env.crdt, doc) } });
		return;
	}
	const snap = captureSnapshot(state, n, env);
	if (snap === undefined) return;
	const dropChange = n.row?.deleted != null && !n.inFlight;
	setEntry(state, {
		...n,
		diskPath: undefined,
		missing: undefined,
		conflictOriginPath: undefined,
		forkedHash: undefined,
		held: false,
		change: dropChange ? undefined : { t: "del", path, snapshot: snap },
	});
}

function clearResolvedBlockers(state: VaultNoteState): void {
	for (const [id, block] of state.blocked) {
		const n = state.notes.get(id);
		const authRow = state.notes.get(block.authority)?.row;
		if (!n || (authRow && authRow.seq !== block.seq)) {
			state.blocked.delete(id);
			continue;
		}
		if (block.endpoints.some(([p, prev]) => {
			const cur = state.observed.get(p);
			if (!prev && !cur) return false;
			if (!prev || !cur) return true;
			return prev.mtime !== cur.stat.mtime || prev.size !== cur.stat.size || prev.hash !== cur.hash || cur.unreadable;
		})) {
			state.blocked.delete(id);
		}
	}
}

function blockNote(state: VaultNoteState, id: string, authority: string, seq: number, paths: string[]): void {
	const endpoints: NoteBlocked["endpoints"] = paths.map(p => {
		const obs = state.observed.get(p);
		return [p, obs ? { mtime: obs.stat.mtime, size: obs.stat.size, hash: obs.hash } : null];
	});
	state.blocked.set(id, { authority, seq, endpoints });
}

function isDirty(state: VaultNoteState, path: string | undefined): boolean {
	return path !== undefined && (state.dirtyPaths.get(path) ?? 0) > 0;
}

/**
 * Isolated handler for `BrakeDeclined` ("undo my side, hold theirs"):
 * cancels outgoing `del` changes so their notes restore back to disk from stored text,
 * while incoming deletions from peers remain held until `BrakeApproved`.
 */
function declineBrake(state: VaultNoteState): void {
	const declinedIds: string[] = [];
	for (const n of state.notes.values()) {
		if (n.change?.t === "del" && n.row?.deleted == null && !n.inFlight) {
			setEntry(state, {
				...n,
				change: undefined,
				missing: undefined,
				diskPath: undefined,
				forkedHash: undefined,
			});
		} else if (n.row?.deleted != null && n.diskPath) {
			declinedIds.push(n.id);
		}
	}
	if (declinedIds.length > 0) {
		state.brakePaused = { count: declinedIds.length, declined: true, declinedIds };
	} else {
		state.brakePaused = undefined;
	}
	state.fullScan = true;
}

function settleStartupIntent(s: VaultNoteState, env: StepEnv): void {
	const op = s.intent;
	if (!op) return;
	s.intent = undefined;
	const n = s.notes.get(op.id);
	if (!n) return;
	if (op.kind === "write") {
		const obs = s.observed.get(op.path);
		if (obs && !obs.unreadable && obs.text !== undefined) {
			const obsHash = obs.hash ?? env.hash(obs.text);
			if (obsHash === n.intendedHash || obs.text === op.text) {
				setEntry(s, {
					...n,
					diskPath: op.path,
					missing: undefined,
					forkedHash: undefined,
					held: false,
					baseState: n.intended ?? s.docs.get(op.id),
					baseStat: { ...obs.stat, hash: obsHash },
					intended: undefined,
					intendedHash: undefined,
					editor: n.editor === "owed-doc" || n.editor === "owed-recover" ? "closed" : n.editor,
				});
				return;
			}
		}
		setEntry(s, { ...n, intended: undefined, intendedHash: undefined });
		return;
	}
	if (op.kind === "move") {
		const src = s.observed.get(op.from);
		const dest = s.observed.get(op.path);
		const srcHash = src && !src.unreadable && src.text !== undefined ? (src.hash ?? env.hash(src.text)) : undefined;
		const destHash = dest && !dest.unreadable && dest.text !== undefined ? (dest.hash ?? env.hash(dest.text)) : undefined;
		if (destHash === op.expectedHash && srcHash !== op.expectedHash) {
			let change = n.change;
			let conflictOriginPath = n.conflictOriginPath;
			if (op.park && !n.row && change?.t === "set") change = { ...change, path: op.path };
			if (conflictOriginPath && op.path !== conflictOriginPath) conflictOriginPath = undefined;
			setEntry(s, { ...n, diskPath: op.path, missing: undefined, change, conflictOriginPath });
		} else {
			s.touched.add(op.id);
		}
		return;
	}
	// remove
	const obs = s.observed.get(op.path);
	const obsHash = obs && !obs.unreadable && obs.text !== undefined ? (obs.hash ?? env.hash(obs.text)) : undefined;
	if (!obs || (obsHash !== undefined && obsHash !== op.expectedHash)) {
		setEntry(s, {
			...n,
			diskPath: undefined,
			missing: undefined,
			conflictOriginPath: undefined,
			forkedHash: undefined,
			held: false,
			baseState: undefined,
			baseStat: undefined,
			intended: undefined,
			intendedHash: undefined,
			change: n.change?.t === "del" ? undefined : n.change,
		});
	} else {
		s.touched.add(op.id);
	}
}

export function apply(prev: VaultNoteState, input: NoteInput, env: StepEnv): VaultNoteState {
	const s = cloneState(prev);
	s.lastOpenResult = undefined;
	s.pendingProblems = [];

	switch (input.t) {
		case "crashRestart": {
			s.dirtyPaths.clear();
			s.observed.clear();
			s.listingComplete = false;
			// Keep durable s.intent across restart so the first complete startup listing settles it cleanly.
			s.brakePaused = s.brakePaused?.declined ? { ...s.brakePaused } : undefined;
			s.emittedNotices.clear();
			s.fullScan = true;
			for (const n of s.notes.values()) {
				const next: NoteEntry = { ...n };
				if (next.editor === "open") next.editor = "owed-recover";
				if (!s.firstSync) next.join = undefined;
				if (next.unpublished) {
					if (next.unpublished.isSnapshot) next.needsSnapshotPublish = true;
					else next.needsInitialPublish = true;
				}
				setEntry(s, next);
			}
			return s;
		}

		case "finishFirstSync": {
			s.firstSync = false;
			s.fullScan = true;
			return s;
		}

		case "migrateFromLegacy": {
			const { seed } = input;
			s.firstSync = seed.firstSync;
			s.noteAuthority = true;
			s.fullScan = true;
			for (const [id, doc] of seed.docs) s.docs.set(id, doc);
			for (const n of seed.notes) setEntry(s, { ...n });
			if (seed.forget) for (const [req] of seed.forget) s.forget.set(req, true);
			return s;
		}

		case "pathDirty": {
			const count = (s.dirtyPaths.get(input.path) ?? 0) + input.delta;
			if (count > 0) s.dirtyPaths.set(input.path, count);
			else {
				s.dirtyPaths.delete(input.path);
				const ownerId = s.byPath.get(input.path) ?? s.rowsByPath.get(input.path);
				if (ownerId) s.touched.add(ownerId);
				for (const n of s.notes.values()) {
					if (desiredPath(n) === input.path || n.change?.path === input.path) s.touched.add(n.id);
				}
			}
			return s;
		}

		case "brakeApproved": {
			const approvedIds: string[] = [];
			for (const n of s.notes.values()) {
				if (n.change?.t === "del" && !n.inFlight) approvedIds.push(n.id);
				else if (n.row?.deleted != null && n.diskPath && !s.blocked.has(n.id)) {
					const docState = s.docs.get(n.id);
					if (!docState || !env.crdt.outsideDeletion(n.row, docState)) approvedIds.push(n.id);
				}
			}
			s.brakePaused = { count: approvedIds.length, approvedIds, declined: false };
			s.emittedNotices.clear();
			s.fullScan = true;
			return s;
		}

		case "brakeDeclined": {
			declineBrake(s);
			return s;
		}

		case "editorOpen": {
			const n = s.notes.get(input.id);
			const want = n ? desiredPath(n) : undefined;
			const refused = !n || n.diskPath === undefined || n.diskPath !== n.row?.path || n.diskPath !== want
				|| n.intended !== undefined || n.held === true || s.intent?.id === input.id
				|| s.blocked.has(input.id) || isDirty(s, n.diskPath);
			if (refused) {
				s.lastOpenResult = { id: input.id, allowed: false };
				return s;
			}
			setEntry(s, { ...n, editor: "open" });
			s.lastOpenResult = { id: input.id, allowed: true };
			return s;
		}

		case "editorClose": {
			const n = s.notes.get(input.id);
			if (!n || n.editor !== "open") return s;
			setEntry(s, { ...n, editor: "owed-doc" });
			return s;
		}

		case "yjsUpdate": {
			s.docs.set(input.id, input.docState);
			s.touched.add(input.id);
			const n = s.notes.get(input.id);
			if (!n) return s;
			let next: NoteEntry = n;
			if (input.textQueued && n.unpublished) {
				next = { ...next, unpublished: undefined, needsInitialPublish: false, needsSnapshotPublish: false };
			}
			if (input.isFirstTextAck && n.firstTextPending) {
				next = { ...next, firstTextPending: false, needsInitialPublish: false, unpublished: undefined };
			}
			if (next.row?.deleted != null && env.crdt.outsideDeletion(next.row, input.docState)) {
				if (next.change?.t !== "restore" || next.change.base !== next.row.seq) {
					next = { ...next, change: { t: "restore", path: next.row.path, base: next.row.seq } };
				}
			}
			if (next !== n) setEntry(s, next);
			return s;
		}

		case "row": {
			const { row } = input;
			const docForFile = s.filesToDocs.get(row.file);
			if (docForFile && docForFile !== row.id) throw new Error("A note's file and document IDs must stay together");
			const existing = s.notes.get(row.id);
			if (existing && existing.file !== row.file) throw new Error("A note's file and document IDs must stay together");
			if (existing?.row && existing.row.seq >= row.seq) return s;

			let next: NoteEntry = existing ?? {
				id: row.id,
				file: row.file,
				editor: "closed",
			};
			next = { ...next, row };
			if (next.inFlight?.accepted !== undefined && next.inFlight.accepted <= row.seq) {
				const req = next.inFlight.req;
				const finishedAction = next.inFlight.action;
				const acceptedPath = next.inFlight.path;
				const wasChange = next.inFlight.change;
				s.forget.set(req, true);
				next.inFlight = undefined;
				if (finishedAction !== "del") next.basePath = acceptedPath;
				if (next.change && JSON.stringify(next.change) === JSON.stringify(wasChange)
					&& !(wasChange.t === "del" && finishedAction === "set")) {
					next.change = undefined;
				} else if (next.change?.t === "set" && finishedAction === "set") {
					next.change = { ...next.change, basePath: acceptedPath };
				}
			}
			const block = s.blocked.get(row.id);
			if (block && block.authority === row.id && block.seq !== row.seq) s.blocked.delete(row.id);

			if (row.deleted != null) {
				next.conflictOriginPath = undefined;
				const docState = s.docs.get(row.id);
				if (next.change?.t === "set" && next.change.legacyRestore && row.vector) {
					next.change = { t: "restore", path: next.change.path, base: row.seq };
				} else if (docState && env.crdt.outsideDeletion(row, docState)) {
					if (next.change?.t !== "restore" || next.change.base !== row.seq) {
						next.change = { t: "restore", path: row.path, base: row.seq };
					}
				}
			}
			setEntry(s, next);
			return s;
		}

		case "userRestore": {
			const n = s.notes.get(input.id);
			const docState = s.docs.get(input.id);
			if (!n?.row || n.row.deleted === null) return s;
			if (input.deletionSeq !== undefined && n.row.seq !== input.deletionSeq) return s;
			if (!docState || cachedText(env.crdt, docState) === undefined) return s;
			const target = input.path ?? n.row.path;
			const resolved = pickLiveRowPath(s, target, n.id, true);
			setEntry(s, {
				...n,
				change: { t: "restore", path: resolved, base: n.row.seq },
				needsSnapshotPublish: true,
				unpublished: { update: docState, isSnapshot: true },
			});
			return s;
		}

		case "answer": {
			const owner = [...s.notes.values()].find(n => n.inFlight?.req === input.req);
			if (!owner || !owner.inFlight || owner.inFlight.accepted !== undefined) return s;
			const p = owner.inFlight;
			s.forget.set(p.req, true);
			if (input.ok !== undefined) {
				// If the ordered Row stream already delivered seq >= ok, finish immediately instead of wedging inFlight.
				if (owner.row && owner.row.seq >= input.ok) {
					const next: NoteEntry = { ...owner, inFlight: undefined };
					if (p.action !== "del") next.basePath = p.path;
					if (next.change && JSON.stringify(next.change) === JSON.stringify(p.change)
						&& !(p.change.t === "del" && p.action === "set")) {
						next.change = undefined;
					} else if (next.change?.t === "set" && p.action === "set") {
						next.change = { ...next.change, basePath: p.path };
					}
					setEntry(s, next);
				} else {
					setEntry(s, { ...owner, inFlight: { ...p, accepted: input.ok } });
				}
				return s;
			}
			const refusedRow = input.refused?.row ?? null;
			if (refusedRow) {
				const docForFile = s.filesToDocs.get(refusedRow.file);
				if (docForFile && docForFile !== refusedRow.id) throw new Error("A note's file and document IDs must stay together");
			}
			let next: NoteEntry = { ...owner, inFlight: undefined };
			if (refusedRow && refusedRow.id === owner.id && (!owner.row || owner.row.seq < refusedRow.seq)) {
				next.row = refusedRow;
				if (refusedRow.deleted != null) next.conflictOriginPath = undefined;
			} else if (refusedRow && refusedRow.id !== owner.id) {
				// Record occupant row so next() sees the taken path and picks a conflict/(restored) suffix.
				const occupant = s.notes.get(refusedRow.id);
				if (!occupant || !occupant.row || occupant.row.seq < refusedRow.seq) {
					setEntry(s, { ...(occupant ?? { id: refusedRow.id, file: refusedRow.file, editor: "closed" }), row: refusedRow });
				}
			}
			if (next.change) {
				if (next.row?.deleted != null && next.change.t === "del") next.change = undefined;
				else if (next.change.t === "set" && next.row) {
					if (next.row.deleted !== null) next.change = { t: "restore", path: next.change.path, base: next.row.seq };
					else if (next.row.path === next.change.path) next.change = undefined;
					else next.change = { ...next.change, basePath: next.row.path };
				} else if (next.change.t === "restore" && (!next.row || next.row.deleted === null)) {
					next.change = undefined;
				}
			}
			setEntry(s, next);
			return s;
		}

		case "intentDone": {
			if (!s.intent || s.intent.id !== input.intent.id || s.intent.kind !== input.intent.kind || s.intent.path !== input.intent.path) {
				return s;
			}
			const op = s.intent;
			s.intent = undefined;
			const n = s.notes.get(op.id);
			if (!n) return s;
			if (op.kind === "write") {
				if (input.outcome === "applied" || input.outcome === "landed") {
					const writtenHash = input.after?.hash ?? n.intendedHash ?? env.hash(op.text);
					if (input.after) s.observed.set(op.path, input.after);
					const next: NoteEntry = {
						...n,
						diskPath: op.path,
						missing: undefined,
						forkedHash: undefined,
						held: false,
						baseState: n.intended ?? s.docs.get(op.id),
						baseStat: input.after ? { ...input.after.stat, hash: writtenHash } : n.baseStat,
						intended: undefined,
						intendedHash: undefined,
						editor: n.editor === "owed-doc" || n.editor === "owed-recover" ? "closed" : n.editor,
					};
					setEntry(s, next);
				} else {
					if (input.after) s.observed.set(op.path, input.after);
					else if (input.outcome === "preconditionFailed") s.observed.delete(op.path);
					if (input.outcome === "unreadable" || input.outcome === "caseClash") {
						blockNote(s, op.id, op.id, op.seq, [op.path]);
						if (input.outcome === "caseClash") s.pendingProblems.push([op.path, "Another note differs only by case on this device"]);
					}
					setEntry(s, { ...n, intended: undefined, intendedHash: undefined });
					if (
						input.outcome === "preconditionFailed" &&
						op.expectedHash === null &&
						input.after &&
						!input.after.unreadable &&
						input.after.text !== undefined &&
						!s.byPath.has(op.path)
					) {
						const obsHash = input.after.hash ?? env.hash(input.after.text);
						const newId = env.newId();
						const newFile = env.newId();
						const docState = env.crdt.create(input.after.text, env.clientId);
						s.docs.set(newId, docState);
						setEntry(s, {
							id: newId,
							file: newFile,
							diskPath: op.path,
							baseState: docState,
							baseStat: { ...input.after.stat, hash: obsHash },
							editor: "closed",
							firstTextPending: true,
							needsInitialPublish: true,
							unpublished: { update: docState },
							change: { t: "set", path: op.path },
						});
					}
				}
				return s;
			}
			if (op.kind === "move") {
				if (input.outcome === "applied" || input.outcome === "landed") {
					s.observed.delete(op.from);
					if (input.after) s.observed.set(op.path, input.after);
					let change = n.change;
					let conflictOriginPath = n.conflictOriginPath;
					if (op.park) {
						if (!n.row && change?.t === "set") change = { ...change, path: op.path };
						if (conflictOriginPath && op.path !== conflictOriginPath) conflictOriginPath = undefined;
					} else if (conflictOriginPath && op.path !== conflictOriginPath) {
						conflictOriginPath = undefined;
					}
					setEntry(s, { ...n, diskPath: op.path, missing: undefined, change, conflictOriginPath });
				} else {
					if (input.outcome === "unreadable" || input.outcome === "caseClash") {
						blockNote(s, op.id, op.id, op.seq, [op.from, op.path]);
						if (input.outcome === "caseClash") s.pendingProblems.push([op.path, "Another note differs only by case on this device"]);
					} else {
						s.touched.add(op.id);
					}
				}
				return s;
			}
			// remove
			if (input.outcome === "applied" || input.outcome === "landed") {
				s.observed.delete(op.path);
				setEntry(s, {
					...n,
					diskPath: undefined,
					missing: undefined,
					conflictOriginPath: undefined,
					forkedHash: undefined,
					held: false,
					baseState: undefined,
					baseStat: undefined,
					intended: undefined,
					intendedHash: undefined,
					change: n.change?.t === "del" ? undefined : n.change,
				});
			} else {
				if (input.after) s.observed.set(op.path, input.after);
				if (input.outcome === "unreadable" || input.outcome === "caseClash") {
					blockNote(s, op.id, op.id, op.seq, [op.path]);
				} else {
					s.touched.add(op.id);
				}
			}
			return s;
		}

		case "diskObs": {
			const isFullScan = input.event === "startup" || input.event === "settle";
			if (isFullScan) {
				s.listingComplete = input.listingComplete;
				s.fullScan = true;
				if (input.listingComplete) s.observed = new Map(input.files);
				else for (const [p, f] of input.files) s.observed.set(p, f);
				if (input.event === "startup" && input.listingComplete && s.intent) {
					settleStartupIntent(s, env);
				}
			} else {
				for (const [p, f] of input.files) s.observed.set(p, f);
				if (input.path && !input.files.has(input.path) && input.listingComplete) s.observed.delete(input.path);
				if (input.from && !input.files.has(input.from) && input.listingComplete) s.observed.delete(input.from);
				if (input.path) {
					const owner = s.byPath.get(input.path) ?? s.rowsByPath.get(input.path);
					if (owner) s.touched.add(owner);
				}
				if (input.from) {
					const owner = s.byPath.get(input.from) ?? s.rowsByPath.get(input.from);
					if (owner) s.touched.add(owner);
				}
				if (input.to) {
					const owner = s.byPath.get(input.to) ?? s.rowsByPath.get(input.to);
					if (owner) s.touched.add(owner);
				}
			}
			clearResolvedBlockers(s);

			// Handle explicit live rename before checking unknown/missing paths.
			if (input.event === "renamed" && input.from && input.to) {
				const id = s.byPath.get(input.from);
				const priorId = s.byPath.get(input.to);
				if (priorId && priorId !== id) {
					const prior = s.notes.get(priorId);
					if (prior) markMissingNote(s, prior, input.to, env);
				}
				if (id) {
					const n = s.notes.get(id)!;
					const resolvedOrigin = n.conflictOriginPath && input.to !== n.conflictOriginPath ? undefined : n.conflictOriginPath;
					setEntry(s, {
						...n,
						diskPath: input.to,
						missing: undefined,
						join: undefined,
						conflictOriginPath: resolvedOrigin,
						change: { t: "set", path: input.to, basePath: n.basePath },
					});
				}
			}

			// Clear missing & handle causal fingerprint-matched own-write confirmation on visible files.
			for (const [id, n] of [...s.notes]) {
				if (!n.diskPath) continue;
				const obs = s.observed.get(n.diskPath);
				if (!obs) continue;
				if (obs.unreadable) {
					blockNote(s, id, id, n.row?.seq ?? 0, [n.diskPath]);
					continue;
				}
				const obsHash = obs.hash ?? (obs.text !== undefined ? env.hash(obs.text) : undefined);
				if (obs.text !== undefined && obsHash !== undefined && n.intendedHash && obsHash === n.intendedHash) {
					// Causal fingerprint match of our own disk write (no TTL windows).
					if (s.intent?.id === id && s.intent.kind === "write") s.intent = undefined;
					setEntry(s, {
						...n,
						missing: undefined,
						forkedHash: undefined,
						held: false,
						baseState: n.intended ?? n.baseState,
						baseStat: { ...obs.stat, hash: obsHash },
						intended: undefined,
						intendedHash: undefined,
						editor: n.editor === "owed-doc" || n.editor === "owed-recover" ? "closed" : n.editor,
					});
				} else if (n.missing?.path === n.diskPath) {
					// File seen again (03fe617 fix).
					setEntry(s, { ...n, missing: undefined });
				}
			}

			// First-sync join vs new file creation for unowned readable paths.
			for (const [path, obs] of s.observed) {
				if (s.byPath.has(path)) continue;
				if (s.intent?.path === path) continue;
				if (obs.unreadable || obs.text === undefined) continue;
				const obsHash = obs.hash ?? env.hash(obs.text);
				if (input.event === "startup" && s.firstSync) {
					const rowId = s.rowsByPath.get(path);
					const rowNote = rowId ? s.notes.get(rowId) : undefined;
					if (rowNote && !rowNote.diskPath) {
						setEntry(s, { ...rowNote, join: { path, hash: obsHash } });
						continue;
					}
				}
				// Try join if firstSync candidate matches complete doc text.
				const rowId = s.rowsByPath.get(path);
				const rowNote = rowId ? s.notes.get(rowId) : undefined;
				if (s.firstSync && rowNote && !rowNote.diskPath) {
					const docText = cachedText(env.crdt, s.docs.get(rowNote.id));
					if (docText === undefined) {
						setEntry(s, { ...rowNote, join: { path, hash: obsHash } });
						continue;
					}
					if (docText === obs.text) {
						const docState = s.docs.get(rowNote.id)!;
						setEntry(s, {
							...rowNote,
							diskPath: path,
							basePath: path,
							baseState: docState,
							baseStat: { ...obs.stat, hash: obsHash },
							join: undefined,
							missing: undefined,
						});
						continue;
					}
				}
				// Spawn a new note for this unowned file (never guesses identity by path/content outside first-sync join).
				if (input.event === "changed" && input.path && input.path !== path) continue;
				if (input.event === "deleted") continue;
				const newId = env.newId();
				const newFile = env.newId();
				const docState = env.crdt.create(obs.text, env.clientId);
				s.docs.set(newId, docState);
				setEntry(s, {
					id: newId,
					file: newFile,
					diskPath: path,
					baseState: docState,
					baseStat: { ...obs.stat, hash: obsHash },
					editor: "closed",
					firstTextPending: true,
					needsInitialPublish: true,
					unpublished: { update: docState },
					change: { t: "set", path },
				});
			}

			// Clear leftover join markers once firstSync is over.
			if (!s.firstSync) {
				for (const n of [...s.notes.values()]) {
					if (n.join) setEntry(s, { ...n, join: undefined });
				}
			}

			// Missing owned files: only on explicit delete event (mayDelete !== false) or complete startup scan.
			if (s.listingComplete) {
				const checkDelete = (n: NoteEntry) => {
					if (!n.diskPath || n.intended || s.intent?.id === n.id || isDirty(s, n.diskPath)) return;
					if (s.observed.has(n.diskPath)) return;
					if (input.event === "startup" || (input.event === "deleted" && input.mayDelete !== false && input.path === n.diskPath)) {
						markMissingNote(s, n, n.diskPath, env);
					}
				};
				for (const n of [...s.notes.values()]) checkDelete(n);
			}
			return s;
		}
	}
}

export function next(prev: VaultNoteState, env: StepEnv): { state: VaultNoteState; actions: NoteAction[] } {
	const s = cloneState(prev);
	const actions: NoteAction[] = [];

	if (s.lastOpenResult) actions.push({ t: "openResult", ...s.lastOpenResult });
	for (const [p, m] of s.pendingProblems) actions.push({ t: "problem", path: p, message: m });
	s.lastOpenResult = undefined;
	s.pendingProblems = [];

	for (const req of s.forget.keys()) actions.push({ t: "forget", req });

	// Pass 1: Only inspect touched notes (or all notes on fullScan) and use cached text decoding.
	const visitIds = s.fullScan ? [...s.notes.keys()] : [...s.touched];
	s.touched.clear();
	s.fullScan = false;

	for (const id of visitIds) {
		let n = s.notes.get(id);
		if (!n) continue;

		if (n.join && !n.diskPath) {
			const obs = s.observed.get(n.join.path);
			const docState = s.docs.get(n.id);
			const docText = cachedText(env.crdt, docState);
			if (obs && !obs.unreadable && obs.text !== undefined && docText !== undefined) {
				if (docText === obs.text && !s.byPath.has(n.join.path)) {
					n = {
						...n,
						diskPath: n.join.path,
						basePath: n.row?.path ?? n.join.path,
						baseState: docState,
						baseStat: { ...obs.stat, hash: n.join.hash },
						join: undefined,
						missing: undefined,
					};
					setEntry(s, n);
				} else {
					const joinPath = n.join.path;
					n = { ...n, join: undefined };
					setEntry(s, n);
					// Did not match: spawn the pre-existing file as its own note if still unowned.
					if (!s.byPath.has(joinPath) && s.intent?.path !== joinPath) {
						const newId = env.newId();
						const newFile = env.newId();
						const createdDoc = env.crdt.create(obs.text, env.clientId);
						s.docs.set(newId, createdDoc);
						setEntry(s, {
							id: newId,
							file: newFile,
							diskPath: joinPath,
							baseState: createdDoc,
							baseStat: { ...obs.stat, hash: n.join?.hash ?? env.hash(obs.text) },
							editor: "closed",
							firstTextPending: true,
							unpublished: { update: createdDoc },
							change: { t: "set", path: joinPath },
						});
						actions.push({ t: "yjsMerge", id: newId, update: createdDoc, agreement: createdDoc, isInitial: true });
					}
				}
			}
		}

		if (n.needsInitialPublish) {
			const docState = s.docs.get(n.id);
			if (docState) {
				actions.push({ t: "yjsMerge", id: n.id, update: docState, agreement: docState, isInitial: true });
				n = { ...n, needsInitialPublish: false };
				setEntry(s, n);
			}
		}

		if (n.needsSnapshotPublish) {
			const docState = s.docs.get(n.id);
			if (docState) {
				actions.push({ t: "yjsMerge", id: n.id, update: docState, agreement: docState, isSnapshot: true });
				n = { ...n, needsSnapshotPublish: false };
				setEntry(s, n);
			}
		}

		if (n.editor === "owed-doc" && n.missing) {
			const dropChange = n.row?.deleted != null && !n.inFlight;
			n = {
				...n,
				diskPath: undefined,
				missing: undefined,
				conflictOriginPath: undefined,
				forkedHash: undefined,
				held: false,
				change: dropChange ? undefined : { t: "del", path: n.missing.path, snapshot: n.missing.snapshot },
			};
			setEntry(s, n);
		}

		const docState = s.docs.get(n.id);
		const docText = cachedText(env.crdt, docState);

		if (n.row?.deleted != null) {
			if (docState && env.crdt.outsideDeletion(n.row, docState)) {
				if (n.change?.t !== "restore" || n.change.base !== n.row.seq) {
					n = { ...n, change: { t: "restore", path: n.row.path, base: n.row.seq } };
					setEntry(s, n);
				}
			} else if (n.editor === "open") {
				actions.push({ t: "closeEditor", id: n.id });
			}
		}

		if (n.held && !hasUnresolvedConflict(s, n.id)) {
			n = { ...n, held: false };
			s.emittedNotices.delete("held:" + n.id);
			setEntry(s, n);
		}

		if (n.diskPath && n.editor !== "open" && !isDirty(s, n.diskPath) && !s.blocked.has(n.id)) {
			const obs = s.observed.get(n.diskPath);
			if (obs && !obs.unreadable && obs.text !== undefined && docState && docText !== undefined) {
				const diskText = obs.text;
				const diskHash = obs.hash ?? env.hash(diskText);
				if (n.forkedHash !== undefined && diskHash === n.forkedHash) {
					// Already preserved in conflict copy; wait for P4 write to overwrite diskPath.
				} else if (diskText === docText) {
					const changedBase = !env.crdt.sameDocState(n.baseState, docState) || n.intended !== undefined || n.held || n.forkedHash !== undefined;
					if (changedBase || n.editor !== "closed") {
						s.emittedNotices.delete("held:" + n.id);
						n = {
							...n,
							baseState: docState,
							baseStat: { ...obs.stat, hash: diskHash },
							intended: undefined,
							intendedHash: undefined,
							forkedHash: undefined,
							held: false,
							editor: "closed",
						};
						setEntry(s, n);
					}
				} else {
					const intendedText = cachedText(env.crdt, n.intended);
					const baseText = cachedText(env.crdt, n.baseState);
					if (n.intended !== undefined) {
						if (intendedText !== undefined && diskText === intendedText) {
							n = {
								...n,
								baseState: n.intended,
								baseStat: { ...obs.stat, hash: diskHash },
								intended: undefined,
								intendedHash: undefined,
								forkedHash: undefined,
							};
							setEntry(s, n);
						} else if ((n.editor === "owed-doc" || n.editor === "owed-recover") && env.crdt.onlyInserts(diskText, docText)) {
							// Stale editor flush already contained in docText: let P4 write overwrite without forking.
						} else if (baseText === undefined || diskText !== baseText) {
							n = handleConflictOrHold(s, n, n.diskPath, diskText, diskHash, obs.stat, env, actions);
						}
					// No `intended`: check unchanged base, stale editor save, single-sided diff, or conflict/recovery fork.
					} else if (baseText !== undefined && diskText === baseText) {
						// Unchanged local disk vs newer remote doc: eligible for P4 write (unless held).
					} else if ((n.editor === "owed-doc" || n.editor === "owed-recover") && env.crdt.onlyInserts(diskText, docText)) {
						// Stale editor flush already contained in docText: P4 write overwrites without a spurious recovery copy.
					} else if (
						n.baseState !== undefined &&
						n.editor === "closed" &&
						env.crdt.sameDocState(docState, n.baseState)
					) {
						// Single-sided diff onto unchanged base -> exact diskText.
						const { update, agreement } = env.crdt.applyToUnchangedBase(n.baseState, diskText, env.clientId);
						s.docs.set(n.id, agreement);
						n = {
							...n,
							baseState: agreement,
							baseStat: { ...obs.stat, hash: diskHash },
							unpublished: { update },
						};
						setEntry(s, n);
						actions.push({ t: "yjsMerge", id: n.id, update, agreement });
					} else {
						// Concurrent remote doc edit, missing base, or owed-* unrecorded disk save -> never diff-merge.
						n = handleConflictOrHold(s, n, n.diskPath, diskText, diskHash, obs.stat, env, actions);
					}
				}
			}
		}
	}
	s.touched.clear();

	// Pass 2: Evaluate deletion brake against exact pending deletion IDs.
	// Known limit: deletions made one by one while the app runs don't trip the brake (catching that would need a time window).
	const pendingDeleteIds: string[] = [];
	const incomingRemoveIds: string[] = [];
	let totalLiveFiles = env.attachmentTotalLive ?? 0;

	for (const n of s.notes.values()) {
		if (n.row?.deleted == null || n.diskPath !== undefined) totalLiveFiles++;
		if (n.change?.t === "del" && !n.inFlight) pendingDeleteIds.push(n.id);
		if (n.row?.deleted != null && n.diskPath && !s.blocked.has(n.id)) {
			const docState = s.docs.get(n.id);
			if (!docState || !env.crdt.outsideDeletion(n.row, docState)) incomingRemoveIds.push(n.id);
		}
	}

	const allDeleteIds = [...pendingDeleteIds, ...incomingRemoveIds];
	const approvedSet = new Set(s.brakePaused?.approvedIds ?? []);
	const declinedSet = new Set(s.brakePaused?.declinedIds ?? []);
	// Stickily ignore incoming removals that were already declined by the owner.
	const activeDeclinedIds = incomingRemoveIds.filter(id => declinedSet.has(id));
	const unapprovedDeleteIds = allDeleteIds.filter(id => !approvedSet.has(id) && !(s.brakePaused?.declined && declinedSet.has(id)));
	const unapprovedCount = unapprovedDeleteIds.length + (env.attachmentPendingDeletes ?? 0);
	const brakeCfg = env.brake ?? DEFAULT_BRAKE;
	const exceeds = unapprovedCount > brakeCfg.minCount && unapprovedCount > brakeCfg.minFraction * Math.max(1, totalLiveFiles);

	if (exceeds) {
		s.brakePaused = {
			count: unapprovedCount,
			approvedIds: s.brakePaused?.approvedIds?.filter(id => allDeleteIds.includes(id)),
			declined: s.brakePaused?.declined,
			declinedIds: activeDeclinedIds.length ? activeDeclinedIds : undefined,
		};
		const brakeNoticeKey = `brake:${unapprovedCount}`;
		if (!s.emittedNotices.has(brakeNoticeKey)) {
			s.emittedNotices.add(brakeNoticeKey);
			actions.push({
				t: "massChangeBrake",
				count: unapprovedCount,
				message: `This would delete ${unapprovedCount} files. Continue?`,
			});
		}
		return { state: s, actions };
	}

	// Prune completed approvals & declined IDs; emit deduped notice when incoming removals remain held.
	if (s.brakePaused?.declined && activeDeclinedIds.length > 0) {
		s.brakePaused = {
			count: activeDeclinedIds.length,
			declined: true,
			declinedIds: activeDeclinedIds,
			approvedIds: s.brakePaused.approvedIds?.filter(id => allDeleteIds.includes(id)),
		};
		const heldKey = `declined:${activeDeclinedIds.length}`;
		if (!s.emittedNotices.has(heldKey)) {
			s.emittedNotices.add(heldKey);
			actions.push({
				t: "problem",
				path: "",
				message: `${activeDeclinedIds.length} deleted files held on this device; approve to remove them`,
			});
		}
	} else {
		const remainingApproved = s.brakePaused?.approvedIds?.filter(id => allDeleteIds.includes(id)) ?? [];
		if (remainingApproved.length > 0) {
			s.brakePaused = { count: remainingApproved.length, approvedIds: remainingApproved };
		} else {
			s.brakePaused = undefined;
		}
	}

	// Emit Worker requests (unless paused by brake above).
	for (const n of [...s.notes.values()]) {
		if (!n.change || n.inFlight || n.firstTextPending) continue;
		const change = n.change;
		if (isDirty(s, change.path)) continue;
		if (change.t === "set" && n.row && (n.row.deleted !== null || n.row.path === change.path || n.row.path !== change.basePath)) {
			setEntry(s, { ...n, change: undefined });
			continue;
		}
		if (change.t === "restore" && (!n.row || n.row.deleted === null || n.row.seq !== change.base)) {
			setEntry(s, { ...n, change: undefined });
			continue;
		}
		if (change.t === "del" && n.row && n.row.deleted !== null) {
			setEntry(s, { ...n, change: undefined });
			continue;
		}
		const action: NoteStructure["t"] = n.row ? change.t : "set";
		const path = action === "del" ? n.row!.path : pickLiveRowPath(s, change.path, n.id, action === "restore");
		const resolvedChange: NoteStructure = action === "del" ? change : { ...change, path };
		const request: NoteRequest = {
			req: env.newId(),
			file: n.file,
			base: n.row?.seq ?? null,
			action,
			path,
			change: resolvedChange,
		};
		setEntry(s, { ...n, change: resolvedChange, inFlight: request });
		actions.push({ t: "workerReq", id: n.id, request });
	}

	// Pass 3: Select at most one vault DiskIntent (only once disk listing is known after startup/scan).
	if (!s.intent && s.listingComplete) {
		const intent = pickNextDiskIntent(s, env);
		if (intent) {
			if (intent.kind === "write") {
				const n = s.notes.get(intent.id)!;
				const docState = s.docs.get(intent.id)!;
				setEntry(s, { ...n, intended: docState, intendedHash: env.hash(intent.text) });
			}
			s.intent = intent;
			actions.push({ t: "diskIntent", intent });
		}
	}

	return { state: s, actions };
}

function handleConflictOrHold(
	s: VaultNoteState,
	n: NoteEntry,
	diskPath: string,
	diskText: string,
	diskHash: string,
	stat: DiskFile,
	env: StepEnv,
	actions: NoteAction[],
): NoteEntry {
	if (hasUnresolvedConflict(s, n.id)) {
		if (s.intent?.id === n.id && s.intent.kind === "write") s.intent = undefined;
		if (!n.held) {
			const heldEntry: NoteEntry = { ...n, held: true, forkedHash: undefined, intended: undefined, intendedHash: undefined };
			setEntry(s, heldEntry);
			const heldKey = "held:" + n.id;
			if (!s.emittedNotices.has(heldKey)) {
				s.emittedNotices.add(heldKey);
				actions.push({
					t: "problem",
					path: diskPath,
					message: `${diskPath} has an unresolved conflict copy; resolve it to keep syncing this note's outside edits`,
				});
			}
			return heldEntry;
		}
		return n;
	}
	const recovered = n.editor === "owed-doc" || n.editor === "owed-recover";
	const copyPath = pickCopyPath(s, diskPath, n.id, recovered);
	const copyId = env.newId();
	const copyFile = env.newId();
	const copyDoc = env.crdt.create(diskText, env.clientId);
	s.docs.set(copyId, copyDoc);
	const copyEntry: NoteEntry = {
		id: copyId,
		file: copyFile,
		baseState: copyDoc,
		baseStat: { ...stat, hash: diskHash },
		editor: "closed",
		copyOf: n.id,
		conflictOriginPath: copyPath,
		firstTextPending: true,
		unpublished: { update: copyDoc },
		change: { t: "set", path: copyPath },
	};
	setEntry(s, copyEntry);
	actions.push({ t: "yjsMerge", id: copyId, update: copyDoc, agreement: copyDoc, isInitial: true });

	const updatedOriginal: NoteEntry = {
		...n,
		editor: "owed-doc",
		forkedHash: diskHash,
		intended: undefined,
		intendedHash: undefined,
	};
	setEntry(s, updatedOriginal);
	return updatedOriginal;
}

function pickNextDiskIntent(s: VaultNoteState, env: StepEnv): NoteIntent | undefined {
	const sorted = [...s.notes.values()].sort((a, b) => a.id.localeCompare(b.id));

	const declinedIncoming = new Set(s.brakePaused?.declined ? (s.brakePaused.declinedIds ?? []) : []);

	// P1: Remove live disk files for confirmed tombstones (held when brake declined).
	for (const n of sorted) {
		if (declinedIncoming.has(n.id)) continue;
		if (!n.diskPath || n.editor === "open" || s.blocked.has(n.id) || isDirty(s, n.diskPath)) continue;
		if (n.row?.deleted == null) continue;
		const docState = s.docs.get(n.id);
		if (docState && env.crdt.outsideDeletion(n.row, docState)) continue;
		const obs = s.observed.get(n.diskPath);
		if (!obs || obs.unreadable || obs.text === undefined) continue;
		const expectedHash = obs.hash ?? env.hash(obs.text);
		// Destruction choke point: remove only if exact text is stored in baseState, docState, or preserved forkedHash.
		const storedBase = cachedText(env.crdt, n.baseState);
		const storedDoc = cachedText(env.crdt, docState);
		if (obs.text !== storedBase && obs.text !== storedDoc && !(n.forkedHash !== undefined && expectedHash === n.forkedHash)) continue;
		return { kind: "remove", id: n.id, path: n.diskPath, expectedHash, seq: n.row.seq };
	}

	// P2: Move placed files whose desired path moved to a free path (run before vacating occupants).
	for (const n of sorted) {
		if (!n.diskPath || n.editor === "open" || s.blocked.has(n.id) || n.row?.deleted != null) continue;
		const want = desiredPath(n);
		if (!want || want === n.diskPath) continue;
		if (isDirty(s, n.diskPath) || isDirty(s, want)) continue;
		if (s.byPath.has(want) || s.observed.has(want) || caseClashPath(s, want)) continue;
		const obs = s.observed.get(n.diskPath);
		if (!obs || obs.unreadable || obs.text === undefined) continue;
		return {
			kind: "move",
			id: n.id,
			from: n.diskPath,
			path: want,
			expectedHash: obs.hash ?? env.hash(obs.text),
			seq: n.row?.seq ?? 0,
		};
	}

	// P3: Vacate occupied destinations / break rename cycles when destination is held by another closed note.
	for (const n of sorted) {
		if (s.blocked.has(n.id) || n.row?.deleted != null) continue;
		const want = desiredPath(n);
		if (!want || n.diskPath === want) continue;
		if (isDirty(s, want)) continue;
		const clash = caseClashPath(s, want);
		if (clash) {
			blockNote(s, n.id, n.id, n.row?.seq ?? 0, [want, clash]);
			s.pendingProblems.push([want, "Another note differs only by case on this device"]);
			continue;
		}
		const ownerId = s.byPath.get(want);
		if (ownerId && ownerId !== n.id) {
			const owner = s.notes.get(ownerId)!;
			if (owner.editor === "open" || s.blocked.has(ownerId) || isDirty(s, want)) continue;
			if (owner.row?.deleted === null && owner.row.path === want) continue;
			const obs = s.observed.get(want);
			if (!obs || obs.unreadable || obs.text === undefined) continue;
			const parkPath = pickCopyPath(s, want, ownerId, false);
			if (isDirty(s, parkPath) || s.observed.has(parkPath)) continue;
			return {
				kind: "move",
				id: ownerId,
				from: want,
				path: parkPath,
				expectedHash: obs.hash ?? env.hash(obs.text),
				seq: owner.row?.seq ?? 0,
				park: true,
			};
		}
	}

	// P4: Write (materialize conflict/recovered copies first, then first placements and content syncs).
	const writeOrder = [
		...sorted.filter(n => n.copyOf !== undefined),
		...sorted.filter(n => n.copyOf === undefined),
	];
	for (const n of writeOrder) {
		if (n.editor === "open" || n.held || s.blocked.has(n.id) || n.row?.deleted != null) continue;
		if (n.inFlight && !n.diskPath) continue; // unplaced local create waits for row/text gating if needed
		const want = desiredPath(n);
		if (!want || isDirty(s, want)) continue;
		if (!n.diskPath && (s.byPath.has(want) || s.observed.has(want) || caseClashPath(s, want))) continue;
		if (n.diskPath && n.diskPath !== want) continue;
		const docState = s.docs.get(n.id);
		const docText = cachedText(env.crdt, docState);
		if (docText === undefined) continue;
		const obs = s.observed.get(want);
		if (obs?.unreadable) continue;
		if (obs?.text === docText) continue;
		// Destruction choke point: overwrite only when disk text is already stored (baseState, intended, docState,
		// preserved forkedHash, or a stale editor flush strictly contained in docText).
		let expectedHash: string | null = null;
		if (obs) {
			if (obs.text === undefined) continue;
			const obsHash = obs.hash ?? env.hash(obs.text);
			const baseText = cachedText(env.crdt, n.baseState);
			const intendedText = cachedText(env.crdt, n.intended);
			const staleEditorFlush =
				(n.editor === "owed-doc" || n.editor === "owed-recover") &&
				env.crdt.onlyInserts(obs.text, docText);
			const safeToOverwrite =
				(baseText !== undefined && obs.text === baseText) ||
				(intendedText !== undefined && obs.text === intendedText) ||
				(n.forkedHash !== undefined && obsHash === n.forkedHash) ||
				staleEditorFlush;
			if (!safeToOverwrite) continue;
			expectedHash = obsHash;
		}
		return { kind: "write", id: n.id, path: want, text: docText, expectedHash, seq: n.row?.seq ?? 0 };
	}

	return undefined;
}

export function step(state: VaultNoteState, input: NoteInput, env: StepEnv): { state: VaultNoteState; actions: NoteAction[] } {
	return next(apply(state, input, env), env);
}

// --- Durable Store Wrapper (parallel to TableDevice in device.ts) ---

const NOTE_META_KEY = "table/note-meta";
const NOTE_STATE_PREFIX = "table/note-state/";
const PRERELEASE_PREFIXES = [
	"table/note-change/",
	"table/note-move/",
	"table/note-remove/",
	"table/note-join/",
	"table/note-write/",
	"table/note-request/",
	"table/note-forget/",
	"table/note-file/",
	"table/note/",
];

interface PersistedNoteMeta {
	firstSync: boolean;
	noteAuthority: boolean;
	intent?: NoteIntent;
	forget: [string, true][];
	blocked?: [string, NoteBlocked][];
	brakePaused?: BrakeState;
}

export class NoteDevice {
	private queue: Promise<unknown> = Promise.resolve();
	private commits = 0;
	get revision() { return this.commits; }
	private constructor(private readonly store: Store, private state: VaultNoteState) {}

	static async open(store: Store): Promise<NoteDevice> {
		const entries = await store.list<NoteEntry>(NOTE_STATE_PREFIX);
		const meta = await store.get<PersistedNoteMeta>(NOTE_META_KEY);
		if (!entries.length && !meta) {
			if (await store.get("table/note-authority")) {
				throw new Error("Pre-release table note state detected; reset vault sync data required");
			}
			for (const prefix of PRERELEASE_PREFIXES) {
				if ((await store.list(prefix)).length) {
					throw new Error("Pre-release table note state detected; reset vault sync data required");
				}
			}
		}
		const state = emptyVaultNoteState(meta?.firstSync ?? false);
		if (meta) {
			state.noteAuthority = meta.noteAuthority;
			state.intent = meta.intent;
			state.brakePaused = meta.brakePaused;
			state.forget = new Map(meta.forget);
			if (meta.blocked) state.blocked = new Map(meta.blocked);
		}
		for (const [k, entry] of entries) {
			const id = k.slice(NOTE_STATE_PREFIX.length);
			setEntry(state, { ...entry, id });
			const doc = await store.get<Uint8Array>("state:" + id);
			if (doc) state.docs.set(id, doc);
		}
		state.fullScan = true;
		checkNoteInvariants(state);
		return new NoteDevice(store, state);
	}

	snapshot(): VaultNoteState { return this.state; }

	dispatch(
		input: NoteInput,
		env: StepEnv,
		onOutbox?: (puts: Map<string, unknown>, id: string, update: Uint8Array, isSnapshot: boolean) => void,
	): Promise<{ state: VaultNoteState; actions: NoteAction[] }> {
		const work = this.queue.then(async () => {
			const before = this.state;
			const result = step(before, input, env);
			const after = result.state;
			checkNoteInvariants(after);

			const puts = new Map<string, unknown>();
			const deletes: string[] = [];
			for (const act of result.actions) {
				if (act.t === "yjsMerge") {
					puts.set("state:" + act.id, after.docs.get(act.id) ?? act.agreement);
					if (onOutbox) {
						onOutbox(puts, act.id, act.update, !!act.isSnapshot);
						const n = after.notes.get(act.id);
						if (n?.unpublished) setEntry(after, { ...n, unpublished: undefined });
					}
				}
			}
			for (const [id, entry] of after.notes) {
				if (before.notes.get(id) !== entry) puts.set(NOTE_STATE_PREFIX + id, entry);
			}
			for (const id of before.notes.keys()) {
				if (!after.notes.has(id)) deletes.push(NOTE_STATE_PREFIX + id);
			}
			const metaChanged =
				before.firstSync !== after.firstSync ||
				before.noteAuthority !== after.noteAuthority ||
				before.intent !== after.intent ||
				before.brakePaused !== after.brakePaused ||
				before.blocked.size !== after.blocked.size ||
				[...after.blocked.entries()].some(([k, v]) => before.blocked.get(k) !== v) ||
				before.forget.size !== after.forget.size ||
				[...after.forget.keys()].some(k => !before.forget.has(k));
			if (metaChanged) {
				const meta: PersistedNoteMeta = {
					firstSync: after.firstSync,
					noteAuthority: after.noteAuthority,
					intent: after.intent,
					forget: [...after.forget.entries()],
					blocked: [...after.blocked.entries()],
					brakePaused: after.brakePaused,
				};
				puts.set(NOTE_META_KEY, meta);
			}
			if (puts.size || deletes.length) {
				await this.store.commit(puts, deletes);
				this.commits++;
			}
			this.state = after;
			return result;
		});
		this.queue = work.catch(() => {});
		return work;
	}
}
