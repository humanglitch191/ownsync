// The owner dashboard's API under `wrangler dev`, signed in with a software passkey (test/passkey.ts) so the real
// verification runs. Each file gets its own Worker, so this one sees setup from the very start.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { decodeServer, encodeClient } from "../src/wire.ts";
import { SETUP_KEY, startDev } from "./devServer.ts";

const dev = await startDev();
after(() => dev.stop());
const ORIGIN = `http://localhost:${dev.port}`;
import { authenticator } from "./passkey.ts";

type Res = { status: number; body: Record<string, any>; cookie: string | null };
async function call(path: string, body?: unknown, { origin = ORIGIN, cookie = "" } = {}): Promise<Res> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (origin) headers.origin = origin;
	if (cookie) headers.cookie = cookie;
	const r = await fetch(`${ORIGIN}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any>, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? null };
}

/** A vault on the Worker, with the token its devices hold. */
async function makeVault(owner: string) {
	const id = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("hex");
	const token = webcrypto.getRandomValues(new Uint8Array(32));
	const ws = new WebSocket(`ws://localhost:${dev.port}/vault/${id}`);
	ws.binaryType = "arraybuffer";
	await new Promise((r) => (ws.onopen = r));
	ws.send(encodeClient({ t: "hello", token, owner: Uint8Array.from(Buffer.from(owner, "hex")) }));
	ws.send(encodeClient({ t: "subscribe", after: 0 }));
	await new Promise<void>((r) => (ws.onmessage = (e) => { if (decodeServer(new Uint8Array(e.data as ArrayBuffer)).t === "synced") r(); }));
	return { id, token, ws };
}
const proof = (key: string, origin = ORIGIN) => createHash("sha256").update(`ownsync-setup\n${origin}\n${key}`).digest("hex");
async function setup(key: string, { ip = "203.0.113.9", ago = 0, origin = ORIGIN, body = proof(key, origin), newKey = "" } = {}): Promise<Res> {
	const headers: Record<string, string> = { origin, "CF-Connecting-IP": ip };
	if (newKey) headers["x-test-setup-key"] = newKey;
	if (ago) headers["x-test-deployed-ago"] = String(ago);
	const r = await fetch(`${ORIGIN}/api/setup`, { method: "POST", headers, body });
	return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any>, cookie: null };
}
const enrolWith = async (token: string, key: Awaited<ReturnType<typeof authenticator>>) =>
	call("/api/enrol/verify", { token, response: key.create((await call("/api/enrol/options", { token })).body as { challenge: string }) });

test("the setup key adds the first passkey: right key, in the window, once; strangers learn nothing", async () => {
	// Before any passkey, signing in looks the same as after, and fails the same way.
	const stranger = await authenticator(ORIGIN);
	const options = (await call("/api/login/options", {})).body;
	assert.equal(options.rpId, "localhost");
	assert.equal((await call("/api/login/verify", { response: await stranger.get(options as { challenge: string }) })).status, 401);
	assert.equal((await call("/api/overview")).status, 401);
	// Wrong keys, a look-alike's hash, the bare key, another site: refused alike.
	for (const body of [proof("not-the-setup-key"), proof(SETUP_KEY, "https://look-alike.example"), SETUP_KEY, ""]) assert.deepEqual((await setup("", { body })).body, { error: "wrong key" });
	assert.equal((await setup(SETUP_KEY, { origin: "https://evil.example" })).status, 403);
	// Ten minutes after the deploy, the right key is turned away too (only someone with it learns why).
	assert.deepEqual((await setup(SETUP_KEY, { ago: 11 * 60 * 1000 })).body, { error: "expired" });

	// Two people with the key at once: two tokens, but only the first passkey to finish counts.
	const [a, b] = [(await setup(SETUP_KEY)).body.token, (await setup(SETUP_KEY)).body.token];
	assert.ok(a && b);
	assert.equal((await call("/api/enrol/options", { token: a }, { origin: "https://evil.example" })).status, 403);
	const owner = await authenticator(ORIGIN), rival = await authenticator(ORIGIN);
	const optionsB = (await call("/api/enrol/options", { token: b })).body as { challenge: string };
	const first = await enrolWith(a, owner);
	assert.equal(first.status, 200);
	assert.match(first.cookie!, /^__Host-vs=/);
	assert.equal((await call("/api/enrol/verify", { token: b, response: rival.create(optionsB) })).status, 403); // its token went with the first
	// The setup key is used up; signing in is by passkey only.
	assert.deepEqual((await setup(SETUP_KEY)).body, { error: "used" });
	assert.deepEqual((await setup("still-guessing")).body, { error: "wrong key" });

	const overview = await call("/api/overview", undefined, { cookie: first.cookie! });
	assert.equal(overview.status, 200);
	assert.equal(overview.body.origin, ORIGIN);
	assert.deepEqual(overview.body.passkeys.map((p: { id: string; current: boolean }) => [p.id, p.current]), [[owner.id, true]]);
	assert.equal(overview.body.limits.requestsPerDay, 100_000);

	// Signing in: a challenge is good once, only for its purpose, only from this site.
	const login = (await call("/api/login/options", {})).body as { challenge: string };
	const signed = await owner.get(login);
	const session = await call("/api/login/verify", { response: signed });
	assert.equal(session.status, 200);
	assert.equal((await call("/api/login/verify", { response: signed })).status, 401);
	assert.equal((await call("/api/login/options", {}, { origin: "https://evil.example" })).status, 403);
	const confirm = (await call("/api/passkeys/remove/options", {}, { cookie: session.cookie! })).body as { challenge: string };
	assert.equal((await call("/api/login/verify", { response: await owner.get(confirm) })).status, 401);

	// Connect a vault: a code and an Obsidian link, each code one vault; it then shows on the dashboard.
	assert.equal((await call("/api/vault-code", {}, { cookie: session.cookie!, origin: "https://evil.example" })).status, 403);
	assert.equal((await call("/api/vault-code", {})).status, 401);
	const code = (await call("/api/vault-code", {}, { cookie: session.cookie! })).body;
	assert.match(code.code, new RegExp(`^${ORIGIN}#[0-9a-f]{64}$`));
	assert.equal(code.link, `obsidian://ownsync-setup?${new URLSearchParams({ host: ORIGIN, code: code.code.split("#")[1] })}`);
	const vault = await makeVault(code.code.split("#")[1]);
	const seen = (await call("/api/overview", undefined, { cookie: session.cookie! })).body;
	assert.deepEqual(seen.vaults.map((v: { id: string }) => v.id), [vault.id]);
	assert.ok(seen.usage.requestsToday > 0);
	// A device goes by its random ID until the owner names it here; an empty name brings the ID back.
	vault.ws.send(encodeClient({ t: "status", id: Uint8Array.of(0x3f, 0xa9, 0xc2, 0xe1), conflicts: 0, version: "0.1.1 mobile" }));
	const named = async () => { for (let i = 0; i < 50; i++) { const d = (await call("/api/overview", undefined, { cookie: session.cookie! })).body.vaults[0]?.devices[0]; if (d) return d; await new Promise((r) => setTimeout(r, 50)); } };
	assert.deepEqual([(await named()).id, (await named()).label, (await named()).mobile], ["3FA9C2E1", "", true]);
	const rename = (label: string, opts = { cookie: session.cookie! }) => call(`/api/vaults/${vault.id}/devices/3FA9C2E1/label`, { label }, opts);
	assert.equal((await rename("My phone", { cookie: "" })).status, 401);
	assert.equal((await rename("My phone")).status, 200);
	assert.equal((await named()).label, "My phone");
	assert.equal((await call(`/api/vaults/${"0".repeat(32)}/devices/3FA9C2E1/label`, { label: "x" }, { cookie: session.cookie! })).status, 404);
	await rename("  ");
	assert.equal((await named()).label, "");
	// Clean up, like every write here: the session and this site's own pages only; the vault checks the ranges.
	const cleanup = (body: unknown, opts: { cookie: string; origin?: string } = { cookie: session.cookie! }) => call(`/api/vaults/${vault.id}/cleanup`, body, opts);
	const lastYear = [Date.UTC(new Date().getUTCFullYear() - 1, 0, 1), Date.UTC(new Date().getUTCFullYear(), 0, 1)];
	assert.equal((await cleanup({ ranges: [lastYear], zone: "UTC", months: 12 }, { cookie: "" })).status, 401);
	assert.equal((await cleanup({ ranges: [lastYear], zone: "UTC", months: 12 }, { cookie: session.cookie!, origin: "https://evil.example" })).status, 403);
	assert.equal((await call(`/api/vaults/${vault.id}/cleanup/sizes`, {}, { cookie: "" })).status, 401);
	assert.deepEqual((await call(`/api/vaults/${vault.id}/cleanup/sizes`, {}, { cookie: session.cookie! })).body, []);
	assert.deepEqual((await cleanup({ ranges: [lastYear], zone: "UTC", months: 12 })).body, { removed: 0, more: false });
	const future = await cleanup({ ranges: [[lastYear[0], Date.now() + 1000]], zone: "UTC", months: 12 });
	assert.deepEqual([future.status, future.body], [400, { error: "Only past periods can be cleaned up." }]);
	assert.equal((await call(`/api/vaults/${"0".repeat(32)}/cleanup`, { ranges: [lastYear], zone: "UTC", months: 12 }, { cookie: session.cookie! })).status, 404);
	// The vault's settings: not chosen until the owner (or a device's carry-over) sets them; the owner's choice stays.
	const settings = (body: unknown, opts: { cookie: string; origin?: string } = { cookie: session.cookie! }) => call(`/api/vaults/${vault.id}/settings`, body, opts);
	const device = async (path: string, body: Uint8Array) => fetch(`${ORIGIN}/vault/${vault.id}/${path}`, { method: "POST", body: Buffer.concat([vault.token, body]) });
	const shown = async () => (await call("/api/overview", undefined, { cookie: session.cookie! })).body.vaults[0].settings;
	assert.deepEqual(await shown(), { snapshots: null, historyBackup: null });
	assert.equal((await settings({ snapshots: false }, { cookie: "" })).status, 401);
	assert.equal((await settings({ snapshots: false }, { cookie: session.cookie!, origin: "https://evil.example" })).status, 403);
	assert.equal((await settings({ snapshots: "off" })).status, 400);
	assert.equal((await call(`/api/vaults/${"0".repeat(32)}/settings`, { snapshots: false }, { cookie: session.cookie! })).status, 404);
	assert.equal((await settings({ snapshots: false })).status, 200);
	assert.deepEqual(await shown(), { snapshots: false, historyBackup: null });
	const carried = await device("names", Buffer.from(JSON.stringify({ settings: { snapshots: true, historyBackup: false } })));
	assert.deepEqual(((await carried.json()) as { settings: unknown }).settings, { snapshots: false, historyBackup: false });
	assert.equal((await device("snapshot", Buffer.concat([Buffer.alloc(16, 1), Buffer.from([0, 0, 0, 1, 7])]))).status, 403);
	assert.equal((await settings({ historyBackup: true, snapshots: true })).status, 200);
	assert.deepEqual(await shown(), { snapshots: true, historyBackup: true });
	// Delete history backups, or all vault snapshots: the session and this site's own pages only; that vault's go, another's stay.
	const other = await makeVault((await call("/api/vault-code", {}, { cookie: session.cookie! })).body.code.split("#")[1]);
	const tag = Buffer.alloc(16, 3);
	const post = (v: typeof vault, path: string, ...parts: Uint8Array[]) => fetch(`${ORIGIN}/vault/${v.id}/${path}`, { method: "POST", body: Buffer.concat([v.token, ...parts]) });
	const history = async (v: typeof vault) => [...new Uint8Array(await (await post(v, "history/list", tag)).arrayBuffer())];
	const snapshots = async (v: typeof vault) => ((await (await post(v, "snapshot/list")).json()) as unknown[]).length;
	for (const v of [vault, other]) {
		assert.equal((await post(v, "history", tag, Buffer.of(9))).status, 200);
		assert.equal((await post(v, "snapshot", Buffer.alloc(16, 2), Buffer.from([0, 0, 0, 1, 7]))).status, 200);
	}
	for (const kind of ["history", "snapshots"]) {
		const clear = (opts: { cookie: string; origin?: string }) => call(`/api/vaults/${vault.id}/${kind}/clear`, {}, opts);
		assert.equal((await clear({ cookie: "" })).status, 401);
		assert.equal((await clear({ cookie: session.cookie!, origin: "https://evil.example" })).status, 403);
		assert.equal((await call(`/api/vaults/${"0".repeat(32)}/${kind}/clear`, {}, { cookie: session.cookie! })).status, 404);
	}
	assert.deepEqual([await history(vault), await history(other), await snapshots(vault), await snapshots(other)], [[0, 0, 0, 1, 9], [0, 0, 0, 1, 9], 1, 1]);
	assert.deepEqual((await call(`/api/vaults/${vault.id}/history/clear`, {}, { cookie: session.cookie! })).body, { ok: true });
	assert.deepEqual([await history(vault), await history(other), await snapshots(vault)], [[], [0, 0, 0, 1, 9], 1]);
	assert.deepEqual((await call(`/api/vaults/${vault.id}/snapshots/clear`, {}, { cookie: session.cookie! })).body, { ok: true });
	assert.deepEqual([await snapshots(vault), await snapshots(other), await history(other)], [0, 1, [0, 0, 0, 1, 9]]);
	// Its devices are told which ones went, so their ledgers don't show them as missing.
	assert.deepEqual(await Promise.all([vault, other].map(async (v) => (await post(v, "snapshot/list")).headers.get("ownsync-removed"))), ["02".repeat(16), ""]);
	other.ws.close();
	vault.ws.close();
	assert.equal((await call("/api/logout", {}, { cookie: session.cookie! })).status, 200);
	assert.equal((await call("/api/overview", undefined, { cookie: session.cookie! })).status, 401);
	COOKIE = first.cookie!;
	OWNER_KEY = owner;
});

let COOKIE = "", OWNER_KEY: Awaited<ReturnType<typeof authenticator>>;

test("passkeys: another can be added; removing needs a fresh passkey check; the last can't be removed", async () => {
	const cookie = COOKIE, key = OWNER_KEY;
	const second = await authenticator(ORIGIN);
	assert.equal((await call("/api/passkeys/add", { response: second.create((await call("/api/passkeys/add/options", {}, { cookie })).body as { challenge: string }) }, { cookie })).status, 200);
	assert.ok((await call("/api/overview", undefined, { cookie })).body.passkeys.some((p: { id: string }) => p.id === second.id));
	// The session alone doesn't remove a passkey.
	const stale = await second.get((await call("/api/login/options", {})).body as { challenge: string });
	assert.equal((await call("/api/passkeys/remove", { id: second.id, response: stale }, { cookie })).status, 401);
	const ok = await key.get((await call("/api/passkeys/remove/options", {}, { cookie })).body as { challenge: string });
	assert.equal((await call("/api/passkeys/remove", { id: second.id, response: ok }, { cookie })).status, 200);
	assert.equal((await call("/api/passkeys/remove", { id: key.id, response: await key.get((await call("/api/passkeys/remove/options", {}, { cookie })).body as { challenge: string }) }, { cookie })).status, 409);
});

test("wrong setup keys lock out that connection (an IPv6 /64) after 10 in an hour, not others", async () => {
	for (let i = 0; i < 10; i++) await setup(`guess-number-${i}`, { ip: `2001:db8:0:7::${i + 1}` });
	assert.deepEqual((await setup(SETUP_KEY, { ip: "2001:db8:0:7:ffff::1" })).body, { error: "locked" }); // the same /64
	assert.deepEqual((await setup(SETUP_KEY, { ip: "2001:db8:0:8::1" })).body, { error: "used" }); // the next /64 gets the real answer
});

test("a new setup key (the owner redeployed) replaces every passkey and ends every session", async () => {
	const NEW = "a-brand-new-setup-key";
	const old = await OWNER_KEY.get((await call("/api/login/options", {})).body as { challenge: string });
	const oldSession = await call("/api/login/verify", { response: old });
	assert.equal(oldSession.status, 200);
	const { token } = (await setup(NEW, { newKey: NEW })).body;
	assert.ok(token);
	const fresh = await authenticator(ORIGIN);
	const done = await enrolWith(token, fresh);
	assert.equal(done.status, 200);
	assert.equal((await call("/api/overview", undefined, { cookie: oldSession.cookie! })).status, 401);
	assert.equal((await call("/api/login/verify", { response: await OWNER_KEY.get((await call("/api/login/options", {})).body as { challenge: string }) })).status, 401);
	assert.deepEqual((await call("/api/overview", undefined, { cookie: done.cookie! })).body.passkeys.map((p: { id: string }) => p.id), [fresh.id]);
	assert.deepEqual((await setup(NEW, { newKey: NEW })).body, { error: "used" });
});
