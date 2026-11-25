import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import {
	NoteDevice,
	checkNoteInvariants,
	emptyVaultNoteState,
	hasUnresolvedConflict,
	step,
	yjsTextCrdt,
	type DiskObsFile,
	type NoteAction,
	type NoteInput,
	type StepEnv,
	type VaultNoteState,
} from "../src/core/table/notePlanner";
import type { NoteRow } from "../src/core/table/notes";
import { Memory } from "./table-sim";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function makeEnv(seed = 1, overrides: Partial<StepEnv> = {}): StepEnv {
	let n = seed;
	return {
		crdt: yjsTextCrdt,
		clientId: 100 + seed,
		newId: () => (++n).toString(16).padStart(32, "0"),
		hash: sha,
		...overrides,
	};
}

const obsFile = (path: string, text: string, mtime = 1): DiskObsFile => ({
	stat: { path, size: Buffer.byteLength(text), mtime },
	text,
	hash: sha(text),
});

function runStep(state: VaultNoteState, input: NoteInput, env: StepEnv) {
	const res = step(state, input, env);
	checkNoteInvariants(res.state);
	return res;
}

test("order independence: row before text and text before row both trigger first placement", () => {
	const env = makeEnv(1);
	const row: NoteRow = { kind: "note", id: "aa".repeat(16), file: "bb".repeat(16), path: "a.md", seq: 1, deleted: null };
	const doc = env.crdt.create("hello", 7);

	// Order 1: row then text
	let r1 = runStep(emptyVaultNoteState(), { t: "row", row }, env);
	assert.equal(r1.actions.filter(a => a.t === "diskIntent").length, 0);
	r1 = runStep(r1.state, { t: "yjsUpdate", id: row.id, docState: doc }, env);
	const intent1 = r1.actions.find(a => a.t === "diskIntent");
	assert.equal(intent1?.t, "diskIntent");
	if (intent1?.t === "diskIntent") {
		assert.equal(intent1.intent.kind, "write");
		assert.equal(intent1.intent.path, "a.md");
		assert.equal(intent1.intent.expectedHash, null);
	}

	// Order 2: text then row
	let r2 = runStep(emptyVaultNoteState(), { t: "yjsUpdate", id: row.id, docState: doc }, env);
	assert.equal(r2.actions.filter(a => a.t === "diskIntent").length, 0);
	r2 = runStep(r2.state, { t: "row", row }, env);
	const intent2 = r2.actions.find(a => a.t === "diskIntent");
	assert.equal(intent2?.t, "diskIntent");
	if (intent2?.t === "diskIntent") {
		assert.equal(intent2.intent.kind, "write");
		assert.equal(intent2.intent.path, "a.md");
	}
});

test("firstTextPending gates WorkerReq(set) until first text ack, and fingerprint confirms own write", () => {
	const env = makeEnv(10);
	let s = emptyVaultNoteState();
	let res = runStep(s, {
		t: "diskObs",
		event: "changed",
		path: "note.md",
		listingComplete: true,
		files: new Map([["note.md", obsFile("note.md", "v1")]]),
	}, env);
	s = res.state;
	assert.equal(res.actions.some(a => a.t === "workerReq"), false, "must wait for first text ack");
	const note = [...s.notes.values()][0]!;
	assert.equal(note.firstTextPending, true);

	// First text ack arrives -> WorkerReq(set) emitted
	res = runStep(s, { t: "yjsUpdate", id: note.id, docState: s.docs.get(note.id)!, isFirstTextAck: true }, env);
	s = res.state;
	const req = res.actions.find(a => a.t === "workerReq");
	assert.equal(req?.t, "workerReq");

	// Confirm remote edit writes to disk, then DiskObs with matching intendedHash confirms causally
	const docV2 = env.crdt.create("v2", 99);
	res = runStep(s, { t: "yjsUpdate", id: note.id, docState: docV2 }, env);
	s = res.state;
	const writeAct = res.actions.find(a => a.t === "diskIntent");
	assert.equal(writeAct?.t, "diskIntent");
	assert.equal(s.notes.get(note.id)?.intendedHash, sha("v2"));

	res = runStep(s, {
		t: "diskObs",
		event: "changed",
		path: "note.md",
		listingComplete: true,
		files: new Map([["note.md", obsFile("note.md", "v2", 2)]]),
	}, env);
	s = res.state;
	assert.equal(s.notes.get(note.id)?.intended, undefined);
	assert.equal(s.notes.get(note.id)?.intendedHash, undefined);
	assert.equal(env.crdt.completeText(s.notes.get(note.id)?.baseState), "v2");
});

test("closed-file edit: single-sided diff merges onto unchanged base; concurrent remote edit forks once and holds", () => {
	const env = makeEnv(20);
	const id = "11".repeat(16), file = "22".repeat(16);
	const base = env.crdt.create("alpha beta", 1);
	let s = emptyVaultNoteState();
	s = runStep(s, { t: "row", row: { kind: "note", id, file, path: "n.md", seq: 1, deleted: null } }, env).state;
	s = runStep(s, { t: "yjsUpdate", id, docState: base }, env).state;
	const write1 = s.intent!;
	s = runStep(s, { t: "intentDone", intent: write1, outcome: "applied", after: obsFile("n.md", "alpha beta", 1) }, env).state;

	// 1) Single-sided closed-file edit (docState == baseState): merges exact disk text
	let res = runStep(s, {
		t: "diskObs",
		event: "changed",
		path: "n.md",
		listingComplete: true,
		files: new Map([["n.md", obsFile("n.md", "alpha gamma beta", 2)]]),
	}, env);
	s = res.state;
	const mergeAct = res.actions.find(a => a.t === "yjsMerge");
	assert.ok(mergeAct && mergeAct.t === "yjsMerge");
	assert.equal(env.crdt.completeText(s.docs.get(id)), "alpha gamma beta");
	assert.equal(hasUnresolvedConflict(s, id), false);

	// 2) Concurrent remote doc edit + closed-file edit -> never diff-merges; forks one conflict copy with copyOf
	const remoteDoc = env.crdt.applyToUnchangedBase(s.docs.get(id)!, "alpha gamma beta remote", 2).agreement;
	s = runStep(s, { t: "yjsUpdate", id, docState: remoteDoc }, env).state;
	// Clear the write intent by pretending disk didn't update yet and user edited disk concurrently
	s = runStep(s, {
		t: "intentDone",
		intent: s.intent!,
		outcome: "preconditionFailed",
		after: obsFile("n.md", "alpha gamma beta local", 3),
	}, env).state;
	res = runStep(s, {
		t: "diskObs",
		event: "changed",
		path: "n.md",
		listingComplete: true,
		files: new Map([["n.md", obsFile("n.md", "alpha gamma beta local", 4)]]),
	}, env);
	s = res.state;

	assert.equal(hasUnresolvedConflict(s, id), true);
	const copies = [...s.notes.values()].filter(n => n.copyOf === id);
	assert.equal(copies.length, 1);
	const copy = copies[0]!;
	assert.equal(env.crdt.completeText(s.docs.get(copy.id)), "alpha gamma beta local");
	assert.match(copy.conflictOriginPath!, /\(conflict [0-9a-f]{6}\)\.md$/);
	// Conflict copy is written first, then original is rewritten to remoteDoc
	assert.equal(s.intent?.kind, "write");
	assert.equal(s.intent?.id, copy.id);
	res = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile(copy.conflictOriginPath!, "alpha gamma beta local", 5) }, env);
	s = res.state;
	assert.equal(s.intent?.kind, "write");
	assert.equal(s.intent?.id, id);
	res = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile("n.md", "alpha gamma beta remote", 6) }, env);
	s = res.state;
	assert.equal(s.notes.get(id)?.editor, "closed");

	// 3) Second clash while first conflict copy is unresolved -> held, NO second fork, disk never overwritten, live typing syncs
	const remote2 = env.crdt.applyToUnchangedBase(s.docs.get(id)!, "alpha gamma beta remote 2", 2).agreement;
	s = runStep(s, { t: "yjsUpdate", id, docState: remote2 }, env).state;
	s = runStep(s, {
		t: "intentDone",
		intent: s.intent!,
		outcome: "preconditionFailed",
		after: obsFile("n.md", "outside edit 2", 7),
	}, env).state;
	res = runStep(s, {
		t: "diskObs",
		event: "changed",
		path: "n.md",
		listingComplete: true,
		files: new Map([
			["n.md", obsFile("n.md", "outside edit 2", 8)],
			[copy.conflictOriginPath!, obsFile(copy.conflictOriginPath!, "alpha gamma beta local", 5)],
		]),
	}, env);
	s = res.state;
	assert.equal([...s.notes.values()].filter(n => n.copyOf === id).length, 1, "one-copy cap stops conflict storm");
	assert.equal(s.notes.get(id)?.held, true);
	assert.equal(s.intent, undefined, "held note disk file is never overwritten");
	assert.ok(res.actions.some(a => a.t === "problem" && /unresolved conflict copy/.test(a.message)));

	// Live typing (YjsUpdate) still accepted while held
	const remote3 = env.crdt.applyToUnchangedBase(s.docs.get(id)!, "alpha gamma beta remote 3", 2).agreement;
	s = runStep(s, { t: "yjsUpdate", id, docState: remote3 }, env).state;
	assert.equal(env.crdt.completeText(s.docs.get(id)), "alpha gamma beta remote 3");
	assert.equal(s.intent, undefined, "still held until conflict copy is resolved");

	// Resolving conflict copy (renaming it away) clears held and reconciles held disk text -> creates 2nd copy for held edit
	res = runStep(s, {
		t: "diskObs",
		event: "renamed",
		from: copy.conflictOriginPath!,
		to: "resolved-copy.md",
		listingComplete: true,
		files: new Map([
			["n.md", obsFile("n.md", "outside edit 2", 8)],
			["resolved-copy.md", obsFile("resolved-copy.md", "alpha gamma beta local", 5)],
		]),
	}, env);
	s = res.state;
	assert.equal(s.notes.get(id)?.held, false);
	const allCopies = [...s.notes.values()].filter(n => n.copyOf === id);
	assert.equal(allCopies.length, 2, "now freed to preserve the held edit");
	const secondCopy = allCopies.find(c => c.id !== copy.id)!;
	assert.equal(env.crdt.completeText(s.docs.get(secondCopy.id)), "outside edit 2");
});

test("editor open blocks writes, preserves delete snapshot across close, and clears missing if file reappears", () => {
	const env = makeEnv(40);
	const id = "33".repeat(16), file = "44".repeat(16);
	const base = env.crdt.create("start", 1);
	let s = emptyVaultNoteState();
	s = runStep(s, { t: "row", row: { kind: "note", id, file, path: "e.md", seq: 1, deleted: null } }, env).state;
	s = runStep(s, { t: "yjsUpdate", id, docState: base }, env).state;
	s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile("e.md", "start", 1) }, env).state;

	// EditorOpen refused if path dirty
	s = runStep(s, { t: "pathDirty", path: "e.md", delta: 1 }, env).state;
	let res = runStep(s, { t: "editorOpen", id }, env);
	assert.deepEqual(res.actions.find(a => a.t === "openResult"), { t: "openResult", id, allowed: false });
	s = runStep(res.state, { t: "pathDirty", path: "e.md", delta: -1 }, env).state;

	// EditorOpen allowed once settled
	res = runStep(s, { t: "editorOpen", id }, env);
	s = res.state;
	assert.deepEqual(res.actions.find(a => a.t === "openResult"), { t: "openResult", id, allowed: true });

	// Remote update while open never emits a disk write
	const edited = env.crdt.applyToUnchangedBase(base, "start typed", 2).agreement;
	res = runStep(s, { t: "yjsUpdate", id, docState: edited }, env);
	s = res.state;
	assert.equal(res.actions.some(a => a.t === "diskIntent"), false);

	// Delete event while open records missing with open doc snapshot, does not send del yet
	res = runStep(s, { t: "diskObs", event: "deleted", path: "e.md", mayDelete: true, listingComplete: true, files: new Map() }, env);
	s = res.state;
	assert.ok(s.notes.get(id)?.missing?.snapshot);
	assert.equal(s.notes.get(id)?.change, undefined);

	// If file reappears before close (03fe617 fix), missing clears
	res = runStep(s, {
		t: "diskObs",
		event: "changed",
		path: "e.md",
		listingComplete: true,
		files: new Map([["e.md", obsFile("e.md", "start typed", 2)]]),
	}, env);
	s = res.state;
	assert.equal(s.notes.get(id)?.missing, undefined);

	// Delete again, then EditorClose sends del with captured snapshot
	s = runStep(s, { t: "diskObs", event: "deleted", path: "e.md", mayDelete: true, listingComplete: true, files: new Map() }, env).state;
	res = runStep(s, { t: "editorClose", id }, env);
	s = res.state;
	assert.equal(s.notes.get(id)?.change?.t, "del");
	assert.ok(res.actions.some(a => a.t === "workerReq" && a.request.action === "del"));
});

test("unreadable files and incomplete listings never delete; remote rename moves and parks cycles", () => {
	const env = makeEnv(60);
	const idA = "55".repeat(16), fileA = "66".repeat(16);
	const idB = "77".repeat(16), fileB = "88".repeat(16);
	let s = emptyVaultNoteState();
	s = runStep(s, { t: "row", row: { kind: "note", id: idA, file: fileA, path: "a.md", seq: 1, deleted: null } }, env).state;
	s = runStep(s, { t: "yjsUpdate", id: idA, docState: env.crdt.create("AAA", 1) }, env).state;
	s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile("a.md", "AAA", 1) }, env).state;

	s = runStep(s, { t: "row", row: { kind: "note", id: idB, file: fileB, path: "b.md", seq: 2, deleted: null } }, env).state;
	s = runStep(s, { t: "yjsUpdate", id: idB, docState: env.crdt.create("BBB", 1) }, env).state;
	s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile("b.md", "BBB", 1) }, env).state;

	// Partial startup listing with missing b.md produces NO deletion
	let res = runStep(s, {
		t: "diskObs",
		event: "startup",
		listingComplete: false,
		files: new Map([["a.md", obsFile("a.md", "AAA", 1)]]),
	}, env);
	s = res.state;
	assert.equal(s.notes.get(idB)?.change, undefined);

	// Unreadable file blocks only that note and never deletes
	res = runStep(s, {
		t: "diskObs",
		event: "startup",
		listingComplete: true,
		files: new Map([
			["a.md", obsFile("a.md", "AAA", 1)],
			["b.md", { stat: { path: "b.md", size: 3, mtime: 1 }, unreadable: true }],
		]),
	}, env);
	s = res.state;
	assert.equal(s.blocked.has(idB), true);
	assert.equal(s.notes.get(idB)?.change, undefined);

	// Restore b.md readable, then swap remote paths a.md <-> b.md (rename cycle broken via park move)
	s = runStep(s, {
		t: "diskObs",
		event: "changed",
		path: "b.md",
		listingComplete: true,
		files: new Map([["a.md", obsFile("a.md", "AAA", 1)], ["b.md", obsFile("b.md", "BBB", 1)]]),
	}, env).state;
	assert.equal(s.blocked.has(idB), false);

	s = runStep(s, { t: "row", row: { kind: "note", id: idA, file: fileA, path: "b.md", seq: 3, deleted: null } }, env).state;
	res = runStep(s, { t: "row", row: { kind: "note", id: idB, file: fileB, path: "a.md", seq: 4, deleted: null } }, env);
	s = res.state;
	assert.equal(s.intent?.kind, "move");
	assert.equal(s.intent?.park, true);
	const parkedTo = s.intent!.path;
	const parkedId = s.intent!.id;
	const otherId = parkedId === idA ? idB : idA;
	const otherWant = otherId === idA ? "b.md" : "a.md";
	s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile(parkedTo, parkedId === idA ? "AAA" : "BBB", 2) }, env).state;
	assert.equal(s.intent?.kind, "move");
	assert.equal(s.intent?.id, otherId);
	assert.equal(s.intent?.path, otherWant);
	s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile(otherWant, otherId === idA ? "AAA" : "BBB", 2) }, env).state;
	assert.equal(s.intent?.kind, "move");
	assert.equal(s.intent?.id, parkedId);
	s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile(parkedId === idA ? "b.md" : "a.md", parkedId === idA ? "AAA" : "BBB", 2) }, env).state;
	assert.equal(s.notes.get(idA)?.diskPath, "b.md");
	assert.equal(s.notes.get(idB)?.diskPath, "a.md");
});

test("mass-change deletion brake: approval lasts until zero deletes; decline undoes local and holds remote", () => {
	const env = makeEnv(80, { brake: { minCount: 2, minFraction: 0.25 } });
	let s = emptyVaultNoteState();
	const ids = ["a1", "a2", "a3", "a4"].map((x, i) => ({
		id: (i + 1).toString(16).padStart(32, "0"),
		file: (i + 11).toString(16).padStart(32, "0"),
		path: `${x}.md`,
	}));
	for (const item of ids) {
		s = runStep(s, { t: "row", row: { kind: "note", id: item.id, file: item.file, path: item.path, seq: 1, deleted: null } }, env).state;
		s = runStep(s, { t: "yjsUpdate", id: item.id, docState: env.crdt.create("text " + item.path, 1) }, env).state;
		s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile(item.path, "text " + item.path, 1) }, env).state;
	}

	// Delete a1 and a2 in one startup scan (2 outgoing dels) while a3 is already tombstoned (1 incoming remove) = 3 > 2 and 3/4 > 25% -> triggers brake
	s = runStep(s, {
		t: "row",
		row: { kind: "note", id: ids[2]!.id, file: ids[2]!.file, path: "a3.md", seq: 10, deleted: 100, snapshot: env.crdt.snapshot(s.docs.get(ids[2]!.id)!) },
	}, env).state;
	// First only a3 is deleted (1 <= 2), cancel its remove by keeping disk dirty until startup scan:
	// Instead, deliver a3's tombstone AFTER a1 & a2 are marked missing by startup (with a3 dirty then clean),
	// OR put a1, a2, a3 deletions together before brake is exceeded:
	// Even cleaner: reset to fresh 4-note state with a3 tombstoned while a3.md is dirty, then startup scan sees a1 & a2 missing + a3 clean!
	let s2 = emptyVaultNoteState();
	for (const item of ids) {
		s2 = runStep(s2, { t: "row", row: { kind: "note", id: item.id, file: item.file, path: item.path, seq: 1, deleted: null } }, env).state;
		s2 = runStep(s2, { t: "yjsUpdate", id: item.id, docState: env.crdt.create("text " + item.path, 1) }, env).state;
		s2 = runStep(s2, { t: "intentDone", intent: s2.intent!, outcome: "applied", after: obsFile(item.path, "text " + item.path, 1) }, env).state;
	}
	s2 = runStep(s2, { t: "pathDirty", path: "a3.md", delta: 1 }, env).state;
	s2 = runStep(s2, {
		t: "row",
		row: { kind: "note", id: ids[2]!.id, file: ids[2]!.file, path: "a3.md", seq: 10, deleted: 100, snapshot: env.crdt.snapshot(s2.docs.get(ids[2]!.id)!) },
	}, env).state;
	s2 = runStep(s2, { t: "pathDirty", path: "a3.md", delta: -1 }, env).state;
	// Wait: clearing dirty emits a3 remove (1 <= 2). Use a1+a2 missing in startup + a3 tombstone while brake minCount=2 and 2 outgoing + 1 incoming = 3!
	// Wait: a3 was already removed if we cleared dirty before startup; instead clear dirty only via crashRestart+startup!
	let s3 = emptyVaultNoteState();
	for (const item of ids) {
		s3 = runStep(s3, { t: "row", row: { kind: "note", id: item.id, file: item.file, path: item.path, seq: 1, deleted: null } }, env).state;
		s3 = runStep(s3, { t: "yjsUpdate", id: item.id, docState: env.crdt.create("text " + item.path, 1) }, env).state;
		s3 = runStep(s3, { t: "intentDone", intent: s3.intent!, outcome: "applied", after: obsFile(item.path, "text " + item.path, 1) }, env).state;
	}
	s3 = runStep(s3, { t: "pathDirty", path: "a3.md", delta: 1 }, env).state;
	s3 = runStep(s3, {
		t: "row",
		row: { kind: "note", id: ids[2]!.id, file: ids[2]!.file, path: "a3.md", seq: 10, deleted: 100, snapshot: env.crdt.snapshot(s3.docs.get(ids[2]!.id)!) },
	}, env).state;
	s3 = runStep(s3, { t: "crashRestart" }, env).state;
	let res = runStep(s3, {
		t: "diskObs",
		event: "startup",
		listingComplete: true,
		files: new Map([
			["a3.md", obsFile("a3.md", "text a3.md", 1)],
			["a4.md", obsFile("a4.md", "text a4.md", 1)],
		]),
	}, env);
	s = res.state;
	assert.ok(res.actions.some(a => a.t === "massChangeBrake" && a.message === "This would delete 3 files. Continue?"));
	assert.equal(res.actions.some(a => a.t === "workerReq" || a.t === "diskIntent"), false);

	// Test BrakeDeclined: cancels outgoing a1/a2 (restoring them to disk) and holds incoming a3
	res = runStep(s, { t: "brakeDeclined" }, env);
	s = res.state;
	assert.equal(s.notes.get(ids[0]!.id)?.change, undefined);
	assert.equal(s.notes.get(ids[1]!.id)?.change, undefined);
	assert.ok(res.actions.some(a => a.t === "problem" && /1 deleted files held/.test(a.message)));
	// Cancelled outgoing notes write back to disk while incoming a3 is NOT removed
	assert.equal(s.intent?.kind, "write");
	assert.ok(s.intent?.id === ids[0]!.id || s.intent?.id === ids[1]!.id);
	s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile(s.intent!.path, "text " + s.intent!.path, 2) }, env).state;
	assert.equal(s.intent?.kind, "write");
	s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile(s.intent!.path, "text " + s.intent!.path, 2) }, env).state;
	assert.equal(s.intent, undefined, "a3 remains held on disk");

	// Now approve: a3 is removed, and approval lasts until delete count reaches zero
	res = runStep(s, { t: "brakeApproved" }, env);
	s = res.state;
	assert.equal(s.intent?.kind, "remove");
	assert.equal(s.intent?.id, ids[2]!.id);
	s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied" }, env).state;
	assert.equal(s.brakePaused, undefined, "approval clears once pending deletes reach zero");
});

test("firstSync join matches exact path+text and NoteDevice enforces pre-release guard", async () => {
	const env = makeEnv(100);
	const id = "99".repeat(16), file = "aa".repeat(16);
	let s = emptyVaultNoteState(true);
	s = runStep(s, { t: "row", row: { kind: "note", id, file, path: "join.md", seq: 1, deleted: null } }, env).state;
	s = runStep(s, {
		t: "diskObs",
		event: "startup",
		listingComplete: true,
		files: new Map([["join.md", obsFile("join.md", "same", 1)], ["other.md", obsFile("other.md", "new", 1)]]),
	}, env).state;
	assert.equal(s.notes.get(id)?.join?.path, "join.md");
	assert.equal(s.notes.get(id)?.diskPath, undefined);

	// Matching doc arrives -> joins without creating a second note
	s = runStep(s, { t: "yjsUpdate", id, docState: env.crdt.create("same", 5) }, env).state;
	assert.equal(s.notes.get(id)?.diskPath, "join.md");
	assert.equal(s.notes.get(id)?.join, undefined);

	// Pre-release guard rejects leftover old keys
	const mem = new Memory();
	await mem.commit(new Map([["table/note-change/x", { t: "set", path: "x.md" }]]), []);
	await assert.rejects(NoteDevice.open(mem), /reset vault sync data required/);

	// Fresh NoteDevice commits and reloads cleanly
	const clean = new Memory();
	const dev = await NoteDevice.open(clean);
	await dev.dispatch({ t: "row", row: { kind: "note", id, file, path: "ok.md", seq: 1, deleted: null } }, env);
	const reopened = await NoteDevice.open(clean);
	assert.equal(reopened.snapshot().notes.get(id)?.row?.path, "ok.md");
});

test("userRestore, migrateFromLegacy (legacyRestore + vector), owed-recover, and file/id pairing", () => {
	const env = makeEnv(140);
	const id = "ab".repeat(16), file = "cd".repeat(16);
	const base = env.crdt.create("hello world", 1);
	const baseDoc = new Y.Doc();
	Y.applyUpdate(baseDoc, base);
	const vecB64 = Buffer.from(Y.encodeStateVector(baseDoc)).toString("base64");
	baseDoc.destroy();

	// migrateFromLegacy with legacyRestore on a vector tombstone promotes to restore once any prior inFlight resolves
	let s = emptyVaultNoteState();
	let res = runStep(s, {
		t: "migrateFromLegacy",
		seed: {
			firstSync: false,
			docs: new Map([[id, base]]),
			notes: [{
				id,
				file,
				editor: "closed",
				change: { t: "set", path: "restored.md", legacyRestore: true },
			}],
		},
	}, env);
	s = res.state;
	const preReq = res.actions.find(a => a.t === "workerReq");
	assert.ok(preReq && preReq.t === "workerReq");
	const tombstoneRow: NoteRow = { kind: "note", id, file, path: "restored.md", seq: 5, deleted: 123, vector: vecB64 };
	res = runStep(s, { t: "answer", req: preReq.request.req, refused: { row: tombstoneRow, missing: false } }, env);
	s = res.state;
	assert.equal(s.notes.get(id)?.change?.t, "restore");
	const req = res.actions.find(a => a.t === "workerReq");
	assert.ok(req && req.t === "workerReq" && req.request.action === "restore");

	// Accept restore -> UserRestore on a later tombstone avoids collision via (restored)
	const id2 = "ef".repeat(16), file2 = "01".repeat(16);
	s = runStep(s, { t: "answer", req: req.request.req, ok: 6 }, env).state;
	s = runStep(s, { t: "row", row: { kind: "note", id, file, path: "restored.md", seq: 6, deleted: null } }, env).state;
	s = runStep(s, { t: "row", row: { kind: "note", id: id2, file: file2, path: "restored.md", seq: 7, deleted: 200, vector: vecB64 } }, env).state;
	s = runStep(s, { t: "yjsUpdate", id: id2, docState: base }, env).state;
	res = runStep(s, { t: "userRestore", id: id2, deletionSeq: 7 }, env);
	s = res.state;
	assert.ok(res.actions.some(a => a.t === "yjsMerge" && a.id === id2 && a.isSnapshot === true));
	assert.equal(s.notes.get(id2)?.change?.t, "restore");
	assert.equal(s.notes.get(id2)?.change?.path, "restored (restored).md");

	// file <-> id pairing check rejects swapped file/id
	assert.throws(() => runStep(s, { t: "row", row: { kind: "note", id: "99".repeat(16), file, path: "bad.md", seq: 99, deleted: null } }, env), /must stay together/);

	// owed-recover: stale flush (onlyInserts(disk, doc)) creates NO recovered copy; unrecorded disk text DOES
	let sRec = emptyVaultNoteState();
	sRec = runStep(sRec, { t: "row", row: { kind: "note", id, file, path: "rec.md", seq: 1, deleted: null } }, env).state;
	sRec = runStep(sRec, { t: "yjsUpdate", id, docState: base }, env).state;
	sRec = runStep(sRec, { t: "intentDone", intent: sRec.intent!, outcome: "applied", after: obsFile("rec.md", "hello world", 1) }, env).state;
	sRec = runStep(sRec, { t: "editorOpen", id }, env).state;
	const typed = env.crdt.applyToUnchangedBase(base, "hello brave world", 2).agreement;
	sRec = runStep(sRec, { t: "yjsUpdate", id, docState: typed }, env).state;
	sRec = runStep(sRec, { t: "crashRestart" }, env).state;
	assert.equal(sRec.notes.get(id)?.editor, "owed-recover");
	// Stale editor flush ("hello world") -> no recovered copy
	res = runStep(sRec, { t: "diskObs", event: "startup", listingComplete: true, files: new Map([["rec.md", obsFile("rec.md", "hello world", 2)]]) }, env);
	assert.equal([...res.state.notes.values()].filter(n => n.copyOf === id).length, 0);
	assert.equal(res.state.intent?.kind, "write");

	// Unrecorded disk text ("hello unrecorded") -> creates (recovered …) copy with copyOf
	res = runStep(sRec, { t: "diskObs", event: "startup", listingComplete: true, files: new Map([["rec.md", obsFile("rec.md", "hello unrecorded", 3)]]) }, env);
	const recCopies = [...res.state.notes.values()].filter(n => n.copyOf === id);
	assert.equal(recCopies.length, 1);
	assert.match(recCopies[0]!.conflictOriginPath!, /\(recovered [0-9a-f]{6}\)\.md$/);
	assert.equal(env.crdt.completeText(res.state.docs.get(recCopies[0]!.id)), "hello unrecorded");
});

test("brakeApproved persists across multiple deletions until pending count reaches zero", () => {
	const env = makeEnv(200, { brake: { minCount: 1, minFraction: 0.25 } });
	let s = emptyVaultNoteState();
	const items = [0, 1, 2].map(i => ({
		id: (i + 1).toString(16).padStart(32, "0"),
		file: (i + 11).toString(16).padStart(32, "0"),
		path: `b${i}.md`,
	}));
	for (const it of items) {
		s = runStep(s, { t: "row", row: { kind: "note", id: it.id, file: it.file, path: it.path, seq: 1, deleted: null } }, env).state;
		s = runStep(s, { t: "yjsUpdate", id: it.id, docState: env.crdt.create("t " + it.path, 1) }, env).state;
		s = runStep(s, { t: "intentDone", intent: s.intent!, outcome: "applied", after: obsFile(it.path, "t " + it.path, 1) }, env).state;
	}
	s = runStep(s, { t: "crashRestart" }, env).state;
	let res = runStep(s, {
		t: "diskObs",
		event: "startup",
		listingComplete: true,
		files: new Map([["b2.md", obsFile("b2.md", "t b2.md", 1)]]),
	}, env);
	s = res.state;
	assert.ok(res.actions.some(a => a.t === "massChangeBrake"));

	// Approve once: both deletions proceed across multiple steps without re-prompting
	res = runStep(s, { t: "brakeApproved" }, env);
	s = res.state;
	const reqs = res.actions.filter(a => a.t === "workerReq");
	assert.equal(reqs.length, 2);
	assert.equal(s.brakePaused?.approved, true);
	// Next step with pending count at zero clears approval
	s = runStep(s, { t: "answer", req: (reqs[0] as Extract<NoteAction, { t: "workerReq" }>).request.req, ok: 2 }, env).state;
	assert.equal(s.brakePaused, undefined, "once pending deletes reach 0, approval clears");
});
