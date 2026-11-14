// Ownsync Worker: one Durable Object per vault, a mailbox of sealed envelopes relayed over hibernating
// WebSockets. It never opens an envelope. It keeps, per document, the latest snapshot a device uploaded
// and the updates since, so its storage stays near the size of the vault, not of its history. Attachment
// chunks are kept apart, once per name.

import { DurableObject } from "cloudflare:workers";
import { Dashboard, type VaultStats } from "./dashboard";
import { CHUNK_OVERHEAD, CLOSE, type ClientFrame, MAX_CHUNK, MAX_ENVELOPE, MAX_RECORD, RECOVERY_SEALED, type ServerFrame, decodeClient, encodeServer } from "./wire";

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
		const vault = path.match(/^\/vault\/([0-9a-f]{32})(\/mint|\/delete)?$/);
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
			CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, last_online INTEGER NOT NULL, version TEXT NOT NULL, conflicts INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK (id = 0), day INTEGER NOT NULL, requests INTEGER NOT NULL, rows INTEGER NOT NULL, last_activity INTEGER);
			CREATE TABLE IF NOT EXISTS tombstone (id INTEGER PRIMARY KEY CHECK (id = 0), at INTEGER NOT NULL);
		`);
		this.head = this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM entries").one().seq;
		const auth = this.sql.exec<{ token_hash: ArrayBuffer }>("SELECT token_hash FROM auth").toArray()[0];
		this.token = auth ? toHex(auth.token_hash) : null;
		this.deleted = this.sql.exec("SELECT 1 FROM tombstone").toArray().length > 0;
		const u = this.sql.exec<{ day: number; requests: number; rows: number; last_activity: number | null }>("SELECT day, requests, rows, last_activity FROM usage").toArray()[0];
		this.usage = u ? { day: u.day, requests: u.requests, rows: u.rows, lastActivity: u.last_activity } : { day: today(), requests: 0, rows: 0, lastActivity: null };
	}

	async fetch(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname;
		this.name ??= path.split("/")[2] ?? null;
		this.count(1);
		const action = path.endsWith("/mint") ? "mint" : path.endsWith("/delete") ? "delete" : null;
		// A device of this vault asks for an owner code to set up another vault on this Worker ("Set up another
		// vault", the same as the dashboard gives). Or it deletes the vault, from Obsidian, where the user typed its
		// short ID.
		if (action) {
			if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
			if (this.deleted) return Response.json({ error: "deleted" }, { status: 410 });
			const token = new Uint8Array(await req.arrayBuffer());
			const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", token));
			const stored = this.sql.exec<{ token_hash: ArrayBuffer }>("SELECT token_hash FROM auth").toArray()[0]?.token_hash;
			if (!stored || token.length !== 32 || !crypto.subtle.timingSafeEqual(hash, stored)) return Response.json({ error: "unauthorized" }, { status: 401 });
			if (action === "mint") return Response.json({ owner: await owner(this.env).mint() });
			await this.delete();
			return Response.json({ deleted: true });
		}
		if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ token: null, live: false } satisfies Session);
		return new Response(null, { status: 101, webSocket: client });
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
				return ws.serializeAttachment({ ...session, token: this.token });
			}
			if (f.t === "subscribe") return this.subscribe(ws, session, f.after);
			if (f.t === "hello") return;
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
		this.write("INSERT OR REPLACE INTO devices (id, last_online, version, conflicts) VALUES (?, ?, ?, ?)", id, Date.now(), f.version, f.conflicts);
		this.write("DELETE FROM devices WHERE id NOT IN (SELECT id FROM devices ORDER BY last_online DESC LIMIT ?)", MAX_DEVICES);
	}

	/** What the owner's dashboard shows of this vault: nothing a key would be needed for. */
	async stats(): Promise<{ bytes: number; requestsToday: number; rowsWrittenToday: number; lastActivity: number | null; deleted: boolean; devices: { id: string; lastOnline: number; online: boolean; version: string; conflicts: number }[] }> {
		const online = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Session).device));
		const fresh = this.usage.day === today();
		const devices = this.sql.exec<{ id: string; last_online: number; version: string; conflicts: number }>("SELECT id, last_online, version, conflicts FROM devices ORDER BY last_online DESC").toArray();
		return {
			bytes: this.sql.databaseSize,
			requestsToday: fresh ? this.usage.requests : 0,
			rowsWrittenToday: fresh ? this.usage.rows : 0,
			lastActivity: this.usage.lastActivity,
			deleted: this.deleted,
			devices: devices.map((d) => ({ id: d.id, lastOnline: d.last_online, online: online.has(d.id), version: d.version, conflicts: d.conflicts })),
		};
	}

	// Everything goes but a tombstone, so the vault can't be created again with an owner code and its devices
	// are told it was deleted instead of being asked for one.
	private async delete(): Promise<void> {
		for (const table of ["entries", "auth", "records", "recovery", "chunks", "devices", "usage"]) this.sql.exec(`DELETE FROM ${table}`);
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
		u.rows++; // this write
		this.sql.exec("INSERT OR REPLACE INTO usage (id, day, requests, rows, last_activity) VALUES (0, ?, ?, ?, ?)", u.day, u.requests, u.rows, u.lastActivity);
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
// How long an owner code works: one a device gets, and one the dashboard gets (shown on a screen, so shorter).
const CODE_MS = 24 * 60 * 60 * 1000, DASHBOARD_CODE_MS = 60 * 60 * 1000, MAX_CODES = 20;

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
	}

	private readonly dashboard: Dashboard;

	async fetch(req: Request): Promise<Response> {
		return this.dashboard.handle(req);
	}

	setup(given: Uint8Array, expected: Uint8Array, setupKey: Uint8Array, who: Uint8Array, deployed: number, origin: string) {
		return this.dashboard.setup(given, expected, setupKey, who, deployed, origin);
	}

	/** A new owner code: for a device that syncs a vault here (the Vault checked its token), or the dashboard. */
	async mint(ttl = CODE_MS): Promise<string> {
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
