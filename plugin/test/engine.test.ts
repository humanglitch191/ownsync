// Directed scenarios for the sync engine: each one is a rule from engine.ts's header, shown working.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
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
