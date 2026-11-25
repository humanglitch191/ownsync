import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictOriginal, sameBytes } from "../src/conflicts";

test("a conflict copy maps back to its original path", () => {
	assert.equal(conflictOriginal("photo (conflict a1b2c3).png"), "photo.png");
	assert.equal(conflictOriginal("a/b.c/photo.v2.tar (conflict 0f9e8d).gz"), "a/b.c/photo.v2.tar.gz");
	assert.equal(conflictOriginal("dir.d/README (conflict a1b2c3)"), "dir.d/README");
});

test("a copy whose name was taken maps to the first copy", () => {
	assert.equal(conflictOriginal("photo (conflict a1b2c3) (conflict a1b2c3).png"), "photo (conflict a1b2c3).png");
});

test("anything else is not a conflict copy", () => {
	for (const p of ["photo.png", "note (conflict a1b2c3).md", "photo (conflict a1b2).png", "photo (conflict zzzzzz).png", "photo(conflict a1b2c3).png"]) assert.equal(conflictOriginal(p), null, p);
});

test("only exactly equal bytes count as identical", () => {
	const b = (...x: number[]) => Uint8Array.from(x).buffer;
	assert.ok(sameBytes(b(1, 2, 3), b(1, 2, 3)));
	assert.ok(sameBytes(b(), b()));
	assert.ok(!sameBytes(b(1, 2, 3), b(1, 2, 4)));
	assert.ok(!sameBytes(b(1, 2), b(1, 2, 0)));
});
