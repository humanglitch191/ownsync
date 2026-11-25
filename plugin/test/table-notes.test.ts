import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { decodeClient, type AttachmentRow, type ServerFrame } from "../../server/src/wire";
import { TableSync } from "../src/tableSync";
import type { NoteRow } from "../src/core/table/notes";
import type { VaultKeys } from "../src/keys";
import { attachmentFs } from "./table-fs";
import { Files, enc, hash } from "./table-sim";
import type { NoteEntry } from "../src/core/table/notePlanner";
import { Device, Server, quiesce, rng } from "./sim";

const key = new Uint8Array(32), keys = { vmk: key, epoch: 0, vaultId: new Uint8Array(16),
	me: { id: new Uint8Array(16) }, keyFor: () => key, state: {} } as unknown as VaultKeys;
const note: NoteRow = { kind: "note", id: "3a".repeat(8), path: "draft.md", file: "ff".repeat(16), seq: 1, deleted: null };
function table(device: Device) {
	const { store } = attachmentFs(device.files, device.data);
	return new TableSync(store, keys, new Files(), () => true, false, 0, (_, e) => device.problems.push(String(e)));
}

test("table note editors use the placed ID and the durable Yjs stream regardless of row/text arrival order", async () => {
	const server = new Server(), random = rng(13);
	const a = new Device("A", server, random), b = new Device("B", server, random);
	const ta = table(a), tb = table(b);
	for (const [d, t] of [[a, ta], [b, tb]] as const) {
		d.data.set("table/migrated", true);
		d.data.set("table/note-state/" + note.id, {id:note.id, file:note.file, diskPath:note.path, editor:"closed"});
		d.files.set(note.path, { content: "draft", mtime: 1 });
		const disk = new Files(); disk.edit(note.path, "draft");
		d.overrides = { tableNotes: t.notes, noteDisk: disk, hash: async text => hash(enc.encode(text)) };
		d.boot(); await d.idle();
		await t.connect(async () => assert.fail("typing sent a table request"));
		d.connect(); await d.engine!.initializeNoteFiles(false);
	}
	await ta.row(await ta.wireNote(note));
	await quiesce([a,b]);
	assert.equal(await a.engine!.open(note.id), undefined, "a row alone cannot open an empty Y.Doc");
	const doc = new Y.Doc(), updates: Uint8Array[] = [];
	doc.on("update", (u: Uint8Array) => updates.push(u));
	doc.getText("t").insert(0,"dra"); doc.getText("t").insert(3,"ft");
	const entry = (update: Uint8Array) => ({ t: "live" as const, entry: { doc: note.id, kind: "update" as const, data: update } });
	await a.engine!.receive(entry(updates[1]!));
	assert.equal(await a.engine!.open(note.id), undefined, "missing Yjs dependencies");
	await b.engine!.receive(entry(Y.encodeStateAsUpdate(doc))); // text before the row
	await tb.row(await tb.wireNote(note));
	await a.engine!.receive(entry(updates[0]!));
	const x = await a.engine!.open(note.id), y = await b.engine!.open(note.id);
	assert.ok(x && y);
	assert.equal(x.getText("t").toString(), "draft");
	x.getText("t").insert(0, "first ");
	y.getText("t").insert(5, " last");
	await quiesce([a,b]);
	assert.equal(y.getText("t").toString(), "first draft last");
	assert.equal(x.getText("t").toString(), y.getText("t").toString());
	assert.equal(ta.notes.at(note.path)?.seq, 1);
	assert.equal(tb.notes.at(note.path)?.seq, 1);
	await a.engine!.close(note.id);
	a.crash();
	const returning = table(a);
	a.overrides.tableNotes = returning.notes;
	a.boot(); await a.idle();
	await returning.connect(async () => assert.fail("unexpected table request"));
	const reopened = await a.engine!.open(note.id);
	assert.equal(reopened?.getText("t").toString(), "first draft last");
	const moved = { ...note, seq: 2, path: "elsewhere.md" };
	await returning.row(await returning.wireNote(moved));
	assert.equal(a.engine!.pathOf(note.id), moved.path);
	assert.equal(a.engine!.noteAt(note.path), undefined);
	assert.equal(a.engine!.noteAt(moved.path), undefined, "disk has not been placed here");
	const second = { ...note, id: "4b".repeat(8), file: "ee".repeat(16), seq: 3 };
	await returning.row(await returning.wireNote(second));
	assert.equal(a.engine!.noteAt(note.path), undefined, "another ID still owns the local file");
	assert.deepEqual([...a.problems,...b.problems], []);
	doc.destroy(); a.engine!.stop(); b.engine!.stop();
});

test("a changed document ID or invalid note record cannot move the catch-up cursor", async () => {
	const d = new Device("x", new Server(), rng(4)), t = table(d);
	const connect = () => t.connect(async () => assert.fail());
	await connect(); await t.row(await t.wireNote(note));
	for (const row of [{ ...note, id: "ab", seq: 2 }, { ...note, file: "dd".repeat(16), seq: 2 }, { ...note, seq: 2, deleted: 1 }]) {
		await assert.rejects(t.row(await t.wireNote(row)));
		assert.equal(await connect(), 1);
	}
	const frame = await t.wireNote(note);
	await assert.rejects(t.row({ ...frame, pathkey: new Uint8Array(32), seq: 3 }));
	assert.equal(await connect(), 1);
});

function version(text: string, base?: Uint8Array) {
	const doc = new Y.Doc();
	if (base) Y.applyUpdate(doc, base);
	doc.getText("t").insert(doc.getText("t").length, text);
	const state = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return state;
}

async function planner(defer = (f: () => void) => f()) {
	const d = new Device("planner", new Server(), rng(123)), disk = new Files();
	const hashText = async (text: string) => hash(enc.encode(text));
	d.data.set("table/migrated", true);
	const boot = async () => {
		const t = table(d);
		d.overrides = { tableNotes: t.notes, noteDisk: disk, hash: hashText, defer, onNoteWork: () => t.noteWork() };
		d.boot(); await d.idle();
		return t;
	};
	const t = await boot();
	await t.notes.receive(note);
	const change = (id: string) => (d.data.get("table/note-state/" + id) as NoteEntry | undefined)?.change;
	return { d, disk, t, boot, change };
}

test("a closed disk edit forks its exact agreement and preserves concurrent remote text", async () => {
	const { d, disk, change } = await planner();
	const base = version("one two"), current = version(" remote", base);
	d.data.set("state:" + note.id, base);
	disk.edit(note.path, "one two");
	await d.engine!.initializeNoteFiles(true);
	disk.edit(note.path, "three two");
	await d.engine!.receive({ t: "live", entry: { doc: note.id, kind: "update", data: current } });
	assert.equal(disk.text(note.path), "one two remote");
	assert.ok([...disk.files.keys()].some(p => p.includes(" (conflict ") && disk.text(p) === "three two"));
	assert.equal(d.storedText(note.id), disk.text(note.path));
	assert.equal(change(note.id), undefined);
	assert.deepEqual(d.problems, []);
});

test("only the initial inventory joins an exact path and text, including a row waiting for text", async () => {
	for (const first of [false, true]) {
		const { d, disk } = await planner();
		disk.edit(note.path, "draft");
		await d.engine!.initializeNoteFiles(first);
		await d.engine!.receive({ t: "live", entry: { doc: note.id, kind: "update", data: version("draft") } });
		await d.engine!.initializeNoteFiles(true); // reconnecting never reopens the exception
		assert.equal(d.engine!.noteAt(note.path), note.id);
		const others = [...disk.files.keys()].filter(p => p !== note.path);
		assert.equal(others.length, first ? 0 : 1);
		if (others.length) {
			assert.match(others[0]!, / \(conflict /);
			assert.equal(disk.text(others[0]!), "draft");
			assert.notEqual(d.engine!.noteAt(others[0]!), note.id);
		}
		assert.deepEqual(d.problems, []);
	}
});

test("a live rename keeps the ID; an identical offline move plans delete plus create", async () => {
	for (const live of [false, true]) {
		const { d, disk, boot, change } = await planner();
		d.data.set("state:" + note.id, version("draft"));
		disk.edit(note.path, "draft");
		await d.engine!.initializeNoteFiles(true);
		if (!live) d.crash();
		disk.files.set("moved.md", disk.files.get(note.path)!);
		disk.files.delete(note.path);
		if (live) { d.engine!.diskRenamed(note.path, "moved.md"); await d.idle(); }
		else { await boot(); await d.engine!.initializeNoteFiles(false); }
		if (live) {
			assert.equal(d.engine!.noteAt("moved.md"), note.id);
			assert.deepEqual(change(note.id), { t: "set", path: "moved.md", basePath: note.path });
		}
		else {
			assert.equal(change(note.id)?.t, "del");
			const other = d.engine!.noteAt("moved.md");
			assert.ok(other && other !== note.id);
			assert.deepEqual(change(other), { t: "set", path: "moved.md" });
			assert.equal(d.storedText(other), "draft");
		}
		assert.deepEqual(d.problems, []);
	}
});

test("replaying a write after a crash preserves destructive stray text as one independent note", async () => {
	for (const fault of ["temp", "effect"] as const) {
		const { d, disk, boot } = await planner();
		d.data.set("state:" + note.id, version("intended"));
		disk.crash = fault;
		await d.engine!.initializeNoteFiles(false);
		assert.ok(!!(d.data.get("table/note-state/" + note.id) as NoteEntry).intended);
		d.crash(); disk.edit(note.path, "unrelated");
		await boot(); await d.engine!.initializeNoteFiles(false);
		d.crash(); await boot(); await d.engine!.initializeNoteFiles(false);
		assert.equal(disk.text(note.path), "intended");
		const kept = [...disk.files.keys()].filter(path => path !== note.path);
		assert.equal(kept.length, 1);
		assert.equal(disk.text(kept[0]!), "unrelated");
		assert.equal(d.storedText(d.engine!.noteAt(kept[0]!)!), "unrelated");
		assert.equal(!!(d.data.get("table/note-state/" + note.id) as NoteEntry).intended, false);
		assert.ok(d.problems.every(p => p.includes("killed")), d.problems.join("\n"));
	}
});

test("a file that appears after first sync stays independent even if its path and text match a later row", async () => {
	const { d, disk, t } = await planner();
	await d.engine!.initializeNoteFiles(true);
	const path = "later.md";
	disk.edit(path, "same"); d.engine!.diskChanged(path); await d.idle();
	const mine = d.engine!.noteAt(path)!;
	assert.ok(mine);
	const other = { ...note, id: "5c".repeat(8), file: "aa".repeat(16), path, seq: 2 };
	await t.notes.receive(other);
	await d.engine!.receive({ t: "live", entry: { doc: other.id, kind: "update", data: version("same") } });
	assert.equal(d.engine!.noteAt(path), other.id);
	const copy = [...disk.files.keys()].find(p => p.startsWith("later (conflict "))!;
	assert.equal(d.engine!.noteAt(copy), mine);
	assert.equal(disk.text(copy), disk.text(path));
	assert.deepEqual(d.problems, []);
});

test("startup finishes a remote rename interrupted after its disk effect under the original ID", async () => {
	const { d, disk, t, boot, change } = await planner();
	d.data.set("state:" + note.id, version("draft"));
	await d.engine!.initializeNoteFiles(false);
	const moved = { ...note, path: "renamed.md", seq: 2 };
	disk.crash = "effect";
	await assert.rejects(t.notes.receive(moved), /killed/);
	await d.idle();
	assert.ok(!!(d.data.get("table/note-meta") as {intent?: unknown}).intent);
	d.crash(); await boot(); await d.engine!.initializeNoteFiles(false);
	assert.equal(d.engine!.noteAt(moved.path), note.id);
	assert.deepEqual([...disk.files.keys()], [moved.path]);
	assert.equal(change(note.id), undefined);
	assert.equal(!!(d.data.get("table/note-meta") as {intent?: unknown}).intent, false);
});

test("a stale editor save with unrecorded typing gets one recovered note", async () => {
	const { d, disk, boot } = await planner();
	const state = version("original");
	d.data.set("state:" + note.id, state);
	await d.engine!.initializeNoteFiles(false);
	assert.ok(await d.engine!.open(note.id));
	d.crash(); disk.edit(note.path, "last unrecorded save");
	await boot(); await d.engine!.initializeNoteFiles(false);
	assert.equal(disk.text(note.path), "original");
	const kept = [...disk.files.keys()].filter(p => p.includes(" (recovered "));
	assert.equal(kept.length, 1);
	assert.equal(disk.text(kept[0]!), "last unrecorded save");
	const copyId = d.engine!.noteAt(kept[0]!)!;
	assert.notEqual(copyId, note.id);
	assert.equal((d.data.get("table/note-state/" + copyId) as { copyOf?: string }).copyOf, note.id);
	disk.files.set("renamed.md", disk.files.get(kept[0]!)!);
	disk.files.delete(kept[0]!);
	d.engine!.diskRenamed(kept[0]!, "renamed.md"); await d.idle();
	assert.equal(d.engine!.noteAt("renamed.md"), copyId);
	assert.equal((d.data.get("table/note-state/" + copyId) as { copyOf?: string }).copyOf, note.id);
	assert.deepEqual(d.problems, []);
});

test("a save racing a closed-note write survives the conditional install and restart", async () => {
	const { d, disk, boot } = await planner(), base = version("base");
	d.data.set("state:" + note.id, base);
	await d.engine!.initializeNoteFiles(false);
	const install = disk.installTemp.bind(disk);
	disk.installTemp = async (path, expected) => {
		disk.installTemp = install;
		disk.edit(path, "base local");
		return install(path, expected);
	};
	await d.engine!.receive({ t: "live", entry: { doc: note.id, kind: "update", data: version(" remote", base) } });
	assert.equal(disk.text(note.path), "base remote");
	d.crash(); await boot(); await d.engine!.initializeNoteFiles(false);
	assert.deepEqual([...disk.files.keys()].map(p => disk.text(p)).sort(), ["base local", "base remote"]);
	assert.deepEqual(d.problems, []);
});

test("a returning scan skips agreed bytes and an explicit modify event still checks them", async () => {
	const { d, disk, boot } = await planner();
	d.data.set("state:" + note.id, version("abc"));
	await d.engine!.initializeNoteFiles(false);
	const reads = disk.reads;
	d.crash(); await boot();
	await d.engine!.initializeNoteFiles(false);
	assert.equal(disk.reads, reads);
	disk.files.get(note.path)!.bytes = enc.encode("xyz"); // same size and mtime
	d.engine!.diskChanged(note.path); await d.idle();
	assert.equal(d.storedText(note.id), "xyz");
	assert.deepEqual(d.problems, []);
});

test("a deletion concurrent with a closed-file edit proposes restore at its deletion seq", async () => {
	const { d, t, disk, change } = await planner();
	const state = version("before");
	d.data.set("state:" + note.id, state); await d.engine!.initializeNoteFiles(false);
	disk.edit(note.path, "before local");
	const deleted = { ...note, seq: 2, deleted: 1, vector: Buffer.from(Y.encodeStateVectorFromUpdate(state)).toString("base64") };
	await t.notes.receive(deleted); await d.idle();
	assert.deepEqual(change(note.id), { t: "restore", path: note.path, base: 2 });
	assert.equal(d.storedText(note.id), "before local");
	assert.equal(disk.text(note.path), "before local");
	assert.deepEqual(d.problems, []);
});

test("two interrupted writes keep the Yjs agreement of the first write that reached disk", async () => {
	const { d, disk, boot } = await planner();
	const base = version("first"), doc = new Y.Doc();
	Y.applyUpdate(doc, base);
	const text = doc.getText("t");
	const replace = (next: string) => {
		text.delete(0, text.length); text.insert(0, next);
		return Y.encodeStateAsUpdate(doc);
	};
	d.data.set("state:" + note.id, base);
	await d.engine!.initializeNoteFiles(false);
	disk.crash = "effect";
	await d.engine!.receive({ t: "live", entry: { doc: note.id, kind: "update", data: replace("second") } });
	assert.equal(disk.text(note.path), "second");
	disk.crash = "temp";
	await d.engine!.receive({ t: "live", entry: { doc: note.id, kind: "update", data: replace("third") } });
	d.crash(); disk.edit(note.path, "second local");
	await boot(); await d.engine!.initializeNoteFiles(false);
	const merged = disk.text(note.path)!;
	assert.equal(merged, "third");
	assert.deepEqual([...disk.files.keys()].map(p => disk.text(p)).sort(), ["second local", "third"]);
	doc.destroy();
});

test("a cycle of row renames moves both documents without publishing the parking path", async () => {
	const { d, t, disk, change } = await planner();
	const other = { ...note, id: "bb".repeat(8), file: "cc".repeat(16), path: "other.md", seq: 2 };
	await t.notes.receive(other);
	d.data.set("state:" + note.id, version("first note"));
	d.data.set("state:" + other.id, version("second note"));
	await d.engine!.initializeNoteFiles(false);
	await t.notes.receive({ ...note, path: other.path, seq: 4 });
	await t.notes.receive({ ...other, path: note.path, seq: 5 });
	await d.idle();
	assert.equal(disk.text(note.path), "second note"); assert.equal(disk.text(other.path), "first note");
	assert.equal(disk.files.size, 2);
	assert.equal(change(note.id), undefined); assert.equal(change(other.id), undefined);
	assert.deepEqual(d.problems, []);
});

test("a new file at the source of an interrupted move keeps its own ID", async () => {
	const { d, t, disk, boot } = await planner();
	d.data.set("state:" + note.id, version("moved note"));
	await d.engine!.initializeNoteFiles(false);
	const row = { ...note, path: "new.md", seq: 2 };
	disk.crash = "effect"; await assert.rejects(t.notes.receive(row), /killed/);
	await d.idle();
	d.crash(); disk.edit(note.path, "newly created");
	await boot(); await d.engine!.initializeNoteFiles(false);
	assert.equal(d.engine!.noteAt(row.path), note.id);
	const newId = d.engine!.noteAt(note.path);
	assert.ok(newId && newId !== note.id);
	assert.equal(d.storedText(newId), "newly created");
	assert.equal(d.storedText(note.id), "moved note");
	assert.equal(disk.files.size, 2);
});

test("deleting a note respects deletion-only edits outside the deleter's full Yjs snapshot", async () => {
	for (const sawEdit of [false, true]) {
		const { d, disk, t, change } = await planner();
		const doc = new Y.Doc();
		doc.getText("t").insert(0, "keep this");
		const original = Y.encodeStateAsUpdate(doc);
		const snap = () => Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString("base64");
		const before = snap();
		doc.getText("t").delete(4, 5);
		d.data.set("state:" + note.id, Y.encodeStateAsUpdate(doc));
		disk.edit(note.path, "keep"); await d.engine!.initializeNoteFiles(true);
		assert.deepEqual(Y.encodeStateVector(doc), Y.encodeStateVectorFromUpdate(original));
		await t.notes.receive({ ...note, seq: 2, deleted: 1, snapshot: sawEdit ? snap() : before });
		await d.idle();
		assert.equal(change(note.id)?.t, sawEdit ? undefined : "restore");
		assert.equal(disk.text(note.path), sawEdit ? undefined : "keep");
		doc.destroy();
	}
});

test("a lost note-create answer replays its request and preserves a later offline rename", async () => {
	const { d, disk, t, boot } = await planner();
	let active = t, seq = 1, firstReq: string | undefined, stored: AttachmentRow | undefined;
	const sent: string[] = [];
	const ask = async (packet: Uint8Array): Promise<ServerFrame> => {
		const f = decodeClient(packet);
		if (f.t === "forget") return { t: "forgotten", req: f.req };
		if (f.t !== "set") throw new Error("unexpected request");
		const req = Buffer.from(f.req).toString("hex");
		sent.push(req);
		if (!firstReq) {
			firstReq = req;
			stored = { file: f.file, seq: ++seq, pathkey: f.pathkey, record: f.record, deleted: null, version: null };
			throw new Error("lost answer");
		}
		if (req === firstReq) return { t: "ok", req: f.req, seq: stored!.seq };
		assert.equal(f.base, stored!.seq);
		void active.row({ file: f.file, seq: ++seq, pathkey: f.pathkey, record: f.record, deleted: null, version: null });
		return { t: "ok", req: f.req, seq };
	};
	await t.connect(ask, d.engine!); await t.ready(1); await t.notesCaughtUp();
	disk.edit("one.md", "draft"); d.engine!.diskChanged("one.md"); await d.idle(); await t.idle();
	assert.equal(sent.length, 0, "a file row must wait for its first stored text ack");
	// Lose the text ack as well. After reconnect its durable outbox must replay
	// before a create can acquire the path.
	d.connect(); await d.idle();
	while (d.pumpUp()) {}
	while (d.pumpDown()) {} await d.idle();
	while (d.pumpUp()) {}
	assert.ok(d.server.rows.some(r => r.entry.doc === d.engine!.noteAt("one.md")));
	d.disconnect(); await d.idle(); assert.equal(sent.length,0);
	d.connect(); await quiesce([d]); await t.idle();
	assert.ok(stored); const doc = d.engine!.noteAt("one.md")!;
	t.disconnect(); disk.files.set("two.md", disk.files.get("one.md")!); disk.files.delete("one.md");
	d.engine!.diskRenamed("one.md", "two.md"); await d.idle();
	d.crash(); active = await boot();
	await active.connect(ask, d.engine!); await active.row(stored); await active.ready(seq);
	await active.notesCaughtUp(); await active.idle();
	assert.equal(active.notes.at("two.md")?.id, doc);
	assert.equal(sent.length, 3); assert.equal(sent[0], sent[1]); assert.notEqual(sent[1], sent[2]);
	assert.equal(disk.text("two.md"), "draft"); assert.equal(disk.text("one.md"), undefined);
	assert.equal(active.notes.state!.notes.get(doc)?.inFlight, undefined);
	assert.equal(active.notes.state!.forget.size, 0);
});

test("table snapshots require complete text and capture unsaved typing under the confirmed path", async () => {
	const { d, t } = await planner();
	await d.engine!.initializeNoteFiles(false);
	const collect = async () => {
		const notes = [];
		for await (const row of d.engine!.tableSnapshotNotes()) notes.push(row);
		return notes;
	};
	await assert.rejects(collect, /Waiting for the text/);
	await d.engine!.receive({ t: "live", entry: { doc: note.id, kind: "update", data: version("draft") } });
	const editor = await d.engine!.open(note.id);
	assert.ok(editor); editor.getText("t").insert(5, " typed");
	assert.deepEqual(await collect(), [{ id: note.id, path: note.path, text: "draft typed" }]);
	const snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(editor))).toString("base64");
	await t.notes.receive({ ...note, deleted: 1, seq: 2, snapshot });
	await d.idle();
	assert.deepEqual(await collect(), []);
});

test("a deleted row can be listed before its text arrives, but its preview and restore wait", async () => {
	const { d, t, change } = await planner();
	const state = version("still stored");
	const doc = new Y.Doc(); Y.applyUpdate(doc, state);
	const snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString("base64");
	doc.destroy();
	await t.notes.receive({ ...note, seq: 2, deleted: Date.now(), snapshot });
	await d.engine!.initializeNoteFiles(false);
	const [entry] = await d.engine!.deletedNotes();
	assert.equal(entry?.deletionSeq, 2);
	assert.equal(await d.engine!.deletedText(note.id), undefined);
	assert.equal(await d.engine!.restoreDeleted(note.id, undefined, 2), undefined);
	assert.equal(change(note.id), undefined);
	await d.engine!.receive({ t: "entry", seq: 1, entry: { doc: note.id, kind: "update", data: state } });
	assert.equal(await d.engine!.deletedText(note.id), "still stored");
	assert.equal(await d.engine!.restoreDeleted(note.id, undefined, 2), note.path);
	assert.equal(change(note.id)?.t, "restore");
});

test("a transient missing path during save or rename cannot delete a note on a remote settle", async () => {
	const { d, disk, change } = await planner(), initial = version("base");
	d.data.set("state:" + note.id,initial); await d.engine!.initializeNoteFiles(false);
	disk.files.delete(note.path);
	d.engine!.diskChanged(note.path,false); await d.idle(); // modify while the editor replaces its file
	assert.equal(change(note.id),undefined);
	d.engine!.diskChanged(note.path,true); // delete and create announced before the queue drains
	disk.edit(note.path,"base saved"); d.engine!.diskChanged(note.path,false); await d.idle();
	const placed = disk.files.get(note.path)!; disk.files.delete(note.path); disk.files.set("new.md",placed);
	await d.engine!.receive({t:"live",entry:{doc:note.id,kind:"update",data:version(" peer", initial)}});
	assert.equal(change(note.id),undefined);
	d.engine!.diskRenamed(note.path,"new.md"); await d.idle();
	assert.equal(d.engine!.noteAt("new.md"),note.id); assert.equal(change(note.id)?.t,"set");
	assert.match(disk.text("new.md")!,/peer/); assert.match(disk.text("new.md")!,/saved/);
});

test("closing after a disk delete uses the open editor's full deletion snapshot", async () => {
	const { d, disk, t, change } = await planner();
	d.data.set("state:" + note.id,version("keep this")); await d.engine!.initializeNoteFiles(false);
	const doc = await d.engine!.open(note.id); assert.ok(doc);
	doc.getText("t").delete(4,5); await d.idle();
	disk.files.delete(note.path);
	d.engine!.diskChanged(note.path); await d.idle();
	assert.equal(change(note.id),undefined);
	const expected = Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString("base64");
	await d.engine!.close(note.id);
	assert.deepEqual(change(note.id),{t:"del", path:note.path,snapshot:expected});
	await t.notes.receive({...note,seq:2,deleted:1,snapshot:expected}); await d.idle();
	assert.equal(t.notes.get(note.id)?.deleted,1); assert.equal(disk.text(note.path),undefined);
	assert.equal(await d.engine!.deletedText(note.id),"keep");
});

test("a pending restore preserves a later edit and deletion before its row echo", async () => {
	const { d, disk, t, change } = await planner();
	const state = version("base");
	d.data.set("state:" + note.id, state);
	await d.engine!.initializeNoteFiles(false);
	// A local edit outside the tombstone keeps this file placed while its restore is pending.
	disk.edit(note.path, "base mine"); d.engine!.diskChanged(note.path, false); await d.idle();
	await t.notes.receive({ ...note, seq: 2, deleted: 1, vector: Buffer.from(Y.encodeStateVectorFromUpdate(state)).toString("base64") });
	await d.engine!.restoreDeleted(note.id, note.path, 2);
	const req = t.notes.state!.notes.get(note.id)!.inFlight!;
	await t.notes.input({t:"answer", req:req.req, ok:3});
	disk.edit(note.path, "base edited"); d.engine!.diskChanged(note.path, false); await d.idle();
	assert.equal(d.storedText(note.id), "base edited");
	disk.files.delete(note.path); d.engine!.diskChanged(note.path, true); await d.idle();
	const deletion = change(note.id);
	assert.ok(deletion?.t === "del" && deletion.snapshot);
	assert.ok(Y.snapshotContainsUpdate(Y.decodeSnapshot(Buffer.from(deletion.snapshot, "base64")), d.data.get("state:" + note.id) as Uint8Array));
	disk.edit(note.path, "new file"); d.engine!.diskChanged(note.path, false); await d.idle();
	await t.notes.receive({ ...note, seq: 3 });
	await d.idle();
	assert.deepEqual(change(note.id), deletion);
	assert.equal(d.storedText(note.id), "base edited");
	assert.equal(disk.text(note.path), "new file");
	assert.deepEqual(d.problems, []);
});

test("a row waiting on a dirty empty path is placed when the last event drains", async () => {
	const events: (() => void)[] = [];
	const { d, disk, t } = await planner(f => events.push(f));
	await d.engine!.initializeNoteFiles(false);
	const row = { ...note, path: "free.md", seq: 2 };
	d.engine!.diskChanged(row.path, false); d.engine!.diskChanged(row.path, false);
	d.data.set("state:" + note.id, version("waiting")); await t.notes.receive(row);
	await d.idle();
	events.shift()!(); await d.idle(); assert.equal(disk.text(row.path), undefined);
	events.shift()!(); await d.idle(); assert.equal(disk.text(row.path), "waiting");
	assert.deepEqual(d.problems, []);
});

test("closing an editor whose file still matches the agreement creates no recovery copy", async () => {
	const { d, disk } = await planner();
	d.data.set("state:" + note.id, version("before")); await d.engine!.initializeNoteFiles(false);
	const doc = await d.engine!.open(note.id); assert.ok(doc);
	const text = doc.getText("t");
	doc.transact(() => { text.delete(0, text.length); text.insert(0, "after"); });
	await d.idle(); await d.engine!.close(note.id);
	assert.deepEqual([...disk.files.keys()], [note.path]);
	assert.equal(disk.text(note.path), "after");
	assert.deepEqual(d.problems, []);
});

test("an upgraded offline device leaves the legacy outbox, agreements and vault files untouched until adoption", async () => {
	const d = new Device("upgrading", new Server(), rng(752));
	d.boot(); d.connect(); await quiesce([d]);
	d.write("local.md","original"); await quiesce([d]);
	d.disconnect(); d.write("local.md","unsent"); d.drain(); await d.idle();
	assert.ok([...d.data.keys()].some(k => k.startsWith("out:")));
	d.crash(); d.rename("local.md","outside.md");
	const files = structuredClone(d.files), data = structuredClone(d.data);
	const t = table(d);
	d.overrides = {tableNotes:t.notes, noteDisk:new Files()};
	d.boot(); await d.idle();
	d.engine!.diskChanged("outside.md"); d.drain();
	await d.engine!.connected({send:() => assert.fail("legacy send before genesis")});
	await d.idle();
	assert.deepEqual(d.files,files);
	assert.deepEqual(d.data,data);
	assert.equal(d.engine!.noteAt("local.md"),undefined);
	assert.deepEqual(d.problems,[]);
	d.crash();
});

test("a holder repairs a note omitted from genesis with its complete body, then proposes the stable ID", async () => {
	const { legacyBases } = await import("../src/core/table/migration");
	const d = new Device("holder",new Server(),rng(28)), t = table(d), disk = new Files();
	const index = new Y.Doc(), doc = new Y.Doc();
	index.getMap("notes").set(note.id,{p:note.path});
	doc.getText("t").insert(0,"kept ");
	const partialBase = Y.encodeStateVector(doc);
	d.data.set("base:"+note.id,Y.encodeStateAsUpdate(doc));
	doc.getText("t").insert(5,"on device");
	d.data.set("index",Y.encodeStateAsUpdate(index));
	d.data.set("state:"+note.id,Y.encodeStateAsUpdate(doc,partialBase));
	// The note never reached disk and its old outbox has already been acknowledged.
	const {store} = attachmentFs(d.files,d.data);
	await store.commit(await legacyBases(store,key),[]);
	d.overrides = {tableNotes:t.notes,noteDisk:disk};
	d.boot(); await d.idle();
	await d.engine!.initializeNoteFiles(false);
	const n = t.notes.state!.notes.get(note.id)!;
	assert.equal(n.firstTextPending,true);
	assert.equal(n.inFlight,undefined);
	const out = [...d.data].find(([k,v]) => k.startsWith("out:") && (v as {doc:string}).doc === note.id);
	assert.ok(out);
	const worker = new Y.Doc();
	try {
		Y.applyUpdate(worker,Y.encodeStateAsUpdate(doc,partialBase));
		assert.ok(worker.store.pendingStructs);
		Y.applyUpdate(worker,(out[1] as {data:Uint8Array}).data);
		assert.equal(worker.store.pendingStructs,null);
		assert.equal(worker.getText("t").toString(),"kept on device");
		await d.engine!.receive({t:"ack",id:Number(out[0].slice(4)),seq:1});
		const proposal = t.notes.state!.notes.get(note.id)!.inFlight!;
		assert.equal(proposal.base,null);
		assert.equal(proposal.action,"set");
		assert.equal(proposal.path,note.path);
		assert.equal(proposal.file,n.file);
		assert.equal(disk.text(note.path),"kept on device");
		assert.ok(d.problems.some(p=>p.includes(note.path)));
	} finally { worker.destroy(); index.destroy(); doc.destroy(); d.crash(); }
});

test("a three-name legacy gap keeps the table name and tells the holder both names once", async () => {
	const { LegacyProjection, legacyBases } = await import("../src/core/table/migration");
	const index = new Y.Doc(), projection = new LegacyProjection(), updates: Uint8Array[] = [];
	const d = new Device("holder",new Server(),rng(28)), disk = new Files();
	try {
		index.on("update", u => updates.push(u));
		for (const p of ["before.md","middle.md","after.md"]) index.getMap("notes").set(note.id,{p});
		for (const n of [0,2]) projection.applyIndex({doc:"index",kind:"update",data:updates[n]!});
		const body = version("keep my text");
		projection.applyDocument({doc:note.id,kind:"snapshot",data:body});
		assert.ok(projection.gaps().includes("after.md"));
		const {row} = (await projection.noteRows(key,0).next()).value!;
		assert.equal(row.path,"before.md");

		d.data.set("index",Y.encodeStateAsUpdate(index));
		d.data.set("state:"+note.id,body);
		d.data.set("note:"+note.id,{diskPath:"after.md",baseHash:hash(enc.encode("keep my text"))});
		disk.edit("after.md","keep my text");
		const {store} = attachmentFs(d.files,d.data);
		await store.commit(await legacyBases(store,key),[]);
		const boot = async () => {
			const t = table(d);
			d.overrides = {tableNotes:t.notes,noteDisk:disk};
			d.boot(); await d.idle();
			return t;
		};
		const first = await boot();
		await first.notes.input({t:"row",row,catchUp:true});
		d.crash(); // row durable, but the local inventory has not run
		const returning = await boot();
		await returning.notes.input({t:"row",row,catchUp:true});
		await d.engine!.initializeNoteFiles(false);
		await returning.notes.input({t:"recheck"});
		assert.equal(returning.notes.state!.notes.get(note.id)?.inFlight,undefined);
		assert.deepEqual([...disk.files.keys()],["before.md"]);
		assert.equal(disk.text("before.md"),"keep my text");
		assert.equal(d.problems.length,1);
		assert.match(d.problems[0]!,/after\.md/);
		assert.match(d.problems[0]!,/before\.md/);
	} finally { projection.close(); index.destroy(); d.crash(); }
});
