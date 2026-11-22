// Ownsync Worker: one Durable Object per vault, a mailbox of sealed envelopes relayed over hibernating
// WebSockets. It never opens an envelope. It keeps, per document, the latest snapshot a device uploaded
// and the updates since, so its storage stays near the size of the vault, not of its history. Attachment
// chunks are kept apart, once per name.

import { DurableObject } from "cloudflare:workers";
import { Dashboard, VERSION, type VaultStats } from "./dashboard";
import { SNAPSHOT_BUDGET, snapshotsToPrune } from "./snapshots";
import { CHUNK_OVERHEAD, CLOSE, type ClientFrame, DOC_TAG_BYTES, MAX_CHUNK, MAX_ENVELOPE, MAX_RECORD, RECOVERY_SEALED, type ServerFrame, decodeClient, encodeServer } from "./wire";

interface Env {
	VAULT: DurableObjectNamespace<Vault>;
	PAIRING: DurableObjectNamespace<Pairing>;
	OWNER: DurableObjectNamespace<Owner>;
	/** Chosen by the owner at deploy time: signs in to add the first passkey, in the first minutes after deploy. */
	SETUP_KEY?: string;
	/** When this version was deployed (changing a secret makes a new version). */
	CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };
}

const MIN_SETUP_KEY = 12;

// token: hex hash of the token this socket said hello with; null before hello. device: the short ID its status gave.
type Session = { token: string | null; live: boolean; device?: string };
const toHex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
type Row = { seq: number; doc: ArrayBuffer; snapshot: number; envelope: ArrayBuffer };

// One catch-up page. Small enough to stay well inside a Worker's time and memory for one event.
const PAGE_ROWS = 400;
const PAGE_BYTES = 4 * 1024 * 1024;
// Devices kept for the dashboard, and how often the day's counters are written (each write is itself a row).
const MAX_DEVICES = 64;
const FLUSH_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// How many days of usage the dashboard shows.
const HISTORY_DAYS = 14;
const MAX_HISTORY_ENVELOPE = 1024 * 1024 + CHUNK_OVERHEAD;
const MAX_HISTORY_BYTES = 50 * 1024 * 1024;
const HISTORY_RETENTION_MS = 30 * DAY_MS;
const SNAPSHOT_ID_BYTES = 16;
const SNAPSHOT_PART_HEADER = SNAPSHOT_ID_BYTES + 4;
const MAX_SNAPSHOT_PARTS = 512;
const MAX_SNAPSHOT_ENVELOPE = 1024 * 1024 + 256; // a full 1 MiB part, sealed: its header, the envelope header and the tag (87 bytes today), with room to spare
const MAX_SNAPSHOT = SNAPSHOT_BUDGET / 8;
const SNAPSHOT_LEASE_MS = 60 * 60 * 1000;
type VaultSnapshot = { id: number; day: number; parts: number; received: number; size: number };

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		// The vault name is an opaque ID (hex of a hash), never the vault's real name.
		const url = new URL(req.url), path = url.pathname;
		// The setup key, typed on the dashboard (the site's front page, a static asset) to add the first passkey.
		// The browser sends a hash of it bound to this address, never the key itself.
		if (path === "/api/setup") {
			const key = setupKeyOk(env) ? await digest(env.SETUP_KEY!) : null;
			const deployed = Date.parse(env.CF_VERSION_METADATA?.timestamp ?? "") || 0; // missing: the window is long shut
			if (req.method !== "POST" || req.headers.get("origin") !== url.origin) return Response.json({ error: "wrong origin" }, { status: 403 });
			if (!key) return Response.json({ error: "no setup key" }, { status: 503 });
			const proof = await req.text();
			if (proof.length > 1024) return Response.json({ error: "wrong key" }, { status: 400 });
			const expected = hex(await digest(`ownsync-setup\n${url.origin}\n${env.SETUP_KEY}`));
			// Wrong tries are counted per connection, so a stranger's guesses lock out only the stranger. Kept as a hash
			// keyed with the setup key, never the address itself.
			const who = await digest(`${hex(key)}\n${network(req.headers.get("CF-Connecting-IP"))}`);
			const result = await owner(env).setup(await digest(proof), await digest(expected), key, who, deployed, url.origin);
			const status = { locked: 429, "wrong key": 403, expired: 410, used: 409 }[result.error ?? ""] ?? 200;
			return Response.json(result, { status, headers: { "cache-control": "no-store" } });
		}
		// The owner dashboard's API; its pages are static assets.
		if (path.startsWith("/api/")) return owner(env).fetch(req);
		const vault = path.match(/^\/vault\/([0-9a-f]{32})(?:\/delete|\/names|\/history(?:\/list|\/clear)?|\/snapshot(?:\/list|\/get|\/delete)?)?$/);
		if (vault) return env.VAULT.get(env.VAULT.idFromName(vault[1]!)).fetch(req);
		// The room is a hash of the pairing code, so the server can't open what it holds.
		const pair = path.match(/^\/pair\/([0-9a-f]{32})$/);
		if (pair) return env.PAIRING.get(env.PAIRING.idFromName(pair[1]!)).fetch(req);
		return new Response("not found", { status: 404 });
	},
};

export class Vault extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;
	private head: number;
	private token: string | null; // hex hash of the vault's current auth token; null until the first hello
	private name: string | null = null; // this vault's ID (32 hex), from the first request's URL
	private deleted: boolean;
	// Today's counters for the dashboard's free-plan meter, kept in memory and written at most once a minute.
	private usage: { day: number; requests: number; rows: number; lastActivity: number | null };
	private flushedAt = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// seq is assigned here, not by AUTOINCREMENT (which costs a second row write per entry). It only ever
		// grows: a snapshot is inserted before the entries it replaces are deleted.
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, doc BLOB NOT NULL, snapshot INTEGER NOT NULL, envelope BLOB NOT NULL);
			CREATE INDEX IF NOT EXISTS entries_doc ON entries (doc, seq);
			CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 0), token_hash BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS records (number INTEGER PRIMARY KEY, blob BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY CHECK (id = 0), sealed BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS chunks (name BLOB PRIMARY KEY, envelope BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, doc BLOB NOT NULL, at INTEGER NOT NULL, size INTEGER NOT NULL, envelope BLOB NOT NULL);
			CREATE INDEX IF NOT EXISTS history_doc ON history (doc, at);
			CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot BLOB NOT NULL UNIQUE, day INTEGER NOT NULL UNIQUE, at INTEGER NOT NULL, epoch INTEGER NOT NULL, parts INTEGER NOT NULL, received INTEGER NOT NULL, size INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS snapshot_parts (snapshot BLOB NOT NULL REFERENCES snapshots(snapshot) ON DELETE CASCADE, part INTEGER NOT NULL, count INTEGER NOT NULL, day INTEGER NOT NULL, at INTEGER NOT NULL, size INTEGER NOT NULL, envelope BLOB NOT NULL, PRIMARY KEY (snapshot, part));
			CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, last_online INTEGER NOT NULL, version TEXT NOT NULL, conflicts INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK (id = 0), day INTEGER NOT NULL, requests INTEGER NOT NULL, rows INTEGER NOT NULL, last_activity INTEGER);
			CREATE TABLE IF NOT EXISTS usage_days (day INTEGER PRIMARY KEY, requests REAL NOT NULL, rows INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS tombstone (id INTEGER PRIMARY KEY CHECK (id = 0), at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS vault_name (id INTEGER PRIMARY KEY CHECK (id = 0), name TEXT NOT NULL);
		`);
		// Added in 0.1.2: a device's name, as Obsidian has it. Vaults made earlier get the column now.
		if (!this.sql.exec<{ name: string }>("PRAGMA table_info(devices)").toArray().some((c) => c.name === "name")) this.sql.exec("ALTER TABLE devices ADD COLUMN name TEXT NOT NULL DEFAULT ''");
		this.head = this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM entries").one().seq;
		const auth = this.sql.exec<{ token_hash: ArrayBuffer }>("SELECT token_hash FROM auth").toArray()[0];
		this.token = auth ? toHex(auth.token_hash) : null;
		this.deleted = this.sql.exec("SELECT 1 FROM tombstone").toArray().length > 0;
		const u = this.sql.exec<{ day: number; requests: number; rows: number; last_activity: number | null }>("SELECT day, requests, rows, last_activity FROM usage").toArray()[0];
		this.usage = u ? { day: u.day, requests: u.requests, rows: u.rows, lastActivity: u.last_activity } : { day: today(), requests: 0, rows: 0, lastActivity: null };
	}

	async fetch(req: Request): Promise<Response> {
		const [, , id, action, operation] = new URL(req.url).pathname.split("/");
		this.name ??= id ?? null;
		this.count(1);
		if (action) {
			if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
			if (this.deleted) return Response.json({ error: "deleted" }, { status: 410 });
			const limit = action === "history" ? DOC_TAG_BYTES + (operation ? 0 : MAX_HISTORY_ENVELOPE)
				: action === "snapshot" ? (operation === "list" ? 0 : operation ? SNAPSHOT_ID_BYTES : SNAPSHOT_PART_HEADER + MAX_SNAPSHOT_ENVELOPE)
				: undefined;
			const body = limit !== undefined
				? await this.readBoundedBody(req, 32 + limit)
				: new Uint8Array(await req.arrayBuffer());
			const token = action === "delete" ? body : body.subarray(0, 32);
			const hash = await digest(token);
			if (this.deleted) return Response.json({ error: "deleted" }, { status: 410 });
			const stored = this.sql.exec<{ token_hash: ArrayBuffer }>("SELECT token_hash FROM auth").toArray()[0]?.token_hash;
			if (!stored || token.length !== 32 || !crypto.subtle.timingSafeEqual(hash, stored)) return Response.json({ error: "unauthorized" }, { status: 401 });
			if (action === "history") return this.history(operation, body.subarray(32));
			if (action === "snapshot") return this.snapshot(operation, body.subarray(32));
			if (action === "names") {
				if (body.length > 32 + 1024) return Response.json({ error: "too large" }, { status: 413 });
				let n: { device?: unknown; name?: unknown; vault?: unknown };
				try { n = JSON.parse(new TextDecoder().decode(body.slice(32))); } catch { return Response.json({ error: "bad names" }, { status: 400 }); }
				// No control characters: kept to printable text.
				const clean = (x: unknown) => (typeof x === "string" ? Array.from(x).filter((c) => c >= " " && c !== "\u007f").join("").trim().slice(0, 40) : "");
				const device = typeof n.device === "string" && /^[0-9A-F]{8}$/.test(n.device) ? n.device : null;
				if (device) this.write("INSERT INTO devices (id, last_online, version, conflicts, name) VALUES (?, ?, '', 0, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name", device, Date.now(), clean(n.name));
				if (typeof n.vault === "string") this.write("INSERT OR REPLACE INTO vault_name (id, name) VALUES (0, ?)", clean(n.vault));
				// And in reply, which Ownsync this Worker runs and the newest release, so the plugin can say when either is behind.
				const latest = await (owner(this.env) as unknown as { latest(): Promise<string | null> }).latest().catch(() => null);
				return Response.json({ ok: true, worker: VERSION, latest });
			}
			await this.erase();
			return Response.json({ deleted: true });
		}
		if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ token: null, live: false } satisfies Session);
		return new Response(null, { status: 101, webSocket: client });
	}

	private async readBoundedBody(req: Request, limit: number): Promise<Uint8Array> {
		const reader = req.body?.getReader();
		if (!reader) return new Uint8Array(0);
		// Keep one extra byte so validation can reject an oversized body after checking its token.
		const parts: Uint8Array[] = [];
		let length = 0;
		while (length <= limit) {
			const { done, value } = await reader.read();
			if (done) break;
			const part = value.subarray(0, limit + 1 - length);
			parts.push(part);
			length += part.length;
		}
		const body = new Uint8Array(length);
		let offset = 0;
		for (const part of parts) {
			body.set(part, offset);
			offset += part.length;
		}
		if (length > limit) void reader.cancel().catch(() => {});
		return body;
	}

	private history(operation: string | undefined, body: Uint8Array): Response {
		if (operation && body.length !== DOC_TAG_BYTES && !(operation === "clear" && body.length === 0)) {
			return Response.json({ error: "bad document tag" }, { status: 400 });
		}
		const doc = body.subarray(0, DOC_TAG_BYTES);
		if (operation === "clear") {
			if (doc.length) this.write("DELETE FROM history WHERE doc = ?", doc);
			else this.write("DELETE FROM history");
			return Response.json({ ok: true });
		}

		const now = Date.now();
		if (operation === "list") {
			this.write("DELETE FROM history WHERE at < ?", now - HISTORY_RETENTION_MS);
			const rows = this.sql.exec<{ envelope: ArrayBuffer }>("SELECT envelope FROM history WHERE doc = ? ORDER BY at DESC, id DESC LIMIT 200", doc).toArray();
			return new Response(new ReadableStream<Uint8Array>({
				pull(controller) {
					const row = rows.shift();
					if (!row) { controller.close(); return; }
					const length = new Uint8Array(4);
					new DataView(length.buffer).setUint32(0, row.envelope.byteLength);
					controller.enqueue(length);
					controller.enqueue(new Uint8Array(row.envelope));
				},
			}), { headers: { "content-type": "application/octet-stream" } });
		}

		const envelope = body.subarray(DOC_TAG_BYTES);
		if (!envelope.length || envelope.length > MAX_HISTORY_ENVELOPE) return Response.json({ error: "bad envelope size" }, { status: 413 });
		this.ctx.storage.transactionSync(() => {
			this.write("INSERT INTO history (doc, at, size, envelope) VALUES (?, ?, ?, ?)", doc, now, envelope.length, envelope);
			this.write("DELETE FROM history WHERE at < ?", now - HISTORY_RETENTION_MS);
			const { size } = this.sql.exec<{ size: number }>("SELECT COALESCE(SUM(size), 0) AS size FROM history").one();
			if (size > MAX_HISTORY_BYTES) {
				// Keep the newest rows that fit. The ID breaks ties when copies arrive in the same millisecond.
				this.write(`DELETE FROM history WHERE id IN (
					SELECT id FROM (SELECT id, SUM(size) OVER (ORDER BY at DESC, id DESC) AS retained FROM history)
					WHERE retained > ?
				)`, MAX_HISTORY_BYTES);
			}
		});
		return Response.json({ ok: true });
	}

	private expireSnapshots(now: number): void {
		this.write("DELETE FROM snapshots WHERE received < parts AND at <= ?", now - SNAPSHOT_LEASE_MS);
	}

	private snapshot(operation: string | undefined, body: Uint8Array, now = Date.now()): Response {
		this.expireSnapshots(now);
		if (!operation) return this.uploadSnapshot(body, now);
		if (operation === "list") {
			if (body.length) return Response.json({ error: "bad body" }, { status: 400 });
			const rows = this.sql.exec<{ id: string; day: number; epoch: number; parts: number; received: number; size: number; complete: number; at: number }>(
				"SELECT lower(hex(snapshot)) AS id, day, epoch, parts, received, size, received = parts AS complete, at FROM snapshots ORDER BY day DESC",
			).toArray();
			return Response.json(rows.map((row) => ({ ...row, complete: !!row.complete })));
		}
		if (operation === "delete" && body.length === 0) {
			this.write("DELETE FROM snapshots");
			return Response.json({ ok: true });
		}
		if (body.length !== SNAPSHOT_ID_BYTES) return Response.json({ error: "bad snapshot ID" }, { status: 400 });
		if (operation === "delete") {
			this.write("DELETE FROM snapshots WHERE snapshot = ?", body);
			return Response.json({ ok: true });
		}
		const saved = this.storedSnapshot(body);
		if (!saved || saved.received < saved.parts) return Response.json({ error: "not found" }, { status: 404 });
		return this.streamSnapshot(saved);
	}

	private storedSnapshot(snapshot: Uint8Array): VaultSnapshot | undefined {
		return this.sql.exec<VaultSnapshot>("SELECT id, day, parts, received, size FROM snapshots WHERE snapshot = ?", snapshot).toArray()[0];
	}

	private uploadSnapshot(body: Uint8Array, now: number): Response {
		if (body.length < SNAPSHOT_PART_HEADER) return Response.json({ error: "bad part header" }, { status: 400 });
		const snapshot = body.subarray(0, SNAPSHOT_ID_BYTES);
		const header = new DataView(body.buffer, body.byteOffset, body.length);
		const part = header.getUint16(SNAPSHOT_ID_BYTES);
		const parts = header.getUint16(SNAPSHOT_ID_BYTES + 2);
		if (parts < 1 || parts > MAX_SNAPSHOT_PARTS || part >= parts) return Response.json({ error: "bad part index or count" }, { status: 400 });
		const envelope = body.subarray(SNAPSHOT_PART_HEADER);
		if (!envelope.length || envelope.length > MAX_SNAPSHOT_ENVELOPE) return Response.json({ error: "bad envelope size" }, { status: 413 });

		const saved = this.storedSnapshot(snapshot);
		const today = Math.floor(now / DAY_MS);
		const day = saved?.day ?? today;
		if (!saved && part !== 0) return Response.json({ error: "restart" }, { status: 409 });
		if (!saved && this.sql.exec("SELECT 1 FROM snapshots WHERE day = ?", day).toArray().length) return Response.json({ error: "taken" }, { status: 409 });
		if (saved && parts !== saved.parts) return Response.json({ error: "part count changed" }, { status: 409 });
		if (saved) {
			const stored = this.sql.exec<{ envelope: ArrayBuffer }>("SELECT envelope FROM snapshot_parts WHERE snapshot = ? AND part = ?", snapshot, part).toArray()[0];
			if (stored) {
				if (envelope.length !== stored.envelope.byteLength || !crypto.subtle.timingSafeEqual(envelope, stored.envelope)) return Response.json({ error: "part changed" }, { status: 409 });
				if (saved.received < parts) this.write("UPDATE snapshots SET at = ? WHERE id = ?", now, saved.id);
				return Response.json({ ok: true, day, complete: saved.received === parts });
			}
		}
		const size = (saved?.size ?? 0) + envelope.length;
		if (size > MAX_SNAPSHOT) return Response.json({ error: "snapshot too large" }, { status: 413 });
		const received = (saved?.received ?? 0) + 1;
		const complete = received === parts;
		const rows = this.sql.exec<{ id: number; day: number; size: number; complete: number }>(
			"SELECT id, day, size, received = parts AS complete FROM snapshots",
		).toArray();
		const prune = new Set(snapshotsToPrune(rows, today, envelope.length));
		const retainedBytes = rows.reduce((sum, row) => sum + (prune.has(row) ? 0 : row.size), envelope.length);
		if (retainedBytes > SNAPSHOT_BUDGET) return Response.json({ error: "snapshot storage full" }, { status: 413 });
		if (complete) {
			const finished = { id: saved?.id ?? 0, day, size, complete: 1 };
			const remaining = rows.filter((row) => row.id !== saved?.id && !prune.has(row));
			for (const row of snapshotsToPrune([...remaining, finished], today)) {
				if (row !== finished) prune.add(row);
			}
		}
		this.ctx.storage.transactionSync(() => {
			for (const row of prune) this.write("DELETE FROM snapshots WHERE id = ?", row.id);
			if (saved) {
				this.write("UPDATE snapshots SET received = ?, size = ?, at = ? WHERE id = ?", received, size, now, saved.id);
			} else {
				// The clear header starts with version, suite and kind, then the four-byte epoch.
				const epoch = envelope.length >= 7 ? header.getUint32(SNAPSHOT_PART_HEADER + 3) : 0;
				this.write("INSERT INTO snapshots (snapshot, day, at, epoch, parts, received, size) VALUES (?, ?, ?, ?, ?, ?, ?)", snapshot, day, now, epoch, parts, received, size);
			}
			this.write("INSERT INTO snapshot_parts (snapshot, part, count, day, at, size, envelope) VALUES (?, ?, ?, ?, ?, ?, ?)", snapshot, part, parts, day, now, envelope.length, envelope);
		});
		return Response.json({ ok: true, day, complete });
	}

	private streamSnapshot(saved: VaultSnapshot): Response {
		let part = 0;
		return new Response(new ReadableStream<Uint8Array>({
			pull: (controller) => {
				// The row ID pins the download to this upload, even if the client deletes and reuses its snapshot ID.
				const row = this.deleted ? undefined : this.sql.exec<{ envelope: ArrayBuffer }>(
					"SELECT envelope FROM snapshot_parts WHERE snapshot = (SELECT snapshot FROM snapshots WHERE id = ?) AND part = ?", saved.id, part,
				).toArray()[0];
				if (!row) return controller.error(new Error("snapshot removed during download"));
				const frame = new Uint8Array(6);
				const header = new DataView(frame.buffer);
				header.setUint16(0, part);
				header.setUint32(2, row.envelope.byteLength);
				controller.enqueue(frame);
				controller.enqueue(new Uint8Array(row.envelope));
				if (++part === saved.parts) controller.close();
			},
		}), { headers: { "content-type": "application/octet-stream" } });
	}

	async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string): Promise<void> {
		if (typeof msg === "string" || msg.byteLength < 1 || msg.byteLength > MAX_ENVELOPE + 64) return ws.close(CLOSE.badMessage, "bad frame");
		const session = ws.deserializeAttachment() as Session;
		this.count(1 / 20); // Cloudflare bills incoming WebSocket messages at 20 to one request
		// Not asked for an owner code: the vault must not be created again.
		if (this.deleted) return ws.close(CLOSE.deleted, "this vault was deleted");
		try {
			const f = decodeClient(new Uint8Array(msg));
			// Records are sealed, and a device whose token a rotation replaced, or a recovering device with no
			// token at all, needs them to find the new key.
			if (f.t === "fetch") return this.sendRecords(ws, f.from);
			// Not said hello yet, or said it with a token that a rotation has replaced since.
			if (session.token === null || session.token !== this.token) {
				if (f.t !== "hello" || f.token.length !== 32) return ws.close(CLOSE.unauthorized, "unauthorized");
				// Held while it awaits the owner object, or the device's next frames would arrive before it is let in.
				const refused = await this.ctx.blockConcurrencyWhile(() => this.admit(f.token, f.owner));
				if (refused) return ws.close(refused, refused === CLOSE.notOwner ? "owner code needed" : "unauthorized");
				// History copies expire after 30 days even in a vault where nobody opens history.
				this.write("DELETE FROM history WHERE at < ?", Date.now() - HISTORY_RETENTION_MS);
				this.expireSnapshots(Date.now());
				return ws.serializeAttachment({ ...session, token: this.token });
			}
			if (f.t === "subscribe") return this.subscribe(ws, session, f.after);
			if (f.t === "hello") return this.expireSnapshots(Date.now());
			if (f.t === "append" || f.t === "rotate") return this.append(ws, f);
			if (f.t === "status") return this.status(ws, session, f);
			if (f.t === "get") {
				const row = this.sql.exec<{ envelope: ArrayBuffer }>("SELECT envelope FROM chunks WHERE name = ?", f.name).toArray()[0];
				return ws.send(encodeServer(row ? { t: "chunk", name: f.name, envelope: new Uint8Array(row.envelope) } : { t: "missing", name: f.name }));
			}
			if (f.envelope.length === 0) return ws.close(CLOSE.badMessage, "empty envelope");
			if (f.t === "put") {
				if (f.envelope.length > MAX_CHUNK + CHUNK_OVERHEAD) return ws.close(CLOSE.badMessage, "chunk too large");
				// The name is a keyed hash of the content, so the same name is the same chunk: stored once.
				try {
					this.write("INSERT OR IGNORE INTO chunks (name, envelope) VALUES (?, ?)", f.name, f.envelope);
				} catch {
					return ws.send(encodeServer({ t: "missing", name: f.name })); // storage full: the device retries later
				}
				return ws.send(encodeServer({ t: "stored", name: f.name }));
			}
			if (f.t === "live") return this.others(ws, { t: "live", doc: f.doc, envelope: f.envelope });
			if (f.t === "publish") {
				const seq = ++this.head;
				this.write("INSERT INTO entries (seq, doc, snapshot, envelope) VALUES (?, ?, 0, ?)", seq, f.doc, f.envelope);
				this.usage.lastActivity = Date.now();
				ws.send(encodeServer({ t: "ack", id: f.id, seq }));
				return this.others(ws, { t: "entry", seq, doc: f.doc, snapshot: false, envelope: f.envelope });
			}
			// A snapshot holds everything its sender had applied for the document, which is every entry up to
			// `base`: those entries can go. It takes a place in the sequence like any entry, so every device that
			// hasn't read past it receives it.
			if (f.base > this.head) return;
			this.write("INSERT INTO entries (seq, doc, snapshot, envelope) VALUES (?, ?, 1, ?)", ++this.head, f.doc, f.envelope);
			this.write("DELETE FROM entries WHERE doc = ? AND seq <= ?", f.doc, f.base);
			this.usage.lastActivity = Date.now();
		} catch {
			ws.close(CLOSE.badMessage, "bad message");
		}
	}

	// Complete the close handshake, or the client waits for it.
	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		// Last online is the Worker's own record of the connection, never the device's word.
		const device = (ws.deserializeAttachment() as Session).device;
		if (device && !this.deleted) this.write("UPDATE devices SET last_online = ? WHERE id = ?", Date.now(), device);
		// The last device going: write the counts now, as the object may sleep before the next minute is up.
		if (!this.deleted && this.ctx.getWebSockets().length <= 1) this.flush();
		try { ws.close(code === 1000 || code >= 3000 ? code : 1000, "closing"); } catch { /* already closed */ }
	}

	// The first hello sets the vault's token, and only with the Worker's owner code. Returns a close code, or 0.
	private async admit(token: Uint8Array, ownerCode: Uint8Array | undefined): Promise<number> {
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", token));
		if (!this.sql.exec("SELECT 1 FROM auth").toArray().length) {
			if (!ownerCode || !(await owner(this.env).create(ownerCode).catch(() => false))) return CLOSE.notOwner;
			this.write("INSERT OR IGNORE INTO auth (id, token_hash) VALUES (0, ?)", hash);
			if (this.name) await owner(this.env).vaultCreated(this.name);
		}
		const stored = this.sql.exec<{ token_hash: ArrayBuffer }>("SELECT token_hash FROM auth").one().token_hash;
		this.token = toHex(stored);
		return crypto.subtle.timingSafeEqual(hash, stored) ? 0 : CLOSE.unauthorized;
	}

	private others(from: WebSocket, frame: ServerFrame): void {
		const bytes = encodeServer(frame);
		for (const ws of this.ctx.getWebSockets()) {
			const s = ws.deserializeAttachment() as Session;
			if (ws !== from && s.live && s.token === this.token) ws.send(bytes);
		}
	}

	// Membership records are opaque here. They are kept strictly in order, first come first served, so two
	// devices adding one at once can't fork the log: the slower one gets the winner's record back and tries
	// again. Devices check the chain themselves.
	private append(ws: WebSocket, f: Extract<ClientFrame, { t: "append" | "rotate" }>): void {
		const next = this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(number) + 1, 0) AS n FROM records").one().n;
		if (f.number === next && f.blob.length > 0 && f.blob.length <= MAX_RECORD && (f.recovery.length === 0 || f.recovery.length === RECOVERY_SEALED)) {
			this.write("INSERT INTO records (number, blob) VALUES (?, ?)", f.number, f.blob);
			if (f.recovery.length) this.write("INSERT OR REPLACE INTO recovery (id, sealed) VALUES (0, ?)", f.recovery);
			if (f.t === "rotate") {
				// Authorised by the current token (this socket's hello). Every other socket, the removed device's
				// included, has to come back with the new one.
				this.write("UPDATE auth SET token_hash = ?", f.tokenHash);
				this.token = toHex(f.tokenHash);
				ws.serializeAttachment({ ...(ws.deserializeAttachment() as Session), token: this.token });
				for (const other of this.ctx.getWebSockets()) if (other !== ws) other.close(CLOSE.rekeyed, "the vault key changed");
			} else {
				for (const other of this.ctx.getWebSockets()) {
					if (other !== ws && (other.deserializeAttachment() as Session).token === this.token) this.sendRecords(other, f.number);
				}
			}
		}
		this.sendRecords(ws, f.number);
	}

	// One short ID per connection, so a device can't fill the list from one socket; the newest MAX_DEVICES are kept.
	private status(ws: WebSocket, session: Session, f: Extract<ClientFrame, { t: "status" }>): void {
		const id = toHex(f.id).toUpperCase();
		if (session.device && session.device !== id) return;
		if (!session.device) ws.serializeAttachment({ ...session, device: id });
		// An upsert, not a replace: the device's name (sent separately) stays.
		this.write("INSERT INTO devices (id, last_online, version, conflicts) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_online = excluded.last_online, version = excluded.version, conflicts = excluded.conflicts", id, Date.now(), f.version, f.conflicts);
		this.write("DELETE FROM devices WHERE id NOT IN (SELECT id FROM devices ORDER BY last_online DESC LIMIT ?)", MAX_DEVICES);
	}

	/** What the owner's dashboard shows of this vault: nothing a key would be needed for. */
	async stats(): Promise<VaultStats> {
		const online = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Session).device));
		const fresh = this.usage.day === today();
		const devices = this.sql.exec<{ id: string; last_online: number; version: string; conflicts: number; name: string }>("SELECT id, last_online, version, conflicts, name FROM devices ORDER BY last_online DESC").toArray();
		// Earlier days as written; today as it stands in memory.
		const days = new Map(this.sql.exec<{ day: number; requests: number; rows: number }>("SELECT day, requests, rows FROM usage_days WHERE day > ?", today() - HISTORY_DAYS).toArray().map((d) => [d.day, d]));
		if (fresh && !this.deleted) days.set(this.usage.day, { day: this.usage.day, requests: this.usage.requests, rows: this.usage.rows });
		return {
			bytes: this.sql.databaseSize,
			requestsToday: fresh ? this.usage.requests : 0,
			rowsWrittenToday: fresh ? this.usage.rows : 0,
			history: [...days.values()].sort((a, b) => a.day - b.day),
			lastActivity: this.usage.lastActivity,
			name: this.sql.exec<{ name: string }>("SELECT name FROM vault_name").toArray()[0]?.name ?? "",
			deleted: this.deleted,
			devices: devices.map((d) => {
				// A device reports "<version> mobile notes-only": its plugin version, then what kind of device it is.
				const [version = "", ...flags] = d.version.split(" ");
				return { id: d.id, name: d.name, lastOnline: d.last_online, online: online.has(d.id), version, conflicts: d.conflicts, mobile: flags.includes("mobile"), notesOnly: flags.includes("notes-only") };
			}),
		};
	}

	// Everything goes but a tombstone, so the vault can't be created again with an owner code and its devices
	// are told it was deleted instead of being asked for one.
	private async erase(): Promise<void> {
		for (const table of ["entries", "auth", "records", "recovery", "chunks", "history", "snapshot_parts", "snapshots", "devices", "usage", "usage_days", "vault_name"]) this.sql.exec(`DELETE FROM ${table}`);
		this.sql.exec("INSERT OR REPLACE INTO tombstone (id, at) VALUES (0, ?)", Date.now());
		this.deleted = true;
		this.token = null;
		this.head = 0;
		this.usage = { day: today(), requests: 0, rows: 0, lastActivity: null };
		for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE.deleted, "this vault was deleted");
		if (this.name) await owner(this.env).vaultDeleted(this.name);
	}

	private write(query: string, ...args: unknown[]): void {
		this.count(0, this.sql.exec(query, ...args).rowsWritten);
	}

	// A pending timer keeps the object from hibernating, so the counts reach storage before it leaves memory.
	private count(requests: number, rows = 0): void {
		if (this.deleted) return;
		if (this.usage.day !== today()) this.usage = { ...this.usage, day: today(), requests: 0, rows: 0 };
		this.usage.requests += requests;
		this.usage.rows += rows;
		// Written along with the activity, at most once a minute: a timer would keep the object awake, and
		// awake time counts against the free plan. Counts since the last write can be lost if it's evicted.
		if (Date.now() - this.flushedAt >= FLUSH_MS) this.flush();
	}

	private flush(): void {
		this.flushedAt = Date.now();
		const u = this.usage;
		u.rows += 2; // these writes
		this.sql.exec("INSERT OR REPLACE INTO usage (id, day, requests, rows, last_activity) VALUES (0, ?, ?, ?, ?)", u.day, u.requests, u.rows, u.lastActivity);
		// The last two weeks, day by day, for the dashboard's activity bars.
		this.sql.exec("INSERT OR REPLACE INTO usage_days (day, requests, rows) VALUES (?, ?, ?)", u.day, u.requests, u.rows);
		this.sql.exec("DELETE FROM usage_days WHERE day <= ?", u.day - HISTORY_DAYS);
	}

	private sendRecords(ws: WebSocket, from: number): void {
		for (const r of this.sql.exec<{ number: number; blob: ArrayBuffer }>("SELECT number, blob FROM records WHERE number >= ? ORDER BY number", from)) {
			ws.send(encodeServer({ t: "record", number: r.number, blob: new Uint8Array(r.blob) }));
		}
		const recovery = this.sql.exec<{ sealed: ArrayBuffer }>("SELECT sealed FROM recovery").toArray()[0];
		ws.send(encodeServer({ t: "records", recovery: recovery ? new Uint8Array(recovery.sealed) : new Uint8Array(0) }));
	}

	// One page of what the device is missing. No await in here, so nothing is published in the middle of it.
	private subscribe(ws: WebSocket, session: Session, after: number): void {
		let rows = 0, bytes = 0, last = after;
		for (const r of this.sql.exec<Row>("SELECT seq, doc, snapshot, envelope FROM entries WHERE seq > ? ORDER BY seq LIMIT ?", after, PAGE_ROWS + 1)) {
			if (rows === PAGE_ROWS || bytes >= PAGE_BYTES) return ws.send(encodeServer({ t: "more", seq: last }));
			rows++;
			last = r.seq;
			bytes += r.envelope.byteLength;
			ws.send(encodeServer({ t: "entry", seq: r.seq, doc: new Uint8Array(r.doc), snapshot: r.snapshot === 1, envelope: new Uint8Array(r.envelope) }));
		}
		ws.send(encodeServer({ t: "synced", seq: this.head }));
		ws.serializeAttachment({ ...session, live: true });
	}
}

const owner = (env: Env) => env.OWNER.get(env.OWNER.idFromName("owner"));
const today = () => Math.floor(Date.now() / DAY_MS); // days since the epoch, so a new one starts at 00:00 UTC
// How long an owner code from the dashboard works (it's shown on a screen), and how many unused ones are kept.
const DASHBOARD_CODE_MS = 60 * 60 * 1000, MAX_CODES = 20;

/** Whose tries these are: an IPv4 address, or an IPv6 /64 (one machine often has a whole /64, or more). */
export function network(ip: string | null): string {
	if (!ip) return "unknown"; // Cloudflare always sets it; never trust a header a client can set instead
	if (!ip.includes(":")) return ip;
	if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1); // IPv4-mapped
	const [head = "", tail = ""] = ip.toLowerCase().split("::");
	const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
	const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
	return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
const digest = async (data: string | Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data));
const setupKeyOk = (env: Env) => (env.SETUP_KEY ?? "").length >= MIN_SETUP_KEY;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// The Worker's owner is whoever knows its setup key. Only hashes of owner codes are kept.
export class Owner extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS codes (code_hash BLOB PRIMARY KEY, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, created INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '');
		`);
		this.dashboard = new Dashboard(
			this.sql,
			(id) => (this.env.VAULT.get(this.env.VAULT.idFromName(id)) as unknown as { stats(): Promise<VaultStats> }).stats(),
			() => this.mint(DASHBOARD_CODE_MS),
			() => this.listVaults(),
		);
		this.dashboard.deployed = Date.parse(env.CF_VERSION_METADATA?.timestamp ?? "") || null; // when this version went live
	}

	private readonly dashboard: Dashboard;

	async fetch(req: Request): Promise<Response> {
		return this.dashboard.handle(req);
	}

	latest(): Promise<string | null> {
		return this.dashboard.latest();
	}

	setup(given: Uint8Array, expected: Uint8Array, setupKey: Uint8Array, who: Uint8Array, deployed: number, origin: string) {
		return this.dashboard.setup(given, expected, setupKey, who, deployed, origin);
	}

	/** A new owner code, for the dashboard's Connect a vault. */
	async mint(ttl = DASHBOARD_CODE_MS): Promise<string> {
		const code = crypto.getRandomValues(new Uint8Array(32)), now = Date.now();
		this.sql.exec("INSERT INTO codes (code_hash, expires) VALUES (?, ?)", await digest(code), now + ttl);
		this.sql.exec("DELETE FROM codes WHERE expires < ? OR code_hash NOT IN (SELECT code_hash FROM codes ORDER BY expires DESC LIMIT ?)", now, MAX_CODES);
		return hex(code);
	}

	/** The Worker's vaults, for the dashboard: IDs only (hashes of the vault IDs devices hold). */
	vaultCreated(vault: string): void {
		this.sql.exec("INSERT OR IGNORE INTO vaults (id, created) VALUES (?, ?)", vault, Date.now());
	}

	listVaults(): { id: string; created: number; label: string }[] {
		return this.sql.exec<{ id: string; created: number; label: string }>("SELECT id, created, label FROM vaults ORDER BY created").toArray();
	}

	/** A vault was deleted from Obsidian: it leaves the dashboard. */
	vaultDeleted(vault: string): void {
		this.sql.exec("DELETE FROM vaults WHERE id = ?", vault);
		this.sql.exec("DELETE FROM device_labels WHERE vault = ?", vault);
	}

	/** Whether `code` is a current owner code; if so a vault is being created with it. Each makes one vault. */
	async create(code: Uint8Array): Promise<boolean> {
		if (code.length !== 32) return false;
		const hash = await digest(code);
		if (!this.sql.exec("SELECT 1 FROM codes WHERE code_hash = ? AND expires >= ?", hash, Date.now()).toArray().length) return false;
		this.sql.exec("DELETE FROM codes WHERE code_hash = ?", hash);
		return true;
	}
}

const PAIRING_TTL_MS = 2 * 60 * 1000;

// Single-use mailbox for one pairing: PUT the sealed VMK once, GET it once, gone after 2 minutes.
// The room is never reusable: a used or expired room keeps a tombstone, so an old link can't be refilled.
type Box = { sealed?: Uint8Array; expires: number; used: boolean };

export class Pairing extends DurableObject<Env> {
	async fetch(req: Request): Promise<Response> {
		const body = req.method === "PUT" ? new Uint8Array(await req.arrayBuffer()) : null; // before reading state, so no await splits check and write
		const box = await this.ctx.storage.get<Box>("box");
		if (body) {
			if (body.length === 0 || body.length > 1024) return new Response("bad size", { status: 400 });
			if (box) return new Response("already used", { status: 409 });
			await this.ctx.storage.put("box", { sealed: body, expires: Date.now() + PAIRING_TTL_MS, used: false } satisfies Box);
			await this.ctx.storage.setAlarm(Date.now() + PAIRING_TTL_MS);
			return new Response(null, { status: 204 });
		}
		if (req.method === "GET") {
			if (!box) return new Response("not found", { status: 404 });
			// 410 tells the new device that someone else took the key: it should be treated as exposed.
			if (box.used) return new Response("already used", { status: 410 });
			if (!box.sealed || box.expires < Date.now()) return new Response("expired", { status: 404 });
			await this.ctx.storage.put("box", { expires: box.expires, used: true } satisfies Box);
			return new Response(box.sealed);
		}
		return new Response("method not allowed", { status: 405 });
	}

	// Expiry drops the sealed key but keeps the tombstone.
	async alarm(): Promise<void> {
		const box = await this.ctx.storage.get<Box>("box");
		if (box?.sealed) await this.ctx.storage.put("box", { expires: box.expires, used: box.used } satisfies Box);
	}
}
