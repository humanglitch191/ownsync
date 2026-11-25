// The same disk and database can be driven by both generations of the engine.
import type { Store } from "../src/core/ports";
import type { TableDisk } from "../src/tableDisk";
type Fs = ConstructorParameters<typeof TableDisk>[0];
export function attachmentFs(files = new Map<string, { content: string | Uint8Array; mtime: number }>(), values = new Map<string, unknown>()) {
	let time = Date.now();
	const folders = new Set<string>([""]);
	const bytes = (p: string) => {
		const b = files.get(p)?.content;
		if (typeof b === "string") return new TextEncoder().encode(b);
		if (!(b instanceof Uint8Array)) throw new Error("Missing binary file " + p);
		return b;
	};
	const fs: Fs = {
		async list(dir) {
			const children = (paths: Iterable<string>) => [...paths].filter(p => p && p.split("/").slice(0, -1).join("/") === dir);
			return { files: children(files.keys()), folders: children(folders) };
		},
		async stat(p) {
			const f = files.get(p);
			return f ? { type: "file", size: f.content.length, ctime: f.mtime, mtime: f.mtime } : null;
		},
		async readBinary(p) { return bytes(p).slice().buffer; },
		async writeBinary(p, b) { files.set(p, { content: p.endsWith(".md") ? new TextDecoder().decode(b) : new Uint8Array(b).slice(), mtime: ++time }); },
		async exists(p) { return folders.has(p) || files.has(p); },
		async mkdir(p) { folders.add(p); },
		async remove(p) { files.delete(p); },
		async rename(from, to) {
			const file = files.get(from); if (!file) throw new Error("Missing " + from);
			files.set(to, file); files.delete(from);
		},
		async copy(from, to) {
			if (files.has(to)) throw new Error("Destination occupied");
			await fs.writeBinary(to, bytes(from).slice().buffer);
		},
	};
	const store: Store = {
		async get<T>(k: string) { return structuredClone(values.get(k)) as T | undefined; },
		async list<T>(prefix: string) { return [...values].filter(([k]) => k.startsWith(prefix)) as [string, T][]; },
		async commit(puts, deletes) {
			for (const [k, v] of puts) values.set(k, structuredClone(v));
			for (const k of deletes) values.delete(k);
		},
	};
	return { fs, store, files, bytes };
}
