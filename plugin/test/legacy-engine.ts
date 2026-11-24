import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { Engine } from "../src/core/engine";
import * as Y from "yjs";
import type { Ref } from "../src/core/ports";
import { Device } from "./sim";

// Load the released engine from git so the mixed shard cannot silently test a second current engine.
let release: typeof Engine | undefined;
export async function releasedEngine(): Promise<typeof Engine> {
	if (!release) {
		const filename = fileURLToPath(new URL("../src/core/engine.legacy.ts", import.meta.url));
		const source = execFileSync("git", ["show", "95a94ac:plugin/src/core/engine.ts"], { encoding: "utf8" });
		const module = await createJiti(filename, { fsCache: false }).evalModule(source, { filename, async: true });
		release = (module as { Engine: typeof Engine }).Engine;
	}
	return release;
}

type Tombstone = { p: string; d?: string; t?: number };
interface ReleasedInternals {
	notes: Y.Map<Tombstone>;
	puts: Map<string, unknown>;
	dropDuplicates(id: string): Promise<void>;
}

function head(state: unknown): string | undefined {
	if (!(state instanceof Uint8Array)) return;
	const doc = new Y.Doc();
	Y.applyUpdate(doc, state);
	const refs = doc.getArray<Ref>("v").toArray(), first = refs[0]?.h;
	doc.destroy();
	return refs.every((r) => r.h === first) ? first : undefined;
}

/** Record only deletions emitted inside the released collapse. All other fuzz assertions still apply. */
export class LegacyDevice extends Device {
	private drops: { id: string; kept: string; h: string; deletion: Tombstone }[] = [];

	override boot(): void {
		super.boot();
		const engine = this.engine as unknown as ReleasedInternals;
		const collapse = engine.dropDuplicates.bind(engine);
		engine.dropDuplicates = async (id) => {
			const path = engine.notes.get(id)?.p;
			const group = [...engine.notes].filter(([, v]) => v.d === undefined && v.p === path).map(([member]) => member).sort();
			if (group.length < 2) return collapse(id);
			const hashOf = (member: string) => {
				const key = `state:${member}`;
				return head(engine.puts.get(key) ?? this.data.get(key));
			};
			await collapse(id);
			for (const member of group) {
				const deletion = engine.notes.get(member), h = hashOf(member);
				if (!h || deletion?.d === undefined) continue;
				const kept = group.find((other) => other < member && engine.notes.get(other)?.d === undefined && hashOf(other) === h);
				if (kept) this.drops.push({ id: member, kept, h, deletion });
			}
		};
	}

	explainsLoss(hash: string, current: Device): boolean {
		const end = current.storedIndex();
		// A live holder would make this a projection or download failure, even if the old engine also dropped a twin.
		for (const [id, v] of end) if (v.d === undefined && !v.p.endsWith(".md")) {
			const doc = new Y.Doc(), state = current.data.get(`state:${id}`) as Uint8Array | undefined;
			if (state) Y.applyUpdate(doc, state);
			const live = doc.getArray<Ref>("v").toArray().some((r) => r.h === hash);
			doc.destroy();
			if (live) return false;
		}
		return this.drops.some(({ id, kept, h, deletion }) => {
			const v = end.get(id), keeper = end.get(kept);
			const replaced = head(current.data.get(`state:${kept}`));
			return h === hash && v?.d === deletion.d && v?.t === deletion.t && v?.p === deletion.p &&
				head(current.data.get(`state:${id}`)) === h && keeper && keeper.d === undefined && replaced !== undefined && replaced !== h;
		});
	}
}
