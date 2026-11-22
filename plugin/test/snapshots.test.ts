import assert from "node:assert/strict";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
	KIND, MAX_VAULT_SNAPSHOT_ENVELOPE, VAULT_SNAPSHOT_PART_BYTES, authToken, concat, gunzipVaultSnapshot,
	gzipVaultSnapshot, hex, openEnvelope, packVaultSnapshotPart, randomBytes, sealEnvelope, sha256,
	unhex, unpackVaultSnapshotPart,
} from "../../protocol/ownsync";
import type { SnapshotLedgerEntry } from "../src/core/ports";
import { createSnapshots, type SnapshotDeps } from "../src/snapshots";

const day = 20_000;
const takenAt = day * 86_400_000 + 1234;
const id = "12".repeat(16);
const note = { id: "note-1", path: "Notes/One.md", text: "café\n😺\0" };
const header = { id, day, takenAt, partIndex: 0, partCount: 1 };
const encoder = new TextEncoder();

function reply(value: unknown, status = 200) {
	return { status, arrayBuffer: encoder.encode(JSON.stringify(value)).buffer as ArrayBuffer };
}

function frame(index: number, envelope: Uint8Array): Uint8Array {
	const header = new Uint8Array(6), view = new DataView(header.buffer);
	view.setUint16(0, index);
	view.setUint32(2, envelope.length);
	return concat(header, envelope);
}

function fixture(mobile = false) {
	const vaultId = randomBytes(16);
	const keys = { vmk: randomBytes(32), epoch: 4, me: { id: randomBytes(16) }, state: {} };
	const ring = new Map([[3, randomBytes(32)], [keys.epoch, keys.vmk]]);
	const ledger = new Map<string, SnapshotLedgerEntry>();
	const storage = new Map<string, string>();
	const calls: string[] = [];
	const uploaded = new Map<number, Uint8Array>();
	const uploadIndices: number[] = [];
	let rows: unknown[] = [];
	let download: Uint8Array | undefined;
	let returnedDay = day;
	let dropUploadAck: number | undefined;
	let frozen = false;
	let listStatus = 200;
	const deps: SnapshotDeps = {
		host: "https://example.test/", vaultId, keys, mobile,
		token: () => authToken(keys.vmk, vaultId),
		vmkFor: (epoch) => ring.get(epoch),
		ready: () => !frozen,
		snapshotLedger: async () => new Map(ledger),
		recordSnapshot: async (id, entry) => { ledger.set(id, entry); },
		forgetSnapshots: async (ids) => { for (const id of ids ?? ledger.keys()) ledger.delete(id); },
		normalizePath: (path) => path.normalize("NFC").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
		configDir: "Settings",
		deviceDayStore: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } },
		now: () => takenAt,
		listNotes: () => [note],
		async requestUrl({ url, method, body, contentType }) {
			assert.equal(method, "POST");
			assert.equal(contentType, "application/octet-stream");
			const prefix = `https://example.test/vault/${hex(vaultId)}/snapshot`;
			assert.ok(url.startsWith(prefix));
			const suffix = url.slice(prefix.length);
			calls.push(suffix);
			const bytes = new Uint8Array(body);
			assert.deepEqual(bytes.subarray(0, 32), await deps.token());
			if (suffix === "/list") {
				assert.equal(bytes.length, 32);
				return reply(rows, listStatus);
			}
			if (suffix === "/delete") {
				assert.ok(bytes.length === 32 || bytes.length === 48);
				rows = [];
				return reply({ ok: true });
			}
			if (suffix === "/get") {
				assert.equal(bytes.length, 48);
				const frames = download ?? concat(...[...uploaded].reverse().map(([index, envelope]) => frame(index, envelope)));
				return { status: 200, arrayBuffer: frames.buffer as ArrayBuffer };
			}
			assert.equal(suffix, "");
			const view = new DataView(body);
			const index = view.getUint16(48), parts = view.getUint16(50);
			uploadIndices.push(index);
			if (index !== 0 && !uploaded.size) return reply({ error: "restart" }, 409);
			const envelope = bytes.subarray(52);
			const snapshotId = hex(bytes.subarray(32, 48));
			assert.ok(envelope.length <= MAX_VAULT_SNAPSHOT_ENVELOPE);
			const opened = await openEnvelope(envelope, vaultId, bytes.subarray(32, 48), deps.vmkFor);
			assert.equal(opened.epoch, keys.epoch);
			assert.equal(opened.kind, KIND.vaultSnapshot);
			const part = unpackVaultSnapshotPart(opened.plaintext);
			assert.deepEqual([part.id, part.partIndex, part.partCount], [snapshotId, index, parts]);
			if (uploaded.has(index)) assert.deepEqual(envelope, uploaded.get(index));
			uploaded.set(index, envelope);
			const complete = uploaded.size === parts;
			rows = [{ id: snapshotId, day: returnedDay, epoch: opened.epoch, parts, received: uploaded.size,
				size: [...uploaded.values()].reduce((sum, part) => sum + part.length, 0), complete, at: returnedDay * 86_400_000 }];
			if (dropUploadAck === index) {
				dropUploadAck = undefined;
				throw new Error("response lost");
			}
			return reply({ ok: true, day: returnedDay, complete });
		},
	};
	const snapshots = createSnapshots(deps);
	return {
		snapshots, deps, vaultId, keys, ring, ledger, calls, uploaded, uploadIndices,
		setRows: (value: unknown[]) => { rows = value; },
		setDownload: (bytes: Uint8Array) => { download = bytes; },
		skew: () => { returnedDay++; },
		dropNextUploadAck: (index = 0) => { dropUploadAck = index; },
		expireUpload: () => { uploaded.clear(); rows = []; },
		freeze: () => { frozen = true; },
		setListStatus: (status: number) => { listStatus = status; },
	};
}

async function sealed(f: ReturnType<typeof fixture>, bytes: Uint8Array, meta = header, epoch = 3) {
	return sealEnvelope({
		kind: KIND.vaultSnapshot, vmk: f.ring.get(epoch)!, vaultId: f.vaultId, docId: unhex(id),
		epoch, deviceId: f.keys.me.id, plaintext: packVaultSnapshotPart(meta, bytes),
	});
}

async function record(f: ReturnType<typeof fixture>, envelopes: Uint8Array[], notesOnly = true) {
	f.ledger.set(id, { day, epoch: 3, parts: await Promise.all(envelopes.map(async (bytes) => hex(await sha256(bytes)))), notesOnly, takenAt });
}

test("binary framing uses canonical buckets and preserves trailing zero bytes", () => {
	for (const [length, bucket] of [[5, 65_536], [65_537, 131_072], [524_289, 1_048_576]]) {
		const input = new Uint8Array(length!);
		input.set([0, 255, 17, 0, 0]);
		const packed = packVaultSnapshotPart(header, input);
		assert.equal(packed.length, 36 + bucket!);
		assert.deepEqual(unpackVaultSnapshotPart(packed), { ...header, bytes: input });
	}
	const last = { ...header, partIndex: 1, partCount: 2 };
	const bytes = Uint8Array.of(8, 0, 0);
	const packed = packVaultSnapshotPart(last, bytes);
	assert.equal(packed.length, 36 + VAULT_SNAPSHOT_PART_BYTES);
	assert.deepEqual(unpackVaultSnapshotPart(packed), { ...last, bytes });
	packed[packed.length - 1] = 1;
	assert.throws(() => unpackVaultSnapshotPart(packed), /padding/);
	assert.throws(() => packVaultSnapshotPart({ ...last, partIndex: 0 }, bytes), /header/);
});

test("multipart upload records sealed hashes, opens out of order and removes both copies", async () => {
	const f = fixture();
	const largeNote = { ...note, text: nodeRandomBytes(1_100_000).toString("base64") };
	const attachment = { id: "image", path: "Attachments/image.png", ref: { h: "aa".repeat(32), n: 1, c: ["bb".repeat(32)] } };
	f.deps.listNotes = async () => [largeNote];
	f.deps.listAttachments = () => [attachment];
	assert.deepEqual(await Promise.all([f.snapshots.takeIfDue(), f.snapshots.takeIfDue()]), ["taken", "not due"]);
	assert.deepEqual(f.calls, ["/list", "", ""]);
	assert.deepEqual([...f.uploaded.values()].map((value) => value.length),
		[MAX_VAULT_SNAPSHOT_ENVELOPE, MAX_VAULT_SNAPSHOT_ENVELOPE]);
	const [info] = await f.snapshots.list();
	assert.ok(info?.verified && info.complete && info.notesOnly === false);
	assert.deepEqual(f.ledger.get(info.id)?.parts,
		await Promise.all([...f.uploaded.values()].map(async (value) => hex(await sha256(value)))));
	assert.deepEqual(await f.snapshots.open(info.id), {
		id: info.id, day, takenAt, notesOnly: false, notes: [largeNote], attachments: [{ id: attachment.id, path: attachment.path }],
	});
	await f.snapshots.remove(info.id);
	assert.equal(f.ledger.size, 0);
	assert.equal(await f.snapshots.takeIfDue(), "not due");
	assert.equal(await createSnapshots(f.deps).takeIfDue(), "not due");
	assert.deepEqual(await f.snapshots.list(), []);
});

test("a lost acknowledgement retries the same ciphertext before recording the ledger", async () => {
	const f = fixture();
	f.dropNextUploadAck();
	assert.equal(await f.snapshots.takeIfDue(), "unavailable");
	assert.equal(f.ledger.size, 0);
	assert.equal(await f.snapshots.takeIfDue(), "taken");
	assert.equal(f.ledger.size, 1);
	assert.deepEqual(f.calls, ["/list", "", ""]);
});

test("an expired multipart upload starts again from zero and records the new ciphertext", async () => {
	const f = fixture();
	f.deps.listNotes = () => [{ ...note, text: nodeRandomBytes(2_150_000).toString("base64") }];
	f.dropNextUploadAck(1);
	assert.equal(await f.snapshots.takeIfDue(), "unavailable");
	assert.equal(f.ledger.size, 0);
	const originalPart = f.uploaded.get(0);
	assert.ok(originalPart);
	f.expireUpload();
	f.deps.listNotes = () => assert.fail("restart should reuse the captured snapshot");
	assert.equal(await f.snapshots.takeIfDue(), "taken");
	assert.deepEqual(f.uploadIndices, [0, 1, 1, 0, 1, 2]);
	assert.notDeepEqual(f.uploaded.get(0), originalPart);
	const [info] = await f.snapshots.list();
	assert.ok(info?.verified);
	assert.deepEqual(f.ledger.get(info.id)?.parts,
		await Promise.all([...f.uploaded.values()].map(async (bytes) => hex(await sha256(bytes)))));
});

test("mobile snapshots enforce 96 MiB before serializing or opening a vault", async () => {
	const f = fixture(true);
	f.deps.listNotes = function* () {
		yield { ...note, text: "\n".repeat(48 * 1024 * 1024 + 1) };
		assert.fail("preflight should stop reading notes when their JSON exceeds the limit");
	};
	assert.equal(await f.snapshots.takeIfDue(), "too large");
	assert.deepEqual(f.calls, ["/list"]);

	const envelope = await sealed(f, gzipSync(Buffer.alloc(96 * 1024 * 1024 + 1, 32)));
	await record(f, [envelope]);
	f.setDownload(frame(0, envelope));
	await assert.rejects(f.snapshots.open(id), /decompression limit/);
});

test("upload needs a ready connection, skips a complete Worker day and rejects a mismatched acknowledgement day", async () => {
	const row = { id, day, epoch: 4, parts: 1, received: 1, size: 65_623, complete: true, at: takenAt };
	const f = fixture();
	f.setRows([row]);
	assert.equal(await f.snapshots.takeIfDue(), "taken elsewhere");
	assert.deepEqual(f.calls, ["/list"]);
	f.freeze();
	assert.equal(await f.snapshots.takeIfDue(), "unavailable");
	assert.deepEqual(f.calls, ["/list"]);
	const g = fixture();
	g.skew();
	assert.equal(await g.snapshots.takeIfDue(), "taken elsewhere");
	assert.equal(g.ledger.size, 0);
	assert.deepEqual(g.calls, ["/list", ""]);
});

test("list distinguishes a missing Worker copy from an unavailable Worker", async () => {
	const f = fixture();
	await record(f, [Uint8Array.of(1)]);
	const [missing] = await f.snapshots.list();
	assert.deepEqual(missing, { id, day, epoch: 3, size: 0, complete: false, verified: true, takenAt, notesOnly: true, missingOnServer: true });
	f.setListStatus(404);
	const [offline] = await f.snapshots.list();
	assert.equal(offline?.id, id);
	assert.equal(offline?.missingOnServer, undefined);
	assert.equal(await f.snapshots.takeIfDue(), "unavailable");
	assert.deepEqual(f.calls, ["/list", "/list"]);
});

test("older parts need both an exact ledger hash and an epoch key", async () => {
	const f = fixture();
	const content = { id, day, takenAt, notesOnly: true, notes: [note], attachments: [] };
	const envelope = await sealed(f, await gzipVaultSnapshot(encoder.encode(JSON.stringify({ v: 1, ...content }))));
	f.setDownload(frame(0, envelope));
	await assert.rejects(f.snapshots.open(id), /ledger entry/);
	assert.deepEqual(f.calls, []);
	await record(f, [envelope]);
	assert.deepEqual(await f.snapshots.open(id), content);
	const modified = envelope.slice();
	modified[modified.length - 1]! ^= 1;
	f.setDownload(frame(0, modified));
	await assert.rejects(f.snapshots.open(id), /hash mismatch/);
	f.ring.delete(3);
	await assert.rejects(f.snapshots.open(id), /key is unavailable/);
});

test("opening refuses missing, duplicate and inconsistent parts even with ledger hashes", async () => {
	const f = fixture();
	const compressed = gzipSync(nodeRandomBytes(VAULT_SNAPSHOT_PART_BYTES).toString("base64"));
	const first = await sealed(f, compressed.subarray(0, VAULT_SNAPSHOT_PART_BYTES), { ...header, partCount: 2 });
	const tail = { ...header, partIndex: 1, partCount: 2 };
	const second = await sealed(f, Uint8Array.of(1), tail);
	await record(f, [first, second]);
	f.setDownload(frame(0, first));
	await assert.rejects(f.snapshots.open(id), /parts are missing/);
	f.setDownload(concat(frame(0, first), frame(0, first)));
	await assert.rejects(f.snapshots.open(id), /duplicate/);

	for (const metadata of [{ id: "23".repeat(16) }, { partCount: 3 }, { partIndex: 0 }, { day: day + 1 }, { takenAt: takenAt + 1 }]) {
		const meta = { ...tail, ...metadata };
		const bytes = meta.partIndex < meta.partCount - 1 ? new Uint8Array(VAULT_SNAPSHOT_PART_BYTES) : Uint8Array.of(1);
		const wrong = await sealed(f, bytes, meta);
		await record(f, [first, wrong]);
		f.setDownload(concat(frame(0, first), frame(1, wrong)));
		await assert.rejects(f.snapshots.open(id), /metadata mismatch/);
	}
});

test("gzip decoding enforces a byte limit and rejects malformed gzip and UTF-8", async () => {
	const input = "😺".repeat(1024);
	const compressed = await gzipVaultSnapshot(encoder.encode(input));
	assert.equal(await gunzipVaultSnapshot([compressed], 4096), input);
	await assert.rejects(gunzipVaultSnapshot([compressed], 4095), /decompression limit/);
	await assert.rejects(gunzipVaultSnapshot([compressed.subarray(0, -2)]));
	await assert.rejects(gunzipVaultSnapshot([await gzipVaultSnapshot(Uint8Array.of(0xff))]));
});

test("verified snapshots reject unsafe note and attachment paths", async () => {
	const f = fixture();
	const cases = [
		{ path: "../bad.md", note: true },
		{ path: "/bad.md", note: true },
		{ path: "Docs/.hidden/bad.md", note: true },
		{ path: "Docs//bad.md", note: true },
		{ path: "Doc\u0000s/bad.md", note: true },
		{ path: "Docs/bad.png", note: true },
		{ path: "C:/bad.png", note: false },
		{ path: "Docs\\bad.png", note: false },
		{ path: "Settings/bad.png", note: false },
		{ path: "Docs/bad.md", note: false },
	];
	for (const { path, note: isNote } of cases) {
		const body = {
			v: 1, id, day, takenAt, notesOnly: isNote,
			notes: isNote ? [{ ...note, path }] : [],
			attachments: isNote ? [] : [{ id: "attachment", path, ref: { h: "00".repeat(32), n: 0, c: [] } }],
		};
		const envelope = await sealed(f, await gzipVaultSnapshot(encoder.encode(JSON.stringify(body))));
		await record(f, [envelope], isNote);
		f.setDownload(frame(0, envelope));
		await assert.rejects(f.snapshots.open(id), /unsafe path/, path);
	}
});
