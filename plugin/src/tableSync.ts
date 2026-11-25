// Coordinates the durable table planner. Socket answers can arrive while the planner awaits
// bytes; the transport delivers those directly and queues live rows in wire order.
import { KIND, chunkName, hex, nameKey, openEnvelope, parseHeader, randomBytes, scopedChunkName, sealEnvelope, tablePathKey, unhex, versionTag } from "../../protocol/ownsync";
import { decodeClient, encodeClient, MAX_CHUNK, MAX_MARK, type AttachmentRow, type ClientFrame, type ServerFrame } from "../../server/src/wire";
import * as Y from "yjs";
import type { NoteRow } from "./core/table/notes";
import type { VaultKeys } from "./keys";
import type { Ref, Store } from "./core/ports";
import { TableDevice, catchUp, conflictSuffix, packRequest, restore, type Answer, type RecordData, type Row } from "./core/table/device";
import { executeIntent, planDisk, type DiskInputs, type DiskPort, type Event } from "./core/table/disk";
import type { Engine } from "./core/engine";
import { NoteSession } from "./core/table/noteSession";
import type { NoteRequest } from "./core/table/notePlanner";
import type { GenesisRow } from "./core/table/migration";

type Ask = (packet: Uint8Array, matches: (f: ServerFrame) => boolean) => Promise<ServerFrame>;
const id = () => hex(randomBytes(16));
const validHash = (h: unknown) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h);
export class TableSync {
	readonly notes: NoteSession;
	private device?: TableDevice;
	private ask?: Ask;
	private synced = false;
	private initialized = false;
	private startup = true;
	private queue: Promise<unknown> = Promise.resolve();
	private inputs: DiskInputs;
	private key?: Promise<Uint8Array>;
	constructor(private store: Store, private keys: VaultKeys, private disk: DiskPort, allowed: (p: string) => boolean,
		attachments: boolean, maxFileSize: number, private problem: (what: string, err: unknown) => void) {
		this.notes = new NoteSession(store);
		this.notes.beforeInventory = () => this.planAttachments({kind:"settle"});
		this.inputs = {
			id, attachments, maxFileSize, allowed,
			holdRemove: (file, seq) => !!this.notes.state?.brakePaused?.declinedIds?.includes(`remove/${file}/${seq}`),
			hash: b => this.hash(b), suffix: (h, n) => this.suffix(h, n),
			readStage: r => store.get("table/blob/" + r.u), fetch: r => this.fetch(r), stage: async o => {
				const bytes = await disk.readBinary(o.path);
				if (!o.hash || bytes.length !== o.size) throw new Error("Attachment changed during staging");
				return this.stageBytes(bytes, o.hash);
			}, legacyVersion: async (path, ref) => {
				if (!this.synced) return;
				try {
					// Existing scoped chunks can be referenced by an ordinary set. An
					// unscoped version must be verified and uploaded as a new version.
					return ref.s ? ref : await this.stageBytes(await this.fetch(ref), ref.h);
				} catch (err) { this.problem("recovering " + path, err); }
			}, pack: r => packRequest(r, { pathkey: p => this.pathkey(p), version: r => this.version(r), seal: (f, d) => this.seal(f, d) })
		};
	}
	private async stageBytes(bytes: Uint8Array, expected: string) {
		const ref: Ref = { h: await this.hash(bytes), n: bytes.length, u: id(), s: 1, c: [] };
		if (ref.h !== expected) throw new Error("Attachment changed during staging");
		for (let at = 0; at < ref.n; at += MAX_CHUNK)
			ref.c.push(await this.chunk(ref, ref.c.length, bytes.subarray(at, at + MAX_CHUNK)));
		if (ref.c.length > MAX_MARK) throw new Error("Attachment exceeds scoped version limit");
		await this.store.commit(new Map<string, unknown>([["table/blob/" + ref.u, bytes], ["table/stage/" + ref.u, true]]), []);
		return ref;
	}
	private first() { const k = this.keys.keyFor(0); if (!k) throw new Error("Missing original vault key"); return k; }
	nameKey() { return this.key ??= nameKey(this.first(), this.keys.vaultId); }
	async suffix(h: string, n: number) { return conflictSuffix(await this.nameKey(), h, n); }
	async hash(b: Uint8Array) { return hex(await chunkName(this.first(), this.keys.vaultId, b)); }
	private async chunk(r: Ref, n: number, b: Uint8Array) {
		return r.s ? hex(await scopedChunkName(this.first(), this.keys.vaultId, r.u, n, b)) : this.hash(b);
	}
	private version(r: Ref) { return versionTag(this.first(), this.keys.vaultId, r.u); }
	private async pathkey(p: string) { return tablePathKey(await this.nameKey(), p); }
	private envelope(docId: Uint8Array, kind: number, plaintext: Uint8Array) {
		if (this.keys.state.pending?.tokenHash) throw new Error("Waiting for vault key rotation");
		return sealEnvelope({ docId, kind, plaintext, vmk: this.keys.vmk, epoch: this.keys.epoch, vaultId: this.keys.vaultId, deviceId: this.keys.me.id });
	}
	private seal(file: string, { path, bytes, mtime }: RecordData) {
		return this.envelope(unhex(file), KIND.attachmentRecord, new TextEncoder().encode(JSON.stringify({ path, bytes, mtime })));
	}
	async wireRow(r: GenesisRow): Promise<AttachmentRow> {
		return { file: unhex(r.file), version: await this.version(r.bytes), pathkey: await this.pathkey(r.path), record: await this.seal(r.file, r), deleted: r.deleted, seq: r.seq };
	}
	async wireNote(row: NoteRow): Promise<AttachmentRow> {
		const { file, seq, deleted, ...record } = row;
		return { file: unhex(file), version: null, seq, deleted, pathkey: await this.pathkey(row.path),
			record: await this.envelope(unhex(file), KIND.noteRecord, new TextEncoder().encode(JSON.stringify(record))) };
	}

	private async openNote(f: AttachmentRow): Promise<NoteRow> {
		const opened = await openEnvelope(f.record, this.keys.vaultId, f.file, this.keys.keyFor);
		if (opened.kind !== KIND.noteRecord) throw new Error("Invalid note envelope kind");
		const { kind, path, id, vector, snapshot } = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext));
		if (kind !== "note" || typeof path !== "string" || !path.endsWith(".md") || path.includes("\\") ||
			path.split("/").some(part => !part || part === "." || part === "..") ||
			typeof id !== "string" || !/^(?:[0-9a-f]{2})+$/.test(id) ||
			hex(await this.pathkey(path)) !== hex(f.pathkey) ||
			(vector !== undefined && typeof vector !== "string") || (snapshot !== undefined && typeof snapshot !== "string") ||
			(f.deleted === null ? vector !== undefined || snapshot !== undefined : (vector === undefined) === (snapshot === undefined))) throw new Error("Invalid note record");
		if (snapshot !== undefined) Y.decodeSnapshot(Uint8Array.from(atob(snapshot), c => c.charCodeAt(0)));
		if (vector !== undefined) Y.decodeStateVector(Uint8Array.from(atob(vector), c => c.charCodeAt(0)));
		return { kind, path, id, ...(vector === undefined ? {} : { vector }), ...(snapshot === undefined ? {} : { snapshot }), seq: f.seq, file: hex(f.file), deleted: f.deleted };
	}

	private async openRow(f: AttachmentRow): Promise<Row> {
		if (f.version === null) throw new Error("Expected an attachment row");
		const opened = await openEnvelope(f.record, this.keys.vaultId, f.file, this.keys.keyFor);
		if (opened.kind !== KIND.attachmentRecord) throw new Error("Invalid attachment envelope kind");
		const { path, bytes, mtime } = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext)) as RecordData;
		// allowed() includes this device's private config directory. An excluded row must
		// still advance the cursor: the planner checks inclusion before touching disk.
		if (typeof path !== "string" || path.endsWith(".md") || !bytes || !validHash(bytes.h) || !Number.isSafeInteger(bytes.n) || bytes.n < 0
			|| typeof bytes.u !== "string" || !bytes.u || (bytes.s !== undefined && bytes.s !== 1) || !Array.isArray(bytes.c) || !bytes.c.every(validHash)
			|| (mtime !== null && !Number.isFinite(mtime)) || hex(await this.pathkey(path)) !== hex(f.pathkey)
			|| hex(await this.version(bytes)) !== hex(f.version)) throw new Error("Invalid attachment record");
		return { path, bytes, mtime, file: hex(f.file), seq: f.seq, deleted: f.deleted };
	}
	private request(f: ClientFrame, matches: (f: ServerFrame) => boolean) {
		if (!this.ask) throw new Error("Offline");
		return this.ask(encodeClient(f), matches);
	}
	private async fetch(ref: Ref) {
		const bytes = new Uint8Array(ref.n);
		let at = 0;
		for (const [n, h] of ref.c.entries()) {
			const name = unhex(h);
			const reply = await this.request({ t: "get", name }, f => (f.t === "chunk" || f.t === "missing") && hex(f.name) === h);
			if (reply.t !== "chunk") throw new Error("Attachment chunk is missing");
			const { kind, plaintext } = await openEnvelope(reply.envelope, this.keys.vaultId, name, this.keys.keyFor);
			if (kind !== KIND.chunk || await this.chunk(ref, n, plaintext) !== h) throw new Error("Invalid attachment chunk");
			bytes.set(plaintext, at); at += plaintext.length;
		}
		if (at !== bytes.length) throw new Error("Incomplete attachment");
		return bytes;
	}
	private async upload(ref: Ref) {
		const bytes = await this.inputs.readStage(ref);
		if (!bytes) return; // a rename may refer to a version already stored at the Worker
		const tag = await this.version(ref);
		for (const [n, h] of ref.c.entries()) {
			const name = unhex(h), data = bytes.subarray(n * MAX_CHUNK, (n + 1) * MAX_CHUNK);
			const envelope = await this.envelope(name, KIND.chunk, data);
			const reply = await this.request({ t: "vput", tag, name, envelope }, f => (f.t === "stored" || f.t === "missing") && hex(f.name) === h);
			if (reply.t !== "stored") throw new Error("Worker could not store attachment chunk");
		}
	}
	private run<T>(work: () => Promise<T>) {
		const result = this.queue.then(work);
		this.queue = result.catch(err => this.problem("attachment sync", err));
		return result;
	}
	async idle() {
		let tail;
		do { tail = this.queue; await tail; } while (tail !== this.queue);
	}
	async open() {
		if (!this.device) {
			await this.notes.load();
			this.device = await TableDevice.open(this.store);
			this.initialized = !!await this.store.get("table/initialized");
		}
	}
	async connect(ask: Ask, engine?: Engine) {
		this.engine = engine; this.textCaughtUp = false; this.noteActive = false;
		this.ask = ask; this.synced = false; this.notes.env.catchingUp = !!engine;
		await this.open();
		return this.device!.change(s => s.cursor);
	}
	disconnect() { this.ask = undefined; this.synced = false; this.notes.env.catchingUp = false; }
	row(frame: AttachmentRow) {
		const session = this.ask;
		return this.run(async () => {
			if (!session || this.ask !== session) return;
			try {
				if (frame.version === null) {
					const note = await this.openNote(frame);
					await this.notes.input({t:"row", row:note, catchUp:!!this.engine && !this.synced});
					await this.device!.change(s => catchUp(s, { cursor: frame.seq }));
					if (this.noteActive) this.schedule();
					return;
				}
				const row = await this.openRow(frame);
				await this.device!.change(s => catchUp(s, row));
				if (this.synced) this.schedule();
			} catch (e) {
				// A later page-end marker must never commit past an unreadable row.
				this.disconnect(); throw e;
			}
		});
	}
	ready(cursor: number) {
		const session = this.ask;
		return this.run(async () => {
			if (!session || this.ask !== session) return;
			await this.device!.change(s => catchUp(s, { cursor }));
			if (!this.initialized) await this.store.commit(new Map([["table/initialized", true]]), []);
			this.initialized = true; this.synced = true;
			await this.startNotesWhenReady();
			this.schedule();
		});
	}
	private engine?: Engine;
	private textCaughtUp = false;
	private noteActive = false;

	notesCaughtUp() {
		const session = this.ask;
		return this.run(async () => {
			if (!session || session !== this.ask) return;
			this.textCaughtUp = true; await this.startNotesWhenReady();
		});
	}
	private async startNotesWhenReady() {
		if (!this.engine || !this.textCaughtUp || !this.synced || this.noteActive) return;
		this.notes.env.catchingUp = false;
		if (this.engine.tableNotesReady) await this.planAttachments({kind: "settle"});
		await this.engine.initializeNoteFiles();
		await this.notes.input({t:"recheck"});
		if (!this.engine.tableNotesReady) throw new Error("Note handoff did not complete");
		this.noteActive = true;
		this.schedule();
	}
	noteWork() { if (this.synced && this.noteActive) this.schedule(); }
	private async transmitNote(doc: string, p: NoteRequest) {
		const {action, file, base, path, req, change} = p;
		const deletion = action === "del" && change.t === "del";
		const sealed = await this.wireNote({ kind: "note", id: doc, file, path, seq: 0, deleted: null,
			...(deletion ? { vector: change.vector, snapshot: change.snapshot } : {}) });
		const common = { file: sealed.file, req: unhex(req), record: sealed.record, pathkey: sealed.pathkey, expectedChunks: null };
		const frame: ClientFrame = action === "set" ? { ...common, t: action, base, version: null } : { ...common, t: action, base: base! };
		const answer = await this.request(frame, f => (f.t === "ok" || f.t === "refused") && hex(f.req) === req);
		if (answer.t === "ok") await this.notes.input({t: "answer", req, ok: answer.seq});
		else if (answer.t === "refused" && answer.row && !answer.missing)
			await this.notes.input({t: "answer", req, refused: {row: await this.openNote(answer.row), missing: false}});
		else throw new Error("Worker could not store the note change");
	}
	// Scoped to one drain. A missing chunk must not starve other downloads or spin the socket.
	private failedDownloads = new Set<string>();
	private failedSends = new Set<string>();
	private passes = new Set<string>();
	private newDrain() {
		this.failedDownloads.clear();
		this.failedSends.clear();
		this.passes.clear();
	}
	private scheduled = false;
	private schedule(newInput = true) {
		if (newInput) this.newDrain();
		if (this.scheduled) return;
		this.scheduled = true;
		void this.run(async () => { this.scheduled = false; if (this.synced) await this.drive({ kind: "settle" }); });
	}
	event(e: Event) {
		return this.run(async () => {
			if (!this.device) return;
			this.newDrain();
			if (this.startup && !this.synced) {
				// A returning device knows its old file IDs. Keep explicit offline moves; D13
				// cannot infer them later when several files had identical bytes.
				if (this.initialized && !await this.store.get("table/fs")) await planDisk(this.device, this.disk, this.inputs, e);
				return;
			}
			await this.drive(e);
		});
	}
	private async forget(packet: Uint8Array) {
		const f = decodeClient(packet);
		if (f.t !== "forget" || !this.ask) return;
		const req = hex(f.req);
		await this.ask(packet, a => a.t === "forgotten" && hex(a.req) === req);
		await this.device!.forgotten(req);
	}
	private async send(file: string) {
		const d = this.device!;
		// Preserve the request ID on replay. An unsent record must use the new epoch
		// after removal, even if this proposal was prepared while offline.
		await d.change(async s => {
			const p = s.pending.get(file);
			if (!p || p.request.t === "del") return;
			const f = decodeClient(p.packet);
			if ((f.t === "set" || f.t === "restore") && parseHeader(f.record).epoch !== this.keys.epoch)
				s.pending.set(file, { ...p, packet: await this.inputs.pack(p.request) });
		});
		let gone = false, missing = false;
		await d.send(file, async packet => {
			const r = decodeClient(packet);
			if (!("req" in r) || !this.ask) throw new Error("Offline");
			const f = await this.ask(packet, a => (a.t === "ok" || a.t === "refused") && hex(a.req) === hex(r.req));
			if (f.t !== "ok" && f.t !== "refused") throw new Error("Wrong attachment answer");
			const req = hex(f.req);
			const answer: Answer = f.t === "ok" ? { req, ok: f.seq } : { req, missing: f.missing, row: f.row && await this.openRow(f.row) };
			missing = f.t === "refused" && f.missing;
			gone = await d.receive(answer, this.inputs, p => this.forget(p)) === "gone";
		}, r => this.upload(r));
		return { gone, missing };
	}
	private async planAttachments(event: Event) {
		await this.open();
		if (!this.inputs.attachments) return;
		const d = this.device!;
		if (this.startup) {
			await planDisk(d,this.disk,this.inputs,{kind:"startup"},this.failedDownloads,false);
			this.startup = false;
		}
		await planDisk(d, this.disk, this.inputs, event, this.failedDownloads);
		const counts = await d.change(s => {
			const deletes: {key: string; incoming: boolean}[] = [];
			const live = new Set(s.local.keys());
			for (const [file,row] of s.latest) {
				const local = s.local.get(file);
				if (row.deleted === null) live.add(file);
				if (!local || s.blocked.has(file) || s.pending.has(file)) continue;
				const hash = s.observed.get(local.path)?.hash;
				if (!hash) continue;
				const target = local.redundant && s.latest.get(local.redundant.target);
				if (target?.deleted === null && target.bytes.h === hash && local.redundant?.hash === hash)
					deletes.push({key: `remove/${file}/${target.seq}`, incoming: true});
				else if (row.deleted !== null && local.base.bytes?.h === hash)
					deletes.push({key: `remove/${file}/${row.seq}`, incoming: true});
			}
			for (const [file,p] of s.pending) if (p.request.t === "del" && p.acceptedDelete === undefined)
				deletes.push({key: `del/${file}/${p.request.req}`, incoming:false});
			return {attachmentTotalLive:live.size, attachmentDeletes:deletes};
		});
		Object.assign(this.notes.env, counts);
	}
	private async drive(event: Event) {
		const d = this.device!, before = d.revision;
		if (this.keys.state.pending?.tokenHash) return;
		await this.planAttachments(event);
		if (this.engine && !this.noteActive) return;
		if (this.noteActive) await this.notes.input({t:"recheck"});
		const brake = this.notes.state?.brakePaused;
		if (brake?.awaiting) return;
		const held = new Set(brake?.declinedIds);
		await d.change(s => {
			if (s.intent?.kind === "remove" && held.has(`remove/${s.intent.file}/${s.intent.seq}`)) s.intent = undefined;
			for (const [file,p] of s.pending) if (p.request.t === "del" && p.acceptedDelete === undefined && held.has(`del/${file}/${p.request.req}`)) {
				s.pending.delete(file); s.local.delete(file); // The confirmed row will be materialized again.
			}
		});
		if (this.noteActive && this.synced) {
			for (const req of this.notes.state!.forget.keys()) {
				await this.request({ t: "forget", req: unhex(req) }, f => f.t === "forgotten" && hex(f.req) === req);
				await this.notes.input({ t: "forgotten", req });
			}
			for (const n of this.notes.state!.notes.values()) {
				if (n.inFlight && n.inFlight.accepted === undefined) await this.transmitNote(n.id, n.inFlight);
			}
		}
		if (!this.inputs.attachments) return;
		if (!this.synced || !this.ask) return;
		await d.sendForgets(p => this.forget(p));
		// An accepted delete waits for its ordered row. Let incoming rows run between passes.
		const files = await d.change(s => [...s.pending].filter(([, p]) => p.acceptedDelete === undefined).map(([file]) => file));
		for (const file of files) {
			if (!this.ask) break;
			if (this.failedSends.has(file)) continue;
			try { if ((await this.send(file)).missing) this.failedSends.add(file); }
			catch (e) { this.failedSends.add(file); this.problem("sending an attachment", e); }
		}
		if (await d.change(s => s.intent && !(s.intent.kind === "remove" && held.has(`remove/${s.intent.file}/${s.intent.seq}`)))) await executeIntent(d, this.disk, this.inputs, this.failedDownloads);
		await this.collectStages();
		if (await d.needsAnotherPass(before, this.passes, [this.failedDownloads, this.failedSends])) this.schedule(false);
		else this.passes.clear();
	}
	private async collectStages() {
		const held = await this.device!.change(s => {
			const ids = new Set([...s.parked.values()].map(r => r.u));
			if (s.intent?.kind === "park") ids.add(s.intent.saved.u);
			for (const p of s.pending.values()) if (p.request.t !== "del") ids.add(p.request.data.bytes.u);
			return ids;
		});
		const old = (await this.store.list("table/stage/")).map(([k]) => k.slice("table/stage/".length)).filter(u => !held.has(u));
		if (old.length) await this.store.commit(new Map(), old.flatMap(u => ["table/blob/" + u, "table/stage/" + u]));
	}
	get caughtUp() { return this.synced && this.noteActive; }

	async snapshotAttachments() {
		if (!this.caughtUp) throw new Error("Waiting for the file table");
		if (!this.inputs.attachments) return undefined;
		return this.device!.change(s => [...s.latest.values()].filter(row => row.deleted === null)
			.map(row => ({ id: row.file, path: row.path, ref: row.bytes })));
	}
	async deleted() {
		if (!this.device || !this.inputs.attachments) return [];
		return this.device.change(s => [...s.latest.values()].filter(r => r.deleted !== null && r.deleted >= Date.now() - 30 * 86400000)
			.map(r => ({ id: r.file, path: r.path, deletedAt: r.deleted! })));
	}
	restore(file: string) {
		return this.run(async () => {
			if (!this.synced || !this.ask || !this.device) return "offline";
			const d = this.device;
			const row = await d.change(s => s.latest.get(file));
			if (!row || row.deleted === null) return;
			await d.change(s => restore(s, row, this.inputs));
			while (await d.change(s => s.pending.get(file)?.request.t === "restore")) {
				if ((await this.send(file)).gone) return "gone";
			}
			this.schedule();
			return d.change(s => { const r = s.latest.get(file); return r?.deleted === null ? r.path : undefined; });
		});
	}
}
