// Checks protocol/ownsync.ts against the fixed test vectors in vectors.json, plus the attacks each rule stops.
// UPDATE_VECTORS=1 node --test rewrites the outputs (and creates the inputs on the first run).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as v from "./ownsync.ts";

const FILE = new URL("./vectors.json", import.meta.url);
const UPDATE = process.env.UPDATE_VECTORS === "1";

type Hex = Record<string, string>;
const fill = (start: number, n: number) => v.hex(Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff));

async function freshInputs(): Promise<Hex> {
	const kp = async (name: string) => {
		const { d, pub } = await v.generateKeyPair();
		return { [`${name}D`]: v.hex(d), [`${name}Pub`]: v.hex(pub) };
	};
	return {
		vaultId: fill(0x00, 16), docId: fill(0x10, 16),
		deviceA: fill(0xa0, 16), deviceB: fill(0xb0, 16), deviceC: fill(0xc0, 16),
		vmk0: fill(0x20, 32), vmk1: fill(0x40, 32), nonce: fill(0x60, 12), rk: fill(0x70, 16), pairK: fill(0x80, 16),
		plaintext: v.hex(new TextEncoder().encode("hello ownsync")),
		...(await kp("a")), ...(await kp("b")), ...(await kp("c")), ...(await kp("eph")), ...(await kp("recovery")),
	};
}

const stored = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : undefined;
if (!stored && !UPDATE) throw new Error("vectors.json missing; run with UPDATE_VECTORS=1");
// New input fields get fresh values; UPDATE_VECTORS=1 then pins them in vectors.json.
const inputs: Hex = { ...(await freshInputs()), ...stored?.inputs };
const I = Object.fromEntries(Object.entries(inputs).map(([k, x]) => [k, v.unhex(x)]));

const party = async (id: Uint8Array, d: Uint8Array, pub: Uint8Array) => ({ id, pub, priv: await v.importPrivate(d, pub) });
const A = await party(I.deviceA, I.aD, I.aPub);
const B = await party(I.deviceB, I.bD, I.bPub);
const C = await party(I.deviceC, I.cD, I.cPub);
const R = await party(v.RECOVERY_ID, I.recoveryD, I.recoveryPub);
const eph = { d: I.ephD, pub: I.ephPub };
const at = 1_763_000_000_000;

const genesis: v.MemberRecord = {
	vaultId: I.vaultId, number: 0, epoch: 0, prevHash: new Uint8Array(32), senderId: A.id,
	members: [A, B, C].map((m) => ({ id: m.id, pub: m.pub, pairedAt: at, pairedBy: A.id })),
	removed: [], recoveryPub: R.pub,
};
const keys = (e: number) => ({ 0: I.vmk0, 1: I.vmk1 })[e];
const genesisBytes = await v.encodeRecord(genesis, keys, I.nonce);
// A removes C: epoch 1, sealed under the old epoch's member key.
const rotation: v.MemberRecord = {
	...genesis, number: 1, epoch: 1, prevHash: await v.recordHash(genesisBytes),
	members: genesis.members.slice(0, 2), removed: [C.id],
	prevVmkSealed: await v.sealPrevVmk(I.vmk1, I.vaultId, 1, I.vmk0),
};
const rotationBytes = await v.encodeRecord(rotation, keys, I.nonce);
const rotationHash = await v.recordHash(rotationBytes);
const wrapArgs = { vmk: I.vmk1, vaultId: I.vaultId, epoch: 1, recordHash: rotationHash, ephemeral: eph };

const outputs: Hex = {
	sealKeyA: v.hex(await v.sealKey(I.vmk0, I.vaultId, A.id)),
	nameKey: v.hex(await v.nameKey(I.vmk0, I.vaultId)),
	authToken: v.hex(await v.authToken(I.vmk0, I.vaultId)),
	authTokenHash: v.hex(await v.sha256(await v.authToken(I.vmk0, I.vaultId))),
	memberKey: v.hex(await v.memberKey(I.vmk0, I.vaultId)),
	envelope: v.hex(await v.sealEnvelope({ vmk: I.vmk0, vaultId: I.vaultId, docId: I.docId, kind: v.KIND.update, epoch: 0, deviceId: A.id, plaintext: I.plaintext, nonce: I.nonce })),
	chunkName: v.hex(await v.chunkName(I.vmk0, I.vaultId, I.plaintext)),
	docTagIndex: v.hex(await v.docTag(I.vmk0, I.vaultId, "index")),
	docTagNote: v.hex(await v.docTag(I.vmk0, I.vaultId, "3f9a1c0e5b7d2a46")),
	packedEntry: v.hex(v.packEntry("3f9a1c0e5b7d2a46", I.plaintext)),
	genesisRecord: v.hex(genesisBytes),
	rotationRecord: v.hex(rotationBytes),
	rotationHash: v.hex(rotationHash),
	wrapAtoB: v.hex(await v.wrapVmk({ ...wrapArgs, sender: A, recipient: B })),
	wrapAtoRecovery: v.hex(await v.wrapVmk({ ...wrapArgs, sender: A, recipient: R })),
	pairingRoom: v.hex(v.unhex(await v.pairingRoom(I.pairK))),
	pairingSealed: v.hex(await v.sealForPairing(I.pairK, I.vmk0)),
	recoveryCode: v.encodeRecoveryCode(I.rk),
	recoveryPrivSealed: v.hex(await v.sealRecoveryPrivate(I.rk, I.vaultId, { d: I.recoveryD, pub: I.recoveryPub })),
	storedRotation: v.hex(v.packStored({
		record: rotationBytes, sender: { id: A.id, pub: A.pub },
		wraps: [{ recipientId: B.id, wrapped: await v.wrapVmk({ ...wrapArgs, sender: A, recipient: B }) }, { recipientId: v.RECOVERY_ID, wrapped: await v.wrapVmk({ ...wrapArgs, sender: A, recipient: R }) }],
	})),
	pairingPayload: v.hex(v.packPairing({ vmk: I.vmk1, epoch: 1, number: 1, hash: rotationHash, pairerId: A.id })),
};
const O = Object.fromEntries(Object.entries(outputs).map(([k, x]) => [k, k === "recoveryCode" ? x : v.unhex(x)])) as Record<string, Uint8Array>;

if (UPDATE) writeFileSync(FILE, JSON.stringify({ inputs, outputs }, null, "\t") + "\n");

test("outputs match the committed vectors", () => {
	assert.deepEqual(outputs, UPDATE ? outputs : stored.outputs);
});

test("envelope opens, and only in its own vault, document and header", async () => {
	const opened = await v.openEnvelope(O.envelope, I.vaultId, I.docId, keys);
	assert.deepEqual(opened.plaintext, I.plaintext);
	assert.equal(opened.epoch, 0);
	await assert.rejects(v.openEnvelope(O.envelope, I.vaultId, I.vaultId, keys)); // moved to another doc
	const relabeled = O.envelope.slice();
	relabeled[2] = v.KIND.snapshot; // replayed as another kind
	await assert.rejects(v.openEnvelope(relabeled, I.vaultId, I.docId, keys));
	const otherVersion = O.envelope.slice();
	otherVersion[0] = 2;
	assert.throws(() => v.parseHeader(otherVersion), /unknown version/);
});

test("rotation wrap opens for the recipient and the recovery key pair", async () => {
	const args = { vaultId: I.vaultId, epoch: 1, recordHash: rotationHash, sender: A };
	assert.deepEqual(await v.unwrapVmk({ ...args, wrapped: O.wrapAtoB, recipient: B }), I.vmk1);
	assert.deepEqual(await v.unwrapVmk({ ...args, wrapped: O.wrapAtoRecovery, recipient: R }), I.vmk1);
});

test("a wrap from a non-member claiming to be a member is rejected (why plain ECIES isn't enough)", async () => {
	const forged = await v.wrapVmk({ ...wrapArgs, vmk: v.randomBytes(32), sender: { ...A, priv: C.priv }, recipient: B });
	await assert.rejects(v.unwrapVmk({ wrapped: forged, vaultId: I.vaultId, epoch: 1, recordHash: rotationHash, sender: A, recipient: B }));
});

test("a wrap can't be replayed into another epoch or record", async () => {
	const args = { wrapped: O.wrapAtoB, vaultId: I.vaultId, sender: A, recipient: B };
	await assert.rejects(v.unwrapVmk({ ...args, epoch: 2, recordHash: rotationHash }));
	await assert.rejects(v.unwrapVmk({ ...args, epoch: 1, recordHash: await v.recordHash(genesisBytes) }));
});

test("membership records round-trip, and reject tampering, the wrong key and the wrong vault", async () => {
	assert.deepEqual(await v.decodeRecord(O.genesisRecord, I.vaultId, keys), genesis);
	const decoded = await v.decodeRecord(O.rotationRecord, I.vaultId, keys);
	assert.deepEqual(decoded, rotation);
	assert.deepEqual(await v.openPrevVmk(I.vmk1, I.vaultId, 1, decoded.prevVmkSealed!), I.vmk0);
	const tampered = O.rotationRecord.slice();
	tampered[5] ^= 1; // epoch in the clear header
	await assert.rejects(v.decodeRecord(tampered, I.vaultId, keys));
	await assert.rejects(v.decodeRecord(O.rotationRecord, I.vaultId, () => I.vmk1));
	await assert.rejects(v.decodeRecord(O.rotationRecord, I.docId, keys));
	await assert.rejects(v.decodeRecord(v.concat(O.rotationRecord, new Uint8Array(1)), I.vaultId, keys));
});

test("a device holding only the new VMK reads the rotation record through the key ring", async () => {
	const header = await v.decodeRecord(O.rotationRecord, I.vaultId, () => undefined).catch((e: Error) => e.message);
	assert.match(String(header), /no key for epoch 0/);
	const sealed = O.rotationRecord.slice(11, 11 + 48); // clear prevVmkSealed
	const vmk0 = await v.openPrevVmk(I.vmk1, I.vaultId, 1, sealed);
	assert.deepEqual(await v.decodeRecord(O.rotationRecord, I.vaultId, (e) => ({ 0: vmk0, 1: I.vmk1 })[e]), rotation);
});

test("the server can't read the member list from stored records", () => {
	const hexRecords = v.hex(O.genesisRecord) + v.hex(O.rotationRecord);
	for (const secret of [A.id, B.id, C.id, A.pub, B.pub, C.pub, R.pub]) assert.ok(!hexRecords.includes(v.hex(secret)));
});

test("recovery code round-trips, ignores formatting, and only the right code opens the private key", async () => {
	const code = outputs.recoveryCode;
	assert.equal(code.length, 26);
	assert.deepEqual(v.decodeRecoveryCode(code), I.rk);
	assert.deepEqual(v.decodeRecoveryCode(code.toLowerCase().replace(/(.{4})/g, "$1-")), I.rk);
	assert.throws(() => v.decodeRecoveryCode(code.slice(1)));
	assert.throws(() => v.decodeRecoveryCode(code.slice(0, 25) + "B")); // nonzero padding bits
	const kp = await v.openRecoveryPrivate(I.rk, I.vaultId, O.recoveryPrivSealed);
	assert.deepEqual(kp, { d: I.recoveryD, pub: I.recoveryPub });
	const wrong = I.rk.slice();
	wrong[0] ^= 1;
	await assert.rejects(v.openRecoveryPrivate(wrong, I.vaultId, O.recoveryPrivSealed));
});

test("stored records and the pairing payload round-trip, and reject trailing bytes", () => {
	const stored = v.unpackStored(O.storedRotation);
	assert.deepEqual(stored.record, O.rotationRecord);
	assert.deepEqual(stored.sender, { id: A.id, pub: A.pub });
	assert.deepEqual(stored.wraps.map((w) => [w.recipientId, w.wrapped]), [[B.id, O.wrapAtoB], [v.RECOVERY_ID, O.wrapAtoRecovery]]);
	assert.deepEqual(v.unpackStored(v.packStored({ record: O.genesisRecord, wraps: [] })), { record: O.genesisRecord, wraps: [], sender: undefined });
	assert.throws(() => v.unpackStored(v.concat(O.storedRotation, new Uint8Array(1))), /trailing/);
	assert.deepEqual(v.unpackPairing(O.pairingPayload), { vmk: I.vmk1, epoch: 1, number: 1, hash: rotationHash, pairerId: A.id });
	assert.throws(() => v.unpackPairing(O.pairingPayload.slice(0, 32)));
});

test("pairing: only the one-time code opens the sealed VMK", async () => {
	assert.deepEqual(await v.openFromPairing(I.pairK, O.pairingSealed), I.vmk0);
	const wrong = I.pairK.slice();
	wrong[0] ^= 1;
	await assert.rejects(v.openFromPairing(wrong, O.pairingSealed));
	assert.notEqual(await v.pairingRoom(I.pairK), v.hex(I.pairK));
});

test("update parts split at PART_SIZE and reassemble", () => {
	const update = Uint8Array.from({ length: v.PART_SIZE * 2 + 5 }, (_, i) => i & 0xff);
	const parts = v.splitUpdate(update).map(v.parsePart);
	assert.deepEqual(parts.map((p) => [p.index, p.count, p.bytes.length]), [[0, 3, v.PART_SIZE], [1, 3, v.PART_SIZE], [2, 3, 5]]);
	assert.equal(new Set(parts.map((p) => p.groupId)).size, 1);
	assert.deepEqual(v.concat(...parts.map((p) => p.bytes)), update);
	assert.throws(() => v.parsePart(v.concat(new Uint8Array(16), Uint8Array.of(0, 3, 0, 3))), /bad part index/);
});

test("document tags are stable per document, differ between documents, and entries unpack", async () => {
	assert.equal(O.docTagIndex.length, 16);
	assert.notDeepEqual(O.docTagIndex, O.docTagNote);
	assert.notDeepEqual(await v.docTag(I.vmk1, I.vaultId, "index"), O.docTagIndex); // another epoch's key, another tag
	assert.deepEqual(v.unpackEntry(O.packedEntry), { docId: "3f9a1c0e5b7d2a46", update: I.plaintext });
});

test("setup proof: the setup key bound to the Worker's origin, as the Worker checks it", async () => {
	const { createHash } = await import("node:crypto");
	const expected = createHash("sha256").update("ownsync-setup\nhttps://ownsync.me.workers.dev\ncorrect horse battery").digest("hex");
	assert.equal(await v.setupProof("https://ownsync.me.workers.dev", "correct horse battery"), expected);
	assert.notEqual(await v.setupProof("https://look-alike.example", "correct horse battery"), expected);
});
