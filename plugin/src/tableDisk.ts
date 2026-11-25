// Only this adapter moves bytes into the plugin folder. Its journal outlives the planner's
// intent so a restart can distinguish an absent file from a destination we displaced.
import type { DataAdapter } from "obsidian";
import type { Store } from "./core/ports";
import type { DiskPort } from "./core/table/disk";

type AttachmentFs = Pick<DataAdapter, "stat" | "list" | "readBinary" | "writeBinary" | "exists" | "mkdir" | "remove" | "copy" | "rename">;
type Mutation = { from: string; to?: string; expected: string | null; kind: "remove" | "install" | "move" };
export class TableDisk implements DiskPort {
	private get temp() { return this.scratch + "/incoming"; }
	private get displaced() { return this.scratch + "/displaced"; }
	constructor(private fs: AttachmentFs, private store: Store, private scratch: string,
		readonly allowed: (path: string) => boolean, private hash: (bytes: Uint8Array) => Promise<string>,
		private suffix: (h: string, n: number) => Promise<string>, private journal = "table/fs") { }
	private check(p: string) { if (!this.allowed(p)) throw new Error("Invalid attachment path"); }
	async stat(path: string) {
		this.check(path);
		const f = await this.fs.stat(path);
		return f?.type === "file" ? { path, size: f.size, mtime: f.mtime } : undefined;
	}
	async list() {
		const files = [], folders = [""];
		while (folders.length) {
			const found = await this.fs.list(folders.pop()!);
			for (const folder of found.folders) if (this.allowed(folder + "/file") || this.allowed(folder + "/file.md")) folders.push(folder);
			for (const p of found.files) if (this.allowed(p)) {
				const f = await this.stat(p);
				if (f) files.push(f);
			}
		}
		return files;
	}
	async readBinary(p: string) { this.check(p); return new Uint8Array(await this.fs.readBinary(p)); }
	private async folder(p: string) {
		const dir = p.split("/").slice(0, -1).join("/");
		if (dir && !await this.fs.exists(dir)) {
			await this.folder(dir);
			try { await this.fs.mkdir(dir); } catch (e) { if (!await this.fs.exists(dir)) throw e; }
		}
	}
	private async remove(p: string) { if (await this.fs.exists(p)) await this.fs.remove(p); }
	private async digest(p: string) { return this.hash(new Uint8Array(await this.fs.readBinary(p))); }
	async writeTemp(bytes: Uint8Array) {
		await this.folder(this.temp);
		await this.fs.writeBinary(this.temp, bytes.slice().buffer);
	}
	private async copy(from: string, to: string) {
		await this.folder(to);
		try { await this.fs.copy(from, to); return true; }
		catch (e) { if (!await this.fs.exists(to)) throw e; return false; }
	}
	// A change between checking and displacing is still the user's file. Return it to its path;
	// if a second save already occupies that path, preserve both for normal disk reconciliation.
	private async putBack(path: string, hash: string) {
		let dest = path;
		for (let n = 0; ; n++) {
			await this.copy(this.displaced, dest);
			if (await this.digest(dest) === hash) return;
			const suffix = await this.suffix(hash, n);
			dest = path.replace(/(\.[^./]*)?$/, (_, ext) => ` (conflict ${suffix})${ext ?? ""}`);
		}
	}
	private async finish(op: Mutation) {
		this.check(op.from);
		if (op.to) this.check(op.to);
		let applied = false;
		const held = await this.fs.exists(this.displaced);
		// A private rename is exclusive to this journal. Installing at any visible destination
		// uses copy's no-overwrite contract: a later user save always survives.
		const actual = held ? await this.digest(this.displaced) : null;
		if (actual !== op.expected) {
			if (held) await this.putBack(op.from, actual!);
		} else if (op.kind === "remove") applied = true;
		else {
			const source = op.kind === "move" ? this.displaced : this.temp;
			const dest = op.to ?? op.from;
			if (await this.fs.exists(source)) {
				const want = await this.digest(source);
				await this.copy(source, dest);
				applied = await this.digest(dest) === want;
			}
			if (!applied && held && op.kind === "move") await this.putBack(op.from, actual!);
		}
		// Forget the journal first. A crash here leaves only disposable private bytes.
		await this.store.commit(new Map(), [this.journal]);
		await this.remove(this.displaced);
		return applied;
	}
	async discardTemp() {
		const op = await this.store.get<Mutation>(this.journal);
		if (op) await this.finish(op);
		await this.remove(this.displaced); await this.remove(this.temp);
	}
	private async mutate(op: Mutation) {
		this.check(op.from); if (op.to) this.check(op.to);
		await this.folder(this.displaced);
		if (await this.store.get(this.journal)) throw new Error("Interrupted attachment mutation");
		await this.remove(this.displaced);
		await this.store.commit(new Map([[this.journal, op]]), []);
		if (op.expected !== null && await this.fs.exists(op.from)) await this.fs.rename(op.from, this.displaced);
		return this.finish(op);
	}
	installTemp(path: string, before: string | null) { return this.mutate({ kind: "install", from: path, expected: before }); }
	removeIf(path: string, expected: string) { return this.mutate({ kind: "remove", from: path, expected }); }
	moveIf(from: string, to: string, expected: string) { return this.mutate({ kind: "move", from, to, expected }); }
}
