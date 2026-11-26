// Durability of the shared Yjs stream and the snapshot ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { Device, Server, quiesce, rng } from "./sim";

function world(n = 2, seed = 1) {
	const server = new Server(), random = rng(seed);
	const devs = Array.from({ length: n }, (_, i) => new Device(`d${i}`, server, random));
	for (const d of devs) { d.data.set("table/migrated", true); d.boot(); void d.engine!.initializeNoteFiles(); d.connect(); }
	return { server, devs };
}
const noProblems = (devs: Device[]) => assert.deepEqual(devs.flatMap((d) => d.problems), []);

test("the snapshot ledger syncs, survives a full index snapshot and supports selective removal", async () => {
	const { server, devs: [a, b] } = world();
	const id = "a".repeat(32), other = "b".repeat(32);
	const entry = { day: 20_000, epoch: 1, parts: ["1".repeat(64), "2".repeat(64)], notesOnly: true, takenAt: 1_728_000_000_000 };
	await quiesce([a!, b!]);
	await a!.engine!.recordSnapshot(id, entry);
	await a!.engine!.recordSnapshot(other, entry);
	await quiesce([a!, b!]);
	const expected = new Map([[id, entry], [other, entry]]);
	assert.deepEqual(await b!.engine!.snapshotLedger(), expected);
	await b!.engine!.recordSnapshot(id, { ...entry, parts: [...entry.parts].reverse() });
	assert.deepEqual(await b!.engine!.snapshotLedger(), expected);

	assert.equal(await a!.engine!.snapshotAll(), true);
	await quiesce([a!, b!]);
	assert.deepEqual(server.rows.map(({ entry }) => [entry.doc, entry.kind]), [["index", "snapshot"]]);
	const c = new Device("c", server, rng(7));
	c.data.set("table/migrated", true); c.boot();
	c.connect();
	const devs = [a!, b!, c];
	await quiesce(devs);
	assert.deepEqual(await c.engine!.snapshotLedger(), expected);

	await b!.engine!.forgetSnapshots([id]);
	await quiesce(devs);
	for (const d of devs) assert.deepEqual(await d.engine!.snapshotLedger(), new Map([[other, entry]]));
	noProblems(devs);
});

test("the snapshot ledger skips malformed entries and forgets all entries across devices", async () => {
	const { server, devs } = world(3);
	const [a, b, peer] = devs;
	const id = "a".repeat(32);
	const entry = { day: 20_000, epoch: 1, parts: ["1".repeat(64)], notesOnly: true, takenAt: 1_728_000_000_000 };
	await quiesce(devs);
	await a!.engine!.recordSnapshot(id, { ...entry, takenAt: Number.MAX_SAFE_INTEGER + 1 });
	assert.deepEqual(await a!.engine!.snapshotLedger(), new Map());
	await a!.engine!.recordSnapshot(id, entry);

	const doc = new Y.Doc();
	const snapshots = doc.getMap("snapshots");
	snapshots.set("B".repeat(32), entry);
	snapshots.set("c".repeat(32), { ...entry, parts: ["invalid"] });
	snapshots.set("d".repeat(32), { ...entry, day: 0.5 });
	server.handle(peer!, { t: "live", entry: { doc: "index", kind: "update", data: Y.encodeStateAsUpdate(doc) } });
	doc.destroy();
	await quiesce(devs);
	assert.deepEqual(await b!.engine!.snapshotLedger(), new Map([[id, entry]]));

	await b!.engine!.forgetSnapshots();
	await quiesce(devs);
	for (const d of devs) assert.deepEqual(await d.engine!.snapshotLedger(), new Map());
	noProblems(devs);
});

test("a failed commit during text catch-up survives later edits and a restart", async () => {
	const {server, devs} = world();
	const [sender, receiver] = devs as [Device, Device];
	await quiesce(devs);
	receiver.disconnect();
	const doc = new Y.Doc(), id = "0000000000000001";
	let request = 0;
	doc.on("update", (data: Uint8Array) => server.handle(sender, {
		t: "publish", id: ++request, entry: {doc: id, kind: "update", data},
	}));
	doc.getText("t").insert(0, "one");
	receiver.failCommits = 1;
	receiver.connect();
	await quiesce(devs);
	doc.getText("t").insert(3, " two");
	await quiesce(devs);
	doc.destroy();
	receiver.crash();
	receiver.boot();
	receiver.connect();
	await quiesce(devs);
	assert.equal(receiver.storedText(id), "one two");
	assert.equal(receiver.failCommits, 0);
	assert.equal(receiver.problems.length, 1);
	assert.match(receiver.problems[0]!, /local database refused a write/);
	noProblems([sender]);
});

test("a failed catch-up page resumes at the last durable cursor on the same connection", async () => {
	const {server, devs} = world();
	const [sender, receiver] = devs as [Device, Device];
	await quiesce(devs);
	receiver.disconnect();
	for (let i = 0; i < 5; i++) {
		const doc = new Y.Doc();
		doc.getText("t").insert(0, "text " + i);
		server.handle(sender, {t: "publish", id: i+1, entry: {doc: String(i), kind: "update", data: Y.encodeStateAsUpdate(doc)}});
		doc.destroy();
	}
	receiver.connect();
	await receiver.idle();
	assert.ok(receiver.pumpUp());
	const page = server.conns.get(receiver)!.down;
	while (page[1]?.t !== "more") {
		assert.equal(page[0]?.t, "entry");
		receiver.pumpDown();
		await receiver.idle();
	}
	receiver.failCommits = 2;
	await quiesce(devs);
	assert.equal(receiver.failCommits, 0);
	for (let i = 0; i < 5; i++) assert.equal(receiver.storedText(String(i)), "text " + i);
	assert.equal((receiver.data.get("meta") as {cursor: number}).cursor, server.head);
	assert.ok(receiver.problems.length > 0 && receiver.problems.every(p => p.includes("local database refused a write")));
	noProblems([sender]);
});
