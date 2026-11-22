import { KIND, MAX_HISTORY_ENVELOPE, concat, hex, openEnvelope, packHistory, sealEnvelope, unpackHistory } from "../../protocol/ownsync";
import type { VaultKeys } from "./keys";

export interface HistoryBackupDeps {
	host: string;
	vaultId: Uint8Array;
	token(): Promise<Uint8Array>;
	keys: Pick<VaultKeys, "epoch" | "vmk"> & {
		me: Pick<VaultKeys["me"], "id">;
		state: Pick<VaultKeys["state"], "pending" | "removed" | "fork">;
	};
	/** The protocol document tag for this note ID, derived from the current VMK. */
	docTag(noteId: string): Promise<Uint8Array>;
	/** The note's tag under every epoch this device holds a key for, so Forget reaches copies made before a rotation. */
	allDocTags?(noteId: string): Promise<Uint8Array[]>;
	noteIdForPath(path: string): string | undefined;
	requestUrl(request: { url: string; method: "POST"; body: ArrayBuffer; contentType: string; throw: false }):
		Promise<{ status: number; arrayBuffer: ArrayBuffer }>;
}

export interface HistoryBackupCopy {
	takenAt: number;
	text: string;
	/** Full hex device ID claimed by the envelope. Every vault member can make this claim. */
	reportedDevice: string;
}

function* envelopes(bytes: Uint8Array): IterableIterator<Uint8Array> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 0;
	for (let i = 0; i < 200 && offset + 4 <= bytes.length; i++) {
		const length = view.getUint32(offset);
		const start = offset + 4;
		offset = start + length;
		if (offset > bytes.length) break;
		if (length && length <= MAX_HISTORY_ENVELOPE) yield bytes.subarray(start, offset);
	}
}

/** One client per vault session. Restore a listed copy through the caller's ordinary text-edit path. */
export function createHistoryBackup(deps: HistoryBackupDeps) {
	const { keys, vaultId } = deps;
	const url = `${deps.host.replace(/\/$/, "")}/vault/${hex(vaultId)}/history`;
	let support: boolean | undefined;
	let mutations = Promise.resolve();

	function active(epoch: number): boolean {
		const { pending, removed, fork } = keys.state;
		return support !== false && keys.epoch === epoch && !pending?.tokenHash && !removed && !fork;
	}

	async function post(path: string, epoch: number, ...parts: Uint8Array[]) {
		if (!active(epoch)) return;
		// An empty tag on a note clear would otherwise turn it into a vault-wide clear.
		if (parts.length && parts[0]?.length !== 16) return;
		const token = await deps.token();
		if (token.length !== 32 || !active(epoch)) return;
		const response = await deps.requestUrl({
			url: url + path, method: "POST", contentType: "application/octet-stream",
			body: concat(token, ...parts).buffer as ArrayBuffer, throw: false,
		}).catch(() => undefined);
		if (response?.status === 404 || response?.status === 401 || response?.status === 410) support = false;
		if (response?.status !== 200 || !active(epoch)) return;
		support = true;
		return response;
	}

	// An upload already queued in this session finishes before a later clear request.
	function mutate<T>(change: () => Promise<T>): Promise<T> {
		const result = mutations.then(change);
		mutations = result.then(() => undefined, () => undefined);
		return result;
	}

	function clear(noteId?: string): Promise<boolean> {
		return mutate(async () => {
			const epoch = keys.epoch;
			if (!active(epoch)) return false;
			if (noteId === undefined) return !!await post("/clear", epoch);
			const tags = (await deps.allDocTags?.(noteId)) ?? [await deps.docTag(noteId)];
			let ok = true;
			for (const tag of tags) ok = !!(await post("/clear", epoch, tag)) && ok;
			return ok;
		});
	}

	return {
		noteIdForPath: (path: string) => deps.noteIdForPath(path),
		/** Undefined before a definitive response. False when this session has disabled backups. */
		supported: () => support,
		/** Resolves once uploads and clears already started have finished. */
		idle: () => mutations,
		upload(noteId: string, text: string, takenAt: number): Promise<void> {
			return mutate(async () => {
				const { epoch, vmk } = keys;
				if (!active(epoch)) return;
				const plaintext = packHistory(noteId, takenAt, text);
				if (!plaintext) return;
				const tag = await deps.docTag(noteId);
				if (!active(epoch)) return;
				const envelope = await sealEnvelope({
					kind: KIND.history, epoch, deviceId: keys.me.id, vmk, vaultId, docId: tag, plaintext,
				});
				await post("", epoch, tag, envelope);
			});
		},
		async list(noteId: string): Promise<HistoryBackupCopy[]> {
			const { epoch, vmk } = keys;
			if (!active(epoch)) return [];
			const tag = await deps.docTag(noteId);
			const response = await post("/list", epoch, tag);
			if (!response) return [];
			const copies: HistoryBackupCopy[] = [];
			for (const envelope of envelopes(new Uint8Array(response.arrayBuffer))) {
				if (!active(epoch)) return [];
				const opened = await openEnvelope(envelope, vaultId, tag, (e) => e === epoch ? vmk : undefined).catch(() => undefined);
				if (opened?.kind !== KIND.history) continue;
				const copy = unpackHistory(opened.plaintext, noteId);
				if (copy) copies.push({ ...copy, reportedDevice: hex(opened.deviceId) });
			}
			if (!active(epoch)) return [];
			return copies.sort((a, b) => b.takenAt - a.takenAt || a.reportedDevice.localeCompare(b.reportedDevice)
				|| (a.text < b.text ? -1 : Number(a.text > b.text)));
		},
		/** Clear the current tag for one note. Returns true when the Worker acknowledges. */
		forget: (noteId: string) => noteId ? clear(noteId) : Promise.resolve(false),
		/** Clear the vault's backups. Returns true when the Worker acknowledges. */
		forgetAll: () => clear(),
	};
}
