export type IndexValue = { p: string; d?: string; t?: number };
export const conflictName = (path: string, id: string) => path.replace(/(\.[^./]*)?$/, ` (conflict ${id.slice(0, 6)})$1`);

// The legacy engine and genesis must assign exactly the same names to existing files.
export function places(notes: Iterable<[string, IndexValue]>) {
	const groups = new Map<string, string[]>(); // index path → the notes claiming it
	for (const [id, v] of notes) {
		if (v.d !== undefined) continue;
		const g = groups.get(v.p);
		if (g) g.push(id);
		else groups.set(v.p, [id]);
	}
	// The smallest ID keeps the path; the others get a suffix, and again if that name is itself claimed.
	const paths = new Map<string, string>(), owners = new Map<string, string>();
	for (const [path, g] of groups) owners.set(path, g.sort()[0]!);
	for (const path of [...groups.keys()].sort()) {
		for (const id of groups.get(path)!.slice(1)) {
			let name = conflictName(path, id);
			while (owners.has(name)) name = conflictName(name, id);
			owners.set(name, id);
		}
	}
	for (const [path, id] of owners) paths.set(id, path);
	return { paths, owners, groups };
}
