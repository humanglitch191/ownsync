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

function fixture() {
	const vaultId = randomBytes(16);
	const keys = { vmk: randomBytes(32), epoch: 3, me: { id: randomBytes(16) }, state: {} };
	const deps: HistoryBackupDeps = {
		host: "https://example.test/", vaultId, keys,
		token: () => authToken(keys.vmk, vaultId),
		docTag: (id) => docTag(keys.vmk, vaultId, id),
		noteIdForPath: (value) => value === path ? note : undefined,
		requestUrl: async () => ({ status: 200, arrayBuffer: new ArrayBuffer(0) }),
	};
	return { keys, deps, vaultId };
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
	const { deps, keys, vaultId } = fixture();
	const calls: Parameters<HistoryBackupDeps["requestUrl"]>[0][] = [];
	deps.requestUrl = async (request) => {
		calls.push(request);
		return { status: 200, arrayBuffer: new ArrayBuffer(0) };
	};
	const backup = createHistoryBackup(deps);
	assert.equal(backup.supported(), undefined);
	assert.equal(backup.noteIdForPath(path), note);
	assert.deepEqual(await Promise.all([backup.upload(note, "text", 123), backup.forget(note), backup.forgetAll()]), [undefined, true, true]);
	await backup.upload(note, "x".repeat(1024 * 1024), 123);
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
	const { deps, keys } = fixture();
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
	await createHistoryBackup(deps).upload(note, "text", 123);
	assert.equal(requests, 0);
});
