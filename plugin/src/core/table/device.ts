// Transitions operate on a private draft. TableDevice commits the changed records together.
import { concat, hex, unhex } from "../../../../protocol/ownsync";
import { encodeClient } from "../../../../server/src/wire";
import type { Ref, Store } from "../ports";

export interface RecordData { path: string; bytes: Ref; mtime: number | null }
export interface Row extends RecordData { file: string; seq: number; deleted: number | null }
export interface Local {
	path: string;
	base: { path?: string; bytes?: Pick<Ref, "h"> & Partial<Ref> };
	removed?: boolean; // explicit delete or authoritative startup absence, retained across an in-flight proposal
	redundant?: { target: string; hash: string };
}
export function checkLocalPaths(locals: Iterable<Local>) {
	const paths = new Set<string>();
	for (const { path } of locals) {
		if (paths.has(path)) throw new Error("Multiple local attachment IDs at " + path);
		paths.add(path);
	}
}
export interface Observation { path: string; size: number; mtime: number; hash?: string }
export type Request = { req: string; file: string } & (
	| { t: "del"; base: number }
	| { t: "set"; base: number | null; data: RecordData }
	| { t: "restore"; base: number; data: RecordData }
);
export interface Pending {
	request: Request;
	packet: Uint8Array;
	sourcePath?: string;
	agreePath?: boolean;
	agreeBytes?: boolean;
	repair?: boolean;
	acceptedDelete?: number;
}
export type Intent = { file: string; path: string; seq: number; authority?: string } & (
	| { kind: "write"; before: string | null; data: RecordData }
	| { kind: "rename"; from: string; hash: string }
	| { kind: "park"; hash: string; saved: Ref }
	| { kind: "remove"; hash: string }
);
export interface Blocked {
	authority: string;
	seq: number;
	endpoints: [string, Observation | null][];
}
export interface State {
	observed: Map<string, Observation>;
	blocked: Map<string, Blocked>;
	latest: Map<string, Row>;
	local: Map<string, Local>;
	pending: Map<string, Pending>;
	forget: Map<string, true>;
	parked: Map<string, Ref>;
	cursor: number;
	intent?: Intent;
}
export interface Inputs {
	id(): string;
	stage(observation: Observation): Promise<Ref>; // durable immutable bytes, also used to repair missing chunks
	suffix(hash: string, counter: number): Promise<string>;
	pack(request: Request): Promise<Uint8Array>;
}

export async function conflictSuffix(vaultNameKey: Uint8Array, hash: string, counter: number): Promise<string> {
	if (!/^[0-9a-f]{64}$/i.test(hash) || !Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) throw new Error("Invalid suffix input");
	const retry = new Uint8Array(counter ? 4 : 0);
	if (counter) new DataView(retry.buffer).setUint32(0, counter);
	const key = await crypto.subtle.importKey("raw", vaultNameKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const input = concat(new TextEncoder().encode("ownsync/conflict-suffix\0"), unhex(hash), retry);
	return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, input))).slice(0, 6);
}

export async function packRequest(r: Request, crypto: {
	pathkey(path: string): Promise<Uint8Array>; version(ref: Ref): Promise<Uint8Array>; seal(file: string, data: RecordData): Promise<Uint8Array>;
}) {
	const ids = { req: unhex(r.req), file: unhex(r.file) };
	if (r.t === "del") return encodeClient({ ...ids, t: "del", base: r.base });
	const data = { ...ids, record: await crypto.seal(r.file, r.data), pathkey: await crypto.pathkey(r.data.path),
		expectedChunks: r.data.bytes.s ? r.data.bytes.c.length : null };
	return encodeClient(r.t === "set" ? { ...data, t: "set", base: r.base, version: await crypto.version(r.data.bytes) }
		: { ...data, t: "restore", base: r.base });
}

const withSuffix = (path: string, suffix: string) => path.replace(/(\.[^./]*)?$/, (_, ext) => ` (${suffix})${ext ?? ""}`);
function occupant(s: State, path: string, except: string) {
	let found: Row | undefined;
	for (const row of s.latest.values()) if (row.file !== except && row.deleted === null && row.path === path && (!found || row.seq > found.seq)) found = row;
	return found;
}

function remember(s: State, row: Row) {
	if ((s.latest.get(row.file)?.seq ?? 0) < row.seq) s.latest.set(row.file, row);
}

// Called only for ordered since/live frames. A refusal may already have supplied a newer row.
export function catchUp(s: State, frame: Row | { cursor: number }) {
	if ("cursor" in frame) s.cursor = Math.max(s.cursor, frame.cursor);
	else {
		remember(s, frame);
		const awaiting = s.pending.get(frame.file)?.acceptedDelete;
		if (awaiting !== undefined && frame.seq >= awaiting) s.pending.delete(frame.file);
		s.cursor = Math.max(s.cursor, frame.seq);
	}
}

async function propose(s: State, source: string, request: Request, inputs: Inputs, fields: Omit<Pending, "request" | "packet"> = {}) {
	if (s.pending.has(source)) throw new Error("Proposal already pending");
	s.pending.set(source, { ...fields, request, packet: await inputs.pack(request) });
}

export function reserved(s: State, file: string) {
	if (s.pending.has(file)) return true;
	for (const { request } of s.pending.values()) if (request.file === file) return true;
	return false;
}

function handover(s: State, source: string, target: Row, at: string) {
	const local = s.local.get(source);
	if (!local) return;
	// The accepted bytes may still be at the ordinary name. Move disk to the accepted name on settle.
	const holder = s.local.get(target.file);
	if (source !== target.file && holder) {
		if (holder.path === local.path) { s.local.delete(source); return; }
		s.local.set(source, { ...local, redundant: { target: target.file, hash: target.bytes.h } });
		return;
	}
	s.local.delete(source);
	s.local.set(target.file, { ...local, base: { path: at, bytes: target.bytes } });
}

export async function restore(s: State, row: Row, inputs: Inputs) {
	if (row.deleted === null || s.latest.get(row.file)?.seq !== row.seq || reserved(s, row.file)) return;
	let path = row.path;
	for (let n = 1; occupant(s, path, row.file); n++) path = withSuffix(row.path, n === 1 ? "restored" : `restored ${n}`);
	await propose(s, row.file, { t: "restore", req: inputs.id(), file: row.file, base: row.seq, data: { ...record(row), path } }, inputs);
}

function record(row: Row): RecordData { return { path: row.path, bytes: row.bytes, mtime: row.mtime }; }

export type Answer = { req: string; ok: number } | { req: string; row: Row | null; missing: boolean };
export async function answer(s: State, a: Answer, inputs: Inputs): Promise<"gone" | void> {
	const entry = [...s.pending].find(([, p]) => p.request.req === a.req);
	if (!entry) return;
	const [source, p] = entry, r = p.request;
	if (p.acceptedDelete !== undefined) return;
	s.pending.delete(source);
	s.forget.set(r.req, true);
	if ("row" in a) {
		if (a.row) remember(s, a.row);
		if (a.missing && r.t === "restore") return "gone";
		if (a.missing && r.t === "set") {
			await propose(s, source, { ...r, req: inputs.id() }, inputs, {
				sourcePath: p.sourcePath, agreePath: p.agreePath, agreeBytes: p.agreeBytes, repair: true,
			});
		} else if (r.t === "restore" && a.row && a.row.file !== source) {
			const original = s.latest.get(source);
			if (original?.seq === r.base) await restore(s, original, inputs);
		} else if (r.t === "set" && r.base === null && a.row?.file !== r.file && a.row?.deleted === null
			&& a.row.path === r.data.path && a.row.bytes.h === r.data.bytes.h && s.latest.get(a.row.file)?.seq === a.row.seq) {
			handover(s, source, a.row, p.sourcePath!);
		}
		return;
	}
	if (r.t === "del") {
		if ((s.latest.get(source)?.seq ?? 0) < a.ok) s.pending.set(source, { ...p, acceptedDelete: a.ok });
		// ok carries no deletion time. The stream supplies the tombstone. A newer edit is still authoritative.
		s.local.delete(source);
		return;
	}
	const accepted: Row = { ...r.data, file: r.file, deleted: null, seq: a.ok };
	remember(s, accepted);
	if (r.t === "restore") return;
	if (source !== r.file) { handover(s, source, accepted, p.sourcePath!); return; }
	const local = s.local.get(source);
	if (local) s.local.set(source, { ...local, base: {
		path: p.agreePath ? p.sourcePath : local.base.path, bytes: p.agreeBytes ? r.data.bytes : local.base.bytes,
	} });
}

// One field's three-way comparison. Missing migration bases make unequal values concurrent.
function field(mine: string, theirs: string, base?: string) {
	if (mine === theirs) return "equal";
	if (mine === base) return "theirs";
	if (theirs === base) return "mine";
	return "both";
}

export async function reconcile(s: State, file: string, view: ReadonlyMap<string, Observation>, missingIsDelete: boolean, inputs: Inputs): Promise<void> {
	if (s.intent?.file === file || reserved(s, file)) return;
	const schedule = (op: Intent) => { if (!s.intent) s.intent = op; };
	const row = s.latest.get(file);
	let local = s.local.get(file);
	if (!local) {
		if (row && row.deleted === null && !view.has(row.path) && ![...s.local.values()].some(f => f.path === row.path))
			schedule({ seq: row.seq, kind: "write", file, path: row.path, before: null, data: record(row) });
		if (row?.deleted != null) s.parked.delete(file);
		return;
	}
	const disk = view.get(local.path);
	if (!disk) {
		if (!missingIsDelete && !local.removed) return;
		if (!row || row.deleted !== null) { s.local.delete(file); return; }
		if (local.base.bytes?.h !== row.bytes.h) {
			s.local.delete(file);
			return reconcile(s, file, view, false, inputs); // re-materialize the unseen edit
		}
		await propose(s, file, { t: "del", req: inputs.id(), file, base: row.seq }, inputs);
		return;
	}
	if (local.removed) {
		local = { ...local, removed: false };
		s.local.set(file, local);
	}
	if (disk.hash === undefined) return;
	const hash = disk.hash;
	if (local.redundant) {
		const target = s.latest.get(local.redundant.target);
		if (hash === local.redundant.hash && target?.deleted === null && target.bytes.h === hash) {
			schedule({ kind: "remove", file, path: local.path, hash, seq: target.seq, authority: target.file });
			return;
		}
		local = { ...local, redundant: undefined };
		s.local.set(file, local);
	}
	if (row && row.deleted !== null && local.base.bytes?.h === hash) {
		schedule({ seq: row.seq, kind: "remove", file, path: local.path, hash }); return;
	}
	const bytes = row && row.deleted === null ? field(hash, row.bytes.h, local.base.bytes?.h) : "mine";
	const path = row && row.deleted === null ? field(disk.path, row.path, local.base.path) : "mine";
	const ownPath = path === "mine", ownBytes = bytes === "mine";
	let dest = ownPath || !row ? disk.path : row.path;
	const copy = bytes === "both" && !ownPath;
	const takeMine = ownBytes || copy;
	const create = !row || copy;
	if (ownPath || ownBytes || copy) {
		const other = occupant(s, dest, file);
		// A cached holder can have moved. Only its Worker refusal proves who owns identical bytes.
		const value = takeMine ? hash : row!.bytes.h;
		if (copy || (other && (row || other.bytes.h !== hash))) {
			const original = dest;
			for (let counter = 0; ; counter++) {
				dest = withSuffix(original, `conflict ${await inputs.suffix(value, counter)}`);
				const holder = occupant(s, dest, file);
				if (!holder || (create && holder.bytes.h === value)) break;
			}
		}
		const ref = takeMine ? await inputs.stage(disk) : row!.bytes;
		if (takeMine && (ref.h !== hash || ref.n !== disk.size || !ref.s)) throw new Error("File changed during staging or version is unscoped");
		const target = copy ? inputs.id() : file;
		await propose(s, file, { t: "set", req: inputs.id(), file: target, base: create ? null : row!.seq,
			data: { path: dest, bytes: ref, mtime: takeMine ? disk.mtime : row!.mtime } }, inputs,
			{ agreePath: ownPath, agreeBytes: takeMine, sourcePath: disk.path });
		return;
	}
	if (!row || row.deleted !== null) return;
	const next = { ...local, base: { path: path === "equal" ? row.path : local.base.path, bytes: bytes === "equal" ? row.bytes : local.base.bytes } };
	if (local.base.path !== next.base.path || local.base.bytes?.u !== next.base.bytes?.u || local.base.bytes?.h !== next.base.bytes?.h) s.local.set(file, next);
	if (disk.path !== row.path) {
		// A pending deletion still owns its absent endpoint. Moving into it would
		// let that file's next pass read and publish the incoming file as its own.
		if (!view.has(row.path) && ![...s.local.values()].some(f => f.path === row.path))
			schedule({ seq: row.seq, kind: "rename", file, from: disk.path, path: row.path, hash });
		else if (bytes === "theirs") schedule({ seq: row.seq, kind: "write", file, path: disk.path, before: hash, data: record(row) });
	} else if (hash !== row.bytes.h) schedule({ seq: row.seq, kind: "write", file, path: disk.path, before: hash, data: record(row) });
}

const maps = ["latest", "local", "pending", "forget", "parked", "observed", "blocked"] as const;
type Meta = Pick<State, "cursor" | "intent">;
export class TableDevice {
	private queue: Promise<unknown> = Promise.resolve();
	private constructor(readonly store: Store, private state: State) {}
	static async open(store: Store) {
		const meta = await store.get<Meta>("table/meta");
		const load = async <T>(kind: string) => {
			const prefix = "table/" + kind + "/";
			return new Map((await store.list<T>(prefix)).map(([k,v]) => [k.slice(prefix.length), v]));
		};
		return new TableDevice(store, { cursor: 0, ...meta, latest: await load<Row>("latest"), local: await load<Local>("local"), pending: await load<Pending>("pending"), forget: await load<true>("forget"), parked: await load<Ref>("parked"), observed: await load<Observation>("observed"), blocked: await load<Blocked>("blocked") });
	}
	// Publish the new in-memory state only after the atomic write succeeds.
	change<T>(fn: (draft: State) => T | Promise<T>): Promise<T> {
		const work = this.queue.then(async () => {
			const before = this.state, draft = { ...before, latest: new Map(before.latest), local: new Map(before.local), pending: new Map(before.pending), forget: new Map(before.forget), parked: new Map(before.parked), observed: new Map(before.observed), blocked: new Map(before.blocked) };
			const result = await fn(draft);
			const puts = new Map<string, unknown>(), deletes: string[] = [];
			for (const kind of maps) {
				for (const [id, value] of draft[kind]) if (before[kind].get(id) !== value) puts.set(`table/${kind}/${id}`, value);
				for (const id of before[kind].keys()) if (!draft[kind].has(id)) deletes.push(`table/${kind}/${id}`);
			}
			if (before.cursor !== draft.cursor || before.intent !== draft.intent) puts.set("table/meta", { cursor: draft.cursor, intent: draft.intent });
			if (puts.size || deletes.length) {
				checkLocalPaths(draft.local.values());
				await this.store.commit(puts, deletes);
			}
			this.state = draft;
			return result;
		});
		this.queue = work.catch(() => {});
		return work;
	}
	// A disconnect after the commit or after forget is harmless. Retry until the Worker confirms deletion.
	async receive(a: Answer, inputs: Inputs, send: (packet: Uint8Array) => Promise<void>) {
		const result = await this.change(s => answer(s, a, inputs));
		await this.sendForgets(send);
		return result;
	}
	async sendForgets(send: (packet: Uint8Array) => Promise<void>) {
		await this.queue;
		for (const req of this.state.forget.keys()) await send(encodeClient({ t: "forget", req: unhex(req) }));
	}
	forgotten(req: string) { return this.change(s => { s.forget.delete(req); }); }
	async send(file: string, send: (packet: Uint8Array) => Promise<void>, upload: (ref: Ref) => Promise<void>) {
		await this.queue;
		const p = this.state.pending.get(file);
		if (!p || p.acceptedDelete !== undefined) return;
		if (p.request.t === "set" && (p.agreeBytes || p.repair)) await upload(p.request.data.bytes);
		await send(p.packet);
	}
}
