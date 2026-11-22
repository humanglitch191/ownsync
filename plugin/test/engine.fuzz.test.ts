// Fuzz test for the sync engine. Three devices do random things to their vaults while the network delivers,
// delays and drops at random and devices crash in the middle of operations. Every run must end with:
//   1. every device holding the same files with the same text, and attachments with the same bytes,
//   2. every piece of text a user typed still there, unless a user who could see it deleted its note,
//      including text brought back by a restore unless deleted again,
//      and every attachment content a user saved, unless a user who could see it replaced or deleted it,
//   3. no piece of text or attachment content duplicated,
//   4. no errors.
// Each piece of typed text is a unique token, which is what makes 2 and 3 checkable. An attachment's content
// is random bytes around one token, split into several chunks.
//
// FUZZ_RUNS=5000 node --import jiti/register --test test/engine.fuzz.test.ts    longer run
// FUZZ_SEED=1234 ...                                                            replay one failing run
// FUZZ_FIRST=20001 ...                                                          start at another seed

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { NoteMeta } from "../src/core/ports";
import { type Content, Device, Server, bytes, latin1, quiesce, rng } from "./sim";

const POOL = ["a.md", "b.md", "c.md", "d.md", "x/e.md", "x/f.md", "x/y/g.md", "p.png", "q.bin", "x/r.png"];
const isCopy = (path: string) => path.includes("(recovered ");
const isNote = (path: string) => path.endsWith(".md");
const NOTE_PATHS = POOL.filter(isNote);

async function run(seed: number, steps: number): Promise<void> {
	const random = rng(seed);
	const restoreRandom = rng(seed ^ 0x6ae5371d);
	const exerciseRestores = !FIXED.includes(seed); // preserve the original operation sequence for regressions
	const chance = (p: number) => random() < p;
	const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)];
	const server = new Server();
	const devs = [0, 1, 2].map((i) => new Device(`d${i}`, server, random));
	// Every third run, one device syncs notes only: its attachments stay its own, and it must not cost the
	// others any of theirs.
	const notesOnly = new Set(seed % 3 === 0 ? [devs[2]!] : []);
	for (const d of notesOnly) d.overrides = { ...d.overrides, attachments: false };
	const synced = (d: Device, path: string) => isNote(path) || !notesOnly.has(d);
	const fate = new Map<string, "must" | "may">(); // token → must still exist at the end, or may be gone
	const restored = new Map<string, string>(); // restored token → note ID, until a user deletes the token again
	const removedBy = new Map(devs.map((d) => [d, new Set<string>()]));
	const log: string[] = [];
	const seenFiles = new Map<Device, string>();
	const stuck = new Set<Device>();
	if (process.env.FUZZ_LOG) for (const d of devs) d.trace = (line) => log.push(`        ${line.replace(/(state|base|out|note):([0-9a-f]{6})[0-9a-f]*/g, "$1:$2")}`);
	let n = 0;
	const token = (d: Device) => { const t = `<${d.name}.${++n}>`; fate.set(t, "must"); log.push(`    ${t}`); return t; };
	// Tokens are separated by spaces, and new ones go in at a boundary, as whole words do in real typing.
	const insertAt = (text: string, t: string) => { const parts = text ? text.split(" ") : []; parts.splice(Math.floor(random() * (parts.length + 1)), 0, t); return parts.join(" "); };
	const closedFiles = (d: Device) => [...d.files.keys()].filter((p) => { const id = d.engine?.noteAt(p); return !id || !d.editors.has(id); });
	const tokensIn = (content: Content) => latin1(content).match(/<[^>]+>/g) ?? [];
	const remove = (d: Device, path: string) => {
		for (const t of tokensIn(d.files.get(path)!.content)) {
			fate.set(t, "may");
			restored.delete(t);
			removedBy.get(d)!.add(t);
		}
		d.remove(path);
	};
	// Bytes that are no token's, with runs of zeros, so equal chunks turn up across files.
	const noise = () => String.fromCharCode(...Array.from({ length: Math.floor(random() * 7) }, () => pick([0, 0, 0, 0, 1, 10, 61, 128, 255])!));
	const create = (d: Device, path: string): Content => {
		const content = isNote(path) ? token(d) : bytes(noise() + token(d) + noise());
		if (!synced(d, path)) for (const t of tokensIn(content)) fate.set(t, "may"); // never leaves this device
		return content;
	};
	// An attachment can't be edited, only replaced: what it held was the user's to throw away.
	const edit = (d: Device, path: string): Content => {
		const old = d.files.get(path)!.content;
		if (typeof old === "string") return insertAt(old, token(d));
		for (const t of tokensIn(old)) fate.set(t, "may");
		return create(d, path);
	};
	// Half the edits go to attachments, if there are any: few paths, so devices replace the same one at once.
	const toEdit = (paths: string[]) => { const att = paths.filter((p) => !isNote(p)); return pick(att.length && chance(0.5) ? att : paths); };
	// Renamed to a free name of its own kind (Obsidian takes a note renamed to ".png" for a different file).
	const renameTo = (d: Device, from: string) => pick(POOL.filter((x) => !d.files.has(x) && isNote(x) === isNote(from)));

	const autosave = (d: Device, id: string) => {
		const path = d.pathOf(id);
		if (path) d.write(path, d.editors.get(id)!.getText("t").toString());
	};
	const typeIn = (d: Device, doc: Y.Doc) => {
		const text = doc.getText("t"), t = token(d), parts = text.toString() ? text.toString().split(" ") : [];
		const at = Math.floor(random() * (parts.length + 1));
		const pos = parts.slice(0, at).join(" ").length + (at > 0 ? 1 : 0);
		if (!parts.length) text.insert(0, t);
		else if (at === parts.length) text.insert(text.length, ` ${t}`);
		else text.insert(pos, `${t} `);
	};
	// After a crash: typing that was neither recorded nor saved by the editor is gone, as it would be in real life.
	const reap = (d: Device, editors: Map<string, Y.Doc>, typed: Set<string>) => {
		const kept = [...d.files.values()].map((f) => latin1(f.content)).join(" ") +[...editors.keys()].map((id) => d.storedText(id)).join(" ");
		for (const t of typed) if (!kept.includes(t)) fate.set(t, "may");
	};

	for (const d of devs) { d.boot(); d.connect(); }
	for (let step = 0; step < steps; step++) {
		const d = pick(devs)!;
		const editorsBefore = new Map(d.editors), typed = new Set<string>();
		const wasAlive = d.alive;
		let closing: string | undefined, interrupted = false;
		// While the engine reads a file, the user may save a change to that very file.
		d.onRead = (path) => {
			const id = d.engine?.noteAt(path);
			// Not for a note open in an editor, or being opened or closed this instant: there Obsidian merges an
			// outside write into the editor itself, and the engine treats the file as the editor's save
			// (see "doc" mode in engine.ts).
			if (!interrupted && chance(0.04) && !(id && (d.editors.has(id) || id === closing)) && d.files.has(path)) { interrupted = true; log.push(`${d.name} edits ${path} mid-read`); d.write(path, edit(d, path)); }
		};
		const r = random() * 100;
		if (!d.alive) {
			if (r < 30) { log.push(`${d.name} boots`); d.boot(); if (chance(0.7)) d.connect(); }
			else if (r < 45) { const p = toEdit([...d.files.keys()]); if (p) { log.push(`${d.name} (app closed) edits ${p}`); d.write(p, edit(d, p)); } }
			else if (r < 52) { const p = pick(POOL.filter((x) => !d.files.has(x))); if (p) { log.push(`${d.name} (app closed) creates ${p}`); d.write(p, create(d, p)); } }
			else if (r < 58) { const p = pick([...d.files.keys()].filter((x) => !isCopy(x))), to = p && renameTo(d, p); if (p && to) { log.push(`${d.name} (app closed) renames ${p} → ${to}`); d.rename(p, to); } }
			else if (r < 62) { const p = pick([...d.files.keys()]); if (p) { log.push(`${d.name} (app closed) deletes ${p}`); remove(d, p); } }
		} else if (r < 8) { const p = pick(POOL.filter((x) => !d.files.has(x))); if (p) { log.push(`${d.name} creates ${p}`); d.write(p, create(d, p)); } }
		else if (r < 20) { const p = toEdit(closedFiles(d)); if (p) { log.push(`${d.name} edits ${p}`); d.write(p, edit(d, p)); } }
		else if (r < 24) { const p = pick(closedFiles(d).filter((x) => !isCopy(x))), to = p && renameTo(d, p); if (p && to) { log.push(`${d.name} renames ${p} → ${to}`); d.rename(p, to); } }
		else if (r < 27) { const p = pick(closedFiles(d)); if (p) { log.push(`${d.name} deletes ${p}`); remove(d, p); } }
		else if (r < 32) {
			const id = pick([...d.files.keys()].filter(isNote).map((p) => d.engine!.noteAt(p)).filter((x): x is string => !!x && !d.editors.has(x)));
			if (id) { log.push(`${d.name} opens ${d.pathOf(id)}`); closing = id; d.drain(); const doc = await d.engine!.open(id); if (doc && d.alive) d.editors.set(id, doc); }
		} else if (r < 47) { const e = pick([...d.editors]); if (e) { log.push(`${d.name} types in ${d.pathOf(e[0])}`); const before = fate.size; typeIn(d, e[1]); typed.add([...fate.keys()][before]!); } }
		else if (r < 53) { const id = pick([...d.editors.keys()]); if (id) { log.push(`${d.name} autosaves ${d.pathOf(id)}`); autosave(d, id); } }
		else if (r < 57) { const id = pick([...d.editors.keys()]); if (id) { log.push(`${d.name} closes ${d.pathOf(id)}`); autosave(d, id); const engine = d.engine!; d.editors.delete(id); closing = id; d.drain(); void engine.close(id); } }
		else if (r < 68) { const e = d.events.shift(); if (e) e(); }
		else if (r < 71 && exerciseRestores) {
			const engine = d.engine!;
			d.drain();
			const deleted = await engine.deletedNotes();
			const note = deleted[Math.floor(restoreRandom() * deleted.length)];
			if (note && d.alive) {
				const target = restoreRandom() < 0.5 ? undefined : NOTE_PATHS[Math.floor(restoreRandom() * NOTE_PATHS.length)];
				const path = isCopy(note.path) ? undefined : target; // as with renames, keep recovery copies named as copies
				log.push(`${d.name} restores ${note.path}${path ? ` → ${path}` : ""} (${note.id.slice(0, 6)})`);
				const text = (await engine.deletedText(note.id)) ?? "";
				await engine.restoreDeleted(note.id, path);
				// A peer that still sees the old live note can reconcile an unprocessed delete and recreate
				// as a text replacement. Its legitimate CRDT text deletion can merge after this restore.
				const livePeers = devs.filter((peer) => {
					if (peer === d) return false;
					const entry = peer.storedIndex().get(note.id);
					return entry && entry.d === undefined;
				}).map((peer) => {
					const path = (peer.data.get(`note:${note.id}`) as NoteMeta | undefined)?.diskPath;
					const content = path ? peer.files.get(path)?.content : undefined;
					return { peer, text: typeof content === "string" ? content : "" };
				});
				for (const t of tokensIn(text)) {
					if (!livePeers.some(({ peer, text }) => removedBy.get(peer)!.has(t) && !text.includes(t))) restored.set(t, note.id);
				}
			}
		}
		else if (r < 80) d.pumpUp();
		else if (r < 92) d.pumpDown();
		// Time passes: whatever is online catches up. Edits after this start from shared versions, so they
		// meet as concurrent edits; an attachment needs a dozen messages, more than random steps often allow.
		else if (r < 93) { log.push("everything online catches up"); await quiesce(devs); }
		else if (r < 96) { log.push(`${d.name} ${d.online ? "goes offline" : "comes online"}`); if (d.online) d.disconnect(); else d.connect(); }
		else if (r < 98) { log.push(`${d.name} crashes`); if (chance(0.5)) for (const id of d.editors.keys()) autosave(d, id); d.crash(); }
		else { const fuse = 1 + Math.floor(random() * 12); log.push(`${d.name} will crash after ${fuse} calls`); d.crash(fuse); }

		for (const x of devs) await x.idle();
		if (process.env.FUZZ_LOG) for (const x of devs) {
			const st = x.data.get("index") as Uint8Array | undefined, probe = new Y.Doc();
			if (st) Y.applyUpdate(probe, st);
			const waiting = !!(probe.store as unknown as { pendingStructs: unknown }).pendingStructs;
			if (waiting !== stuck.has(x)) { log.push(`      [${x.name}] index ${waiting ? "is now WAITING for an update it doesn't have" : "is complete again"}`); if (waiting) stuck.add(x); else stuck.delete(x); }
			const now = `      [${x.name}${x.alive ? "" : " dead"}] ${[...x.files].map(([p, f]) => `${p}=${JSON.stringify(latin1(f.content))}`).sort().join(" | ")}`;
			if (seenFiles.get(x) !== now) { seenFiles.set(x, now); log.push(now); }		}
		if (wasAlive && !d.alive) reap(d, editorsBefore, typed);
		d.onRead = null;
	}

	// Calm down: close editors, start everything, connect everything, let it all drain.
	log.push("calm down");
	for (const d of devs) {
		d.onRead = null;
		d.crash(1e9); // disarm any pending fuse
		if (!d.alive) d.boot();
		for (const id of [...d.editors.keys()]) { autosave(d, id); d.editors.delete(id); d.drain(); void d.engine!.close(id); }
		d.connect();
	}
	await quiesce(devs);

	if (process.env.FUZZ_LOG) (await import("node:fs")).writeFileSync(process.env.FUZZ_LOG, log.join("\n") + "\n");
	const fail = (message: string) => assert.fail(`${message}\nseed ${seed}, last steps:\n  ${log.slice(-40).join("\n  ")}`);
	// Byte for byte: an attachment's bytes as one character each, and marked, so a note never equals one.
	// What each device syncs: a notes-only device is compared on its notes alone.
	const disks = devs.map((d) => JSON.stringify([...d.files].filter(([p]) => isNote(p) || !notesOnly.size).map(([p, f]) => [p, typeof f.content === "string" ? f.content : `bytes:${latin1(f.content)}`]).sort()));
	const full = devs.filter((d) => !notesOnly.has(d)).map((d) => JSON.stringify([...d.files].map(([p, f]) => [p, typeof f.content === "string" ? f.content : `bytes:${latin1(f.content)}`]).sort()));
	for (const d of notesOnly) for (const [p] of d.files) if (!isNote(p) && devs.some((x) => x !== d && !notesOnly.has(x) && x.files.get(p) && latin1(x.files.get(p)!.content) === latin1(d.files.get(p)!.content))) {
		// The same bytes on a syncing device would mean an attachment travelled to or from the notes-only one.
		const own = tokensIn(d.files.get(p)!.content).every((t) => t.startsWith(`<${d.name}.`));
		if (!own) fail(`${d.name} syncs notes only, but has ${p} from another device`);
	}
	for (const d of devs) if (d.problems.length) fail(`errors on ${d.name}:\n${d.problems.join("\n")}`);
	const sync = devs.map((d) => `${d.name}: cursor ${(d.data.get("meta") as { cursor: number } | undefined)?.cursor}, unsent ${[...d.data.keys()].filter((k) => k.startsWith("out:")).join(",") || "none"}, online ${d.online}`).join("; ");
	const index = devs[0]!.storedIndex();
	const indexes = [index, ...devs.slice(1).map((d) => d.storedIndex())].map((entries) => new Map([...entries].map(([id, v]) => [id.slice(0, 6), `${v.p}${v.d === undefined ? "" : " (deleted)"}`])));
	const indexDiff = [...new Set(indexes.flatMap((m) => [...m.keys()]))].filter((id) => new Set(indexes.map((m) => m.get(id))).size > 1).map((id) => `${id}: ${indexes.map((m) => m.get(id) ?? "-").join(" | ")}`);
	if (process.env.FUZZ_LOG) log.push(`index waiting for missing updates: ${devs.map((d) => { const doc = new Y.Doc(); const st = d.data.get("index") as Uint8Array | undefined; if (st) Y.applyUpdate(doc, st); const p = (doc.store as unknown as { pendingStructs: { missing: Map<number, number> } | null }).pendingStructs; return `${d.name}: ${p ? JSON.stringify([...p.missing]) : "no"}`; }).join("; ")}`);
	if (process.env.FUZZ_LOG) log.push(`index differences: ${indexDiff.join("; ") || "none"}`, `server rows: ${server.rows.map((r) => `${r.seq}:${r.entry.doc.slice(0, 6)}${r.entry.kind === "snapshot" ? "S" : ""}`).join(" ")}`);
	if (process.env.FUZZ_LOG) (await import("node:fs")).writeFileSync(process.env.FUZZ_LOG, log.join("\n") + "\n");
	if (new Set(full).size > 1) fail(`devices that sync attachments ended with different vaults:\n${full.join("\n")}`);
	if (new Set(disks).size !== 1) fail(`devices ended with different vaults (server head ${server.head}; ${sync}):\n${devs.map((d, i) => `${d.name}: ${disks[i]}`).join("\n")}`);
	for (const d of devs) {
		const left = [...d.data.keys()].filter((k) => k.startsWith("out:") || k.startsWith("base:") || k.startsWith("up:"));
		if (left.length) fail(`${d.name} still has unsent or unwritten work: ${left.join(", ")}\n${disks[0]}`);
	}
	const files = [...devs[0]!.files], main = files.filter(([p]) => !isCopy(p)).map(([, f]) => latin1(f.content)).join(" "), all = files.map(([, f]) => latin1(f.content)).join(" ");
	for (const [t, f] of fate) {
		const count = main.split(t).length - 1;
		if (count > 1) fail(`${t} is duplicated (${count} times)\n${disks[0]}`);
		if (f === "must" && !all.includes(t)) fail(`${t} was lost\n${disks[0]}`);
	}
	for (const [t, id] of restored) {
		if (index.get(id)?.d !== undefined) continue; // a deletion can still win
		if (!all.includes(t)) fail(`${t} was lost from restored note ${id}\n${disks[0]}`);
	}
}

const RUNS = Number(process.env.FUZZ_RUNS ?? 300), STEPS = Number(process.env.FUZZ_STEPS ?? 250);
test(`fuzz: ${process.env.FUZZ_SEED ? `seed ${process.env.FUZZ_SEED}` : `${RUNS} random runs`} of ${STEPS} steps converge without losing or duplicating text`, async () => {
	if (process.env.FUZZ_SEED) return run(Number(process.env.FUZZ_SEED), STEPS);
	const first = Number(process.env.FUZZ_FIRST ?? 1);
	for (let seed = first; seed < first + RUNS; seed++) {
		try {
			await run(seed, STEPS);
		} catch (err) {
			// A failed check names its seed already; anything else that throws must too, or it can't be replayed.
			if (err instanceof Error && !/seed \d+, last steps/.test(err.message)) err.message += `\nseed ${seed}`;
			throw err;
		}
	}
});

// Seeds the nightly batch once failed on (text lost or duplicated), kept so those bugs stay fixed.
const FIXED = [
	163124, 180757, 200871, 225880, 241307, 260188, 283658, 303416, 327079, 340276, 361266, 381853, 403231,
	420062, 451630, 461174, 486793, 507078, 521854, 540252, 565728, 580612, 611597, 622096, 640605, 662128,
	680463, 703288, 725156, 740581, 765662, 780535, 801185, 820883, 840069, 862289, 887676, 904453, 921530,
	940943, 1296505, 1379070, 5000539, 5003249
];
test(`fuzz: ${FIXED.length} seeds that once failed`, { skip: !!process.env.FUZZ_SEED || !!process.env.FUZZ_FIRST }, async () => {
	for (const seed of FIXED) await run(seed, 250);
});
