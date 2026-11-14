// The bound editor's undo and the validation of other devices' presence, without an editor.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { applyPresence, localUndo } from "../src/collab";

test("undo takes back only this editor's typing, not another device's or the engine's", () => {
	const doc = new Y.Doc(), text = doc.getText("t"), undo = localUndo(text);
	const editor = {}; // stands in for the editor's sync plugin, which adds itself as the tracked origin
	undo.addTrackedOrigin(editor);
	doc.transact(() => text.insert(0, "mine "), editor);
	const other = new Y.Doc();
	Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
	const remote = (at: number, s: string, origin?: string) => {
		other.getText("t").insert(at, s);
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), origin);
	};
	remote(5, "theirs ", "ownsync-remote"); // as the engine applies remote edits
	remote(12, "too "); // no origin: the default UndoManager would track this one
	doc.transact(() => text.insert(text.length, "engine"), "something else");
	assert.equal(text.toString(), "mine theirs too engine");
	undo.undo();
	assert.equal(text.toString(), "theirs too engine");
	assert.equal(undo.undo(), null, "nothing else to undo");
	undo.redo();
	assert.equal(text.toString(), "mine theirs too engine");
});

test("presence from another device is cleaned before the editor sees it", () => {
	const mine = new Awareness(new Y.Doc()), theirs = new Awareness(new Y.Doc());
	theirs.setLocalState({
		user: { name: "Evil\u0000\u202e<img src=x onerror=alert(1)>" + "x".repeat(100), color: "red; background-image: url(https://evil.example)", colorLight: "url(x)" },
		cursor: { anchor: { item: { client: "1", clock: 0 } }, head: { tname: "t", assoc: 0 } },
		extra: "dropped",
	});
	assert.equal(applyPresence(mine, encodeAwarenessUpdate(theirs, [theirs.clientID])), true, "a new device appeared");
	const seen = mine.getStates().get(theirs.clientID)!;
	assert.deepEqual(Object.keys(seen).sort(), ["cursor", "user"]);
	assert.equal(seen.user.name, "Evil<img src=x onerror=alert(1)>xxxxxxxx"); // shown as text, never as HTML
	assert.match(seen.user.color, /^#[0-9a-f]{6}$/);
	assert.equal(seen.cursor, null, "a malformed cursor is dropped");

	// A device that opens the note again starts its clock over; it must still be seen. Its empty state clears it.
	theirs.setLocalState({ user: { name: "Phone", color: "#0090ff" }, cursor: { anchor: { type: null, tname: "t", item: null, assoc: 0 }, head: { type: null, tname: null, item: { client: 7, clock: 3 }, assoc: -1 } } });
	assert.equal(applyPresence(mine, encodeAwarenessUpdate(theirs, [theirs.clientID])), false);
	assert.equal(mine.getStates().get(theirs.clientID)!.user.name, "Phone");
	assert.ok(mine.getStates().get(theirs.clientID)!.cursor);
	theirs.setLocalState(null);
	applyPresence(mine, encodeAwarenessUpdate(theirs, [theirs.clientID]));
	assert.equal(mine.getStates().has(theirs.clientID), false);
	const again = new Awareness(Object.assign(new Y.Doc(), { clientID: theirs.clientID })); // clock back at 0
	again.setLocalStateField("user", { name: "Phone again", color: "#0090ff" });
	assert.equal(applyPresence(mine, encodeAwarenessUpdate(again, [again.clientID])), true);
	assert.equal(mine.getStates().get(theirs.clientID)!.user.name, "Phone again");

	// Nobody else can overwrite or remove this device's own state.
	mine.setLocalStateField("user", { name: "Me", color: "#46a758" });
	const fake = new Awareness(Object.assign(new Y.Doc(), { clientID: mine.clientID }));
	fake.setLocalStateField("user", { name: "Impostor", color: "#46a758" });
	applyPresence(mine, encodeAwarenessUpdate(fake, [fake.clientID]));
	assert.equal(mine.getLocalState()!.user.name, "Me");
	for (const a of [mine, theirs, again, fake]) a.destroy();
});
