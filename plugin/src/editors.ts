// Live typing: each markdown editor that is really on screen in edit mode is bound to its note's document,
// so keystrokes go straight into it and other devices' keystrokes appear in the editor.
//
// Everything else counts as closed to the engine, which then keeps the file itself up to date:
// reading view (its hidden editor is never saved), and tabs Obsidian hasn't loaded yet.

import { type App, type Editor, MarkdownView } from "obsidian";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { showAvatars } from "./avatars";
import { applyPresence, collab, localUndo, presenceGoes, user } from "./collab";
import type { Engine } from "./core/engine";

/** Registered once on every editor by the plugin; filled with the binding for bound editors. */
export const editorBinding = new Compartment();

type Binding = { id: string; view: MarkdownView; editor: Editor; undo: Y.UndoManager };

/** Obsidian is on screen and has the focus (activeDocument follows it into popout windows). */
const inView = () => activeDocument.visibilityState === "visible" && activeDocument.hasFocus();

export class Editors {
	private bound = new Map<EditorView, Binding>();
	private presence = new Map<string, Awareness>(); // note ID → this device's presence there, while an editor shows it
	private queue: Promise<void> = Promise.resolve();
	private stopped = false;
	private shown = inView(); // in view when last looked: coming back into view announces every open note

	constructor(
		private readonly app: App, private readonly engine: Engine, private readonly onProblem: (what: string, err: unknown) => void,
		private readonly sendPresence: (note: string, update: Uint8Array) => void, private name: string,
	) {
		// Re-read the visible tabs and their paths after offline moves have been reconciled.
		void engine.startupScan.then(ready => { if (ready) this.refresh(); });
	}

	/** Another device's presence in a note. Dropped unless an editor here shows the note. */
	receivePresence(note: string, update: Uint8Array): void {
		const aw = this.presence.get(note);
		if (aw && applyPresence(aw, update)) this.offer(note, aw, "change"); // it just appeared: show it this cursor now, not at the next renewal
	}

	/** Window focus or visibility changed. Back in view: tell the others in each open note this device is there. */
	viewChanged(): void {
		const now = inView();
		if (now && !this.shown) this.announce();
		this.shown = now;
	}

	/** Tell the others in each open note this device is there, on reconnecting say; whoever is there answers. */
	announce(): void {
		for (const [id, aw] of this.presence) this.offer(id, aw, "announce");
	}

	setName(name: string): void {
		this.name = name;
		for (const aw of this.presence.values()) aw.setLocalStateField("user", user(name, aw.clientID));
	}

	/** Bring the bindings in line with what is on screen. Calls are handled one after another. */
	refresh(): void {
		if (!this.engine.readyForEditors || this.stopped) return;
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
				// The disk planner must settle this save against its own base first.
				await this.release(id);
				return;
			}
			const undo = localUndo(text), editor = view.editor;
			cm.dispatch({ effects: editorBinding.reconfigure(collab(text, this.awareness(id, doc), undo)) });
			// Obsidian's Undo command and the phone toolbar call the editor's undo(), which goes straight to
			// CodeMirror's history, past any keymap.
			Object.assign(editor, { undo: () => undo.undo(), redo: () => undo.redo() });
			this.bound.set(cm, { id, view, editor, undo });
			this.showPeople(id);
			return;
		}
	}

	private async unbind(cm: EditorView, onScreen: boolean): Promise<void> {
		const { id, view, editor, undo } = this.bound.get(cm)!;
		this.bound.delete(cm);
		showAvatars(view.containerEl, [], () => {});
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
		// The local state changing, or y-protocols renewing it every 15 s: sent only while someone else is in the note.
		fresh.on("update", (_: unknown, origin: unknown) => {
			if (origin !== "local") return;
			if (!this.shown && inView()) return this.viewChanged(); // focus went to a popout window, whose events don't reach main.ts
			this.offer(id, fresh, fresh.getLocalState() === null ? "leave" : "change");
		});
		// Other devices joining, renaming or leaving: by their empty state when they close the note, or after 30 s unheard.
		fresh.on("change", () => this.showPeople(id));
		fresh.setLocalStateField("user", user(this.name, fresh.clientID));
		this.offer(id, fresh, "announce");
		return fresh;
	}

	/** The other devices in the note, as avatars in the header of every editor here that shows it. */
	private showPeople(id: string): void {
		const aw = this.presence.get(id);
		if (!aw) return;
		const states = aw.getStates() as Map<number, { user?: { name: string; color: string }; cursor?: { head: unknown } | null }>;
		const people = [...states].flatMap(([client, s]) => (client !== aw.clientID && s.user ? [{ id: client, ...s.user }] : []));
		for (const [cm, b] of this.bound) {
			if (b.id !== id) continue;
			showAvatars(b.view.containerEl, people, (client) => {
				const head = states.get(client)?.cursor?.head;
				const at = head ? Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), aw.doc) : null;
				if (at) cm.dispatch({ effects: EditorView.scrollIntoView(Math.min(at.index, cm.state.doc.length), { y: "center" }) });
			});
		}
	}

	private offer(id: string, aw: Awareness, why: "announce" | "change" | "leave"): void {
		const others = [...aw.getStates().keys()].some((client) => client !== aw.clientID);
		if (presenceGoes(why, inView(), others)) this.sendPresence(id, encodeAwarenessUpdate(aw, [aw.clientID]));
	}

	/** Close the note in the engine once no editor shows it. The engine then writes the file itself. */
	private async release(id: string): Promise<void> {
		if (!this.shows(id)) await this.engine.close(id);
	}
}
