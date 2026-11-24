// Directed scenarios for the sync engine: each one is a rule from engine.ts's header, shown working.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { Ref, Upload } from "../src/core/ports";
import { Device, Server, bytes, latin1, quiesce, rng } from "./sim";

function world(n = 2, seed = 1) {
	const server = new Server(), random = rng(seed);
	const devs = Array.from({ length: n }, (_, i) => new Device(`d${i}`, server, random));
	for (const d of devs) { d.boot(); d.connect(); }
	return { server, devs };
}
const disk = (d: Device) => Object.fromEntries([...d.files].map(([p, f]): [string, string] => [p, latin1(f.content)]).sort());
const noProblems = (devs: Device[]) => assert.deepEqual(devs.flatMap((d) => d.problems), []);

test("a note created, edited, renamed and deleted on one device follows on the other", async () => {
	const { devs: [a, b] } = world();
	await quiesce([a!, b!]);
	a!.write("Plan.md", "first");
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "Plan.md": "first" });
	const id = b!.engine!.noteAt("Plan.md");
	assert.ok(id);
	assert.equal(b!.engine!.pathOf(id), "Plan.md");
	a!.write("Plan.md", "first second");
	a!.rename("Plan.md", "Work/Plan.md");
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "Work/Plan.md": "first second" });
	assert.equal(b!.engine!.pathOf(id), "Work/Plan.md");
	b!.remove("Work/Plan.md");
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), {});
	assert.equal(a!.engine!.pathOf(id), undefined);
	noProblems([a!, b!]);
});

test("edits to the same note while offline merge, with no conflict file", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "one two three");
	await quiesce([a!, b!]);
	a!.disconnect();
	b!.disconnect();
	a!.write("Note.md", "ONE one two three");
	b!.write("Note.md", "one two three FOUR");
	await quiesce([a!, b!]);
	a!.connect();
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), { "Note.md": "ONE one two three FOUR" });
	assert.deepEqual(disk(b!), disk(a!));
	noProblems([a!, b!]);
});

test("a file edited while a remote edit was waiting to be written is merged, not overwritten", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "one two three");
	await quiesce([a!, b!]);
	a!.write("Note.md", "one two three FOUR");
	while (a!.events.length) a!.events.shift()!();
	await a!.idle();
	while (a!.pumpUp()) { /* A's edit reaches the server */ }
	// B's user saves an edit at the very moment the engine is reading the file to apply A's.
	b!.onRead = () => { b!.onRead = null; b!.write("Note.md", "ZERO one two three"); };
	await quiesce([a!, b!]);
	assert.equal(b!.onRead, null, "the race must actually have happened");
	assert.deepEqual(disk(a!), { "Note.md": "ZERO one two three FOUR" });
	assert.deepEqual(disk(b!), disk(a!));
	noProblems([a!, b!]);
});

test("the same new file name on two devices keeps both notes", async () => {
	const { devs: [a, b] } = world();
	await quiesce([a!, b!]);
	a!.disconnect();
	b!.disconnect();
	a!.write("Daily.md", "from A");
	b!.write("Daily.md", "from B");
	await quiesce([a!, b!]);
	a!.connect();
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), disk(b!));
	assert.deepEqual(Object.values(disk(a!)).sort(), ["from A", "from B"]);
	assert.ok("Daily.md" in disk(a!));
	noProblems([a!, b!]);
});

test("deleting a note doesn't destroy an edit the deleter never saw", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "one");
	await quiesce([a!, b!]);
	b!.disconnect();
	b!.write("Note.md", "one two");
	await quiesce([b!]);
	a!.remove("Note.md");
	await quiesce([a!]);
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), { "Note.md": "one two" });
	assert.deepEqual(disk(b!), disk(a!));
	noProblems([a!, b!]);
});

test("another device can list and restore a deleted note with a full snapshot", async () => {
	const server = new Server(), random = rng(1);
	const a = new Device("a", server, random), b = new Device("b", server, random), c = new Device("c", server, random);
	const deletedAt = 1_800_000_000_000;
	a.overrides.now = () => deletedAt;
	b.overrides.now = () => deletedAt + 60_000;
	const devs = [a, b, c];
	for (const d of devs) { d.boot(); d.connect(); }
	const path = "Note.md", text = "the original text";
	a.write(path, text);
	await quiesce(devs);
	const id = a.engine!.noteAt(path)!;
	a.remove(path);
	await quiesce(devs);
	assert.deepEqual(disk(a), {});
	assert.deepEqual(disk(b), {});
	assert.deepEqual(await b.engine!.deletedNotes(), [{ id, path, deletedAt }]);
	assert.equal(await b.engine!.deletedText(id), text);

	// C keeps its index and cursor but drops the deleted note's state. It will only read new entries.
	c.crash();
	c.data.delete(`state:${id}`);
	c.boot();
	assert.deepEqual(await c.engine!.deletedNotes(), []);
	await c.engine!.restoreDeleted(id);
	assert.equal(c.storedIndex().get(id)?.d, a.storedIndex().get(id)?.d);

	const beforeRestore = server.head;
	b.disconnect();
	await b.engine!.restoreDeleted(id);
	assert.deepEqual(disk(b), { [path]: text });
	assert.deepEqual(await b.engine!.deletedNotes(), []);
	b.crash();
	b.boot();
	b.connect();
	await quiesce([a, b]);
	assert.deepEqual(disk(a), { [path]: text });
	assert.deepEqual(disk(b), disk(a));
	assert.ok(server.rows.some(({ seq, entry }) => seq > beforeRestore && entry.doc === id && entry.kind === "snapshot"));
	c.connect();
	await quiesce(devs);
	assert.deepEqual(disk(c), disk(a));
	noProblems(devs);
});

test("a deleted note restored onto a path another note took comes back under a new name, leaving that note alone", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "old text");
	await quiesce([a!, b!]);
	const old = a!.engine!.noteAt("Note.md")!;
	a!.remove("Note.md");
	await quiesce([a!, b!]);
	b!.write("Note.md", "new text");
	await quiesce([a!, b!]);
	const live = b!.engine!.noteAt("Note.md")!;
	assert.notEqual(live, old);
	assert.equal(await a!.engine!.restoreDeleted(old), "Note (restored).md");
	await quiesce([a!, b!]);
	for (const d of [a!, b!]) {
		assert.deepEqual(disk(d), { "Note.md": "new text", "Note (restored).md": "old text" });
		assert.equal(d.engine!.noteAt("Note.md"), live);
	}
	noProblems([a!, b!]);
});

test("a file made where a crash cut short a remote deletion is a new note, so restoring the deleted one loses nothing", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "old");
	await quiesce([a!, b!]);
	const id = a!.engine!.noteAt("Note.md")!;
	a!.remove("Note.md");
	while (a!.events.length) a!.events.shift()!();
	await a!.idle();
	while (a!.pumpUp()) { /* to the server */ }
	// B dies right after removing the file for the deletion, before recording anything: find that point.
	const files = structuredClone([...b!.files]), data = structuredClone([...b!.data]);
	const conn = () => b!.server.conns.get(b!)!, pending = [...conn().down];
	for (let fuse = 1; ; fuse++) {
		assert.ok(fuse < 30, "no crash point right after the file's removal");
		b!.crash(fuse);
		while (b!.pumpDown()) { /* deliver */ }
		await b!.idle();
		if (!b!.alive && !b!.files.has("Note.md")) break;
		if (b!.alive) b!.crash();
		b!.files = new Map(structuredClone(files));
		b!.data = new Map(structuredClone(data));
		b!.boot();
		b!.connect();
		await b!.idle();
		while (b!.pumpUp()) { /* subscribe */ }
		conn().down = [...pending];
		conn().live = true;
	}
	b!.write("Note.md", "new"); // the user, seeing no file, makes a new one there while the app is closed
	b!.boot();
	await b!.idle();
	await a!.engine!.restoreDeleted(id);
	await quiesce([a!]);
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(Object.values(disk(a!)).sort(), ["new", "old"]);
	assert.deepEqual(disk(b!), disk(a!));
	noProblems([a!, b!]);
});

test("Recently deleted lists the last 30 days, at most 200 notes, newest first", async () => {
	let now = 1_800_000_000_000;
	const server = new Server(), a = new Device("a", server, rng(1));
	a.overrides.now = () => now;
	a.boot();
	a.connect();
	const DAY = 24 * 60 * 60 * 1000;
	a.write("Old.md", "old");
	await quiesce([a]);
	a.remove("Old.md");
	await quiesce([a]);
	now += 31 * DAY;
	for (let i = 0; i < 201; i++) a.write(`N${i}.md`, `note ${i}`);
	await quiesce([a]);
	for (let i = 0; i < 201; i++) { now += 1000; a.remove(`N${i}.md`); await quiesce([a]); }
	const listed = await a.engine!.deletedNotes();
	assert.equal(listed.length, 200);
	assert.deepEqual(listed.slice(0, 2).map((n) => n.path), ["N200.md", "N199.md"]);
	assert.ok(!listed.some((n) => n.path === "Old.md" || n.path === "N0.md"));
	assert.equal(await a.engine!.deletedText(listed[0]!.id), "note 200");
	noProblems([a]);
});

// The failures the test caused, and nothing else.
const onlyRefusedWrites = (devs: Device[]) => assert.deepEqual(devs.flatMap((d) => d.problems).filter((p) => !p.includes("the local database refused a write")), []);

test("a failed database commit loses no remote edit, even after later commits move the cursor on", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "one");
	await quiesce([a!, b!]);
	// Read from the stored entry alone (no live copy of the edit to mask the loss), and its commit fails.
	b!.disconnect();
	a!.write("Note.md", "one two");
	await quiesce([a!, b!]);
	b!.failCommits = 1;
	b!.connect();
	await quiesce([a!, b!]);
	a!.write("Note.md", "one two three");
	await quiesce([a!, b!]);
	assert.equal(b!.failCommits, 0);
	b!.crash();
	b!.boot();
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "Note.md": "one two three" });
	onlyRefusedWrites([a!, b!]);
});

test("a catch-up page whose commit fails is read again, not left waiting for the next connection", async () => {
	const { devs: [a, b] } = world();
	b!.disconnect();
	for (let i = 0; i < 5; i++) a!.write(`N${i}.md`, `note ${i}`);
	await quiesce([a!]);
	b!.connect();
	// The last entry of the first page fails to commit, and so does the page's end, which would ask for the next.
	for (let more = false; !more;) {
		while (b!.pumpUp());
		if (b!.server.conns.get(b!)!.down[1]?.t === "more") { b!.failCommits = 2; more = true; }
		b!.pumpDown();
		await b!.idle();
	}
	await quiesce([a!, b!]);
	assert.equal(b!.failCommits, 0);
	assert.deepEqual(disk(b!), disk(a!));
	onlyRefusedWrites([a!, b!]);
});

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
	c.boot();
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

test("typing in an editor reaches the other device's editor and file", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "one");
	await quiesce([a!, b!]);
	const ea = (await a!.engine!.open(a!.engine!.noteAt("Note.md")!))!, eb = (await b!.engine!.open(b!.engine!.noteAt("Note.md")!))!;
	ea.getText("t").insert(3, " two");
	await quiesce([a!, b!]);
	assert.equal(eb.getText("t").toString(), "one two");
	await b!.engine!.close(b!.engine!.noteAt("Note.md")!);
	await quiesce([a!, b!]);
	assert.equal(disk(b!)["Note.md"], "one two");
	noProblems([a!, b!]);
});

test("a note open on both devices, deleted after the editor saved the other device's typing, stays deleted", async () => {
	const { server, devs: [a, b] } = world();
	a!.write("Note.md", "hello");
	await quiesce([a!, b!]);
	const id = a!.engine!.noteAt("Note.md")!;
	const ea = (await a!.engine!.open(id))!, eb = (await b!.engine!.open(id))!;
	eb.getText("t").insert(5, " from B");
	await b!.idle();
	while (b!.pumpUp()) { /* B's edit goes out live, and to be stored */ }
	assert.deepEqual(server.conns.get(a!)!.down.map((m) => m.t), ["live", "entry"]);
	a!.pumpDown(); // the live edit reaches A's editor
	await a!.idle();
	a!.write("Note.md", ea.getText("t").toString()); // A's editor saves it
	await quiesce([a!, b!]); // the same edit arrives again, stored
	a!.remove("Note.md");
	await a!.engine!.close(id); // the editor goes with its file
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), {});
	assert.deepEqual(disk(b!), {});
	noProblems([a!, b!]);
});

test("a device that joins with its own copy of the vault adopts identical notes and keeps different ones", async () => {
	const { server, devs: [a] } = world(1);
	a!.write("Same.md", "same text");
	a!.write("Differs.md", "A's version");
	await quiesce([a!]);
	const c = new Device("c", server, rng(7));
	c.files.set("Same.md", { content: "same text", mtime: 1 });
	c.files.set("Differs.md", { content: "C's version", mtime: 2 });
	c.files.set("OnlyC.md", { content: "only on C", mtime: 3 });
	c.boot();
	c.connect();
	await quiesce([a!, c]);
	assert.deepEqual(disk(a!), disk(c));
	assert.deepEqual(Object.values(disk(c)).sort(), ["A's version", "C's version", "only on C", "same text"]);
	noProblems([a!, c]);
});

test("a crash between recording a remote edit and writing the file is finished at the next start", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "one");
	await quiesce([a!, b!]);
	a!.write("Note.md", "one two");
	while (a!.events.length) a!.events.shift()!();
	await a!.idle();
	while (a!.pumpUp()) { /* to the server */ }
	// B dies somewhere inside handling it, at every possible point in turn.
	let crashedMidway = 0;
	for (let fuse = 1; fuse < 30; fuse++) {
		const snapshotFiles = structuredClone([...b!.files]), snapshotData = structuredClone([...b!.data]);
		const pending = [...b!.server.conns.get(b!)!.down];
		b!.crash(fuse);
		while (b!.pumpDown()) { /* deliver */ }
		await b!.idle();
		if (b!.alive) b!.crash();
		else crashedMidway++;
		b!.boot();
		b!.connect();
		await quiesce([a!, b!]);
		assert.deepEqual(disk(b!), { "Note.md": "one two" }, `crash after ${fuse} calls`);
		assert.deepEqual(b!.problems, []);
		// Rewind B to before the edit arrived, and try the next crash point.
		b!.crash();
		b!.files = new Map(snapshotFiles);
		b!.data = new Map(snapshotData);
		b!.boot();
		b!.connect();
		await b!.idle();
		const conn = b!.server.conns.get(b!)!;
		while (b!.pumpUp()) { /* subscribe */ }
		conn.down = [];
		conn.down.push(...pending);
		conn.live = true;
	}
	assert.ok(crashedMidway >= 5, `only ${crashedMidway} crash points were inside the operation`);
});

// --- attachments (the simulator splits them into 4-byte chunks) ---

const PIC = "\x89PNG\0\0\0\rIHDR\0\0\xff\xfe pixels";
const PIC2 = "\x89PNG\0\0\0\rIHDR\0\0\x01\x02 other pixels";

test("an attachment created, replaced, renamed and deleted on one device follows on the other, byte for byte", async () => {
	const { server, devs: [a, b] } = world();
	await quiesce([a!, b!]);
	a!.write("img/Photo.png", bytes(PIC));
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "img/Photo.png": PIC });
	assert.ok(b!.files.get("img/Photo.png")!.content instanceof Uint8Array);
	const stored = server.chunks.size;
	a!.write("img/Copy.png", bytes(PIC)); // the same content again: no chunk stored twice
	await quiesce([a!, b!]);
	assert.equal(server.chunks.size, stored);
	b!.write("img/Photo.png", bytes(PIC2));
	b!.rename("img/Photo.png", "Photo 2.png");
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), { "Photo 2.png": PIC2, "img/Copy.png": PIC });
	a!.remove("Photo 2.png");
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "img/Copy.png": PIC });
	noProblems([a!, b!]);
});

test("an attachment replaced on two devices at once keeps both versions, one as a conflict copy", async () => {
	const { devs: [a, b, c] } = world(3);
	a!.write("p.png", bytes(PIC));
	await quiesce([a!, b!, c!]);
	a!.disconnect();
	b!.disconnect();
	a!.write("p.png", bytes("from A"));
	b!.write("p.png", bytes("from B"));
	await quiesce([a!, b!, c!]);
	a!.connect();
	b!.connect();
	await quiesce([a!, b!, c!]);
	assert.deepEqual(disk(a!), disk(b!));
	assert.deepEqual(disk(c!), disk(a!));
	assert.deepEqual(Object.values(disk(a!)).sort(), ["from A", "from B"]);
	assert.ok("p.png" in disk(a!));
	assert.match(Object.keys(disk(a!)).find((p) => p !== "p.png")!, /^p \(conflict [0-9a-f]{6}\)\.png$/);
	// Online too: each replaces it before the other's version arrives.
	a!.write("p.png", bytes("A again"));
	b!.write("p.png", bytes("B again"));
	await quiesce([a!, b!, c!]);
	assert.deepEqual(disk(a!), disk(b!));
	assert.deepEqual(disk(c!), disk(a!));
	assert.deepEqual(Object.values(disk(a!)).filter((t) => t.includes("again")).sort(), ["A again", "B again"]);
	noProblems([a!, b!, c!]);
});

test("the same new attachment name on two devices keeps both, and both stay that kind of file", async () => {
	const { devs: [a, b] } = world();
	await quiesce([a!, b!]);
	a!.disconnect();
	a!.write("scan.pdf", bytes("A's scan"));
	b!.write("scan.pdf", bytes("B's scan"));
	await quiesce([a!, b!]);
	a!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), disk(b!));
	assert.deepEqual(Object.values(disk(a!)).sort(), ["A's scan", "B's scan"]);
	assert.ok(Object.keys(disk(a!)).every((p) => p.endsWith(".pdf")));
	noProblems([a!, b!]);
});

test("the same new attachment, byte for byte, on two devices at one path is one file, not a conflict copy", async () => {
	const { devs: [a, b] } = world();
	await quiesce([a!, b!]);
	a!.disconnect();
	a!.write("scan.pdf", bytes("one scan"));
	b!.write("scan.pdf", bytes("one scan"));
	await quiesce([a!, b!]);
	a!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), { "scan.pdf": "one scan" });
	assert.deepEqual(disk(b!), disk(a!));
	noProblems([a!, b!]);
});

async function twins() {
	const { devs } = world();
	const [a, b] = devs as [Device, Device];
	await quiesce(devs);
	a.disconnect();
	a.write("p.png", bytes(PIC));
	b.write("p.png", bytes(PIC));
	await quiesce(devs);
	a.connect();
	await quiesce(devs);
	const rep = a.engine!.noteAt("p.png")!;
	const [hidden] = [...a.storedIndex()].filter(([id, v]) => id !== rep && v.p === "p.png" && v.d === undefined);
	assert.ok(hidden);
	return { devs, a, b, rep, twin: hidden[0] };
}

// Apply a peer's causally valid change before the waiting upload is acknowledged.
function peerUpdate(d: Device, id: string, change: (doc: Y.Doc) => void) {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, d.data.get(id === "index" ? id : `state:${id}`) as Uint8Array);
	const before = Y.encodeStateVector(doc);
	change(doc);
	const entry = { doc: id, data: Y.encodeStateAsUpdate(doc, before), kind: "update" as const };
	doc.destroy();
	return { t: "live" as const, entry };
}

test("editing a split child shown at its twin's plain path keeps the plain name", async () => {
	const { devs, a, b, rep, twin } = await twins();
	const suffix = `p (conflict ${rep.slice(0, 6)}).png`;
	const move = peerUpdate(b, "index", (doc) => doc.getMap("notes").set(rep, { p: suffix }));
	for (const d of devs) await d.engine!.receive(move);
	await quiesce(devs);
	assert.equal(a.engine!.noteAt("p.png"), rep);
	a.write("p.png", bytes(PIC2));
	await quiesce(devs);
	for (const d of devs) {
		assert.equal(d.storedIndex().get(rep)?.p, "p.png");
		assert.ok(d.storedIndex().get(twin)?.d);
		assert.deepEqual(disk(d), { "p.png": PIC2 });
	}
	noProblems(devs);
});

test("renaming while an edit uploads retires the observed twin at the new claim", async () => {
	const { devs, a, b, twin } = await twins();
	a.disconnect();
	a.write("p.png", bytes(PIC2));
	await quiesce([a]);
	a.rename("p.png", "new.png");
	await quiesce([a]);
	a.connect();
	await quiesce(devs);
	assert.ok(b.storedIndex().get(twin)?.d);
	for (const d of devs) assert.deepEqual(disk(d), { "new.png": PIC2 });
	noProblems(devs);
});

test("an abandoned first upload leaves a different-content conflict file visible", async () => {
	const { devs } = world();
	const [a, b] = devs as [Device, Device];
	await quiesce(devs);
	b.disconnect();
	b.write("p.png", bytes(PIC));
	await quiesce([b]);
	const pending = b.engine!.noteAt("p.png")!;
	const index = b.data.get("index") as Uint8Array;
	assert.ok(b.data.has(`up:${pending}`));
	b.crash(); // its index reached the peer, but its version never did
	await a.engine!.receive({ t: "live", entry: { doc: "index", kind: "update", data: index } });
	let next = 0;
	a.engine!["opts"].newId = () => "ffffff" + (++next).toString(16).padStart(10, "0");
	a.write("p.png", bytes(PIC2));
	await quiesce([a]);
	assert.deepEqual(disk(a), { "p (conflict ffffff).png": PIC2 });
	noProblems([a]);
});

test("startup leaves singleton heads cold and reads them when a rename joins their claims", async () => {
	const { devs } = world();
	const [a, b] = devs as [Device, Device];
	a.write("p.png", bytes(PIC));
	a.write("q.png", bytes(PIC));
	await quiesce(devs);
	const p = a.engine!.noteAt("p.png")!, q = a.engine!.noteAt("q.png")!;
	a.crash();
	a.boot();
	const reads: string[] = [], head = a.engine!["head"].bind(a.engine);
	a.engine!["head"] = (id) => { reads.push(id); return head(id); };
	await quiesce([a]);
	assert.deepEqual(reads, [], "loading the saved index did not resettle the unchanged singleton files");
	assert.ok([p, q].every((id) => !a.engine!["heads"].has(id)));
	const move = peerUpdate(b, "index", (doc) => doc.getMap("notes").set(q, { p: "p.png" }));
	await a.engine!.receive(move);
	await quiesce([a]);
	assert.ok([p, q].every((id) => a.engine!["heads"].get(id)));
	assert.deepEqual(disk(a), { "p.png": PIC });
	noProblems(devs);
});

test("a hidden twin follows a startup rename and a deletion, and its group restores exactly once", async () => {
	const { devs, a, b, rep, twin } = await twins();
	a.crash();
	a.rename("p.png", "moved.png");
	a.boot();
	a.connect();
	await quiesce(devs);
	for (const id of [rep, twin]) assert.equal(b.storedIndex().get(id)?.p, "moved.png");
	b.remove("moved.png");
	await quiesce(devs);
	assert.deepEqual(disk(a), {});
	const entries = await a.engine!.deletedNotes();
	assert.deepEqual(entries.map((e) => e.path), ["moved.png"]);
	assert.equal(await a.engine!.restoreAttachment(entries[0]!.id), "moved.png");
	await quiesce(devs);
	assert.deepEqual(disk(b), { "moved.png": PIC });
	b.write("moved.png", bytes(PIC2));
	await quiesce(devs);
	assert.deepEqual(await b.engine!.deletedNotes(), []);
	assert.equal(await a.engine!.restoreAttachment(twin), undefined);
	noProblems(devs);
});

test("startup follows a shared file moved after its new owner was committed but before handover", async () => {
	const { devs, a, b, rep, twin } = await twins();
	a.crash();
	a.data.set(`note:${twin}`, a.data.get(`note:${rep}`));
	a.data.delete(`note:${rep}`);
	a.rename("p.png", "moved.png");
	a.boot();
	a.connect();
	await quiesce(devs);
	assert.deepEqual(disk(b), { "moved.png": PIC });
	for (const id of [rep, twin]) assert.equal(b.storedIndex().get(id)?.p, "moved.png");
	noProblems(devs);
});

test("removing only the shown claim hands its file to the hidden twin in place", async () => {
	const { devs, a, b, rep, twin } = await twins();
	const state = new Y.Doc();
	Y.applyUpdate(state, a.data.get(`state:${rep}`) as Uint8Array);
	const d = Buffer.from(Y.encodeStateVector(state)).toString("base64");
	state.destroy();
	const deletion = peerUpdate(a, "index", (doc) => doc.getMap("notes").set(rep, { p: "p.png", d }));
	const lines: string[] = [];
	a.trace = (line) => lines.push(line);
	for (const device of devs) await device.engine!.receive(deletion);
	await quiesce(devs);
	assert.equal(a.engine!.noteAt("p.png"), twin);
	assert.deepEqual(disk(b), { "p.png": PIC });
	assert.deepEqual(lines.filter((l) => /engine (writes|removes|renames)|→ server get/.test(l)), []);
	noProblems(devs);
});

test("a representative that already has a file moves it onto the freed shared path", async () => {
	const { devs } = world();
	const [a, b] = devs as [Device, Device];
	for (const p of ["p.png", "q.png"]) a.write(p, bytes(PIC));
	await quiesce(devs);
	const ids = [a.engine!.noteAt("p.png")!, a.engine!.noteAt("q.png")!].sort();
	const rep = ids[0]!, path = a.pathOf(ids[1]!)!;
	const move = peerUpdate(a, "index", (doc) => doc.getMap("notes").set(rep, { p: path }));
	const before = a.files.get(a.pathOf(rep)!);
	for (const d of devs) await d.engine!.receive(move);
	await quiesce(devs);
	assert.equal(a.files.get(path), before, "the representative moved its own file");
	assert.equal(a.engine!.noteAt(path), rep);
	assert.deepEqual(disk(b), { [path]: PIC });
	noProblems(devs);
});

test("resaving and restarting an upload preserves its first observed members and versions", async () => {
	for (const move of [true, false]) {
		const { devs, a, b, rep, twin } = await twins();
		a.disconnect();
		a.write("p.png", bytes("first save"));
		await quiesce([a]);
		const seen = (a.data.get(`up:${rep}`) as Upload).seen;
		assert.deepEqual(seen?.map((copy) => copy.id), [twin]);
		const changed = move ? peerUpdate(b, "index", (doc) => doc.getMap("notes").set(twin, { p: "q.png" })) :
			peerUpdate(b, twin, (doc) => {
				const v = doc.getArray<Ref>("v"), same = { ...v.get(0), u: "deadcafe00000000" };
				v.delete(0, v.length);
				v.push([same]);
			});
		for (const d of devs) await d.engine!.receive(changed);
		a.write("p.png", bytes("second save"));
		await quiesce([a]);
		assert.deepEqual((a.data.get(`up:${rep}`) as Upload).seen, seen);
		a.crash();
		a.boot();
		a.connect();
		await quiesce(devs);
		assert.deepEqual(Object.values(disk(b)).sort(), [PIC, "second save"].sort());
		assert.equal(b.storedIndex().get(twin)?.d, undefined);
		noProblems(devs);
	}
});

test("an upload whose disk owner becomes hidden survives restart", async () => {
	const { devs } = world();
	const [a, b] = devs as [Device, Device];
	a.write("p.png", bytes(PIC));
	await quiesce(devs);
	const id = a.engine!.noteAt("p.png")!, smaller = "0000010000000000";
	a.disconnect();
	a.write("p.png", bytes(PIC2));
	await quiesce([a]);
	const stored = new Y.Doc(), independent = new Y.Doc();
	Y.applyUpdate(stored, a.data.get(`state:${id}`) as Uint8Array);
	independent.getArray<Ref>("v").push([{ ...stored.getArray<Ref>("v").get(0), u: "0000020000000000" }]);
	const state = Y.encodeStateAsUpdate(independent);
	stored.destroy();
	independent.destroy();
	const index = peerUpdate(b, "index", (doc) => doc.getMap("notes").set(smaller, { p: "p.png" }));
	for (const d of devs) {
		await d.engine!.receive({ t: "live", entry: { doc: smaller, data: state, kind: "snapshot" } });
		await d.engine!.receive(index);
	}
	assert.ok(a.data.has(`up:${id}`));
	assert.deepEqual(disk(a), { "p.png": PIC2 });
	a.crash();
	a.boot();
	a.connect();
	await quiesce(devs);
	assert.deepEqual(Object.values(disk(b)).sort(), [PIC, PIC2].sort());
	assert.deepEqual(disk(a), disk(b));
	noProblems(devs);
});

test("crashing immediately after unlinking an identical conflict file preserves both claims", async () => {
	const { devs } = world();
	const [a, b] = devs as [Device, Device];
	await quiesce(devs);
	a.disconnect();
	a.write("p.png", bytes(PIC));
	b.write("p.png", bytes(PIC2));
	await quiesce(devs);
	a.connect();
	await quiesce(devs);
	const copy = [...a.files.keys()].find((p) => p.includes(" (conflict "))!;
	const source = a.files.get("p.png")!.content;
	a.trace = (line) => { if (line.endsWith(`engine removes ${copy}`)) a.crash(1); };
	a.write(copy, source);
	await quiesce(devs);
	assert.equal(a.alive, false);
	assert.equal(a.files.has(copy), false);
	a.trace = null;
	a.boot();
	a.connect();
	await quiesce(devs);
	assert.equal([...b.storedIndex()].filter(([, v]) => v.d === undefined && v.p === "p.png").length, 2);
	assert.deepEqual(disk(a), { "p.png": latin1(source) });
	assert.deepEqual(disk(a), disk(b));
	noProblems(devs);
});

test("two devices splitting identical concurrent siblings show one conflict file", async () => {
	const { devs } = world();
	const [a, b] = devs as [Device, Device];
	a.write("p.png", bytes(PIC));
	a.write("source.bin", bytes(PIC2));
	await quiesce(devs);
	const id = a.engine!.noteAt("p.png")!, source = a.engine!.noteAt("source.bin")!;
	const doc = new Y.Doc();
	Y.applyUpdate(doc, a.data.get(`state:${source}`) as Uint8Array);
	const ref = doc.getArray<Ref>("v").get(0);
	doc.destroy();
	const versions = ["1111111111000000", "2222222222000000"];
	const concurrent = versions.map((u) => peerUpdate(a, id, (d) => d.getArray<Ref>("v").push([{ ...ref, u }])));
	await a.engine!.receive(concurrent[0]!);
	await b.engine!.receive(concurrent[1]!);
	await a.engine!.receive(concurrent[1]!);
	await b.engine!.receive(concurrent[0]!);
	await quiesce(devs);
	for (const version of versions) assert.ok(a.storedIndex().has(version));
	assert.deepEqual(disk(a), { "p.png": PIC, "p (conflict 111111).png": PIC2, "source.bin": PIC2 });
	assert.deepEqual(disk(a), disk(b));
	noProblems(devs);
});

test("an orphan conflict copy moved back to its original name on both devices comes back as one file", async () => {
	const { devs: [a, b] } = world();
	const P = "Templates/Bases/People.base";
	a!.write(P, bytes("orig"));
	await quiesce([a!, b!]);
	a!.disconnect();
	b!.disconnect();
	a!.write(P, bytes("from A"));
	b!.write(P, bytes("from B"));
	a!.connect();
	b!.connect();
	await quiesce([a!, b!]);
	a!.remove(P); // the original is gone: only the copy is left
	await quiesce([a!, b!]);
	const [copy] = Object.keys(disk(a!));
	assert.match(copy!, /People \(conflict [0-9a-f]{6}\)\.base$/);
	const content = disk(a!)[copy!];
	// A's app is closed while the copy is renamed back on disk. On B the same move reaches the engine as a deletion
	// and a new file (another program moved it): the engine sees new bytes at the path, not the copy.
	a!.crash();
	a!.rename(copy!, P);
	const bytesOnB = b!.files.get(copy!)!.content;
	b!.remove(copy!);
	b!.write(P, bytesOnB);
	a!.boot();
	a!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), { [P]: content });
	assert.deepEqual(disk(b!), disk(a!));
	noProblems([a!, b!]);
});

test("deleting an attachment doesn't destroy a version the deleter never saw", async () => {
	const { devs: [a, b] } = world();
	a!.write("p.png", bytes(PIC));
	await quiesce([a!, b!]);
	b!.disconnect();
	b!.write("p.png", bytes(PIC2));
	await quiesce([b!]);
	a!.remove("p.png");
	await quiesce([a!]);
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), { "p.png": PIC2 });
	assert.deepEqual(disk(b!), disk(a!));
	noProblems([a!, b!]);
});

test("an attachment renamed while the app was closed is found by its content, not deleted and re-added", async () => {
	const { server, devs: [a, b] } = world();
	a!.write("p.png", bytes(PIC));
	await quiesce([a!, b!]);
	const id = a!.engine!.noteAt("p.png");
	a!.crash();
	a!.rename("p.png", "moved/p.png");
	const stored = server.chunks.size;
	a!.boot();
	a!.connect();
	await quiesce([a!, b!]);
	assert.equal(a!.engine!.noteAt("moved/p.png"), id);
	assert.deepEqual(disk(b!), { "moved/p.png": PIC });
	assert.equal(server.chunks.size, stored);
	noProblems([a!, b!]);
});

test("a crash at any point of an upload is recovered: the other device gets the whole file", async () => {
	let crashedMidway = 0;
	for (let fuse = 1; fuse < 40; fuse++) {
		const { server, devs: [a, b] } = world(2, fuse);
		await quiesce([a!, b!]);
		a!.crash(fuse);
		a!.write("p.png", bytes(PIC));
		await quiesce([a!, b!]);
		if (a!.alive) a!.crash(1e9);
		else crashedMidway++;
		// Whatever B has, it is never part of the file.
		assert.ok(!b!.files.has("p.png") || latin1(b!.files.get("p.png")!.content) === PIC, `crash after ${fuse} calls`);
		if (!a!.alive) { a!.boot(); a!.connect(); }
		await quiesce([a!, b!]);
		assert.deepEqual(disk(b!), { "p.png": PIC }, `crash after ${fuse} calls`);
		assert.ok([...server.chunks.values()].every((c) => c.length <= 4));
		noProblems([a!, b!]);
	}
	assert.ok(crashedMidway >= 10, `only ${crashedMidway} crash points were inside the operation`);
});

test("a crash at any point of a download is recovered, and never leaves part of a file", async () => {
	let crashedMidway = 0;
	for (let fuse = 1; fuse < 40; fuse++) {
		const { devs: [a, b] } = world(2, fuse);
		a!.write("p.png", bytes(PIC));
		await quiesce([a!, b!]);
		a!.write("p.png", bytes(PIC2));
		b!.crash(fuse);
		await quiesce([a!, b!]);
		if (b!.alive) b!.crash(1e9);
		else crashedMidway++;
		assert.ok([PIC, PIC2].includes(disk(b!)["p.png"]!), `crash after ${fuse} calls: ${disk(b!)["p.png"]}`);
		if (!b!.alive) { b!.boot(); b!.connect(); }
		await quiesce([a!, b!]);
		assert.deepEqual(disk(b!), { "p.png": PIC2 }, `crash after ${fuse} calls`);
		noProblems([a!, b!]);
	}
	assert.ok(crashedMidway >= 10, `only ${crashedMidway} crash points were inside the operation`);
});

test("a chunk missing on the server is retried, and the file is never written without it", async () => {
	const { server, devs: [a, b] } = world();
	b!.disconnect();
	a!.write("p.png", bytes(PIC));
	await quiesce([a!]);
	const [name, data] = [...server.chunks][1]!;
	server.chunks.delete(name);
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), {});
	assert.equal(b!.problems.length, 1);
	assert.match(b!.problems[0]!, /missing on the server/);
	b!.problems = [];
	server.chunks.set(name, data);
	b!.disconnect();
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "p.png": PIC });
	noProblems([a!, b!]);
});

test("an attachment over the size limit is reported and left alone, on both sides", async () => {
	const { devs: [a, b] } = world();
	for (const d of [a!, b!]) { d.overrides = { maxFileSize: 20 }; d.crash(); d.boot(); d.connect(); }
	await quiesce([a!, b!]);
	a!.write("big.bin", bytes("x".repeat(21)));
	a!.write("small.bin", bytes(PIC.slice(0, 20)));
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "small.bin": PIC.slice(0, 20) });
	assert.match(a!.problems.join("\n"), /big\.bin.*larger than/);
	a!.problems = [];
	// Grown over the limit here and replaced there: neither side's version is overwritten.
	a!.write("small.bin", bytes("y".repeat(30)));
	b!.write("small.bin", bytes("z"));
	await quiesce([a!, b!]);
	assert.equal(disk(a!)["small.bin"], "y".repeat(30));
	assert.equal(disk(b!)["small.bin"], "z");
	assert.match(a!.problems.join("\n"), /small\.bin.*larger than/);
	assert.deepEqual(b!.problems, []);
});

test("a device that syncs notes only leaves attachments alone, then catches up when they're turned back on", async () => {
	const { devs: [a, b] } = world();
	await quiesce([a!, b!]);
	a!.write("Note.md", "hello");
	a!.write("img/Photo.png", bytes(PIC));
	await quiesce([a!, b!]);
	// B (a phone, say) switches to notes only: its copy stays on its disk but no longer syncs either way.
	b!.crash();
	b!.overrides = { ...b!.overrides, attachments: false };
	b!.boot();
	b!.connect();
	b!.remove("img/Photo.png"); // deleting it here costs A nothing
	b!.write("Local.png", bytes(PIC2)); // nor does anything new here reach A
	a!.write("img/Photo.png", bytes(PIC2)); // and A's change doesn't come down
	a!.write("Other.png", bytes(PIC));
	a!.write("Note.md", "hello again");
	await quiesce([a!, b!]);
	assert.deepEqual(disk(a!), { "Note.md": "hello again", "Other.png": PIC, "img/Photo.png": PIC2 });
	assert.deepEqual(disk(b!), { "Local.png": PIC2, "Note.md": "hello again" });
	// Attachments back on: B finds its own file, uploads it, and downloads what it was missing.
	b!.crash();
	b!.overrides = { ...b!.overrides, attachments: true };
	b!.boot();
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "Local.png": PIC2, "Note.md": "hello again", "Other.png": PIC, "img/Photo.png": PIC2 });
	assert.deepEqual(disk(a!), disk(b!));
	noProblems([a!, b!]);
});

// A note open in an editor whose typing is on record, and whose editor saved an older version last: the file
// holds nothing the document lacks, so a crash (a phone killing the app, say) must not leave a recovery copy.
async function typedAheadOfSave(b: Device, id: string) {
	const eb = (await b.engine!.open(id))!, t = eb.getText("t");
	t.insert(t.length, " This is test content");
	await b.idle();
	b.write(b.pathOf(id)!, t.toString()); // the editor saves
	t.insert(t.length, " hhh"); // and the user types on before the engine handles that save
	await b.idle();
	b.drain();
	await b.idle();
	return eb;
}
const copies = (d: Device) => [...d.files.keys()].filter((p) => p.includes("(recovered "));

test("a crash with a note open whose typing is on record leaves no recovery copy", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "hello");
	await quiesce([a!, b!]);
	await typedAheadOfSave(b!, b!.engine!.noteAt("Note.md")!);
	await quiesce([a!, b!]);
	b!.crash();
	b!.boot();
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "Note.md": "hello This is test content hhh" });
	assert.deepEqual(disk(a!), disk(b!));
	noProblems([a!, b!]);
});

test("a note open when the app was killed, before this device ever caught up, keeps typing its file never got", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "hello");
	await quiesce([a!, b!]);
	const id = b!.engine!.noteAt("Note.md")!;
	// As if the first catch-up never finished: startup doesn't look at the files, and file events wait for it.
	b!.crash();
	b!.data.set("meta", { ...(b!.data.get("meta") as object), synced: false });
	b!.boot();
	const t = (await b!.engine!.open(id))!.getText("t");
	t.insert(t.length, " world");
	await b!.idle();
	b!.write("Note.md", t.toString()); // the editor saves
	t.insert(t.length, " again"); // typing on record, never saved
	await b!.idle();
	b!.crash();
	b!.boot();
	assert.equal((await b!.engine!.open(id))!.getText("t").toString(), "hello world again");
	b!.connect();
	await quiesce([a!, b!]);
	assert.equal(a!.files.get("Note.md")?.content, "hello world again");
	noProblems([a!, b!]);
});

test("a note deleted elsewhere while open here, its typing synced, stays deleted with no copy, even if this app was killed", async () => {
	for (const killed of [false, true]) {
		const { devs: [a, b] } = world();
		a!.write("Note.md", "hello");
		await quiesce([a!, b!]);
		await typedAheadOfSave(b!, b!.engine!.noteAt("Note.md")!);
		await quiesce([a!, b!]);
		if (killed) b!.crash();
		a!.remove("Note.md");
		await quiesce([a!, b!]);
		if (killed) { b!.boot(); b!.connect(); }
		await quiesce([a!, b!]);
		assert.deepEqual(disk(b!), {}, `killed: ${killed}`);
		assert.deepEqual(disk(a!), {}, `killed: ${killed}`);
		noProblems([a!, b!]);
	}
});

test("a note deleted elsewhere while open here with typing that never left this device keeps that typing", async () => {
	for (const killed of [false, true]) {
		const { devs: [a, b] } = world();
		a!.write("Note.md", "hello");
		await quiesce([a!, b!]);
		b!.disconnect();
		const id = b!.engine!.noteAt("Note.md")!, eb = await typedAheadOfSave(b!, id);
		if (killed) b!.crash();
		a!.remove("Note.md");
		await quiesce([a!, b!]);
		if (killed) b!.boot();
		b!.connect();
		await quiesce([a!, b!]);
		if (!killed) { // the editor saves what it shows, and closes
			b!.write(b!.pathOf(id)!, eb.getText("t").toString());
			await b!.engine!.close(id);
			await quiesce([a!, b!]);
		}
		const all = Object.values(disk(b!)).join(" ");
		assert.ok(all.includes("This is test content") && all.includes("hhh"), `killed: ${killed}: ${JSON.stringify(disk(b!))}`);
		assert.deepEqual(disk(a!), disk(b!));
		noProblems([a!, b!]);
	}
});

test("text that reached a crashed note's file only, and a recovery copy then open and killed, make one copy, not a copy of a copy", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "hello");
	await quiesce([a!, b!]);
	const id = b!.engine!.noteAt("Note.md")!;
	const eb = (await b!.engine!.open(id))!;
	eb.getText("t").insert(5, " world");
	await quiesce([a!, b!]);
	b!.crash();
	b!.write("Note.md", "hello gghjjhuu"); // typed with the app down: only the file has it
	b!.boot();
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "Note.md": "hello world", [`Note (recovered ${id.slice(0, 6)}).md`]: "hello gghjjhuu" });
	// The copy is opened, typed in, and the app is killed again.
	await typedAheadOfSave(b!, b!.engine!.noteAt(copies(b!)[0]!)!);
	await quiesce([a!, b!]);
	b!.crash();
	b!.boot();
	b!.connect();
	await quiesce([a!, b!]);
	assert.deepEqual(copies(b!), [`Note (recovered ${id.slice(0, 6)}).md`]);
	assert.equal(disk(b!)[copies(b!)[0]!], "hello gghjjhuu This is test content hhh");
	assert.deepEqual(disk(a!), disk(b!));
	noProblems([a!, b!]);
});

test("an editor closed before saving its last typing leaves no recovery copy", async () => {
	const { devs: [a, b] } = world();
	a!.write("Note.md", "one\ntwo\nthree\nfour");
	await quiesce([a!, b!]);
	const id = b!.engine!.noteAt("Note.md")!, eb = (await b!.engine!.open(id))!;
	eb.getText("t").insert(eb.getText("t").length, " more");
	await quiesce([a!, b!]);
	await b!.engine!.close(id); // the editor's last save is still the version it opened
	await quiesce([a!, b!]);
	assert.deepEqual(disk(b!), { "Note.md": "one\ntwo\nthree\nfour more" });
	assert.deepEqual(disk(a!), disk(b!));
	noProblems([a!, b!]);
});
