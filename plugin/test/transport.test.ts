import { legacyFixture } from "./legacy-fixture";
import type { Entry } from "../src/core/ports";
import { decodeServer, encodeClient, type ClientFrame } from "../../server/src/wire";
// The sync engine through the real Worker (wrangler dev) and the real encryption: two and three devices
// with in-memory vaults. What the fuzz test proves about the engine alone, this checks end to end.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { VaultKeys, newRecovery, shortId, vaultIdOf } from "../src/keys";
import { Transport, fetchRecords } from "../src/transport";
import { hex, unhex, sha256, unpackPairing, chunkName, docTag, KIND, packEntry, sealEnvelope } from "../../protocol/ownsync";
import { TableDisk } from "../src/tableDisk";
import { TableSync } from "../src/tableSync";
import { attachmentFs } from "./table-fs";
import { ownerCodes, startDev, stats } from "../../server/test/devServer";
import { Device, Server, memoryPorts, rng } from "./sim";

const dev = await startDev();
const host = `http://localhost:${dev.port}`;
const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join("");
const nextOwner = await ownerCodes(host);
const links: Transport[] = [], devices: Device[] = [];
after(() => {
	for (const t of links) t.disconnect();
	for (const d of devices) d.engine?.stop();
	dev.stop();
});

// A device that already holds the vault key (as one set up before the membership log existed): it joins the
// log by itself. `keys` instead starts it from keys set up some other way (paired, recovered).
async function device(name: string, vault: string, vaultKey = key, overrides: Device["overrides"] = {}, keys?: VaultKeys, ownerCode?: string) {
	const d = new Device(name, new Server(), rng(name.length + devices.length * 7919));
	// Exercise the same encrypted table and disk adapters as the plugin.
	d.overrides = { ...overrides };
	const problems: string[] = [], alerts: string[] = [], presence: [note: string, update: string][] = [];
	const onProblem = (what: string, err: unknown) => problems.push(`${what}: ${String(err)}`);
	keys ??= await VaultKeys.open(vault, memoryPorts(JSON.stringify({ 0: vaultKey })), { onProblem, onAlert: (m) => alerts.push(m) });
	const { fs,store } = attachmentFs(d.files,d.data);
	const allowed = (p: string) => !p.startsWith(".") && !p.endsWith(".md");
	const adapter: TableDisk = new TableDisk(fs,store,".private/table",allowed,b => table.hash(b),(h,n) => table.suffix(h,n));
	const table = new TableSync(store,keys,adapter,allowed,overrides.attachments !== false,20*2**20,onProblem);
	d.overrides.tableNotes = table.notes;
	d.overrides.tableHistory = table;
	d.overrides.noteDisk = new TableDisk(fs,store,".private/notes",p => !p.startsWith(".") && p.endsWith(".md"),
		async b => hex(await sha256(b)),(h,n) => table.suffix(h,n),"table/note-fs");
	d.overrides.onNoteWork = () => table.noteWork();
	d.boot();
	const link = new Transport(host, keys, d.engine!, {
		attachments:table, tableCapable:async () => true,
		owner: ownerCode ?? (await nextOwner()),
		onProblem,
		onPresence: (note, update) => presence.push([note, new TextDecoder().decode(update)]),
		version: "0.1.0-test",
		conflicts: () => [...d.files.keys()].filter((p) => p.includes(" (conflict ") || p.includes(" (recovered ")).length,
	});
	links.push(link);
	devices.push(d);
	return { d, link, keys, problems, alerts, presence, table };
}
const disk = (d: Device) => Object.fromEntries([...d.files].filter(([p]) => !p.startsWith(".")).map(([p, f]) => [p, f.content]).sort());
async function until(devs: Device[], check: () => boolean, ms = 10000): Promise<void> {
	const end = Date.now() + ms;
	for (;;) {
		for (const d of devs) { d.drain(); await d.idle(); }
		if (check()) return;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

test("notes sync between devices through the Worker: create, edit, rename and delete", async () => {
	const a = await device("a", "vault-one"), b = await device("b", "vault-one");
	await Promise.all([a.link.connect(), b.link.connect()]);
	await until([a.d, b.d], () => a.link.status === "synced" && b.link.status === "synced");
	a.d.write("Secret plan.md", "launch on Tuesday");
	await until([a.d, b.d], () => disk(b.d)["Secret plan.md"] === "launch on Tuesday");
	b.d.write("Secret plan.md", "launch on Tuesday at noon");
	b.d.rename("Secret plan.md", "Projects/Secret plan.md");
	await until([a.d, b.d], () => disk(a.d)["Projects/Secret plan.md"] === "launch on Tuesday at noon" && !("Secret plan.md" in disk(a.d)));

	a.d.remove("Projects/Secret plan.md");
	await until([a.d, b.d], () => Object.keys(disk(b.d)).length === 0);
	assert.deepEqual([...a.problems, ...b.problems, ...a.d.problems, ...b.d.problems], []);
});

test("typing shows up live in the other device's editor, while the Worker stores it in batches", async () => {
	const a = await device("a2", "vault-two", key, { pace: 1500 }), b = await device("b2", "vault-two");
	await Promise.all([a.link.connect(), b.link.connect()]);
	await until([a.d,b.d], () => a.link.status === "synced" && b.link.status === "synced");
	a.d.write("Live typing.md", "start");
	await until([a.d, b.d], () => disk(b.d)["Live typing.md"] === "start");
	await until([a.d,b.d], () => !!a.table.notes.at("Live typing.md") && !!b.table.notes.at("Live typing.md"));
	const id = a.table.notes.at("Live typing.md")!.id;
	const ea = await a.d.engine!.open(id), eb = await b.d.engine!.open(id);
	assert.ok(ea && eb);
	await new Promise((r) => setTimeout(r, 1600)); // let a's pacing window pass, so the burst below starts a fresh one
	const cursor = () => (a.d.data.get("meta") as { cursor: number }).cursor;
	const before = cursor(), started = Date.now();
	for (let i = 0; i < 12; i++) {
		ea.getText("t").insert(ea.getText("t").length, ` word${i}`);
		await new Promise((r) => setTimeout(r, 20));
	}
	await until([a.d, b.d], () => eb.getText("t").toString().endsWith("word11"), 1000);
	assert.ok(Date.now() - started < 1000, "the other editor shows the typing within a second");
	assert.ok(cursor() - before <= 1, `stored ${cursor() - before} entries during the burst; typing must not cost one each`);
	// Once the pacing window passes, the rest is stored as one entry and nothing is left unsent.
	await until([a.d, b.d], () => ![...a.d.data.keys()].some((k) => k.startsWith("out:")), 4000);
	assert.ok(cursor() - before <= 3, `12 keystroke edits were stored as ${cursor() - before} entries`);
	assert.deepEqual([...a.problems, ...b.problems], []);
});

test("a wrong vault key is refused, and nothing is retried", async () => {
	const bad = await device("x", "vault-one", "ab".repeat(32));
	await bad.link.connect();
	await until([bad.d], () => bad.link.status === "unauthorized");
	assert.equal(bad.d.files.size, 0);
});

test("presence reaches the other device's editors, never its engine, and is throttled", async () => {
	const a = await device("a5", "vault-presence"), b = await device("b5", "vault-presence");
	await Promise.all([a.link.connect(), b.link.connect()]);
	await until([a.d, b.d], () => a.link.status === "synced" && b.link.status === "synced");
	const toEngine: string[] = [], receive = b.d.engine!.receive.bind(b.d.engine!);
	b.d.engine!.receive = (m) => { toEngine.push(m.t); return receive(m); };
	const started = Date.now();
	for (let i = 0; i < 20; i++) {
		a.link.presence("a note", new TextEncoder().encode(`Presence of Kim's laptop ${i}`));
		await new Promise((r) => setTimeout(r, 10));
	}
	const sending = Date.now() - started;
	await until([a.d, b.d], () => b.presence[b.presence.length - 1]?.[1] === "Presence of Kim's laptop 19", 2000);
	assert.ok(b.presence.every(([note]) => note === "a note"));
	assert.ok(b.presence.length <= Math.floor(sending / 150) + 1, `${b.presence.length} presence frames in ${sending} ms`);
	assert.deepEqual(toEngine.filter((t) => t === "live" || t === "entry"), [], "the engine got presence");
	assert.deepEqual(a.presence, [], "a device doesn't get its own presence back");
	assert.deepEqual([...a.problems, ...b.problems, ...b.d.problems], []);
});

test("a new vault without the Worker's owner code is refused, and nothing is retried", async () => {
	const stranger = await device("y", "vault-new", key, {}, undefined, "");
	await stranger.link.connect();
	await until([stranger.d], () => stranger.link.status === "needs owner code");
});

test("removing a device through the Worker: the others carry on under a new key, the removed one can't read or write", async () => {
	const a = await device("ra", "vault-four"), b = await device("rb", "vault-four"), c = await device("rc", "vault-four");
	await Promise.all([a, b, c].map((x) => x.link.connect()));
	await until([a.d, b.d, c.d], () => [a, b, c].every((x) => x.link.status === "synced" && x.keys.state.head?.members.length === 3));
	a.d.write("Kept.md", "everyone sees this");
	await until([a.d, b.d, c.d], () => disk(b.d)["Kept.md"] === "everyone sees this" && disk(c.d)["Kept.md"] === "everyone sees this");

	await a.keys.remove(c.keys.me.id);
	a.link.offer();
	const settled = () => c.link.status === "removed" && [a, b].every((x) => x.keys.epoch === 1 && x.link.status === "synced" && !x.keys.state.resnapshot);
	await until([a.d, b.d, c.d], settled);
	a.d.write("After.md", "not for the removed device");
	b.d.write("Kept.md", "everyone sees this, edited");
	c.d.write("From c.md", "written after removal");
	await until([a.d, b.d, c.d], () => disk(b.d)["After.md"] === "not for the removed device" && disk(a.d)["Kept.md"] === "everyone sees this, edited");
	assert.equal(disk(c.d)["After.md"], undefined);
	assert.equal(disk(c.d)["Kept.md"], "everyone sees this");
	assert.equal(disk(a.d)["From c.md"], undefined);
	assert.match(c.alerts.join("\n"), /removed from the vault/);

	// A device paired now gets every note from the new epoch's snapshots alone: the older entries are refused.
	const p = unpackPairing(a.keys.pairingPayload()!);
	const keys = await VaultKeys.fresh("vault-four", memoryPorts(), {}, new Map([[p.epoch, p.vmk]]), { number: p.number, hash: p.hash, pairedBy: p.pairerId });
	const d = await device("rd", "vault-four", key, {}, keys);
	await d.link.connect();
	await until([a.d, b.d, d.d], () => disk(d.d)["Kept.md"] === "everyone sees this, edited" && disk(d.d)["After.md"] === "not for the removed device" && a.keys.state.head?.members.length === 3);
	assert.equal(Object.keys(disk(d.d)).length, 2);
	assert.deepEqual([...a.problems, ...b.problems, ...d.problems, ...a.alerts, ...b.alerts, ...a.d.problems, ...b.d.problems, ...d.d.problems], []);
});

test("a device paired after a key rotation still gets attachments uploaded before it", async () => {
	const a = await device("ka", "vault-rotated-attach"), b = await device("kb", "vault-rotated-attach");
	await Promise.all([a.link.connect(), b.link.connect()]);
	await until([a.d, b.d], () => [a, b].every((x) => x.link.status === "synced" && x.keys.state.head?.members.length === 2));
	const scan = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) & 0xff);
	a.d.write("Scans/passport.pdf", scan);
	await a.table.event({kind:"changed",path:"Scans/passport.pdf"});
	await until([a.d, b.d], () => { const got = b.d.files.get("Scans/passport.pdf")?.content; return got instanceof Uint8Array && Buffer.compare(got, scan) === 0; }, 30000);
	await a.keys.remove(b.keys.me.id);
	a.link.offer();
	await until([a.d, b.d], () => a.keys.epoch === 1 && a.link.status === "synced" && !a.keys.state.resnapshot);
	const p = unpackPairing(a.keys.pairingPayload()!);
	assert.equal(p.epoch, 1);
	const keys = await VaultKeys.fresh("vault-rotated-attach", memoryPorts(), {}, new Map([[p.epoch, p.vmk]]), { number: p.number, hash: p.hash, pairedBy: p.pairerId });
	const c = await device("kc", "vault-rotated-attach", key, {}, keys);
	await c.link.connect();
	await until([a.d, c.d], () => { const got = c.d.files.get("Scans/passport.pdf")?.content; return got instanceof Uint8Array && Buffer.compare(got, scan) === 0; }, 30000);
	assert.equal(c.keys.keyFor(0)?.length, 32, "the new device learned the older key");
	assert.deepEqual([...a.problems, ...c.problems, ...a.d.problems, ...c.d.problems], []);
});

test("recovering through the Worker: a new device with only the code gets every note, and the old device is removed", async () => {
	const vaultId = await vaultIdOf("vault-five"), r1 = await newRecovery(vaultId);
	const created = await VaultKeys.fresh("vault-five", memoryPorts(), {}, new Map([[0, unhex(key)]]));
	await created.genesis(r1);
	const a = await device("va", "vault-five", key, {}, created);
	await a.link.connect();
	await until([a.d], () => a.link.status === "synced" && !!a.keys.state.head);
	a.d.write("Diary.md", "only on the lost laptop");
	await until([a.d], () => !!a.table.notes.at("Diary.md") && ![...a.d.data.keys()].some((k) => k.startsWith("out:")));

	const { records, recovery } = await fetchRecords(host, vaultId);
	const keys = await VaultKeys.fresh("vault-five", memoryPorts(), {}, new Map());
	await keys.recover(r1.code, recovery, records, await newRecovery(vaultId));
	const n = await device("vn", "vault-five", key, {}, keys);
	await n.link.connect();
	await until([a.d, n.d], () => disk(n.d)["Diary.md"] === "only on the lost laptop" && n.keys.epoch === 1 && !n.keys.state.resnapshot && a.link.status === "removed");
	n.d.write("New.md", "after recovery");
	const p = unpackPairing(n.keys.pairingPayload()!);
	const again = await device("vp", "vault-five", key, {}, await VaultKeys.fresh("vault-five", memoryPorts(), {}, new Map([[p.epoch, p.vmk]]), { number: p.number, hash: p.hash, pairedBy: p.pairerId }));
	await again.link.connect();
	await until([n.d, again.d], () => disk(again.d)["Diary.md"] === "only on the lost laptop" && disk(again.d)["New.md"] === "after recovery");
	assert.deepEqual([...n.problems, ...again.problems, ...n.d.problems, ...again.d.problems], []);
});

test("once synced a device tells the Worker its short ID, version and conflict count; deleting the vault on the server stops every device", async () => {
	const a = await device("sa", "vault-status"), b = await device("sb", "vault-status");
	await Promise.all([a.link.connect(), b.link.connect()]);
	await until([a.d, b.d], () => a.link.status === "synced" && b.link.status === "synced");
	const vault = hex(a.keys.vaultId);
	const reported = async (want: Record<string, string>) => {
		for (let i = 0; ; i++) {
			const got = Object.fromEntries((await stats(host, vault)).devices.map((d) => [d.id, `${d.version} ${d.conflicts} ${d.online ? "online" : "offline"}`]));
			try { return assert.deepEqual(got, want); } catch (err) { if (i > 200) throw err; }
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	const A = shortId(a.keys.me.id), B = shortId(b.keys.me.id);
	await reported({ [A]: "0.1.0-test 0 online", [B]: "0.1.0-test 0 online" });
	a.d.files.set("Plan (conflict 1a2b3c).md", { content: "the other version", mtime: 1 }); // the engine isn't told: only the count matters here
	a.link.report();
	await reported({ [A]: "0.1.0-test 1 online", [B]: "0.1.0-test 0 online" });

	const token = await a.keys.token();
	assert.equal((await fetch(`${host}/vault/${vault}/delete`, { method: "POST", body: token })).status, 200);
	await until([a.d, b.d], () => a.link.status === "deleted" && b.link.status === "deleted");
	await new Promise((r) => setTimeout(r, 500));
	assert.deepEqual([a.link.status, b.link.status], ["deleted", "deleted"], "nothing reconnects");
	assert.deepEqual([...a.problems, ...b.problems, ...a.d.problems, ...b.d.problems], []);
});

// Write a pre-table vault using the 0.2.x wire format. Only the fixture speaks that protocol.
async function legacyPeer(keys: VaultKeys) {
	const ws = new WebSocket(`ws://localhost:${dev.port}/vault/${hex(keys.vaultId)}`);
	ws.binaryType = "arraybuffer";
	await new Promise<void>((resolve,reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
	ws.send(encodeClient({t:"hello",token:await keys.token(),owner:unhex(await nextOwner())}));
	const request = (frame: ClientFrame) => new Promise<ReturnType<typeof decodeServer>>((resolve,reject) => {
		ws.onmessage = e => resolve(decodeServer(new Uint8Array(e.data as ArrayBuffer)));
		ws.onclose = e => reject(new Error("fixture connection closed: " + e.code));
		ws.send(encodeClient(frame));
	});
	const seal = (docId: Uint8Array, kind: number, plaintext: Uint8Array) => sealEnvelope({
		vmk:keys.vmk,vaultId:keys.vaultId,epoch:keys.epoch,deviceId:keys.me.id,docId,kind,plaintext
	});
	let id = 0;
	return {
		close: () => ws.close(),
		async put(bytes: Uint8Array) {
			const name = await chunkName(keys.vmk,keys.vaultId,bytes);
			assert.equal((await request({t:"put",name,envelope:await seal(name,KIND.chunk,bytes)})).t,"stored");
			return hex(name);
		},
		async publish(entry: Entry) {
			const doc = await docTag(keys.vmk,keys.vaultId,entry.doc);
			const envelope = await seal(doc,entry.kind === "snapshot" ? KIND.snapshot : KIND.update,packEntry(entry.doc,entry.data));
			assert.equal((await request({t:"publish",id:++id,doc,envelope})).t,"ack");
		},
	};
}

test("a live legacy vault migrates through the transport, then an updated peer downloads, edits and restores", async () => {
	const vault = "migration", a = await device("capable",vault);
	const content = (s: string) => new TextEncoder().encode(s);
	const val = (d: Device,p: string) => new TextDecoder().decode(d.files.get(p)?.content as Uint8Array | undefined);
	const kept = "0000000000000001", removed = "0000000000000002", bytes = content("before genesis");
	const old = await legacyPeer(a.keys);
	try {
		const h = await old.put(bytes);
		const fixture = legacyFixture([{id:kept,path:"kept.md",body:"existing note"},
			{id:removed,path:"removed.md",body:"legacy deleted text",deleted:Date.now()},
			{id:"0000000000000003",path:"legacy.png",body:{h,c:[h],n:bytes.length,u:"0000000000000004"}}]);
		for (const e of fixture.entries) await old.publish(e);
	} finally { old.close(); }
	await a.link.connect(); await until([a.d],() => a.link.status === "synced");
	await until([a.d],() => a.d.data.has("table/initialized"));
	assert.equal(a.d.engine!.tableActive,true);
	await until([a.d], () => a.d.engine!.tableNotesReady);
	assert.equal(a.table.notes.at("kept.md")?.id, kept);
	assert.ok(a.table.notes.get(removed)?.vector);
	const b = await device("joining",vault);
	await b.link.connect();
	await until([a.d,b.d],() => val(b.d,"legacy.png") === "before genesis");
	b.d.write("legacy.png",content("after genesis"));
	await b.table.event({kind:"changed",path:"legacy.png"});
	await until([a.d,b.d],() => val(a.d,"legacy.png") === "after genesis");
	assert.equal(b.d.engine!.noteAt("kept.md"), kept);
	b.d.rename("kept.md", "moved.md");
	await until([a.d,b.d], () => disk(a.d)["moved.md"] === "existing note");
	assert.equal(a.table.notes.at("moved.md")?.id, kept);
	b.d.remove("moved.md");
	await until([a.d,b.d], () => !!a.table.notes.get(kept)?.snapshot && !a.d.files.has("moved.md"));
	a.d.write("migration-note.md","still text");
	await until([a.d,b.d],() => b.d.files.get("migration-note.md")?.content === "still text");
	a.d.remove("legacy.png"); await a.table.event({kind:"deleted",path:"legacy.png"});
	await until([a.d,b.d],() => !b.d.files.has("legacy.png"));
	const [gone] = await b.table.deleted(); assert.ok(gone);
	assert.equal(await b.table.restore(gone.id),"legacy.png");
	await until([a.d,b.d],() => val(a.d,"legacy.png") === "after genesis");
	assert.deepEqual([...a.problems,...b.problems,...a.d.problems,...b.d.problems],[]);
});

test("the device reports a failed migration and waits without running legacy sync", async () => {
	const a = await device("capable","write-limit"), old = await legacyPeer(a.keys);
	try {
		const fixture = legacyFixture([{id:"0000000000000001",path:"still-legacy.md",body:"legacy text"}]);
		await old.publish(fixture.entries[0]!);
		const fault = await fetch(`${host}/test-fail-genesis/${hex(a.keys.vaultId)}`, {method:"POST"});
		assert.equal(fault.status,204,await fault.text());
		await a.link.connect();
		await until([a.d], () => a.problems.some(p => p.includes("Migration could not complete today")));
		assert.equal(a.d.engine!.tableActive,false);
		await old.publish(fixture.entries[1]!);
		assert.equal(a.d.files.has("still-legacy.md"),false);
	} finally { old.close(); }
});

test("table note rows bind the placed document and typing crosses the encrypted live channel", async () => {
	const a = await device("a","table-notes",key,{});
	await a.link.connect();
	await until([a.d], () => a.d.data.has("table/initialized"));
	const b = await device("b","table-notes",key,{});
	await b.link.connect();
	await until([a.d,b.d], () => a.link.status === "synced" && b.link.status === "synced");
	const path = "Note in all-files table.md";
	a.d.write(path, "shared initial text");
	await until([a.d,b.d], () => b.d.files.get(path)?.content === "shared initial text");
	const id = a.d.engine!.noteAt(path)!;
	await until([a.d,b.d], () => !!a.table.notes.at(path) && !!b.table.notes.at(path));
	const seq = a.table.notes.at(path)!.seq;
	{
		const x = await a.d.engine!.open(id), y = await b.d.engine!.open(id);
		assert.ok(x && y);
		x.getText("t").insert(0, "live ");
		await until([a.d,b.d], () => y.getText("t").toString() === "live shared initial text");
		assert.equal(a.table.notes.at(path)?.seq, seq);
		assert.equal(b.table.notes.at(path)?.seq, seq);
		assert.deepEqual([...a.problems,...b.problems,...a.d.problems,...b.d.problems], []);
	}
});

test("a notes-only device restores the selected deletion across a rotation and keeps the occupied name", async () => {
	const vault = "table-restore";
	const full = await device("full", vault, key, {});
	await full.link.connect();
	await until([full.d], () => full.table.caughtUp);
	const peer = await device("reader", vault, key, { attachments: false });
	await peer.link.connect();
	const ds = [full.d, peer.d], path = "draft.md", restored = "draft (restored).md";
	await until(ds, () => peer.link.status === "synced" && peer.table.caughtUp);
	full.d.write(path, "first document"); full.d.write("image.png", new Uint8Array([1,2,3]));
	await full.table.event({ kind: "changed", path: "image.png" });
	await until(ds, () => peer.d.files.get(path)?.content === "first document");
	await full.table.idle();
	const id = peer.d.engine!.noteAt(path)!;
	assert.equal(await peer.table.snapshotAttachments(), undefined);
	assert.deepEqual((await full.table.snapshotAttachments())?.map(v => [v.path, v.ref.n]), [["image.png", 3]]);
	assert.ok(!peer.d.files.has("image.png"));
	full.d.remove(path);
	await until(ds, () => peer.table.notes.get(id)?.deleted != null && !peer.d.files.has(path));
	const [deletion] = await peer.d.engine!.deletedNotes();
	assert.equal(deletion?.id, id);
	assert.equal(await peer.d.engine!.deletedText(id), "first document");
	full.d.write(path, "different document");
	await until(ds, () => peer.d.files.get(path)?.content === "different document");
	assert.equal(await peer.d.engine!.restoreDeleted(id, undefined, deletion!.deletionSeq), restored);
	await until(ds, () => ds.every(d => d.files.get(restored)?.content === "first document"));
	assert.equal(full.d.engine!.noteAt(restored), id);
	assert.notEqual(full.d.engine!.noteAt(path), id);
	peer.d.remove(restored);
	await until(ds, () => peer.table.notes.get(id)?.deleted != null && !full.d.files.has(restored));
	assert.equal(await peer.d.engine!.restoreDeleted(id, undefined, deletion!.deletionSeq), undefined);
	await full.keys.remove(peer.keys.me.id); full.link.offer();
	await until(ds, () => peer.link.status === "removed" && full.keys.epoch === 1 && !full.keys.state.resnapshot);
	const p = unpackPairing(full.keys.pairingPayload()!);
	const keys = await VaultKeys.fresh(vault, memoryPorts(), {}, new Map([[p.epoch, p.vmk]]),
		{ number: p.number, hash: p.hash, pairedBy: p.pairerId });
	const joined = await device("new", vault, key, { attachments: false }, keys);
	await joined.link.connect();
	await until([full.d, joined.d], () => joined.link.status === "synced" && joined.d.files.get(path)?.content === "different document");
	assert.equal(await joined.d.engine!.deletedText(id), "first document");
	assert.ok(!joined.d.files.has("image.png"));
	assert.deepEqual([...full.problems, ...peer.problems, ...joined.problems, ...ds.flatMap(d => d.problems), ...joined.d.problems], []);
});

test("the Worker's storage holds no note text, attachment content, file names, folder names or vault names", () => {
	for (const secret of ["launch on", "Tuesday", "Secret plan", "Projects", "word1", "vault-one", "Live typing", "everyone sees", "removed device", "lost laptop", "after recovery", "vault-five", "Kim's laptop", "before genesis", "after genesis", "legacy.png", "passport.pdf", "vault-four", "vault-rotated-attach", "Note in all-files table", "shared initial text"]) {
		let hits = "";
		try { hits = execFileSync("grep", ["-rlaF", secret, dev.persistDir], { encoding: "utf8" }).trim(); }
		catch (e) { if ((e as { status?: number }).status !== 1) throw e; } // 1 = no match
		assert.equal(hits, "", `found "${secret}" in ${hits}`);
	}
});
