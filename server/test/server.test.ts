// Runs the Worker under `wrangler dev` with fresh local storage and drives it over WebSockets.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SNAPSHOT_BUDGET, snapshotsToPrune } from "../src/snapshots.ts";
import { CLOSE, type ClientFrame, type ServerFrame, decodeClient, decodeServer, encodeClient, encodeServer } from "../src/wire.ts";
import { type Stats, claim, startDev, stats } from "./devServer.ts";

const dev = await startDev();
after(() => dev.stop());
const PORT = dev.port;

const vault = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const doc = (n: number) => new Uint8Array(16).fill(n);
const name = (n: number) => new Uint8Array(32).fill(n);
const token = () => crypto.getRandomValues(new Uint8Array(32));

// Set by the first test: a fresh owner code from the dashboard for each vault a test creates.
let OWNER: (() => Promise<Uint8Array>) | undefined;

async function connect(vaultHex: string, tok?: Uint8Array, owner?: Uint8Array) {
	owner ??= await OWNER?.();
	const ws = new WebSocket(`ws://localhost:${PORT}/vault/${vaultHex}`);
	ws.binaryType = "arraybuffer";
	const inbox: ServerFrame[] = [];
	let wake: (() => void) | undefined;
	ws.onmessage = (e) => { inbox.push(decodeServer(new Uint8Array(e.data as ArrayBuffer))); wake?.(); };
	const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	const send = (f: ClientFrame) => ws.send(encodeClient(f));
	if (tok) send(owner ? { t: "hello", token: tok, owner } : { t: "hello", token: tok });
	const next = async (): Promise<ServerFrame> => {
		while (!inbox.length) await new Promise<void>((r) => { wake = r; });
		return inbox.shift()!;
	};
	// Everything the Worker has after `after`, across as many pages as it takes.
	const catchUp = async (after: number) => {
		const got: string[] = [];
		let pages = 1;
		send({ t: "subscribe", after });
		for (;;) {
			const f = await next();
			if (f.t === "entry") got.push(`${f.seq}:${f.doc[0]}:${f.snapshot ? "S" : "u"}:${text(f.envelope)}`);
			else if (f.t === "more") { pages++; send({ t: "subscribe", after: f.seq }); }
			else if (f.t === "synced") return { got, head: f.seq, pages };
		}
	};
	const publish = async (d: Uint8Array, body: string, id = 1) => {
		send({ t: "publish", id, doc: d, envelope: bytes(body) });
		const f = await next();
		assert.equal(f.t, "ack");
		return (f as { seq: number }).seq;
	};
	// Membership records up to the end marker, as "number:blob", and the sealed recovery key.
	const records = async () => {
		const got: string[] = [];
		for (;;) {
			const f = await next();
			if (f.t === "record") got.push(`${f.number}:${text(f.blob)}`);
			else if (f.t === "records") return { got, recovery: text(f.recovery) };
		}
	};
	return { ws, closed, send, next, catchUp, publish, records };
}
const sealedKey = (c: string) => bytes(c.repeat(113));

test("only a current owner code creates a vault, each code once; then devices of a vault get codes for more", async () => {
	const home = `http://localhost:${PORT}/`;
	assert.equal(await (await connect(vault(), token(), token())).closed, CLOSE.notOwner); // no code works yet
	const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
	// Two codes from the dashboard (two vaults set up at the same moment): both create vaults.
	const first = await claim(`http://localhost:${PORT}`), second = await claim(`http://localhost:${PORT}`);
	assert.ok(first !== second);
	const other = await connect(vault(), token(), hexToBytes(first));
	assert.deepEqual(await other.catchUp(0), { got: [], head: 0, pages: 1 });
	other.ws.close();
	const code = hexToBytes(second);

	const v = vault(), tok = token();
	for (const bad of [undefined, token(), code.slice(0, 31)]) assert.equal(await (await connect(v, tok, bad)).closed, CLOSE.notOwner);
	const created = await connect(v, tok, code);
	assert.deepEqual(await created.catchUp(0), { got: [], head: 0, pages: 1 });
	// Once a vault exists its token is what counts, with or without the owner code.
	const device = await connect(v, tok, undefined);
	await device.catchUp(0);
	assert.equal(await (await connect(v, token(), code)).closed, CLOSE.unauthorized);
	for (const x of [created, device]) x.ws.close();
	// Each code makes one vault; codes come only from the dashboard (a device of a vault can't make one).
	assert.equal(await (await connect(vault(), token(), code)).closed, CLOSE.notOwner);
	assert.equal((await fetch(`${home}vault/${v}/mint`, { method: "POST", body: tok })).status, 404);
	OWNER = async () => hexToBytes(await claim(`http://localhost:${PORT}`));
});

test("every frame survives encoding and decoding", () => {
	const client: ClientFrame[] = [
		{ t: "hello", token: token() }, { t: "hello", token: token(), owner: token() }, { t: "subscribe", after: 2 ** 40 + 7 }, { t: "publish", id: 4_000_000_000, doc: doc(3), envelope: bytes("x") },
		{ t: "snapshot", doc: doc(4), base: 99, envelope: bytes("yy") }, { t: "live", doc: doc(5), envelope: bytes("z") },
		{ t: "fetch", from: 3 }, { t: "append", number: 2, recovery: bytes("r"), blob: bytes("rec") },
		{ t: "rotate", number: 5, tokenHash: token(), recovery: new Uint8Array(0), blob: bytes("rot") },
		{ t: "put", name: name(6), envelope: bytes("c") }, { t: "get", name: name(7) }, { t: "status", id: Uint8Array.of(1, 2, 3, 4), conflicts: 3, version: "0.1.0-beta" },
		{ t: "vput", tag: name(8), name: name(9), envelope: bytes("v") }, { t: "mark", id: 3, flags: 9, tags: [name(10), name(11)] }, { t: "mark", id: 4, flags: 6, tags: [] },
	];
	for (const f of client) assert.deepEqual(decodeClient(encodeClient(f)), f);
	const server: ServerFrame[] = [
		{ t: "entry", seq: 2 ** 40 + 1, doc: doc(1), snapshot: true, envelope: bytes("e") }, { t: "more", seq: 5 }, { t: "synced", seq: 6 },
		{ t: "ack", id: 7, seq: 8 }, { t: "live", doc: doc(2), envelope: bytes("l") },
		{ t: "record", number: 4, blob: bytes("rec") }, { t: "records", recovery: bytes("sealed") },
		{ t: "stored", name: name(3) }, { t: "chunk", name: name(4), envelope: bytes("k") }, { t: "missing", name: name(5) },
		{ t: "marked", id: 9, tags: [name(6)] }, { t: "marked", id: 10, tags: [] },
	];
	for (const f of server) assert.deepEqual(decodeServer(encodeServer(f)), f);
	assert.throws(() => decodeClient(Uint8Array.of(3, 0, 0)), RangeError); // a publish cut short
	assert.throws(() => decodeClient(Uint8Array.of(99)), RangeError);
	assert.throws(() => decodeClient(encodeClient({ t: "status", id: Uint8Array.of(1, 2, 3, 4), conflicts: 0, version: "v".repeat(33) })), RangeError);
});

test("a publish is stored, acknowledged and relayed; a live frame is relayed but not stored", async () => {
	const v = vault(), tok = token();
	const a = await connect(v, tok), b = await connect(v, tok);
	assert.deepEqual(await a.catchUp(0), { got: [], head: 0, pages: 1 });
	await b.catchUp(0);
	assert.equal(await a.publish(doc(1), "one", 41), 1);
	assert.deepEqual(await b.next(), { t: "entry", seq: 1, doc: doc(1), snapshot: false, envelope: bytes("one") });
	a.send({ t: "live", doc: doc(1), envelope: bytes("typing") });
	assert.deepEqual(await b.next(), { t: "live", doc: doc(1), envelope: bytes("typing") });
	assert.equal(await a.publish(doc(2), "two"), 2);
	const c = await connect(v, tok);
	assert.deepEqual((await c.catchUp(1)).got, ["2:2:u:two"]);
	for (const x of [a, b, c]) x.ws.close();
});

test("a snapshot replaces its document's older entries, for devices that need it", async () => {
	const v = vault(), tok = token();
	const a = await connect(v, tok);
	await a.catchUp(0);
	await a.publish(doc(1), "a1");
	await a.publish(doc(2), "b1");
	await a.publish(doc(1), "a2");
	a.send({ t: "snapshot", doc: doc(1), base: 3, envelope: bytes("A-upto-3") });
	a.send({ t: "snapshot", doc: doc(2), base: 99, envelope: bytes("ignored: past the head") });
	assert.equal(await a.publish(doc(1), "a3"), 5); // the snapshot took seq 4
	const fresh = await connect(v, tok);
	assert.deepEqual((await fresh.catchUp(0)).got, ["2:2:u:b1", "4:1:S:A-upto-3", "5:1:u:a3"]);
	// A device that hasn't read past the snapshot gets it, wherever it was: its position doesn't prove it
	// holds the entries the snapshot replaced.
	const behind = await connect(v, tok);
	assert.deepEqual(await behind.catchUp(3), { got: ["4:1:S:A-upto-3", "5:1:u:a3"], head: 5, pages: 1 });
	const past = await connect(v, tok);
	assert.deepEqual((await past.catchUp(4)).got, ["5:1:u:a3"]);
	for (const x of [a, fresh, behind, past]) x.ws.close();
});

test("catch-up comes in pages and still delivers everything in order", async () => {
	const v = vault(), tok = token();
	const a = await connect(v, tok);
	await a.catchUp(0);
	const N = 950;
	for (let i = 1; i <= N; i++) a.send({ t: "publish", id: i, doc: doc(i % 7), envelope: bytes(`e${i}`) });
	for (let i = 1; i <= N; i++) await a.next();
	const b = await connect(v, tok);
	const { got, head, pages } = await b.catchUp(0);
	assert.equal(head, N);
	assert.equal(pages, 3);
	assert.deepEqual(got.map((g) => g.split(":")[0]), Array.from({ length: N }, (_, i) => String(i + 1)));
	a.ws.close(); b.ws.close();
});

test("attachment chunks: stored once per name, served to any of the vault's devices, missing ones said so", async () => {
	const v = vault(), tok = token();
	const a = await connect(v, tok), b = await connect(v, tok);
	const big = new Uint8Array(1024 * 1024 + 51).fill(7); // a full 1 MiB chunk, sealed
	a.send({ t: "put", name: name(1), envelope: big });
	assert.deepEqual(await a.next(), { t: "stored", name: name(1) });
	a.send({ t: "put", name: name(1), envelope: bytes("a second copy") }); // same name: kept as it was
	assert.deepEqual(await a.next(), { t: "stored", name: name(1) });
	b.send({ t: "get", name: name(1) });
	assert.deepEqual(await b.next(), { t: "chunk", name: name(1), envelope: big });
	b.send({ t: "get", name: name(2) });
	assert.deepEqual(await b.next(), { t: "missing", name: name(2) });
	// Chunks are not entries: a catch-up doesn't carry them.
	assert.deepEqual((await b.catchUp(0)).got, []);
	a.send({ t: "put", name: name(3), envelope: new Uint8Array(1024 * 1024 + 65) });
	assert.equal(await a.closed, CLOSE.badMessage);
	const stranger = await connect(vault(), token()); // another vault's devices see nothing of this one
	stranger.send({ t: "get", name: name(1) });
	assert.deepEqual(await stranger.next(), { t: "missing", name: name(1) });
	for (const x of [b, stranger]) x.ws.close();
});

test("wrong token, or anything before hello, is closed as unauthorized", async () => {
	const v = vault();
	const owner = await connect(v, token());
	await owner.catchUp(0); // claimed
	const wrong = await connect(v, token());
	assert.equal(await wrong.closed, CLOSE.unauthorized);
	const early = await connect(v);
	early.send({ t: "publish", id: 1, doc: doc(1), envelope: bytes("x") });
	assert.equal(await early.closed, CLOSE.unauthorized);
	owner.ws.close();
});

test("pairing mailbox: put once, get once, then gone", async () => {
	const url = `http://localhost:${PORT}/pair/${vault()}`;
	assert.equal((await fetch(url)).status, 404);
	assert.equal((await fetch(url, { method: "PUT", body: bytes("sealed vmk") })).status, 204);
	assert.equal((await fetch(url, { method: "PUT", body: bytes("replacement") })).status, 409);
	const got = await fetch(url);
	assert.equal(got.status, 200);
	assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes("sealed vmk"));
	assert.equal((await fetch(url)).status, 410); // single use, and says someone took it
	assert.equal((await fetch(url, { method: "PUT", body: bytes("again") })).status, 409); // can't be refilled
	assert.equal((await fetch(`http://localhost:${PORT}/pair/${vault()}`, { method: "PUT", body: new Uint8Array(2000) })).status, 400);
});

test("membership records: readable without a token, stored in order, first come first served, shown to the others", async () => {
	const v = vault(), tok = token();
	const stranger = await connect(v);
	stranger.send({ t: "fetch", from: 0 });
	assert.deepEqual(await stranger.records(), { got: [], recovery: "" });
	stranger.send({ t: "append", number: 0, recovery: new Uint8Array(0), blob: bytes("forged") });
	assert.equal(await stranger.closed, CLOSE.unauthorized); // reading needs no token, writing does

	const a = await connect(v, tok), b = await connect(v, tok);
	await a.catchUp(0);
	await b.catchUp(0);
	a.send({ t: "append", number: 0, recovery: sealedKey("k"), blob: bytes("genesis") });
	assert.deepEqual(await a.records(), { got: ["0:genesis"], recovery: "k".repeat(113) });
	assert.deepEqual(await b.records(), { got: ["0:genesis"], recovery: "k".repeat(113) }); // pushed
	// Two devices add record 1 at once: the second gets the first one's record back, and nothing is stored.
	a.send({ t: "append", number: 1, recovery: new Uint8Array(0), blob: bytes("pair-x") });
	b.send({ t: "append", number: 1, recovery: new Uint8Array(0), blob: bytes("pair-y") });
	assert.deepEqual((await a.records()).got, ["1:pair-x"]);
	assert.deepEqual((await b.records()).got, ["1:pair-x"]); // the push
	assert.deepEqual((await b.records()).got, ["1:pair-x"]); // the answer to its own append
	b.send({ t: "append", number: 5, recovery: new Uint8Array(0), blob: bytes("gap") });
	b.send({ t: "append", number: 2, recovery: bytes("short"), blob: bytes("bad recovery size") });
	assert.deepEqual((await b.records()).got, []);
	assert.deepEqual((await b.records()).got, []);
	b.send({ t: "fetch", from: 1 });
	assert.deepEqual(await b.records(), { got: ["1:pair-x"], recovery: "k".repeat(113) });
	a.ws.close(); b.ws.close();
});

test("a rotation switches the vault to the new token, closes every other socket, and keeps the records readable", async () => {
	const v = vault(), oldTok = token(), newTok = token();
	const a = await connect(v, oldTok), b = await connect(v, oldTok);
	await a.catchUp(0);
	await b.catchUp(0);
	a.send({ t: "append", number: 0, recovery: new Uint8Array(0), blob: bytes("genesis") });
	await a.records();
	await b.records();
	const newHash = new Uint8Array(await crypto.subtle.digest("SHA-256", newTok));
	a.send({ t: "rotate", number: 1, tokenHash: newHash, recovery: sealedKey("n"), blob: bytes("rotation") });
	assert.deepEqual(await a.records(), { got: ["1:rotation"], recovery: "n".repeat(113) });
	assert.equal(await b.closed, CLOSE.rekeyed);
	assert.equal(await a.publish(doc(1), "after"), 1); // the rotating socket carries on

	const stale = await connect(v); // the removed device, or one that missed the rotation
	stale.send({ t: "fetch", from: 1 });
	assert.deepEqual((await stale.records()).got, ["1:rotation"]);
	stale.send({ t: "hello", token: oldTok });
	assert.equal(await stale.closed, CLOSE.unauthorized);
	const back = await connect(v, newTok);
	assert.deepEqual((await back.catchUp(0)).got, ["1:1:u:after"]);
	// A rotation must come from a socket that holds the current token.
	const late = await connect(v, oldTok);
	late.send({ t: "rotate", number: 2, tokenHash: newHash, recovery: new Uint8Array(0), blob: bytes("hijack") });
	assert.equal(await late.closed, CLOSE.unauthorized);
	back.send({ t: "fetch", from: 0 });
	assert.deepEqual((await back.records()).got, ["0:genesis", "1:rotation"]);
	a.ws.close(); back.ws.close();
});

// The vault's stats as the dashboard reads them, once `ok` holds.
async function statsUntil(v: string, ok: (s: Stats) => boolean): Promise<Stats> {
	for (let i = 0; ; i++) {
		const s = await stats(`http://localhost:${PORT}`, v);
		if (ok(s)) return s;
		if (i > 200) assert.fail(`stats never settled: ${JSON.stringify(s)}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}
const status = (id: number, conflicts = 0, version = "0.1.0"): ClientFrame => ({ t: "status", id: Uint8Array.of(0xab, 0xcd, id >> 8, id & 0xff), conflicts, version });

test("devices report a status: one short ID per connection, last online from the Worker's own record, at most 64 kept", async () => {
	const v = vault(), tok = token();
	const a = await connect(v, tok);
	await a.catchUp(0);
	a.send(status(1, 2));
	a.send(status(2, 9, "9.9.9")); // another ID on the same connection: ignored
	a.send(status(1, 3));
	let s = await statsUntil(v, (s) => s.devices[0]?.conflicts === 3);
	assert.deepEqual(s.devices.map(({ id, online, version, conflicts, mobile, notesOnly }) => ({ id, online, version, conflicts, mobile, notesOnly })), [{ id: "ABCD0001", online: true, version: "0.1.0", conflicts: 3, mobile: false, notesOnly: false }]);
	const reported = s.devices[0]!.lastOnline;
	// A phone that syncs notes only says so after its version (an older server just shows it as part of it).
	const phone = await connect(v, tok);
	phone.send(status(99, 0, "0.1.1 mobile notes-only"));
	const p = (await statsUntil(v, (s) => s.devices.some((d) => d.id === "ABCD0063"))).devices.find((d) => d.id === "ABCD0063")!;
	assert.deepEqual([p.version, p.mobile, p.notesOnly], ["0.1.1", true, true]);
	// Its name and the vault's, as Obsidian has them: with the vault's token only, and kept when it reports again.
	const names = (t: Uint8Array, json: unknown) => fetch(`http://localhost:${PORT}/vault/${v}/names`, { method: "POST", body: new Uint8Array([...t, ...bytes(JSON.stringify(json))]) });
	assert.equal((await names(token(), { device: "ABCD0063", name: "Kish's iPhone", vault: "Personal" })).status, 401);
	const named = await names(tok, { device: "ABCD0063", name: "  Kish's iPhone\u0007 ", vault: "Personal" });
	assert.equal(named.status, 200);
	// The reply says which Ownsync the Worker runs, and the newest release when it can be looked up (or null), for the plugin's update notice.
	const reply = (await named.json()) as { worker?: string; latest?: string | null; names?: Record<string, string> };
	assert.deepEqual(reply.names, { ABCD0063: "Kish's iPhone" }); // what each device shows in its list of devices
	assert.match(reply.worker ?? "", /^\d+\.\d+\.\d+$/);
	assert.ok(reply.latest === null || /^\d+\.\d+\.\d+$/.test(reply.latest ?? ""));
	phone.send(status(99, 1, "0.1.1 mobile notes-only"));
	s = await statsUntil(v, (s) => s.devices.find((d) => d.id === "ABCD0063")?.conflicts === 1);
	assert.deepEqual([s.name, s.devices.find((d) => d.id === "ABCD0063")!.name], ["Personal", "Kish's iPhone"]);
	phone.ws.close();
	await new Promise((r) => setTimeout(r, 20));
	a.ws.close();
	s = await statsUntil(v, (s) => !s.devices[0]?.online);
	assert.ok(s.devices[0]!.lastOnline > reported, "last online is when the connection closed");

	for (let i = 2; i <= 65; i++) {
		const d = await connect(v, tok);
		d.send(status(i));
		await statsUntil(v, (s) => s.devices.some((x) => x.id === `ABCD${i.toString(16).toUpperCase().padStart(4, "0")}`));
		d.ws.close();
	}
	s = await statsUntil(v, (s) => s.devices.every((d) => !d.online));
	assert.equal(s.devices.length, 64);
	assert.ok(!s.devices.some((d) => d.id === "ABCD0001"), "the device seen longest ago went");
});

test("the dashboard's stats count today's requests and rows written, the storage used and the last publish", async () => {
	const v = vault(), tok = token();
	const a = await connect(v, tok);
	await a.catchUp(0);
	const before = Date.now();
	await a.publish(doc(1), "one");
	await a.publish(doc(1), "two");
	const s = await stats(`http://localhost:${PORT}`, v);
	assert.ok(Math.abs(s.requestsToday - (1 + 4 / 20)) < 1e-9, `${s.requestsToday} requests`); // the connection, then hello, subscribe and two publishes at 20 to one
	assert.ok(s.rowsWrittenToday >= 3, `${s.rowsWrittenToday} rows written`); // the token, two entries
	assert.ok(s.bytes > 0);
	assert.ok(s.lastActivity! >= before);
	assert.deepEqual(s.history.at(-1), { day: Math.floor(Date.now() / 86_400_000), requests: s.requestsToday, rows: s.rowsWrittenToday }); // today, in the 14-day history
	assert.equal(s.deleted, false);
	a.ws.close();
});

test("sealed history is authenticated, listed newest first per document, and can be cleared", async () => {
	const v = vault(), tok = token(), home = `http://localhost:${PORT}`;
	const root = `${home}/vault/${v}`;
	const a = await connect(v, tok);
	await a.catchUp(0);
	const post = (path: string, ...parts: Uint8Array[]) => fetch(`${root}/${path}`, { method: "POST", body: Buffer.concat(parts) });
	const list = async (tag: Uint8Array) => {
		const response = await post("history/list", tok, tag);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "application/octet-stream");
		return [...new Uint8Array(await response.arrayBuffer())];
	};
	const first = doc(1), other = doc(2);
	const older = Uint8Array.of(255), newer = Uint8Array.of(0, 42), elsewhere = Uint8Array.of(7);
	for (const path of ["history", "history/list", "history/clear"]) {
		assert.equal((await post(path, token(), first)).status, 401);
		assert.equal((await fetch(`${root}/${path}`)).status, 405);
	}
	assert.equal((await post("history", tok, first)).status, 413);
	assert.equal((await post("history", tok, first, new Uint8Array(1024 * 1024 + 65))).status, 413);
	const before = await stats(home, v);
	for (const [tag, envelope] of [[first, older], [first, newer], [other, elsewhere]] as const) {
		const response = await post("history", tok, tag, envelope);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true });
	}
	const after = await stats(home, v);
	assert.equal(after.requestsToday - before.requestsToday, 3);
	assert.ok(after.rowsWrittenToday - before.rowsWrittenToday >= 3);
	assert.deepEqual(await list(first), [0, 0, 0, 2, 0, 42, 0, 0, 0, 1, 255]);
	assert.deepEqual(await list(other), [0, 0, 0, 1, 7]);
	assert.equal((await post("history/list", tok, first, Uint8Array.of(0))).status, 400);
	assert.equal((await post("history/clear", tok, first, Uint8Array.of(0))).status, 400);
	const clearDoc = await post("history/clear", tok, first);
	assert.equal(clearDoc.status, 200);
	assert.deepEqual(await clearDoc.json(), { ok: true });
	assert.deepEqual(await list(first), []);
	assert.deepEqual(await list(other), [0, 0, 0, 1, 7]);
	const clearAll = await post("history/clear", tok);
	assert.equal(clearAll.status, 200);
	assert.deepEqual(await clearAll.json(), { ok: true });
	assert.deepEqual(await list(other), []);
	assert.equal((await post("history", tok, first, newer)).status, 200);
	assert.equal((await post("delete", tok)).status, 200);
	assert.equal(await a.closed, CLOSE.deleted);
	assert.equal((await post("history", tok, first, newer)).status, 410);
	assert.equal((await post("history/list", tok, first)).status, 410);
	assert.equal((await post("history/clear", tok)).status, 410);
});

test("history evicts the oldest copy when uploads exceed the vault's 50 MiB limit", async () => {
	const v = vault(), tok = token();
	const a = await connect(v, tok);
	await a.catchUp(0);
	a.ws.close();
	const root = `http://localhost:${PORT}/vault/${v}/history`;
	const upload = async (body: Uint8Array) => {
		const response = await fetch(root, { method: "POST", body });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true });
	};
	const marker = Buffer.concat([tok, doc(1)]);
	const listMarker = async () => {
		const response = await fetch(`${root}/list`, { method: "POST", body: marker });
		assert.equal(response.status, 200);
		return (await response.arrayBuffer()).byteLength;
	};
	await upload(Buffer.concat([marker, Uint8Array.of(1)]));
	const copy = Buffer.concat([tok, doc(2), new Uint8Array(1024 * 1024)]);
	for (let i = 0; i < 49; i++) await upload(copy);
	assert.equal(await listMarker(), 5);
	await upload(copy);
	assert.equal(await listMarker(), 0);
	// The running total follows a clear: a fresh copy is not evicted by bytes that are gone.
	assert.equal((await fetch(`${root}/clear`, { method: "POST", body: tok })).status, 200);
	await upload(Buffer.concat([marker, Uint8Array.of(1)]));
	await upload(copy);
	assert.equal(await listMarker(), 5);
});

const snapshotPost = (v: string, path: string, ...parts: Uint8Array[]) => fetch(`http://localhost:${PORT}/vault/${v}/${path}`, { method: "POST", body: Buffer.concat(parts) });
const snapshotPart = (id: Uint8Array, index: number, count: number, envelope: Uint8Array) => {
	const header = Buffer.alloc(4);
	header.writeUInt16BE(index, 0);
	header.writeUInt16BE(count, 2);
	return Buffer.concat([id, header, envelope]);
};
// A device's names report, with its earlier choice to carry over; the reply says the vault's settings.
const settingsOf = async (v: string, tok: Uint8Array, settings?: unknown) => ((await (await snapshotPost(v, "names", tok, bytes(JSON.stringify({ settings })))).json()) as { settings: unknown }).settings;

test("vault settings: unset takes uploads as 0.2.1 did; carry-over turns snapshots on and backup off; off refuses uploads", async () => {
	const v = vault(), tok = token(), a = await connect(v, tok);
	await a.catchUp(0);
	const post = (path: string, ...parts: Uint8Array[]) => snapshotPost(v, path, tok, ...parts);
	assert.deepEqual(await settingsOf(v, tok), { snapshots: null, historyBackup: null });
	assert.deepEqual((await stats(`http://localhost:${PORT}`, v)).settings, { snapshots: null, historyBackup: null });
	// Unset: a 0.2.1 device (no carry-over) keeps uploading both.
	assert.equal((await post("snapshot", snapshotPart(doc(1), 0, 1, Uint8Array.of(1)))).status, 200);
	assert.equal((await post("history", doc(1), Uint8Array.of(1))).status, 200);
	// Two devices disagree: snapshots off and backup on change nothing; snapshots on and backup off win, and stay.
	assert.deepEqual(await settingsOf(v, tok, { snapshots: false, historyBackup: true }), { snapshots: null, historyBackup: null });
	assert.deepEqual(await settingsOf(v, tok, { snapshots: true, historyBackup: false }), { snapshots: true, historyBackup: false });
	assert.deepEqual(await settingsOf(v, tok, { snapshots: false, historyBackup: true }), { snapshots: true, historyBackup: false });
	assert.deepEqual(await settingsOf(v, tok, { snapshots: "no", historyBackup: 1 }), { snapshots: true, historyBackup: false });
	const off = await post("history", doc(1), Uint8Array.of(2));
	assert.deepEqual([off.status, await off.json()], [403, { error: "off" }]);
	// Off deletes nothing: the copy made before is still listed, and can still be cleared.
	assert.deepEqual([...new Uint8Array(await (await post("history/list", doc(1))).arrayBuffer())], [0, 0, 0, 1, 1]);
	assert.equal((await post("snapshot/list")).status, 200);
	a.ws.close();
});

test("sealed vault snapshots authenticate, complete out of order, stream in order, and can be erased", async () => {
	const v = vault(), tok = token(), a = await connect(v, tok);
	await a.catchUp(0);
	const post = (path: string, ...parts: Uint8Array[]) => snapshotPost(v, path, tok, ...parts);
	const id = doc(1), other = doc(2);
	const envelopes = [Uint8Array.of(1, 1, 7, 1, 2, 3, 4, 30), Uint8Array.of(20, 21), Uint8Array.of(10)];
	const paths = ["snapshot", "snapshot/list", "snapshot/get", "snapshot/delete"];
	for (const path of paths) {
		assert.equal((await snapshotPost(v, path, token())).status, 401);
		assert.equal((await fetch(`http://localhost:${PORT}/vault/${v}/${path}`)).status, 405);
	}
	assert.equal((await post("snapshot/list", id)).status, 400);
	assert.equal((await post("snapshot/get", id.subarray(0, 15))).status, 400);
	assert.equal((await post("snapshot/delete", id.subarray(0, 15))).status, 400);
	assert.equal((await post("snapshot/get", id)).status, 404);
	for (const [index, count] of [[0, 0], [0, 513], [1, 1]]) {
		assert.equal((await post("snapshot", snapshotPart(id, index, count, envelopes[0]))).status, 400);
	}
	for (const length of [0, 1024 * 1024 + 257]) {
		assert.equal((await post("snapshot", snapshotPart(id, 0, 1, new Uint8Array(length)))).status, 413);
	}

	const home = `http://localhost:${PORT}`;
	const unknown = await post("snapshot", snapshotPart(id, 2, 3, envelopes[2]));
	assert.equal(unknown.status, 409);
	assert.deepEqual(await unknown.json(), { error: "restart" });
	const before = await stats(home, v);
	const first = snapshotPart(id, 0, 3, envelopes[0]);
	const response = await post("snapshot", first);
	assert.equal(response.status, 200);
	const started = await response.json() as { day: number };
	const day = started.day;
	assert.deepEqual(started, { ok: true, day, complete: false });
	const after = await stats(home, v);
	assert.equal(after.requestsToday - before.requestsToday, 1);
	assert.ok(after.rowsWrittenToday - before.rowsWrittenToday >= 2);
	const list = async () => {
		const r = await post("snapshot/list");
		assert.equal(r.status, 200);
		return await r.json() as { at: number }[];
	};
	const [row] = await list();
	assert.ok(row.at >= Date.now() - 60_000 && row.at <= Date.now());
	assert.equal(Math.floor(row.at / 86_400_000), day);
	const metadata = { id: Buffer.from(id).toString("hex"), day, epoch: 0x01020304, parts: 3, at: row.at };
	assert.deepEqual(row, { ...metadata, received: 1, size: 8, complete: false });
	assert.equal((await post("snapshot/get", id)).status, 404);
	const taken = await post("snapshot", snapshotPart(other, 0, 1, envelopes[0]));
	assert.equal(taken.status, 409);
	assert.deepEqual(await taken.json(), { error: "taken" });
	const retry = await post("snapshot", first);
	assert.equal(retry.status, 200);
	assert.deepEqual(await retry.json(), started);
	assert.equal((await post("snapshot", snapshotPart(id, 0, 3, Uint8Array.of(2, ...envelopes[0].subarray(1))))).status, 409);
	assert.equal((await post("snapshot", snapshotPart(id, 0, 2, envelopes[0]))).status, 409);
	for (const index of [2, 1]) {
		const upload = await post("snapshot", snapshotPart(id, index, 3, envelopes[index]));
		assert.equal(upload.status, 200);
		assert.deepEqual(await upload.json(), { ok: true, day, complete: index === 1 });
	}
	const [finished] = await list();
	assert.ok(finished.at >= row.at);
	assert.deepEqual(finished, { ...metadata, at: finished.at, received: 3, size: 11, complete: true });
	const get = await post("snapshot/get", id);
	assert.equal(get.status, 200);
	assert.equal(get.headers.get("content-type"), "application/octet-stream");
	assert.deepEqual(new Uint8Array(await get.arrayBuffer()), Uint8Array.of(
		0, 0, 0, 0, 0, 8, ...envelopes[0],
		0, 1, 0, 0, 0, 2, ...envelopes[1],
		0, 2, 0, 0, 0, 1, ...envelopes[2],
	));
	const retried = await post("snapshot", first);
	assert.equal(retried.status, 200);
	assert.deepEqual(await retried.json(), { ok: true, day, complete: true });

	assert.equal((await post("snapshot/delete", other)).status, 200);
	assert.equal((await post("snapshot/get", id)).status, 200);
	assert.equal((await post("snapshot/delete", id)).status, 200);
	assert.equal((await post("snapshot/get", id)).status, 404);
	const replacement = snapshotPart(id, 0, 1, envelopes[1]);
	assert.equal((await post("snapshot", replacement)).status, 200);
	assert.equal((await post("snapshot/delete")).status, 200);
	assert.deepEqual(await list(), []);
	assert.equal((await post("snapshot", replacement)).status, 200);
	assert.equal((await post("delete")).status, 200);
	assert.equal(await a.closed, CLOSE.deleted);
	for (const path of paths) assert.equal((await post(path)).status, 410);
});

async function snapshotVaultWithDb() {
	const directory = join(dev.persistDir, "v3/do/ownsync-Vault");
	const existing = new Set(readdirSync(directory));
	const v = vault(), tok = token(), a = await connect(v, tok);
	await a.catchUp(0);
	const [file] = readdirSync(directory).filter((file) => /^[0-9a-f]{64}\.sqlite$/.test(file) && !existing.has(file));
	assert.ok(file, "the local Worker created a new SQLite database for this vault");
	return { v, tok, a, db: new DatabaseSync(join(directory, file)) };
}

test("snapshot leases renew on accepted parts, and expired uploads must restart", async () => {
	const { v, tok, a, db } = await snapshotVaultWithDb();
	try {
		const upload = (id: Uint8Array, index = 0) => snapshotPost(v, "snapshot", tok, snapshotPart(id, index, 3, Uint8Array.of(1)));
		const age = (id: Uint8Array, elapsed = 3_600_001) => {
			// The Worker runs in a separate process. Age the lease in its local database without a test route.
			assert.equal(db.prepare("UPDATE snapshots SET at = ? WHERE snapshot = ?").run(Date.now() - elapsed, id).changes, 1);
		};
		const first = doc(1), second = doc(2);
		assert.equal((await upload(first)).status, 200);
		assert.equal((await upload(second)).status, 409);
		for (const index of [0, 1]) {
			age(first, 3_000_000);
			const now = Date.now();
			assert.equal((await upload(first, index)).status, 200);
			assert.ok(Number(db.prepare("SELECT at FROM snapshots WHERE snapshot = ?").get(first)?.at) >= now);
		}
		age(first);
		const expired = await upload(first, 2);
		assert.equal(expired.status, 409);
		assert.deepEqual(await expired.json(), { error: "restart" });
		assert.equal((await upload(second)).status, 200);
		assert.equal(db.prepare("SELECT count(*) AS n FROM snapshot_parts WHERE snapshot = ?").get(first)?.n, 0);
		age(second);
		a.send({ t: "hello", token: tok });
		await a.catchUp(0);
		assert.equal(db.prepare("SELECT count(*) AS n FROM snapshots").get()?.n, 0);
		assert.equal(db.prepare("SELECT count(*) AS n FROM snapshot_parts").get()?.n, 0);
		assert.equal((await upload(first)).status, 200);
		assert.equal((await upload(first, 1)).status, 200);
		assert.equal((await upload(first, 2)).status, 200);
		db.exec("UPDATE snapshots SET day = day - 1, at = at - 86400000; UPDATE snapshot_parts SET day = day - 1, at = at - 86400000");
		assert.equal((await upload(second)).status, 200);
		const response = await snapshotPost(v, "snapshot/list", tok);
		assert.equal(response.status, 200);
		const listed = await response.json() as { id: string; complete: boolean }[];
		assert.deepEqual(listed.map(({ id, complete }) => [id, complete]), [[Buffer.from(second).toString("hex"), false], [Buffer.from(first).toString("hex"), true]]);
		assert.equal((await snapshotPost(v, "delete", tok)).status, 200);
		for (const table of ["history", "snapshots", "snapshot_parts"]) {
			assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
		}
	} finally {
		db.close();
		a.ws.close();
	}
});

test("a snapshot part prunes old complete rows for space or is refused without erasing uploads", async () => {
	const { v, tok, a, db } = await snapshotVaultWithDb();
	try {
		const today = Math.floor(Date.now() / 86_400_000);
		const insert = db.prepare("INSERT INTO snapshots (snapshot, day, at, epoch, parts, received, size) VALUES (?, ?, ?, 0, 2, ?, ?)");
		const size = SNAPSHOT_BUDGET / 8;
		for (let i = 1; i <= 8; i++) insert.run(doc(i), today - i, Date.now(), i <= 3 ? 2 : 1, size);
		const upload = (index: number) => snapshotPost(v, "snapshot", tok, snapshotPart(doc(9), index, 3, Uint8Array.of(1)));
		assert.equal((await upload(0)).status, 200);
		assert.equal(db.prepare("SELECT 1 FROM snapshots WHERE snapshot = ?").get(doc(3)), undefined); // the two newest complete stay
		assert.ok(db.prepare("SELECT 1 FROM snapshots WHERE snapshot = ?").get(doc(2)));
		assert.ok(db.prepare("SELECT 1 FROM snapshots WHERE snapshot = ?").get(doc(1)));
		insert.run(doc(10), today - 9, Date.now(), 1, size - 1);
		const refused = await upload(1);
		assert.equal(refused.status, 413);
		assert.deepEqual(await refused.json(), { error: "snapshot storage full" });
		assert.equal(db.prepare("SELECT sum(size) AS size FROM snapshots").get()?.size, SNAPSHOT_BUDGET);
		assert.equal(db.prepare("SELECT received FROM snapshots WHERE snapshot = ?").get(doc(9))?.received, 1);
		assert.ok(db.prepare("SELECT 1 FROM snapshots WHERE snapshot = ?").get(doc(1)));
	} finally {
		db.close();
		a.ws.close();
	}
});

test("a vault snapshot cannot exceed 50 MiB, and rejection leaves the final part available", async () => {
	const v = vault(), tok = token(), a = await connect(v, tok);
	await a.catchUp(0);
	a.ws.close();
	const id = doc(1), part = new Uint8Array(1024 * 1024 + 64);
	const upload = (index: number, envelope: Uint8Array) => snapshotPost(v, "snapshot", tok, snapshotPart(id, index, 50, envelope));
	for (let index = 0; index < 49; index++) assert.equal((await upload(index, part)).status, 200);
	const remaining = 50 * 1024 * 1024 - 49 * part.length;
	assert.equal((await upload(49, part.subarray(0, remaining + 1))).status, 413);
	const last = await upload(49, part.subarray(0, remaining));
	assert.equal(last.status, 200);
	const result = await last.json() as { complete: boolean };
	assert.equal(result.complete, true);
});

test("vault snapshot retention keeps daily and ISO-weekly representatives and trims oldest bytes first", () => {
	const today = Date.parse("2026-11-19") / 86_400_000; // Thursday
	const row = (age: number, size = 1, complete = true) => ({ day: today - age, size, complete });
	const retainedAges = (rows: ReturnType<typeof row>[]) => {
		const removed = snapshotsToPrune(rows, today);
		return rows.filter((item) => !removed.includes(item)).map((item) => today - item.day).sort((a, b) => a - b);
	};
	// Nothing older than 30 days: the weekly one 32 days back goes.
	assert.deepEqual(retainedAges(Array.from({ length: 45 }, (_, age) => row(age)).reverse()), [0, 1, 2, 3, 4, 5, 6, 11, 18, 25]);
	// Except the two newest complete ones, however old: a vault that stopped taking snapshots keeps its last two.
	assert.deepEqual(retainedAges([row(0, 1, false), row(45), row(46), row(47)]), [0, 45, 46]);
	// Within the 150 MiB budget: three of the largest (50 MiB) snapshots, the newest first.
	assert.deepEqual(retainedAges([0, 1, 2, 3, 4, 5, 6, 11, 18].map((age) => row(age, 50 * 1024 * 1024))), [0, 1, 2]);
});

// --- version-scoped chunks and Clean up (DESIGN.md section 10) ---

const cleanupPost = (v: string, body: unknown) => fetch(`http://localhost:${PORT}/test-cleanup/${v}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ removed?: number; more?: boolean; error?: string }>);
const cleanupSizes = (v: string) => fetch(`http://localhost:${PORT}/test-cleanup/${v}/sizes`).then((r) => r.json() as Promise<{ at: number; old: number; deleted: number }[]>);
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("vput: a chunk name belongs to one version for good; an old-style chunk or another version's can't be claimed", async () => {
	const { v, tok, a, db } = await snapshotVaultWithDb();
	try {
		a.send({ t: "put", name: name(1), envelope: bytes("old-style") });
		assert.deepEqual(await a.next(), { t: "stored", name: name(1) });
		const vput = async (tag: number, n: number, body = "v") => { a.send({ t: "vput", tag: name(tag), name: name(n), envelope: bytes(body) }); return (await a.next()).t; };
		assert.equal(await vput(101, 1), "missing"); // there already, and nobody's
		assert.equal(await vput(101, 2), "stored");
		assert.equal(await vput(102, 2, "another version's"), "missing");
		assert.equal(await vput(101, 2, "again"), "stored"); // its own: fine, and the first envelope stays
		assert.deepEqual(db.prepare("SELECT lower(hex(name)) AS name, lower(hex(tag)) AS tag FROM version_chunks").all().map((r) => ({ ...r })), [{ name: hexOf(name(2)), tag: hexOf(name(101)) }]);
		assert.equal(Buffer.from(db.prepare("SELECT envelope FROM chunks WHERE name = ?").get(name(2))!.envelope as Uint8Array).toString(), "v");
		// The names reply says whether every recent device can read these: not while a device reports an older version.
		const names = async () => (await (await fetch(`http://localhost:${PORT}/vault/${v}/names`, { method: "POST", body: new Uint8Array([...tok, ...bytes(JSON.stringify({ device: "0000AAAA" }))]) })).json() as { scoped: boolean }).scoped;
		assert.equal(await names(), true);
		a.send(status(7, 0, "0.1.5"));
		await statsUntil(v, (s) => s.devices.some((d) => d.version === "0.1.5"));
		assert.equal(await names(), false);
		a.send(status(7, 0, "0.2.0 mobile"));
		await statsUntil(v, (s) => s.devices.some((d) => d.version === "0.2.0"));
		assert.equal(await names(), true);
	} finally {
		db.close();
		a.ws.close();
	}
});

test("Clean up removes only past, retired versions a full list confirmed: never current ones, never old-style chunks", async () => {
	const { v, a, db } = await snapshotVaultWithDb();
	try {
		const vput = async (tag: number, n: number, body: string) => { a.send({ t: "vput", tag: name(tag), name: name(n), envelope: bytes(body) }); assert.equal((await a.next()).t, "stored"); };
		const mark = async (flags: number, ...tags: number[]) => { a.send({ t: "mark", id: flags, flags, tags: tags.map(name) }); const f = await a.next(); assert.equal(f.t, "marked"); return (f as { tags: Uint8Array[] }).tags.map((t) => t[0]); };
		a.send({ t: "put", name: name(1), envelope: bytes("old-style") });
		await a.next();
		await vput(101, 11, "A, part one"); // A: replaced last January
		await vput(101, 12, "A, part two");
		await vput(102, 21, "B is deleted"); // B: deleted last February
		await vput(103, 31, "C is current");
		await vput(104, 41, "D retired after the last list");
		assert.deepEqual(await mark(1, 101, 104), []);
		assert.deepEqual(await mark(1 | 8, 102), []);
		await new Promise((r) => setTimeout(r, 5));
		assert.deepEqual(await mark(2 | 4 | 16, 103), []); // a full list from a device that hasn't said who it is: not counted
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lists").get()!.n, 0);
		a.send(status(5, 0, "0.2.0"));
		assert.deepEqual(await mark(2 | 4 | 16, 103), []); // now it is: the vault's only device has listed what it holds current
		// When these happened, as if long ago.
		const year = new Date().getUTCFullYear() - 1, at = (month: number, day: number) => Date.UTC(year, month, day);
		const retire = db.prepare("UPDATE versions SET retired_at = ? WHERE tag = ?");
		retire.run(at(0, 15), name(101));
		retire.run(at(1, 10), name(102));
		retire.run(at(3, 5), name(104));
		db.prepare("UPDATE lists SET at = ?").run(at(2, 1));
		assert.deepEqual(await cleanupSizes(v), [
			{ at: at(0, 15), old: "A, part one".length + "A, part two".length, deleted: 0 },
			{ at: at(1, 10), old: 0, deleted: "B is deleted".length },
		]);

		// Only ranges that end by the start of the current period, on the Worker's clock, in the browser's time zone.
		const lastYear = [at(0, 1), Date.UTC(year + 1, 0, 1)];
		const refused = { error: "Only past periods can be cleaned up." };
		assert.deepEqual(await cleanupPost(v, { ranges: [[at(0, 1), Date.now() + 86_400_000]], zone: "UTC", months: 1 }), refused);
		assert.deepEqual(await cleanupPost(v, { ranges: [[at(0, 1), Date.UTC(year + 1, 0, 1) + 1]], zone: "UTC", months: 12 }), refused);
		assert.deepEqual(await cleanupPost(v, { ranges: [lastYear], zone: "Pacific/Kiritimati", months: 12 }), refused); // its year began 14 hours earlier
		assert.deepEqual(await cleanupPost(v, { ranges: [lastYear], zone: "Not/AZone", months: 12 }), { error: "bad time zone" });
		assert.deepEqual(await cleanupPost(v, { ranges: [], zone: "UTC", months: 12 }), refused);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!.n, 6);

		// A bounded amount a request: half of A goes, and A is then missing a chunk when a device says it's current again.
		assert.deepEqual(await cleanupPost(v, { ranges: [[at(0, 1), at(1, 1)]], zone: "UTC", months: 12, limit: 1 }), { removed: 1, more: true });
		assert.deepEqual(await mark(2, 101, 103), [101]);
		assert.deepEqual(await mark(2, 101), [101]); // every time, from what is stored
		// The rest of last year: B goes; A is current now, D unconfirmed, C current, the old-style chunk nobody's.
		assert.deepEqual(await cleanupPost(v, { ranges: [[at(0, 1), Date.UTC(year + 1, 0, 1) - 14 * 3_600_000]], zone: "Pacific/Kiritimati", months: 12 }), { removed: 1, more: false });
		const left = db.prepare("SELECT name FROM chunks").all().map((r) => Buffer.from(r.name as Uint8Array)[0]).sort((x, y) => x! - y!);
		assert.equal(left.length, 4);
		assert.ok(left.includes(1) && left.includes(31) && left.includes(41) && (left.includes(11) !== left.includes(12)));
		assert.deepEqual(await cleanupSizes(v), []);
		// Only asked (no flags), as Recently deleted does: B is named, and stays retired.
		assert.deepEqual(await mark(0, 102, 103), [102]);
		assert.notEqual(db.prepare("SELECT retired_at FROM versions WHERE tag = ?").get(name(102))!.retired_at, null);
		a.send({ t: "get", name: name(21) });
		assert.deepEqual(await a.next(), { t: "missing", name: name(21) });
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM version_chunks").get()!.n, 5); // how a missing chunk is known later
		// Put back by a device that still has the file: A is whole again.
		const gone = left.includes(11) ? 12 : 11;
		await vput(101, gone, "A, again");
		assert.deepEqual(await mark(2, 101), []);
	} finally {
		db.close();
		a.ws.close();
	}
});

const DAY = 86_400_000;
const markOn = (a: Awaited<ReturnType<typeof connect>>) => async (flags: number, ...tags: number[]) => { a.send({ t: "mark", id: flags, flags, tags: tags.map(name) }); const f = await a.next(); assert.equal(f.t, "marked"); };
const vputOn = (a: Awaited<ReturnType<typeof connect>>) => async (tag: number, n: number) => { a.send({ t: "vput", tag: name(tag), name: name(n), envelope: bytes(`chunk ${n}`) }); assert.equal((await a.next()).t, "stored"); };

test("a device list of 64, all seen lately, confirms nothing: a 65th may have fallen off it", async () => {
	const { v, a, db } = await snapshotVaultWithDb();
	try {
		const mark = markOn(a);
		await vputOn(a)(101, 11);
		a.send(status(1, 0, "0.2.0"));
		await mark(1, 101);
		await mark(2 | 4 | 16);
		db.prepare("UPDATE versions SET retired_at = ?").run(Date.now() - 2 * DAY);
		db.prepare("UPDATE lists SET at = ?").run(Date.now() - DAY);
		const add = db.prepare("INSERT INTO devices (id, last_online, version, conflicts) VALUES (?, ?, '0.2.0', 0)"), list = db.prepare("INSERT INTO lists (device, at) VALUES (?, ?)");
		for (let i = 2; i <= 64; i++) {
			const id = `ABCD${i.toString(16).toUpperCase().padStart(4, "0")}`;
			add.run(id, Date.now());
			list.run(id, Date.now() - DAY);
		}
		assert.deepEqual(await cleanupSizes(v), []);
		db.prepare("UPDATE devices SET last_online = ? WHERE id = 'ABCD0040'").run(Date.now() - 31 * DAY); // one not seen lately: the rest have listed
		assert.equal((await cleanupSizes(v)).length, 1);
	} finally {
		db.close();
		a.ws.close();
	}
});

test("a device connected for over 30 days still counts as seen lately, for scoped uploads and for confirmation", async () => {
	const { v, tok, a, db } = await snapshotVaultWithDb();
	const b = await connect(v, tok);
	try {
		await b.catchUp(0);
		a.send(status(7, 0, "0.1.5"));
		b.send(status(8, 0, "0.2.0"));
		await statsUntil(v, (s) => s.devices.length === 2);
		const mark = markOn(b);
		await vputOn(b)(101, 11);
		await mark(1, 101);
		await mark(2 | 4 | 16);
		db.prepare("UPDATE devices SET last_online = ? WHERE id = 'ABCD0007'").run(Date.now() - 40 * DAY); // a's connection opened long ago
		db.prepare("UPDATE versions SET retired_at = ?").run(Date.now() - 2 * DAY);
		db.prepare("UPDATE lists SET at = ?").run(Date.now() - DAY);
		assert.deepEqual(await cleanupSizes(v), []); // a, still connected, has sent no list
		const names = await fetch(`http://localhost:${PORT}/vault/${v}/names`, { method: "POST", body: new Uint8Array([...tok, ...bytes(JSON.stringify({ device: "ABCD0008" }))]) });
		assert.equal(((await names.json()) as { scoped: boolean }).scoped, false); // a runs 0.1.5
	} finally {
		db.close();
		a.ws.close();
		b.ws.close();
	}
});

test("a full list dates from its first frame, flagged as such, not from an earlier report; lists of devices not seen in 30 days go", async () => {
	const { a, db } = await snapshotVaultWithDb();
	try {
		const mark = markOn(a), vput = vputOn(a);
		a.send(status(1, 0, "0.2.0"));
		await vput(103, 31);
		await vput(104, 41);
		await mark(2, 103); // an ordinary report, hours before the daily list
		await new Promise((r) => setTimeout(r, 5));
		await mark(1, 104);
		await new Promise((r) => setTimeout(r, 5));
		db.prepare("INSERT INTO devices (id, last_online, version, conflicts) VALUES ('ABCD0F00', ?, '0.2.0', 0)").run(Date.now() - 40 * DAY);
		db.prepare("INSERT INTO lists (device, at) VALUES ('ABCD0F00', ?), ('ABCD0F01', ?)").run(Date.now() - 40 * DAY, Date.now() - 50 * DAY);
		await mark(2 | 16, 103);
		await mark(2 | 4);
		const retired = db.prepare("SELECT retired_at FROM versions WHERE tag = ?").get(name(104))!.retired_at as number;
		assert.ok((db.prepare("SELECT at FROM lists WHERE device = 'ABCD0001'").get()!.at as number) > retired, "the list began after the retirement");
		assert.deepEqual(db.prepare("SELECT device FROM lists").all().map((r) => r.device), ["ABCD0001"]);
	} finally {
		db.close();
		a.ws.close();
	}
});

test("deleting a vault takes its token; then its devices are told 4004, it can't be created again, and only a tombstone is left", async () => {
	const v = vault(), tok = token(), home = `http://localhost:${PORT}`;
	const a = await connect(v, tok), b = await connect(v, tok);
	await a.catchUp(0);
	await b.catchUp(0);
	await a.publish(doc(1), "soon gone");
	a.send(status(1));
	await statsUntil(v, (s) => s.devices.length === 1);
	const post = (what: string, body: Uint8Array) => fetch(`${home}/vault/${v}/${what}`, { method: "POST", body }).then((r) => r.status);
	for (const wrong of [token(), new Uint8Array(0), new Uint8Array([...tok, 0])]) assert.equal(await post("delete", wrong), 401);
	assert.equal(await post("delete", tok), 200);
	assert.equal(await a.closed, CLOSE.deleted);
	assert.equal(await b.closed, CLOSE.deleted);
	// Not asked for an owner code, and a fresh one doesn't bring it back, with the old token or a new one.
	for (const t of [tok, token()]) assert.equal(await (await connect(v, t, await OWNER!())).closed, CLOSE.deleted);
	const bare = await connect(v);
	bare.send({ t: "hello", token: tok });
	assert.equal(await bare.closed, CLOSE.deleted);
	assert.equal(await post("delete", tok), 410);
	assert.equal(await post("names", new Uint8Array([...tok, ...bytes("{}")])), 410);
	assert.deepEqual({ ...(await stats(home, v)), bytes: 0 }, { bytes: 0, requestsToday: 0, rowsWrittenToday: 0, history: [], lastActivity: null, name: "", deleted: true, devices: [], settings: { snapshots: null, historyBackup: null } });
});

test("history expiry has an index on its time, so it doesn't scan the table", async () => {
	const { a, db } = await snapshotVaultWithDb();
	assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'history_at'").get());
	db.close();
	a.ws.close();
});

test("delete and names read at most a small body before checking the token", async () => {
	const v = vault(), tok = token();
	const a = await connect(v, tok);
	await a.catchUp(0);
	for (const path of ["delete", "names"]) {
		// A body that never ends: answered after the first bytes, not read to the end.
		// Announces 1 GB and sends only the start: answered without waiting for the rest.
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const req = request({ port: PORT, host: "localhost", method: "POST", path: `/vault/${v}/${path}`, agent: false, headers: { "content-length": String(1 << 30) } });
			const timer = setTimeout(() => (req.destroy(), resolve(undefined)), 10_000);
			req.on("response", (res) => (clearTimeout(timer), req.destroy(), resolve(res.statusCode)));
			req.on("error", (err) => (clearTimeout(timer), reject(err)));
			req.write(new Uint8Array(64 * 1024));
		});
		assert.equal(status, 401);
	}
	const big = await fetch(`http://localhost:${PORT}/vault/${v}/names`, { method: "POST", body: new Uint8Array([...tok, ...bytes(JSON.stringify({ vault: "x".repeat(1100) }))]) });
	assert.equal(big.status, 413);
	a.ws.close();
});

test("a request for a vault that doesn't exist leaves no storage behind", async () => {
	const directory = join(dev.persistDir, "v3/do/ownsync-Vault");
	const existing = new Set(readdirSync(directory));
	const v = vault();
	assert.equal((await fetch(`http://localhost:${PORT}/vault/${v}/names`, { method: "POST", body: new Uint8Array(40) })).status, 401);
	assert.equal((await fetch(`http://localhost:${PORT}/vault/${v}/history/list`, { method: "POST", body: new Uint8Array(48) })).status, 401);
	const bare = await connect(v);
	bare.send({ t: "fetch", from: 0 });
	assert.deepEqual(await bare.records(), { got: [], recovery: "" });
	bare.send({ t: "hello", token: token() }); // no owner code
	assert.equal(await bare.closed, CLOSE.notOwner);
	for (const file of readdirSync(directory).filter((f) => f.endsWith(".sqlite") && !existing.has(f))) {
		const db = new DatabaseSync(join(directory, file));
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'").all();
		db.close();
		assert.deepEqual(tables, []);
	}
});
