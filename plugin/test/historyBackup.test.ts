import { test } from "node:test";
import assert from "node:assert/strict";
import { KIND, authToken, concat, docTag, hex, openEnvelope, packHistory, randomBytes, sealEnvelope, unpackHistory } from "../../protocol/ownsync";
import { createHistoryBackup, type HistoryBackupDeps } from "../src/historyBackup";

const note = "note-1";
const path = "Notes/One.md";
const encoder = new TextEncoder();

function frame(envelope: Uint8Array): Uint8Array {
	const length = new Uint8Array(4);
	new DataView(length.buffer).setUint32(0, envelope.length);
	return concat(length, envelope);
}

function fakeTiming(random = () => 0) {
	let now = 0;
	const timers = new Map<() => void, number>();
	const timing: NonNullable<HistoryBackupDeps["timing"]> = {
		now: () => now,
		random,
		setTimer: (callback, delay) => {
			timers.set(callback, now + delay);
			return () => { timers.delete(callback); };
		},
	};
	return {
		timing,
		next: () => Math.min(...timers.values()),
		advance(ms: number) {
			now += ms;
			for (const [callback, due] of [...timers]) {
				if (due > now) continue;
				timers.delete(callback);
				callback();
			}
		},
	};
}

function fixture(random?: () => number) {
	const clock = fakeTiming(random);
	const vaultId = randomBytes(16);
	const keys = { vmk: randomBytes(32), epoch: 3, me: { id: randomBytes(16) }, state: {} };
	const deps: HistoryBackupDeps = {
		host: "https://example.test/", vaultId, keys, timing: clock.timing,
		token: () => authToken(keys.vmk, vaultId),
		docTag: (id) => docTag(keys.vmk, vaultId, id),
		noteIdForPath: (value) => value === path ? note : undefined,
		requestUrl: async () => ({ status: 200, arrayBuffer: new ArrayBuffer(0) }),
	};
	return { keys, deps, vaultId, clock };
}

test("history uses the smallest UTF-8 bucket and round-trips markdown, Unicode and NUL", () => {
	const t = 123;
	const overhead = encoder.encode(JSON.stringify({ v: 1, note, t, text: "" })).length;
	for (const [size, bucket] of [[1024, 1024], [1025, 2048], [2048, 2048], [2049, 4096], [1024 * 1024, 1024 * 1024]] as const) {
		const text = "x".repeat(size - overhead);
		const padded = packHistory(note, t, text)!;
		assert.equal(padded.length, bucket);
		assert.ok(padded.subarray(size).every((byte) => byte === 0));
		assert.deepEqual(unpackHistory(padded, note), { takenAt: t, text });
	}
	const text = "é".repeat(600) + "\n# title\u0000";
	const padded = packHistory(note, t, text)!;
	assert.equal(padded.length, 2048);
	assert.deepEqual(unpackHistory(padded, note), { takenAt: t, text });
	assert.equal(packHistory(note, t, "x".repeat(1024 * 1024 + 1 - overhead)), undefined);
	assert.equal(unpackHistory(padded.subarray(0, 2000), note), undefined);
});

test("history validates the plaintext's version, note, timestamp and UTF-8", () => {
	const now = 10_000;
	const future = now + 5 * 60_000;
	assert.deepEqual(unpackHistory(packHistory(note, future, "")!, note, now), { takenAt: future, text: "" });
	assert.equal(unpackHistory(packHistory(note, future + 1, "")!, note, now), undefined);
	assert.equal(unpackHistory(packHistory(note, now, "")!, "another-note", now), undefined);
	for (const t of [-1, 0.5, NaN, Infinity]) assert.equal(unpackHistory(packHistory(note, t, "")!, note, now), undefined);
	const badVersion = new Uint8Array(1024);
	badVersion.set(encoder.encode(JSON.stringify({ v: 2, note, t: now, text: "" })));
	assert.equal(unpackHistory(badVersion, note, now), undefined);
	const badEncoding = packHistory(note, now, "x")!;
	badEncoding[badEncoding.lastIndexOf("x".charCodeAt(0))] = 0xff;
	assert.equal(unpackHistory(badEncoding, note, now), undefined);
});

test("lists check real envelopes against kind, current epoch, vault, tag and plaintext", async () => {
	const { deps, keys, vaultId } = fixture();
	const tag = await deps.docTag(note);
	const now = Date.now();
	const make = (text: string, t: number, options: Partial<Parameters<typeof sealEnvelope>[0]> = {}) => sealEnvelope({
		kind: KIND.history, epoch: keys.epoch, vmk: keys.vmk, deviceId: keys.me.id, vaultId, docId: tag,
		plaintext: packHistory(note, t, text)!, ...options,
	});
	const items = await Promise.all([
		make("older", now - 1),
		make("wrong kind", now, { kind: KIND.update }),
		make("old epoch", now, { epoch: keys.epoch - 1 }),
		make("future epoch", now, { epoch: keys.epoch + 1 }),
		make("wrong vault", now, { vaultId: randomBytes(16) }),
		make("wrong tag", now, { docId: await deps.docTag("another-note") }),
		make("wrong note ID", now, { plaintext: packHistory("another-note", now, "wrong note ID")! }),
		make("future time", now + 6 * 60_000),
		make("newer Z", now),
		make("newer A", now),
	]);
	const body = concat(...items.map(frame));
	deps.requestUrl = async () => ({ status: 200, arrayBuffer: body.buffer as ArrayBuffer });
	const backup = createHistoryBackup(deps);
	assert.deepEqual(await backup.list(note), [
		{ takenAt: now, text: "newer A", reportedDevice: hex(keys.me.id) },
		{ takenAt: now, text: "newer Z", reportedDevice: hex(keys.me.id) },
		{ takenAt: now - 1, text: "older", reportedDevice: hex(keys.me.id) },
	]);
	assert.equal(backup.supported(), true);
});

test("list framing skips corrupt frames and keeps complete copies before a truncated frame", async () => {
	const { deps, keys, vaultId } = fixture();
	const valid = await sealEnvelope({
		kind: KIND.history, epoch: keys.epoch, vmk: keys.vmk, deviceId: keys.me.id, vaultId,
		docId: await deps.docTag(note), plaintext: packHistory(note, 1, "text")!,
	});
	const badTag = valid.slice();
	badTag[badTag.length - 1] = badTag[badTag.length - 1]! ^ 1;
	const complete = frame(valid);
	const body = concat(frame(Uint8Array.of(1, 1, KIND.history)), frame(badTag), frame(new Uint8Array(0)), complete, complete.subarray(0, 16));
	deps.requestUrl = async () => ({ status: 200, arrayBuffer: body.buffer as ArrayBuffer });
	const backup = createHistoryBackup(deps);
	assert.deepEqual(await backup.list(note), [{ takenAt: 1, text: "text", reportedDevice: hex(keys.me.id) }]);
	const beyondLimit = concat(new Uint8Array(4 * 200), complete);
	deps.requestUrl = async () => ({ status: 200, arrayBuffer: beyondLimit.buffer as ArrayBuffer });
	assert.deepEqual(await backup.list(note), []);
});

test("the upload and clear calls use the binary Worker contract and preserve mutation order", async () => {
	const { deps, keys, vaultId, clock } = fixture();
	const calls: Parameters<HistoryBackupDeps["requestUrl"]>[0][] = [];
	deps.requestUrl = async (request) => {
		calls.push(request);
		return { status: 200, arrayBuffer: new ArrayBuffer(0) };
	};
	const backup = createHistoryBackup(deps);
	assert.equal(backup.supported(), undefined);
	assert.equal(backup.noteIdForPath(path), note);
	const operations = Promise.all([backup.upload(note, "text", 123), backup.forget(note), backup.forgetAll()]);
	clock.advance(30_000);
	assert.deepEqual(await operations, [undefined, true, true]);
	const oversized = backup.upload(note, "x".repeat(1024 * 1024), 123);
	clock.advance(30_000);
	await oversized;
	await backup.list(note);
	const base = `https://example.test/vault/${hex(vaultId)}/history`;
	assert.deepEqual(calls.map((call) => call.url), [base, base + "/clear", base + "/clear", base + "/list"]);
	assert.ok(calls.every((call) => call.method === "POST" && call.contentType === "application/octet-stream" && !call.throw));
	const [upload, clearOne, clearAll, list] = calls.map((call) => new Uint8Array(call.body));
	const token = await deps.token();
	const tag = await deps.docTag(note);
	assert.deepEqual(upload!.subarray(0, 48), concat(token, tag));
	assert.deepEqual(clearOne, concat(token, tag));
	assert.deepEqual(clearAll, token);
	assert.deepEqual(list, concat(token, tag));
	const opened = await openEnvelope(upload!.subarray(48), vaultId, tag, (e) => e === keys.epoch ? keys.vmk : undefined);
	assert.equal(opened.kind, KIND.history);
	assert.deepEqual(unpackHistory(opened.plaintext, note), { takenAt: 123, text: "text" });
	deps.docTag = async () => new Uint8Array(0);
	assert.equal(await backup.forget(note), false);
	assert.equal(await backup.forget(backup.noteIdForPath("Missing.md")!), false);
	assert.equal(calls.length, 4);
});

test("404, 401 and 410 disable the session while a transient error allows another request", async () => {
	for (const status of [404, 401, 410]) {
		const { deps } = fixture();
		let requests = 0;
		deps.requestUrl = async () => {
			requests++;
			return { status, arrayBuffer: new ArrayBuffer(0) };
		};
		const backup = createHistoryBackup(deps);
		assert.deepEqual(await backup.list(note), []);
		assert.equal(backup.supported(), false);
		await backup.upload(note, "text", 1);
		assert.equal(await backup.forget(note), false);
		assert.equal(await backup.forgetAll(), false);
		assert.equal(requests, 1);
	}
	const { deps } = fixture();
	deps.requestUrl = async () => { throw new Error("offline"); };
	const backup = createHistoryBackup(deps);
	assert.deepEqual(await backup.list(note), []);
	assert.equal(backup.supported(), undefined);
	deps.requestUrl = async () => ({ status: 200, arrayBuffer: new ArrayBuffer(0) });
	assert.equal(await backup.forgetAll(), true);
	assert.equal(backup.supported(), true);
});

test("a rotation during tag derivation prevents uploading under a stale epoch", async () => {
	const { deps, keys, clock } = fixture();
	const currentTag = deps.docTag;
	deps.docTag = async (id) => {
		const tag = await currentTag(id);
		keys.epoch++;
		keys.vmk = randomBytes(32);
		return tag;
	};
	let requests = 0;
	deps.requestUrl = async () => {
		requests++;
		return { status: 200, arrayBuffer: new ArrayBuffer(0) };
	};
	const uploaded = createHistoryBackup(deps).upload(note, "text", 123);
	clock.advance(30_000);
	await uploaded;
	assert.equal(requests, 0);
});

test("one timer starts all due uploads and leaves later uploads queued", async () => {
	const random = [0, 0.5, 1 - 2 ** -32];
	const { deps, clock } = fixture(() => random.shift()!);
	let requests = 0;
	deps.requestUrl = async () => {
		requests++;
		return { status: 200, arrayBuffer: new ArrayBuffer(0) };
	};
	const backup = createHistoryBackup(deps);
	const earliest = backup.upload(note, "early", 1);
	const middle = backup.upload(note, "middle", 2);
	const latest = backup.upload(note, "late", 3);
	assert.equal(clock.next(), 30_000);
	clock.advance(29_999);
	assert.equal(requests, 0);
	clock.advance(135_001);
	await Promise.all([earliest, middle]);
	assert.equal(requests, 2);
	assert.equal(clock.next(), 300_000);
	clock.advance(135_000);
	await latest;
	assert.equal(requests, 3);
	assert.equal(clock.next(), Infinity);
});

test("Forget preserves the pending upload's delay and runs before newer copies of the same note", async () => {
	const random = [0.5, 0];
	const { deps, clock, keys, vaultId } = fixture(() => random.shift()!);
	const calls: string[] = [];
	deps.requestUrl = async ({ url, body }) => {
		if (url.endsWith("/clear")) calls.push("clear");
		else {
			const tag = await deps.docTag(note);
			const opened = await openEnvelope(new Uint8Array(body).subarray(48), vaultId, tag, () => keys.vmk);
			calls.push(unpackHistory(opened.plaintext, note)!.text);
		}
		return { status: 200, arrayBuffer: new ArrayBuffer(0) };
	};
	const backup = createHistoryBackup(deps);
	const before = backup.upload(note, "before", 1);
	const forget = backup.forget(note);
	const after = backup.upload(note, "after", 2);
	assert.equal(clock.next(), 165_000);
	clock.advance(165_000);
	assert.deepEqual(await Promise.all([before, forget, after]), [undefined, true, undefined]);
	assert.deepEqual(calls, ["before", "clear", "after"]);
});

test("session stop drops delayed uploads, finishes pending clears and leaves no timer", async () => {
	const { deps, clock } = fixture();
	const calls: string[] = [];
	deps.requestUrl = async ({ url }) => {
		calls.push(url.endsWith("/clear") ? "clear" : "upload");
		return { status: 200, arrayBuffer: new ArrayBuffer(0) };
	};
	const backup = createHistoryBackup(deps);
	const uploaded = backup.upload(note, "text", 1);
	const forgotten = backup.forget(note);
	await backup.idle();
	assert.deepEqual(await Promise.all([uploaded, forgotten]), [undefined, true]);
	assert.deepEqual(calls, ["clear"]);
	assert.equal(clock.next(), Infinity);
});

test("switching backups off cancels queued uploads, stops lists and still permits a vault-wide clear", async () => {
	const { deps, clock } = fixture();
	let enabled = true;
	deps.enabled = () => enabled;
	const calls: string[] = [];
	deps.requestUrl = async ({ url }) => {
		calls.push(url);
		return { status: 200, arrayBuffer: new ArrayBuffer(0) };
	};
	const backup = createHistoryBackup(deps);
	const pending = backup.upload(note, "old", 1);
	const listing = backup.list(note);
	enabled = false;
	backup.discardUploads();
	await pending;
	assert.deepEqual(await listing, []);
	assert.deepEqual(await backup.list(note), []);
	await backup.upload(note, "disabled", 2);
	assert.equal(clock.next(), Infinity);
	assert.equal(await backup.forgetAll(), true);
	enabled = true;
	clock.advance(300_000);
	assert.equal(calls.length, 1);
	assert.ok(calls[0]?.endsWith("/clear"));
});
