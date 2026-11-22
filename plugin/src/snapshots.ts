import {
	KIND, MAX_VAULT_SNAPSHOT_ENVELOPE, MAX_VAULT_SNAPSHOT_JSON, MAX_VAULT_SNAPSHOT_PARTS,
	VAULT_SNAPSHOT_PART_BYTES, concat, gunzipVaultSnapshot, gzipVaultSnapshot, hex, openEnvelope,
	packVaultSnapshotPart, randomBytes, sealEnvelope, sha256, unhex, unpackVaultSnapshotPart,
} from "../../protocol/ownsync";
import type { Ref, SnapshotLedgerEntry } from "./core/ports";
import type { HistoryBackupDeps } from "./historyBackup";

export interface SnapshotInfo { id: string; day: number; takenAt?: number; epoch: number; size: number; complete: boolean; verified: boolean; missingOnServer?: boolean; notesOnly?: boolean }
export interface SnapshotNote { id: string; path: string; text: string }
export interface SnapshotContent { id: string; day: number; takenAt: number; notesOnly: boolean; notes: SnapshotNote[]; attachments: { id: string; path: string }[] }

type Attachment = SnapshotContent["attachments"][number] & { ref: Pick<Ref, "h" | "n" | "c"> & Partial<Pick<Ref, "u">> };
type SnapshotBody = Omit<SnapshotContent, "attachments"> & { v: 1; attachments: Attachment[] };
type TakeResult = "taken" | "not due" | "taken elsewhere" | "unavailable" | "too large";

export interface SnapshotDeps extends Pick<HistoryBackupDeps, "host" | "vaultId" | "token" | "keys" | "requestUrl"> {
	/** The sync connection is ready and caught up. */
	ready(): boolean;
	mobile?: boolean;
	vmkFor(epoch: number): Uint8Array | undefined;
	listNotes(maxBytes: number): Iterable<SnapshotNote> | AsyncIterable<SnapshotNote> | Promise<SnapshotNote[]>;
	/** Return undefined when attachment references aren't available, or an empty array for a vault with none. */
	listAttachments?(): Attachment[] | undefined | Promise<Attachment[] | undefined>;
	snapshotLedger(): Promise<Map<string, SnapshotLedgerEntry>>;
	recordSnapshot(id: string, entry: SnapshotLedgerEntry): Promise<void>;
	forgetSnapshots(ids?: string[]): Promise<void>;
	configDir: string;
	normalizePath(path: string): string;
	/** Defaults to browser local storage, scoped by vault and device ID. */
	deviceDayStore?: Pick<Storage, "getItem" | "setItem">;
	now?(): number;
}

interface WorkerSnapshot {
	id: string;
	day: number;
	epoch: number;
	parts: number;
	received: number;
	size: number;
	complete: boolean;
	at: number;
}

interface Upload {
	id: string;
	entry: SnapshotLedgerEntry;
	compressed: Uint8Array;
	partCount: number;
	workerDay?: number;
	envelope?: Uint8Array;
}

const dayOf = (at: number) => Math.floor(at / 86_400_000);
const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
const isHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

// Count the UTF-8 bytes JSON needs for note text without allocating its escaped form.
function jsonTextBytes(text: string, limit: number): number {
	let bytes = 0;
	for (let i = 0; i < text.length && bytes <= limit; i++) {
		const code = text.charCodeAt(i);
		if (code < 32) bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
		else if (code < 128) bytes += code === 34 || code === 92 ? 2 : 1;
		else if (code < 2048) bytes += 2;
		else if (code < 0xd800 || code > 0xdfff) bytes += 3;
		else {
			const next = text.charCodeAt(i + 1);
			if (code < 0xdc00 && next >= 0xdc00 && next <= 0xdfff) {
				i++;
				bytes += 4;
			} else bytes += 6;
		}
	}
	return bytes;
}

function json(buffer: ArrayBuffer): unknown {
	try { return JSON.parse(decoder.decode(buffer)); }
	catch { return undefined; }
}

function workerRow(value: unknown): value is WorkerSnapshot {
	if (!value || typeof value !== "object") return false;
	const { id, day, epoch, parts, received, size, complete, at } = value as Partial<WorkerSnapshot>;
	return isId(id) && natural(day) && natural(epoch) && epoch <= 0xffffffff
		&& natural(parts) && parts > 0 && parts <= MAX_VAULT_SNAPSHOT_PARTS
		&& natural(received) && received <= parts && natural(size) && natural(at)
		&& complete === (received === parts);
}

function safePath(path: unknown, note: boolean, { configDir, normalizePath }: Pick<SnapshotDeps, "configDir" | "normalizePath">): path is string {
	// Mirror VaultDisk.check with the vault's Obsidian normalizer. Reject drive paths and NUL explicitly.
	return typeof path === "string" && !/^[a-z]:|[\\\0]/i.test(path)
		&& path === normalizePath(path) && path.endsWith(".md") === note
		&& !path.split("/").some((segment) => !segment || segment.startsWith("."))
		&& path !== configDir && !path.startsWith(`${configDir}/`);
}

function validContent(value: unknown, deps: SnapshotDeps): value is SnapshotBody {
	if (!value || typeof value !== "object") return false;
	const { v, id, day, takenAt, notesOnly, notes, attachments } = value as Partial<SnapshotBody>;
	if (v !== 1 || !isId(id) || !natural(takenAt) || day !== dayOf(takenAt) || typeof notesOnly !== "boolean"
		|| !Array.isArray(notes) || !Array.isArray(attachments) || (notesOnly && attachments.length)) return false;

	const ids = new Set<string>();
	const paths = new Set<string>();
	function file(value: { id: string; path: string }, note: boolean): boolean {
		if (!value || typeof value.id !== "string" || !value.id || !safePath(value.path, note, deps)
			|| ids.has(value.id) || paths.has(value.path)) return false;
		ids.add(value.id);
		paths.add(value.path);
		return true;
	}
	return notes.every((note) => file(note, true) && typeof note.text === "string")
		&& attachments.every((attachment) => {
			if (!file(attachment, false)) return false;
			const { ref } = attachment;
			return !!ref && isHash(ref.h) && natural(ref.n) && Array.isArray(ref.c) && ref.c.every(isHash)
				&& (ref.u === undefined || (typeof ref.u === "string" && !!ref.u));
		});
}

function partNumbers(index: number, count: number): Uint8Array {
	const bytes = new Uint8Array(4), view = new DataView(bytes.buffer);
	view.setUint16(0, index);
	view.setUint16(2, count);
	return bytes;
}

function* frames(buffer: ArrayBuffer): IterableIterator<{ index: number; envelope: Uint8Array }> {
	const view = new DataView(buffer);
	let offset = 0;
	while (offset < buffer.byteLength) {
		if (buffer.byteLength - offset < 6) throw new Error("truncated snapshot frame");
		const index = view.getUint16(offset);
		const length = view.getUint32(offset + 2);
		offset += 6;
		if (!length || length > MAX_VAULT_SNAPSHOT_ENVELOPE || offset + length > buffer.byteLength) {
			throw new Error("invalid snapshot frame length");
		}
		yield { index, envelope: new Uint8Array(buffer, offset, length) };
		offset += length;
	}
}

export function createSnapshots(deps: SnapshotDeps): {
	takeIfDue(): Promise<TakeResult>;
	list(): Promise<SnapshotInfo[]>;
	open(id: string): Promise<SnapshotContent>;
	remove(id?: string): Promise<void>;
} {
	// A phone opens snapshots up to 96 MiB but takes them only up to 32 MiB: taking holds the notes, their JSON
	// and its gzip at once.
	const jsonLimit = deps.mobile ? 96 * 1024 * 1024 : MAX_VAULT_SNAPSHOT_JSON;
	const takeLimit = deps.mobile ? 32 * 1024 * 1024 : MAX_VAULT_SNAPSHOT_JSON;
	const { keys, vaultId, now = Date.now } = deps;
	const url = `${deps.host.replace(/\/$/, "")}/vault/${hex(vaultId)}/snapshot`;
	const dayKey = `ownsync-snapshot-day-${hex(vaultId)}-${hex(keys.me.id)}`;
	let supported = true;
	let mutations = Promise.resolve();
	let lastTakenDay = readLastDay();
	let pending: Upload | undefined;

	function readLastDay(): number {
		try {
			const saved = (deps.deviceDayStore ?? globalThis.localStorage)?.getItem(dayKey);
			if (saved && natural(Number(saved))) return Number(saved);
		} catch { /* The ledger and Worker list still cover stored snapshots. */ }
		return -1;
	}

	function active(epoch: number): boolean {
		const { pending, removed, fork } = keys.state;
		return supported && keys.epoch === epoch && !pending?.tokenHash && !removed && !fork;
	}

	async function post(path: string, allowed: () => boolean, ...parts: Uint8Array[]) {
		if (!allowed()) return;
		const token = await deps.token();
		if (token.length !== 32 || !allowed()) return;
		const response = await deps.requestUrl({
			url: url + path, method: "POST", contentType: "application/octet-stream",
			body: concat(token, ...parts).buffer as ArrayBuffer, throw: false,
		}).catch(() => undefined);
		if (response?.status === 401 || response?.status === 410 || (path === "/list" && response?.status === 404)) {
			supported = false;
		}
		if (allowed()) return response;
	}

	function mutate<T>(change: () => Promise<T>): Promise<T> {
		const result = mutations.then(change);
		mutations = result.then(() => undefined, () => undefined);
		return result;
	}

	async function workerList(allowed: () => boolean): Promise<WorkerSnapshot[] | undefined> {
		const response = await post("/list", allowed);
		if (response?.status !== 200) return;
		const rows = json(response.arrayBuffer);
		if (Array.isArray(rows) && rows.every(workerRow)) return rows;
	}

	// Its own function, so the notes and their JSON are gone before the upload starts.
	async function build(day: number, epoch: number, takenAt: number, allowed: () => boolean): Promise<Upload | "unavailable" | "too large"> {
		const notes: SnapshotNote[] = [];
		let noteBytes = 0;
		for await (const note of await deps.listNotes(takeLimit)) {
			if (!allowed()) return "unavailable";
			if (note.text.length > takeLimit - noteBytes) return "too large";
			noteBytes += jsonTextBytes(note.text, takeLimit - noteBytes);
			if (noteBytes > takeLimit) return "too large";
			notes.push(note);
		}
		const attachments = await deps.listAttachments?.();
		const id = hex(randomBytes(16));
		const content: SnapshotBody = { v: 1, id, day, takenAt, notesOnly: attachments === undefined, notes, attachments: attachments ?? [] };
		if (!allowed() || !validContent(content, deps)) return "unavailable";
		let serialized: string | undefined = JSON.stringify(content);
		notes.length = 0; // their text is in the JSON now
		if (serialized.length > takeLimit) return "too large";
		const bytes = encoder.encode(serialized);
		serialized = undefined;
		if (bytes.length > takeLimit) return "too large";
		const compressed = await gzipVaultSnapshot(bytes);
		const partCount = Math.ceil(compressed.length / VAULT_SNAPSHOT_PART_BYTES);
		if (partCount > MAX_VAULT_SNAPSHOT_PARTS) return "too large";
		return { id, compressed, partCount, entry: { day, epoch, parts: [], notesOnly: content.notesOnly, takenAt } };
	}

	async function take(): Promise<TakeResult> {
		const { epoch, vmk } = keys;
		const allowed = () => active(epoch) && deps.ready();
		if (!allowed() || typeof CompressionStream === "undefined") return "unavailable";
		const takenAt = now(), day = dayOf(takenAt);
		if (day <= lastTakenDay) return "not due";
		if (pending && (pending.entry.day !== day || pending.entry.epoch !== epoch)) pending = undefined;

		if (!pending) {
			const rows = await workerList(allowed);
			if (!rows) return "unavailable";
			const ledger = await deps.snapshotLedger();
			if ([...ledger.values()].some((entry) => entry.day === day)) return "not due";
			if (rows.some((row) => row.complete && row.day === day)) return "taken elsewhere";
			if (!allowed()) return "unavailable";
			const built = await build(day, epoch, takenAt, allowed);
			if (typeof built === "string") return built;
			pending = built;
		}

		const upload = pending;
		const { id, entry, partCount, compressed } = upload;
		const docId = unhex(id);
		let restarted = false;
		while (entry.parts.length < partCount) {
			if (!allowed()) return "unavailable";
			const partIndex = entry.parts.length;
			const start = partIndex * VAULT_SNAPSHOT_PART_BYTES;
			// Keep the exact ciphertext if an acknowledgement is lost.
			const envelope = upload.envelope ??= await sealEnvelope({
				kind: KIND.vaultSnapshot, vmk, vaultId, docId, epoch, deviceId: keys.me.id,
				plaintext: packVaultSnapshotPart({ id, day, takenAt: entry.takenAt, partIndex, partCount },
					compressed.subarray(start, start + VAULT_SNAPSHOT_PART_BYTES)),
			});
			const response = await post("", allowed, docId, partNumbers(partIndex, partCount), envelope);
			if (response?.status === 413) {
				pending = undefined;
				if (partIndex > 0) await post("/delete", allowed, docId).catch(() => undefined);
				return "too large";
			}
			if (response?.status === 409) {
				const error = (json(response.arrayBuffer) as { error?: unknown } | undefined)?.error;
				if (error === "taken") {
					pending = undefined;
					return "taken elsewhere";
				}
				if (error === "restart") {
					entry.parts.length = 0;
					upload.envelope = undefined;
					upload.workerDay = undefined;
					if (partIndex === 0 || restarted) return "unavailable";
					restarted = true;
					continue;
				}
			}
			if (response?.status !== 200) return "unavailable";
			const ack = json(response.arrayBuffer) as { ok?: unknown; day?: unknown; complete?: unknown } | undefined;
			if (ack?.ok !== true || !natural(ack.day) || typeof ack.complete !== "boolean") return "unavailable";
			upload.workerDay ??= ack.day;
			if (ack.day !== day || ack.day !== upload.workerDay) {
				pending = undefined;
				return "taken elsewhere";
			}
			if (ack.complete !== (partIndex === partCount - 1)) return "unavailable";
			entry.parts.push(hex(await sha256(envelope)));
			upload.envelope = undefined;
		}
		if (!allowed()) return "unavailable";
		await deps.recordSnapshot(id, entry);
		lastTakenDay = day;
		try { (deps.deviceDayStore ?? globalThis.localStorage)?.setItem(dayKey, String(day)); }
		catch { /* The ledger and Worker list still cover stored snapshots. */ }
		pending = undefined;
		return "taken";
	}

	async function downloadSnapshot(id: string, partCount: number, allowed: () => boolean): Promise<Map<number, Uint8Array>> {
		const response = await post("/get", allowed, unhex(id));
		if (response?.status !== 200) throw new Error("snapshot is unavailable");
		const envelopes = new Map<number, Uint8Array>();
		for (const { index, envelope } of frames(response.arrayBuffer)) {
			if (index >= partCount || envelopes.has(index)) throw new Error("duplicate or unexpected snapshot part");
			envelopes.set(index, envelope);
		}
		if (envelopes.size !== partCount) throw new Error("snapshot parts are missing");
		return envelopes;
	}

	async function* decryptedParts(id: string, entry: SnapshotLedgerEntry, vmk: Uint8Array, allowed: () => boolean) {
		const docId = unhex(id);
		const envelopes = await downloadSnapshot(id, entry.parts.length, allowed);
		for (let index = 0; index < entry.parts.length; index++) {
			const envelope = envelopes.get(index)!;
			envelopes.delete(index);
			if (hex(await sha256(envelope)) !== entry.parts[index]) throw new Error("snapshot part hash mismatch");
			const opened = await openEnvelope(envelope, vaultId, docId, (epoch) => epoch === entry.epoch ? vmk : undefined);
			if (opened.kind !== KIND.vaultSnapshot) throw new Error("unexpected snapshot envelope kind");
			const part = unpackVaultSnapshotPart(opened.plaintext);
			if (part.id !== id || part.day !== entry.day || part.takenAt !== entry.takenAt
				|| part.partIndex !== index || part.partCount !== entry.parts.length) {
				throw new Error("snapshot part metadata mismatch");
			}
			if (!allowed()) throw new Error("snapshot is unavailable");
			yield part.bytes;
		}
	}

	return {
		takeIfDue: () => mutate(() => take().catch((error: unknown) => error instanceof RangeError ? "too large" : "unavailable")),
		async list(): Promise<SnapshotInfo[]> {
			const epoch = keys.epoch;
			const ledger = await deps.snapshotLedger();
			const rows = await workerList(() => active(epoch));
			const snapshots = new Map<string, SnapshotInfo>();
			for (const row of rows ?? []) {
				const entry = ledger.get(row.id);
				const verified = !!entry && row.complete && row.epoch === entry.epoch && row.day === entry.day
					&& row.parts === entry.parts.length;
				snapshots.set(row.id, {
					id: row.id, day: row.day, epoch: row.epoch, size: row.size, complete: row.complete, verified,
					...(verified ? { takenAt: entry.takenAt, notesOnly: entry.notesOnly } : {}),
				});
			}
			for (const [id, { day, takenAt, epoch, notesOnly }] of ledger) {
				if (!snapshots.has(id)) snapshots.set(id, {
					id, day, takenAt, epoch, size: 0, complete: false, verified: true, notesOnly,
					...(rows ? { missingOnServer: true } : {}),
				});
			}
			return [...snapshots.values()].sort((a, b) => b.day - a.day || (b.takenAt ?? 0) - (a.takenAt ?? 0));
		},
		async open(id: string): Promise<SnapshotContent> {
			if (!isId(id)) throw new Error("invalid snapshot ID");
			const epoch = keys.epoch;
			const allowed = () => active(epoch);
			const entry = (await deps.snapshotLedger()).get(id);
			if (!entry || !entry.parts.length || entry.parts.length > MAX_VAULT_SNAPSHOT_PARTS || !entry.parts.every(isHash)) {
				throw new Error("snapshot has no verified ledger entry");
			}
			const vmk = deps.vmkFor(entry.epoch);
			if (!vmk || entry.epoch > epoch) throw new Error("snapshot key is unavailable");
			const content: unknown = JSON.parse(await gunzipVaultSnapshot(decryptedParts(id, entry, vmk, allowed), jsonLimit));
			if (!allowed()) throw new Error("snapshot is unavailable");
			if (!validContent(content, deps) || content.id !== id || content.day !== entry.day
				|| content.takenAt !== entry.takenAt || content.notesOnly !== entry.notesOnly) {
				throw new Error("invalid snapshot content or unsafe path");
			}
			const { day, takenAt, notesOnly, notes, attachments } = content;
			return { id, day, takenAt, notesOnly, notes: notes.map(({ id, path, text }) => ({ id, path, text })),
				attachments: attachments.map(({ id, path }) => ({ id, path })) };
		},
		remove: (id) => mutate(async () => {
			if (id !== undefined && !isId(id)) throw new Error("invalid snapshot ID");
			const epoch = keys.epoch;
			const response = await post("/delete", () => active(epoch), ...(id === undefined ? [] : [unhex(id)]));
			if (response?.status !== 200) throw new Error("could not delete snapshot from Worker");
			if (id === undefined || id === pending?.id) pending = undefined;
			await deps.forgetSnapshots(id === undefined ? undefined : [id]);
		}),
	};
}
