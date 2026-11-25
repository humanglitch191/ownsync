// The encrypted connection between the sync engine and the Worker. The engine speaks in plain documents
// and updates; everything that leaves this file is sealed, and filed under an opaque tag. Every connection
// starts by reading the membership records, so a device takes in a new epoch, or learns it was removed,
// before it says hello with the epoch's token. Editors' presence (cursors) travels as live frames, but
// never reaches the engine.

import { importGenesis } from "./genesis";
import type { TableSync } from "./tableSync";
import type { Engine } from "./core/engine";
import type { ClientMsg, Entry } from "./core/ports";
import type { Stored, VaultKeys } from "./keys";
import { KIND, chunkName, docTag, hex, openEnvelope, packEntry, parseHeader, scopedChunkName, sealEnvelope, unhex, unpackEntry, versionTag } from "../../protocol/ownsync";
import { CLOSE, MARK, MAX_ENVELOPE, MAX_VERSION, SHORT_ID_BYTES, type ClientFrame, type ServerFrame, decodeServer, encodeClient } from "../../server/src/wire";

export type Status = "connecting" | "catching up" | "synced" | "offline" | "unauthorized" | "needs owner code" | "removed" | "frozen" | "deleted";

const MAX_BACKOFF_MS = 30_000;
const PRESENCE_MS = 150;
type Presence = { t: "presence"; note: string; data: Uint8Array };
const vaultUrl = (host: string, vaultId: Uint8Array) => `${host.replace(/\/$/, "").replace(/^http/, "ws")}/vault/${hex(vaultId)}`;

/** Every membership record and the sealed recovery key, without a token: what a recovering device starts from. */
export function fetchRecords(host: string, vaultId: Uint8Array): Promise<{ records: Stored[]; recovery: Uint8Array }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(vaultUrl(host, vaultId));
		ws.binaryType = "arraybuffer";
		const records: Stored[] = [];
		ws.onopen = () => ws.send(encodeClient({ t: "fetch", from: 0 }));
		ws.onmessage = (e: MessageEvent) => {
			const f = decodeServer(new Uint8Array(e.data as ArrayBuffer));
			if (f.t === "record") records.push(f);
			else if (f.t === "records") {
				resolve({ records, recovery: f.recovery });
				ws.close();
			}
		};
		ws.onclose = () => reject(new Error("the Worker closed the connection"));
		ws.onerror = () => reject(new Error("could not reach the Worker"));
	});
}

export interface TransportOptions {
	attachments?: TableSync;
	tableCapable?(): Promise<boolean>;
	/** The Worker's owner code (64 hex characters): needed only to create the vault on the Worker. */
	owner?: string;
	onStatus?(status: Status): void;
	onProblem?(what: string, err: unknown): void;
	/** Another device's presence in a note: an awareness update, still to be validated. */
	onPresence?(note: string, update: Uint8Array): void;
	/** This plugin's version, and how many conflict and recovered copies the vault has: for the owner's dashboard. */
	version?: string;
	conflicts?(): number;
}

export class Transport {
	status: Status = "offline";
	private ws: WebSocket | null = null;
	private wanted = false;
	private attempts = 0;
	private retry: number | null = null;
	private tags = new Map<string, Promise<Uint8Array>>(); // "<epoch>:<document>" → tag
	private authed = false; // this socket has said hello
	private batch: Stored[] = []; // records arriving, until the end marker
	private offered = -1; // number of the record last offered to the Worker on this socket
	private sending: Promise<void> = Promise.resolve(); // seal and send strictly in order
	private receiving: Promise<void> = Promise.resolve(); // open and deliver strictly in order
	private presenceOut = new Map<string, Uint8Array>(); // note → newest presence not yet sent
	private held: ClientMsg[] = []; // waiting for this device's own key change (see send)
	private presenceTimer: number | null = null;
	private reported = -1; // the conflict count last reported on this socket

	private negotiated = false;
	private engineConnected = false;
	private switched = false;
	private stopGenesis?: () => void;
	private waiting?: { matches: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void; reject: (err: Error) => void };
	constructor(private readonly host: string, private readonly keys: VaultKeys, private readonly engine: Engine, private readonly opts: TransportOptions = {}) {}

	async connect(): Promise<void> {
		this.wanted = true;
		if (this.ws) return;
		const ws = new WebSocket(vaultUrl(this.host, this.keys.vaultId));
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		this.authed = false; this.negotiated = false; this.engineConnected = false; this.switched = false;
		this.batch = [];
		this.held = []; // the engine sends what it still needs again on the new connection
		this.offered = -1;
		this.reported = -1;
		this.set("connecting");
		ws.onopen = () => {
			this.attempts = 0;
			ws.send(encodeClient({ t: "fetch", from: this.keys.fetchFrom() }));
		};
		ws.onmessage = (e: MessageEvent) => {
			const bytes = new Uint8Array(e.data as ArrayBuffer);
			this.receiving = this.receiving.then(() => this.receive(ws, bytes)).catch((err) => this.opts.onProblem?.("a message from the Worker", err));
		};
		ws.onclose = (e: CloseEvent) => this.closed(ws, e.code);
	}

	disconnect(): void {
		this.wanted = false;
		if (this.retry) window.clearTimeout(this.retry);
		const ws = this.ws;
		if (!ws) return;
		ws.close();
		this.closed(ws, 1000); // don't wait for the close handshake
	}

	/** Relay this device's presence in a note to the others. At most one batch per PRESENCE_MS; only the newest per note goes. */
	presence(note: string, update: Uint8Array): void {
		this.presenceOut.set(note, update);
		this.presenceTimer ??= window.setTimeout(() => {
			this.presenceTimer = null;
			const ws = this.ws;
			if (ws && this.authed) for (const [note, data] of this.presenceOut) this.send(ws, { t: "presence", note, data });
			this.presenceOut.clear();
		}, PRESENCE_MS);
	}

	/** Offers the Worker the record the keys want added. A rotation waits until this device has caught up: its snapshots must hold everything. */
	offer(): void {
		const p = this.keys.state.pending, ws = this.ws;
		if (!p || !ws || !this.authed || p.number === this.offered || (p.tokenHash && this.status !== "synced")) return;
		this.offered = p.number;
		const { number, recovery, blob, tokenHash } = p;
		ws.send(encodeClient(tokenHash ? { t: "rotate", number, tokenHash, recovery, blob } : { t: "append", number, recovery, blob }));
	}

	/**
	 * Tells the Worker this device's short ID, version and conflict count, once caught up (`now`: it just has) and again
	 * when the count changes.
	 */
	report(now = false): void {
		const ws = this.ws, conflicts = this.opts.conflicts?.() ?? 0;
		if (!ws || ws.readyState !== WebSocket.OPEN || (!now && this.status !== "synced") || conflicts === this.reported) return;
		this.reported = conflicts;
		ws.send(encodeClient({ t: "status", id: this.keys.me.id.slice(0, SHORT_ID_BYTES), conflicts, version: (this.opts.version ?? "").slice(0, MAX_VERSION) }));
	}

	private set(status: Status): void {
		if (this.status === status) return;
		this.status = status;
		this.opts.onStatus?.(status);
	}

	private closed(ws: WebSocket, code: number): void {
		if (this.ws !== ws) return;
		this.ws = null;
		this.opts.attachments?.disconnect();
		this.waiting?.reject(new Error("Attachment connection closed")); this.waiting = undefined;
		this.stopGenesis?.(); this.stopGenesis = undefined;
		void this.engine.disconnected();
		if (code === CLOSE.unauthorized || code === CLOSE.notOwner || code === CLOSE.deleted) {
			this.wanted = false;
			return this.set(code === CLOSE.notOwner ? "needs owner code" : code === CLOSE.deleted ? "deleted" : "unauthorized");
		}
		if (code === CLOSE.rekeyed) this.attempts = 0; // another device rotated: come back at once for the new key
		this.set("offline");
		if (this.wanted) this.retry = window.setTimeout(() => void this.connect().catch(() => {}), Math.min(100 * 2 ** this.attempts++, MAX_BACKOFF_MS));
	}

	/**
	 * HMAC(name key, SHA-256(data)), as hex: names a chunk, and an attachment's version, for the engine. The name
	 * key is the first epoch's, for the vault's whole life: names are how the engine recognises content, so they
	 * mustn't change when the key rotates. (A removed device keeps it, and could test, with the server's help,
	 * whether a file it already has is in the vault; it can't read anything.)
	 */
	async chunkName(data: Uint8Array, scope?: { u: string; i: number }): Promise<string> {
		const first = this.firstKey();
		return hex(await (scope ? scopedChunkName(first, this.keys.vaultId, scope.u, scope.i, data) : chunkName(first, this.keys.vaultId, data)));
	}

	/** A version's tag, which the Worker files its version-scoped chunks under: with the first epoch's key too. */
	async versionTag(u: string): Promise<string> {
		return hex(await versionTag(this.firstKey(), this.keys.vaultId, u));
	}

	private firstKey(): Uint8Array {
		const first = this.keys.keyFor(0);
		if (!first) throw new Error("this device doesn't have the vault's first key yet");
		return first;
	}

	private tag(epoch: number, vmk: Uint8Array, doc: string): Promise<Uint8Array> {
		const key = `${epoch}:${doc}`;
		let tag = this.tags.get(key);
		if (!tag) this.tags.set(key, (tag = docTag(vmk, this.keys.vaultId, doc)));
		return tag;
	}

	private send(ws: WebSocket, msg: ClientMsg | Presence): void {
		// While this device's own key change is waiting, nothing new is sealed under the old key, which a device
		// being removed (or, when recovering, every other device) can still read. Stored messages wait for the new
		// key; live ones go, since what they carry follows in the stored ones anyway. Marks wait with the chunks: a
		// retirement must not reach the Worker before the vput it follows, which would make the version current again.
		if (this.keys.state.pending?.tokenHash && msg.t !== "subscribe" && msg.t !== "get") {
			if (msg.t === "publish" || msg.t === "snapshot" || msg.t === "put" || msg.t === "mark") this.held.push(msg);
			return;
		}
		this.sending = this.sending.then(async () => {
			const frame = await this.seal(msg);
			if (this.switched && (msg.t === "put" || msg.t === "mark" || msg.t === "get" ||
				((msg.t === "live" || msg.t === "publish") && this.engine.legacyAttachment(msg.entry.doc)) ||
				(msg.t === "snapshot" && this.engine.legacyAttachment(msg.doc)))) return;
			if (frame && ws === this.ws && ws.readyState === WebSocket.OPEN) ws.send(encodeClient(frame));
		}).catch((err) => this.opts.onProblem?.("sending to the Worker", err));
	}

	private async seal(msg: ClientMsg | Presence): Promise<ClientFrame | null> {
		if (msg.t === "subscribe") return msg;
		const { vaultId, epoch, vmk } = this.keys; // whatever epoch is current when it's sealed
		// A chunk is sealed with its name as the document: the server can't file it under another one.
		if (msg.t === "get") return { t: "get", name: unhex(msg.name) };
		if (msg.t === "mark") {
			const flags = msg.state === "ask" ? 0 : msg.state === "current" ? MARK.current | (msg.start ? MARK.start : 0) | (msg.last ? MARK.last : 0) : MARK.retired | (msg.state === "deleted" ? MARK.deleted : 0);
			return { t: "mark", id: msg.id, flags, tags: msg.tags.map(unhex) };
		}
		if (msg.t === "put") {
			const name = unhex(msg.name), envelope = await sealEnvelope({ vmk, vaultId, docId: name, epoch, deviceId: this.keys.me.id, kind: KIND.chunk, plaintext: msg.data });
			return msg.tag ? { t: "vput", tag: unhex(msg.tag), name, envelope } : { t: "put", name, envelope };
		}
		const entry: Entry = msg.t === "snapshot" ? { doc: msg.doc, kind: "snapshot", data: msg.data } : msg.t === "presence" ? { doc: msg.note, kind: "update", data: msg.data } : msg.entry;
		const doc = await this.tag(epoch, vmk, entry.doc);
		const envelope = await sealEnvelope({
			vmk, vaultId, docId: doc, epoch, deviceId: this.keys.me.id,
			kind: msg.t === "presence" ? KIND.presence : entry.kind === "snapshot" ? KIND.snapshot : KIND.update,
			plaintext: packEntry(entry.doc, entry.data),
		});
		if (envelope.length > MAX_ENVELOPE) {
			// shortcut: one note's sealed state must fit in 4 MiB; split it into parts if anyone has notes that large.
			if (msg.t === "publish" || msg.t === "snapshot") this.opts.onProblem?.("a note is too large to sync (over 4 MB)", new Error(entry.doc));
			return null;
		}
		if (msg.t === "publish") return { t: "publish", id: msg.id, doc, envelope };
		if (msg.t === "snapshot") return { t: "snapshot", doc, base: msg.base, envelope };
		return { t: "live", doc, envelope };
	}

	private connectNotes(ws: WebSocket) {
		if (this.engineConnected) return;
		this.engineConnected = true;
		return this.engine.connected({send:msg => this.send(ws,msg)});
	}

	private ask(ws: WebSocket, packet: Uint8Array, matches: (f: ServerFrame) => boolean): Promise<ServerFrame> {
		return new Promise((resolve,reject) => {
			if (this.waiting || this.ws !== ws || ws.readyState !== WebSocket.OPEN || this.keys.state.pending?.tokenHash)
				return reject(new Error("Attachment connection unavailable"));
			this.waiting = {matches,resolve,reject};
			try { ws.send(packet); } catch (e) { this.waiting = undefined; reject(e); }
		});
	}

	private async receive(ws: WebSocket, bytes: Uint8Array): Promise<void> {
		if (ws !== this.ws) return;
		const f = decodeServer(bytes);
		if (this.waiting?.matches(f)) {
			const waiter = this.waiting; this.waiting = undefined; waiter.resolve(f); return;
		}
		const sync = this.opts.attachments;
		if (sync && f.t === "format") {
			try {
				if (f.table && !this.switched) {
					this.switched = true; this.stopGenesis?.();
					await this.engine.useTable(await sync.nameKey());
					const after = await sync.connect((p,match) => this.ask(ws,p,match));
					if (ws !== this.ws) return;
					ws.send(encodeClient({t:"since",after}));
				} else if (!f.table && this.engine.tableActive) throw new Error("Worker no longer holds the migrated attachment table");
				await this.connectNotes(ws);
			} catch (e) { ws.close(); throw e; }
			return;
		}
		if (sync && f.t === "migrationEligible") {
			if (f.ready && !this.switched && !this.stopGenesis && !this.keys.state.pending?.tokenHash)
				this.stopGenesis = importGenesis(vaultUrl(this.host,this.keys.vaultId),this.keys,sync,(stale,err) => {
					this.stopGenesis = undefined;
					if (err) this.opts.onProblem?.("building attachment genesis",err);
					if (stale && !this.switched && ws === this.ws) ws.send(encodeClient({t:"migrationCheck"}));
				});
			return;
		}
		if (sync && this.switched) {
			if (f.t === "row" || f.t === "tableSynced") {
				const apply = f.t === "row" ? sync.row(f.row) : sync.ready(f.seq);
				void apply.catch(() => ws.close()); return;
			}
			if (f.t === "tableMore") { ws.send(encodeClient({t:"since",after:f.seq})); return; }
			if (f.t === "stored" || f.t === "chunk" || f.t === "missing" || f.t === "marked") return;
		}
		if (f.t === "record") return void this.batch.push(f);
		if (f.t === "records") return this.records(ws);
		if (f.t === "stored" || f.t === "missing") return this.engine.receive({ t: f.t, name: hex(f.name) });
		if (f.t === "marked") return this.engine.receive({ t: "marked", id: f.id, tags: f.tags.map(hex) });
		if (f.t === "chunk") {
			// The engine checks the content against its name; an envelope that doesn't open counts as missing.
			// Chunks keep the epoch they were uploaded in (the vault document names them), so any epoch in the key ring opens one.
			const name = hex(f.name);
			const opened = await openEnvelope(f.envelope, this.keys.vaultId, f.name, this.keys.keyFor).catch(() => undefined);
			return this.engine.receive(opened?.kind === KIND.chunk ? { t: "chunk", name, data: opened.plaintext } : { t: "missing", name });
		}
		if (f.t !== "entry" && f.t !== "live") {
			if (f.t !== "more" && f.t !== "synced" && f.t !== "ack") return; // this connection uses the legacy handshake
			// Who this is goes before anything the engine sends once caught up: the Worker files its list of current versions under it.
			if (f.t === "synced") {
				this.report(true);
				if (this.negotiated && !this.switched) ws.send(encodeClient({t:"migrationCheck"}));
			}
			await this.engine.receive(f);
			if (f.t === "synced") {
				this.set("synced");
				this.report();
				this.offer();
				if (this.keys.state.resnapshot) await this.resnapshot();
			}
			return;
		}
		// Sealed before a rotation this device accepted. The rotation's snapshots hold what came before it, and
		// accepting these would let a removed device, with the server's help, slip in edits under the old key.
		if (parseHeader(f.envelope).epoch < this.keys.epoch) return;
		// Fails if the envelope was altered, or filed under another document's tag.
		const { kind, plaintext } = await openEnvelope(f.envelope, this.keys.vaultId, f.doc, this.keys.keyFor);
		const { docId, update } = unpackEntry(plaintext);
		if (kind === KIND.presence && f.t === "live") return this.opts.onPresence?.(docId, update);
		// Anything else (presence replayed as a stored entry, say) must not reach the engine as a document update.
		if (kind !== KIND.update && kind !== KIND.snapshot) throw new Error(`unexpected envelope kind ${kind}`);
		const entry: Entry = { doc: docId, kind: kind === KIND.snapshot ? "snapshot" : "update", data: update };
		await this.engine.receive(f.t === "entry" ? { t: "entry", seq: f.seq, entry } : { t: "live", entry });
	}

	private async records(ws: WebSocket): Promise<void> {
		const batch = this.batch;
		this.batch = [];
		await this.keys.receive(batch);
		if (ws !== this.ws) return;
		if (!this.keys.state.pending?.tokenHash && this.held.length) {
			const held = this.held;
			this.held = [];
			for (const msg of held) this.send(ws, msg);
		}
		const k = this.keys.state;
		if (k.removed || k.fork) {
			this.disconnect(); // stop publishing until the user has seen it
			return this.set(k.removed ? "removed" : "frozen");
		}
		if (!this.authed) {
			// Joined after a rotation: first the older keys, which attachments uploaded before then are sealed with.
			if (this.keys.missingOlder) await fetchRecords(this.host, this.keys.vaultId).then(({ records }) => this.keys.learnOlder(records)).catch((err) => this.opts.onProblem?.("fetching older keys", err));
			if (ws !== this.ws) return;
			const token = await this.keys.token();
			if (ws !== this.ws) return;
			try {
				this.negotiated = !!this.opts.attachments && (this.engine.tableActive || !!await this.opts.tableCapable?.());
			} catch (e) { ws.close(); throw e; }
			if (ws !== this.ws) return;
			this.authed = true;
			// The owner code goes along only when this device is creating the vault (see main.ts).
			ws.send(encodeClient(this.opts.owner ? { t: "hello", token, owner: unhex(this.opts.owner) } : { t: "hello", token }));
			this.set("catching up");
			if (this.negotiated) ws.send(encodeClient({t:"table"}));
			else await this.connectNotes(ws);
		}
		this.offer();
		if (k.resnapshot && this.status === "synced") await this.resnapshot();
	}

	// After taking in a new epoch, every device sends all it holds under it: the rotating device's snapshots
	// lack whatever other devices wrote under the old key that it hadn't seen.
	private async resnapshot(): Promise<void> {
		if (!(await this.engine.snapshotAll())) return;
		await this.sending;
		await this.keys.snapshotted();
	}
}
