// The stored 0.2.x format, shared by migration tests that start at the upgrade boundary.
import * as Y from "yjs";
import { createHash } from "node:crypto";
import type { Entry, Ref } from "../src/core/ports";

export interface LegacyFile { id: string; path: string; body: string | Ref; deleted?: number }

export function legacyFixture(files: LegacyFile[]) {
	const index = new Y.Doc(), data = new Map<string, unknown>(), entries: Entry[] = [];
	for (const { id, path, body, deleted } of files) {
		const doc = new Y.Doc();
		if (typeof body === "string") doc.getText("t").insert(0, body);
		else doc.getArray<Ref>("v").push([body]);
		index.getMap("notes").set(id, deleted === undefined ? { p: path } : {
			p: path, d: Buffer.from(Y.encodeStateVector(doc)).toString("base64"), t: deleted,
		});
		const state = Y.encodeStateAsUpdate(doc);
		data.set("state:" + id, state);
		entries.push({ doc: id, kind: "snapshot", data: state });
		if (deleted === undefined) data.set("note:" + id, {
			diskPath: path, baseHash: typeof body === "string" ? createHash("sha256").update(body).digest("hex") : body.h,
		});
		doc.destroy();
	}
	const state = Y.encodeStateAsUpdate(index);
	index.destroy();
	entries.unshift({ doc: "index", kind: "snapshot", data: state });
	data.set("index", state);
	data.set("meta", { synced: true, cursor: entries.length, nextOut: 1 });
	return { data, entries };
}
