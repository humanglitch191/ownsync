// The pure parts of the presence avatars: initials, the +N overflow and a readable text colour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { initials, split, textColour } from "../src/avatars";

test("initials: first letters of the first two words, else the first two letters", () => {
	assert.equal(initials("Anna's iPhone 17 Pro"), "AI");
	assert.equal(initials("Another device"), "AD");
	assert.equal(initials("laptop"), "LA");
	assert.equal(initials("  (work)  mac "), "WM");
	assert.equal(initials("Émile"), "ÉM");
	assert.equal(initials("🙂"), "🙂");
	assert.equal(initials(""), "?");
});

test("at most three shown, the rest behind +N", () => {
	assert.deepEqual(split([1, 2]), { shown: [1, 2], rest: [] });
	assert.deepEqual(split([1, 2, 3, 4, 5]), { shown: [1, 2, 3], rest: [4, 5] });
});

test("text colour: whichever of black and white contrasts more", () => {
	assert.equal(textColour("#ffffff"), "#000");
	assert.equal(textColour("#000000"), "#fff");
	assert.equal(textColour("#d6a000"), "#000");
	assert.equal(textColour("#8e4ec6"), "#fff");
});
