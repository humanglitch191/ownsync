// Only stored snapshots and updates enter these documents. Disk and the legacy outbox are inputs to
// the returning device's base, never to genesis.
import * as Y from "yjs";
import { hex, tableFileId, unhex } from "../../../../protocol/ownsync";
import type { Entry, NoteMeta, Ref, Store } from "../ports";
import { checkLocalPaths, conflictSuffix, type Local, type Row } from "./device";
import type { NoteRow } from "./notes";
import type { NoteEntry, NoteStructure } from "./notePlanner";
import { places, type IndexValue } from "../places";
const suffix = (p: string, s: string) => p.replace(/(\.[^./]*)?$/, (_, ext) => ` (conflict ${s})${ext ?? ""}`);

function migratedId(key: Uint8Array, id: string) {
	if (!/^(?:[0-9a-f]{2})+$/.test(id)) throw new Error("Invalid legacy attachment identity");
	return tableFileId(key, unhex(id)).then(hex);
}

export type GenesisRow = Row & { dateAtCommit?: true };

// Keep only clock coverage for note bodies. A complete stream covers every clock
// up to each referenced insertion or deletion, including cross-writer origins.
class NoteCoverage {
	private ranges = new Map<number, [number, number][]>();
	private needs = new Map<number, number>();

	add(update: Uint8Array) {
		const { structs, ds } = Y.decodeUpdate(update);
		const need = (client: number, end: number) => this.needs.set(client, Math.max(this.needs.get(client) ?? 0, end));
		for (const item of structs) {
			if (item instanceof Y.Skip) continue;
			const {client, clock} = item.id, end = clock + item.length;
			let ranges = this.ranges.get(client);
			if (!ranges) this.ranges.set(client, ranges = []);
			const last = ranges[ranges.length - 1];
			if (last && clock >= last[0] && clock <= last[1]) last[1] = Math.max(last[1], end);
			else ranges.push([clock, end]);
			need(client, end);
			if (item instanceof Y.Item) for (const ref of [item.origin, item.rightOrigin, item.parent])
				if (ref instanceof Y.ID) need(ref.client, ref.clock + 1);
		}
		for (const [client, spans] of ds.clients) for (const {clock, len} of spans) need(client, clock + len);
	}

	complete() {
		for (const [client, end] of this.needs) {
			let covered = 0;
			for (const [a, b] of (this.ranges.get(client) ?? []).sort(([a], [b]) => a-b)) {
				if (a > covered) return false;
				covered = Math.max(covered, b);
			}
			if (covered < end) return false;
		}
		return true;
	}
}

export class LegacyProjection {
	readonly index = new Y.Doc();
	readonly notes = this.index.getMap<IndexValue>("notes");
	private docs = new Map<string, Y.Doc>();
	private text = new Map<string, NoteCoverage>();
	private omitted = new Set<string>();
	applyIndex(entry: Entry) { if (entry.doc === "index") Y.applyUpdate(this.index, entry.data); }
	applyDocument(entry: Entry) {
		const path = this.notes.get(entry.doc)?.p;
		if (!path) return;
		if (path.endsWith(".md")) {
			let coverage = this.text.get(entry.doc);
			if (!coverage) this.text.set(entry.doc, coverage = new NoteCoverage());
			coverage.add(entry.data);
			return;
		}
		let d = this.docs.get(entry.doc);
		if (!d) this.docs.set(entry.doc, d = new Y.Doc());
		Y.applyUpdate(d, entry.data);
	}

	// Inspect pending index items only after both passes have reached the same head.
	// A missing predecessor can hide the note ID or its path entirely.
	gaps(indexUnavailable = false) {
		this.omitted.clear();
		const paths = new Set<string>();
		const pending = this.index.store.pendingStructs;
		if (pending) for (const item of Y.decodeUpdateV2(pending.update).structs) {
			if (!(item instanceof Y.Item)) continue;
			// Decoded root parents are their Yjs names until integration.
			const parentName: unknown = item.parent;
			let id = parentName === "notes" ? item.parentSub : null;
			for (const origin of [item.origin, item.rightOrigin]) {
				if (id || !origin || origin.clock >= Y.getState(this.index.store, origin.client)) continue;
				const parent = Y.getItem(this.index.store, origin);
				if (parent instanceof Y.Item && parent.parent === this.notes) id = parent.parentSub;
			}
			if (id) this.omitted.add(id);
			for (const value of item.content.getContent()) if (typeof value?.p === "string") paths.add(value.p);
		}
		for (const [id, note] of this.notes) {
			const doc = this.docs.get(id);
			if (note.p.endsWith(".md") ? !this.text.get(id)?.complete() :
				doc?.store.pendingStructs || doc?.store.pendingDs || (!doc && note.d === undefined)) this.omitted.add(id);
			if (this.omitted.has(id)) paths.add(note.p);
		}
		if (pending || this.index.store.pendingDs || indexUnavailable) paths.add("legacy index (some file names may be unavailable)");
		return [...paths].sort();
	}
	// Text remains in its existing Yjs stream. In particular the deletion vector
	// is the one the deleter saw, not the current vector of the text document.
	async *noteRows(key: Uint8Array, after: number) {
		const paths = places(this.notes);
		for (const id of [...this.notes.keys()].sort()) {
			if (this.omitted.has(id)) continue;
			const v = this.notes.get(id)!;
			if (!v.p.endsWith(".md") || !this.text.get(id)?.complete()) continue;
			if (v.d !== undefined) Y.decodeStateVector(Uint8Array.from(atob(v.d), c => c.charCodeAt(0)));
			const row: NoteRow = { kind: "note", id, file: await migratedId(key, id), path: paths.get(id) ?? v.p,
				seq: ++after, deleted: v.t ?? null, ...(v.d === undefined ? {} : { vector: v.d }) };
			yield { row, dateAtCommit: v.d !== undefined && v.t === undefined };
		}
	}
	async *rows(key: Uint8Array): AsyncGenerator<GenesisRow> {
		const paths = places(this.notes), occupied = new Set(paths.values());
		const emitted = new Set<string>();
		let seq = 0;
		for (const id of [...this.notes.keys()].sort()) {
			if (this.omitted.has(id)) continue;
			const v = this.notes.get(id)!;
			if (v.p.endsWith(".md")) continue;
			const versions = this.docs.get(id)?.getArray<Ref>("v").toArray() ?? [];
			const seen = new Set<string>();
			for (const ref of versions) {
				if (typeof ref.u !== "string" || !ref.u)
					throw new Error("Missing or invalid legacy version identity at " + v.p);
				if (seen.has(ref.h)) continue;
				const first = !seen.size;
				seen.add(ref.h);
				let source = first ? id : ref.u;
				let replaced = false;
				// A split might already have published the child and still list it in the parent.
				if (!first && this.notes.has(source)) {
					if (this.docs.get(source)?.getArray<Ref>("v").toArray().some(r => r.h === ref.h)) continue;
					replaced = true;
					source += ref.u; // the advanced child keeps its ordinary ID
				}
				if (emitted.has(source)) throw new Error("Invalid legacy attachment identity");
				emitted.add(source);
				const original = paths.get(id) ?? v.p;
				let path = original;
				if (!first) {
					let n = 0;
					do { path = suffix(original, await conflictSuffix(key, ref.h, n++)); } while (occupied.has(path));
					occupied.add(path);
				}

				yield {
					file: await migratedId(key, source), seq: ++seq, path, bytes: ref, mtime: null,
					deleted: v.d === undefined ? null : v.t ?? null,
					...(replaced || (v.d !== undefined && v.t === undefined) ? { dateAtCommit: true } as const : {})
				};
			}
		}
	}
	close() { this.index.destroy(); for (const d of this.docs.values()) d.destroy(); }
}

type StoredEntry = Entry & { renameSources?: [string, string][] };

// A local Y.Map.set writes a new item for that key. Look it up in the persisted document:
// the wire update for a replacement may inherit its key from the previous item.
// Older 0.2.x outboxes only have the replacement item; its collected predecessor has no path.
function unsentPaths(index: Y.Doc, out: StoredEntry[]) {
	const notes = index.getMap<IndexValue>("notes"), paths = new Map<string, string | undefined>(), current = new Set<string>();
	for (const e of out) if (e.doc === "index") {
		const from = new Map(e.renameSources);
		for (const struct of Y.decodeUpdate(e.data).structs) {
			if (!(struct instanceof Y.Item)) continue;
			if (struct.id.clock >= Y.getState(index.store, struct.id.client)) continue;
			const item = Y.getItem(index.store, struct.id);
			if (item instanceof Y.Item && item.parent === notes && item.parentSub !== null) {
				const key = item.parentSub;
				if (!paths.has(key)) paths.set(key, from.get(key));
				if (!item.deleted) current.add(key);
			}
		}
	}
	for (const key of paths.keys()) if (!current.has(key)) paths.delete(key);
	return paths;
}

// forget() cleared diskPath/baseHash before recording an offline deletion. The deletion vector
// proves which attachment document the user had seen. A later version is never evidence for del.
async function deletedBase(store: Store, id: string, seen: string) {
	const data = await store.get<Uint8Array>("state:" + id);
	if (!data) return;
	const doc = new Y.Doc();
	try {
		Y.applyUpdate(doc, data);
		const covered = Y.decodeStateVector(Uint8Array.from(atob(seen), c => c.charCodeAt(0)));
		for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc)))
			if (clock > (covered.get(client) ?? 0)) return;
		return doc.getArray<Ref>("v").get(0);
	} finally { doc.destroy(); }
}

// Capture these bases together with the handoff marker, before starting either disk planner.
export async function legacyBases(store: Store, key: Uint8Array) {
	const locals = new Map<string, Local>();
	const puts = new Map<string, unknown>();
	const queued = (await store.list<StoredEntry>("out:")).sort(([a], [b]) => Number(a.slice(4)) - Number(b.slice(4)));
	const out = queued.map(([,e]) => e);
	const pending = new Set(out.map(e => e.doc));
	const restores = new Set(out.filter(e => e.kind === "snapshot").map(e => e.doc));
	const index = new Y.Doc();
	try {
		const data = await store.get<Uint8Array>("index");
		if (data) Y.applyUpdate(index, data);
		const notes = index.getMap<IndexValue>("notes"), changed = unsentPaths(index, out);
		const paths = places(notes);
		// A tombstone or a never-downloaded file can survive solely as a local
		// version reference. Keep those references until table catch-up proves
		// which IDs made it into genesis, including legacy split versions.
		const projection = new LegacyProjection();
		try {
			if (data) projection.applyIndex({ doc: "index", data, kind: "snapshot" });
			for (const [id, value] of notes) if (!value.p.endsWith(".md")) {
				const body = await store.get<Uint8Array>("state:" + id);
				if (body) projection.applyDocument({ doc: id, data: body, kind: "snapshot" });
			}
			for await (const r of projection.rows(key))
				puts.set("table/legacy/" + r.file, { path: r.path, bytes: r.bytes, removed: r.dateAtCommit || r.deleted !== null });
		} finally { projection.close(); }
		for (const id of notes.keys()) {
			const entry = notes.get(id)!;
			if (!entry.p.endsWith(".md")) continue;
			const m = await store.get<NoteMeta>("note:" + id);
			const base = await store.get<Uint8Array>("base:" + id);
			// A backup may hold the missing prefix only in its last agreement.
			// Keep the union in the same handoff commit as the planner seed.
			if (base) {
				const current = await store.get<Uint8Array>("state:" + id);
				const merged = current ? Y.mergeUpdates([current,base]) : base;
				if (!current || merged.length !== current.length || merged.some((b,i) => b !== current[i]))
					puts.set("state:" + id, merged);
			}
			const basePath = changed.has(id) ? changed.get(id) : m?.diskPath;
			const change: NoteStructure | undefined = !changed.has(id) ? undefined : entry.d === undefined
				? { t: "set", path: paths.get(id) ?? entry.p, basePath, ...(restores.has(id) ? { legacyRestore: true } as const : {}) }
				: { t: "del", path: entry.p, vector: entry.d };
			const seed: NoteEntry = { id, file: await migratedId(key, id), diskPath: m?.diskPath, basePath,
				editor: m?.open ? "owed-recover" : m?.owed === "doc" ? "owed-doc" : m?.owed === "recover" ? "owed-recover" : "closed",
				baseState: m?.baseHash === undefined ? undefined : base ?? await store.get<Uint8Array>("state:" + id),
				intended: m?.writing ? base : undefined, copyOf: m?.copyOf,
				legacy: entry.d === undefined ? { t: "set", path: paths.get(id) ?? entry.p } : { t: "del", path: entry.p, vector: entry.d },
				firstTextPending: pending.has(id), change };
			puts.set("table/note-state/" + id, seed);
		}
		for (const [k, m] of await store.list<NoteMeta>("note:")) {
			const id = k.slice(5), entry = notes.get(id);
			const removed = !m.diskPath && changed.has(id) && entry?.d !== undefined;
			const path = m.diskPath ?? (removed ? entry?.p : undefined);
			if (!path || path.endsWith(".md")) continue;
			const file = await migratedId(key, id);
			let bytes: Local["base"]["bytes"];
			if (!pending.has(id)) {
				if (removed) bytes = await deletedBase(store, id, entry!.d!);
				else {
					const upload = await store.get<{ base?: string }>("up:" + id);
					const h = upload ? upload.base : m.baseHash;
					if (h) bytes = { h }; // never substitute a staged hash for its agreement
				}
			}
			locals.set("table/local/" + file, { path, base: { path: changed.has(id) ? changed.get(id) : path, bytes }, removed });
		}
	} finally { index.destroy(); }
	checkLocalPaths(locals.values());
	for (const [k, v] of locals) puts.set(k, v);
	puts.set("table/migrated", true);
	return puts;
}
