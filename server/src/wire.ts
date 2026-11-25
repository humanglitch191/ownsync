// Messages between a device and the Worker, as binary WebSocket frames: u8 type | fields.
// The Worker stores and relays sealed envelopes. All it knows of one is which document it belongs to
// (an opaque 16-byte tag) and whether it is a snapshot, or for an attachment chunk, its name (a keyed hash).
//
// Table-capable peers send table immediately after hello and receive format. A migration stages
// rows numbered from 1 on that connection and commits genesis(base, rows) at the legacy head.
// Table versions on the wire are the opaque storage tags used by vput.
// A presence byte precedes a version tag in a row or set; absent means note. Note del carries a
// sealed replacement record with the deleting device's state vector. File and request IDs are
// 16 bytes each. A zero set base means create. stageRow, set and restore prefix the payload with a scoped count or a legacy marker. since/tableMore/tableSynced have their own cursor.
//
// device → Worker
//   hello      token(32) | owner(32)?          must be first (fetch aside); the Worker keeps only the token's hash.
//                                              `owner`, the Worker's owner code, is needed only to create a vault
//   subscribe  after(8)                        send me entries with seq > after
//   publish    id(4) | doc(16) | envelope      store this update; `id` comes back in the ack
//   snapshot   doc(16) | base(8) | envelope    this is the whole document as of seq `base`: drop its older entries
//   live       doc(16) | envelope              relay to my other devices now, don't store
//   fetch      from(4)                         send me the membership records numbered `from` and up; allowed before hello
//   append     number(4) | u16 n | recovery(n) | blob
//                                              store this membership record if `number` is the next one; n > 0 also
//                                              replaces the sealed recovery key
//   rotate     number(4) | tokenHash(32) | u16 n | recovery(n) | blob
//                                              the same for a rotation record; from then on only the new token opens the vault
//   put        name(32) | envelope             store this attachment chunk under its name, unless it is there
//   get        name(32)                        send me that chunk
//   status     id(4) | conflicts(4) | version  for the owner's dashboard: this device's short ID, how many conflict and
//                                              recovered copies it sees, its plugin version (utf8, ≤ 32 bytes); one ID per connection
//   vput       tag(32) | name(32) | envelope   store this chunk of the version tagged `tag` (DESIGN.md section 10). The
//                                              name is recorded under the tag only if this vput stored the chunk, or it
//                                              is already recorded under that tag; otherwise the reply is `missing`
//   mark       id(4) | flags(1) | n × tag(32)  n ≤ 1024: these versions were retired (flag 1; with flag 8, because their
//                                              attachment was deleted) or are current (flag 2); flag 16 starts and
//                                              flag 4 ends this device's full list of what is current; no flags: only asks (marked)
//
// Worker → device
//   entry      seq(8) | doc(16) | snapshot(1) | envelope
//   more       seq(8)                          that was one page, up to `seq`: subscribe again from there
//   synced     seq(8)                          you have everything up to `seq`; what follows is live
//   ack        id(4) | seq(8)                  your publish was stored as `seq`
//   live       doc(16) | envelope
//   record     number(4) | blob                one stored membership record
//   records    recovery                        end of the records that answer a fetch or an append, then the sealed
//                                              recovery key (empty if there is none)
//   stored     name(32)                        that chunk is stored
//   chunk      name(32) | envelope
//   missing    name(32)                        no such chunk (after a get), or it couldn't be stored (after a put or vput)
//   marked     id(4) | n × tag(32)             the answer to a mark: each tag it called current, or asked about, that
//                                              has a recorded chunk missing

/** The Worker compares opaque file and path keys. Only a device can open record. */
export type AttachmentRow = {
	file: Uint8Array; version: Uint8Array | null; pathkey: Uint8Array; record: Uint8Array;
	deleted: number | null; seq: number;
};

export type AttachmentMutation =
	| { t: "del"; req: Uint8Array; file: Uint8Array; base: number; record?: Uint8Array }
	| { t: "restore"; req: Uint8Array; file: Uint8Array; base: number; expectedChunks: number | null; pathkey: Uint8Array; record: Uint8Array }
	| { t: "set"; req: Uint8Array; file: Uint8Array; base: number | null; expectedChunks: number | null; version: Uint8Array | null; pathkey: Uint8Array; record: Uint8Array };

export type AttachmentAnswer =
	| { t: "ok"; req: Uint8Array; seq: number }
	| { t: "refused"; req: Uint8Array; row: AttachmentRow | null; missing: boolean };

export type ClientFrame =
	| { t: "migrationEstimate"; writes: number }
	| { t: "forget"; req: Uint8Array }
	| AttachmentMutation
	| { t: "stagePart"; part: number; data: Uint8Array }
	| { t: "genesis"; base: number; rows: number }
	| { t: "stageRow"; dateAtCommit?: true; expectedChunks: number | null; row: AttachmentRow }
	| { t: "table" }
	| { t: "since"; after: number }
	| { t: "hello"; token: Uint8Array; owner?: Uint8Array }
	| { t: "subscribe"; after: number }
	| { t: "publish"; id: number; doc: Uint8Array; envelope: Uint8Array }
	| { t: "snapshot"; doc: Uint8Array; base: number; envelope: Uint8Array }
	| { t: "live"; doc: Uint8Array; envelope: Uint8Array }
	| { t: "fetch"; from: number }
	| { t: "append"; number: number; recovery: Uint8Array; blob: Uint8Array }
	| { t: "rotate"; number: number; tokenHash: Uint8Array; recovery: Uint8Array; blob: Uint8Array }
	| { t: "put"; name: Uint8Array; envelope: Uint8Array }
	| { t: "get"; name: Uint8Array }
	| { t: "status"; id: Uint8Array; conflicts: number; version: string }
	| { t: "vput"; tag: Uint8Array; name: Uint8Array; envelope: Uint8Array }
	| { t: "mark"; id: number; flags: number; tags: Uint8Array[] };

export type ServerFrame =
	| { t: "forgotten"; req: Uint8Array }
	| AttachmentAnswer
	| { t: "format"; table: boolean }
	| { t: "migrationBudget"; allowed: boolean }
	| { t: "migrationWriteFailed" }
	| { t: "migrationFailed"; reason: string }
	| { t: "row"; row: AttachmentRow }
	| { t: "tableMore" | "tableSynced" | "stagedPart"; seq: number }
	| { t: "entry"; seq: number; doc: Uint8Array; snapshot: boolean; envelope: Uint8Array }
	| { t: "more"; seq: number }
	| { t: "synced"; seq: number }
	| { t: "ack"; id: number; seq: number }
	| { t: "live"; doc: Uint8Array; envelope: Uint8Array }
	| { t: "record"; number: number; blob: Uint8Array }
	| { t: "records"; recovery: Uint8Array }
	| { t: "stored"; name: Uint8Array }
	| { t: "chunk"; name: Uint8Array; envelope: Uint8Array }
	| { t: "missing"; name: Uint8Array }
	| { t: "marked"; id: number; tags: Uint8Array[] };

/** WebSocket close codes the Worker uses. `rekeyed`: a device rotated the vault key; fetch the records and come back.
 * `deleted`: the vault was deleted from the Worker; don't come back. */
export const CLOSE = { badMessage: 4000, unauthorized: 4001, notOwner: 4002, rekeyed: 4003, deleted: 4004, updateNeeded: 4005 } as const;
export const DOC_TAG_BYTES = 16;
export const CHUNK_NAME_BYTES = 32;
/** Largest envelope the Worker stores. Workers accept messages up to 32 MiB and rows up to 8 MB. */
export const MAX_ENVELOPE = 4 * 1024 * 1024;
/** Largest stored membership record, and the exact size of a sealed recovery key (d | pub | tag). */
export const MAX_RECORD = 64 * 1024;
export const RECOVERY_SEALED = 32 + 65 + 16;
/** Largest attachment chunk (plaintext), and the most its envelope adds. */
export const MAX_CHUNK = 1024 * 1024;
export const CHUNK_OVERHEAD = 64;
export const SHORT_ID_BYTES = 4;
export const MAX_VERSION = 32;
/** A version tag's size, the most tags in one mark, the most chunks one version may have, and mark's flags. */
export const TAG_BYTES = 32;
export const MAX_MARK = 1024;
export const MARK = { retired: 1, current: 2, last: 4, deleted: 8, start: 16 } as const;

const CLIENT = { hello: 1, subscribe: 2, publish: 3, snapshot: 4, live: 5, fetch: 6, append: 7, rotate: 8, put: 9, get: 10, status: 11, vput: 12, mark: 13, table: 14, since: 15, set: 16, del: 17, restore: 18, stageRow: 19, genesis: 20, forget: 21, stagePart: 23, migrationEstimate: 24 } as const;
const SERVER = { entry: 16, more: 17, synced: 18, ack: 19, live: 20, record: 21, records: 22, stored: 24, chunk: 25, missing: 26, marked: 27, format: 28, row: 29, tableMore: 30, tableSynced: 31, ok: 32, refused: 33, stagedPart: 34, forgotten: 35, migrationWriteFailed: 37, migrationFailed: 38, migrationBudget: 39 } as const;

/** Legacy messages retain their original limit. A table record has additional fixed fields
 * and at most two fixed-width IDs; the decoder checks the record itself. */
const MAX_TABLE_FRAME = MAX_ENVELOPE + 1 + 2 * DOC_TAG_BYTES + 2 * TAG_BYTES + 2 * 8 + 1 + 3;
export function validClientSize(bytes: Uint8Array): boolean {
	if (!bytes.length) return false;
	const type = bytes[0];
	if (type === CLIENT.set || type === CLIENT.restore || type === CLIENT.stageRow || type === CLIENT.del)
		return bytes.length <= MAX_TABLE_FRAME;
	return bytes.length <= MAX_ENVELOPE + 64;
}

function build(type: number, ...fields: (Uint8Array | [bytes: 1 | 2 | 4 | 8, value: number])[]): Uint8Array {
	const size = fields.reduce((n, f) => n + (f instanceof Uint8Array ? f.length : f[0]), 1);
	const out = new Uint8Array(size), view = new DataView(out.buffer);
	out[0] = type;
	let at = 1;
	for (const f of fields) {
		if (f instanceof Uint8Array) { out.set(f, at); at += f.length; continue; }
		if (f[0] === 1) view.setUint8(at, f[1]);
		else if (f[0] === 2) view.setUint16(at, f[1]);
		else if (f[0] === 4) view.setUint32(at, f[1]);
		else view.setBigUint64(at, BigInt(f[1]));
		at += f[0];
	}
	return out;
}

/** Reads fields off a frame; throws RangeError on a frame that is too short. */
class Reader {
	private bytes: Uint8Array;
	private view: DataView;
	private at = 1;
	constructor(bytes: Uint8Array) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
	u8(): number { return this.view.getUint8(this.at++); }
	u16(): number { const v = this.view.getUint16(this.at); this.at += 2; return v; }
	u32(): number { const v = this.view.getUint32(this.at); this.at += 4; return v; }
	u64(): number { const v = Number(this.view.getBigUint64(this.at)); this.at += 8; return v; }
	take(n: number): Uint8Array {
		if (this.at + n > this.bytes.length) throw new RangeError("frame too short");
		return this.bytes.subarray(this.at, (this.at += n));
	}
	seq(): number {
		const n = this.u64();
		if (!Number.isSafeInteger(n)) throw new RangeError("unsafe sequence");
		return n;
	}
	bool(): boolean {
		const n = this.u8();
		if (n > 1) throw new RangeError("bad flag");
		return n === 1;
	}
	expectedChunks(): number | null {
		if (!this.bool()) return null;
		const n = this.u16();
		if (n > MAX_MARK) throw new RangeError("too many chunks");
		return n;
	}
	end<T>(value: T): T {
		if (this.at !== this.bytes.length) throw new RangeError("trailing bytes");
		return value;
	}
	record(): Uint8Array {
		const record = this.rest();
		if (!record.length || record.length > MAX_ENVELOPE) throw new RangeError("bad attachment record");
		return record;
	}
	rest(): Uint8Array { return this.bytes.subarray(this.at); }
}

function id(value: Uint8Array): Uint8Array {
	if (value.length !== DOC_TAG_BYTES) throw new RangeError("invalid identifier length");
	return value;
}

function chunkDeclaration(n: number | null): Uint8Array {
	if (n === null) return Uint8Array.of(0);
	if (!Number.isInteger(n) || n < 0 || n > MAX_MARK) throw new RangeError("bad chunk count");
	return build(1, [2, n]);
}

function versionField(tag: Uint8Array | null): Uint8Array {
	if (tag === null) return Uint8Array.of(0);
	if (tag.length !== TAG_BYTES) throw new RangeError("invalid version tag");
	return build(1, tag);
}

function readRow(r: Reader): AttachmentRow {
	return { file: r.take(DOC_TAG_BYTES), version: r.bool() ? r.take(TAG_BYTES) : null, pathkey: r.take(TAG_BYTES),
		seq: r.seq(), deleted: r.bool() ? r.seq() : null, record: r.record() };
}

function rowFrame(type: number, row: AttachmentRow, ...prefix: Uint8Array[]): Uint8Array {
	return build(type, ...prefix, id(row.file), versionField(row.version), row.pathkey, [8, row.seq], [1, Number(row.deleted !== null)], ...(row.deleted === null ? [] : [[8, row.deleted] as [8, number]]), row.record);
}

export function encodeClient(f: ClientFrame): Uint8Array {
	switch (f.t) {
		case "stagePart": return build(CLIENT.stagePart, [8, f.part], f.data);
		case "stageRow": return rowFrame(CLIENT.stageRow, f.row, Uint8Array.of(Number(!!f.dateAtCommit)), chunkDeclaration(f.expectedChunks));
		case "genesis": return build(CLIENT.genesis, [8, f.base], [8, f.rows]);
		case "migrationEstimate": return build(CLIENT.migrationEstimate, [8, f.writes]);
		case "forget": return build(CLIENT.forget, id(f.req));
		case "table": return build(CLIENT.table);
		case "since": return build(CLIENT.since, [8, f.after]);
		case "set": return build(CLIENT.set, chunkDeclaration(f.expectedChunks), id(f.req), id(f.file), [8, f.base ?? 0], versionField(f.version), f.pathkey, f.record);
		case "del": return build(CLIENT.del, id(f.req), id(f.file), [8, f.base], ...(f.record ? [f.record] : []));
		case "restore": return build(CLIENT.restore, chunkDeclaration(f.expectedChunks), id(f.req), id(f.file), [8, f.base], f.pathkey, f.record);
		case "hello": return f.owner ? build(CLIENT.hello, f.token, f.owner) : build(CLIENT.hello, f.token);
		case "subscribe": return build(CLIENT.subscribe, [8, f.after]);
		case "publish": return build(CLIENT.publish, [4, f.id], f.doc, f.envelope);
		case "snapshot": return build(CLIENT.snapshot, f.doc, [8, f.base], f.envelope);
		case "live": return build(CLIENT.live, f.doc, f.envelope);
		case "fetch": return build(CLIENT.fetch, [4, f.from]);
		case "append": return build(CLIENT.append, [4, f.number], [2, f.recovery.length], f.recovery, f.blob);
		case "rotate": return build(CLIENT.rotate, [4, f.number], f.tokenHash, [2, f.recovery.length], f.recovery, f.blob);
		case "put": return build(CLIENT.put, f.name, f.envelope);
		case "get": return build(CLIENT.get, f.name);
		case "status": return build(CLIENT.status, f.id, [4, f.conflicts], new TextEncoder().encode(f.version));
		case "vput": return build(CLIENT.vput, f.tag, f.name, f.envelope);
		case "mark": return build(CLIENT.mark, [4, f.id], [1, f.flags], ...f.tags);
	}
}

export function decodeClient(bytes: Uint8Array): ClientFrame {
	const r = new Reader(bytes);
	switch (bytes[0]) {
		case CLIENT.stagePart: {
			const part = r.seq(), data = r.rest();
			if (!part || !data.length || data.length > GENESIS_PART_BYTES) throw new RangeError("invalid genesis part");
			return { t: "stagePart", part, data };
		}
		case CLIENT.stageRow: return { t: "stageRow", ...(r.bool() ? { dateAtCommit: true as const } : {}), expectedChunks: r.expectedChunks(), row: readRow(r) };
		case CLIENT.genesis: return r.end({ t: "genesis", base: r.seq(), rows: r.seq() });
		case CLIENT.migrationEstimate: return r.end({ t: "migrationEstimate", writes: r.seq() });
		case CLIENT.forget: return r.end({ t: "forget", req: r.take(DOC_TAG_BYTES) });
		case CLIENT.table: return r.end({ t: "table" });
		case CLIENT.since: return r.end({ t: "since", after: r.seq() });
		case CLIENT.set: return { t: "set", expectedChunks: r.expectedChunks(), req: r.take(DOC_TAG_BYTES), file: r.take(DOC_TAG_BYTES), base: r.seq() || null, version: r.bool() ? r.take(TAG_BYTES) : null, pathkey: r.take(TAG_BYTES), record: r.record() };
		case CLIENT.del: {
			const req = r.take(DOC_TAG_BYTES), file = r.take(DOC_TAG_BYTES), base = r.seq();
			const record = r.rest();
			if (record.length > MAX_ENVELOPE) throw new RangeError("bad deletion record");
			return record.length ? { t: "del", req, file, base, record } : { t: "del", req, file, base };
		}
		case CLIENT.restore: return { t: "restore", expectedChunks: r.expectedChunks(), req: r.take(DOC_TAG_BYTES), file: r.take(DOC_TAG_BYTES), base: r.seq(), pathkey: r.take(TAG_BYTES), record: r.record() };
		case CLIENT.hello: {
			const token = r.take(32), owner = r.rest();
			return owner.length ? { t: "hello", token, owner } : { t: "hello", token };
		}
		case CLIENT.subscribe: return { t: "subscribe", after: r.u64() };
		case CLIENT.publish: return { t: "publish", id: r.u32(), doc: r.take(DOC_TAG_BYTES), envelope: r.rest() };
		case CLIENT.snapshot: return { t: "snapshot", doc: r.take(DOC_TAG_BYTES), base: r.u64(), envelope: r.rest() };
		case CLIENT.live: return { t: "live", doc: r.take(DOC_TAG_BYTES), envelope: r.rest() };
		case CLIENT.fetch: return { t: "fetch", from: r.u32() };
		case CLIENT.append: return { t: "append", number: r.u32(), recovery: r.take(r.u16()), blob: r.rest() };
		case CLIENT.rotate: return { t: "rotate", number: r.u32(), tokenHash: r.take(32), recovery: r.take(r.u16()), blob: r.rest() };
		case CLIENT.put: return { t: "put", name: r.take(CHUNK_NAME_BYTES), envelope: r.rest() };
		case CLIENT.get: return { t: "get", name: r.take(CHUNK_NAME_BYTES) };
		case CLIENT.status: {
			const id = r.take(SHORT_ID_BYTES), conflicts = r.u32(), version = r.rest();
			if (version.length > MAX_VERSION) throw new RangeError("version too long");
			return { t: "status", id, conflicts, version: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(version) };
		}
		case CLIENT.vput: return { t: "vput", tag: r.take(TAG_BYTES), name: r.take(CHUNK_NAME_BYTES), envelope: r.rest() };
		case CLIENT.mark: return { t: "mark", id: r.u32(), flags: r.u8(), tags: tags(r.rest()) };
		default: throw new RangeError("unknown frame type");
	}
}

function tags(rest: Uint8Array): Uint8Array[] {
	if (rest.length % TAG_BYTES || rest.length > MAX_MARK * TAG_BYTES) throw new RangeError("bad tag list");
	return Array.from({ length: rest.length / TAG_BYTES }, (_, i) => rest.subarray(i * TAG_BYTES, (i + 1) * TAG_BYTES));
}

export function encodeServer(f: ServerFrame): Uint8Array {
	switch (f.t) {
		case "migrationBudget": return build(SERVER.migrationBudget, [1, Number(f.allowed)]);
		case "migrationFailed": return build(SERVER.migrationFailed, new TextEncoder().encode(f.reason));
		case "migrationWriteFailed": return build(SERVER.migrationWriteFailed);
		case "forgotten": return build(SERVER.forgotten, id(f.req));
		case "format": return build(SERVER.format, [1, Number(f.table)]);
		case "row": return rowFrame(SERVER.row, f.row);
		case "tableMore": case "tableSynced": case "stagedPart": return build(SERVER[f.t], [8, f.seq]);
		case "ok": return build(SERVER.ok, id(f.req), [8, f.seq]);
		case "refused": {
			const header = build(SERVER.refused, id(f.req), [1, Number(f.missing)]);
			return f.row ? rowFrame(SERVER.refused, f.row, header.subarray(1)) : header;
		}
		case "entry": return build(SERVER.entry, [8, f.seq], f.doc, [1, f.snapshot ? 1 : 0], f.envelope);
		case "more": return build(SERVER.more, [8, f.seq]);
		case "synced": return build(SERVER.synced, [8, f.seq]);
		case "ack": return build(SERVER.ack, [4, f.id], [8, f.seq]);
		case "live": return build(SERVER.live, f.doc, f.envelope);
		case "record": return build(SERVER.record, [4, f.number], f.blob);
		case "records": return build(SERVER.records, f.recovery);
		case "stored": return build(SERVER.stored, f.name);
		case "chunk": return build(SERVER.chunk, f.name, f.envelope);
		case "missing": return build(SERVER.missing, f.name);
		case "marked": return build(SERVER.marked, [4, f.id], ...f.tags);
	}
}

export function decodeServer(bytes: Uint8Array): ServerFrame {
	const r = new Reader(bytes);
	switch (bytes[0]) {
		case SERVER.migrationBudget: return r.end({ t: "migrationBudget", allowed: r.bool() });
		case SERVER.migrationFailed: return { t: "migrationFailed", reason: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(r.rest()) };
		case SERVER.migrationWriteFailed: return r.end({ t: "migrationWriteFailed" });
		case SERVER.forgotten: return r.end({ t: "forgotten", req: r.take(DOC_TAG_BYTES) });
		case SERVER.format: return r.end({ t: "format", table: r.bool() });
		case SERVER.row: return { t: "row", row: readRow(r) };
		case SERVER.stagedPart: return r.end({ t: "stagedPart", seq: r.seq() });
		case SERVER.tableMore: case SERVER.tableSynced: return r.end({ t: bytes[0] === SERVER.tableMore ? "tableMore" : "tableSynced", seq: r.seq() });
		case SERVER.ok: return r.end({ t: "ok", req: r.take(DOC_TAG_BYTES), seq: r.seq() });
		case SERVER.refused: {
			const req = r.take(DOC_TAG_BYTES), missing = r.bool();
			return { t: "refused", req, missing, row: r.rest().length ? readRow(r) : null };
		}
		case SERVER.entry: return { t: "entry", seq: r.u64(), doc: r.take(DOC_TAG_BYTES), snapshot: r.u8() === 1, envelope: r.rest() };
		case SERVER.more: return { t: "more", seq: r.u64() };
		case SERVER.synced: return { t: "synced", seq: r.u64() };
		case SERVER.ack: return { t: "ack", id: r.u32(), seq: r.u64() };
		case SERVER.live: return { t: "live", doc: r.take(DOC_TAG_BYTES), envelope: r.rest() };
		case SERVER.record: return { t: "record", number: r.u32(), blob: r.rest() };
		case SERVER.records: return { t: "records", recovery: r.rest() };
		case SERVER.stored: return { t: "stored", name: r.take(CHUNK_NAME_BYTES) };
		case SERVER.chunk: return { t: "chunk", name: r.take(CHUNK_NAME_BYTES), envelope: r.rest() };
		case SERVER.missing: return { t: "missing", name: r.take(CHUNK_NAME_BYTES) };
		case SERVER.marked: return { t: "marked", id: r.u32(), tags: tags(r.rest()) };
		default: throw new RangeError("unknown frame type");
	}
}


// Length-prefixed stageRow frames form one stream: even a maximum-size sealed record
// can cross part boundaries. Keep at most one part and one decoded row in memory.
export const GENESIS_PART_BYTES = 1024 * 1024;
type StageRow = Extract<ClientFrame, { t: "stageRow" }>;

export function genesisWrites(live: number, deleted: number, parts: number) {
	return 3 * live + 2 * deleted + 2 * parts + 2;
}

// The dry pass retains one sealed row. A second pass over the same immutable
// projection produces fresh ciphertext of identical length when staging is granted.
export async function estimateGenesis(rows: AsyncIterable<StageRow> | Iterable<StageRow>) {
	let live = 0, deleted = 0, bytes = 0;
	for await (const frame of rows) {
		if (frame.dateAtCommit || frame.row.deleted !== null) deleted++; else live++;
		bytes += Uint32Array.BYTES_PER_ELEMENT + encodeClient(frame).length;
	}
	return genesisWrites(live, deleted, Math.ceil(bytes / GENESIS_PART_BYTES));
}

export async function* packGenesis(rows: AsyncIterable<StageRow> | Iterable<StageRow>) {
	let part = new Uint8Array(GENESIS_PART_BYTES), used = 0;
	for await (const row of rows) {
		const frame = encodeClient(row), length = new Uint8Array(4);
		new DataView(length.buffer).setUint32(0, frame.length);
		for (const data of [length, frame]) {
			for (let at = 0; at < data.length;) {
				const n = Math.min(data.length - at, part.length - used);
				part.set(data.subarray(at, at + n), used);
				at += n; used += n;
				if (used === part.length) { yield part; part = new Uint8Array(GENESIS_PART_BYTES); used = 0; }
			}
		}
	}
	if (used) yield part.subarray(0, used);
}

export function* unpackGenesis(parts: Iterable<Uint8Array>): Generator<StageRow> {
	const length = new Uint8Array(4);
	let field = length, used = 0;
	for (const part of parts) {
		for (let at = 0; at < part.length;) {
			const n = Math.min(field.length - used, part.length - at);
			field.set(part.subarray(at, at + n), used);
			at += n; used += n;
			if (used !== field.length) continue;
			used = 0;
			if (field === length) {
				const size = new DataView(length.buffer).getUint32(0);
				if (!size || size > MAX_TABLE_FRAME)
					throw new RangeError("invalid genesis row length");
				field = new Uint8Array(size);
			} else {
				const row = decodeClient(field);
				if (row.t !== "stageRow") throw new RangeError("expected a genesis row");
				yield row;
				field = length;
			}
		}
	}
	if (used || field !== length) throw new RangeError("truncated genesis row");
}
