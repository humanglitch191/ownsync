import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeClient, MAX_MARK } from "../../server/src/wire";
import { hex, unhex } from "../../protocol/ownsync";
import type { Ref, Store } from "../src/core/ports";
import { TableDevice, catchUp, conflictSuffix, packRequest, type Answer, type Row, type RecordData } from "../src/core/table/device";
import { planDisk, executeIntent, type DiskInputs, type Event, type DiskPort } from "../src/core/table/disk";

export const enc = new TextEncoder(), dec = new TextDecoder();
export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const nameKey = new Uint8Array(32).fill(8);

export class Memory implements Store {
	values = new Map<string, unknown>();
	fail = false;
	async get<T>(k: string) { return structuredClone(this.values.get(k)) as T | undefined; }
	async list<T>(prefix: string) { return structuredClone([...this.values].filter(([k]) => k.startsWith(prefix))) as [string,T][]; }
	async commit(puts: Map<string, unknown>, deletes: Iterable<string>) {
		if (this.fail) throw new Error("crash at commit");
		for (const [k,v] of puts) this.values.set(k, structuredClone(v));
		for (const k of deletes) this.values.delete(k);
	}
}

export class Files implements DiskPort {
	files = new Map<string, { bytes: Uint8Array; mtime: number }>();
	clock = 0;
	reads = 0;
	temp?: Uint8Array;
	crash?: "temp" | "effect";
	put(path: string, bytes: Uint8Array) { this.files.set(path, { bytes: bytes.slice(), mtime: ++this.clock }); }
	edit(path: string, value: string) { this.put(path, enc.encode(value)); }
	text(path: string) { const f = this.files.get(path); return f && dec.decode(f.bytes); }
	hash(path: string) { const f = this.files.get(path); return f ? hash(f.bytes) : null; }
	async stat(path: string) { const f = this.files.get(path); return f && { path, mtime: f.mtime, size: f.bytes.length }; }
	async list() { return Promise.all([...this.files.keys()].map(async p => (await this.stat(p))!)); }
	async readBinary(path: string) { this.reads++; return this.files.get(path)!.bytes.slice(); }
	fault(at: typeof this.crash) { if (this.crash === at) { this.crash = undefined; throw new Error("killed"); } }
	async discardTemp() { this.temp = undefined; }
	async writeTemp(bytes: Uint8Array) { this.temp = bytes.slice(); this.fault("temp"); }
	async installTemp(path: string, expected: string | null) {
		if (this.hash(path) !== expected) return false;
		this.put(path, this.temp!); this.temp = undefined; this.fault("effect"); return true;
	}
	async moveIf(from: string, to: string, expected: string) {
		if (this.hash(from) !== expected || this.files.has(to)) return false;
		this.files.set(to, this.files.get(from)!); this.files.delete(from); this.fault("effect"); return true;
	}
	async removeIf(path: string, expected: string) {
		if (this.hash(path) !== expected) return false;
		this.files.delete(path); this.fault("effect"); return true;
	}
}

// The records are clear in this fixture so the oracle can inspect them. CAS and path
// uniqueness compare the opaque fields from the packet, just as the SQL Worker does.
export const tag = (u: string) => hash(enc.encode(u));
const pathkey = (p: string) => hash(enc.encode(p));
const partSize = 4;
export const chunkName = (u: string, n: number, b: Uint8Array) => createHash("sha256").update(u + "/" + n + "/").update(b).digest("hex");

export class WorkerModel {
	seq = 0;
	time = Date.UTC(2025, 0, 31, 23);
	rows = new Map<string, Row>();
	answers = new Map<string, number>();
	chunks = new Map<string, Uint8Array>();
	private serial = 0;
	id = () => (++this.serial).toString(16).padStart(32, "0");
	private keys = new Map<string, { path: string; version: string }>();
	private owners = new Map<string, string>();
	private uploaded = new Map<string, number>();
	private declarations = new Map<string, number | null>();
	private retired = new Map<string, number>();
	live() { return [...this.rows.values()].filter(r => r.deleted === null); }
	put(name: string, bytes: Uint8Array, version?: string) {
		const owner = this.owners.get(name);
		if (version && owner !== version) {
			assert.ok(!owner && !this.chunks.has(name), "chunk already belongs to a different version");
			const count = [...this.owners.values()].filter(v => v === version).length;
			assert.ok(count < (this.declarations.get(version) ?? MAX_MARK));
			this.owners.set(name, version);
		}
		if (!this.chunks.has(name)) { this.chunks.set(name, bytes.slice()); this.uploaded.set(name, this.time); }
	}
	// The oracle follows only the ordered chunk names from a reachable row.
	content(r: Ref) {
		if (!r.c.every(c => this.chunks.has(c))) return undefined;
		const bytes = Buffer.concat(r.c.map(c => this.chunks.get(c)!));
		assert.equal(bytes.length, r.n);
		assert.equal(hash(bytes), r.h);
		return bytes;
	}
	genesis(row: Row) {
		assert.equal(row.seq, ++this.seq);
		const version = tag(row.bytes.u);
		if (row.deleted === null) assert.ok(this.content(row.bytes));
		this.rows.set(row.file, row);
		this.keys.set(row.file, { path: pathkey(row.path), version });
		this.declarations.set(version, row.bytes.s ? row.bytes.c.length : null);
		if (row.deleted !== null && !this.live().some(r => tag(r.bytes.u) === version)) this.retired.set(version, row.deleted);
		else this.retired.delete(version);
	}
	clean(from: number, to: number) {
		const current = new Set(this.live().map(row => this.keys.get(row.file)!.version));
		let removed = 0;
		for (const [name, version] of this.owners) {
			const at = this.retired.get(version) ?? this.uploaded.get(name)!;
			if (!current.has(version) && this.declarations.get(version) !== null && from <= at && at < to && this.chunks.delete(name)) removed++;
		}
		return removed;
	}
	request(packet: Uint8Array): Answer {
		const r = decodeClient(packet);
		if (r.t !== "set" && r.t !== "del" && r.t !== "restore") throw new Error("expected proposal");
		const req = hex(r.req), file = hex(r.file), prior = this.answers.get(req);
		if (prior !== undefined) return { req, ok: prior };
		const row = this.rows.get(file), old = this.keys.get(file);
		const refuse = (holder = row, missing = false) => ({ req, row: holder ?? null, missing });
		if ((row?.seq ?? null) !== r.base) return refuse();
		const path = r.t === "del" ? old!.path : hex(r.pathkey);
		if (r.t !== "del") {
			const holder = this.live().find(x => x.file !== file && this.keys.get(x.file)!.path === path);
			if (holder) return refuse(holder);
		}
		if (r.t === "restore" && (!row || row.deleted === null)) return refuse();
		if (r.t === "del" && (!row || row.deleted !== null)) return refuse();
		if (r.t === "set" && r.version === null) throw new Error("Unexpected note in attachment model");
		const version = r.t === "set" ? hex(r.version!) : old!.version;
		if (r.t === "set" && row?.deleted != null && version === old?.version) return refuse();
		if (r.t !== "del") {
			const n = r.expectedChunks, declared = this.declarations.get(version);
			const owned = [...this.owners].filter(([,v]) => v === version);
			if (n === null ? version !== old?.version || declared !== null :
				(declared !== undefined && declared !== n) || owned.length !== n || owned.some(([k]) => !this.chunks.has(k))) return refuse(row, true);
			this.declarations.set(version, n);
		}
		const data: RecordData = r.t === "del" ? row! : JSON.parse(dec.decode(r.record));
		const seq = ++this.seq;
		this.rows.set(file, { ...data, file, seq, deleted: r.t === "del" ? this.time : null });
		this.keys.set(file, { path, version });
		if (old && row?.deleted === null && !this.live().some(r => this.keys.get(r.file)!.version === old.version)) this.retired.set(old.version, this.time);
		if (r.t !== "del") this.retired.delete(version);
		this.answers.set(req, seq);
		return { req, ok: seq };
	}
}

export async function client(w: WorkerModel, disk = new Files(), store = new Memory(), submit = (p: Uint8Array) => w.request(p)) {
	let dev = await TableDevice.open(store);
	const i: DiskInputs = { id: w.id, attachments: true, allowed: p => !p.startsWith("."), maxFileSize: 100000,
		hash: async b => hash(b), suffix: (h,n) => conflictSuffix(nameKey,h,n),
		async stage(f) {
			const b = await disk.readBinary(f.path), u = w.id(), c: string[] = [];
			for (let at = 0; at < b.length; at += partSize) c.push(chunkName(u,c.length,b.subarray(at,at+partSize)));
			await store.commit(new Map([["table/blob/"+u,b]]), []);
			return { h: hash(b), n: b.length, c, u, s: 1 };
		},
		async readStage(ref) { return store.get<Uint8Array>("table/blob/"+ref.u); },
		async fetch(ref) { const b = w.content(ref); if (!b) throw new Error("missing bytes"); return b; },
		pack: r => packRequest(r, { pathkey: async p => unhex(pathkey(p)), version: async ref => unhex(tag(ref.u)),
			seal: async (_file, data) => enc.encode(JSON.stringify(data)) }),
	};
	const plan = (e: Event = {kind:"settle"}) => planDisk(dev,disk,i,e);
	const pending = () => dev.change(s => [...s.pending].filter(([,p]) => p.acceptedDelete === undefined).map(([f]) => f));
	const packet = async (file?: string) => {
		file ??= (await pending())[0]; assert.ok(file);
		let result: Uint8Array | undefined;
		await dev.send(file, async p => { result = p; }, async (ref: Ref) => {
			const bytes = await i.readStage(ref);
			if (bytes) ref.c.forEach((c,n) => w.put(c,bytes.subarray(n*partSize,(n+1)*partSize),tag(ref.u)));
		});
		assert.ok(result); return result;
	};
	const forget = async (bytes: Uint8Array) => {
		const f = decodeClient(bytes); assert.equal(f.t,"forget");
		if (f.t === "forget") { const req = hex(f.req); w.answers.delete(req); await dev.forgotten(req); }
	};
	const ack = (a: Answer) => dev.receive(a,i,forget);
	const pull = () => dev.change(s => {
		for (const row of [...w.rows.values()].filter(r => r.seq > s.cursor).sort((a,b) => a.seq-b.seq)) catchUp(s,row);
		catchUp(s,{ cursor: w.seq });
	});
	const effect = () => executeIntent(dev,disk,i);
	const deliver = async () => ack(submit(await packet()));
	const settle = async () => {
		const seen = new Set<string>(), failedDownloads = new Set<string>(), failedSends = new Set<string>();
		let before: number;
		do {
			before = dev.revision;
			await pull(); await planDisk(dev, disk, i, {kind:"settle"}, failedDownloads);
			if (await dev.change(s => !!s.intent)) await executeIntent(dev,disk,i,failedDownloads);
			else {
				const file = (await pending()).find(f => !failedSends.has(f));
				if (file) {
					const answer = submit(await packet(file));
					await ack(answer);
					if ("missing" in answer && answer.missing) failedSends.add(file);
				}
			}
		} while (await dev.needsAnotherPass(before, seen, [failedDownloads, failedSends]));
	};
	return { disk, store, i, plan, packet, submit, ack, pull, effect, deliver, pending, settle, forget,
		reopen: async () => { dev = await TableDevice.open(store); }, get dev() { return dev; } };
}
