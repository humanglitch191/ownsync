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
	enabled?(): boolean;
	timing?: {
		now(): number;
		random(): number;
		setTimer(callback: () => void, delay: number): () => void;
	};
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

const backupTiming: NonNullable<HistoryBackupDeps["timing"]> = {
	now: () => performance.now(),
	random: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32,
	setTimer: (callback, delay) => {
		const timer = setTimeout(callback, delay);
		return () => clearTimeout(timer);
	},
};

interface DelayedChange {
	due: number;
	noteId: string | undefined;
	upload: boolean;
	start(): void;
	cancel(): void;
}

/** One client per vault session. Restore a listed copy through the caller's ordinary text-edit path. */
export function createHistoryBackup(deps: HistoryBackupDeps) {
	const { keys, vaultId, timing = backupTiming, enabled = () => true } = deps;
	const url = `${deps.host.replace(/\/$/, "")}/vault/${hex(vaultId)}/history`;
	let support: boolean | undefined;
	let mutations = Promise.resolve();
	let delayed: DelayedChange[] = [];
	let cancelTimer: (() => void) | undefined;
	let revision = 0;
	let stopping = false;

	function active(epoch: number): boolean {
		const { pending, removed, fork } = keys.state;
		return support !== false && keys.epoch === epoch && !pending?.tokenHash && !removed && !fork;
	}

	async function post(path: string, allowed: () => boolean, ...parts: Uint8Array[]) {
		if (!allowed()) return;
		// An empty tag on a note clear would otherwise turn it into a vault-wide clear.
		if (parts.length && parts[0]?.length !== 16) return;
		const token = await deps.token();
		if (token.length !== 32 || !allowed()) return;
		const response = await deps.requestUrl({
			url: url + path, method: "POST", contentType: "application/octet-stream",
			body: concat(token, ...parts).buffer as ArrayBuffer, throw: false,
		}).catch(() => undefined);
		if (!allowed()) return;
		if (response?.status === 404 || response?.status === 401 || response?.status === 410) support = false;
		if (response?.status !== 200) return;
		support = true;
		return response;
	}

	// Serialize the Worker mutations that are ready to send.
	function mutate<T>(change: () => Promise<T>): Promise<T> {
		const result = mutations.then(change);
		mutations = result.then(() => undefined, () => undefined);
		return result;
	}

	function armTimer(): void {
		cancelTimer?.();
		const due = delayed.reduce((earliest, change) => Math.min(earliest, change.due), Infinity);
		cancelTimer = due === Infinity ? undefined : timing.setTimer(() => drain(timing.now()), Math.max(0, due - timing.now()));
	}

	function drain(now: number): void {
		const ready = delayed.filter((change) => change.due <= now).sort((a, b) => a.due - b.due);
		delayed = delayed.filter((change) => change.due > now);
		for (const change of ready) change.start();
		armTimer();
	}

	function later<T>(due: number, noteId: string | undefined, upload: boolean, change: () => Promise<T>, skipped: T): Promise<T> {
		if (due <= timing.now()) {
			drain(timing.now());
			return mutate(change);
		}
		return new Promise((resolve, reject) => {
			delayed.push({ due, noteId, upload, start: () => void mutate(change).then(resolve, reject), cancel: () => resolve(skipped) });
			armTimer();
		});
	}

	function clear(noteId?: string): Promise<boolean> {
		if (stopping) return Promise.resolve(false);
		// Keep the random deadlines. A clear waits only for delayed changes it would clear.
		const due = delayed.reduce((latest, change) =>
			noteId === undefined || change.noteId === undefined || change.noteId === noteId ? Math.max(latest, change.due) : latest, timing.now());
		return later(due, noteId, false, async () => {
			const epoch = keys.epoch;
			const allowed = () => active(epoch);
			if (!allowed()) return false;
			if (noteId === undefined) return !!await post("/clear", allowed);
			const tags = (await deps.allDocTags?.(noteId)) ?? [await deps.docTag(noteId)];
			let ok = true;
			for (const tag of tags) ok = !!(await post("/clear", allowed, tag)) && ok;
			return ok;
		}, false);
	}

	function discardUploads(): void {
		revision++;
		for (const change of delayed) if (change.upload) change.cancel();
		delayed = delayed.filter((change) => !change.upload);
		drain(Infinity);
	}

	return {
		noteIdForPath: (path: string) => deps.noteIdForPath(path),
		enabled: () => !stopping && enabled(),
		/** Undefined before a definitive response. False when this session has disabled backups. */
		supported: () => support,
		/** Called at session stop, with the caller's existing shutdown deadline. */
		idle(): Promise<void> {
			stopping = true;
			discardUploads();
			return mutations;
		},
		discardUploads,
		upload(noteId: string, text: string, takenAt: number): Promise<void> {
			if (stopping || !enabled() || !active(keys.epoch) || text.length > MAX_HISTORY_ENVELOPE) return Promise.resolve();
			const atEnqueue = revision;
			const randomDue = timing.now() + 30_000 + Math.floor(timing.random() * 270_001);
			// A new copy may share a deadline with a pending clear, after the clear itself.
			const due = delayed.reduce((latest, change) =>
				!change.upload && (change.noteId === undefined || change.noteId === noteId) ? Math.max(latest, change.due) : latest, randomDue);
			return later(due, noteId, true, async () => {
				const { epoch, vmk } = keys;
				const allowed = () => enabled() && revision === atEnqueue && active(epoch);
				if (!allowed()) return;
				const plaintext = packHistory(noteId, takenAt, text);
				if (!plaintext) return;
				const tag = await deps.docTag(noteId);
				if (!allowed()) return;
				const envelope = await sealEnvelope({
					kind: KIND.history, epoch, deviceId: keys.me.id, vmk, vaultId, docId: tag, plaintext,
				});
				await post("", allowed, tag, envelope);
			}, undefined);
		},
		async list(noteId: string): Promise<HistoryBackupCopy[]> {
			const { epoch, vmk } = keys;
			const atStart = revision;
			const allowed = () => !stopping && enabled() && revision === atStart && active(epoch);
			if (!allowed()) return [];
			const tag = await deps.docTag(noteId);
			const response = await post("/list", allowed, tag);
			if (!response) return [];
			const copies: HistoryBackupCopy[] = [];
			for (const envelope of envelopes(new Uint8Array(response.arrayBuffer))) {
				if (!allowed()) return [];
				const opened = await openEnvelope(envelope, vaultId, tag, (e) => e === epoch ? vmk : undefined).catch(() => undefined);
				if (opened?.kind !== KIND.history) continue;
				const copy = unpackHistory(opened.plaintext, noteId);
				if (copy) copies.push({ ...copy, reportedDevice: hex(opened.deviceId) });
			}
			if (!allowed()) return [];
			return copies.sort((a, b) => b.takenAt - a.takenAt || a.reportedDevice.localeCompare(b.reportedDevice)
				|| (a.text < b.text ? -1 : Number(a.text > b.text)));
		},
		/** Clear the current tag for one note. Returns true when the Worker acknowledges. */
		forget: (noteId: string) => noteId ? clear(noteId) : Promise.resolve(false),
		/** Clear the vault's backups. Returns true when the Worker acknowledges. */
		forgetAll: () => clear(),
	};
}
