// Ownsync protocol v1, reference implementation of docs/PROTOCOL.md.
// Web platform APIs, so the same file runs in Node, Obsidian desktop and iOS.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

export const VERSION = 1;
export const SUITE = 1; // AES-256-GCM, HKDF-SHA256, HMAC-SHA256, ECDH P-256
export const KIND = { update: 1, snapshot: 2, presence: 3, chunk: 4, updatePart: 5, history: 6, vaultSnapshot: 7, attachmentRecord: 8, noteRecord: 9 } as const;
export const RECOVERY_ID = new Uint8Array(16); // member ID of the recovery key pair
const ZERO_NONCE = new Uint8Array(12); // only for keys that seal exactly one message

// --- bytes ---

export function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let i = 0;
	for (const p of parts) { out.set(p, i); i += p.length; }
	return out;
}
const u8 = (n: number) => Uint8Array.of(n);
function uint(n: number, bytes: 2 | 4 | 8): Uint8Array {
	const b = new Uint8Array(bytes), v = new DataView(b.buffer);
	if (bytes === 2) v.setUint16(0, n);
	else if (bytes === 4) v.setUint32(0, n);
	else v.setBigUint64(0, BigInt(n));
	return b;
}
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const b64url = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

class Reader {
	private b: Uint8Array;
	private v: DataView;
	i = 0;
	constructor(b: Uint8Array) { this.b = b; this.v = new DataView(b.buffer, b.byteOffset, b.length); }
	bytes(n: number) {
		if (this.i + n > this.b.length) throw new Error("truncated");
		return this.b.slice(this.i, (this.i += n));
	}
	u8() { return this.bytes(1)[0]!; }
	u16() { const n = this.v.getUint16(this.i); this.bytes(2); return n; }
	u32() { const n = this.v.getUint32(this.i); this.bytes(4); return n; }
	u64() { const n = Number(this.v.getBigUint64(this.i)); this.bytes(8); return n; }
	end() { if (this.i !== this.b.length) throw new Error("trailing bytes"); }
}

// --- primitives ---

export const sha256 = async (b: Uint8Array) => new Uint8Array(await subtle.digest("SHA-256", b));

/** What the dashboard sends for the setup key (POST /api/setup): the key bound to the Worker's origin, never the key. */
export const setupProof = async (origin: string, setupKey: string) => hex(await sha256(new TextEncoder().encode(`ownsync-setup\n${origin}\n${setupKey}`)));
export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
	const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, 256));
}
const label = (s: string, ...rest: Uint8Array[]) => concat(te.encode(`ownsync/v1/${s}`), ...rest);

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await subtle.sign("HMAC", k, data));
}

async function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, ad: Uint8Array) {
	const k = await subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
	return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: ad }, k, plaintext));
}
async function open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array) {
	const k = await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
	return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: ad }, k, ciphertext));
}

// P-256 keys travel as raw bytes: private d (32) and uncompressed public point (65).
export function importPrivate(d: Uint8Array, pub: Uint8Array): Promise<CryptoKey> {
	const jwk = { kty: "EC", crv: "P-256", d: b64url(d), x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33)) };
	return subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}
async function ecdh(priv: CryptoKey, pub: Uint8Array): Promise<Uint8Array> {
	const p = await subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, false, []);
	return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: p }, priv, 256));
}
export async function generateKeyPair(): Promise<{ d: Uint8Array; pub: Uint8Array }> {
	const kp = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const jwk = await subtle.exportKey("jwk", kp.privateKey);
	const d = Uint8Array.from(atob(jwk.d!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
	return { d, pub: new Uint8Array(await subtle.exportKey("raw", kp.publicKey)) };
}

// --- key schedule (all from the epoch's VMK, salt = vaultId) ---

export const sealKey = (vmk: Uint8Array, vaultId: Uint8Array, deviceId: Uint8Array) => hkdf(vmk, vaultId, label("seal", deviceId));
export const nameKey = (vmk: Uint8Array, vaultId: Uint8Array) => hkdf(vmk, vaultId, label("name"));
export const authToken = (vmk: Uint8Array, vaultId: Uint8Array) => hkdf(vmk, vaultId, label("auth"));
export const memberKey = (vmk: Uint8Array, vaultId: Uint8Array) => hkdf(vmk, vaultId, label("member"));
const keyringKey = (vmk: Uint8Array, vaultId: Uint8Array) => hkdf(vmk, vaultId, label("keyring"));

// --- envelopes: header(23) | nonce(12) | ciphertext+tag ---

export type Header = { kind: number; epoch: number; deviceId: Uint8Array };
const HEADER_LEN = 23;

export function parseHeader(envelope: Uint8Array): Header {
	const r = new Reader(envelope);
	if (r.u8() !== VERSION || r.u8() !== SUITE) throw new Error("unknown version or suite");
	return { kind: r.u8(), epoch: r.u32(), deviceId: r.bytes(16) };
}

// docId is the document tag for sync and history, the chunk name for chunks, or the whole-vault snapshot ID.
export async function sealEnvelope(a: Header & { vmk: Uint8Array; vaultId: Uint8Array; docId: Uint8Array; plaintext: Uint8Array; nonce?: Uint8Array }) {
	const header = concat(u8(VERSION), u8(SUITE), u8(a.kind), uint(a.epoch, 4), a.deviceId);
	const nonce = a.nonce ?? randomBytes(12);
	const ct = await seal(await sealKey(a.vmk, a.vaultId, a.deviceId), nonce, a.plaintext, concat(header, a.vaultId, a.docId));
	return concat(header, nonce, ct);
}

// vmkFor returns the VMK of an epoch from the key ring; epoch policy (rejecting old epochs) is the caller's.
export async function openEnvelope(envelope: Uint8Array, vaultId: Uint8Array, docId: Uint8Array, vmkFor: (epoch: number) => Uint8Array | undefined) {
	const h = parseHeader(envelope);
	const vmk = vmkFor(h.epoch);
	if (!vmk) throw new Error(`no key for epoch ${h.epoch}`);
	const header = envelope.slice(0, HEADER_LEN);
	const plaintext = await open(await sealKey(vmk, vaultId, h.deviceId), envelope.slice(HEADER_LEN, HEADER_LEN + 12), envelope.slice(HEADER_LEN + 12), concat(header, vaultId, docId));
	return { ...h, plaintext };
}

// These identities use the vault's first name key throughout its lifetime, including after rotation.
export const tableFileId = async (key: Uint8Array, legacyId: Uint8Array) =>
	(await hmac(key, concat(te.encode("ownsync/table-file\0"), legacyId))).slice(0, 16);
export const tablePathKey = (key: Uint8Array, path: string) =>
	hmac(key, concat(te.encode("ownsync/table-path\0"), te.encode(path)));

export const chunkName = async (vmk: Uint8Array, vaultId: Uint8Array, plaintext: Uint8Array) => hmac(await nameKey(vmk, vaultId), await sha256(plaintext));
// From 0.2.0 a chunk belongs to one attachment version (`Ref.u`), so an expired version can be erased without asking
// who else uses its chunks (DESIGN.md section 10). Both with epoch 0's VMK, as chunkName. Inputs never collide with
// each other or with chunkName's: "version" first here, a length byte (at most 64, not "v") first below, 32 bytes for chunkName.
export const versionTag = async (vmk: Uint8Array, vaultId: Uint8Array, u: string) => hmac(await nameKey(vmk, vaultId), concat(te.encode("version"), te.encode(u)));
export async function scopedChunkName(vmk: Uint8Array, vaultId: Uint8Array, u: string, index: number, plaintext: Uint8Array) {
	const id = te.encode(u);
	if (id.length > 64) throw new Error("version ID too long");
	return hmac(await nameKey(vmk, vaultId), concat(u8(id.length), id, uint(index, 4), await sha256(plaintext)));
}

// --- documents: the index and each note sync as separate documents ---

// The tag the Worker files a document's entries under. It can tell which entries belong together, so it
// can drop the ones a snapshot replaces; it can't tell which note, or that two tags are the same vault's.
export const docTag = async (vmk: Uint8Array, vaultId: Uint8Array, docId: string) => (await hmac(await nameKey(vmk, vaultId), te.encode(`doc:${docId}`))).slice(0, 16);

// The plaintext of an update or snapshot envelope: which document, then the Yjs update. u8 length | id | update.
export function packEntry(docId: string, update: Uint8Array): Uint8Array {
	const id = te.encode(docId);
	if (id.length > 255) throw new Error("document ID too long"); // what its length byte holds; only version IDs are held to 64
	return concat(u8(id.length), id, update);
}
export function unpackEntry(plaintext: Uint8Array): { docId: string; update: Uint8Array } {
	const r = new Reader(plaintext);
	const docId = new TextDecoder().decode(r.bytes(r.u8()));
	return { docId, update: plaintext.subarray(r.i) };
}

// --- history copies: UTF-8 JSON padded to a power-of-two KiB bucket ---

const MIN_HISTORY_PLAINTEXT = 1024;
const MAX_HISTORY_PLAINTEXT = 1024 * 1024;
export const MAX_HISTORY_ENVELOPE = MAX_HISTORY_PLAINTEXT + HEADER_LEN + 12 + 16;
const historyDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function packHistory(note: string, t: number, text: string): Uint8Array | undefined {
	if (text.length > MAX_HISTORY_PLAINTEXT) return;
	const json = te.encode(JSON.stringify({ v: 1, note, t, text }));
	if (json.length > MAX_HISTORY_PLAINTEXT) return;
	let size = MIN_HISTORY_PLAINTEXT;
	while (size < json.length) size *= 2;
	const padded = new Uint8Array(size);
	padded.set(json);
	return padded;
}

export function unpackHistory(plaintext: Uint8Array, note: string, now = Date.now()): { takenAt: number; text: string } | undefined {
	const size = plaintext.length;
	if (size < MIN_HISTORY_PLAINTEXT || size > MAX_HISTORY_PLAINTEXT || (size & (size - 1)) !== 0) return;
	let end = size;
	while (end > 0 && plaintext[end - 1] === 0) end--;
	try {
		const copy = JSON.parse(historyDecoder.decode(plaintext.subarray(0, end)));
		if (copy?.v !== 1 || typeof copy.note !== "string" || copy.note !== note || typeof copy.text !== "string") return;
		const { t, text } = copy;
		if (!Number.isSafeInteger(t) || t < 0 || t > now + 5 * 60_000) return;
		return { takenAt: t, text };
	} catch {
		return undefined;
	}
}

// --- whole-vault snapshots: individually sealed slices of a padded gzip stream ---

const MIN_VAULT_SNAPSHOT_BUCKET = 64 * 1024;
export const VAULT_SNAPSHOT_PART_BYTES = 1024 * 1024;
export const MAX_VAULT_SNAPSHOT_JSON = 512 * 1024 * 1024;
export const MAX_VAULT_SNAPSHOT_PARTS = 512;
const VAULT_SNAPSHOT_PART_HEADER = 36;
export const MAX_VAULT_SNAPSHOT_ENVELOPE = VAULT_SNAPSHOT_PART_BYTES + VAULT_SNAPSHOT_PART_HEADER + HEADER_LEN + 12 + 16;

interface VaultSnapshotPart {
	id: string;
	day: number;
	takenAt: number;
	partIndex: number;
	partCount: number;
}

function snapshotBucket(part: VaultSnapshotPart, length: number): number {
	if (!Number.isSafeInteger(part.day) || part.day < 0 || part.day > 0xffffffff
		|| !Number.isSafeInteger(part.takenAt) || part.takenAt < 0
		|| !Number.isInteger(part.partIndex) || !Number.isInteger(part.partCount)
		|| part.partIndex < 0 || part.partIndex >= part.partCount || part.partCount > MAX_VAULT_SNAPSHOT_PARTS
		|| length < 1 || length > VAULT_SNAPSHOT_PART_BYTES
		|| (part.partIndex < part.partCount - 1 && length !== VAULT_SNAPSHOT_PART_BYTES)) {
		throw new Error("invalid snapshot part header");
	}
	if (part.partCount > 1) return VAULT_SNAPSHOT_PART_BYTES;
	let size = MIN_VAULT_SNAPSHOT_BUCKET;
	while (size < length) size *= 2;
	return size;
}

export function packVaultSnapshotPart(part: VaultSnapshotPart, bytes: Uint8Array): Uint8Array {
	if (!/^[0-9a-f]{32}$/.test(part.id)) throw new Error("invalid snapshot ID");
	const padded = new Uint8Array(VAULT_SNAPSHOT_PART_HEADER + snapshotBucket(part, bytes.length));
	const header = concat(unhex(part.id), uint(part.day, 4), uint(part.takenAt, 8),
		uint(part.partIndex, 2), uint(part.partCount, 2), uint(bytes.length, 4));
	padded.set(header);
	padded.set(bytes, VAULT_SNAPSHOT_PART_HEADER);
	return padded;
}

export function unpackVaultSnapshotPart(plaintext: Uint8Array): VaultSnapshotPart & { bytes: Uint8Array } {
	if (plaintext.length < VAULT_SNAPSHOT_PART_HEADER) throw new Error("truncated snapshot part header");
	const r = new Reader(plaintext);
	const part = { id: hex(r.bytes(16)), day: r.u32(), takenAt: r.u64(), partIndex: r.u16(), partCount: r.u16() };
	const length = r.u32();
	const end = r.i + length;
	if (plaintext.length !== r.i + snapshotBucket(part, length) || plaintext.subarray(end).some((byte) => byte !== 0)) {
		throw new Error("invalid snapshot part padding");
	}
	return { ...part, bytes: plaintext.subarray(r.i, end) };
}

function byteStream(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
	const iterator = Symbol.asyncIterator in chunks ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
	return new ReadableStream({
		async pull(controller) {
			const chunk = await iterator.next();
			if (chunk.done) controller.close();
			else controller.enqueue(chunk.value);
		},
		async cancel() { await iterator.return?.(); },
	});
}

export async function gzipVaultSnapshot(json: Uint8Array): Promise<Uint8Array> {
	function* chunks() {
		for (let i = 0; i < json.length; i += VAULT_SNAPSHOT_PART_BYTES) yield json.subarray(i, i + VAULT_SNAPSHOT_PART_BYTES);
	}
	return new Uint8Array(await new Response(byteStream(chunks()).pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

export async function gunzipVaultSnapshot(parts: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, maxBytes = MAX_VAULT_SNAPSHOT_JSON): Promise<string> {
	const reader = byteStream(parts).pipeThrough(new DecompressionStream("gzip")).getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const text: string[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new Error("snapshot exceeds decompression limit");
			text.push(decoder.decode(value, { stream: true }));
		}
		text.push(decoder.decode());
		return text.join("");
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
}

// --- rotation wraps: es + ss ECDH, so the recipient authenticates the sender ---

export type Party = { id: Uint8Array; pub: Uint8Array };

function wrapInfo(vaultId: Uint8Array, epoch: number, sender: Party, recipient: Party, ePub: Uint8Array) {
	return label("wrap", u8(SUITE), vaultId, uint(epoch, 4), sender.id, sender.pub, recipient.id, recipient.pub, ePub);
}

// Wraps vmk (the new epoch's VMK) from sender to recipient. Output: ephemeral public key (65) | ciphertext+tag (48).
export async function wrapVmk(a: { vmk: Uint8Array; vaultId: Uint8Array; epoch: number; recordHash: Uint8Array; sender: Party & { priv: CryptoKey }; recipient: Party; ephemeral?: { d: Uint8Array; pub: Uint8Array } }) {
	const e = a.ephemeral ?? (await generateKeyPair());
	const ikm = concat(await ecdh(await importPrivate(e.d, e.pub), a.recipient.pub), await ecdh(a.sender.priv, a.recipient.pub));
	const info = wrapInfo(a.vaultId, a.epoch, a.sender, a.recipient, e.pub);
	return concat(e.pub, await seal(await hkdf(ikm, a.recordHash, info), ZERO_NONCE, a.vmk, info));
}

export async function unwrapVmk(a: { wrapped: Uint8Array; vaultId: Uint8Array; epoch: number; recordHash: Uint8Array; sender: Party; recipient: Party & { priv: CryptoKey } }) {
	const ePub = a.wrapped.slice(0, 65);
	const ikm = concat(await ecdh(a.recipient.priv, ePub), await ecdh(a.recipient.priv, a.sender.pub));
	const info = wrapInfo(a.vaultId, a.epoch, a.sender, a.recipient, ePub);
	return open(await hkdf(ikm, a.recordHash, info), ZERO_NONCE, a.wrapped.slice(65), info);
}

// --- key ring: each rotation record carries the previous VMK sealed under the new one ---

export async function sealPrevVmk(newVmk: Uint8Array, vaultId: Uint8Array, newEpoch: number, prevVmk: Uint8Array) {
	return seal(await keyringKey(newVmk, vaultId), ZERO_NONCE, prevVmk, concat(vaultId, uint(newEpoch, 4)));
}
export async function openPrevVmk(newVmk: Uint8Array, vaultId: Uint8Array, newEpoch: number, sealed: Uint8Array) {
	return open(await keyringKey(newVmk, vaultId), ZERO_NONCE, sealed, concat(vaultId, uint(newEpoch, 4)));
}

// --- update parts: an update too big for one frame, split; reassembled before applying ---

export const PART_SIZE = 512 * 1024;

// Plaintext of a KIND.updatePart envelope: groupId(16) | u16 index | u16 count | bytes.
export function splitUpdate(update: Uint8Array, groupId = randomBytes(16)): Uint8Array[] {
	const count = Math.ceil(update.length / PART_SIZE);
	if (count > 0xffff) throw new Error("update too large");
	return Array.from({ length: count }, (_, i) => concat(groupId, uint(i, 2), uint(count, 2), update.subarray(i * PART_SIZE, (i + 1) * PART_SIZE)));
}

export function parsePart(plaintext: Uint8Array) {
	const r = new Reader(plaintext);
	const groupId = hex(r.bytes(16)), index = r.u16(), count = r.u16();
	if (index >= count) throw new Error("bad part index");
	return { groupId, index, count, bytes: plaintext.subarray(r.i) };
}

// --- pairing: the QR carries a one-time 16-byte code K; the VMK waits on the server sealed under K ---

const pairKey = (k: Uint8Array) => hkdf(k, new Uint8Array(0), label("pair"));
// The server sees only this, never K.
export const pairingRoom = async (k: Uint8Array) => hex((await sha256(concat(label("pair-room"), k))).slice(0, 16));
// One-shot key: every pairing uses a fresh K.
export const sealForPairing = async (k: Uint8Array, payload: Uint8Array) => seal(await pairKey(k), ZERO_NONCE, payload, label("pair"));
export const openFromPairing = async (k: Uint8Array, sealed: Uint8Array) => open(await pairKey(k), ZERO_NONCE, sealed, label("pair"));

// What the mailbox carries: the current VMK and epoch, the pairing device's newest record (so the server
// can't feed the new device a stale chain) and the pairing device's ID.
// vmk(32) | u32 epoch | u32 number | hash(32) | pairerId(16)
export type Pairing = { vmk: Uint8Array; epoch: number; number: number; hash: Uint8Array; pairerId: Uint8Array };
export const packPairing = (p: Pairing) => concat(p.vmk, uint(p.epoch, 4), uint(p.number, 4), p.hash, p.pairerId);
export function unpackPairing(b: Uint8Array): Pairing {
	const r = new Reader(b);
	const p = { vmk: r.bytes(32), epoch: r.u32(), number: r.u32(), hash: r.bytes(32), pairerId: r.bytes(16) };
	r.end();
	return p;
}

// --- recovery key: 16 random bytes shown as 26 RFC 4648 base32 characters ---

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeRecoveryCode(rk: Uint8Array): string {
	let bits = "";
	for (const b of rk) bits += b.toString(2).padStart(8, "0");
	return bits.padEnd(130, "0").match(/.{5}/g)!.map((c) => B32[parseInt(c, 2)]).join("");
}

// Ignores case, spaces and dashes. Throws on anything that isn't exactly one code.
export function decodeRecoveryCode(code: string): Uint8Array {
	const s = code.toUpperCase().replace(/[\s-]/g, "");
	if (!/^[A-Z2-7]{26}$/.test(s)) throw new Error("recovery code must be 26 characters A-Z, 2-7");
	const bits = Array.from(s, (c) => B32.indexOf(c).toString(2).padStart(5, "0")).join("");
	if (bits.slice(128) !== "00") throw new Error("invalid recovery code");
	return Uint8Array.from(bits.slice(0, 128).match(/.{8}/g)!, (b) => parseInt(b, 2));
}

// The recovery private key, sealed once per recovery code (a new code always comes with a new key pair).
export async function sealRecoveryPrivate(rk: Uint8Array, vaultId: Uint8Array, kp: { d: Uint8Array; pub: Uint8Array }) {
	return seal(await hkdf(rk, vaultId, label("recovery-priv")), ZERO_NONCE, concat(kp.d, kp.pub), vaultId);
}
export async function openRecoveryPrivate(rk: Uint8Array, vaultId: Uint8Array, sealed: Uint8Array) {
	const pt = await open(await hkdf(rk, vaultId, label("recovery-priv")), ZERO_NONCE, sealed, vaultId);
	return { d: pt.slice(0, 32), pub: pt.slice(32) };
}

// --- membership records: encrypted, so the server can't read the member list ---

export type Member = { id: Uint8Array; pub: Uint8Array; pairedAt: number; pairedBy: Uint8Array };
export type MemberRecord = {
	vaultId: Uint8Array;
	number: number;
	epoch: number;
	prevHash: Uint8Array; // 32 zero bytes for the first record
	senderId: Uint8Array;
	members: Member[];
	removed: Uint8Array[];
	recoveryPub?: Uint8Array;
	prevVmkSealed?: Uint8Array; // present only on rotation records
};

const optional = (b?: Uint8Array) => (b ? concat(uint(b.length, 2), b) : uint(0, 2));

// A rotation record is sealed under the old epoch's member key, so the device it removes can still read it.
const sealingEpoch = (r: { epoch: number; prevVmkSealed?: Uint8Array }) => (r.prevVmkSealed ? r.epoch - 1 : r.epoch);

// Clear header: u8 VERSION | u32 number | u32 epoch | optional prevVmkSealed (sealed under the new VMK already).
const recordHeader = (r: MemberRecord) => concat(u8(VERSION), uint(r.number, 4), uint(r.epoch, 4), optional(r.prevVmkSealed));

export async function encodeRecord(r: MemberRecord, vmkFor: (epoch: number) => Uint8Array, nonce = randomBytes(12)): Promise<Uint8Array> {
	const header = recordHeader(r);
	const body = concat(
		r.prevHash, r.senderId,
		uint(r.members.length, 2), ...r.members.flatMap((m) => [m.id, m.pub, uint(m.pairedAt, 8), m.pairedBy]),
		uint(r.removed.length, 2), ...r.removed,
		optional(r.recoveryPub),
	);
	const ct = await seal(await memberKey(vmkFor(sealingEpoch(r)), r.vaultId), nonce, body, concat(header, r.vaultId));
	return concat(header, nonce, ct);
}

// vmkFor must know the sealing epoch's VMK. A device holding only the newest VMK gets the previous one
// from the clear prevVmkSealed with openPrevVmk.
// The clear header alone: enough to pick the keys before opening the body.
export function peekRecord(bytes: Uint8Array) {
	const h = new Reader(bytes);
	if (h.u8() !== VERSION) throw new Error("unknown record version");
	const number = h.u32(), epoch = h.u32(), n = h.u16();
	return { number, epoch, prevVmkSealed: n ? h.bytes(n) : undefined, headerLength: h.i };
}

export async function decodeRecord(bytes: Uint8Array, vaultId: Uint8Array, vmkFor: (epoch: number) => Uint8Array | undefined): Promise<MemberRecord> {
	const { number, epoch, prevVmkSealed, headerLength } = peekRecord(bytes);
	const h = new Reader(bytes);
	h.bytes(headerLength);
	const header = bytes.slice(0, headerLength);
	const nonce = h.bytes(12);
	const vmk = vmkFor(sealingEpoch({ epoch, prevVmkSealed }));
	if (!vmk) throw new Error(`no key for epoch ${sealingEpoch({ epoch, prevVmkSealed })}`);
	const body = await open(await memberKey(vmk, vaultId), nonce, bytes.slice(h.i), concat(header, vaultId));
	const r = new Reader(body);
	const rec: MemberRecord = {
		vaultId, number, epoch, prevHash: r.bytes(32), senderId: r.bytes(16),
		members: Array.from({ length: r.u16() }, () => ({ id: r.bytes(16), pub: r.bytes(65), pairedAt: r.u64(), pairedBy: r.bytes(16) })),
		removed: Array.from({ length: r.u16() }, () => r.bytes(16)),
	};
	const len = r.u16();
	if (len) rec.recoveryPub = r.bytes(len);
	if (prevVmkSealed) rec.prevVmkSealed = prevVmkSealed;
	r.end();
	return rec;
}

export const recordHash = sha256;

// --- stored records: what the server keeps per record number, opaque to it ---
// u32 recordLength | record | u16 n | n × (recipientId(16) | wrap(113)) | if n > 0: senderId(16) | senderPub(65)
// The sender is in clear only so a recovering device, which can't open the record yet, can open its wrap.
// Every other device takes the sender's key from the member list, never from here.

export type Stored = { record: Uint8Array; wraps: { recipientId: Uint8Array; wrapped: Uint8Array }[]; sender?: Party };
const WRAP_LEN = 65 + 32 + 16;

export function packStored(s: Stored): Uint8Array {
	const sender = s.wraps.length ? [s.sender!.id, s.sender!.pub] : [];
	return concat(uint(s.record.length, 4), s.record, uint(s.wraps.length, 2), ...s.wraps.flatMap((w) => [w.recipientId, w.wrapped]), ...sender);
}

export function unpackStored(b: Uint8Array): Stored {
	const r = new Reader(b);
	const record = r.bytes(r.u32());
	const wraps = Array.from({ length: r.u16() }, () => ({ recipientId: r.bytes(16), wrapped: r.bytes(WRAP_LEN) }));
	const sender = wraps.length ? { id: r.bytes(16), pub: r.bytes(65) } : undefined;
	r.end();
	return { record, wraps, sender };
}
