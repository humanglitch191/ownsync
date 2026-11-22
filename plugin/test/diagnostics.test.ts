import { test } from "node:test";
import assert from "node:assert/strict";
import { redactProblem } from "../src/diagnostics";

test("a problem line keeps its kind and plain message, and loses paths, IDs and quoted names", () => {
	assert.equal(redactProblem("connecting: couldn't reach the server"), "connecting: couldn't reach the server");
	assert.equal(redactProblem("disk Journal/2026-11-14.md: ENOENT 'Journal/2026-11-14.md'"), "disk: (details withheld)");
	assert.equal(redactProblem("open 0123456789abcdef: no such document"), "open: no such document");
	assert.equal(redactProblem("rename a/b.md: Folder a/c doesn't exist"), "rename: (details withheld)");
	assert.equal(redactProblem("Device 0123abcd was removed"), "(details withheld)");
	assert.equal(redactProblem("two devices disagree"), "two devices disagree");
});
