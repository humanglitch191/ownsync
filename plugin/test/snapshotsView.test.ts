import assert from "node:assert/strict";
import { test } from "node:test";
import { differingSnapshotNotes, restoreFolderName, safeSnapshotPath, snapshotDate, snapshotTree } from "../src/snapshotsView";

const note = (path: string, text = path) => ({ id: path, path, text });

test("restore folders use the first available name", () => {
	const base = "Restored 2026-11-22";
	assert.equal(restoreFolderName("2026-11-22", () => false), base);
	const occupied = new Set([base, `${base} 2`, `${base} 4`]);
	assert.equal(restoreFolderName("2026-11-22", (path) => occupied.has(path)), `${base} 3`);
});

test("snapshot paths are relative and outside vault settings", () => {
	for (const path of ["Read me.md", "Projects/Drafts/Idea.md", "A..B.md"]) {
		assert.equal(safeSnapshotPath(path), true, path);
	}
	for (const path of ["", "/Root.md", "../Escape.md", "A/../Escape.md", "A/./Note.md", "A//Note.md", "A\\..\\Escape.md", "C:/Note.md", ".obsidian", ".Obsidian/plugins/Note.md", "A/.obsidian/Note.md", "A/.. /Escape.md", "A/\0Note.md"]) {
		assert.equal(safeSnapshotPath(path), false, path);
	}
	assert.equal(safeSnapshotPath("Vault Settings/Note.md", "vault settings"), false);
	assert.equal(safeSnapshotPath("Vault Settings references/Note.md", "vault settings"), true);
});

test("the snapshot tree keeps root notes and folder contents separate", () => {
	const root = note("Welcome.md"), apple = note("Projects/Apple.md"), zebra = note("Projects/Zebra.md");
	const draft = note("Projects/Drafts/New.md"), other = note("Projects archive/X.md");
	const tree = snapshotTree([draft, root, zebra, other, apple, note("../Wrong.md")]);
	assert.deepEqual(tree.notes, [root]);
	assert.deepEqual([...tree.folders.keys()].sort(), ["Projects", "Projects archive"]);
	const projects = tree.folders.get("Projects");
	assert.ok(projects);
	assert.deepEqual(projects.notes, [apple, zebra]);
	assert.deepEqual(projects.folders.get("Drafts"), { path: "Projects/Drafts", folders: new Map(), notes: [draft] });
	assert.deepEqual(tree.folders.get("Projects archive")?.notes, [other]);
});

test("in-place restore selects only changed and missing notes", () => {
	const same = { note: note("Same.md", "Same\n"), current: "Same\n" };
	const changed = { note: note("Changed.md", "Restored\n"), current: "Current\n" };
	const missing = { note: note("Missing.md", ""), current: undefined };
	const empty = { note: note("Empty.md", ""), current: "" };
	assert.deepEqual(differingSnapshotNotes([same, changed, missing, empty]), [changed, missing]);
});

test("a snapshot shows the local date it was taken, not its UTC day", () => {
	const takenAt = new Date(2026, 10, 22, 0, 30).getTime();
	const utcDay = Math.floor(takenAt / 86_400_000);
	assert.equal(snapshotDate(utcDay, takenAt), "2026-11-22");
	assert.equal(snapshotDate(utcDay), new Date(utcDay * 86_400_000).toISOString().slice(0, 10));
});
