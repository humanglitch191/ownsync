// Only stored snapshots and updates enter these documents. Disk and the legacy outbox are inputs to
// the returning device's base, never to genesis.
import * as Y from "yjs";
import { hex, tableFileId, unhex } from "../../../../protocol/ownsync";
import type { Entry, NoteMeta, Ref, Store, Upload } from "../ports";
import { conflictSuffix, type Local, type Row } from "./device";
import { places, type IndexValue } from "../places";
const suffix = (p: string, s: string) => p.replace(/(\.[^./]*)?$/, (_, ext) => ` (conflict ${s})${ext ?? ""}`);

function migratedId(key: Uint8Array, id: string) {
	if (!/^(?:[0-9a-f]{2})+$/.test(id)) throw new Error("Invalid legacy attachment identity");
	return tableFileId(key, unhex(id)).then(hex);
}

export type GenesisRow = Row & { dateAtCommit?: true };

export class LegacyProjection {
	readonly index = new Y.Doc();
	readonly notes = this.index.getMap<IndexValue>("notes");
	private docs = new Map<string, Y.Doc>();
	applyIndex(entry: Entry) { if (entry.doc === "index") Y.applyUpdate(this.index, entry.data); }
	applyAttachment(entry: Entry) {
		const path = this.notes.get(entry.doc)?.p;
		if (!path || path.endsWith(".md")) return;
		let d = this.docs.get(entry.doc);
		if (!d) this.docs.set(entry.doc, d = new Y.Doc());
		Y.applyUpdate(d, entry.data);
	}
	async *rows(key: Uint8Array): AsyncGenerator<GenesisRow> {
		// A live-only dependency may not yet be stored. Committing a partial Yjs document would
		// discard the update waiting for it; a later snapshot can complete this projection.
		for (const doc of [this.index, ...this.docs.values()])
			if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error("Incomplete stored document");
		const { paths } = places(this.notes), occupied = new Set(paths.values());
		const emitted = new Set<string>();
		let seq = 0;
		for (const id of [...this.notes.keys()].sort()) {
			const v = this.notes.get(id)!;
			if (v.p.endsWith(".md")) continue;
			const versions = this.docs.get(id)?.getArray<Ref>("v").toArray() ?? [];
			const seen = new Set<string>();
			for (const ref of versions) {
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

// A local Y.Map.set writes a new item for that key. Look it up in the persisted document:
// the wire update for a replacement may inherit its key from the previous item.
function unsentPaths(index: Y.Doc, out: Entry[]) {
	const notes = index.getMap<IndexValue>("notes"), paths = new Set<string>();
	for (const e of out) if (e.doc === "index") {
		for (const struct of Y.decodeUpdate(e.data).structs) {
			if (!(struct instanceof Y.Item)) continue;
			const item = Y.getItem(index.store, struct.id);
			if (item instanceof Y.Item && !item.deleted && item.parent === notes && item.parentSub !== null)
				paths.add(item.parentSub);
		}
	}
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
	const puts = new Map<string, unknown>(), out = (await store.list<Entry>("out:")).map(([, e]) => e);
	const pending = new Set(out.map(e => e.doc));
	const index = new Y.Doc();
	try {
		const data = await store.get<Uint8Array>("index");
		if (data) Y.applyUpdate(index, data);
		const notes = index.getMap<IndexValue>("notes"), changed = unsentPaths(index, out);
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
					const upload = await store.get<Upload>("up:" + id);
					const h = upload ? upload.base : m.baseHash;
					if (h) bytes = { h }; // never substitute a staged hash for its agreement
				}
			}
			puts.set("table/local/" + file, { path, base: { path: changed.has(id) ? undefined : path, bytes }, removed } satisfies Local);
		}
	} finally { index.destroy(); }
	puts.set("table/migrated", true);
	return puts;
}
