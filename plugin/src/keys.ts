// The vault's keys and its membership log (docs/PROTOCOL.md "Membership log", "Rotation wraps", "Recovery
// key"): which devices are in the vault, the current epoch, and the key ring. It knows nothing about Obsidian
// or the network: the transport hands it the records the Worker holds and sends the one it wants added.
//
// How a device gets into the log: it adds itself. A newly paired device holds the VMK and the pairing
// device's newest record (from the pairing code), so it appends a record adding only itself, naming the
// pairing device in `pairedBy`. Anyone holding the VMK could write that record anyway, so this grants nothing
// new; the rules below just keep such a record from doing anything but add its sender.

import * as P from "../../protocol/ownsync";

const { hex } = P;
const same = (a?: Uint8Array, b?: Uint8Array) => (a && b ? hex(a) === hex(b) : a === b);
const RECOVERY = hex(P.RECOVERY_ID);
/** How long after this device showed a pairing code a record naming it as the pairer is expected. */
const PAIRING_WINDOW_MS = 10 * 60 * 1000;

export const shortId = (id: Uint8Array) => (hex(id) === RECOVERY ? "the recovery key" : hex(id).slice(0, 8).toUpperCase());
/** The ID the protocol uses for a vault, from the vault ID in the settings. The Worker files the vault under it. */
export const vaultIdOf = async (setting: string) => (await P.sha256(new TextEncoder().encode(setting))).slice(0, 16);

/** This device, in one vault. The private key can't be exported, only used; IndexedDB keeps it as it is. */
export interface Identity { id: Uint8Array; pub: Uint8Array; priv: CryptoKey }
export interface Head { number: number; epoch: number; hash: Uint8Array; members: P.Member[]; recoveryPub?: Uint8Array }
/** A record this device wants the Worker to add. A rotation also carries the new auth token's hash. */
export interface Pending { number: number; hash: Uint8Array; blob: Uint8Array; recovery: Uint8Array; tokenHash?: Uint8Array }
/** One of two valid records that both follow the head. */
export interface Candidate { number: number; blob: Uint8Array; senderId: Uint8Array; added: Uint8Array[]; removed: Uint8Array[] }
export type Stored = { number: number; blob: Uint8Array };

/** Everything but the key ring. */
export interface KeyState {
	me: Identity;
	head?: Head;
	/** A newly paired device, not in the log yet: the pairing device's newest record, and that device's ID. */
	pin?: { number: number; hash: Uint8Array; pairedBy: Uint8Array };
	seen: Record<number, string>; // hash of each record accepted, to spot a competitor behind the head
	mine: string[]; // hashes of the records this device wrote
	alerted: string[];
	pending?: Pending;
	/**
	 * A recovery key to put in place once the removal waiting in `pending` has landed. Not in the same record: that
	 * is sealed under the old epoch, which the removed device can read. (The code itself is never stored.)
	 */
	nextRecovery?: { pub: Uint8Array; sealed: Uint8Array };
	removed?: string; // why this device is no longer in the vault
	fork?: Candidate[];
	resnapshot?: boolean; // a new epoch was accepted, and this device hasn't sent its documents under it yet
}

export interface KeyPorts {
	load(): Promise<KeyState | undefined>;
	save(state: KeyState): Promise<void>;
	/** The key ring as JSON, `{ "<epoch>": "<hex VMK>" }`. Secret. */
	loadRing(): string | null;
	saveRing(ring: string): void;
}

export interface KeyOptions {
	/** Something the user must see: a removal, a record naming this device falsely, a competing record. */
	onAlert?(message: string): void;
	onProblem?(what: string, err: unknown): void;
}

export async function newIdentity(): Promise<Identity> {
	const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
	return { id: P.randomBytes(16), pub: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)), priv: kp.privateKey };
}

/** A new recovery key: the code the user keeps, the public key every rotation wraps to, the private key sealed under the code. */
export async function newRecovery(vaultId: Uint8Array) {
	const rk = P.randomBytes(16), kp = await P.generateKeyPair();
	return { code: P.encodeRecoveryCode(rk), pub: kp.pub, sealed: await P.sealRecoveryPrivate(rk, vaultId, kp) };
}
export type Recovery = Awaited<ReturnType<typeof newRecovery>>;

type Got = { number: number; blob: Uint8Array; stored: P.Stored; hash: Uint8Array };
type Checked = { g: Got; rec: P.MemberRecord; vmk?: Uint8Array };
type Signer = P.Party & { priv: CryptoKey };

export class VaultKeys {
	private codes: number[] = []; // when this device showed pairing codes

	private constructor(readonly vaultId: Uint8Array, private ring: Map<number, Uint8Array>, private s: KeyState, private readonly ports: KeyPorts, private readonly opts: KeyOptions) {}

	/** This device's keys for a vault it is already in (or was in before the membership log existed). */
	static async open(vaultIdSetting: string, ports: KeyPorts, opts: KeyOptions = {}): Promise<VaultKeys> {
		const ring = new Map<number, Uint8Array>();
		for (const [e, k] of Object.entries(JSON.parse(ports.loadRing() ?? "{}") as Record<string, string>)) {
			if (!/^[0-9a-f]{64}$/.test(k)) throw new Error("the stored vault key is damaged");
			ring.set(Number(e), P.unhex(k));
		}
		if (!ring.size) throw new Error("this device has no key for the vault");
		const state = await ports.load();
		if (state) return new VaultKeys(await vaultIdOf(vaultIdSetting), ring, state, ports, opts);
		return VaultKeys.fresh(vaultIdSetting, ports, opts, ring);
	}

	/** A new start in a vault (creating, pairing, recovering): a new device identity, and whatever keys the start brings. */
	static async fresh(vaultIdSetting: string, ports: KeyPorts, opts: KeyOptions, ring: Map<number, Uint8Array>, pin?: KeyState["pin"]): Promise<VaultKeys> {
		const keys = new VaultKeys(await vaultIdOf(vaultIdSetting), ring, { me: await newIdentity(), pin, seen: {}, mine: [], alerted: [] }, ports, opts);
		if (ring.size) keys.saveRing();
		await keys.save();
		return keys;
	}

	get state(): Readonly<KeyState> { return this.s; }
	get me(): Identity { return this.s.me; }
	/** The newest epoch this device holds the key of. */
	get epoch(): number { return Math.max(...this.ring.keys()); }
	get vmk(): Uint8Array { return this.ring.get(this.epoch)!; }
	/**
	 * Any epoch this device holds. Note updates of an older epoch are refused before this is asked (transport.ts,
	 * PROTOCOL.md "After a rotation"); attachment chunks keep the epoch they were uploaded in, and need the old key.
	 */
	keyFor = (epoch: number) => this.ring.get(epoch);
	/** This device joined after a rotation and lacks older keys (needed for attachments uploaded before then). */
	get missingOlder(): boolean { return Math.min(...this.ring.keys()) > 0; }

	/**
	 * Fill in older keys from rotation records: each carries the previous epoch's key sealed under its own, in the
	 * record's clear header. Sealed with the newer key, so the Worker can't make one up; at worst it withholds them.
	 */
	async learnOlder(records: Stored[]): Promise<void> {
		const sealed = new Map<number, Uint8Array>();
		for (const g of await parse(records)) {
			const { epoch, prevVmkSealed } = P.peekRecord(g.stored.record);
			if (prevVmkSealed) sealed.set(epoch, prevVmkSealed);
		}
		let learned = false;
		for (let e = Math.min(...this.ring.keys()); e > 0 && sealed.has(e); e--) {
			const prev = await P.openPrevVmk(this.ring.get(e)!, this.vaultId, e, sealed.get(e)!).catch(() => undefined);
			if (!prev) break;
			this.ring.set(e - 1, prev);
			learned = true;
		}
		if (learned) this.saveRing();
	}
	token(): Promise<Uint8Array> { return P.authToken(this.vmk, this.vaultId); }
	/** The first record number to ask the Worker for: the head again, to notice if the server's copy changed. */
	fetchFrom(): number { return this.s.head?.number ?? this.s.pin?.number ?? 0; }

	/** Takes in records from the Worker and accepts every one that follows the head by the rules. */
	async receive(records: Stored[]): Promise<void> {
		const got = await parse(records);
		try {
			if (!this.s.head) await this.anchor(got);
			await this.advance(got, records);
			const s = this.s;
			if (s.head && !s.removed && !s.fork && !s.pending && !s.head.members.some((m) => same(m.id, s.me.id))) await this.enroll();
		} catch (err) {
			this.opts.onProblem?.("reading the vault's device list", err);
		}
		await this.save();
	}

	/** After a fork: the user's choice. That record is accepted if it still passes the rules. */
	async choose(candidate: Candidate): Promise<void> {
		this.s.fork = undefined;
		await this.receive([candidate]);
	}

	/** This device has sent all its documents under the current epoch. */
	async snapshotted(): Promise<void> {
		this.s.resnapshot = false;
		await this.save();
	}

	/**
	 * What the pairing code hands a new device. Null until this device is in the log. A `renewal` (the same pairing
	 * screen showing a fresh code) vouches for no more joins than the first code did.
	 */
	pairingPayload(renewal = false): Uint8Array | null {
		const h = this.s.head;
		// Not while a key change is waiting either: the new device would get a key about to be replaced.
		if (!h || this.s.removed || this.s.fork || this.s.pending || !h.members.some((m) => same(m.id, this.s.me.id))) return null;
		if (renewal && this.codes.length) this.codes[this.codes.length - 1] = Date.now();
		else this.codes.push(Date.now());
		return P.packPairing({ vmk: this.ring.get(h.epoch)!, epoch: h.epoch, number: h.number, hash: h.hash, pairerId: this.s.me.id });
	}

	/** The first record of a new vault, listing only this device, with the recovery key if the user set one up. */
	genesis(recovery?: Recovery): Promise<void> {
		const me = this.s.me;
		return this.queue({ epoch: 0, senderId: me.id, members: [this.self(me.id)], removed: [], recoveryPub: recovery?.pub }, recovery && { vmk: this.vmk, sender: me }, recovery?.sealed);
	}

	/**
	 * Removes a device: a new epoch whose key goes to every other device. A new recovery key, if given, follows in
	 * a second rotation once this one has landed, under a key the removed device doesn't have.
	 */
	async remove(id: Uint8Array, recovery?: Pick<Recovery, "pub" | "sealed">): Promise<void> {
		const h = this.ready();
		if (same(id, this.s.me.id) || !h.members.some((m) => same(m.id, id))) throw new Error("not a device that can be removed");
		if (recovery) this.s.nextRecovery = { pub: recovery.pub, sealed: recovery.sealed };
		await this.rotate(h.members.filter((m) => !same(m.id, id)), [id], this.s.me);
	}

	/** Sets up or replaces the recovery key. It rotates the epoch, so the old recovery key opens nothing new. */
	replaceRecovery(recovery: Pick<Recovery, "pub" | "sealed">): Promise<void> {
		return this.rotate(this.ready().members, [], this.s.me, recovery);
	}

	/**
	 * Recovery on a new device that has no keys yet: open the newest VMK wrapped to the recovery key, then
	 * rotate as the recovery key, enrolling this device, removing every other one (they may be lost or stolen,
	 * and they know the old recovery key), and replacing the recovery key with `next`.
	 */
	async recover(code: string, sealed: Uint8Array, records: Stored[], next: Recovery): Promise<void> {
		const kp = await P.openRecoveryPrivate(P.decodeRecoveryCode(code), this.vaultId, sealed).catch(() => {
			throw new Error("this recovery code doesn't open the vault's recovery key");
		});
		const rk: Signer = { id: P.RECOVERY_ID, pub: kp.pub, priv: await P.importPrivate(kp.d, kp.pub) };
		const got = await parse(records);
		const g = got.sort((a, b) => b.number - a.number).find((g) => g.stored.wraps.some((w) => same(w.recipientId, P.RECOVERY_ID)));
		if (!g) throw new Error("the Worker holds no key for the recovery key");
		const { epoch, prevVmkSealed } = P.peekRecord(g.stored.record);
		const sender = g.stored.sender!;
		const wrapped = g.stored.wraps.find((w) => same(w.recipientId, P.RECOVERY_ID))!.wrapped;
		const vmk = await P.unwrapVmk({ wrapped, vaultId: this.vaultId, epoch, recordHash: g.hash, sender, recipient: rk });
		this.ring.set(epoch, vmk);
		if (prevVmkSealed) this.ring.set(epoch - 1, await P.openPrevVmk(vmk, this.vaultId, epoch, prevVmkSealed));
		const rec = await P.decodeRecord(g.stored.record, this.vaultId, (e) => this.ring.get(e));
		// A recovering device can't check the chain behind this record; it can check the record agrees with its wrap.
		const member = rec.members.find((m) => same(m.id, rec.senderId));
		if (!same(rec.recoveryPub, kp.pub) || !same(rec.senderId, sender.id) || (hex(sender.id) !== RECOVERY && !same(member?.pub, sender.pub))) throw new Error("the recovery key's record doesn't add up");
		this.saveRing();
		this.setHead(rec, g.hash);
		await this.advance(got);
		const h = this.s.head!;
		if (this.s.fork) throw new Error("the Worker holds two competing device lists; recover again later");
		await this.rotate([this.self(P.RECOVERY_ID)], h.members.map((m) => m.id), rk, next);
	}

	// --- the log ---

	// The first record this device trusts without checking it against an earlier one: the pairing device's
	// newest record (from the pairing code), or else record 0 (a vault this device created, or one set up
	// before the log existed). An empty log gets a first record from this device.
	private async anchor(got: Got[]): Promise<void> {
		const pin = this.s.pin;
		const g = got.find((g) => g.number === (pin?.number ?? 0) && (!pin || same(g.hash, pin.hash)));
		if (!g) {
			if (!pin && !this.s.pending && !got.length) await this.genesis();
			return;
		}
		const { epoch, prevVmkSealed } = P.peekRecord(g.stored.record);
		const vmk = this.ring.get(epoch);
		if (!vmk) throw new Error(`no key for epoch ${epoch}`);
		if (prevVmkSealed) this.ring.set(epoch - 1, await P.openPrevVmk(vmk, this.vaultId, epoch, prevVmkSealed));
		const rec = await P.decodeRecord(g.stored.record, this.vaultId, (e) => this.ring.get(e));
		if (!pin && (rec.epoch !== 0 || !same(rec.prevHash, new Uint8Array(32)))) throw new Error("record 0 isn't a first record");
		this.saveRing();
		this.setHead(rec, g.hash);
	}

	private async advance(got: Got[], raw: Stored[] = []): Promise<void> {
		const s = this.s;
		while (s.head && !s.removed && !s.fork) {
			const h = s.head, valid: Checked[] = [];
			for (const g of got.filter((g) => g.number === h.number + 1)) {
				if (valid.some((v) => same(v.g.hash, g.hash))) continue;
				try {
					valid.push(await this.check(g, h));
				} catch (err) {
					this.opts.onProblem?.(`refused membership record ${g.number}`, err);
				}
			}
			if (!valid.length) {
				// Something sits at the next number, valid or not even a record: nothing can be added after it.
				const bad = raw.find((r) => r.number === h.number + 1);
				if (bad) await this.blocked(bad);
				break;
			}
			if (valid.length === 1) {
				await this.accept(valid[0]!);
				continue;
			}
			// No automatic tie-break: a stolen device not removed yet looks exactly like the user's own.
			s.fork = valid.map(({ g, rec }) => ({
				number: g.number, blob: g.blob, senderId: rec.senderId, removed: rec.removed,
				added: rec.members.filter((m) => !h.members.some((x) => same(x.id, m.id))).map((m) => m.id),
			}));
			this.alert(`Two devices changed the device list at the same moment (record ${h.number + 1}). Sync is paused on this device until you choose which change to keep.`);
		}
		await this.competitors(got);
	}

	// PROTOCOL.md "Accepting a record". Throws why a record that claims to follow the head doesn't.
	private async check(g: Got, h: Head): Promise<Checked> {
		const rec = await P.decodeRecord(g.stored.record, this.vaultId, (e) => this.ring.get(e));
		if (!same(rec.prevHash, h.hash)) throw new Error("it doesn't follow this device's newest record");
		const rotation = !!rec.prevVmkSealed;
		if (rec.epoch !== h.epoch + (rotation ? 1 : 0)) throw new Error("wrong epoch");
		const before = new Map(h.members.map((m) => [hex(m.id), m]));
		const ids = new Set(rec.members.map((m) => hex(m.id)));
		if (ids.size !== rec.members.length || ids.has(RECOVERY)) throw new Error("bad member list");
		// An existing member's entry stays as it was: its key, and who paired it when (else "paired by" could be relabelled).
		if (rec.members.some((m) => { const was = before.get(hex(m.id)); return was && (!same(was.pub, m.pub) || !same(was.pairedBy, m.pairedBy) || was.pairedAt !== m.pairedAt); })) throw new Error("it changes an existing device's entry");
		const added = rec.members.filter((m) => !before.has(hex(m.id)));
		const left = h.members.filter((m) => !ids.has(hex(m.id)));
		if (left.map((m) => hex(m.id)).sort().join() !== rec.removed.map(hex).sort().join()) throw new Error("its removed list doesn't match its member list");
		const sender = hex(rec.senderId);
		let senderPub = sender === RECOVERY ? h.recoveryPub : ids.has(sender) ? before.get(sender)?.pub : undefined;
		if (!rotation) {
			// A record in the same epoch adds one device and changes nothing else. The device it adds may write it.
			if (added.length !== 1 || left.length || !same(rec.recoveryPub, h.recoveryPub)) throw new Error("a record within an epoch may only add one device");
			if (!senderPub && sender === hex(added[0]!.id)) senderPub = added[0]!.pub;
			if (!senderPub) throw new Error("its sender isn't a member");
			return { g, rec };
		}
		if (!senderPub) throw new Error("its sender isn't a member");
		if (added.length > (sender === RECOVERY ? 1 : 0)) throw new Error("only a recovery adds a device in a rotation");
		if (!ids.has(hex(this.s.me.id))) return { g, rec }; // it removes this device: there is no key for it
		const wrap = g.stored.wraps.find((w) => same(w.recipientId, this.s.me.id));
		if (!wrap) throw new Error("it holds no key for this device");
		// The sender's key comes from the member list, never from the record's clear part.
		const vmk = await P.unwrapVmk({ wrapped: wrap.wrapped, vaultId: this.vaultId, epoch: rec.epoch, recordHash: g.hash, sender: { id: rec.senderId, pub: senderPub }, recipient: this.s.me });
		if (!same(await P.openPrevVmk(vmk, this.vaultId, rec.epoch, rec.prevVmkSealed!), this.ring.get(h.epoch))) throw new Error("its key ring doesn't match");
		return { g, rec, vmk };
	}

	private async accept({ g, rec, vmk }: Checked): Promise<void> {
		const s = this.s, me = s.me.id, h = s.head!;
		if (vmk) {
			this.ring.set(rec.epoch, vmk);
			this.saveRing();
			s.resnapshot = true;
		}
		// Claims about yourself: only this device knows they're false.
		if (same(rec.senderId, me) && !s.mine.includes(hex(g.hash))) {
			this.alert(`Membership record ${rec.number} says this device wrote it, but it didn't: another device holding the vault key did. Check the device list and remove any device you don't recognise.`);
		}
		for (const m of rec.members) {
			if (h.members.some((x) => same(x.id, m.id)) || !same(m.pairedBy, me) || same(rec.senderId, me)) continue;
			this.codes = this.codes.filter((t) => t > Date.now() - PAIRING_WINDOW_MS);
			if (this.codes.shift() === undefined) this.alert(`Device ${shortId(m.id)} joined the vault saying this device paired it, but this device hasn't shown a pairing code recently. If you didn't pair it, remove it.`);
		}
		this.setHead(rec, g.hash);
		// This device's own removal has landed: now the recovery key it asked for, under the new epoch.
		if (s.nextRecovery && s.mine.includes(hex(g.hash)) && rec.removed.length && !s.pending) {
			const next = s.nextRecovery;
			s.nextRecovery = undefined;
			await this.replaceRecovery(next);
		}
		if (h.members.some((m) => same(m.id, me)) && !rec.members.some((m) => same(m.id, me))) {
			s.removed = `This device was removed from the vault by ${shortId(rec.senderId)}. Its notes stay here, but no longer sync.`;
			this.alert(s.removed);
		}
	}

	private setHead(rec: P.MemberRecord, hash: Uint8Array): void {
		const s = this.s;
		s.head = { number: rec.number, epoch: rec.epoch, hash, members: rec.members, recoveryPub: rec.recoveryPub };
		s.seen[rec.number] = hex(hash);
		if (s.pending && s.pending.number <= rec.number) {
			if (s.pending.tokenHash && !same(s.pending.hash, hash)) {
				s.nextRecovery = undefined; // it followed the change that wasn't made
				this.alert("Another device changed the device list first, so this device's change wasn't made. Try it again.");
			}
			s.pending = undefined;
		}
	}

	// A valid record competing with one this device already accepted doesn't stop it: otherwise a removed device
	// still holding an old key could stop every device, with the server's help. The user hears of it once.
	private async competitors(got: Got[]): Promise<void> {
		const s = this.s;
		for (const g of got) {
			const seen = s.seen[g.number];
			if (!s.head || g.number > s.head.number || seen === undefined || seen === hex(g.hash) || s.alerted.includes(hex(g.hash))) continue;
			try {
				await P.decodeRecord(g.stored.record, this.vaultId, (e) => this.ring.get(e));
			} catch {
				continue; // not written with a vault key: noise
			}
			s.alerted.push(hex(g.hash));
			this.alert(`The Worker also holds a different membership record ${g.number}, competing with one this device already accepted. It was ignored. Unless two devices changed the device list at the same moment, a removed device or the server is interfering.`);
		}
	}

	// --- writing records ---

	private self(pairedBy: Uint8Array): P.Member {
		return { id: this.s.me.id, pub: this.s.me.pub, pairedAt: Date.now(), pairedBy };
	}

	private ready(): Head {
		const s = this.s;
		if (!s.head || s.pending || s.fork || s.removed) throw new Error("the device list is busy or not loaded yet; try again once Ownsync shows synced");
		return s.head;
	}

	// A device holding the VMK but missing from the member list adds itself.
	private enroll(): Promise<void> {
		const h = this.s.head!;
		return this.queue({ epoch: h.epoch, senderId: this.s.me.id, members: [...h.members, this.self(this.s.pin?.pairedBy ?? this.s.me.id)], removed: [], recoveryPub: h.recoveryPub });
	}

	private async rotate(members: P.Member[], removed: Uint8Array[], sender: Signer, recovery?: Pick<Recovery, "pub" | "sealed">): Promise<void> {
		const h = this.s.head!, vmk = P.randomBytes(32), epoch = h.epoch + 1;
		const prevVmkSealed = await P.sealPrevVmk(vmk, this.vaultId, epoch, this.ring.get(h.epoch)!);
		const tokenHash = await P.sha256(await P.authToken(vmk, this.vaultId));
		await this.queue({ epoch, senderId: sender.id, members, removed, recoveryPub: recovery?.pub ?? h.recoveryPub, prevVmkSealed }, { vmk, sender }, recovery?.sealed, tokenHash);
	}

	// The record after the head, with the VMK wrapped to every member (this device too, so a crash before the
	// Worker answers loses nothing) and to the recovery key.
	private async queue(r: Omit<P.MemberRecord, "vaultId" | "number" | "prevHash">, wrap?: { vmk: Uint8Array; sender: Signer }, recovery = new Uint8Array(0), tokenHash?: Uint8Array): Promise<void> {
		const h = this.s.head;
		const rec: P.MemberRecord = { ...r, vaultId: this.vaultId, number: h ? h.number + 1 : 0, prevHash: h?.hash ?? new Uint8Array(32) };
		const record = await P.encodeRecord(rec, (e) => this.ring.get(e)!);
		const hash = await P.recordHash(record);
		const to: P.Party[] = [...rec.members, ...(rec.recoveryPub ? [{ id: P.RECOVERY_ID, pub: rec.recoveryPub }] : [])];
		const wraps = wrap ? await Promise.all(to.map(async (m) => ({
			recipientId: m.id,
			wrapped: await P.wrapVmk({ vmk: wrap.vmk, vaultId: this.vaultId, epoch: rec.epoch, recordHash: hash, sender: wrap.sender, recipient: m }),
		}))) : [];
		this.s.mine.push(hex(hash));
		this.s.pending = { number: rec.number, hash, blob: P.packStored({ record, wraps, sender: wrap?.sender }), recovery, tokenHash };
		await this.save();
	}

	/**
	 * The Worker holds, after the head, a record no device should have written: only someone with the vault key
	 * could (a stolen device not removed yet, or a stolen pairing code). Nothing can be added after it, so a
	 * removal or recovery-key change waiting here would never land; it is dropped rather than shown as done.
	 */
	private async blocked(bad: Stored): Promise<void> {
		const key = `blocked:${hex(await P.sha256(bad.blob))}`;
		if (this.s.alerted.includes(key)) return;
		this.s.alerted.push(key);
		this.s.pending = undefined;
		this.s.nextRecovery = undefined;
		await this.save();
		this.alert("The device list on your Worker has a change this device can't accept, so devices can't be added or removed any more. Only someone holding the vault key could have made it. Your notes are safe on your devices: to be sure, start a new vault from a device you trust (Settings → Ownsync → Leave this vault, then Create) and pair your other devices again.");
	}

	private alert(message: string): void {
		this.opts.onAlert?.(message);
	}

	private saveRing(): void {
		this.ports.saveRing(JSON.stringify(Object.fromEntries([...this.ring].map(([e, k]) => [e, hex(k)]))));
	}

	private save(): Promise<void> {
		return this.ports.save(this.s);
	}
}

async function parse(records: Stored[]): Promise<Got[]> {
	const got: Got[] = [];
	for (const r of records) {
		try {
			const stored = P.unpackStored(r.blob);
			if (P.peekRecord(stored.record).number === r.number) got.push({ number: r.number, blob: r.blob, stored, hash: await P.recordHash(stored.record) });
		} catch {
			// not a record: whatever the server sent, it can't be accepted
		}
	}
	return got;
}
