// A simulated world for the sync engine: devices with an in-memory disk and database, a server that follows
// the mailbox rules, and a network the test moves one message at a time. A device can crash in the middle
// of any operation; whatever it hadn't committed is gone, and its disk is as it was at that instant.

import { createHash } from "node:crypto";

// The plugin uses window's timers (they work in Obsidian's pop-out windows); in Node, the global ones are those.
(globalThis as { window?: unknown }).window ??= globalThis;
import * as Y from "yjs";
import { Engine, type EngineOptions } from "../src/core/engine";
import type { ClientMsg, Disk, DiskFile, Entry, ServerMsg, Store } from "../src/core/ports";
import type { KeyPorts, KeyState } from "../src/keys";

/** A note's text, or an attachment's bytes. */
export type Content = string | Uint8Array;
/** Bytes as a string, one character per byte: comparable, and readable in failures. */
export const latin1 = (c: Content) => (typeof c === "string" ? c : String.fromCharCode(...c));
export const bytes = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

export function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000;
}

class Crashed extends Error {}

export class Server {
	rows: { seq: number; entry: Entry }[] = [];
	head = 0;
	chunks = new Map<string, Uint8Array>();
	conns = new Map<Device, { up: ClientMsg[]; down: ServerMsg[]; live: boolean; listFrom?: number }>();
	// Version-scoped chunks and Clean up, as the Worker keeps them (DESIGN.md section 10), on a clock the test moves.
	clock = 1;
	versions = new Map<string, { retiredAt: number | null; deleted: boolean }>();
	versionChunks = new Map<string, string>(); // chunk name → its version's tag
	lists = new Map<string, number>(); // device → when its latest full list of current versions began
	seen = new Map<string, number>(); // device → when it was last connected
	removed = new Set<string>(); // chunks Clean up removed

	handle(from: Device, msg: ClientMsg): void {
		const conn = this.conns.get(from);
		if (!conn) return;
		this.seen.set(from.name, this.clock);
		const others = (m: ServerMsg) => { for (const [dev, c] of this.conns) if (dev !== from && c.live) c.down.push(m); };
		if (msg.t === "put" && msg.tag) {
			// A name is recorded under the tag only if this put stored it, or it is that tag's already.
			const owner = this.versionChunks.get(msg.name), stored = owner === undefined ? !this.chunks.has(msg.name) : owner === msg.tag;
			if (stored) {
				if (!this.chunks.has(msg.name)) this.chunks.set(msg.name, msg.data.slice());
				this.versionChunks.set(msg.name, msg.tag);
				this.versions.set(msg.tag, { retiredAt: null, deleted: false });
			}
			conn.down.push({ t: stored ? "stored" : "missing", name: msg.name });
		} else if (msg.t === "put") {
			if (!this.chunks.has(msg.name)) this.chunks.set(msg.name, msg.data.slice());
			conn.down.push({ t: "stored", name: msg.name });
		} else if (msg.t === "mark") {
			const missing: string[] = [];
			if (msg.state === "current") conn.listFrom ??= this.clock;
			for (const tag of msg.tags) {
				const v = this.versions.get(tag);
				if (msg.state === "current") {
					if (v) Object.assign(v, { retiredAt: null, deleted: false });
					if (this.missing(tag)) missing.push(tag);
				} else if (v && v.retiredAt === null) Object.assign(v, { retiredAt: this.clock, deleted: msg.state === "deleted" });
			}
			if (msg.last) {
				if (conn.live) this.lists.set(from.name, Math.max(this.lists.get(from.name) ?? 0, conn.listFrom ?? this.clock));
				conn.listFrom = undefined;
			}
			conn.down.push({ t: "marked", id: msg.id, tags: missing });
		} else if (msg.t === "get") {
			const data = this.chunks.get(msg.name);
			conn.down.push(data ? { t: "chunk", name: msg.name, data: data.slice() } : { t: "missing", name: msg.name });
		} else if (msg.t === "subscribe") {
			// Pages of 3, to exercise paging. Snapshots are never skipped: a device's position says how far it
			// has read, not that it holds entries a snapshot replaced before it got there.
			const rows = this.rows.filter((r) => r.seq > msg.after);
			for (const r of rows.slice(0, 3)) conn.down.push({ t: "entry", seq: r.seq, entry: r.entry });
			if (rows.length > 3) return void conn.down.push({ t: "more", seq: rows[2]!.seq });
			conn.down.push({ t: "synced", seq: this.head });
			conn.live = true;
		} else if (msg.t === "publish") {
			const seq = ++this.head;
			this.rows.push({ seq, entry: msg.entry });
			conn.down.push({ t: "ack", id: msg.id, seq });
			others({ t: "entry", seq, entry: msg.entry });
		} else if (msg.t === "live") others({ t: "live", entry: msg.entry });
		else if (msg.t === "snapshot" && msg.base <= this.head) {
			// The snapshot contains every entry of its document up to `base`: those can go.
			this.rows = this.rows.filter((r) => !(r.entry.doc === msg.doc && r.seq <= msg.base));
			this.rows.push({ seq: ++this.head, entry: { doc: msg.doc, kind: "snapshot", data: msg.data } });
		}
	}

	private missing(tag: string): boolean {
		for (const [name, t] of this.versionChunks) if (t === tag && !this.chunks.has(name)) return true;
		return false;
	}

	/** Retirements before this are confirmed: every device seen in the last 30 days has listed what it holds current since. */
	get listedAt(): number {
		const recent = [...this.seen].filter(([, at]) => at >= this.clock - 30 * 86_400_000).map(([d]) => this.lists.get(d) ?? 0);
		return recent.length ? Math.min(...recent) : Math.max(0, ...this.lists.values());
	}

	/** Clean up, as the Worker does it: chunks of versions retired in [from, to), before now, and confirmed. */
	cleanUp(from: number, to: number): number {
		if (to > this.clock) throw new Error("only the past can be cleaned up");
		let n = 0;
		for (const [name, tag] of this.versionChunks) {
			const at = this.versions.get(tag)?.retiredAt ?? null;
			if (at !== null && at >= from && at < to && at < this.listedAt && this.chunks.delete(name)) {
				this.removed.add(name);
				n++;
			}
		}
		return n;
	}
}

/** Engine options for devices that upload version-scoped chunks and report versions (Ownsync 0.2.0 on a 0.2.0 Worker). */
export const SCOPED: Partial<EngineOptions> = {
	versionTag: async (u) => `tag-${createHash("sha256").update(`version ${u}`).digest("hex").slice(0, 8)}`,
	reports: () => true,
	scoped: () => true,
};

export class Device {
	files = new Map<string, { content: Content; mtime: number }>();
	data = new Map<string, unknown>();
	engine: Engine | null = null;
	editors = new Map<string, Y.Doc>();
	events: (() => void)[] = []; // file events the engine has been told about but hasn't started handling
	problems: string[] = [];
	/** Called after the engine reads a file: the test may change that file "at the same moment". */
	onRead: ((path: string) => void) | null = null;
	/** Set by a test to see what the engine does to the disk and database. */
	trace: ((line: string) => void) | null = null;
	/** Engine options a test wants different from the simulator's defaults. */
	overrides: Partial<EngineOptions> = {};
	/** How many of the next database commits fail, as a full or broken IndexedDB would. */
	failCommits = 0;
	private clock = 1;
	private life = { dead: true, fuse: Infinity };

	constructor(readonly name: string, readonly server: Server, private readonly random: () => number) {}

	get alive(): boolean {
		if (this.engine && this.life.dead) this.crash();
		return !!this.engine;
	}
	get online(): boolean {
		return this.server.conns.has(this);
	}

	// --- what a user (or another app) does to the vault folder ---
	// Obsidian announces each change at once; the engine gets round to it later (see `events`).
	write(path: string, content: Content): void {
		this.files.set(path, { content, mtime: this.clock++ });
		if (this.alive) this.engine!.diskChanged(path);
	}
	remove(path: string): void {
		this.files.delete(path);
		if (this.alive) this.engine!.diskChanged(path);
	}
	rename(from: string, to: string): void {
		this.files.set(to, this.files.get(from)!);
		this.files.delete(from);
		if (this.alive) this.engine!.diskRenamed(from, to);
	}
	pathOf(id: string): string | undefined {
		return [...this.files.keys()].find((p) => this.engine?.noteAt(p) === id);
	}
	storedText(id: string): string {
		const state = this.data.get(`state:${id}`) as Uint8Array | undefined;
		const doc = new Y.Doc();
		if (state) Y.applyUpdate(doc, state);
		return doc.getText("t").toString();
	}
	storedIndex(): Map<string, { p: string; d?: string }> {
		const state = this.data.get("index") as Uint8Array | undefined;
		const doc = new Y.Doc();
		if (state) Y.applyUpdate(doc, state);
		const index = new Map(doc.getMap<{ p: string; d?: string }>("notes"));
		doc.destroy();
		return index;
	}

	// --- the app's life ---
	boot(): void {
		this.life = { dead: false, fuse: Infinity };
		const life = this.life;
		const step = () => {
			if (life.dead || --life.fuse <= 0) {
				life.dead = true;
				throw new Crashed();
			}
		};
		const stat = (path: string): DiskFile | undefined => {
			const f = this.files.get(path);
			return f && { path, mtime: f.mtime, size: f.content.length };
		};
		// A note read as bytes, or an attachment as text, is an engine bug.
		const read = <T extends Content>(path: string, kind: "string" | "object"): T => {
			step();
			const f = this.files.get(path);
			if (!f) throw new Error(`no file ${path}`);
			if (typeof f.content !== kind) throw new Error(`${path} read as the wrong kind of file`);
			const content = f.content;
			this.onRead?.(path);
			return content as T;
		};
		// The engine's own changes are announced back to it, as Obsidian does.
		const write = (path: string, content: Content): DiskFile => {
			step();
			this.trace?.(`${this.name} engine writes ${path} = ${latin1(content)}`);
			this.files.set(path, { content, mtime: this.clock++ });
			engine.diskChanged(path);
			return stat(path)!;
		};
		const disk: Disk = {
			list: async () => (step(), [...this.files.keys()].map((p) => stat(p)!)),
			stat: async (path) => (step(), stat(path)),
			read: async (path) => read<string>(path, "string"),
			readBinary: async (path) => read<Uint8Array>(path, "object").slice(),
			write: async (path, content) => write(path, content),
			writeBinary: async (path, content) => write(path, content.slice()),
			remove: async (path) => {
				step();
				this.trace?.(`${this.name} engine removes ${path}`);
				this.files.delete(path);
				engine.diskChanged(path);
			},
			rename: async (from, to) => {
				step();
				this.trace?.(`${this.name} engine renames ${from} → ${to}`);
				if (this.files.has(to)) throw new Error(`rename onto existing ${to}`);
				if (!this.files.has(from)) throw new Error(`rename of missing ${from}`); // as a real disk would
				this.files.set(to, this.files.get(from)!);
				this.files.delete(from);
				engine.diskRenamed(from, to);
			},
		};
		const store: Store = {
			get: async <T>(key: string) => (step(), structuredClone(this.data.get(key)) as T | undefined),
			list: async <T>(prefix: string) => (step(), [...this.data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T] as [string, T])),
			commit: async (puts, deletes) => {
				step(); // all or nothing
				if (this.failCommits > 0 && this.failCommits--) throw new Error("the local database refused a write");
				this.trace?.(`${this.name} commits ${[...puts].map(([k, v]) => (k.startsWith("note:") ? `${k}@${(v as { diskPath?: string }).diskPath ?? "-"}` : k)).join(" ")}${[...deletes].length ? ` del ${[...deletes].join(" ")}` : ""}`);
				for (const k of deletes) this.data.delete(k);
				for (const [k, v] of puts) this.data.set(k, structuredClone(v));
			},
		};
		const engine = (this.engine = new Engine(store, disk, {
			hash: async (text) => text, // exact, and readable in failures
			chunkName: async (data, scope) => createHash("sha256").update(scope ? `${scope.u} ${scope.i} ` : "").update(data).digest("hex").slice(0, 12),
			chunkSize: 4, // so most attachments are several chunks
			newId: () => Array.from({ length: 4 }, () => Math.floor(this.random() * 0x10000).toString(16).padStart(4, "0")).join(""),
			random: this.random,
			now: () => this.clock,
			snapshotAfter: 4,
			onProblem: (what, err) => { if (!(err instanceof Crashed)) this.problems.push(`${this.name} ${what}: ${err instanceof Error ? err.stack : String(err)}`); },
			onClosed: (id) => this.editors.delete(id),
			defer: (start) => this.events.push(start),
			...this.overrides,
		}));
		this.trace?.(`${this.name} session client ${(engine as unknown as { clientId: number }).clientId}`);
		void engine.start();
	}

	/** This device's clock moves on (a day, say), as its own `now` sees it. */
	passTime(ms: number): void {
		this.clock += ms;
	}

	/** Crash now, or after `fuse` more disk or database calls (in the middle of whatever it's doing then). */
	crash(fuse = 0): void {
		if (fuse > 0) return void (this.life.fuse = fuse);
		this.life.dead = true;
		this.engine = null;
		this.editors.clear();
		this.events = [];
		this.server.conns.delete(this);
	}

	connect(): void {
		if (!this.alive || this.online) return;
		const conn = { up: [] as ClientMsg[], down: [] as ServerMsg[], live: false };
		this.server.conns.set(this, conn);
		void this.engine!.connected({ send: (msg) => { if (this.server.conns.get(this) === conn) conn.up.push(msg); } });
	}
	disconnect(): void {
		if (!this.online) return;
		this.server.conns.delete(this);
		void this.engine?.disconnected();
	}
	/** Move one message in each direction; returns whether anything moved. */
	pumpUp(): boolean {
		const msg = this.server.conns.get(this)?.up.shift();
		if (msg) {
			this.trace?.(`${this.name} → server ${msg.t}${msg.t === "subscribe" ? ` after ${msg.after}` : msg.t === "snapshot" ? ` ${msg.doc.slice(0, 6)} base ${msg.base}` : msg.t === "mark" ? ` ${msg.state}${msg.last ? " last" : ""} ${msg.tags.length}` : "name" in msg ? ` ${msg.name}` : ` ${msg.entry.doc.slice(0, 6)}`}`);
			this.server.handle(this, msg);
		}
		return !!msg;
	}
	pumpDown(): boolean {
		const msg = this.server.conns.get(this)?.down.shift();
		if (msg) {
			this.trace?.(`${this.name} ← server ${msg.t}${"seq" in msg ? ` ${msg.seq}` : ""}${"entry" in msg ? ` ${msg.entry.doc.slice(0, 6)}${msg.entry.kind === "snapshot" ? " snapshot" : ""}` : ""}${"name" in msg ? ` ${msg.name}` : ""}`);
			this.drain();
			void this.engine?.receive(msg);
		}
		return !!msg;
	}
	/**
	 * Start handling every announced file event. The real engine handles its inputs strictly in arrival
	 * order, so anything else given to it must come after the file events announced before.
	 */
	drain(): boolean {
		const waiting = this.events.splice(0);
		for (const start of waiting) start();
		return waiting.length > 0;
	}
	async idle(): Promise<void> {
		await this.engine?.idle();
		this.alive; // notices a crash that happened mid-operation
	}
}

/** A device's keys kept in memory, where the plugin uses IndexedDB and Obsidian's secret storage. */
export function memoryPorts(ring: string | null = null): KeyPorts {
	let state: KeyState | undefined;
	return {
		load: async () => state,
		save: async (s) => { state = s; },
		loadRing: () => ring,
		saveRing: (r) => { ring = r; },
	};
}

/** Run until nothing is left to do anywhere. */
export async function quiesce(devs: Device[]): Promise<void> {
	for (let quiet = 0, rounds = 0; quiet < 3; rounds++) {
		if (rounds > 5000) throw new Error("did not settle");
		let moved = false;
		for (const d of devs) {
			if (d.drain()) moved = true;
			while (d.pumpUp()) moved = true;
			while (d.pumpDown()) moved = true;
			await d.idle();
		}
		quiet = moved ? 0 : quiet + 1;
	}
}
