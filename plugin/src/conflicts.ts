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

/** `original` is null when the file the copy was made from is gone (deleted or renamed since): only the copy is left. */
interface Pair { path: string; original: TFile | null; copy: TFile }

function pairOf(app: App, file: unknown): Pair | null {
	if (!(file instanceof TFile)) return null;
	const path = conflictOriginal(file.path);
	if (!path) return null;
	const original = app.vault.getAbstractFileByPath(path);
	return { path, original: original instanceof TFile ? original : null, copy: file };
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
			box.createEl("h4", { text: p.path });
			const row = box.createDiv({ cls: "ownsync-conflict-row" });
			const original = p.original;
			if (!original) {
				// Only the copy is left: give it its name back, or let it go.
				const name = p.path.split("/").pop()!;
				this.side(row, p, p.copy, `Rename back to "${name}"`, "The original is gone; this copy takes its place.", () => this.app.fileManager.renameFile(p.copy, p.path));
				this.side(row, p, p.copy, "Delete this copy", "Moves it to the trash.", () => this.app.fileManager.trashFile(p.copy), false);
				continue;
			}
			this.side(row, p, original, "Keep this one", "Deletes the other copy.", () => this.app.fileManager.trashFile(p.copy));
			this.side(row, p, p.copy, "Keep this one", "Replaces the original with this copy.", async () => {
				await this.app.fileManager.trashFile(original);
				await this.app.fileManager.renameFile(p.copy, p.path);
			});
		}
	}

	private side(row: HTMLElement, p: Pair, f: TFile, label: string, hint: string, act: () => Promise<void>, preview = true): void {
		const side = row.createDiv({ cls: "ownsync-conflict-side" });
		side.createDiv({ cls: "ownsync-quiet", text: f === p.original ? "Original" : p.original ? "Other device" : preview ? "Only copy left" : "" });
		// `preview` false: the same file as the side before it, shown once.
		if (preview && IMAGE.test(f.path)) side.createEl("img", { attr: { src: this.app.vault.getResourcePath(f), alt: f.name } });
		else if (preview) {
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
	const review = () => {
		const pairs = allPairs(app);
		if (!pairs.length) return void new Notice("No attachment conflicts.");
		const M = conflictModal(); new M(app, pairs).open();
	};

	const announce = (pairs: Pair[]) => {
		const fresh = pairs.filter((p) => p.original && !shown.has(p.path)); // a copy with no original isn't news: the review lists it
		if (!fresh.length) return;
		const notice = new Notice(createFragment((f) => {
			f.createDiv({ text: fresh.length === 1 ? `${fresh[0]!.original!.name} was changed on two devices at once.` : `${fresh.length} attachments were changed on two devices at once.` });
			const actions = f.createDiv({ cls: "ownsync-notice-actions" });
			actions.createEl("button", { text: "Compare" }).addEventListener("click", () => { notice.hide(); review(); });
			actions.createEl("button", { text: "Not now" }).addEventListener("click", () => notice.hide());
		}), 0);
		for (const p of fresh) shown.set(p.path, notice);
		const hide = notice.hide.bind(notice);
		notice.hide = () => { for (const p of fresh) shown.delete(p.path); hide(); };
	};

	plugin.registerEvent(app.vault.on("create", (file) => { const p = pairOf(app, file); if (p) announce([p]); }));
	app.workspace.onLayoutReady(() => announce(allPairs(app)));
	plugin.addCommand({ id: "review-attachment-conflicts", name: "Review attachment conflicts", callback: review });
}
