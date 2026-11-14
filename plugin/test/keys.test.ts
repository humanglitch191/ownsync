// The membership log, rotation and recovery, headless: devices' keys against an in-memory Worker that keeps
// records strictly in order, first come first served, as server/src/index.ts does.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../../protocol/ownsync";
import { type KeyState, type Stored, VaultKeys, newRecovery, vaultIdOf } from "../src/keys";
import { memoryPorts } from "./sim";

const VAULT = "0123456789abcdef0123456789abcdef";
const vaultId = await vaultIdOf(VAULT);
const DOC = new Uint8Array(16).fill(7);
const te = (s: string) => new TextEncoder().encode(s);

class Log {
	records: Stored[] = [];
	recovery = new Uint8Array(0);
	/** What the Worker does with a device's append or rotate: keep it if its number is the next one. */
	offer(keys: VaultKeys): void {
		const p = keys.state.pending;
		if (!p || p.number !== this.records.length) return;
		this.records.push({ number: p.number, blob: p.blob });
		if (p.recovery.length) this.recovery = p.recovery;
	}
}

type Dev = { keys: VaultKeys; alerts: string[]; problems: string[] };
async function dev(ring: Map<number, Uint8Array>, pin?: KeyState["pin"]): Promise<Dev> {
	const alerts: string[] = [], problems: string[] = [];
	const opts = { onAlert: (m: string) => alerts.push(m), onProblem: (what: string, err: unknown) => problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`) };
	return { keys: await VaultKeys.fresh(VAULT, memoryPorts(), opts, ring, pin), alerts, problems };
}
/** Every device reads the whole log and offers the record it wants added, until nothing changes. */
async function settle(log: Log, devs: Dev[]): Promise<void> {
	for (let round = 0; round < 10; round++) {
		const before = log.records.length;
		for (const d of devs) {
			await d.keys.receive(log.records);
			log.offer(d.keys);
		}
		if (log.records.length === before) return;
	}
	throw new Error("did not settle");
}
/** A new device paired by `by`, from what the pairing code carries. */
function pair(by: Dev): Promise<Dev> {
	const p = P.unpackPairing(by.keys.pairingPayload()!);
	return dev(new Map([[p.epoch, p.vmk]]), { number: p.number, hash: p.hash, pairedBy: p.pairerId });
}
async function vault(n: number, recovery?: Awaited<ReturnType<typeof newRecovery>>) {
	const log = new Log(), a = await dev(new Map([[0, P.randomBytes(32)]]));
	await a.keys.genesis(recovery);
	await settle(log, [a]);
	const devs = [a];
	while (devs.length < n) {
		devs.push(await pair(a));
		await settle(log, devs);
	}
	return { log, devs };
}
const ids = (k: VaultKeys) => k.state.head!.members.map((m) => P.hex(m.id));
const hashOf = async (s: Stored) => P.recordHash(P.unpackStored(s.blob).record);
/** A record written by hand, by whoever holds `vmk`. */
async function forge(vmk: Uint8Array, r: Omit<P.MemberRecord, "vaultId">, wraps: P.Stored["wraps"] = [], sender?: P.Party): Promise<Stored> {
	const record = await P.encodeRecord({ ...r, vaultId }, () => vmk);
	return { number: r.number, blob: P.packStored({ record, wraps, sender }) };
}
const seal = (k: VaultKeys, text: string) => P.sealEnvelope({ vmk: k.vmk, vaultId, docId: DOC, kind: P.KIND.update, epoch: k.epoch, deviceId: k.me.id, plaintext: te(text) });
const opens = async (env: Uint8Array, k: VaultKeys) => new TextDecoder().decode((await P.openEnvelope(env, vaultId, DOC, k.keyFor)).plaintext);

test("a new vault's first record, then each paired device adds itself, and the pairing device expects it", async () => {
	const { log, devs: [a, b] } = await vault(2);
	assert.deepEqual(ids(a!.keys), [P.hex(a!.keys.me.id), P.hex(b!.keys.me.id)]);
	assert.deepEqual(b!.keys.state.head, a!.keys.state.head);
	assert.deepEqual(b!.keys.state.head!.members[1]!.pairedBy, a!.keys.me.id);
	assert.deepEqual([...a!.alerts, ...b!.alerts, ...a!.problems, ...b!.problems], []);
	// A device that joins saying `a` paired it, when `a` showed no code: only `a` can tell that's false.
	const p = P.unpackPairing(b!.keys.pairingPayload()!);
	const c = await dev(new Map([[p.epoch, p.vmk]]), { number: p.number, hash: p.hash, pairedBy: a!.keys.me.id });
	await settle(log, [a!, b!, c]);
	assert.equal(a!.keys.state.head!.members.length, 3);
	assert.match(a!.alerts.join("\n"), /saying this device paired it/);
	assert.deepEqual(b!.alerts, []);
});

test("two devices pairing at the same moment: the Worker takes one record first, the other device adds itself after it", async () => {
	const { log, devs: [a] } = await vault(1);
	const x = await pair(a!), y = await pair(a!);
	await x.keys.receive(log.records);
	await y.keys.receive(log.records);
	assert.equal(x.keys.state.pending!.number, y.keys.state.pending!.number);
	await settle(log, [x, y, a!]);
	for (const d of [a!, x, y]) assert.equal(d.keys.state.head!.members.length, 3);
	assert.deepEqual([a!, x, y].flatMap((d) => [...d.alerts, ...d.problems]), []);
});

test("records that break the rules are refused, and the head stays where it was", async () => {
	const { log, devs: [a, b] } = await vault(2);
	const h = b!.keys.state.head!, vmk = b!.keys.vmk, next = { number: h.number + 1, epoch: 0, prevHash: h.hash, removed: [] as Uint8Array[], recoveryPub: undefined };
	const stranger = { id: P.randomBytes(16), pub: (await P.generateKeyPair()).pub, pairedAt: 1, pairedBy: a!.keys.me.id };
	const bad: [string, Stored][] = [
		["doesn't follow the head", await forge(vmk, { ...next, prevHash: P.randomBytes(32), senderId: stranger.id, members: [...h.members, stranger] })],
		["removes a device within the epoch", await forge(vmk, { ...next, senderId: a!.keys.me.id, members: h.members.slice(0, 1), removed: [b!.keys.me.id] })],
		["adds two devices", await forge(vmk, { ...next, senderId: a!.keys.me.id, members: [...h.members, stranger, { ...stranger, id: P.randomBytes(16) }] })],
		["sender not a member", await forge(vmk, { ...next, senderId: P.randomBytes(16), members: [...h.members, stranger] })],
		["changes a device's key", await forge(vmk, { ...next, senderId: stranger.id, members: [{ ...h.members[0]!, pub: stranger.pub }, h.members[1]!, stranger] })],
		["skips an epoch", await forge(vmk, { ...next, epoch: 1, senderId: stranger.id, members: [...h.members, stranger] })],
		["another vault key", await forge(P.randomBytes(32), { ...next, senderId: stranger.id, members: [...h.members, stranger] })],
		["a rotation with no key for this device", await forge(vmk, { ...next, epoch: 1, senderId: a!.keys.me.id, members: h.members, prevVmkSealed: await P.sealPrevVmk(P.randomBytes(32), vaultId, 1, vmk) })],
	];
	for (const [why, record] of bad) {
		b!.problems.length = 0;
		await b!.keys.receive([...log.records, record]);
		assert.deepEqual(b!.keys.state.head, h, why);
		assert.equal(b!.problems.length, 1, why);
	}
	const tampered = log.records[log.records.length - 1]!.blob.slice();
	tampered[tampered.length - 20]! ^= 1;
	await b!.keys.receive([{ number: h.number, blob: tampered }]);
	assert.deepEqual(b!.keys.state.head, h);

	// A valid record that says `a` wrote it, written by `b`: accepted, since it follows the rules, but `a` says so.
	const claimed = await forge(vmk, { ...next, senderId: a!.keys.me.id, members: [...h.members, stranger] });
	await a!.keys.receive([...log.records, claimed]);
	assert.equal(a!.keys.state.head!.number, h.number + 1);
	assert.match(a!.alerts.join("\n"), /says this device wrote it/);
});

test("removing a device: a new epoch for the others, nothing new for the removed one, older envelopes refused", async () => {
	const { log, devs: [a, b, c] } = await vault(3);
	const fromCBefore = await seal(c!.keys, "before");
	const oldToken = await a!.keys.token(), vmk0 = a!.keys.vmk;
	await a!.keys.remove(c!.keys.me.id);
	await settle(log, [a!, b!, c!]);
	assert.equal(a!.keys.epoch, 1);
	assert.equal(b!.keys.epoch, 1);
	assert.deepEqual(a!.keys.vmk, b!.keys.vmk);
	assert.notDeepEqual(a!.keys.vmk, vmk0);
	assert.notDeepEqual(await b!.keys.token(), oldToken);
	assert.deepEqual(ids(b!.keys), [a!, b!].map((d) => P.hex(d.keys.me.id)));
	assert.ok(a!.keys.state.resnapshot && b!.keys.state.resnapshot, "both send their documents again under the new key");
	assert.equal(c!.keys.epoch, 0);
	assert.match(c!.keys.state.removed ?? "", /removed from the vault/);
	assert.match(c!.alerts.join("\n"), /removed from the vault/);

	const fromA = await seal(a!.keys, "after");
	assert.equal(await opens(fromA, b!.keys), "after");
	await assert.rejects(opens(fromA, c!.keys)); // the removed device can't read what's new
	// Nor can it write: the transport refuses note updates of an older epoch before it opens them (keys of
	// older epochs stay in the ring only for attachments), whenever they were sealed.
	const refused = (env: Uint8Array, keys: VaultKeys) => P.parseHeader(env).epoch < keys.epoch;
	assert.ok(refused(fromCBefore, b!.keys));
	assert.ok(refused(await seal(c!.keys, "sneaked in"), b!.keys));

	// The removed device still holds the old epoch's key, so it can write a valid competitor to the rotation
	// that removed it. That must not stop the others; they hear of it once.
	const rotation = log.records[log.records.length - 1]!;
	const before = log.records[log.records.length - 2]!;
	const competitor = await forge(vmk0, {
		number: rotation.number, epoch: 1, prevHash: await hashOf(before), senderId: c!.keys.me.id, members: b!.keys.state.head!.members, removed: [],
		prevVmkSealed: await P.sealPrevVmk(P.randomBytes(32), vaultId, 1, vmk0),
	});
	await b!.keys.receive([...log.records, competitor]);
	await b!.keys.receive([...log.records, competitor]);
	assert.equal(b!.keys.state.fork, undefined);
	assert.equal(b!.keys.state.head!.number, rotation.number);
	assert.equal(b!.alerts.filter((m) => /competing with one this device already accepted/.test(m)).length, 1);
	await assert.rejects(c!.keys.remove(a!.keys.me.id), /busy/); // a removed device writes nothing
	assert.deepEqual([...a!.problems, ...b!.problems], []);
});

test("removing a lost device: the new recovery key follows in a second rotation, under a key the removed device lacks", async () => {
	const r1 = await newRecovery(vaultId), r2 = await newRecovery(vaultId);
	const { log, devs: [a, b, c] } = await vault(3, r1);
	await a!.keys.remove(c!.keys.me.id, r2);
	await settle(log, [a!, b!, c!]);
	assert.equal(a!.keys.epoch, 2, "a removal, then a recovery-key change");
	assert.deepEqual(b!.keys.state.head!.recoveryPub, r2.pub);
	assert.equal(c!.keys.epoch, 0);
	// The removal record, which the removed device can read, still names the old recovery key; the new one is only
	// in the record after, sealed under epoch 1.
	const [removal, change] = log.records.slice(-2).map((r) => P.peekRecord(P.unpackStored(r.blob).record));
	assert.deepEqual([removal!.epoch, change!.epoch], [1, 2]);
	await assert.rejects(P.decodeRecord(P.unpackStored(log.records[log.records.length - 1]!.blob).record, vaultId, (e) => (e === 0 ? c!.keys.keyFor(0) : undefined)));
	assert.equal(a!.keys.state.nextRecovery, undefined);
	assert.deepEqual([...a!.alerts, ...b!.alerts, ...a!.problems, ...b!.problems], []);
});

test("a record no device should accept, after the head, is reported once and drops a change that can't land", async () => {
	const { log, devs: [a, b] } = await vault(2);
	const h = b!.keys.state.head!;
	const junk: Stored = { number: h.number + 1, blob: P.randomBytes(200) };
	await a!.keys.remove(b!.keys.me.id);
	assert.ok(a!.keys.state.pending);
	await a!.keys.receive([...log.records, junk]);
	await a!.keys.receive([...log.records, junk]);
	assert.equal(a!.keys.state.pending, undefined, "the removal is dropped, not shown as done");
	assert.equal(a!.alerts.filter((m) => /can't accept/.test(m)).length, 1);
	assert.equal(a!.keys.pairingPayload() === null, false);
});

test("an existing device's entry can't be rewritten, and no pairing code is handed out while a key change waits", async () => {
	const { log, devs: [a, b] } = await vault(2);
	const h = a!.keys.state.head!, vmk = a!.keys.vmk;
	const relabel = await forge(vmk, { number: h.number + 1, epoch: 0, prevHash: h.hash, removed: [], recoveryPub: undefined, senderId: b!.keys.me.id, members: [h.members[0]!, { ...h.members[1]!, pairedBy: P.randomBytes(16) }] });
	a!.problems.length = 0;
	await a!.keys.receive([...log.records, relabel]);
	assert.deepEqual(a!.keys.state.head, h);
	assert.match(a!.problems.join("\n"), /existing device's entry/);
	await a!.keys.remove(b!.keys.me.id);
	assert.equal(a!.keys.pairingPayload(), null);
});

test("recovery: a new device opens the newest key with the code alone, removes the rest and replaces the code", async () => {
	const r1 = await newRecovery(vaultId);
	const { log, devs: [a, b] } = await vault(2, r1);
	await a!.keys.remove(b!.keys.me.id); // epoch 1, wrapped to the recovery key too
	await settle(log, [a!, b!]);
	const n = await dev(new Map()), r2 = await newRecovery(vaultId);
	await assert.rejects(n.keys.recover(r2.code, log.recovery, log.records, r2), /doesn't open/);
	await n.keys.recover(r1.code, log.recovery, log.records, r2);
	assert.equal(n.keys.epoch, 1);
	assert.deepEqual(n.keys.vmk, a!.keys.vmk);
	log.offer(n.keys); // its rotation, sent once it has caught up
	await settle(log, [n, a!]);
	assert.equal(n.keys.epoch, 2);
	assert.deepEqual(ids(n.keys), [P.hex(n.keys.me.id)]);
	assert.deepEqual(n.keys.state.head!.members[0]!.pairedBy, P.RECOVERY_ID);
	assert.match(a!.keys.state.removed ?? "", /removed .* by the recovery key/);
	assert.deepEqual([...n.alerts, ...n.problems], []);
	// The old code is used up; the new one recovers the newest epoch.
	const m = await dev(new Map());
	await assert.rejects(m.keys.recover(r1.code, log.recovery, log.records, await newRecovery(vaultId)), /doesn't open/);
	await m.keys.recover(r2.code, log.recovery, log.records, await newRecovery(vaultId));
	assert.deepEqual(m.keys.vmk, n.keys.vmk);
});

test("a vault recovered before any rotation: the first record's key is wrapped to the recovery key", async () => {
	const r1 = await newRecovery(vaultId);
	const { log, devs: [a] } = await vault(1, r1);
	const n = await dev(new Map());
	await n.keys.recover(r1.code, log.recovery, log.records, await newRecovery(vaultId));
	assert.deepEqual(n.keys.vmk, a!.keys.vmk);
});

test("two valid records at the head freeze the device until the user picks one; one behind the head only alerts", async () => {
	const { log, devs: [a, b] } = await vault(2);
	// Two devices pair at once, and the Worker (wrongly) serves both of their records.
	const x = await pair(a!), y = await pair(a!);
	await x.keys.receive(log.records);
	await y.keys.receive(log.records);
	const both = [x, y].map((d) => ({ number: d.keys.state.pending!.number, blob: d.keys.state.pending!.blob }));
	await b!.keys.receive([...log.records, ...both]);
	assert.equal(b!.keys.state.fork?.length, 2);
	assert.match(b!.alerts.join("\n"), /same moment/);
	const head = b!.keys.state.head;
	await b!.keys.receive([...log.records, ...both]);
	assert.equal(b!.keys.state.head, head, "frozen: nothing more is accepted");
	await b!.keys.choose(b!.keys.state.fork![0]!);
	assert.equal(b!.keys.state.fork, undefined);
	assert.deepEqual(b!.keys.state.head!.members[2]!.id, x.keys.me.id);
	await b!.keys.receive([...log.records, ...both]);
	await b!.keys.receive([...log.records, ...both]);
	assert.equal(b!.keys.state.fork, undefined);
	assert.equal(b!.alerts.filter((m) => /competing with one this device already accepted/.test(m)).length, 1);
});
