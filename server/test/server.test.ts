// Runs the Worker under `wrangler dev` with fresh local storage and drives it over WebSockets.

import { test, after } from "node:test";
import assert from "node:assert/strict";
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

// Set by the first test: a fresh owner code ("Set up another vault" from its vault) for each vault a test creates.
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
	// "Set up another vault": a device of a vault gets a new owner code with its token, and nobody else does.
	const mint = (vaultHex: string, body: Uint8Array) => fetch(`${home}vault/${vaultHex}/mint`, { method: "POST", body }).then(async (r) => ({ status: r.status, ...((await r.json()) as { owner?: string }) }));
	for (const [vh, t] of [[v, token()], [vault(), tok], [v, new Uint8Array(0)], [v, new Uint8Array([...tok, 0])]] as const) assert.equal((await mint(vh, t)).status, 401);
	const minted = (await mint(v, tok)).owner;
	assert.match(minted!, /^[0-9a-f]{64}$/);
	const another = await connect(vault(), token(), hexToBytes(minted!));
	assert.deepEqual(await another.catchUp(0), { got: [], head: 0, pages: 1 });
	another.ws.close();
	assert.equal(await (await connect(vault(), token(), hexToBytes(minted!))).closed, CLOSE.notOwner); // each code makes one vault
	OWNER = async () => hexToBytes((await mint(v, tok)).owner!);
});

test("every frame survives encoding and decoding", () => {
	const client: ClientFrame[] = [
		{ t: "hello", token: token() }, { t: "hello", token: token(), owner: token() }, { t: "subscribe", after: 2 ** 40 + 7 }, { t: "publish", id: 4_000_000_000, doc: doc(3), envelope: bytes("x") },
		{ t: "snapshot", doc: doc(4), base: 99, envelope: bytes("yy") }, { t: "live", doc: doc(5), envelope: bytes("z") },
		{ t: "fetch", from: 3 }, { t: "append", number: 2, recovery: bytes("r"), blob: bytes("rec") },
		{ t: "rotate", number: 5, tokenHash: token(), recovery: new Uint8Array(0), blob: bytes("rot") },
		{ t: "put", name: name(6), envelope: bytes("c") }, { t: "get", name: name(7) }, { t: "status", id: Uint8Array.of(1, 2, 3, 4), conflicts: 3, version: "0.1.0-beta" },
	];
	for (const f of client) assert.deepEqual(decodeClient(encodeClient(f)), f);
	const server: ServerFrame[] = [
		{ t: "entry", seq: 2 ** 40 + 1, doc: doc(1), snapshot: true, envelope: bytes("e") }, { t: "more", seq: 5 }, { t: "synced", seq: 6 },
		{ t: "ack", id: 7, seq: 8 }, { t: "live", doc: doc(2), envelope: bytes("l") },
		{ t: "record", number: 4, blob: bytes("rec") }, { t: "records", recovery: bytes("sealed") },
		{ t: "stored", name: name(3) }, { t: "chunk", name: name(4), envelope: bytes("k") }, { t: "missing", name: name(5) },
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
	assert.deepEqual(s.devices.map(({ id, online, version, conflicts }) => ({ id, online, version, conflicts })), [{ id: "ABCD0001", online: true, version: "0.1.0", conflicts: 3 }]);
	const reported = s.devices[0]!.lastOnline;
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
	assert.equal(s.deleted, false);
	a.ws.close();
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
	assert.equal(await post("mint", tok), 410);
	assert.deepEqual({ ...(await stats(home, v)), bytes: 0 }, { bytes: 0, requestsToday: 0, rowsWrittenToday: 0, lastActivity: null, deleted: true, devices: [] });
});
