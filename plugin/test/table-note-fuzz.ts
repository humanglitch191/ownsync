// Exercise the production note planner, table client and disk journal. The two
// subscriptions are independent: pumping the text stream needn't deliver a row.
import assert from "node:assert/strict";
import * as Y from "yjs";
import { chunkName, hex, KIND, openEnvelope, sealEnvelope } from "../../protocol/ownsync";
import { decodeClient, type AttachmentRow, type ServerFrame } from "../../server/src/wire";
import { LegacyProjection } from "../src/core/table/migration";
import type { NoteRow } from "../src/core/table/notes";
import type { VaultKeys } from "../src/keys";
import { TableDisk } from "../src/tableDisk";
import { TableSync } from "../src/tableSync";
import type { VaultNoteState } from "../src/core/table/notePlanner";
import { Crashed, Device, Server, quiesce, rng } from "./sim";
import { attachmentFs } from "./table-fs";
import { enc, hash } from "./table-sim";

const vmk = new Uint8Array(32), vaultId = new Uint8Array(16);
const keys = { vmk, vaultId, epoch: 0, state: {}, me: { id: vaultId }, keyFor: () => vmk } as unknown as VaultKeys;
const now = Date.UTC(2025, 4, 1);
type Side = "before" | "after";
type Effect = "writeTemp" | "installTemp" | "moveIf" | "removeIf";
interface Peer { d: Device; sync: TableSync; cursor: number; lose: boolean; fault?: { effect: Effect; side: Side } }

export const noteCoverage = { migrated: 0, copiedJoins: 0, lostAnswers: 0, replays: 0, offlineMoves: 0,
	liveRenames: 0, deleteEdits: 0, restoreEdits: 0, heldNotices: 0, crashes: {} as Record<string, number> };

function unresolvedCopies(state: VaultNoteState, id: string) {
	return [...state.notes.values()].filter(n => n.copyOf === id && n.conflictOriginPath !== undefined
		&& (!n.diskPath || n.diskPath === n.conflictOriginPath) && n.row?.deleted == null && n.change?.t !== "del");
}

// Note branch of the Worker's CAS. Keep every committed envelope for live delivery;
// since() after reconnect returns only each file's latest row, in sequence order.
class NoteWorker {
	restores: { file: string; peer: Peer; base: number; seq: number }[] = [];
	entries: AttachmentRow[] = [];
	rows = new Map<string, AttachmentRow>();
	answers = new Map<string, number>();
	staged = new Map<string, Uint8Array>();
	constructor(readonly text: Server) {}
	store(row: AttachmentRow) {
		assert.equal(row.seq, this.entries.length + 1);
		this.rows.set(hex(row.file), row); this.entries.push(row);
	}
	async request(peer: Peer, packet: Uint8Array): Promise<ServerFrame> {
		const f = decodeClient(packet);
		if (f.t === "vput") {
			this.staged.set(hex(f.name), f.envelope); return { t: "stored", name: f.name };
		}
		if (f.t === "get") {
			const staged = this.staged.get(hex(f.name));
			if (staged) return { t: "chunk", name: f.name, envelope: staged };
			const plaintext = this.text.chunks.get(hex(f.name));
			return plaintext ? { t: "chunk", name: f.name, envelope: await sealEnvelope({ vmk, vaultId, epoch: 0,
				deviceId: vaultId, docId: f.name, kind: KIND.chunk, plaintext }) } : { t: "missing", name: f.name };
		}
		if (f.t === "forget") { this.answers.delete(hex(f.req)); return { t: "forgotten", req: f.req }; }
		assert.ok(f.t === "set" || f.t === "del" || f.t === "restore");
		const req = hex(f.req), replay = this.answers.get(req);
		if (replay !== undefined) { noteCoverage.replays++; return { t: "ok", req: f.req, seq: replay }; }
		const row = this.rows.get(hex(f.file));
		const refuse = (holder = row): ServerFrame => ({ t: "refused", req: f.req, row: holder ?? null, missing: false });
		if ((row?.seq ?? null) !== f.base) return refuse();
		if (f.t !== "del") {
			const taken = [...this.rows.values()].find(r => r !== row && r.deleted === null && hex(r.pathkey) === hex(f.pathkey));
			if (taken) return refuse(taken);
		}
		if (f.t === "restore" ? !row || row.deleted === null : row?.deleted != null || (f.t === "del" && !row)) return refuse();
		assert.ok(f.record && (!row || row.version === null) && (f.t !== "set" || f.version === null));
		const seq = this.entries.length + 1;
		this.store({ seq, file: f.file, pathkey: f.t === "del" ? row!.pathkey : f.pathkey,
			record: f.record, version: null, deleted: f.t === "del" ? now : null });
		if (f.t === "restore") this.restores.push({ file: hex(f.file), peer, base: f.base, seq });
		this.answers.set(req, seq);
		if (peer.lose) { peer.lose = false; noteCoverage.lostAnswers++; throw new Error("injected lost answer"); }
		return { t: "ok", req: f.req, seq };
	}
}

export async function runNoteSeed(seed: number, steps: number | "held conflict" | "delete held") {
	const random = rng(seed), pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!;
	const server = new Server(), worker = new NoteWorker(server), peers: Peer[] = [], log: string[] = [];
	const required = new Set<string>();
	// A disk-only insertion can be inherited by successive copies before it ever enters Yjs.
	const diskAuthor = new Map<string, string>();
	const copied = new Map<string, { parent: string; markers: Set<string> }>();
	let offlineMove: { parent: string; file: string; child: string; markers: Set<string> } | undefined;
	const userRestores: { peer: Peer; base: number; head: number }[] = [];
	const markers = (text: string) => new Set(text.match(/<n\d+>/g) ?? []);
	const token = () => { const s = '<n' + required.size + '>'; required.add(s); return s; };
	const visible = (p: string) => !p.startsWith("."), note = (p: string) => visible(p) && p.endsWith(".md");
	const nextPath = (stem: string) => stem + "-" + (++serial) + ".md";
	let serial = 0;
	function device() {
		const d = new Device("d" + peers.length, server, rng(seed * 4 + peers.length));
		d.overrides = { now: () => now, hash: async text => hash(enc.encode(text)), chunkName: async b => hex(await chunkName(vmk, vaultId, b)) };
		return d;
	}
	function configure(p: Peer) {
		const d = p.d;
		const { fs, store } = attachmentFs(d.files, d.data);
		const commit = store.commit.bind(store);
		store.commit = async (puts, deletes) => {
			await commit(puts, deletes);
			// Capture inherited markers on the planner commit that creates the copy.
			for (const [k, v] of puts) {
				if (!k.startsWith("table/note-state/")) continue;
				const id = k.slice("table/note-state/".length), parent = (v as {copyOf?: string}).copyOf;
				if (parent && puts.has("state:" + id) && !copied.has(id)) {
					const source = markers(d.storedText(parent));
					const inherited = [...markers(d.storedText(id))].filter(marker => source.has(marker) || diskAuthor.get(marker) === parent);
					copied.set(id, { parent, markers: new Set(inherited) });
				}
			}
		};
		// The adapter's visible filesystem changes also wake Obsidian's planner.
		const rename = fs.rename.bind(fs), copy = fs.copy.bind(fs);
		fs.rename = async (from,to) => {
			await rename(from,to);
			if (note(from) && note(to)) d.engine?.diskRenamed(from,to);
			else if (note(from) || note(to)) d.engine?.diskChanged(note(from) ? from : to);
		};
		fs.copy = async (from,to) => { await copy(from,to); if (note(to)) d.engine?.diskChanged(to); };
		const disk = new TableDisk(fs, store, ".scratch/notes", note, async b => hash(b), (h,n) => p.sync.suffix(h,n), "table/note-fs");
		for (const effect of ["writeTemp", "installTemp", "moveIf", "removeIf"] as const) {
			// Freeze the engine's store too. An exception alone would let it commit
			// the intent as completed on its way out, unlike process death.
			const original = disk[effect].bind(disk) as (...args: unknown[]) => Promise<boolean>;
			const fault = (side: Side) => {
				if (p.fault?.effect !== effect || p.fault.side !== side) return;
				p.fault = undefined;
				const label = effect + "/" + side;
				noteCoverage.crashes[label] = (noteCoverage.crashes[label] ?? 0) + 1;
				p.sync.disconnect(); d.crash(); throw new Crashed();
			};
			const wrapped = async (...args: unknown[]) => {
				fault("before"); const done = await original(...args); if (done || effect === "writeTemp") fault("after"); return done;
			};
			if (effect === "writeTemp") disk.writeTemp = async bytes => { await wrapped(bytes); };
			else disk[effect] = wrapped;
		}
		const allowed = (p: string) => visible(p) && !note(p);
		const binary: TableDisk = new TableDisk(fs, store, ".scratch/attachments", allowed, b => p.sync.hash(b), (h,n) => p.sync.suffix(h,n));
		const sync = p.sync = new TableSync(store, keys, binary, allowed, true, 20 * 2**20,
			(what,e) => {
				if (e instanceof Error && (e.message === "injected lost answer" || (!d.online && e.message === "Offline"))) return;
				if (d.alive) d.problems.push(what + ": " + e);
			});
		Object.assign(d.overrides, { noteDisk: disk, tableNotes: sync.notes, tableHistory: sync, onNoteWork: () => sync.noteWork() });
		d.overrides.onProblem = (path, err) => {
			if (err instanceof Crashed) return;
			const state = sync.notes.state, id = state?.byPath.get(path);
			if (err instanceof Error && err.message === path + " has an unresolved conflict copy; resolve it to keep syncing this note's outside edits"
				&& state && id && state.notes.get(id)?.held && unresolvedCopies(state,id).length === 1
				&& typeof d.files.get(path)?.content === "string" && state.observed.get(path)?.text === d.files.get(path)!.content) {
				noteCoverage.heldNotices++;
			} else d.problems.push(path + ": " + err);
		};
	}
	function add(d = device()) {
		const p = { d, cursor: 0, lose: false } as Peer;
		peers.push(p); configure(p); return p;
	}
	async function boot(p: Peer) { configure(p); p.d.boot(); await p.d.idle(); }
	const active = () => peers.filter(p => p.d.online);
	async function wire(p: Peer) {
		const d = p.d;
		if (!d.alive) await boot(p);
		await d.engine!.useTable(await p.sync.nameKey());
		const after = await p.sync.connect(packet => worker.request(p, packet), d.engine!);
		d.connect();
		const head = worker.entries.length;
		const catchRows = async () => {
			for (const row of [...worker.rows.values()].filter(r => r.seq > after && r.seq <= head).sort((a,b) => a.seq-b.seq))
				await p.sync.row(row);
			p.cursor = head; await p.sync.ready(head);
		};
		const catchText = async () => { await quiesce([d]); await p.sync.notesCaughtUp(); };
		// Fetch the row page before doing any work that could advance its head.
		if (random() < .5) { await catchRows(); await catchText(); } else { await catchText(); await catchRows(); }
	}
	async function deliver(p: Peer) {
		const end = worker.entries.length;
		while (p.d.online && p.cursor < end) {
			try { await p.sync.row(worker.entries[p.cursor]!); }
			catch (e) { if (e instanceof Crashed && !p.d.alive) return; throw e; }
			p.cursor++;
		}
	}
	async function drain() {
		for (let pass = 0; ; pass++) {
			assert.ok(pass < 100, "note clients did not reach quiescence");
			const head = worker.entries.length, text = server.head;
			for (const p of active()) await deliver(p);
			await quiesce(active().map(p => p.d));
			for (const p of active()) { await p.sync.idle(); await p.d.idle(); }
			if (head === worker.entries.length && text === server.head && active().every(p => {
				const c = server.conns.get(p.d)!; return !c.up.length && !c.down.length && !p.d.events.length && p.cursor === head;
			})) break;
		}
	}
	const disconnect = (p: Peer) => { p.sync.disconnect(); p.d.disconnect(); };
	const paths = (p: Peer) => [...p.d.files.keys()].filter(note);
	const write = async (p: Peer, path: string) => {
		const before = p.d.files.get(path)?.content ?? ""; assert.equal(typeof before, "string");
		const suffix = token(); log.push(p.d.name + " types " + suffix + " at " + path);
		const placed = p.sync.notes.state?.byPath.get(path);
		if (placed) diskAuthor.set(suffix, placed);
		p.d.write(path, before + suffix); p.d.drain(); await p.d.idle();
	};
	async function check() {
		await drain();
		// A held edit needs an explicit user decision before all disks can agree.
		// Keep the copy under a fresh name and run the ordinary convergence oracle.
		const resolved = new Set<string>();
		for (;;) {
			let acted = false;
			for (const p of peers) {
				const state = p.sync.notes.state!, held = [...state.notes.values()].find(n => n.held);
				if (!held) continue;
				assert.ok(held.diskPath && p.d.files.has(held.diskPath), "held edit lost its disk file");
				assert.equal(p.d.files.get(held.diskPath)!.content,state.observed.get(held.diskPath)?.text);
				const copies = unresolvedCopies(state,held.id);
				assert.equal(copies.length,1);
				const copy = copies[0]!;
				assert.ok(copy.diskPath && p.d.files.has(copy.diskPath) && !resolved.has(copy.id), "held copy cannot be resolved");
				resolved.add(copy.id);
				p.d.rename(copy.diskPath,nextPath("resolved"));
				await drain();
				acted = true;
			}
			if (!acted) break;
		}
		const docs = new Map<string,Y.Doc>(), rows = new Map<string, NoteRow>();
		try {
			for (const row of worker.rows.values()) {
				if (row.version !== null) continue;
				const { plaintext } = await openEnvelope(row.record, vaultId, row.file, keys.keyFor);
				const data = JSON.parse(new TextDecoder().decode(plaintext));
				assert.ok(!rows.has(data.id), "two table files share note ID " + data.id);
				rows.set(data.id, { ...data, file: hex(row.file), seq: row.seq, deleted: row.deleted });
				docs.set(data.id, new Y.Doc());
			}
			for (const { entry } of server.rows) {
				const doc = docs.get(entry.doc); if (doc) Y.applyUpdate(doc, entry.data);
			}
			const expected = new Map<string,string>(), found = new Map<string,string[]>();
			for (const [id,row] of rows) {
				const doc = docs.get(id)!;
				assert.ok(!doc.store.pendingStructs && !doc.store.pendingDs, "incomplete stored text " + id);
				const text = doc.getText("t").toString();
				if (process.env.FUZZ_LOG) log.push([row.seq,id,row.deleted === null ? "live" : "deleted",row.path,text].join(" "));
				if (row.deleted === null) {
					assert.ok(!expected.has(row.path), "two live rows at " + row.path);
					expected.set(row.path,text);
				}
				for (const marker of text.match(/<n\d+>/g) ?? []) {
					const live = found.get(marker) ?? [];
					if (row.deleted === null) live.push(id);
					found.set(marker,live);
				}
			}
			// Keep one witness per invariant in batch output. FUZZ_LOG retains the full rows.
			const problems = new Map<string,string>();
			const problem = (kind: string, witness: string) => { if (!problems.has(kind)) problems.set(kind,kind + ": " + witness); };
			// A copy may share only the characters it inherited. Its identity survives
			// renames, and two occurrences inside any one ID are still a failure.
			const userRestored = worker.restores.some(restore => restore.file === offlineMove?.file &&
				userRestores.some(r => r.peer === restore.peer && r.base === restore.base && r.head < restore.seq));
			function origin(id: string, marker: string): string {
				const copy = copied.get(id);
				if (copy?.markers.has(marker)) return origin(copy.parent, marker);
				if (userRestored && offlineMove?.child === id && offlineMove.markers.has(marker)) return offlineMove.parent;
				return id;
			}
			for (const s of required) {
				const live = found.get(s);
				if (!live) problem("lost typed text",s);
				else if (new Set(live).size !== live.length || new Set(live.map(id => origin(id,s))).size > 1)
					problem("duplicate",s + " in " + live.map(id => rows.get(id)!.path).join(", "));
			}
			for (const p of peers) {
				const { d, sync } = p;
				assert.deepEqual(d.problems, []);
				assert.deepEqual(new Map([...sync.notes.ids()].map(id => [id,sync.notes.get(id)])),rows,d.name + " row divergence");
				const actual = new Map(paths(p).map(path => [path,d.files.get(path)!.content]));
				for (const path of new Set([...actual.keys(), ...expected.keys()])) {
					if (actual.get(path) !== expected.get(path)) {
						problem("disk divergence",d.name + " " + path);
						if (process.env.FUZZ_LOG) {
							const state = sync.notes.state!;
							log.push(JSON.stringify({ device: d.name, path, actual: actual.get(path), expected: expected.get(path),
								intent: state.intent, notes: [...state.notes.values()].filter(n => n.diskPath === path || n.row?.path === path)
									.map(n => ({id:n.id, at:n.diskPath, row:n.row, change:n.change, flight:n.inFlight, editor:n.editor, held:n.held, blocked:state.blocked.get(n.id)})) }));
						}
					}
				}
				const deleted = await d.engine!.deletedNotes();
				for (const [id,r] of rows) {
					if (r.deleted === null) { if (d.engine!.noteAt(r.path) !== id) problem("wrong disk ID",d.name + " " + r.path); }
					else {
						assert.ok(deleted.some(e => e.id === id && e.deletionSeq === r.seq), "missing from Recently deleted " + id);
						assert.equal(await d.engine!.deletedText(id),docs.get(id)!.getText("t").toString());
					}
				}
				const state = sync.notes.state!;
				if (state.intent || state.forget.size || [...state.notes.values()].some(n => n.change || n.inFlight || n.unpublished))
					problem("unsettled device",d.name);
			}
			assert.ok(!problems.size,[...problems.values()].join("; "));
		} finally { for (const doc of docs.values()) doc.destroy(); }
	}
	try {
		const a = add(), b = add(), mixed = seed % 4 === 0;
		if (mixed) {
			for (const p of peers) { delete p.d.overrides.tableNotes; p.d.boot(); p.d.connect(); }
			await quiesce(peers.map(p => p.d));
			for (let i=0; i<3; i++) { await write(pick(peers),"draft.md"); await quiesce(peers.map(p => p.d)); }
			a.d.write("legacy.bin", Uint8Array.of(1,2,3)); await quiesce(peers.map(p => p.d));
			const projection = new LegacyProjection(), key = await a.sync.nameKey();
			try {
				for (const {entry} of server.rows) projection.applyIndex(entry);
				for (const {entry} of server.rows) projection.applyDocument(entry);
				for await (const r of projection.rows(key)) worker.store(await a.sync.wireRow(r));
				for await (const {row} of projection.noteRows(key,worker.entries.length)) worker.store(await a.sync.wireNote(row));
			} finally { projection.close(); }
			for (const p of peers) { disconnect(p); p.d.crash(); }
			noteCoverage.migrated++;
		}
		await wire(a); await wire(b);
		await write(a,"draft.md"); await drain();
		const id = a.d.engine!.noteAt("draft.md")!;
		const joined = add();
		for (const [path,file] of a.d.files) if (visible(path)) joined.d.files.set(path,structuredClone(file));
		await wire(joined); await drain();
		assert.equal(joined.d.engine!.noteAt("draft.md"),id); noteCoverage.copiedJoins++;
		if (steps === "held conflict" || steps === "delete held") {
			const notices = noteCoverage.heldNotices;
			for (const local of [token(),token()]) {
				await write(a,"draft.md");
				// The outside save lands before its watcher fires; B receives the
				// remote edit while its last agreed bytes are still the old ones.
				const file = b.d.files.get("draft.md")!;
				assert.equal(typeof file.content,"string");
				diskAuthor.set(local, id);
				b.d.files.set("draft.md",{ content: file.content + local, mtime: file.mtime + 1 });
				await drain();
				b.d.engine!.diskChanged("draft.md"); await drain();
			}
			assert.equal(b.sync.notes.state!.notes.get(id)?.held,true);
			assert.equal(noteCoverage.heldNotices,notices + 1);
			if (steps === "delete held") {
				await write(b, "draft.md");
				const latest = b.d.files.get("draft.md")!.content;
				disconnect(b); b.d.crash(); b.d.remove("draft.md");
				await wire(b); await drain();
				// A peer can list, preview and explicitly restore the exact last save.
				const engine = a.d.engine!;
				const deleted = await engine.deletedNotes();
				const saved = [];
				for (const row of deleted) if (await engine.deletedText(row.id) === latest) saved.push(row);
				assert.equal(saved.length, 1);
				const row = saved[0]!;
				const restored = await engine.restoreDeleted(row.id, undefined, row.deletionSeq);
				assert.ok(restored);
				await drain();
				for (const p of peers) assert.equal(p.d.files.get(restored)?.content, latest);
			}
			await check();
			return;
		}
		const sharedPath = "independent.md";
		await write(a,sharedPath); await write(b,sharedPath);
		const firstId = a.d.engine!.noteAt(sharedPath), secondId = b.d.engine!.noteAt(sharedPath);
		assert.ok(firstId && secondId && firstId !== secondId);
		await drain();
		assert.ok(a.sync.notes.get(firstId)?.deleted === null && a.sync.notes.get(secondId)?.deleted === null);
		assert.notEqual(a.sync.notes.get(firstId)!.path,a.sync.notes.get(secondId)!.path);
		const edit = await b.d.engine!.open(id); assert.ok(edit);
		const moved = nextPath("live");
		a.d.rename("draft.md", moved); a.d.drain(); await a.d.idle();
		edit.getText("t").insert(edit.getText("t").length, token() + "!");
		await b.d.idle(); await drain(); await b.d.engine!.close(id); await drain();
		noteCoverage.liveRenames++;
		// Delete and restore both race a peer who still sees the live document.
		disconnect(b);
		if (seed % 2) await write(b,moved);
		else {
			const before = b.d.files.get(moved)?.content; assert.ok(typeof before === "string" && before.endsWith("!"));
			b.d.write(moved,before.slice(0,-1)); b.d.drain(); await b.d.idle();
		}
		a.d.remove(moved); await drain();
		assert.ok(a.sync.notes.get(id)?.deleted != null);
		if (seed % 2) {
			await a.d.engine!.restoreDeleted(id,undefined,a.sync.notes.get(id)!.seq);
			await drain(); noteCoverage.restoreEdits++;
		}
		await wire(b); await drain();
		assert.equal(a.sync.notes.get(id)?.deleted,null); noteCoverage.deleteEdits++;

		// A crash on either side of each durable disk intent, rotating the
		// boundaries across seeds. The survivor continues to receive Worker frames.
		const effect = (["installTemp","moveIf","removeIf","writeTemp"] as const)[seed % 4]!;
		const side = seed % 8 < 4 ? "before" : "after";
		joined.fault = {effect,side};
		if (effect === "installTemp" || effect === "writeTemp") await write(a,moved);
		else if (effect === "moveIf") a.d.rename(moved,nextPath("move"));
		else a.d.remove(moved);
		await drain();
		assert.ok(!joined.d.alive && !joined.fault, "disk crash was not reached: " + effect);
		await wire(joined); await drain();
		const offline = nextPath("offline"), to = nextPath("outside");
		await write(a,offline); await drain();
		const original = a.d.engine!.noteAt(offline)!;
		const movedMarkers = markers(a.d.files.get(offline)!.content as string);
		a.sync.disconnect(); a.d.crash(); a.d.rename(offline,to);
		await wire(a); await drain();
		assert.ok(a.sync.notes.get(original)?.deleted != null,"external move must delete the old ID");
		const replacement = a.d.engine!.noteAt(to); assert.ok(replacement && replacement !== original);
		offlineMove = { parent: original, file: a.sync.notes.get(original)!.file, child: replacement, markers: movedMarkers };
		log.push("offline move " + offline + " (" + original + ") -> " + to + " (" + replacement + ")");
		noteCoverage.offlineMoves++;
		a.lose = true; await write(a,nextPath("lost")); await drain();
		assert.ok(!a.lose); disconnect(a); await wire(a); await drain();

		for (let step=0; step<steps; step++) {
			const p = pick(peers), path = pick(paths(p)), op = Math.floor(random()*10);
			log.push(step + ": " + p.d.name + " op=" + op + " " + (path ?? ""));
			if (op === 0 && path) await write(p,path);
			else if (op === 1 && path) {
				const id = p.d.engine!.noteAt(path), doc = id && await p.d.engine!.open(id);
				if (doc) { const t = doc.getText("t"); t.insert(t.length,token()); await p.d.idle(); await p.d.engine!.close(id!); }
			} else if (op === 2 && path) p.d.rename(path,nextPath("rename"));
			else if (op === 3 && path) p.d.remove(path);
			else if (op === 4) {
				const tombs = await p.d.engine!.deletedNotes(), selected = pick(tombs.filter(t => note(t.path)));
				if (selected) {
					log.push("restore " + selected.id + " " + selected.path);
					const head = worker.entries.length;
					const path = await p.d.engine!.restoreDeleted(selected.id,undefined,selected.deletionSeq);
					if (path && selected.id === offlineMove.parent) userRestores.push({ peer: p, base: selected.deletionSeq!, head });
				}
			} else if (op === 5) { if (p.d.online) disconnect(p); else await wire(p); }
			else if (op === 6 && p.d.online) await deliver(p);
			else if (op === 7 || !path) await write(p,"note-" + Math.floor(random()*3) + ".md");
			else if (op === 8) await drain();
			else { p.sync.disconnect(); p.d.crash(); await wire(p); }
			p.d.drain(); await p.d.idle(); await p.sync.idle();
		}
		for (const p of peers) if (!p.d.online) await wire(p);
		await check();
		if (mixed) for (const p of peers) assert.deepEqual(p.d.files.get("legacy.bin")?.content,Uint8Array.of(1,2,3));
	} catch (e) {
		throw new Error("table note seed " + seed + ": " + String(e) + (process.env.FUZZ_LOG ? "\n" + log.join("\n") + "\n" + (e instanceof Error ? e.stack : "") : ""));
	} finally {
		for (const p of peers) { p.sync.disconnect(); p.d.engine?.stop(); p.d.crash(); }
	}
}
