import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { TableSync } from "../src/tableSync";
import type { NoteRow } from "../src/core/table/notes";
import type { VaultKeys } from "../src/keys";
import { attachmentFs } from "./table-fs";
import { Files } from "./table-sim";
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
		d.data.set("note:" + note.id, { diskPath: note.path, baseHash: "draft", size: 5, mtime: 1 });
		d.files.set(note.path, { content: "draft", mtime: 1 });
		d.overrides = { tableNotes: t.notes };
		d.boot(); await d.idle();
		await t.connect(async () => assert.fail("typing sent a table request"));
		d.connect();
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
