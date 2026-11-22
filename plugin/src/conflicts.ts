import { type App, type EventRef, Modal, Notice, TFile } from "obsidian";

const COPY = /^(.*) \(conflict [0-9a-f]{6}\)(\.[^./]*)?$/;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** The engine's conflictName() in reverse: the path this copy was made from, or null if it is not a copy. A copy of a copy gives the first copy. */
export function conflictOriginal(path: string): string | null {
	if (path.endsWith(".md")) return null;
	const m = COPY.exec(path);
	return m ? m[1]! + (m[2] ?? "") : null;
}

export interface ConflictHost {
	app: App;
	registerEvent(ref: EventRef): void;
	addCommand(c: { id: string; name: string; callback: () => void }): unknown;
}

interface Pair { original: TFile; copy: TFile }

function pairOf(app: App, file: unknown): Pair | null {
	if (!(file instanceof TFile)) return null;
	const o = conflictOriginal(file.path);
	const original = o && app.vault.getAbstractFileByPath(o);
	return original instanceof TFile ? { original, copy: file } : null;
}

const allPairs = (app: App) => app.vault.getFiles().flatMap((f) => pairOf(app, f) ?? []);

// Built on first use, so this file loads (for the tests) where obsidian's Modal does not exist.
const conflictModal = () => class ConflictModal extends Modal {
	constructor(app: App, private pairs: Pair[]) { super(app); }

	onOpen(): void {
		this.setTitle("Attachment conflicts");
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		if (!this.pairs.length) return this.close();
		for (const p of this.pairs) {
			const box = this.contentEl.createDiv({ cls: "ownsync-conflict" });
			box.createEl("h4", { text: p.original.path });
			const row = box.createDiv({ cls: "ownsync-conflict-row" });
			this.side(row, p, p.original, "Keep this one", "Deletes the other copy.", () => this.app.fileManager.trashFile(p.copy));
			this.side(row, p, p.copy, "Keep this one", "Replaces the original with this copy.", async () => {
				await this.app.fileManager.trashFile(p.original);
				await this.app.fileManager.renameFile(p.copy, p.original.path);
			});
		}
	}

	private side(row: HTMLElement, p: Pair, f: TFile, label: string, hint: string, act: () => Promise<void>): void {
		const side = row.createDiv({ cls: "ownsync-conflict-side" });
		side.createDiv({ cls: "ownsync-quiet", text: f === p.original ? "Original" : "Other device" });
		if (IMAGE.test(f.path)) side.createEl("img", { attr: { src: this.app.vault.getResourcePath(f), alt: f.name } });
		else {
			side.createDiv({ text: f.name });
			side.createDiv({ cls: "ownsync-quiet", text: `${(f.stat.size / 1024).toFixed(1)} KB, changed ${new Date(f.stat.mtime).toLocaleString()}` });
		}
		const b = side.createEl("button", { text: label });
		side.createDiv({ cls: "ownsync-quiet", text: hint });
		b.addEventListener("click", () => {
			b.disabled = true;
			void act().then(() => { this.pairs = this.pairs.filter((x) => x !== p); this.render(); }, () => { b.disabled = false; new Notice("Could not change the file.", 6000); });
		});
	}
}

export function installConflictNotice(plugin: ConflictHost): void {
	const { app } = plugin;
	const shown = new Map<string, Notice>(); // by original path, one at a time
	const review = () => { const M = conflictModal(); new M(app, allPairs(app)).open(); };

	const announce = (pairs: Pair[]) => {
		const fresh = pairs.filter((p) => !shown.has(p.original.path));
		if (!fresh.length) return;
		const notice = new Notice(createFragment((f) => {
			f.createDiv({ text: fresh.length === 1 ? `${fresh[0]!.original.name} was changed on two devices at once.` : `${fresh.length} attachments were changed on two devices at once.` });
			const actions = f.createDiv({ cls: "ownsync-notice-actions" });
			actions.createEl("button", { text: "Compare" }).addEventListener("click", () => { notice.hide(); review(); });
			actions.createEl("button", { text: "Not now" }).addEventListener("click", () => notice.hide());
		}), 0);
		for (const p of fresh) shown.set(p.original.path, notice);
		const hide = notice.hide.bind(notice);
		notice.hide = () => { for (const p of fresh) shown.delete(p.original.path); hide(); };
	};

	plugin.registerEvent(app.vault.on("create", (file) => { const p = pairOf(app, file); if (p) announce([p]); }));
	app.workspace.onLayoutReady(() => announce(allPairs(app)));
	plugin.addCommand({ id: "review-attachment-conflicts", name: "Review attachment conflicts", callback: review });
}
