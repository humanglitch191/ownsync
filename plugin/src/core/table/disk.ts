// A plan is committed before executing any filesystem intent. The injected adapter owns the
// private plugin-folder temp file and the conditional mutations at the visible endpoints.
import type { Disk, DiskFile, Ref } from "../ports";
import { reconcile, reserved, type Blocked, type Inputs, type Observation, type State, type TableDevice } from "./device";

export type Event = { kind: "startup" | "settle" } | { kind: "changed" | "deleted"; path: string }
	| { kind: "renamed"; from: string; to: string };
export interface DiskInputs extends Inputs {
	attachments: boolean;
	allowed(path: string): boolean;
	maxFileSize: number;
	hash(bytes: Uint8Array): Promise<string>;
	readStage(ref: Ref): Promise<Uint8Array | undefined>;
	fetch(ref: Ref): Promise<Uint8Array>;
}
export interface DiskPort extends Pick<Disk, "stat" | "list" | "readBinary"> {
	writeTemp(bytes: Uint8Array): Promise<void>;
	discardTemp(): Promise<void>;
	// Recheck immediately at mutation, including destination absence. A failed precondition preserves user bytes.
	installTemp(path: string, expectedHash: string | null): Promise<boolean>;
	moveIf(from: string, to: string, expectedHash: string): Promise<boolean>;
	removeIf(path: string, expectedHash: string): Promise<boolean>;
}
const included = (i: DiskInputs, p: string) => i.attachments && !p.endsWith(".md") && i.allowed(p);

const under = (path: string, root: string) => path === root || path.startsWith(root + "/");

async function observe(disk: DiskPort, i: DiskInputs, stat: DiskFile, cached?: Observation): Promise<Observation> {
	if (stat.size > i.maxFileSize) return stat;
	if (cached?.hash !== undefined && cached.mtime === stat.mtime && cached.size === stat.size) return cached;
	try {
		const bytes = await disk.readBinary(stat.path), after = await disk.stat(stat.path);
		if (after?.size === stat.size && after.mtime === stat.mtime && bytes.length === stat.size)
			return { ...stat, hash: await i.hash(bytes) };
	} catch { /* Keep unreadable paths occupied. */ }
	return stat;
}

async function inventory(s: State, disk: DiskPort, i: DiskInputs, event: Event) {
	const cache = s.observed;
	if ("path" in event) cache.delete(event.path);
	if (event.kind === "renamed") for (const path of cache.keys()) if (under(path, event.from) || under(path, event.to)) cache.delete(path);
	const view = new Map<string, Observation>();
	for (const stat of await disk.list()) if (included(i, stat.path))
		view.set(stat.path, await observe(disk, i, stat, cache.get(stat.path)));
	// The stat belongs to these observed bytes, even when no row or agreement exists yet.
	for (const path of cache.keys()) if (!view.get(path)?.hash) cache.delete(path);
	for (const [path, obs] of view) if (obs.hash !== undefined) cache.set(path, obs);
	return view;
}

function bindEvent(s: State, view: Map<string, Observation>, event: Event, inputs: DiskInputs) {
	const owners = new Map([...s.local].map(([id,f]) => [f.path, id]));
	const move = (file: string, to: string) => {
		const prior = owners.get(to);
		if (prior && prior !== file) s.local.delete(prior);
		const local = s.local.get(file)!;
		owners.delete(local.path); owners.set(to, file);
		s.local.set(file, { ...local, path: to, removed: false });
	};
	if ("path" in event) {
		const id = owners.get(event.path);
		if (id) s.local.set(id, { ...s.local.get(id)!, removed: event.kind === "deleted" && !view.has(event.path) });
	}
	if (event.kind === "renamed") {
		for (const [path, file] of [...owners]) if (under(path, event.from)) {
			const to = event.to + path.slice(event.from.length);
			if (included(inputs, to) && view.has(to)) move(file, to);
		}
	}
	const missing = [...s.local].filter(([, f]) => !view.has(f.path));
	const unknown = [...view.values()].filter(f => !owners.has(f.path));
	const defer = new Set<string>();
	if (event.kind === "startup") {
		// D13 counts both sides in the original inventory. An unreadable candidate cannot establish uniqueness.
		for (const [file, local] of missing) {
			const base = local.base.bytes;
			// At migration an offline rename with no confirmed hash cannot identify its old file.
			if (!base) continue;
			const matches = unknown.filter(f => f.hash === base.h);
			if (unknown.some(f => f.hash === undefined && (base.n === undefined || f.size === base.n))) {
				defer.add(file);
				for (const m of matches) defer.add(m.path);
			} else if (matches.length === 1 && missing.filter(([, f]) => f.base.bytes?.h === base.h).length === 1) move(file, matches[0]!.path);
		}
	}
	for (const f of unknown) {
		if (s.intent?.path === f.path) continue;
		if (owners.has(f.path) || defer.has(f.path) || f.hash === undefined) continue;
		// A missing source at settle may have a rename event on its way.
		if (missing.length && event.kind !== "startup" && !(event.kind === "changed" && event.path === f.path)
			&& !(event.kind === "renamed" && under(f.path, event.to))) continue;
		const id = inputs.id();
		s.local.set(id, { path: f.path, base: {} });
	}
	return defer;
}

// Last-change catch-up can deliver a completed path swap without its temporary name. Break a
// closed cycle by staging one agreed file privately. The saved ref survives until installation.
async function parkCycle(s: State, view: Map<string, Observation>, inputs: DiskInputs) {
	const moving = new Map<string, string>();
	for (const [id, local] of s.local) {
		const row = s.latest.get(id);
		if (!s.blocked.has(id) && row?.deleted === null && local.path !== row.path && !reserved(s, id) && included(inputs,row.path)
			&& view.get(local.path)?.hash === row.bytes.h && local.base.bytes?.h === row.bytes.h) moving.set(local.path,id);
	}
	const visited = new Set<string>();
	for (const start of moving.keys()) {
		const chain = new Set<string>();
		let path = start;
		while (moving.has(path) && !visited.has(path)) {
			visited.add(path); chain.add(path);
			path = s.latest.get(moving.get(path)!)!.path;
		}
		if (!chain.has(path)) continue;
		const file = moving.get(path)!, obs = view.get(path)!, saved = await inputs.stage(obs);
		if (saved.h !== obs.hash || saved.n !== obs.size) throw new Error("File changed while staging a move");
		s.intent = { kind: "park", file, path, hash: saved.h, saved, seq: s.latest.get(file)!.seq };
		return;
	}
}

export async function planDisk(device: TableDevice, disk: DiskPort, inputs: DiskInputs, event: Event) {
	if (!inputs.attachments) {
		await device.change(s => { s.intent = undefined; });
		return;
	}
	if (event.kind === "startup") {
		await device.change(async () => disk.discardTemp());
		await executeIntent(device, disk, inputs);
	}
	await device.change(async s => {
		const view = await inventory(s, disk, inputs, event);
		const defer = bindEvent(s, view, event, inputs);
		for (const [id, block] of s.blocked) {
			const at = s.local.get(id)?.path;
			if ((at && !block.endpoints.some(([p]) => p === at)) || s.latest.get(block.authority)?.seq !== block.seq
				|| block.endpoints.some(([p, seen]) => !sameObservation(seen, view.get(p)))) s.blocked.delete(id);
		}
		// Ingest local changes before creating remote files. Process authoritative missing events even
		// when another file needs disk work; an event can contain the only evidence of a user rename.
		const ids = [...new Set([...s.local.keys(), ...s.latest.keys()])];
		for (const id of ids) {
			const local = s.local.get(id), path = local?.path ?? s.latest.get(id)?.path;
			if (!path || !included(inputs, path) || defer.has(id) || s.blocked.has(id)) continue;
			const row = s.latest.get(id);
			if (row && (!included(inputs, row.path) || row.bytes.n > inputs.maxFileSize)) continue;
			const deleted = event.kind === "startup" || (event.kind === "deleted" && under(path, event.path))
				|| (event.kind === "renamed" && under(path, event.from) && !included(inputs, event.to + path.slice(event.from.length)));
			if (deleted && local && !view.has(path) && !local.removed && s.intent?.file !== id)
				s.local.set(id, { ...local, removed: true });
			await reconcile(s, id, view, deleted, inputs);
		}
		if (!s.intent) await parkCycle(s, view, inputs);
	});
}

function sameObservation(a: Observation | null, b: Observation | undefined) {
	return a?.hash === b?.hash && a?.size === b?.size && a?.mtime === b?.mtime;
}

// Execute one already-durable intent. Re-reading an endpoint also distinguishes a completed
// operation from a prepared one after a crash. Scratch bytes never enter disk discovery.
export async function executeIntent(device: TableDevice, disk: DiskPort, i: DiskInputs) {
	return device.change(async s => {
		const op = s.intent;
		if (!op) return false;
		if (!included(i, op.path) || (op.kind === "rename" && !included(i, op.from))) {
			s.intent = undefined;
			return false;
		}
		const bound = s.local.get(op.file)?.path;
		if (bound && bound !== op.path && !(op.kind === "rename" && bound === op.from)) {
			s.intent = undefined; // a later user rename already identified the new endpoint
			return false;
		}
		let unreadable = false;
		const read = async (path: string) => {
			try {
				const stat = await disk.stat(path);
				return stat && await observe(disk, i, stat);
			} catch {
				unreadable = true;
				return (await disk.list()).find(f => f.path === path) as Observation | undefined;
			}
		};
		let dest = await read(op.path);
		const source = op.kind === "rename" ? await read(op.from) : undefined;
		const block = () => {
			const endpoints: Blocked["endpoints"] = [[op.path, dest ?? null]];
			if (op.kind === "rename") endpoints.push([op.from, source ?? null]);
			for (const [path, seen] of endpoints) {
				if (seen?.hash === undefined) s.observed.delete(path);
				else s.observed.set(path, seen);
			}
			s.blocked.set(op.file, { seq: op.seq, authority: op.authority ?? op.file, endpoints });
			s.intent = undefined;
			return false;
		};
		if (unreadable || (dest && dest.hash === undefined) || (source && source.hash === undefined)) return block();
		const removal = op.kind === "remove" || op.kind === "park";
		const done = removal ? !dest : op.kind === "write" ? dest?.hash === op.data.bytes.h : !source && dest?.hash === op.hash;
		if (!done) {
			let applied = false;
			if (s.latest.get(op.authority ?? op.file)?.seq === op.seq && !reserved(s, op.file)) {
				if (op.kind === "write" && (dest?.hash ?? null) === op.before) {
					const saved = s.parked.get(op.file);
					const ref = op.data.bytes;
					let bytes: Uint8Array | undefined;
					if (saved?.h === ref.h) {
						try { bytes = await i.readStage(saved); } catch { /* Try the published version. */ }
						if (bytes && (bytes.length !== ref.n || await i.hash(bytes) !== ref.h)) bytes = undefined;
					}
					if (!bytes) {
						try { bytes = await i.fetch(ref); } catch { return block(); }
						if (bytes.length !== ref.n || await i.hash(bytes) !== ref.h) return block();
					}
					await disk.writeTemp(bytes);
					applied = await disk.installTemp(op.path, op.before);
					await disk.discardTemp();
				} else if (op.kind === "rename" && source?.hash === op.hash && !dest) applied = await disk.moveIf(op.from, op.path, op.hash);
				else if (removal && dest?.hash === op.hash) applied = await disk.removeIf(op.path, op.hash);
			}
			if (!applied) {
				if (op.kind === "rename" && !source && dest && s.local.get(op.file)?.path === op.from) {
					// The move may have finished before a second save. Its bytes have no proven base.
					s.local.set(op.file, { path: op.path, base: { path: op.path } });
				}
				s.intent = undefined;
				return false;
			}
			dest = removal ? undefined : await read(op.path);
		}
		if (op.kind === "rename") s.observed.delete(op.from);
		if (removal) {
			s.observed.delete(op.path);
			s.local.delete(op.file);
			if (op.kind === "park") s.parked.set(op.file, op.saved);
		} else {
			s.parked.delete(op.file);
			const prior = s.local.get(op.file);
			// An edit just after install must be compared to what was installed, even if its event is delayed.
			const base = { path: op.path, bytes: op.kind === "write" ? op.data.bytes : prior?.base.bytes };
			if (dest?.hash !== undefined) s.observed.set(op.path, dest);
			else s.observed.delete(op.path);
			s.local.set(op.file, { path: op.path, base });
		}
		s.intent = undefined;
		return true;
	});
}
