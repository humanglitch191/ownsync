// The vault's files, as the engine sees them: notes and attachments, never the settings folder.

import { type App, TFile, normalizePath } from "obsidian";
import type { Disk, DiskFile } from "./core/ports";

export class VaultDisk implements Disk {
	constructor(private readonly app: App) {}

	/** A file that syncs: anything in the vault outside its settings folder. */
	synced(f: unknown): f is TFile {
		return f instanceof TFile && !f.path.startsWith(`${this.app.vault.configDir}/`);
	}

	private file(path: string): TFile | undefined {
		const f = this.app.vault.getAbstractFileByPath(path);
		return this.synced(f) ? f : undefined;
	}

	async list(): Promise<DiskFile[]> {
		return this.app.vault.getFiles().filter((f) => this.synced(f)).map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
	}

	// Obsidian's own record of the file, the same one `list` reads: the engine compares the two.
	async stat(path: string): Promise<DiskFile | undefined> {
		const f = this.file(path);
		return f && { path, mtime: f.stat.mtime, size: f.stat.size };
	}

	async read(path: string): Promise<string> {
		const f = this.file(path);
		if (!f || f.extension !== "md") throw new Error(`no note at ${path}`);
		return this.app.vault.read(f);
	}

	async readBinary(path: string): Promise<Uint8Array> {
		const f = this.file(path);
		if (!f) throw new Error(`no file at ${path}`);
		return new Uint8Array(await this.app.vault.readBinary(f));
	}

	async write(path: string, content: string): Promise<DiskFile> {
		this.check(path, true);
		const existing = this.file(path);
		// process, not modify: Obsidian's atomic write, so a save it makes at the same moment can't slip in between.
		if (existing) await this.app.vault.process(existing, () => content);
		else {
			await this.folderFor(path);
			await this.app.vault.create(path, content);
		}
		return (await this.stat(path))!;
	}

	async writeBinary(path: string, content: Uint8Array): Promise<DiskFile> {
		this.check(path, false);
		// The engine hands over a buffer of its own; copy only a view into a larger one.
		const data = (content.byteLength === content.buffer.byteLength ? content.buffer : content.slice().buffer) as ArrayBuffer;
		const existing = this.file(path);
		if (existing) await this.app.vault.modifyBinary(existing, data);
		else {
			await this.folderFor(path);
			await this.app.vault.createBinary(path, data);
		}
		return (await this.stat(path))!;
	}

	async remove(path: string): Promise<void> {
		const f = this.file(path);
		if (f) await this.app.fileManager.trashFile(f);
	}

	// vault.rename, not fileManager.renameFile: links were already rewritten on the device where the user renamed it.
	async rename(from: string, to: string): Promise<void> {
		const f = this.file(from);
		if (!f) throw new Error(`no file at ${from}`);
		this.check(to, from.endsWith(".md"));
		await this.folderFor(to);
		await this.app.vault.rename(f, to);
	}

	// Paths come from other devices: only plain vault-relative paths of the expected kind, outside the settings
	// folder and hidden folders (which Obsidian doesn't show, so nothing in them is ever synced from here).
	private check(path: string, note: boolean): void {
		if (path !== normalizePath(path) || path.endsWith(".md") !== note || path.split("/").some((s) => s === "" || s.startsWith(".")) || path.startsWith(`${this.app.vault.configDir}/`)) {
			throw new Error(`refusing to write outside the vault's files: ${path}`);
		}
	}

	private async folderFor(path: string): Promise<void> {
		const folder = path.split("/").slice(0, -1).join("/");
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
	}
}
