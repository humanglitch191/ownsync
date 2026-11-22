import { test } from "node:test";
import assert from "node:assert/strict";
import { keepCopies, whenLabel, type Copy } from "../src/historyRules";

const HOUR = 60 * 60_000;
const now = new Date(2026, 10, 22, 15, 0).getTime();
const copy = (hoursAgo: number, path = "a.md", size = 10, deleted = false): Copy =>
	({ path, time: now - hoursAgo * HOUR, size, deleted });

test("every copy from the last 24 hours stays", () => {
	const copies = [copy(0.1), copy(1), copy(5), copy(24)];
	assert.deepEqual(keepCopies(copies, now), copies);
});

test("older copies keep the newest per local calendar day and note", () => {
	const keep = [copy(23), copy(29), copy(30, "b.md"), copy(40), copy(24 * 30)];
	const drop = [copy(30), copy(31), copy(42), copy(24 * 30 + 1)];
	assert.deepEqual(keepCopies([...drop, ...keep].reverse(), now), keep);
});

test("recently deleted notes are kept for 30 days without daily thinning", () => {
	const keep = [copy(25, "a.md", 10, true), copy(28, "a.md", 10, true), copy(24 * 30, "a.md", 10, true)];
	const expired = copy(24 * 30 + 1, "a.md", 10, true);
	assert.deepEqual(keepCopies([expired, ...keep], now), keep);
});

test("the shared size cap evicts oldest entries first", () => {
	const newest = copy(1, "b.md", 40, true);
	const next = copy(2, "c.md", 60);
	assert.deepEqual(keepCopies([copy(4, "a.md", 1), next, copy(3, "c.md", 40), newest], now, 100), [newest, next]);
	assert.deepEqual(keepCopies([copy(4, "a.md", 10), next, newest], now, 90), [newest]);
});

test("time labels use the local calendar, including across months and years", () => {
	assert.equal(whenLabel(now - HOUR / 2, now), "Today 14:30");
	assert.equal(whenLabel(new Date(2026, 10, 21, 9, 5).getTime(), now), "Yesterday 09:05");
	assert.equal(whenLabel(new Date(2026, 9, 1, 18, 30).getTime(), now), "2026-10-01 18:30");
	assert.equal(whenLabel(new Date(2025, 11, 31, 23, 55).getTime(), new Date(2026, 0, 1, 0, 5).getTime()), "Yesterday 23:55");
});
