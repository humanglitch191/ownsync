// Ownsync Worker: one Durable Object per vault, a mailbox of sealed envelopes relayed over hibernating
// WebSockets. It never opens an envelope. It keeps, per document, the latest snapshot a device uploaded
// and the updates since, so its storage stays near the size of the vault, not of its history. Attachment
// chunks are kept apart, once per name.

import { DurableObject } from "cloudflare:workers";
import { Dashboard, VERSION, type VaultRpc, type VaultSettings, type VaultStats } from "./dashboard";
import { SNAPSHOT_BUDGET, SNAPSHOT_DAYS, snapshotsToPrune } from "./snapshots";
import { CHUNK_OVERHEAD, CLOSE, type AttachmentAnswer, type AttachmentMutation, type AttachmentRow, type ClientFrame, DOC_TAG_BYTES, MARK, MAX_CHUNK, MAX_MARK, MAX_RECORD, RECOVERY_SEALED, type ServerFrame, decodeClient, encodeServer, unpackGenesis, validClientSize } from "./wire";

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
// listFrom: when this socket's full list of current versions began (DESIGN.md section 10), until its last frame.
type Session = { token: string | null; live: boolean; device?: string; listFrom?: number; table?: string; subscribed?: boolean; wantsMigration?: boolean; tableLive?: boolean };
const toHex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
type StoredAttachment = { file: ArrayBuffer; version: ArrayBuffer; pathkey: ArrayBuffer; record: ArrayBuffer; deleted: number | null; seq: number };
// The existing BLOB column uses an empty blob for a note, outside the fixed-width version-tag space.
const NO_VERSION = new Uint8Array(0);
const storedVersion = (v: ArrayBuffer) => v.byteLength ? new Uint8Array(v) : null;
const attachmentRow = (r: StoredAttachment): AttachmentRow => ({
	file: new Uint8Array(r.file), version: storedVersion(r.version), pathkey: new Uint8Array(r.pathkey), record: new Uint8Array(r.record), deleted: r.deleted, seq: r.seq,
});
type Row = { seq: number; doc: ArrayBuffer; snapshot: number; envelope: ArrayBuffer };

// NULL in versions means upload started, count unknown. Only genesis may install this legacy marker.
const LEGACY_CHUNKS = -1;
class IncompleteGenesis extends Error {}

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
const MAX_SNAPSHOT = 50 * 1024 * 1024; // one snapshot; the vault keeps SNAPSHOT_BUDGET of them in all
const SNAPSHOT_LEASE_MS = 60 * 60 * 1000;
// Version-scoped chunks (DESIGN.md section 10): devices this recent must all run 0.2.0 or later before any device
// uploads them, and Clean up removes at most this many chunks a request (the dashboard asks again for the rest).
const SCOPED_SINCE_MS = 30 * DAY_MS;
const CLEANUP_PER_REQUEST = 2000;
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
	private migrated = false;
	private migrationFailureDay?: number; // Best effort: reporting a failed write must not require another write.
	// Today's counters for the dashboard's free-plan meter, kept in memory and written at most once a minute.
	private usage: { day: number; requests: number; rows: number; lastActivity: number | null };
	private flushedAt = 0;
	private historyBytes: number | undefined; // the history table's total size, summed once per wake and kept up to date

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// No tables until a vault is created (or an older Worker made them): a request for a random ID must not
		// leave storage behind, or anyone could make objects that never go away.
		const exists = this.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'auth'").toArray().length > 0;
		if (exists) {
			this.schema();
			this.migrated = !!this.sql.exec("SELECT 1 FROM settings WHERE key = 'attachmentTable'").toArray().length;
		}
		this.head = exists ? this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM entries").one().seq : 0;
		const auth = exists ? this.sql.exec<{ token_hash: ArrayBuffer }>("SELECT token_hash FROM auth").toArray()[0] : undefined;
		this.token = auth ? toHex(auth.token_hash) : null;
		this.deleted = exists && this.sql.exec("SELECT 1 FROM tombstone").toArray().length > 0;
		const u = exists ? this.sql.exec<{ day: number; requests: number; rows: number; last_activity: number | null; flushed_at: number }>("SELECT day, requests, rows, last_activity, flushed_at FROM usage").toArray()[0] : undefined;
		this.usage = u ? { day: u.day, requests: u.requests, rows: u.rows, lastActivity: u.last_activity } : { day: today(), requests: 0, rows: 0, lastActivity: null };
		// Waking from hibernation would forget when the counters were last written, and every wake wrote them again
		// (2 rows each: most of a vault's rows when a device wakes it every few seconds). Counts between writes can be
		// lost when it sleeps again; the dashboard's figures are near enough.
		this.flushedAt = u?.flushed_at ?? 0;
	}

	private schema(): void {
		// seq is assigned here, not by AUTOINCREMENT (which costs a second row write per entry). It only ever
		// grows: a snapshot is inserted before the entries it replaces are deleted.
		const files = `
			CREATE TABLE IF NOT EXISTS attachments (file BLOB PRIMARY KEY, version BLOB NOT NULL, pathkey BLOB NOT NULL, record BLOB NOT NULL, deleted INTEGER, seq INTEGER NOT NULL UNIQUE) WITHOUT ROWID;
			CREATE UNIQUE INDEX IF NOT EXISTS attachments_path ON attachments(pathkey) WHERE deleted IS NULL;
			CREATE INDEX IF NOT EXISTS attachments_version ON attachments(version) WHERE deleted IS NULL AND version != x'';`;
		const old = this.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'attachments'").toArray()[0];
		if (old && !old.sql.includes("WITHOUT ROWID")) {
			this.ctx.storage.transactionSync(() => {
				this.sql.exec("ALTER TABLE attachments RENAME TO old_attachments; DROP INDEX attachments_version; DROP INDEX attachments_path");
				this.sql.exec(files);
				this.sql.exec("INSERT INTO attachments SELECT * FROM old_attachments; DROP TABLE old_attachments; DROP TABLE IF EXISTS attachment_stage");
			});
		} else this.sql.exec(files);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, doc BLOB NOT NULL, snapshot INTEGER NOT NULL, envelope BLOB NOT NULL);
			CREATE INDEX IF NOT EXISTS entries_doc ON entries (doc, seq);
			CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 0), token_hash BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS records (number INTEGER PRIMARY KEY, blob BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY CHECK (id = 0), sealed BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS chunks (name BLOB PRIMARY KEY, envelope BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, doc BLOB NOT NULL, at INTEGER NOT NULL, size INTEGER NOT NULL, envelope BLOB NOT NULL);
			CREATE INDEX IF NOT EXISTS history_doc ON history (doc, at);
			CREATE INDEX IF NOT EXISTS history_at ON history (at);
			CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot BLOB NOT NULL UNIQUE, day INTEGER NOT NULL UNIQUE, at INTEGER NOT NULL, epoch INTEGER NOT NULL, parts INTEGER NOT NULL, received INTEGER NOT NULL, size INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS removed_snapshots (snapshot BLOB PRIMARY KEY, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS snapshot_parts (snapshot BLOB NOT NULL REFERENCES snapshots(snapshot) ON DELETE CASCADE, part INTEGER NOT NULL, count INTEGER NOT NULL, day INTEGER NOT NULL, at INTEGER NOT NULL, size INTEGER NOT NULL, envelope BLOB NOT NULL, PRIMARY KEY (snapshot, part));
			CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, last_online INTEGER NOT NULL, version TEXT NOT NULL, conflicts INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK (id = 0), day INTEGER NOT NULL, requests INTEGER NOT NULL, rows INTEGER NOT NULL, last_activity INTEGER);
			CREATE TABLE IF NOT EXISTS usage_days (day INTEGER PRIMARY KEY, requests REAL NOT NULL, rows INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS tombstone (id INTEGER PRIMARY KEY CHECK (id = 0), at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS vault_name (id INTEGER PRIMARY KEY CHECK (id = 0), name TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS versions (tag BLOB PRIMARY KEY, retired_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0);
			CREATE INDEX IF NOT EXISTS versions_retired ON versions (retired_at);
			CREATE TABLE IF NOT EXISTS version_chunks (name BLOB PRIMARY KEY, tag BLOB NOT NULL);
			CREATE INDEX IF NOT EXISTS version_chunks_tag ON version_chunks (tag);

			CREATE TABLE IF NOT EXISTS attachment_answers (req BLOB PRIMARY KEY, answer BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS genesis_parts (session TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(session, part)) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS lists (device TEXT PRIMARY KEY, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
		`);
		// Existing chunks have no known upload time. Leave it NULL so an orphan cannot be dated by guesswork.
		if (!this.sql.exec<{ name: string }>("PRAGMA table_info(chunks)").toArray().some(c => c.name === "uploaded_at")) this.sql.exec("ALTER TABLE chunks ADD COLUMN uploaded_at INTEGER");
		if (!this.sql.exec<{ name: string }>("PRAGMA table_info(versions)").toArray().some(c => c.name === "expected_chunks")) this.sql.exec("ALTER TABLE versions ADD COLUMN expected_chunks INTEGER");
		if (!this.sql.exec<{ name: string }>("PRAGMA table_info(devices)").toArray().some(c => c.name === "table_client")) this.sql.exec("ALTER TABLE devices ADD COLUMN table_client INTEGER NOT NULL DEFAULT 0");
		// Added in 0.1.2: a device's name, as Obsidian has it. Vaults made earlier get the column now.
		if (!this.sql.exec<{ name: string }>("PRAGMA table_info(devices)").toArray().some((c) => c.name === "name")) this.sql.exec("ALTER TABLE devices ADD COLUMN name TEXT NOT NULL DEFAULT ''");
		// Added in 0.2.0: when the usage counters were last written, so a wake from hibernation doesn't write them again.
		if (!this.sql.exec<{ name: string }>("PRAGMA table_info(usage)").toArray().some((c) => c.name === "flushed_at")) this.sql.exec("ALTER TABLE usage ADD COLUMN flushed_at INTEGER NOT NULL DEFAULT 0");
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
				: action === "names" ? 1024
				: 0; // delete: the token alone
			const body = await this.readBoundedBody(req, 32 + limit);
			const token = action === "delete" ? body : body.subarray(0, 32);
			const hash = await digest(token);
			if (this.deleted) return Response.json({ error: "deleted" }, { status: 410 });
			const stored = this.token === null ? undefined : this.sql.exec<{ token_hash: ArrayBuffer }>("SELECT token_hash FROM auth").toArray()[0]?.token_hash;
			if (!stored || token.length !== 32 || !crypto.subtle.timingSafeEqual(hash, stored)) return Response.json({ error: "unauthorized" }, { status: 401 });
			if (action === "history") return this.history(operation, body.subarray(32));
			if (action === "snapshot") return this.snapshot(operation, body.subarray(32));
			if (action === "names") {
				if (body.length > 32 + 1024) return Response.json({ error: "too large" }, { status: 413 });
				let n: { device?: unknown; name?: unknown; vault?: unknown; settings?: unknown };
				try { n = JSON.parse(new TextDecoder().decode(body.slice(32))); } catch { return Response.json({ error: "bad names" }, { status: 400 }); }
				// No control characters: kept to printable text.
				const clean = (x: unknown) => (typeof x === "string" ? Array.from(x).filter((c) => c >= " " && c !== "\u007f").join("").trim().slice(0, 40) : "");
				const device = typeof n.device === "string" && /^[0-9A-F]{8}$/.test(n.device) ? n.device : null;
				if (device) this.write("INSERT INTO devices (id, last_online, version, conflicts, name) VALUES (?, ?, '', 0, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name", device, Date.now(), clean(n.name));
				if (typeof n.vault === "string") this.write("INSERT OR REPLACE INTO vault_name (id, name) VALUES (0, ?)", clean(n.vault));
				// A 0.2.x device's own choice carries over while the vault has none: snapshots on, or history backup off. So
				// any device's snapshots on turns them on, and any device's backup off turns it off; the owner's choice stays.
				for (const [key, value] of settingsIn(n.settings)) if (value === (key === "snapshots")) this.write("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", key, Number(value));
				// And in reply, which Ownsync this Worker runs and the newest release, so the plugin can say when either is behind.
				const latest = await (owner(this.env) as unknown as { latest(): Promise<string | null> }).latest().catch(() => null);
				// And the names the vault's devices gave themselves, for each device's list (they were sent readable anyway).
				const names = Object.fromEntries(this.sql.exec<{ id: string; name: string }>("SELECT id, name FROM devices WHERE name != ''").toArray().map((r) => [r.id, r.name]));
				// And whether every recent device can read version-scoped chunks. A Worker that sends no `scoped` has neither vput nor mark.
				// And the vault's settings, which every device follows.
				return Response.json({ ok: true, worker: VERSION, latest, names, scoped: this.scoped(device), settings: this.settings() });
			}
			await this.erase();
			return Response.json({ deleted: true });
		}
		if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426, headers: { "X-Ownsync-Table": "1" } });
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
			if (doc.length) this.dropHistory("WHERE doc = ?", doc);
			else this.dropHistory("");
			return Response.json({ ok: true });
		}

		const now = Date.now();
		if (operation === "list") {
			this.dropHistory("WHERE at < ?", now - HISTORY_RETENTION_MS);
			// One copy in memory at a time: the IDs first, then each envelope as the reader asks for it.
			const ids = this.sql.exec<{ id: number }>("SELECT id FROM history WHERE doc = ? ORDER BY at DESC, id DESC LIMIT 200", doc).toArray();
			return new Response(new ReadableStream<Uint8Array>({
				pull: (controller) => {
					for (let next; (next = ids.shift());) {
						const row = this.deleted ? undefined : this.sql.exec<{ envelope: ArrayBuffer }>("SELECT envelope FROM history WHERE id = ?", next.id).toArray()[0];
						if (!row) continue; // evicted or cleared since the list began
						const length = new Uint8Array(4);
						new DataView(length.buffer).setUint32(0, row.envelope.byteLength);
						controller.enqueue(length);
						controller.enqueue(new Uint8Array(row.envelope));
						return;
					}
					controller.close();
				},
			}), { headers: { "content-type": "application/octet-stream" } });
		}

		const envelope = body.subarray(DOC_TAG_BYTES);
		if (!envelope.length || envelope.length > MAX_HISTORY_ENVELOPE) return Response.json({ error: "bad envelope size" }, { status: 413 });
		if (this.settings().historyBackup === false) return Response.json({ error: "off" }, { status: 403 }); // also for devices older than the setting
		try {
			this.ctx.storage.transactionSync(() => {
				this.historyBytes ??= this.sql.exec<{ size: number }>("SELECT COALESCE(SUM(size), 0) AS size FROM history").one().size;
				this.write("INSERT INTO history (doc, at, size, envelope) VALUES (?, ?, ?, ?)", doc, now, envelope.length, envelope);
				this.historyBytes += envelope.length;
				this.dropHistory("WHERE at < ?", now - HISTORY_RETENTION_MS);
				// Keep the newest rows that fit: drop the oldest until they do. The ID breaks ties within a millisecond.
				while (this.historyBytes > MAX_HISTORY_BYTES && this.dropHistory("WHERE id = (SELECT id FROM history ORDER BY at, id LIMIT 1)"));
			});
		} catch (error) {
			this.historyBytes = undefined; // rolled back: sum it again next time
			throw error;
		}
		return Response.json({ ok: true });
	}

	// Every history delete goes through here, so the running total stays right.
	private dropHistory(where: string, ...args: unknown[]): number {
		const cursor = this.sql.exec<{ size: number }>(`DELETE FROM history ${where} RETURNING size`, ...args);
		let dropped = 0;
		for (const row of cursor) {
			dropped++;
			if (this.historyBytes !== undefined) this.historyBytes -= row.size;
		}
		this.count(0, cursor.rowsWritten);
		return dropped;
	}

	// Every snapshot delete goes through here. The list names what was removed for 30 days, so devices drop it from
	// their ledger and only a snapshot gone some other way shows as missing (DESIGN.md section 9).
	private dropSnapshots(now: number, where: string, ...args: unknown[]): void {
		const cursor = this.sql.exec<{ snapshot: ArrayBuffer }>(`DELETE FROM snapshots ${where} RETURNING snapshot`, ...args);
		const removed = cursor.toArray();
		this.count(0, cursor.rowsWritten);
		for (const { snapshot } of removed) this.write("INSERT OR REPLACE INTO removed_snapshots (snapshot, at) VALUES (?, ?)", snapshot, now);
	}

	private expireSnapshots(now: number): void {
		this.write("DELETE FROM removed_snapshots WHERE at <= ?", now - SNAPSHOT_DAYS * DAY_MS);
		this.dropSnapshots(now, "WHERE received < parts AND at <= ?", now - SNAPSHOT_LEASE_MS);
		// The last 30 days, even when no device uploads any more.
		const rows = this.sql.exec<{ id: number; day: number; size: number; complete: number }>("SELECT id, day, size, received = parts AS complete FROM snapshots").toArray();
		for (const row of snapshotsToPrune(rows, Math.floor(now / DAY_MS))) this.dropSnapshots(now, "WHERE id = ?", row.id);
	}

	private snapshot(operation: string | undefined, body: Uint8Array, now = Date.now()): Response {
		this.expireSnapshots(now);
		if (!operation) return this.settings().snapshots === false ? Response.json({ error: "off" }, { status: 403 }) : this.uploadSnapshot(body, now);
		if (operation === "list") {
			if (body.length) return Response.json({ error: "bad body" }, { status: 400 });
			const rows = this.sql.exec<{ id: string; day: number; epoch: number; parts: number; received: number; size: number; complete: number; at: number }>(
				"SELECT lower(hex(snapshot)) AS id, day, epoch, parts, received, size, received = parts AS complete, at FROM snapshots ORDER BY day DESC",
			).toArray();
			// In a header, so a 0.2.1 device reads the list as before; 200 IDs keep it small.
			const removed = this.sql.exec<{ id: string }>("SELECT lower(hex(snapshot)) AS id FROM removed_snapshots ORDER BY at DESC LIMIT 200").toArray();
			return Response.json(rows.map((row) => ({ ...row, complete: !!row.complete })), { headers: { "ownsync-removed": removed.map((r) => r.id).join(",") } });
		}
		if (operation === "delete" && body.length === 0) {
			this.dropSnapshots(now, "");
			return Response.json({ ok: true });
		}
		if (body.length !== SNAPSHOT_ID_BYTES) return Response.json({ error: "bad snapshot ID" }, { status: 400 });
		if (operation === "delete") {
			this.dropSnapshots(now, "WHERE snapshot = ?", body);
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
			for (const row of prune) this.dropSnapshots(now, "WHERE id = ?", row.id);
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
		if (typeof msg === "string" || !validClientSize(new Uint8Array(msg))) return ws.close(CLOSE.badMessage, "bad frame");
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
				this.dropHistory("WHERE at < ?", Date.now() - HISTORY_RETENTION_MS);
				this.expireSnapshots(Date.now());
				return ws.serializeAttachment({ ...session, token: this.token });
			}
			if (f.t === "table") {
				if (!session.table && (session.subscribed || session.live)) return ws.close(CLOSE.badMessage, "negotiate before subscribe");
				if (!session.table) ws.serializeAttachment({ ...session, table: crypto.randomUUID() });
				return ws.send(encodeServer({ t: "format", table: this.migrated }));
			}
			if (this.migrated && !session.table) return ws.close(CLOSE.updateNeeded, "update needed");
			if (f.t === "migrationCheck") {
				if (!session.table) return ws.close(CLOSE.badMessage, "table handshake required");
				ws.serializeAttachment({ ...session, wantsMigration: true });
				return ws.send(encodeServer({ t: "migrationEligible", ready: !this.migrated && this.migrationEligible() }));
			}
			if (f.t === "stageRow") return ws.close(CLOSE.badMessage, "genesis rows belong inside parts");
			if (f.t === "stagePart" || f.t === "genesis") {
				if (!session.table) return ws.close(CLOSE.badMessage, "table handshake required");
				if (f.t === "genesis") return this.genesis(ws, session.table, f.base, f.rows);
				if (this.migrated) return ws.send(encodeServer({ t: "format", table: true }));
				try {
					this.write("INSERT INTO genesis_parts(session, part, data) VALUES (?, ?, ?)", session.table, f.part, f.data);
				} catch { return this.migrationWriteFailed(ws); }
				return ws.send(encodeServer({ t: "stagedPart", seq: f.part }));
			}
			if (f.t === "forget" || f.t === "since" || f.t === "set" || f.t === "del" || f.t === "restore") {
				if (!session.table || !this.migrated) return ws.close(CLOSE.badMessage, "attachment table required");
				if (f.t === "forget") {
					this.write("DELETE FROM attachment_answers WHERE req = ?", f.req);
					return ws.send(encodeServer({ t: "forgotten", req: f.req }));
				}
				if (f.t === "since") return this.since(ws, session, f.after);
				return this.changeAttachment(ws, f);
			}
			if (f.t === "subscribe") return this.subscribe(ws, session, f.after);
			if (f.t === "hello") return this.expireSnapshots(Date.now());
			if (f.t === "append" || f.t === "rotate") return this.append(ws, f);
			if (f.t === "status") return this.status(ws, session, f);
			if (f.t === "mark") {
				if (this.migrated) return ws.close(CLOSE.badMessage, "attachment table owns retirements");
				return this.mark(ws, session, f);
			}
			if (f.t === "get") {
				const row = this.sql.exec<{ envelope: ArrayBuffer }>("SELECT envelope FROM chunks WHERE name = ?", f.name).toArray()[0];
				return ws.send(encodeServer(row ? { t: "chunk", name: f.name, envelope: new Uint8Array(row.envelope) } : { t: "missing", name: f.name }));
			}
			if (f.envelope.length === 0) return ws.close(CLOSE.badMessage, "empty envelope");
			if (f.t === "vput") return this.vput(ws, f);
			if (f.t === "put") {
				if (f.envelope.length > MAX_CHUNK + CHUNK_OVERHEAD) return ws.close(CLOSE.badMessage, "chunk too large");
				// The name is a keyed hash of the content, so the same name is the same chunk: stored once.
				try {
					this.write("INSERT OR IGNORE INTO chunks (name, envelope, uploaded_at) VALUES (?, ?, ?)", f.name, f.envelope, Date.now());
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

	// Check again at genesis: a legacy device may have connected since staging began.
	private migrationEligible(): boolean {
		if (this.migrationRequested()) return true;
		const cutoff = Date.now() - SCOPED_SINCE_MS;
		for (const ws of this.ctx.getWebSockets()) {
			const s = ws.deserializeAttachment() as Session;
			if (s.token === this.token && !s.table) return false;
		}
		const unknown = this.sql.exec("SELECT 1 FROM settings WHERE key = 'unidentifiedLegacy' AND value >= ?", cutoff).toArray();
		if (unknown.length) return false;
		const recent = this.sql.exec<{ n: number; old: number }>("SELECT count(*) AS n, count(*) FILTER (WHERE table_client = 0) AS old FROM devices WHERE last_online >= ?", cutoff).one();
		return recent.n < MAX_DEVICES && recent.old === 0;
	}
	private migrationRequested(): boolean {
		return !!this.sql.exec("SELECT 1 FROM settings WHERE key = 'migrateNow'").toArray().length;
	}
	async requestMigration() {
		if (this.token === null || this.deleted) return { error: "no such vault" };
		if (!this.migrated) {
			this.write("INSERT OR REPLACE INTO settings(key,value) VALUES ('migrateNow',1)");
			for (const ws of this.ctx.getWebSockets()) {
				const s = ws.deserializeAttachment() as Session;
				if (s.token === this.token && s.wantsMigration) ws.send(encodeServer({ t: "migrationEligible", ready: true }));
			}
		}
		return { ok: true };
	}

	private migrationWriteFailed(ws: WebSocket) {
		this.migrationFailureDay = today();
		ws.send(encodeServer({ t: "migrationWriteFailed" }));
	}

	private *genesisParts(session: string) {
		let part = 0;
		for (const r of this.sql.exec<{ part: number; data: ArrayBuffer }>("SELECT part, data FROM genesis_parts WHERE session = ? ORDER BY part", session)) {
			if (r.part !== ++part) throw new IncompleteGenesis("missing genesis part");
			yield new Uint8Array(r.data);
		}
	}

	// Only stage blobs are visible before commit. The file rows, version retirements,
	// format flag and disposal of all contenders' parts commit or roll back together.
	private genesis(ws: WebSocket, session: string, base: number, rows: number): void {
		if (!this.migrated && base === this.head && this.migrationEligible()) {
			try {
				this.ctx.storage.transactionSync(() => this.installGenesis(session, rows));
				this.migrated = true;
			} catch (e) {
				if (!(e instanceof IncompleteGenesis)) return this.migrationWriteFailed(ws);
			}
			if (this.migrated) {
				for (const peer of this.ctx.getWebSockets()) {
					if (peer === ws) continue;
					const s = peer.deserializeAttachment() as Session;
					if (s.token !== this.token) continue;
					if (!s.table) peer.close(CLOSE.updateNeeded, "update needed");
					else peer.send(encodeServer({ t: "format", table: true }));
				}
			}
		}
		if (!this.migrated) {
			try { this.write("DELETE FROM genesis_parts WHERE session = ?", session); }
			catch { return this.migrationWriteFailed(ws); }
		}
		ws.send(encodeServer({ t: "format", table: this.migrated }));
	}

	private installGenesis(session: string, rows: number) {
		let seq = 0;
		const now = Date.now();
		const versions = new Map<string, { tag: Uint8Array; count: number; retired: number | null }>();
		for (const { row, expectedChunks, dateAtCommit } of unpackGenesis(this.genesisParts(session))) {
			if (row.seq !== ++seq || (row.version === null && expectedChunks !== null)) throw new IncompleteGenesis("invalid genesis row");
			const deleted = dateAtCommit ? now : row.deleted;
			this.write("INSERT INTO attachments(file,version,pathkey,record,deleted,seq) VALUES (?,?,?,?,?,?)",
				row.file, row.version ?? NO_VERSION, row.pathkey, row.record, deleted, seq);
			if (row.version === null) continue;
			const key = toHex(row.version), count = expectedChunks ?? LEGACY_CHUNKS, prior = versions.get(key);
			if (!prior) versions.set(key, { tag: row.version.slice(), count, retired: deleted });
			else {
				if (prior.count !== count) throw new IncompleteGenesis("conflicting chunk declarations");
				prior.retired = prior.retired === null || deleted === null ? null : Math.max(prior.retired, deleted);
			}
		}
		if (seq !== rows) throw new IncompleteGenesis("incomplete genesis");
		for (const { tag, count, retired } of versions.values()) {
			const chunks = this.sql.exec<{ owned: number; stored: number }>(`SELECT COUNT(*) AS owned, COUNT(c.name) AS stored
				FROM version_chunks vc LEFT JOIN chunks c ON c.name=vc.name WHERE vc.tag=?`, tag).one();
			if (count === LEGACY_CHUNKS ? chunks.owned !== 0 : chunks.owned > count || (retired === null && chunks.stored !== count))
				throw new IncompleteGenesis("incomplete genesis version");
			this.write(`INSERT INTO versions(tag,expected_chunks,retired_at,deleted) VALUES (?,?,?,?)
				ON CONFLICT(tag) DO UPDATE SET expected_chunks=excluded.expected_chunks, deleted=excluded.deleted,
				retired_at=CASE WHEN excluded.deleted THEN CASE WHEN excluded.retired_at=? THEN excluded.retired_at
				ELSE COALESCE(versions.retired_at,excluded.retired_at) END END`, tag, count, retired, Number(retired !== null), now);
		}
		this.write("INSERT INTO settings(key, value) VALUES ('attachmentTable', 1)");
		this.write("DELETE FROM genesis_parts");
	}

	private hasAttachmentChunks(version: Uint8Array, expected: number | null, sameVersion: boolean): boolean {
		const saved = this.sql.exec<{ expected_chunks: number | null }>("SELECT expected_chunks FROM versions WHERE tag = ?", version).toArray()[0]?.expected_chunks;
		if (expected === null) return sameVersion && saved === LEGACY_CHUNKS;
		if (saved != null && saved !== expected) return false;
		const counts = this.sql.exec<{ owned: number; stored: number }>(`SELECT COUNT(*) AS owned, COUNT(c.name) AS stored
			FROM version_chunks vc LEFT JOIN chunks c ON c.name = vc.name WHERE vc.tag = ?`, version).one();
		return counts.owned === expected && counts.stored === expected;
	}

	// Keep a success until its device durably records it. A refused request can still apply on retry.
	private changeAttachment(ws: WebSocket, f: AttachmentMutation): void {
		const replay = this.sql.exec<{ answer: ArrayBuffer }>("SELECT answer FROM attachment_answers WHERE req = ?", f.req).toArray()[0];
		if (replay) return ws.send(replay.answer);
		let changed: AttachmentRow | undefined;
		const current = this.sql.exec<StoredAttachment>("SELECT * FROM attachments WHERE file = ?", f.file).toArray()[0];
		const refused = (r = current, missing = false): AttachmentAnswer => ({ t: "refused", req: f.req, row: r ? attachmentRow(r) : null, missing });
		const apply = (): AttachmentAnswer => {
			if ((current?.seq ?? null) !== f.base) return refused();
			if (f.t !== "del") {
				const occupant = this.sql.exec<StoredAttachment>("SELECT * FROM attachments WHERE pathkey = ? AND deleted IS NULL AND file != ?", f.pathkey, f.file).toArray()[0];
				if (occupant) return refused(occupant);
			}
			if (f.t === "del" && (!current || current.deleted !== null)) return refused();
			if (f.t === "restore" && (!current || current.deleted === null)) return refused();
			const version = f.t === "set" ? f.version : storedVersion(current!.version);
			const note = version === null;
			if (current && note !== (current.version.byteLength === 0)) return refused();
			if (f.t === "del" && note !== !!f.record) return refused();
			if (f.t !== "del" && note && f.expectedChunks !== null) return refused();
			const sameVersion = !!current && (note || toHex(version) === toHex(current.version));
			if (f.t === "set" && current?.deleted != null && sameVersion) return refused();
			if (f.t !== "del" && version !== null && !this.hasAttachmentChunks(version, f.expectedChunks, sameVersion)) return refused(current, true);
			const now = Date.now();
			const seq = this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM attachments").one().seq;
			changed = { seq, file: f.file, version, pathkey: f.t === "del" ? new Uint8Array(current!.pathkey) : f.pathkey,
				record: f.record ?? new Uint8Array(current!.record), deleted: f.t === "del" ? now : null };
			this.write("INSERT INTO attachments(file, version, pathkey, record, deleted, seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET version=excluded.version, pathkey=excluded.pathkey, record=excluded.record, deleted=excluded.deleted, seq=excluded.seq",
				changed.file, changed.version ?? NO_VERSION, changed.pathkey, changed.record, changed.deleted, seq);
			if (!note && current && current.deleted === null && (f.t === "del" || !sameVersion)) {
				this.write("UPDATE versions SET retired_at = ?, deleted = ? WHERE tag = ? AND NOT EXISTS (SELECT 1 FROM attachments WHERE version = versions.tag AND version != x'' AND deleted IS NULL)", now, Number(f.t === "del"), current.version);
			}
			if (!note && f.t !== "del") this.write(`INSERT INTO versions(tag, expected_chunks) VALUES (?, ?)
				ON CONFLICT(tag) DO UPDATE SET expected_chunks = excluded.expected_chunks, retired_at = NULL, deleted = 0
				WHERE versions.expected_chunks IS NULL OR versions.retired_at IS NOT NULL`, version, f.expectedChunks ?? LEGACY_CHUNKS);
			return { t: "ok", req: f.req, seq };
		};
		let answer: Uint8Array;
		try {
			answer = this.ctx.storage.transactionSync(() => {
				const outcome = apply(), bytes = encodeServer(outcome);
				if (outcome.t === "ok") this.write("INSERT INTO attachment_answers(req, answer) VALUES (?, ?)", f.req, bytes);
				return bytes;
			});
		} catch {
			return ws.send(encodeServer(refused(current, true)));
		}
		ws.send(answer);
		if (changed) {
			this.usage.lastActivity = Date.now();
			// Even the author consumes this row through since/live. Its answer resolves only the proposal.
			const frame = encodeServer({ t: "row", row: changed });
			for (const peer of this.ctx.getWebSockets()) {
				const s = peer.deserializeAttachment() as Session;
				if (s.tableLive && s.token === this.token) peer.send(frame);
			}
		}
	}

	private since(ws: WebSocket, session: Session, after: number): void {
		const head = this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM attachments").one().seq;
		if (after > head) return ws.close(CLOSE.badMessage, "attachment cursor past head");
		let rows = 0, bytes = 0, last = after;
		for (const r of this.sql.exec<StoredAttachment>("SELECT * FROM attachments WHERE seq > ? ORDER BY seq LIMIT ?", after, PAGE_ROWS + 1)) {
			if (rows === PAGE_ROWS || bytes >= PAGE_BYTES) {
				ws.serializeAttachment({ ...session, tableLive: false });
				return ws.send(encodeServer({ t: "tableMore", seq: last }));
			}
			const frame = encodeServer({ t: "row", row: attachmentRow(r) });
			ws.send(frame);
			rows++;
			bytes += frame.length;
			last = r.seq;
		}
		ws.send(encodeServer({ t: "tableSynced", seq: head }));
		ws.serializeAttachment({ ...session, tableLive: true });
	}

	// Complete the close handshake, or the client waits for it.
	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		// Last online is the Worker's own record of the connection, never the device's word.
		const { device, table, token } = ws.deserializeAttachment() as Session;
		if (!this.deleted && !this.migrated && token && !device && !table) this.write("INSERT OR REPLACE INTO settings(key,value) VALUES ('unidentifiedLegacy',?)", Date.now());
		if (table && !this.deleted && !this.migrated) this.write("DELETE FROM genesis_parts WHERE session = ?", table);
		if (device && !this.deleted) this.write("UPDATE devices SET last_online = ? WHERE id = ?", Date.now(), device);
		// The last device going: write the counts now, as the object may sleep before the next minute is up.
		if (!this.deleted && this.ctx.getWebSockets().length <= 1) this.flush();
		try { ws.close(code === 1000 || code >= 3000 ? code : 1000, "closing"); } catch { /* already closed */ }
	}

	// The first hello sets the vault's token, and only with the Worker's owner code. Returns a close code, or 0.
	private async admit(token: Uint8Array, ownerCode: Uint8Array | undefined): Promise<number> {
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", token));
		if (this.token === null) {
			if (!ownerCode || !(await owner(this.env).create(ownerCode).catch(() => false))) return CLOSE.notOwner;
			this.schema();
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
			if (ws !== from && s.live && s.token === this.token && (!this.migrated || s.table)) ws.send(bytes);
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
					const s = other.deserializeAttachment() as Session;
					if (other !== ws && s.token === this.token && (!this.migrated || s.table)) this.sendRecords(other, f.number);
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
		this.write("INSERT INTO devices (id, last_online, version, conflicts, table_client) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_online = excluded.last_online, version = excluded.version, conflicts = excluded.conflicts, table_client = excluded.table_client", id, Date.now(), f.version, f.conflicts, Number(!!session.table));
		this.write("DELETE FROM devices WHERE id NOT IN (SELECT id FROM devices ORDER BY last_online DESC LIMIT ?)", MAX_DEVICES);
	}

	// A chunk of one attachment version (DESIGN.md section 10). Stored as `put` stores it, and its name recorded under
	// the version's tag, but only if this vput stored it or the name is already that tag's: a name belongs to one tag
	// for good, so no device can claim an old-style chunk, or another version's, and have it removed.
	private vput(ws: WebSocket, f: Extract<ClientFrame, { t: "vput" }>): void {
		if (f.envelope.length > MAX_CHUNK + CHUNK_OVERHEAD) return ws.close(CLOSE.badMessage, "chunk too large");
		let stored = false;
		try {
			this.ctx.storage.transactionSync(() => {
				const owner = this.sql.exec<{ mine: number }>("SELECT tag = ? AS mine FROM version_chunks WHERE name = ?", f.tag, f.name).toArray()[0];
				if (owner) {
					if (!owner.mine) return;
					this.write("INSERT OR IGNORE INTO chunks (name, envelope, uploaded_at) VALUES (?, ?, ?)", f.name, f.envelope, Date.now()); // put back, if it was removed
				} else {
					const { n, capacity } = this.sql.exec<{ n: number; capacity: number }>(`SELECT COUNT(*) AS n,
						COALESCE((SELECT expected_chunks FROM versions WHERE tag = ?), ?) AS capacity FROM version_chunks WHERE tag = ?`, f.tag, MAX_MARK, f.tag).one();
					if (n >= capacity) return;
					const cursor = this.sql.exec("INSERT OR IGNORE INTO chunks (name, envelope, uploaded_at) VALUES (?, ?, ?)", f.name, f.envelope, Date.now());
					this.count(0, cursor.rowsWritten);
					if (!cursor.rowsWritten) return; // there already, and nobody's: an old-style chunk, never to be removed
					this.write("INSERT INTO version_chunks (name, tag) VALUES (?, ?)", f.name, f.tag);
				}
				if (this.migrated) this.write("INSERT OR IGNORE INTO versions(tag) VALUES (?)", f.tag);
				else this.write("INSERT INTO versions (tag, retired_at) VALUES (?, NULL) ON CONFLICT(tag) DO UPDATE SET retired_at = NULL, deleted = 0 WHERE retired_at IS NOT NULL", f.tag);
				stored = true;
			});
		} catch {
			stored = false; // storage full: the device retries later
		}
		ws.send(encodeServer({ t: stored ? "stored" : "missing", name: f.name }));
	}

	// Devices report which versions stopped or started being current; the Worker's clock says when. The answer names
	// each version called current, or asked about (no flags), that has a recorded chunk missing, worked out from what is
	// stored every time.
	private mark(ws: WebSocket, session: Session, f: Extract<ClientFrame, { t: "mark" }>): void {
		const now = Date.now(), missing: Uint8Array[] = [];
		// A full list confirms only retirements from before it began (its first frame says so): a version this device
		// listed as current in an earlier frame, and that another device retired since, isn't confirmed by it.
		if ((f.flags & MARK.current) && (f.flags & MARK.start)) session = { ...session, listFrom: now };
		this.ctx.storage.transactionSync(() => {
			for (const tag of f.tags) {
				if (f.flags & MARK.current) this.write("UPDATE versions SET retired_at = NULL, deleted = 0 WHERE tag = ? AND retired_at IS NOT NULL", tag);
				else if (f.flags & MARK.retired) {
					this.write("UPDATE versions SET retired_at = ?, deleted = ? WHERE tag = ? AND retired_at IS NULL", now, f.flags & MARK.deleted ? 1 : 0, tag);
					continue;
				}
				// Called current, or only asked about (no flag: Recently deleted leaves out what Clean up removed).
				if (this.sql.exec("SELECT 1 FROM version_chunks v WHERE v.tag = ? AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.name = v.name) LIMIT 1", tag).toArray().length) missing.push(tag);
			}
			// The end of a caught-up device's full list: as far as it knows, nothing retired before it began is current.
			if ((f.flags & MARK.last) && session.live && session.device) {
				this.write("INSERT INTO lists (device, at) VALUES (?, ?) ON CONFLICT(device) DO UPDATE SET at = max(at, excluded.at)", session.device, session.listFrom ?? now);
				// The lists of devices not seen in 30 days count no more: a few go with each list.
				this.touchOpen();
				this.write("DELETE FROM lists WHERE device IN (SELECT l.device FROM lists l LEFT JOIN devices d ON d.id = l.device WHERE d.id IS NULL OR d.last_online < ? LIMIT 64)", now - SCOPED_SINCE_MS);
			}
		});
		if (f.flags & MARK.last) session = { ...session, listFrom: undefined };
		ws.serializeAttachment(session);
		ws.send(encodeServer({ t: "marked", id: f.id, tags: missing }));
	}

	/**
	 * Whether a 0.2.0 device may upload version-scoped chunks: a 0.1.5 device can't read them. Every device seen in the
	 * last 30 days, other than the one asking, must report 0.2.0 or later; no version on record counts as old. The list
	 * keeps the newest 64: when all of them are that recent, an older device may have fallen off it, so that counts as old too.
	 */
	private scoped(asking: string | null): boolean {
		this.touchOpen();
		const since = Date.now() - SCOPED_SINCE_MS;
		const all = this.sql.exec<{ n: number; oldest: number | null }>("SELECT COUNT(*) AS n, MIN(last_online) AS oldest FROM devices").one();
		if (all.n >= MAX_DEVICES && (all.oldest ?? 0) >= since) return false;
		const recent = this.sql.exec<{ version: string }>("SELECT version FROM devices WHERE last_online >= ? AND id != ?", since, asking ?? "").toArray();
		return recent.every((d) => newer(d.version.split(" ")[0] ?? "", "0.2.0"));
	}

	/**
	 * Retirements before this may be cleaned up: every device seen in the last 30 days has listed what it holds current
	 * since. One device's list isn't enough: a device away meanwhile may bring a deleted attachment back with its own
	 * offline edit, its deleted version as the head again. (No device seen that long: the latest list.)
	 */
	private listedAt(): number {
		this.touchOpen();
		const since = Date.now() - SCOPED_SINCE_MS;
		// As in scoped: a full device list may have lost a device seen lately, which then hasn't listed.
		const all = this.sql.exec<{ n: number; oldest: number | null }>("SELECT COUNT(*) AS n, MIN(last_online) AS oldest FROM devices").one();
		if (all.n >= MAX_DEVICES && (all.oldest ?? 0) >= since) return 0;
		const recent = this.sql.exec<{ at: number | null; n: number }>(
			"SELECT MIN(COALESCE(l.at, 0)) AS at, COUNT(*) AS n FROM devices d LEFT JOIN lists l ON l.device = d.id WHERE d.last_online >= ?", since,
		).one();
		return recent.n ? recent.at ?? 0 : this.sql.exec<{ at: number | null }>("SELECT MAX(at) AS at FROM lists").one().at ?? 0;
	}

	// A device connected without a break is seen now, however long ago it connected (last online is set on status and close).
	private touchOpen(): void {
		const now = Date.now();
		for (const ws of this.ctx.getWebSockets()) {
			const device = (ws.deserializeAttachment() as Session).device;
			if (device) this.write("UPDATE devices SET last_online = ? WHERE id = ?", now, device);
		}
	}

	// After genesis, liveness comes from the table. Orphaned scoped uploads are dated per chunk;
	// old uploads without a timestamp stay out of both the dashboard total and the delete query.
	private cleanupCandidates(): { query: string; args: number[] } {
		const scoped = "FROM versions v JOIN version_chunks vc ON vc.tag = v.tag JOIN chunks c ON c.name = vc.name";
		if (this.migrated) return {
			query: `SELECT c.name, length(c.envelope) AS size, v.deleted, COALESCE(v.retired_at, c.uploaded_at) AS at ${scoped}
				WHERE v.expected_chunks IS NOT ? AND NOT EXISTS (SELECT 1 FROM attachments WHERE version = v.tag AND version != x'' AND deleted IS NULL)`,
			args: [LEGACY_CHUNKS],
		};
		return { query: `SELECT c.name, length(c.envelope) AS size, v.deleted, v.retired_at AS at ${scoped} WHERE v.retired_at < ?`, args: [this.listedAt()] };
	}

	/**
	 * For Clean up on the owner's dashboard (an RPC from the Owner object, which checked the session and Origin): the
	 * history that can be removed, by the quarter hour it stopped being current in. Every time zone's midnight falls
	 * on a quarter hour, so the browser groups these into its own local months, quarters, half-years and years.
	 */
	async cleanupSizes(): Promise<{ at: number; old: number; deleted: number }[]> {
		if (this.token === null || this.deleted) return [];
		const { query, args } = this.cleanupCandidates();
		return this.sql.exec<{ at: number; old: number; deleted: number }>(
			`SELECT at / 900000 * 900000 AS at, SUM(CASE WHEN deleted THEN 0 ELSE size END) AS old, SUM(CASE WHEN deleted THEN size ELSE 0 END) AS deleted
			FROM (${query}) WHERE at IS NOT NULL GROUP BY 1 ORDER BY 1`, ...args,
		).toArray();
	}

	/**
	 * Clean up: removes the chunks of versions that stopped being current within `ranges` ([from, to) in ms), all of
	 * them before the current period (`months` long, in time zone `zone`) began on this Worker's clock, and only where
	 * a full list since confirmed it. Never a current version, nor an old-style chunk (it has no tag). The
	 * version_chunks rows stay: that is how a missing chunk is known later. At most `limit` chunks; `more` says ask again.
	 */
	async cleanUp(ranges: unknown, zone: unknown, months: unknown, now = Date.now(), limit = CLEANUP_PER_REQUEST): Promise<{ removed: number; more: boolean } | { error: string }> {
		if (this.token === null || this.deleted) return { error: "no such vault" };
		if (months !== 1 && months !== 3 && months !== 6 && months !== 12) return { error: "bad period" };
		let start: number;
		try { start = periodStart(now, String(zone), months); } catch { return { error: "bad time zone" }; }
		const ok = (r: unknown): r is [number, number] => Array.isArray(r) && r.length === 2 && Number.isSafeInteger(r[0]) && Number.isSafeInteger(r[1]) && r[0] < r[1] && r[1] <= start;
		if (!Array.isArray(ranges) || !ranges.length || ranges.length > 1000 || !ranges.every(ok)) return { error: "Only past periods can be cleaned up." };
		const { query, args } = this.cleanupCandidates();
		let removed = 0;
		this.ctx.storage.transactionSync(() => {
			for (const [from, to] of ranges as [number, number][]) {
				const names = this.sql.exec<{ name: ArrayBuffer }>(
					`SELECT name FROM (${query}) WHERE at >= ? AND at < ? LIMIT ?`,
					...args, from, to, limit - removed,
				).toArray();
				for (const { name } of names) this.write("DELETE FROM chunks WHERE name = ?", name);
				removed += names.length;
				if (removed >= limit) break;
			}
		});
		return { removed, more: removed >= limit };
	}

	/** What the owner's dashboard shows of this vault: nothing a key would be needed for. */
	/**
	 * The vault's settings (DESIGN.md sections 8 and 9), set on the dashboard or carried over from a device. Null: not
	 * chosen yet, so uploads are taken as before 0.2.2 and each device follows its own earlier setting.
	 */
	private settings(): VaultSettings {
		const set = new Map(this.sql.exec<{ key: string; value: number }>("SELECT key, value FROM settings").toArray().map((r) => [r.key, !!r.value]));
		return { snapshots: set.get("snapshots") ?? null, historyBackup: set.get("historyBackup") ?? null };
	}

	async setSettings(given: unknown): Promise<{ ok: true } | { error: string }> {
		if (this.token === null || this.deleted) return { error: "no such vault" };
		const changes = settingsIn(given);
		if (!changes.length) return { error: "bad settings" };
		for (const [key, value] of changes) this.write("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, Number(value));
		return { ok: true };
	}

	/** Delete history backups on the dashboard (an RPC from the Owner object, which checked the session and Origin). */
	async clearHistory(): Promise<{ ok: true } | { error: string }> {
		if (this.token === null || this.deleted) return { error: "no such vault" };
		this.dropHistory("");
		return { ok: true };
	}

	/** Delete all vault snapshots on the dashboard, as a device's snapshot/delete with no ID does. */
	async clearSnapshots(): Promise<{ ok: true } | { error: string }> {
		if (this.token === null || this.deleted) return { error: "no such vault" };
		this.dropSnapshots(Date.now(), "");
		return { ok: true };
	}

	async stats(): Promise<VaultStats> {
		if (this.token === null && !this.deleted) return { bytes: 0, requestsToday: 0, rowsWrittenToday: 0, history: [], lastActivity: null, name: "", deleted: false, devices: [], settings: { snapshots: null, historyBackup: null }, snapshots: [], historyCopies: { copies: 0, bytes: 0 } };
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
			settings: this.settings(),
			migration: this.deleted ? undefined : this.migrated ? "complete" : this.migrationFailureDay === today() ? "failedToday" : this.migrationRequested() ? "requested" : "legacy",
			// Complete snapshots, newest first; history copies only as totals (the Worker doesn't know which device made one).
			snapshots: this.sql.exec<{ at: number; size: number }>("SELECT at, size FROM snapshots WHERE received = parts ORDER BY day DESC").toArray(),
			historyCopies: this.sql.exec<{ copies: number; bytes: number }>("SELECT COUNT(*) AS copies, COALESCE(SUM(size), 0) AS bytes FROM history").one(),
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
		for (const table of ["entries", "auth", "records", "recovery", "chunks", "history", "snapshot_parts", "snapshots", "removed_snapshots", "devices", "usage", "usage_days", "vault_name", "versions", "version_chunks", "lists", "settings", "attachments", "attachment_answers", "genesis_parts"]) this.sql.exec(`DELETE FROM ${table}`);
		this.sql.exec("INSERT OR REPLACE INTO tombstone (id, at) VALUES (0, ?)", Date.now());
		this.deleted = true;
		this.token = null;
		this.historyBytes = undefined;
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
		if (this.token === null) return; // no vault here (or deleted): write nothing
		this.flushedAt = Date.now();
		const u = this.usage;
		u.rows += 2; // these writes
		this.sql.exec("INSERT OR REPLACE INTO usage (id, day, requests, rows, last_activity, flushed_at) VALUES (0, ?, ?, ?, ?, ?)", u.day, u.requests, u.rows, u.lastActivity, this.flushedAt);
		// The last two weeks, day by day, for the dashboard's activity bars.
		this.sql.exec("INSERT OR REPLACE INTO usage_days (day, requests, rows) VALUES (?, ?, ?)", u.day, u.requests, u.rows);
		this.sql.exec("DELETE FROM usage_days WHERE day <= ?", u.day - HISTORY_DAYS);
	}

	private sendRecords(ws: WebSocket, from: number): void {
		if (this.token === null) return void ws.send(encodeServer({ t: "records", recovery: new Uint8Array(0) })); // no vault (yet): no records
		for (const r of this.sql.exec<{ number: number; blob: ArrayBuffer }>("SELECT number, blob FROM records WHERE number >= ? ORDER BY number", from)) {
			ws.send(encodeServer({ t: "record", number: r.number, blob: new Uint8Array(r.blob) }));
		}
		const recovery = this.sql.exec<{ sealed: ArrayBuffer }>("SELECT sealed FROM recovery").toArray()[0];
		ws.send(encodeServer({ t: "records", recovery: recovery ? new Uint8Array(recovery.sealed) : new Uint8Array(0) }));
	}

	// One page of what the device is missing. No await in here, so nothing is published in the middle of it.
	private subscribe(ws: WebSocket, session: Session, after: number): void {
		ws.serializeAttachment({ ...session, subscribed: true, live: false });
		let rows = 0, bytes = 0, last = after;
		for (const r of this.sql.exec<Row>("SELECT seq, doc, snapshot, envelope FROM entries WHERE seq > ? ORDER BY seq LIMIT ?", after, PAGE_ROWS + 1)) {
			if (rows === PAGE_ROWS || bytes >= PAGE_BYTES) return ws.send(encodeServer({ t: "more", seq: last }));
			rows++;
			last = r.seq;
			bytes += r.envelope.byteLength;
			ws.send(encodeServer({ t: "entry", seq: r.seq, doc: new Uint8Array(r.doc), snapshot: r.snapshot === 1, envelope: new Uint8Array(r.envelope) }));
		}
		ws.send(encodeServer({ t: "synced", seq: this.head }));
		ws.serializeAttachment({ ...session, subscribed: true, live: true });
	}
}

const owner = (env: Env) => env.OWNER.get(env.OWNER.idFromName("owner"));
const today = () => Math.floor(Date.now() / DAY_MS); // days since the epoch, so a new one starts at 00:00 UTC
/** The known vault settings in `given` that are booleans; anything else is ignored. */
const settingsIn = (given: unknown) => (["snapshots", "historyBackup"] as const).flatMap((key) => {
	const value = (given as Record<string, unknown> | null | undefined)?.[key];
	return typeof value === "boolean" ? [[key, value] as const] : [];
});
/** Whether release `version` ("1.2.3") is `than` or later; anything else (a pre-release, nothing) counts as older. */
function newer(version: string, than: string): boolean {
	const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(version), b = than.split(".").map(Number);
	if (!a) return false;
	for (let i = 0; i < 3; i++) if (Number(a[i + 1]) !== b[i]) return Number(a[i + 1]) > b[i]!;
	return true;
}
/**
 * When the calendar period holding `now` began in time zone `zone` (an IANA name; throws if unknown): local midnight
 * on the first of its month, quarter (`months` 3), half-year (6) or year (12). Clean up only touches what came before.
 */
export function periodStart(now: number, zone: string, months: 1 | 3 | 6 | 12): number {
	const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
	// An instant's wall-clock time in the zone, written as if it were UTC.
	const wall = (t: number) => {
		const p = Object.fromEntries(format.formatToParts(t).map((x) => [x.type, Number(x.value)]));
		return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
	};
	const local = new Date(wall(now)), month = local.getUTCMonth();
	const start = Date.UTC(local.getUTCFullYear(), month - (month % months), 1);
	// The instant with that wall-clock time: the zone's offset there, found from a first guess.
	const guess = start - (wall(start) - start);
	return start - (wall(guess) - guess);
}
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
			(id) => this.env.VAULT.get(this.env.VAULT.idFromName(id)) as unknown as VaultRpc,
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
