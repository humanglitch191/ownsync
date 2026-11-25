// Filesystem boundary of the note planner. Only a complete listing can establish absence.
import { digest } from "lib0/hash/sha256";
import { hex } from "../../../../protocol/ownsync";
import type { DiskFile } from "../ports";
import type { DiskPort } from "./disk";
import type { DiskObsFile, NoteInput, NoteIntent } from "./notePlanner";

export const noteHash = (text: string) => hex(digest(new TextEncoder().encode(text)));
type Observation = Extract<NoteInput, { t: "diskObs" }>;
type Done = Extract<NoteInput, { t: "intentDone" }>;

async function readFile(disk: DiskPort, path: string, stat?: DiskFile): Promise<DiskObsFile | undefined> {
	try {
		stat ??= await disk.stat(path);
		if (!stat) return;
		const bytes = await disk.readBinary(path), after = await disk.stat(path);
		if (after?.mtime !== stat.mtime || after.size !== bytes.length || stat.size !== bytes.length) throw new Error("Changed during read");
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		return { stat, text, hash: noteHash(text) };
	} catch {
		return { stat: stat ?? { path, mtime: 0, size: 0 }, unreadable: true };
	}
}

export async function observeNotes(disk: DiskPort, event: Observation["event"], path?: string, to?: string, agreed?: (stat: DiskFile) => DiskObsFile | undefined): Promise<Observation> {
	const files = new Map<string, DiskObsFile>();
	const input: Observation = { t: "diskObs", event, path, from: to ? path : undefined, to, listingComplete: true, files };
	if (path) {
		for (const p of to ? [path, to] : [path]) {
			const file = await readFile(disk, p);
			if (file) files.set(p, file);
		}
	} else {
		let list: DiskFile[];
		try { list = await disk.list(); } catch { input.listingComplete = false; return input; }
		for (const stat of list) {
			const file = agreed?.(stat) ?? await readFile(disk, stat.path, stat);
			if (file) files.set(stat.path, file);
		}
	}
	return input;
}

export async function executeNote(disk: DiskPort, intent: NoteIntent): Promise<Done> {
	if (disk.allowed && (!disk.allowed(intent.path) || (intent.kind === "move" && !disk.allowed(intent.from)))) {
		return {t: "intentDone", intent, outcome: "unreadable"};
	}
	let applied: boolean;
	if (intent.kind === "write") {
		await disk.writeTemp(new TextEncoder().encode(intent.text));
		applied = await disk.installTemp(intent.path, intent.expectedHash);
	} else if (intent.kind === "move") applied = await disk.moveIf(intent.from, intent.path, intent.expectedHash);
	else applied = await disk.removeIf(intent.path, intent.expectedHash);
	const after = await readFile(disk, intent.path);
	if (!applied && intent.kind === "move") {
		const source = await readFile(disk, intent.from);
		return { t: "intentDone", intent, outcome: after?.unreadable || source?.unreadable ? "unreadable" : "preconditionFailed", after, source };
	}
	if (after?.unreadable) return { t: "intentDone", intent, outcome: "unreadable", after };
	if (intent.kind === "write" && after?.text !== intent.text) applied = false;
	return { t: "intentDone", intent, outcome: applied ? "applied" : "preconditionFailed", after };
}
