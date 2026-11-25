// shortcut: A stale compare restarts both passes from zero (index first, then attachment docs).
// Neither the device's legacy replica nor an unstored live update can contribute to genesis. The Worker compares the whole-vault head at commit.
import { KIND, docTag, hex, openEnvelope, unpackEntry } from "../../protocol/ownsync";
import { decodeServer, encodeClient, packGenesis, type ClientFrame } from "../../server/src/wire";
import { LegacyProjection } from "./core/table/migration";
import type { VaultKeys } from "./keys";
import type { TableSync } from "./tableSync";

export function importGenesis(url: string, keys: VaultKeys, sync: TableSync, finished: (stale: boolean, error?: unknown) => void) {
	const ws = new WebSocket(url), projection = new LegacyProjection(), epoch = keys.epoch, vmk = keys.vmk;
	ws.binaryType = "arraybuffer";
	let pass: "format" | "index" | "docs" | "stage" | "compare" = "format", base = 0, staged = 0, part = 0, ended = false;
	let parts: AsyncGenerator<Uint8Array>;
	const tags = new Map<string, string>(), older = new Map<string, string>();
	const seen = new Set<string>(), oldOnly = new Set<string>();
	const watch = async (doc: string) => {
		tags.set(hex(await docTag(vmk, keys.vaultId, doc)), doc);
		for (const k of keys.vmks) if (k !== vmk) older.set(hex(await docTag(k, keys.vaultId, doc)), doc);
	};
	const finish = (stale = false, error?: unknown) => {
		if (ended) return;
		ended = true; ws.close(); projection.close(); finished(stale, error);
	};
	const send = (f: ClientFrame) => {
		if (ended || keys.epoch !== epoch || keys.state.pending?.tokenHash) throw new Error("Vault keys changed during migration");
		ws.send(encodeClient(f));
	};
	async function* stagedRows(): AsyncGenerator<Extract<ClientFrame, { t: "stageRow" }>> {
		const key = await sync.nameKey();
		for await (const r of projection.rows(key)) {
			staged++;
			yield { t: "stageRow", row: await sync.wireRow(r), dateAtCommit: r.dateAtCommit, expectedChunks: r.bytes.s ? r.bytes.c.length : null };
		}
		for await (const { row, dateAtCommit } of projection.noteRows(key, staged)) {
			staged++;
			yield { t: "stageRow", row: await sync.wireNote(row), dateAtCommit: dateAtCommit || undefined, expectedChunks: null };
		}
	}
	const next = async () => {
		const p = await parts.next();
		if (p.done) return send({ t: "genesis", base, rows: staged });
		send({ t: "stagePart", part: ++part, data: p.value });
	};
	let queue = Promise.resolve();
	ws.onopen = () => {
		queue = queue.then(async () => {
			send({ t: "hello", token: await keys.token() }); send({ t: "table" });
		}).catch(e => finish(false, e));
	};
	ws.onmessage = e => {
		queue = queue.then(async () => {
			if (ended) return;
			const f = decodeServer(new Uint8Array(e.data as ArrayBuffer));
			if (f.t === "migrationFailed") throw new Error("Migration failed: " + f.reason + ". This vault still uses legacy sync.");
			if (f.t === "migrationWriteFailed") throw new Error("Migration could not complete today. The Worker could not store the migration. This vault still uses legacy sync.");
			if (f.t === "format") {
				if (f.table) return finish();
				if (pass === "stage") {
					pass = "compare"; return send({ t: "subscribe", after: base });
				}
				await watch("index");
				pass = "index"; return send({ t: "subscribe", after: 0 });
			}
			if (pass === "compare") {
				if (f.t === "more" || (f.t === "synced" && f.seq !== base)) return finish(true);
				if (f.t === "synced") return finish(false, new Error("Worker refused genesis at the same head; check eligibility and stored chunks"));
				return;
			}
			if (pass === "stage") {
				if (f.t === "stagedPart") {
					if (f.seq !== part) throw new Error("Wrong staged part");
					await next();
				}
				return;
			}
			if (f.t === "entry") {
				const tag = hex(f.doc), previous = older.get(tag);
				if (previous) oldOnly.add(previous);
				const doc = tags.get(tag);
				if (!doc) return;
				const { kind, plaintext, epoch: sealedEpoch } = await openEnvelope(f.envelope, keys.vaultId, f.doc, keys.keyFor);
				if (sealedEpoch !== epoch || (kind !== KIND.update && kind !== KIND.snapshot)) throw new Error("Invalid stored migration entry");
				const { docId, update } = unpackEntry(plaintext);
				if (docId !== doc) throw new Error("Mismatched legacy document tag");
				const entry = { doc, data: update, kind: kind === KIND.snapshot ? "snapshot" as const : "update" as const };
				seen.add(doc);
				if (pass === "index") projection.applyIndex(entry);
				else projection.applyAttachment(entry);
			}
			if (f.t === "more") return send({ t: "subscribe", after: f.seq });
			if (f.t !== "synced") return;
			// Never decrypt an old-epoch edit after removal. If the only stored copy still
			// uses the old tag, wait for a survivor's ordinary re-encrypted snapshot.
			for (const id of oldOnly) if (!seen.has(id)) throw new Error("Waiting for legacy snapshots after key rotation");
			if (pass === "index") {
				base = f.seq; tags.clear(); older.clear(); seen.clear(); oldOnly.clear();
				for (const id of projection.notes.keys()) await watch(id);
				pass = "docs"; send({ t: "subscribe", after: 0 });
			} else if (pass === "docs") {
				if (base !== f.seq) return finish(true);
				projection.requireStoredNotes(seen);
				pass = "stage"; parts = packGenesis(stagedRows()); await next();
			}
		}).catch(err => finish(false, err));
	};
	ws.onclose = () => finish(false, new Error("The migration connection closed before the Worker confirmed the result."));
	return () => finish();
}
