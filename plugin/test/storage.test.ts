// Version-scoped chunks and Clean up (DESIGN.md section 10), in the simulator: what the owner removes on the
// dashboard is only ever history, whatever the devices did meanwhile.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { Ref } from "../src/core/ports";
import { Device, SCOPED, Server, bytes, latin1, quiesce, rng } from "./sim";

const DAY = 86_400_000;
const PIC = "\x89PNG\0\0\0\rIHDR\0\0\xff\xfe pixels";
const PIC2 = "\x89PNG\0\0\0\rIHDR\0\0\x01\x02 other pixels";

function world(n = 2, seed = 1, setup?: (d: Device, i: number) => void) {
	const server = new Server(), random = rng(seed);
	const devs = Array.from({ length: n }, (_, i) => new Device(`d${i}`, server, random));
	devs.forEach((d, i) => { d.overrides = { ...SCOPED }; setup?.(d, i); d.boot(); d.connect(); });
	return { server, devs };
}
const disk = (d: Device) => Object.fromEntries([...d.files].map(([p, f]): [string, string] => [p, latin1(f.content)]).sort());
const noProblems = (devs: Device[]) => assert.deepEqual(devs.flatMap((d) => d.problems), []);

/**
 * Days pass on every clock (one, unless said). The devices in `online` connect afresh and, once caught up, send their
 * daily lists. A retirement is confirmed once every device seen in the last 30 days has listed since.
 */
async function nextDay(server: Server, devs: Device[], online = devs, days = 1): Promise<void> {
	server.clock += days * DAY;
	for (const d of devs) d.passTime(days * DAY);
	for (const d of online) { d.disconnect(); d.connect(); }
	await quiesce(online);
}

/** Chunks that the versions of a live attachment refer to (as the device has them) and the Worker doesn't hold. */
function missingChunks(server: Server, d: Device): string[] {
	const missing: string[] = [];
	for (const [id, v] of d.storedIndex()) {
		if (v.d !== undefined || v.p.endsWith(".md")) continue;
		const doc = new Y.Doc(), state = d.data.get(`state:${id}`) as Uint8Array | undefined;
		if (state) Y.applyUpdate(doc, state);
		for (const ref of doc.getArray<Ref>("v").toArray()) for (const name of ref.c) if (!server.chunks.has(name)) missing.push(`${v.p} ${name}`);
		doc.destroy();
	}
	return missing;
}

test("a replaced version goes only once a full list confirms it; current versions and old-style chunks never do", async () => {
	let scoped = false;
	const { server, devs } = world(2, 1, (d) => { d.overrides = { ...SCOPED, scoped: () => scoped }; });
	const [a, b] = devs as [Device, Device];
	a.write("old.png", bytes(PIC)); // while some device couldn't read scoped chunks yet
	await quiesce(devs);
	assert.equal(server.versionChunks.size, 0);
	scoped = true;
	a.write("p.png", bytes(PIC));
	await quiesce(devs);
	const first = [...server.versionChunks.keys()];
	assert.ok(first.length > 1);
	server.clock += 10;
	a.write("p.png", bytes(PIC2));
	a.remove("old.png");
	await quiesce(devs);
	server.clock += 10;
	assert.equal(server.cleanUp(0, server.clock), 0); // retired, but no full list has confirmed it yet
	await nextDay(server, devs);
	const before = server.chunks.size;
	assert.equal(server.cleanUp(0, server.clock), first.length);
	assert.equal(server.chunks.size, before - first.length); // old.png's chunks stay: they belong to no version
	assert.ok(first.every((name) => !server.chunks.has(name)));
	assert.deepEqual(missingChunks(server, a), []);
	assert.deepEqual(disk(a), { "p.png": PIC2 });
	assert.deepEqual(disk(b), disk(a));
	// A device joining now gets everything current.
	const c = new Device("d2", server, rng(9));
	c.overrides = { ...SCOPED };
	c.boot();
	c.connect();
	await quiesce([a, b, c]);
	assert.deepEqual(disk(c), disk(a));
	noProblems([a, b, c]);
});

test("conflict copies keep their chunks through Clean up, and a copied file uploads its own", async () => {
	const { server, devs } = world(3);
	const [a, b, c] = devs as [Device, Device, Device];
	a.write("p.png", bytes(PIC));
	await quiesce(devs);
	a.disconnect();
	b.disconnect();
	a.write("p.png", bytes("from A"));
	b.write("p.png", bytes("from B"));
	await quiesce(devs);
	a.connect();
	b.connect();
	await quiesce(devs);
	c.write("same.png", bytes("from A")); // the same content as another attachment: a version of its own
	await quiesce(devs);
	server.clock += 10;
	await nextDay(server, devs);
	assert.ok(server.cleanUp(0, server.clock) > 0); // the version both replaced
	for (const d of devs) assert.deepEqual(missingChunks(server, d), []);
	assert.deepEqual(Object.values(disk(a)).sort(), ["from A", "from A", "from B"]);
	assert.deepEqual(disk(b), disk(a));
	assert.deepEqual(disk(c), disk(a));
	// Everything is still there for a device that starts from nothing.
	for (const d of devs) { d.crash(); d.files.clear(); d.data.clear(); d.boot(); d.connect(); await quiesce(devs); }
	assert.deepEqual(Object.values(disk(a)).sort(), ["from A", "from A", "from B"]);
	noProblems(devs);
});

/** Recently deleted as the device lists it: it may ask the Worker, so the network runs meanwhile. */
async function listed(d: Device, devs: Device[]): Promise<string[]> {
	const list = d.engine!.deletedNotes();
	await quiesce(devs);
	return (await list).map((n) => n.path).sort();
}

test("a deleted attachment is listed until its content is cleaned up, then isn't restored; one still stored is, however old", async () => {
	const { server, devs } = world();
	const [a, b] = devs as [Device, Device];
	a.write("p.png", bytes(PIC));
	a.write("q.png", bytes(PIC2));
	await quiesce(devs);
	const p = a.engine!.noteAt("p.png")!, q = a.engine!.noteAt("q.png")!;
	a.remove("p.png");
	await quiesce(devs);
	server.clock += 10;
	await nextDay(server, devs);
	server.clock += 10;
	a.remove("q.png"); // after the last list: can't be cleaned up yet
	await quiesce(devs);
	assert.deepEqual(await listed(b, devs), ["p.png", "q.png"]);
	assert.ok(server.cleanUp(0, server.clock) > 0);
	assert.deepEqual(await listed(b, devs), ["q.png"]);

	const refused = b.engine!.restoreAttachment(p);
	await quiesce(devs);
	assert.equal(await refused, "gone");
	assert.deepEqual(disk(a), {});
	assert.notEqual(b.storedIndex().get(p)?.d, undefined);
	// The check made its version current on the Worker for a moment: it is retired again.
	assert.ok([...server.versions.values()].every((v) => v.retiredAt !== null));

	await nextDay(server, devs, devs, 40); // no 30-day limit for attachments: listed while stored
	assert.deepEqual(await listed(b, devs), ["q.png"]);
	const back = b.engine!.restoreAttachment(q);
	await quiesce(devs);
	assert.equal(await back, "q.png");
	assert.deepEqual(disk(a), { "q.png": PIC2 });
	assert.deepEqual(disk(b), disk(a));

	b.disconnect();
	assert.deepEqual(await listed(b, []), ["p.png"]); // offline it can't ask; restoring says so
	assert.equal(await b.engine!.restoreAttachment(p), "offline");
	noProblems(devs);
});

test("a device offline through Clean up puts back what it still holds current", async () => {
	const { server, devs } = world(2, 3);
	const [a, b] = devs as [Device, Device];
	a.write("p.png", bytes(PIC));
	await quiesce(devs);
	b.disconnect();
	b.rename("p.png", "kept.png"); // offline, while A deletes it
	await quiesce([b]);
	a.remove("p.png");
	await quiesce([a]);
	server.clock += 10;
	await nextDay(server, devs, [a]);
	assert.equal(server.cleanUp(0, server.clock), 0); // B was seen lately and hasn't listed since
	await nextDay(server, devs, [a], 30); // away over 30 days: B no longer holds it back
	assert.ok(server.cleanUp(0, server.clock) > 0);
	b.connect();
	await quiesce(devs);
	await nextDay(server, devs); // B's daily list says the version is current: it is missing, and B has the file
	await nextDay(server, devs); // A asks for the chunks again on its next connection
	assert.deepEqual(disk(a), { "kept.png": PIC }, "this seed lets B's rename win over A's deletion");
	assert.deepEqual(disk(b), disk(a));
	assert.deepEqual(missingChunks(server, a), []);
	// The only problem: A couldn't download the attachment until B had put it back.
	assert.ok(a.problems.every((p) => p.includes("a chunk is missing on the server")));
	noProblems([b]);
});

test("a notes-only device's daily list keeps what is current from being cleaned up", async () => {
	const { server, devs } = world(3, 1, (d, i) => { if (i === 2) d.overrides = { ...SCOPED, attachments: false }; });
	const [a, b, c] = devs as [Device, Device, Device];
	a.write("p.png", bytes(PIC));
	await quiesce(devs);
	assert.deepEqual(disk(c), {});
	// A report saying the version stopped being current, lost and replayed late, say.
	const [version] = [...server.versions.values()];
	version!.retiredAt = server.clock;
	server.clock += 10;
	a.disconnect();
	b.disconnect();
	await nextDay(server, devs, [c], 31); // A and B away for longer than 30 days: only C's list counts
	assert.equal(version!.retiredAt, null);
	assert.equal(server.cleanUp(0, server.clock), 0);
	assert.deepEqual(missingChunks(server, a), []);
	noProblems(devs);
});
