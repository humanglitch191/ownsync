// Before the extension, so a copy keeps its file type.
export const conflictName = (path: string, id: string) => path.replace(/(\.[^./]*)?$/, ` (conflict ${id.slice(0, 6)})$1`);

const COPY = /^(.*) \(conflict [0-9a-f]{6}\)(\.[^./]*)?$/;

/** The engine's conflictName() in reverse: the path this copy was made from, or null if it is not a copy. A copy of a copy gives the first copy. */
export function conflictOriginal(path: string): string | null {
	if (path.endsWith(".md")) return null;
	const m = COPY.exec(path);
	return m ? m[1]! + (m[2] ?? "") : null;
}

// A split child's suffix identifies the version that made it. A user's other conflict-looking name is its own claim.
export function claimOf(id: string, path: string): string {
	const original = conflictOriginal(path);
	return original !== null && conflictName(original, id) === path ? original : path;
}
