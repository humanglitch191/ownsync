// The bound editor's undo and the validation of other devices' presence, without an editor.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { applyPresence, carryOver, deviceNames, followedSettings, localUndo, presenceGoes, vaultSettings } from "../src/collab";

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

test("device names from the Worker: only 8-hex IDs and cleaned names", () => {
	assert.deepEqual([...deviceNames({ ABCD0063: " Anna's iPhone 17 Pro\u0007", "bad id": "x", ABCD0064: "", ABCD0065: 7 })], [["ABCD0063", "Anna's iPhone 17 Pro"]]);
	for (const raw of [null, "x", [], 5]) assert.equal(deviceNames(raw).size, 0);
});

test("vault settings: a device follows the vault's once chosen, its own 0.2.x one until then, and carries over only snapshots on or backup off", () => {
	assert.deepEqual(vaultSettings({ snapshots: true, historyBackup: null }), { snapshots: true, historyBackup: null });
	for (const raw of [undefined, null, "x", 5, {}, { snapshots: "on", historyBackup: true }]) assert.equal(vaultSettings(raw), undefined); // an older Worker
	const old = { snapshots: true, backUpHistoryToWorker: false }, fresh = { snapshots: false, backUpHistoryToWorker: true };
	// Not chosen yet, or an older Worker: each device as before.
	assert.deepEqual(followedSettings({ snapshots: null, historyBackup: null }, old), { snapshots: true, historyBackup: false });
	assert.deepEqual(followedSettings(undefined, fresh), { snapshots: false, historyBackup: true });
	// Chosen: every device follows the vault, whatever it had.
	assert.deepEqual(followedSettings({ snapshots: false, historyBackup: true }, old), { snapshots: false, historyBackup: true });
	assert.deepEqual(followedSettings({ snapshots: true, historyBackup: false }, fresh), { snapshots: true, historyBackup: false });
	assert.deepEqual(followedSettings({ snapshots: null, historyBackup: false }, fresh), { snapshots: false, historyBackup: false });
	// Only a choice that differs from the default is sent (a declined offer left snapshots off: nothing to carry).
	assert.deepEqual(carryOver(old), { snapshots: true, historyBackup: false });
	assert.deepEqual(carryOver({ snapshots: true, backUpHistoryToWorker: true }), { snapshots: true });
	assert.deepEqual(carryOver({ snapshots: false, backUpHistoryToWorker: false }), { historyBackup: false });
	assert.equal(carryOver(fresh), undefined);
});

test("presence goes only while in view and someone else is in the note; an announce goes regardless; leaving goes to whoever is there", () => {
	// Alone, in view: the 15 s renewal and cursor moves stay home; opening the note (or coming back) announces once.
	assert.equal(presenceGoes("change", true, false), false);
	assert.equal(presenceGoes("announce", true, false), true);
	// Someone else there: renewals, cursor moves and the reply to a newcomer go.
	assert.equal(presenceGoes("change", true, true), true);
	assert.equal(presenceGoes("announce", true, true), true);
	// Hidden or in the background: nothing, so the others drop this device after 30 s.
	assert.equal(presenceGoes("change", false, true), false);
	assert.equal(presenceGoes("announce", false, true), false);
	assert.equal(presenceGoes("announce", false, false), false);
	// Closing the note clears the cursor on the others' screens, if there are any.
	assert.equal(presenceGoes("leave", false, true), true);
	assert.equal(presenceGoes("leave", true, false), false);
});

test("presence goes out only when someone else is in the note and Obsidian is in view", () => {
	assert.equal(presenceGoes("change", true, false), false); // alone: cursor moves and renewals stay home, so the vault can sleep
	assert.equal(presenceGoes("announce", true, false), true); // opening the note or coming back: say so once
	assert.equal(presenceGoes("change", true, true), true);
	assert.equal(presenceGoes("change", false, true), false); // in the background: nothing; the others drop this device after 30 s
	assert.equal(presenceGoes("announce", false, true), false);
	assert.equal(presenceGoes("leave", false, true), true); // leaving is always told to whoever is there
	assert.equal(presenceGoes("leave", true, false), false);
});
