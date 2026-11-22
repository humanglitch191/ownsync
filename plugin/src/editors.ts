// Live typing: each markdown editor that is really on screen in edit mode is bound to its note's document,
// so keystrokes go straight into it and other devices' keystrokes appear in the editor.
//
// Everything else counts as closed to the engine, which then keeps the file itself up to date:
// reading view (its hidden editor is never saved), and tabs Obsidian hasn't loaded yet.

import { type App, type Editor, MarkdownView } from "obsidian";
import { Compartment } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { applyPresence, collab, localUndo, user } from "./collab";
import type { Engine } from "./core/engine";

/** Registered once on every editor by the plugin; filled with the binding for bound editors. */
export const editorBinding = new Compartment();

type Binding = { id: string; editor: Editor; undo: Y.UndoManager };

export class Editors {
	private bound = new Map<EditorView, Binding>();
	private presence = new Map<string, Awareness>(); // note ID → this device's presence there, while an editor shows it
	private queue: Promise<void> = Promise.resolve();
	private stopped = false;

	constructor(
		private readonly app: App, private readonly engine: Engine, private readonly onProblem: (what: string, err: unknown) => void,
		private readonly sendPresence: (note: string, update: Uint8Array) => void, private name: string,
	) {}

	/** Another device's presence in a note. Dropped unless an editor here shows the note. */
	receivePresence(note: string, update: Uint8Array): void {
		const aw = this.presence.get(note);
		if (aw && applyPresence(aw, update)) this.send(note, aw); // it just appeared: show it this cursor now, not at the next renewal
	}

	setName(name: string): void {
		this.name = name;
		for (const aw of this.presence.values()) aw.setLocalStateField("user", user(name, aw.clientID));
	}

	/** Bring the bindings in line with what is on screen. Calls are handled one after another. */
	refresh(): void {
		this.queue = this.queue.then(() => (this.stopped ? undefined : this.sync())).catch((err) => this.onProblem("connecting an editor to sync", err));
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await this.queue;
		for (const cm of [...this.bound.keys()]) await this.unbind(cm, true);
	}

	private editors(): { cm: EditorView; view: MarkdownView }[] {
		return this.app.workspace.getLeavesOfType("markdown").flatMap((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.getMode() !== "source") return []; // not loaded yet, or reading view
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			return cm ? [{ cm, view }] : [];
		});
	}

	private async sync(): Promise<void> {
		const onScreen = this.editors();
		for (const [cm, { id }] of [...this.bound]) {
			const view = onScreen.find((e) => e.cm === cm)?.view;
			const showing = view?.file ? this.engine.noteAt(view.file.path) : undefined;
			if (showing !== id || !this.engine.isOpen(id)) await this.unbind(cm, !!view);
		}
		for (const { cm, view } of onScreen) if (!this.bound.has(cm)) await this.bind(cm, view);
	}

	private async bind(cm: EditorView, view: MarkdownView): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			// What the editor holds goes to the file first; opening the note then takes it in as an edit.
			await view.save();
			const id = view.file && this.engine.noteAt(view.file.path);
			if (!id) return; // not a synced note yet; a later refresh binds it
			const doc = await this.engine.open(id);
			if (!doc) return;
			// The tab may show another file by now: look again rather than bind it to this note.
			if (!view.file || this.engine.noteAt(view.file.path) !== id) {
				await this.release(id);
				continue;
			}
			// No awaits from here on: nothing can change between comparing the two texts and binding them.
			const text = doc.getText("t"), shown = cm.state.doc.toString(), synced = text.toString();
			if (shown !== synced) {
				// Typed since that save: go round again so it isn't thrown away. Otherwise the editor is just behind.
				if (shown !== (view as unknown as { data: string }).data && attempt < 2) {
					await this.release(id);
					continue;
				}
				cm.dispatch({ changes: { from: 0, to: shown.length, insert: synced } });
			}
			const undo = localUndo(text), editor = view.editor;
			cm.dispatch({ effects: editorBinding.reconfigure(collab(text, this.awareness(id, doc), undo)) });
			// Obsidian's Undo command and the phone toolbar call the editor's undo(), which goes straight to
			// CodeMirror's history, past any keymap.
			Object.assign(editor, { undo: () => undo.undo(), redo: () => undo.redo() });
			this.bound.set(cm, { id, editor, undo });
			return;
		}
	}

	private async unbind(cm: EditorView, onScreen: boolean): Promise<void> {
		const { id, editor, undo } = this.bound.get(cm)!;
		this.bound.delete(cm);
		if (onScreen) cm.dispatch({ effects: editorBinding.reconfigure([]) });
		delete (editor as Partial<Editor>).undo; // back to the prototype's
		delete (editor as Partial<Editor>).redo;
		undo.destroy();
		if (!this.shows(id)) {
			this.presence.get(id)?.destroy(); // sends the empty state, which clears this cursor on the other devices
			this.presence.delete(id);
		}
		await this.release(id);
	}

	private shows(id: string): boolean {
		return [...this.bound.values()].some((b) => b.id === id);
	}

	/** One per note, shared by every editor here that shows it: they are one participant to the other devices. */
	private awareness(id: string, doc: Y.Doc): Awareness {
		let aw = this.presence.get(id);
		if (aw) return aw;
		const fresh = (aw = new Awareness(doc));
		this.presence.set(id, aw);
		fresh.on("update", (_: unknown, origin: unknown) => { if (origin === "local") this.send(id, fresh); });
		fresh.setLocalStateField("user", user(this.name, fresh.clientID));
		return fresh;
	}

	private send(id: string, aw: Awareness): void {
		this.sendPresence(id, encodeAwarenessUpdate(aw, [aw.clientID]));
	}

	/** Close the note in the engine once no editor shows it. The engine then writes the file itself. */
	private async release(id: string): Promise<void> {
		if (!this.shows(id)) await this.engine.close(id);
	}
}
