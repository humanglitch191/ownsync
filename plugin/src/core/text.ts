import type * as Y from "yjs";

/**
 * Make `ytext` equal `next` by its true small edits: a word-level diff (Myers, as git uses), so text that
 * didn't change isn't deleted and retyped. That matters when two devices' edits are merged: retyped text
 * would be duplicated, and an edit cut through the middle of a word would shred it.
 */
export function applyText(ytext: Y.Text, next: string): void {
	for (const [pos, remove, insert] of textEdits(ytext.toString(), next).reverse()) {
		if (remove) ytext.delete(pos, remove);
		if (insert) ytext.insert(pos, insert);
	}
}

export function onlyInserts(prev: string, next: string): boolean {
	return textEdits(prev, next).every(([, remove]) => remove === 0);
}

// Legacy startup infers identity from intact words. Refining a known note's
// merge within a word must not also claim an unrelated file after a crash.
export function onlyInsertsWords(prev: string, next: string): boolean {
	return textEdits(prev, next, false).every(([, remove]) => remove === 0);
}

function textEdits(prev: string, next: string, refine = true): [at: number, remove: number, insert: string][] {
	if (prev === next) return [];
	const split = (text: string) => text.split(/(\s+)/).filter((u) => u !== ""); // words and the whitespace between them
	const a = split(prev), b = split(next);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let end = 0;
	while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	const am = a.slice(start, a.length - end), bm = b.slice(start, b.length - end);
	// Each kept unit ends a hunk: delete what a had before it, insert what b had before it.
	const kept = [...(matches(am, bm) ?? []), [am.length, bm.length] as [number, number]];
	const hunks: [at: number, remove: number, insert: string][] = [];
	let i = 0, j = 0, at = a.slice(0, start).join("").length;
	for (const [x, y] of kept) {
		const old = am.slice(i, x).join(""), insert = bm.slice(j, y).join("");
		if (old || insert) {
			// Yjs offsets are UTF-16. Preserve whole code points at each edge.
			let left = 0, right = 0;
			if (refine) {
				while (left < old.length && old.codePointAt(left) === insert.codePointAt(left))
					left += old.codePointAt(left)! > 0xffff ? 2 : 1;
				while (right < old.length - left && right < insert.length - left &&
					old.charCodeAt(old.length - right - 1) === insert.charCodeAt(insert.length - right - 1)) right++;
				if (right && /[\uDC00-\uDFFF]/.test(old.charAt(old.length - right))) right--;
				// A pure insertion retains all the old text. For a multiword replacement,
				// retaining edges can anchor a new word across an old inter-word insertion.
				if (left + right < old.length && (x - i > 1 || y - j > 1)) {
					left = 0;
					right = 0;
				}
			}
			hunks.push([at + left, old.length - left - right, insert.slice(left, insert.length - right)]);
		}
		at += old.length + (am[x]?.length ?? 0);
		i = x + 1;
		j = y + 1;
	}
	return hunks;
}

/** Myers diff: the index pairs of units that `a` and `b` keep in common, or null when they differ too much. */
function matches(a: string[], b: string[], limit = 2000): [number, number][] | null {
	const n = a.length, m = b.length, max = Math.min(n + m, limit), off = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) { x++; y++; }
			v[off + k] = x;
			if (x < n || y < m) continue;
			const out: [number, number][] = [];
			for (let dd = d; dd > 0; dd--) {
				const pv = trace[dd]!, kk = x - y;
				const pk = kk === -dd || (kk !== dd && pv[off + kk - 1]! < pv[off + kk + 1]!) ? kk + 1 : kk - 1;
				const px = pv[off + pk]!, py = px - pk;
				while (x > px && y > py) out.push([--x, --y]);
				x = px;
				y = py;
			}
			while (x > 0 && y > 0) out.push([--x, --y]);
			return out.reverse();
		}
	}
	return null; // shortcut: past `limit` differing units the whole middle is replaced; fine for a rewrite, lossy for merging one
}
