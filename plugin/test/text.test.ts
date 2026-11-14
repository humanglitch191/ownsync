import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { applyText } from "../src/core/text";

test("applyText replaces only the changed middle, so a concurrent edit elsewhere survives", () => {
	const a = new Y.Doc(), b = new Y.Doc();
	a.getText("t").insert(0, "alpha beta gamma");
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
	applyText(a.getText("t"), "alpha BETA gamma"); // e.g. an external edit ingested on A
	b.getText("t").insert(16, " delta"); // meanwhile on B
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
	assert.equal(a.getText("t").toString(), "alpha BETA gamma delta");
	assert.equal(b.getText("t").toString(), a.getText("t").toString());
	// The last cases swap one emoji for another that shares half its encoding.
	for (const [from, to] of [["", "x"], ["x", ""], ["aaa", "aa"], ["abc", "abXbc"], ["a\u{1F7E2}b", "a\u{1F534}b"], ["\u{1F7E2}", "\u{1F7E1}\u{1F7E2}"], ["x\u{1F600}", "x\u{1F601}"]]) {
		const t = new Y.Doc().getText("t");
		t.insert(0, from!);
		applyText(t, to!);
		assert.equal(t.toString(), to);
		assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/.test(t.toString()), `broken character in ${JSON.stringify(to)}`);
	}
});

test("applyText makes only the real edits, so two devices' edits to one note merge without loss or repeats", () => {
	const base = "one two three four five six";
	const a = new Y.Doc(), b = new Y.Doc();
	a.getText("t").insert(0, base);
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
	applyText(a.getText("t"), "A1 one two three four five six A2"); // edits at both ends on A
	applyText(b.getText("t"), "B1 one two three FOUR five six B2"); // edits at both ends and the middle on B
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
	const merged = a.getText("t").toString();
	assert.equal(b.getText("t").toString(), merged);
	const words = merged.split(/\s+/).filter(Boolean).sort();
	assert.deepEqual(words, ["A1", "A2", "B1", "B2", "FOUR", "five", "one", "six", "three", "two"].sort());
	// Random edits: the result is always exactly the target text.
	let seed = 7;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let round = 0; round < 300; round++) {
		const words1 = Array.from({ length: Math.floor(rand() * 30) }, () => `w${Math.floor(rand() * 12)}`);
		const words2 = words1.filter(() => rand() > 0.3).flatMap((w) => (rand() > 0.7 ? [w, `n${Math.floor(rand() * 12)}`] : [w]));
		const from = words1.join(rand() > 0.5 ? " " : "\n"), to = words2.join(rand() > 0.5 ? " " : "  ");
		const t = new Y.Doc().getText("t");
		t.insert(0, from);
		applyText(t, to);
		assert.equal(t.toString(), to);
	}
});
