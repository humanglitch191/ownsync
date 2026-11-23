// Pairing a new device: the existing device seals the vault key, with its newest membership record's hash and
// its own ID, under a one-time 16-byte code, leaves it in the Worker's single-use mailbox (2 minutes), and shows
// a QR code / link with the server, vault ID and code. While the screen stays open and visible (10 minutes at
// most), a fresh code replaces each one as it runs out. The link never contains the vault key; the Worker never
// sees the code. The new device then adds itself to the membership log (keys.ts).

import { type App, Modal, Setting, requestUrl } from "obsidian";
import { say } from "./notice";
import * as QRCode from "qrcode";
import { hex, openFromPairing, pairingRoom, randomBytes, sealForPairing, unhex, unpackPairing } from "../../protocol/ownsync";
import type { VaultKeys } from "./keys";
import { shortId } from "./keys";
import { parsePairLink, trimHost } from "./links";

export interface PairingHost {
	app: App;
	settings: { host: string; vaultId: string };
	session: { keys: VaultKeys } | null;
	hasKey(): boolean;
	setUp(host: string, vaultId: string, ring: Map<number, Uint8Array>, init?: (keys: VaultKeys) => Promise<void>, pin?: VaultKeys["state"]["pin"]): Promise<void>;
	createVault(host: string, ownerCode: string): Promise<void>;
	/** Whether this device syncs attachments too, or notes only. */
	attachments: boolean;
	setAttachments(on: boolean): Promise<void>;
	/** This device's name, given while pairing. */
	deviceName: string;
	setDeviceName(name: string): Promise<void>;
	/** Names the devices gave themselves, by short ID, as the Worker last reported them. */
	deviceNames: Map<string, string>;
	refreshNames(): Promise<boolean>;
}

// A phone's camera opens web links, not obsidian:// ones, so the QR code goes through the server's own
// add-device page. The pairing code stays in the part after "#", which the browser never sends to a server.
const pairPage = (link: string) => {
	const p = new URL(link).searchParams;
	return `${p.get("host")}/add-device/#${new URLSearchParams({ vaultId: p.get("vaultId")!, code: p.get("code")! })}`;
};
const toArrayBuffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export async function createPairingLink(host: PairingHost, renewal = false): Promise<string | null> {
	const server = trimHost(host.settings.host);
	const payload = host.session?.keys.pairingPayload(renewal);
	if (!server || !payload) return null;
	const code = randomBytes(16);
	const res = await requestUrl({
		url: `${server}/pair/${await pairingRoom(code)}`,
		method: "PUT",
		body: toArrayBuffer(await sealForPairing(code, payload)),
		throw: false,
	});
	if (res.status !== 204) throw new Error(`pairing upload failed (${res.status})`);
	return `obsidian://ownsync-pair?${new URLSearchParams({ host: server, vaultId: host.settings.vaultId, code: hex(code) })}`;
}

export async function showPairingCode(host: PairingHost): Promise<void> {
	try {
		const link = await createPairingLink(host);
		if (!link) return void say("Wait until Ownsync shows synced, then try again.", 7000);
		new PairDeviceModal(host, link).open();
	} catch (err) {
		say(`Could not start pairing: ${String(err)}`, 8000);
	}
}

// New device. Any web page can open an obsidian:// link, so nothing changes without the user's confirmation.
export async function handlePairLink(host: PairingHost, params: Record<string, string>): Promise<boolean> {
	const link = parsePairLink(params);
	if (!link) {
		say("This pairing link is incomplete or uses an insecure Worker address. Show a new code on your other device.", 8000);
		return false;
	}
	const { host: server, vaultId, code: codeHex } = link;
	// A device that already syncs takes no pairing link, not even one for its own vault: a link from anywhere could
	// otherwise replace its keys with ones someone else holds. To pair it again, leave the vault first.
	if (host.hasKey()) {
		say("This device already syncs a vault, so the pairing link was ignored. To pair it again, use Settings → Ownsync → Leave this vault first.", 12000);
		return false;
	}
	let attachments = host.attachments, name = "";
	const ok = await confirm(host.app, "Pair this device?", (el) => {
		el.createEl("p", { cls: "ownsync-server", text: `Worker: ${server}` });
		el.createEl("p", { cls: "ownsync-lead", text: "This vault's notes will be encrypted and synced through that Worker. Only continue if you got this code just now, from your own device or from the person whose vault this is." });
		new Setting(el)
			.setName("Device name")
			.setDesc("How your other devices show this one. For example: Anna's iPhone 17 Pro.")
			.addText((t) => t.setPlaceholder(host.deviceName).onChange((v) => (name = v)));
		attachmentsToggle(el, attachments, (on) => (attachments = on));
	});
	if (!ok) {
		say("Pairing cancelled. Nothing changed.", 6000);
		return false;
	}

	const code = unhex(codeHex);
	const res = await requestUrl({ url: `${server}/pair/${await pairingRoom(code)}`, method: "GET", throw: false });
	if (res.status === 410) {
		say("Someone else already used this pairing code, so they may hold the vault key. On a device that syncs, open Settings → Ownsync → Recovery key and press Replace (or Set up): the vault then gets a new key they don't have.", 20000);
		return false;
	}
	if (res.status !== 200) {
		say("This pairing code has run out. Scan the code now shown on your other device (it shows a fresh one every 2 minutes).", 10000);
		return false;
	}
	let p: ReturnType<typeof unpackPairing>;
	try {
		p = unpackPairing(await openFromPairing(code, new Uint8Array(res.arrayBuffer)));
	} catch {
		say("Pairing failed: the Worker returned something this code can't open. Both devices need the same Ownsync version.", 8000);
		return false;
	}
	await host.setAttachments(attachments);
	if (name.trim()) await host.setDeviceName(name);
	await host.setUp(server, vaultId, new Map([[p.epoch, p.vmk]]), undefined, { number: p.number, hash: p.hash, pairedBy: p.pairerId });
	const me = host.session?.keys.me.id;
	say(`Paired and syncing.${me ? ` This device's ID is ${shortId(me)}: check that your other device shows the same.` : ""}`, 15000);
	return true;
}

/** "Sync attachments too": asked whenever a device starts syncing a vault, and changeable in Settings later. */
export function attachmentsToggle(el: HTMLElement, on: boolean, set: (on: boolean) => void): void {
	new Setting(el)
		.setName("Sync attachments too")
		.setDesc("Images, PDFs and other files, up to 20 MB each. Off: this device syncs notes only, and leaves attachments on your other devices alone.")
		.addToggle((t) => t.setValue(on).onChange(set));
}

function confirm(app: App, title: string, body: (el: HTMLElement) => void): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let answer = false;
		modal.modalEl.addClass("ownsync-setup");
		modal.titleEl.setText(title);
		body(modal.contentEl);
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
		buttons.createEl("button", { text: "Pair", cls: "mod-cta" }).addEventListener("click", () => { answer = true; modal.close(); });
		modal.onClose = () => resolve(answer);
		modal.open();
	});
}

const CODE_MS = 2 * 60 * 1000, SCREEN_MS = 10 * 60 * 1000;
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

// Shows the one-time link as a QR code (scan with the phone's camera) and as text (for a computer). Each code
// is replaced only once it has run out, so one is ever live; the screen stops after 10 minutes, or as soon as
// it's hidden, and says which device joined so the user can check it on that device.
class PairDeviceModal extends Modal {
	private timer: number | null = null;
	private readonly opened = Date.now();
	private expires = Date.now() + CODE_MS;
	private readonly known: Set<string>;

	constructor(private readonly host: PairingHost, private link: string) {
		super(host.app);
		this.known = new Set(this.members());
		this.modalEl.addClass("ownsync-setup");
	}

	private members(): string[] {
		return (this.host.session?.keys.state.head?.members ?? []).map((m) => hex(m.id));
	}

	onOpen(): void {
		this.titleEl.setText("Add a device");
		this.showCode();
		this.timer = window.setInterval(() => void this.tick(), 1000);
	}

	onClose(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.contentEl.empty();
	}

	private showCode(): void {
		const el = this.contentEl;
		el.empty();
		el.createEl("p", { cls: "ownsync-lead", text: "Scan this code with the new device's camera, or copy the link and open it there." });
		const qr = el.createDiv({ cls: "ownsync-qr" });
		const canvas = qr.createEl("canvas");
		canvas.setAttr("aria-label", "One-time pairing code");
		void QRCode.toCanvas(canvas, pairPage(this.link), { width: 220, margin: 2 }).catch(() => canvas.replaceWith(createEl("p", { text: "Could not draw the QR code; use the link instead." })));
		const copy = el.createDiv({ cls: "ownsync-center" }).createEl("button", { text: "Copy link", cls: "mod-cta" });
		copy.addEventListener("click", () => {
			void navigator.clipboard.writeText(this.link).then(() => {
				copy.setText("Copied");
				window.setTimeout(() => copy.setText("Copy link"), 2000);
			}, () => say("Failed to copy the pairing link.", 6000));
		});
		el.createEl("p", { cls: "ownsync-quiet ownsync-center", attr: { "data-countdown": "" } });
		el.createEl("p", { cls: "ownsync-quiet", text: "Ownsync not on the new device yet? Scanning shows how to install it." });
		el.createEl("p", { cls: "ownsync-quiet", text: "Anyone who uses this code before your device does gets your notes. Don't share or screenshot it." });
		this.countdown();
	}

	private countdown(): void {
		this.contentEl.querySelector("[data-countdown]")?.setText(`A new code in ${clock(Math.max(0, this.expires - Date.now()))}`);
	}

	private async tick(): Promise<void> {
		const joined = this.members().find((id) => !this.known.has(id));
		if (joined) return void this.joined(joined);
		if (Date.now() < this.expires) return this.countdown();
		// Out of time, or nobody is looking: stop handing out codes until the user asks again.
		if (Date.now() - this.opened >= SCREEN_MS || document.visibilityState !== "visible") return this.stopped();
		this.expires = Infinity; // one renewal at a time
		try {
			const link = await createPairingLink(this.host, true);
			if (!link) return this.stopped();
			this.link = link;
			this.expires = Date.now() + CODE_MS;
			this.showCode();
		} catch {
			this.stopped();
		}
	}

	private stopped(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		const el = this.contentEl;
		el.empty();
		el.createEl("p", { cls: "ownsync-lead", text: "The code ran out. Show a new one when the other device is ready." });
		const buttons = el.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "Show a new code", cls: "mod-cta" }).addEventListener("click", () => {
			this.close();
			void showPairingCode(this.host);
		});
	}

	private async joined(id: string): Promise<void> {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		const el = this.contentEl, short = shortId(unhex(id));
		el.empty();
		this.titleEl.setText("A new device joined");
		el.createEl("p", { cls: "ownsync-lead", text: "Check that it shows the same ID:" });
		el.createDiv({ cls: "ownsync-id", text: short });
		el.createEl("p", { cls: "ownsync-quiet", text: "If it doesn't match, someone else used the code: remove that device in Settings → Ownsync → Devices." });
		const buttons = el.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Done", cls: "mod-cta" }).addEventListener("click", () => this.close());
		// The new device reports its name once it syncs, a moment after it joins: ask the Worker a few times.
		for (let i = 0; i < 6 && this.containerEl.isConnected; i++) {
			const name = this.host.deviceNames.get(short);
			if (name) return void this.titleEl.setText(`${name} joined`);
			await new Promise((r) => window.setTimeout(r, 1500));
			await this.host.refreshNames();
		}
	}
}
