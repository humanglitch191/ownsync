// A simulated world for the sync engine: devices with an in-memory disk and database, a server that follows
// the mailbox rules, and a network the test moves one message at a time. A device can crash in the middle
// of any operation; whatever it hadn't committed is gone, and its disk is as it was at that instant.

import { NoteSession } from "../src/core/table/noteSession";
import { Files } from "./table-sim";

// The plugin uses window's timers (they work in Obsidian's pop-out windows); in Node, the global ones are those.
(globalThis as { window?: unknown }).window ??= globalThis;
import * as Y from "yjs";
import { Engine, type EngineOptions } from "../src/core/engine";
import type { ClientMsg, Entry, ServerMsg, Store } from "../src/core/ports";
import type { KeyPorts, KeyState } from "../src/keys";

/** A note's text, or an attachment's bytes. */
export type Content = string | Uint8Array;
export function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000;
}

export class Crashed extends Error {}

export class Server {
	rows: { seq: number; entry: Entry }[] = [];
	head = 0;
	chunks = new Map<string, Uint8Array>();
	conns = new Map<Device, { up: ClientMsg[]; down: ServerMsg[]; live: boolean }>();
	handle(from: Device, msg: ClientMsg): void {
		const conn = this.conns.get(from);
		if (!conn) return;
		const others = (m: ServerMsg) => { for (const [dev, c] of this.conns) if (dev !== from && c.live) c.down.push(m); };
		if (msg.t === "subscribe") {
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
}

export class Device {
	files = new Map<string, { content: Content; mtime: number }>();
	data = new Map<string, unknown>();
	engine: Engine | null = null;

	events: (() => void)[] = []; // file events the engine has been told about but hasn't started handling
	problems: string[] = [];
	/** Engine options a test wants different from the simulator's defaults. */
	overrides: Partial<EngineOptions> = {};
	/** How many of the next database commits fail, as a full or broken IndexedDB would. */
	failCommits = 0;
	private clock = 1;
	private life = { dead: true };

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
	storedText(id: string): string {
		const state = this.data.get(`state:${id}`) as Uint8Array | undefined;
		const doc = new Y.Doc();
		if (state) Y.applyUpdate(doc, state);
		const text = doc.getText("t").toString();
		doc.destroy();
		return text;
	}
	// --- the app's life ---
	boot(): void {
		this.life = { dead: false };
		const life = this.life;
		const step = () => {
			if (life.dead) throw new Crashed();
		};
		const store: Store = {
			get: async <T>(key: string) => (step(), structuredClone(this.data.get(key)) as T | undefined),
			list: async <T>(prefix: string) => (step(), [...this.data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T] as [string, T])),
			commit: async (puts, deletes) => {
				step(); // all or nothing
				if (this.failCommits > 0 && this.failCommits--) throw new Error("the local database refused a write");

				for (const k of deletes) this.data.delete(k);
				for (const [k, v] of puts) this.data.set(k, structuredClone(v));
			},
		};
		const engine = (this.engine = new Engine(store, {
			tableNotes: new NoteSession(store), noteDisk: new Files(),
			newId: () => Array.from({ length: 4 }, () => Math.floor(this.random() * 0x10000).toString(16).padStart(4, "0")).join(""),
			random: this.random,
			now: () => this.clock,
			snapshotAfter: 4,
			onProblem: (what, err) => { if (!(err instanceof Crashed)) this.problems.push(`${this.name} ${what}: ${err instanceof Error ? err.stack : String(err)}`); },
			defer: (start) => this.events.push(start),
			...this.overrides,
		}));

		void engine.start();
	}

	crash(): void {
		this.life.dead = true;
		this.engine = null;
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
		if (msg) this.server.handle(this, msg);
		return !!msg;
	}
	pumpDown(): boolean {
		const msg = this.server.conns.get(this)?.down.shift();
		if (msg) {
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
