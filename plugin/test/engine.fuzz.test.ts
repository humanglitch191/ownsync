// Fuzz test for the sync engine. Three devices do random things to their vaults while the network delivers,
// delays and drops at random and devices crash in the middle of operations. Every run must end with:
//   1. every device holding the same files with the same text, and attachments with the same bytes,
//   2. every piece of text a user typed still there, unless a user who could see it deleted its note,
//      including text brought back by a restore unless deleted again,
//      and every attachment content a user saved, unless a user who could see it replaced or deleted it,
//   3. no piece of text or attachment content duplicated,
//   4. no errors,
//   5. and, with the owner cleaning up past history at random (DESIGN.md section 10), no live attachment's
//      versions referring to a chunk the Worker doesn't hold.
// Each piece of typed text is a unique token, which is what makes 2 and 3 checkable. An attachment's content
// is random bytes around one token, split into several chunks.
//
// FUZZ_RUNS=5000 node --import jiti/register --test test/engine.fuzz.test.ts    longer run
// FUZZ_SEED=1234 ...                                                            replay one failing run
// FUZZ_FIRST=20001 ...                                                          start at another seed

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { NoteMeta, Ref } from "../src/core/ports";
import { type Content, Device, SCOPED, Server, bytes, latin1, quiesce, rng } from "./sim";

const POOL = ["a.md", "b.md", "c.md", "d.md", "x/e.md", "x/f.md", "x/y/g.md", "p.png", "q.bin", "x/r.png"];
const isCopy = (path: string) => path.includes("(recovered ");
const isNote = (path: string) => path.endsWith(".md");
const NOTE_PATHS = POOL.filter(isNote);
const DAY = 86_400_000;

async function run(seed: number, steps: number): Promise<void> {
	const random = rng(seed);
	const restoreRandom = rng(seed ^ 0x6ae5371d);
	const exerciseRestores = !FIXED.includes(seed); // preserve the original operation sequence for regressions
	const chance = (p: number) => random() < p;
	const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)];
	const server = new Server();
	const devs = [0, 1, 2].map((i) => new Device(`d${i}`, server, random));
	// Version-scoped chunks and Clean up, except in the seeds kept from before them (their runs stay as they were).
	// Days pass and the owner cleans up on a generator of their own, so the devices' moves stay those of the seed.
	const storage = !FIXED.includes(seed), storageRandom = rng(seed ^ 0x2c1b3c6d);
	if (storage) for (const d of devs) d.overrides = { ...SCOPED };
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

	let tabsClosed = false;
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
			if (id) {
				log.push(`${d.name} opens ${d.pathOf(id)}`); closing = id; d.drain();
				const engine = d.engine!, path = d.pathOf(id)!;
				const bind = async () => {
					if (tabsClosed || !d.alive || d.engine !== engine) return;
					const owner = engine.noteAt(path);
					if (!owner) return;
					const doc = await engine.open(owner);
					if (!doc || !d.alive || d.engine !== engine) return;
					if (!tabsClosed && engine.noteAt(path) === owner) d.editors.set(owner, doc);
					else if (!d.editors.has(owner)) await engine.close(owner);
				};
				if (engine.readyForEditors) await bind();
				else void engine.startupScan.then(ready => { if (ready) return bind(); });
			}
		} else if (r < 47) { const e = pick([...d.editors]); if (e) { log.push(`${d.name} types in ${d.pathOf(e[0])}`); const before = fate.size; typeIn(d, e[1]); typed.add([...fate.keys()][before]!); } }
		else if (r < 53) { const id = pick([...d.editors.keys()]); if (id) { log.push(`${d.name} autosaves ${d.pathOf(id)}`); autosave(d, id); } }
		else if (r < 57) { const id = pick([...d.editors.keys()]); if (id) { log.push(`${d.name} closes ${d.pathOf(id)}`); autosave(d, id); const engine = d.engine!; d.editors.delete(id); closing = id; d.drain(); void engine.close(id); } }
		else if (r < 68) { const e = d.events.shift(); if (e) e(); }
		else if (r < 71 && exerciseRestores) {
			const engine = d.engine!;
			d.drain();
			// The list may ask the Worker which deleted attachments it still stores: this device's link carries the answer.
			let deleted = undefined as { id: string; path: string }[] | undefined;
			void engine.deletedNotes().then((list) => { deleted = list; }, () => { deleted = []; });
			for (let quiet = 0; !deleted && d.alive && quiet < 3;) { const moved = d.pumpUp() || d.pumpDown(); await d.idle(); quiet = moved ? 0 : quiet + 1; }
			deleted ??= [];
			const note = deleted[Math.floor(restoreRandom() * deleted.length)];
			if (note && d.alive && !isNote(note.path)) {
				// An attachment: back only if the Worker still has its content, which takes a round trip.
				log.push(`${d.name} restores attachment ${note.path} (${note.id.slice(0, 6)})`);
				void engine.restoreAttachment(note.id);
			} else if (note && d.alive) {
				const target = restoreRandom() < 0.5 ? undefined : NOTE_PATHS[Math.floor(restoreRandom() * NOTE_PATHS.length)];
				const path = isCopy(note.path) ? undefined : target; // as with renames, keep recovery copies named as copies
				log.push(`${d.name} restores ${note.path}${path ? ` → ${path}` : ""} (${note.id.slice(0, 6)})`);
				const text = (await engine.deletedText(note.id)) ?? "";
				await engine.restoreDeleted(note.id, path);
				// A peer can have reconciled a delete and recreate as a text replacement, a legitimate CRDT text
				// deletion that merges after this restore if this device hadn't seen it yet; whether the peer still
				// sees the note live (its file) or has deleted it again since (its stored copy).
				const peers = devs.filter((peer) => peer !== d && peer.storedIndex().has(note.id)).map((peer) => {
					if (peer.storedIndex().get(note.id)!.d === undefined) {
						const path = (peer.data.get(`note:${note.id}`) as NoteMeta | undefined)?.diskPath;
						const content = path ? peer.files.get(path)?.content : undefined;
						return { peer, text: typeof content === "string" ? content : "" };
					}
					const doc = new Y.Doc(), state = peer.data.get(`state:${note.id}`) as Uint8Array | undefined;
					if (state) Y.applyUpdate(doc, state);
					const kept = doc.getText("t").toString();
					doc.destroy();
					return { peer, text: kept };
				});
				for (const t of tokensIn(text)) {
					if (!peers.some(({ peer, text }) => removedBy.get(peer)!.has(t) && !text.includes(t))) restored.set(t, note.id);
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

		if (storage) {
			server.clock++;
			const s = storageRandom();
			if (s < 0.02) {
				// Over a day, whatever is online catches up, and sends its daily list.
				log.push("a day passes; everything online catches up");
				server.clock += DAY;
				for (const x of devs) x.passTime(DAY);
				await quiesce(devs);
			} else if (s < 0.05) {
				// Mostly everything past, as an owner would; sometimes a slice of it.
				const all = storageRandom() < 0.7, to = all ? server.clock : Math.floor(storageRandom() * server.clock) + 1, from = all ? 0 : Math.floor(storageRandom() * to);
				const retired = [...server.versions.values()].filter((v) => v.retiredAt !== null).length;
				log.push(`the owner cleans up [${from}, ${to}): ${server.cleanUp(from, to)} chunks (${retired} of ${server.versions.size} versions retired, last list at ${server.listedAt})`);
			}
		}

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
	tabsClosed = true;
	for (const d of devs) {
		d.onRead = null;
		d.crash(1e9); // disarm any pending fuse
		if (!d.alive) d.boot();
		for (const id of [...d.editors.keys()]) { autosave(d, id); d.editors.delete(id); d.drain(); void d.engine!.close(id); }
		d.connect();
	}
	await quiesce(devs);
	// Two more days: every device sends its list (a device holding a version the Worker is missing chunks of puts
	// them back), then connects again (a download that found them missing is tried again).
	if (storage) for (let day = 0; day < 2; day++) {
		log.push("a day passes");
		server.clock += DAY;
		for (const d of devs) { d.passTime(DAY); d.disconnect(); d.connect(); }
		await quiesce(devs);
	}

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
	// A download can find a version's chunks cleaned up (it came back, by a rename winning over a deletion, say)
	// until a device that has the file puts them back: tried again, so not an error, as long as 5 holds at the end.
	const expected = (p: string) => server.removed.size > 0 && p.includes("a chunk is missing on the server");
	for (const d of devs) if (d.problems.some((p) => !expected(p))) fail(`errors on ${d.name}:\n${d.problems.filter((p) => !expected(p)).join("\n")}`);
	for (const d of devs) {
		if (notesOnly.has(d)) continue;
		for (const [id, v] of d.storedIndex()) {
			if (v.d !== undefined || isNote(v.p)) continue;
			const doc = new Y.Doc(), state = d.data.get(`state:${id}`) as Uint8Array | undefined;
			if (state) Y.applyUpdate(doc, state);
			const refs = doc.getArray<Ref>("v").toArray(), gone = refs.flatMap((r) => r.c).filter((name) => !server.chunks.has(name));
			doc.destroy();
			if (gone.length) fail(`${d.name}: live attachment ${v.p} (${id.slice(0, 6)}, versions ${refs.map((r) => r.u.slice(0, 6)).join(", ")}) refers to chunks the Worker doesn't hold (${gone.filter((n) => server.removed.has(n)).length} of ${gone.length} cleaned up)`);
		}
	}
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
// Seeds that failed with restores and Clean up in play (each runs with them, unlike FIXED).
const FAILED = [
	1610460, 1621736, 1645185, 1661421, 1691034, 1703746, 1724336, 1743398, 1762951, 1781044, 1803511, 1820440,
	1843276, 1860490, 1880494, 1901034, 1957125, 1971785, 1986257, 2003566, 2031220, 2046034, 2061343, 2102409,
	2170737, 2192509, 2281409, 2561205, 2644373, 2680806, 2719789, 2923193, 3244949, 3287775
];
test(`fuzz: ${FAILED.length} seeds that failed with restores and Clean up`, { skip: !!process.env.FUZZ_SEED || !!process.env.FUZZ_FIRST }, async () => {
	for (const seed of FAILED) await run(seed, 250);
});

test(`fuzz: ${FIXED.length} seeds that once failed`, { skip: !!process.env.FUZZ_SEED || !!process.env.FUZZ_FIRST }, async () => {
	for (const seed of FIXED) await run(seed, 250);
});
