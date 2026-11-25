// FUZZ_SEED replays exactly one history. FUZZ_FIRST, FUZZ_RUNS, FUZZ_STEPS also drive the
// nightly note fuzz. Each device has a durable database and a disk; a crash discards its
// planner and the messages in flight. All choices, including IDs, are local to the seed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeClient } from "../../server/src/wire";
import { restore, type Answer } from "../src/core/table/device";
import { LegacyProjection } from "../src/core/table/migration";
import { Device, Server, quiesce, rng } from "./sim";
import { client, WorkerModel, Files, Memory, chunkName, hash, tag, nameKey } from "./table-sim";

type Peer = Awaited<ReturnType<typeof client>> & {
	online: boolean;
	packetInFlight?: Uint8Array;
	answerInFlight?: Answer;
};
const paths = ["p.bin","q.bin","pics/a.png","pics/b.png"];
const operations = ["write", "write", "edit", "rename", "delete", "restore", "toggle connection", "restart",
	"catch up", "advance packet", "apply disk intent", "clean up", "settle online peers", "send", "plan", "idle"];
const day = 86_400_000;
const value = (b: Uint8Array) => Buffer.from(b).toString("hex");
const original = (p: string) => p.replace(/(?: \(conflict [a-f0-9]{6}\))+(?=(?:\.[^./]*)?$)/,"");
const diskView = (files: Files) => [...files.files].map(([p,f]) => [p,value(f.bytes)] as const).sort(([a],[b]) => a.localeCompare(b));

function verify(w: WorkerModel, devices: Files[], required: Set<string>) {
	const expected = new Map<string,string>(), reachable = new Set<string>();
	for (const row of w.rows.values()) {
		const data = w.content(row.bytes);
		if (row.deleted === null) {
			assert.ok(data, "live row missing chunks at " + row.path);
			assert.ok(!expected.has(row.path), "multiple live rows at " + row.path);
			expected.set(row.path,value(data));
		}
		if (data && (row.deleted === null || row.deleted >= w.time - 30*day)) reachable.add(value(data));
	}
	for (const bytes of required) assert.ok(reachable.has(bytes), "user bytes lost: " + bytes);
	for (const [device, disk] of devices.entries()) {
		const files = diskView(disk), seen = new Set<string>();
		assert.deepEqual(new Map(files), expected, `device ${device} differs from the live table`);
		for (const [path,bytes] of files) {
			const key = JSON.stringify([original(path),bytes]);
			assert.ok(!seen.has(key), "identical conflict copies at " + original(path));
			seen.add(key);
		}
	}
}

const coverage = { migrated:0, offlineWrites:0, lostSuccess:0, replay:0, diskCrashes:0,
	restoreAttempts:0, restores:0, cleanedChunks:0, identicalRaces:0 };

async function run(seed: number, steps: number) {
	const random = rng(seed), pick = <T>(items: T[]) => items[Math.floor(random()*items.length)]!;
	const w = new WorkerModel(), required = new Set<string>(), log: string[] = [];
	// Keep accepted deletions independently of the live-file oracle: staged bytes and orphan
	// chunks cannot satisfy a promise to offer the deleted version for restore.
	const deletionKey = (file: string, seq: number) => file + "/" + seq;
	const tombstones = new Map<string, { file: string; seq: number; bytes: string; at: number; cleaned: boolean }>();
	const rememberDeletion = (file: string, seq: number, bytes: string, at: number) =>
		tombstones.set(deletionKey(file,seq), { file, seq, bytes, at, cleaned: false });
	let serial = 0;
	const submit = (packet: Uint8Array) => {
		const frame = decodeClient(packet), seq = w.seq;
		const answer = w.request(packet);
		if (w.seq !== seq && "file" in frame) {
			const row = w.rows.get(value(frame.file))!;
			const data = w.content(row.bytes);
			assert.ok(data, "accepted a version without its bytes");
			const bytes = value(data);
			if (frame.t === "restore") {
				assert.equal(bytes, tombstones.get(deletionKey(row.file,frame.base))?.bytes, "restore changed the deleted bytes");
				coverage.restores++;
			}
			if ("base" in frame && frame.base !== null) tombstones.delete(deletionKey(row.file,frame.base));
			if (row.deleted !== null) rememberDeletion(row.file,row.seq,bytes,row.deleted);
			log.push(`accepted ${frame.t} #${w.seq} ${row.file} ${row.path} ${bytes}`);
		}
		return answer;
	};
	const newBytes = () => Buffer.from([0xff,...Buffer.from(`<${seed}.${++serial}>`),0]);
	const recordWrite = (before: Uint8Array | undefined, after: Uint8Array) => {
		// Only the actual bytes under the user's cursor can have been intentionally replaced.
		if (before) { log.push("replaced " + value(before)); required.delete(value(before)); }
		required.add(value(after));
	};
	const newPeer = async (disk?: Files, store?: Memory): Promise<Peer> => {
		const peer = Object.assign(await client(w, disk, store, submit), { online: true });
		const fetch = peer.i.fetch;
		peer.i.fetch = ref => {
			if (!peer.online) throw new Error("offline");
			return fetch(ref);
		};
		return peer;
	};
	const peers: Peer[] = [];
	const write = async (d: Peer, path: string, b = newBytes()) => {
		log.push(`d${peers.indexOf(d)} writes ${value(b)} at ${path}`);
		if (!d.online) coverage.offlineWrites++;
		recordWrite(d.disk.files.get(path)?.bytes,b);
		d.disk.put(path,b); await d.plan({kind:"changed",path});
	};
	const drop = (p: Peer) => { delete p.packetInFlight; delete p.answerInFlight; };
	const restart = async (p: Peer) => {
		drop(p); await p.reopen(); await p.plan({kind:"startup"});
	};
	const drain = async () => {
		for (const p of peers) {
			if (!p.online) continue;
			if (p.answerInFlight) await p.ack(p.answerInFlight);
			else if (p.packetInFlight) await p.ack(p.submit(p.packetInFlight));
			drop(p);
		}
		for (let pass = 0; pass < 100; pass++) {
			const seq = w.seq;
			for (const p of peers) if (p.online) await p.settle();
			if (seq === w.seq) return;
		}
		assert.fail("peers did not reach quiescence");
	};
	const check = async () => {
		await drain();
		verify(w,peers.map(d => d.disk),required);
		for (const tomb of tombstones.values()) {
			const row = w.rows.get(tomb.file);
			assert.equal(row?.seq, tomb.seq, "lost deleted row");
			assert.equal(row.deleted, tomb.at);
			const data = w.content(row.bytes);
			if (!tomb.cleaned || data) assert.equal(data?.toString("hex"), tomb.bytes, "lost recoverable deleted bytes");
		}
		for (const p of peers) await p.dev.change(s => {
			assert.equal(s.cursor,w.seq);
			assert.deepEqual(s.latest,w.rows);
			assert.equal(s.pending.size,0); assert.equal(s.intent,undefined);
		});
	};
	try {
		if (seed % 4 === 0) {
			// Use the real 0.2.x engine and its stored Yjs stream. An offline save belongs
			// exclusively to the returning device, so it must survive outside genesis.
			const legacy = new Server(), old = [0,1,2].map(n => new Device("legacy"+n,legacy,random));
			for (const d of old) {
				d.overrides = { chunkName:async (b,scope) => scope ? chunkName(scope.u,scope.i,b) : hash(b),
					reports:() => true,scoped:() => seed % 8 === 0,versionTag:async u => tag(u),now:() => w.time };
				d.boot(); d.connect();
			}
			await quiesce(old);
			for (let n = 0; n < 3 + Math.floor(random()*4); n++) {
				const d = pick(old), path = pick(paths), b = newBytes();
				recordWrite(d.files.get(path)?.content as Uint8Array | undefined,b);
				d.write(path,b); await quiesce(old);
			}
			const path = pick([...old[0]!.files.keys()]);
			old[0]!.disconnect();
			for (const d of old.slice(0,2)) {
				const b = newBytes(); recordWrite(d.files.get(path)!.content as Uint8Array,b);
				d.write(path,b);
			}
			await quiesce(old);
			const projection = new LegacyProjection();
			try {
				for (const r of legacy.rows) projection.applyIndex(r.entry);
				for (const r of legacy.rows) projection.applyAttachment(r.entry);
				for (const [c,b] of legacy.chunks) w.put(c,b,legacy.versionChunks.get(c));
				for await (const row of projection.rows(nameKey)) {
					const deleted = row.dateAtCommit ? w.time : row.deleted;
					w.genesis({ ...row, deleted });
					const bytes = w.content(row.bytes);
					if (deleted !== null && bytes) rememberDeletion(row.file,row.seq,value(bytes),deleted);
				}
			} finally { projection.close(); }
			for (const d of old) {
				await d.engine!.useTable(nameKey);
				const disk = new Files(), store = new Memory();
				for (const [p,f] of d.files) disk.put(p,f.content as Uint8Array);
				store.values = structuredClone(d.data); d.crash();
				assert.deepEqual(d.problems,[]);
				const peer = await newPeer(disk,store); peers.push(peer);
				await peer.pull(); await peer.plan({kind:"startup"});
			}
			coverage.migrated++;
		} else for (let i=0; i<3; i++) peers.push(await newPeer());

		await check();
		// Three peers race from the same baseline. Two write identical losing bytes.
		const path = "race.bin", [winner, first, second] = peers as [Peer,Peer,Peer];
		await write(winner,path); await check();
		const identical = newBytes();
		await write(winner,path); await write(first,path,identical); await write(second,path,identical);
		const packet = await winner.packet(), accepted = winner.submit(packet);
		assert.ok("ok" in accepted);
		coverage.lostSuccess++; await restart(winner);
		const retry = await winner.packet(); assert.deepEqual(retry,packet);
		assert.deepEqual(winner.submit(retry),accepted); coverage.replay++; await winner.ack(accepted);
		await check(); coverage.identicalRaces++;
		assert.equal([...winner.disk.files.values()].filter(f => value(f.bytes) === value(identical)).length,1);

		for (let step = 0; step < steps; step++) {
			w.time += 60_000;
			const d = pick(peers), files = [...d.disk.files.keys()], from = pick(files), path = pick(paths);
			const op = Math.floor(random()*operations.length);
			log.push(`${step}: d${peers.indexOf(d)} ${operations[op]} ${from ?? ""} -> ${path} seq=${w.seq}`);
			if (op <= 2) await write(d,op === 2 && from ? from : path);
			else if (op === 3 && from && !d.disk.files.has(path)) {
				assert.ok(await d.disk.moveIf(from,path,d.disk.hash(from)!));
				await d.plan({kind:"renamed",from,to:path});
			} else if (op === 4 && from) {
				const bytes = d.disk.files.get(from)!.bytes;
				log.push("deleted on disk " + value(bytes));
				// A user can delete an offline save before publication. If deletion reaches
				// the Worker the tombstone oracle also checks its exact recoverable bytes.
				required.delete(value(bytes));
				d.disk.files.delete(from); await d.plan({kind:"deleted",path:from});
			} else if (op === 5 && d.online) {
				const tombstone = await d.dev.change(s => pick([...s.latest.values()].filter(r => r.deleted !== null)));
				if (tombstone) { await d.dev.change(s => restore(s,tombstone,d.i)); coverage.restoreAttempts++; }
			} else if (op === 6) {
				d.online = !d.online; drop(d);
			} else if (op === 7) {
				if (await d.dev.change(s => !!s.intent) && random() < .5) {
					d.disk.crash = "effect";
					try { await d.effect(); } catch (e) { assert.match(String(e),/killed/); coverage.diskCrashes++; }
					d.disk.crash = undefined;
				}
				await restart(d);
			} else if (op === 8 && d.online) await d.pull();
			else if (op === 9 && d.online) {
				if (d.answerInFlight) { await d.ack(d.answerInFlight); drop(d); }
				else if (d.packetInFlight) {
					d.answerInFlight = d.submit(d.packetInFlight);
					if (random() < .3) { if ("ok" in d.answerInFlight) coverage.lostSuccess++; drop(d); }
				} else if ((await d.pending()).length) d.packetInFlight = await d.packet(pick(await d.pending()));
			} else if (op === 10 && d.online) { await d.plan(); await d.effect(); }
			else if (op === 11) {
				const cutoff = Date.UTC(2025,1,1);
				if (w.time >= cutoff) {
					// Release only tombstones explicitly covered by this cleanup range.
					// An unseen user edit remains required even when an erroneous del is cleaned.
					coverage.cleanedChunks += w.clean(0,cutoff);
					for (const tomb of tombstones.values()) {
						const row = w.rows.get(tomb.file)!;
						// Staging can replenish cleaned chunks. A successful restore must still return the original bytes.
						if (row.bytes.s && tomb.at < cutoff && !w.content(row.bytes)) tomb.cleaned = true;
					}
					for (const row of w.live()) assert.ok(w.content(row.bytes));
				}
			} else if (op === 12) await drain();
			else if (op === 13 && d.online && !d.packetInFlight) {
				await d.pull(); await d.plan();
				if ((await d.pending()).length) await d.deliver();
			} else if (op === 14) await d.plan();
		}
		for (const p of peers) p.online = true;
		await check();

		// Start from a user's confirmed save, without consulting which requests the planner
		// chose to send. Every peer must offer that deletion, and a different peer can restore it.
		const saved = newBytes(), savedPath = "restore-probe.bin";
		await write(first, savedPath, saved); await check();
		const savedFile = w.live().find(row => row.path === savedPath)!.file;
		first.disk.files.delete(savedPath);
		await first.plan({ kind: "deleted", path: savedPath });
		await check(); // keep these bytes required across the deletion
		for (const p of peers) {
			assert.ok(!p.disk.files.has(savedPath));
			const row = await p.dev.change(s => s.latest.get(savedFile));
			assert.ok(row?.deleted != null && row.deleted >= w.time - 30 * day);
			assert.equal(value(w.content(row.bytes)!), value(saved));
		}
		await second.dev.change(s => restore(s, s.latest.get(savedFile)!, second.i));
		coverage.restoreAttempts++;
		await check();
		for (const p of peers) assert.equal(value(p.disk.files.get(savedPath)!.bytes), value(saved));
	} catch (err) {
		throw new Error(`table fuzz seed ${seed}\n${(process.env.FUZZ_LOG ? log : log.slice(-35)).join("\n")}\n${err instanceof Error ? err.stack : err}`);
	}
}

test("the oracle rejects orphan-only bytes, a divergent disk and byte-identical sibling conflicts", async () => {
	const w = new WorkerModel(), d = await client(w);
	d.disk.edit("a.bin", "content"); await d.settle();
	const row = w.live()[0]!, bytes = w.content(row.bytes)!;
	const required = new Set([value(bytes)]);
	assert.throws(() => verify(w, [new Files()], required), /differs from the live table/);
	for (const [i, suffix] of ["aaaaaa", "bbbbbb"].entries()) {
		const path = `a (conflict ${suffix}).bin`;
		w.rows.set(suffix, { ...row, file: suffix, path, seq: i + 2 });
		d.disk.put(path, bytes);
	}
	w.rows.delete(row.file); d.disk.files.delete(row.path);
	assert.throws(() => verify(w, [d.disk], required), /identical conflict copies/);
	w.rows.clear(); d.disk.files.clear();
	assert.ok(w.content(row.bytes), "negative control needs intact orphan chunks");
	assert.throws(() => verify(w, [d.disk], required), /user bytes lost/);
});

const seed = process.env.FUZZ_SEED;
const regressions = [2728545, 2747157, 2781512, 2808104, 2833507, 2845892, 2860885, 3145936];
test("table fuzz: regression seeds", { skip: !!seed || !!process.env.FUZZ_FIRST }, async () => {
	for (const n of regressions) await run(n,250);
});
const count = seed === undefined ? Number(process.env.FUZZ_RUNS ?? 20) : 1;
const first = Number(seed ?? process.env.FUZZ_FIRST ?? 1), steps = Number(process.env.FUZZ_STEPS ?? 250);
test(`table fuzz: seeds ${first}–${first+count-1}, ${steps} steps`, async t => {
	try { for (let n=first; n<first+count; n++) await run(n,steps); }
	finally { t.diagnostic(JSON.stringify(coverage)); }
});
