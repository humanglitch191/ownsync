// The welcome screen: everything a first-time user does, in one place. A new vault connects with a one-time code
// from the server's dashboard (or "Set up another vault" on a device that syncs), which also says which server;
// any other device is paired from one that already syncs. The setup key is only ever typed on the dashboard.

import { Modal, Notice, requestUrl } from "obsidian";
import { hex } from "../../protocol/ownsync";
import { RecoverModal, type DevicesHost } from "./devices";
import { paramsOfPairLink, parseVaultCode, trimHost } from "./links";
import { type PairingHost, attachmentsToggle, handlePairLink, showPairingCode } from "./pairing";

export type SetupHost = PairingHost & DevicesHost & { status: string; leave(): Promise<void> };

type Screen = "choose" | "first" | "join" | "done";

/** A labelled text box, label above, full width: fits a phone. */
function field(el: HTMLElement, label: string, hint: string): HTMLInputElement {
	const wrap = el.createDiv({ cls: "ownsync-field" });
	const input = createEl("input", { type: "text", attr: { autocapitalize: "off", autocomplete: "off", spellcheck: "false" } });
	wrap.createEl("label", { text: label }).appendChild(input);
	if (hint) wrap.createDiv({ cls: "ownsync-quiet", text: hint });
	return input;
}

export class SetupModal extends Modal {
	private screen: Screen;

	/** `code`: a vault code from the dashboard's Open in Obsidian. Any web page can open that link, so the server it
	 * names is shown and nothing happens until the user presses Connect. */
	constructor(private readonly plugin: SetupHost, private code = "") {
		super(plugin.app);
		this.screen = code ? "first" : "choose";
		this.modalEl.addClass("ownsync-setup");
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private go(screen: Screen): void {
		this.screen = screen;
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		this.titleEl.empty();
		if (this.screen === "choose") {
			this.titleEl.setText("Set up Ownsync");
			el.createEl("p", { cls: "ownsync-lead", text: "Sync this vault between your devices. Notes are encrypted on this device before they leave it." });
			this.choice(el, "Start syncing this vault", "Your first vault, or a new one on your server.", () => this.go("first"));
			this.choice(el, "Join a vault from another device", "Get a vault you already sync, with a code from a device that syncs it.", () => this.go("join"));
			const foot = el.createEl("p", { cls: "ownsync-quiet" });
			foot.createSpan({ text: "Lost all your devices? " });
			foot.createEl("a", { text: "Recover from a recovery kit", href: "#" }).addEventListener("click", (e) => {
				e.preventDefault();
				this.close();
				new RecoverModal(this.plugin, () => {}).open();
			});
		} else if (this.screen === "first") {
			this.titleEl.setText("Connect this vault");
			const steps = el.createEl("ol", { cls: "ownsync-steps" });
			steps.createEl("li", { text: "Open your server's address in a browser and sign in." });
			steps.createEl("li", { text: "Under Connect a vault, press Open in Obsidian, or copy the code and paste it here." });
			const input = field(el, "Vault code", "The notes already in this vault are uploaded to your server, encrypted.");
			input.placeholder = "https://…#…";
			input.value = this.code;
			let attachments = this.plugin.attachments;
			attachmentsToggle(el, attachments, (on) => (attachments = on));
			const server = el.createEl("p", { cls: "ownsync-server" });
			const showServer = () => {
				const code = parseVaultCode(input.value);
				server.setText(code ? `Server: ${code.host}` : "");
				server.toggle(!!code);
			};
			input.addEventListener("input", () => { this.code = input.value; showServer(); });
			input.addEventListener("keydown", (e) => { if (e.key === "Enter") void connect(); });
			showServer();
			window.setTimeout(() => input.focus(), 0);
			const error = el.createEl("p", { cls: "ownsync-error" });
			error.hide();
			const buttons = el.createDiv({ cls: "modal-button-container" });
			buttons.createEl("button", { text: "Back" }).addEventListener("click", () => this.go("choose"));
			const go = buttons.createEl("button", { text: "Connect", cls: "mod-cta" });
			const busy = (on: boolean) => { go.disabled = on; go.setText(on ? "Connecting…" : "Connect"); };
			const connect = async () => {
				const code = parseVaultCode(input.value);
				error.hide();
				if (!code) return this.fail(error, "That isn't a vault code. Copy it again from your server's dashboard.");
				busy(true);
				try {
					await this.plugin.setAttachments(attachments);
					await this.plugin.createVault(code.host, code.owner);
					if (!this.plugin.hasKey()) return busy(false); // the recovery kit was closed: nothing was created
					// The server says whether the code still works only once the vault connects.
					const outcome = await this.until(() => ["synced", "catching up", "needs owner code"].includes(this.plugin.status));
					if (this.plugin.status === "needs owner code") {
						await this.plugin.leave();
						throw new Error("This code was already used or has expired. Get a new one from your server's dashboard.");
					}
					if (!outcome) throw new Error("Couldn't reach the server yet. Ownsync keeps trying; check this device is online.");
					this.go("done");
				} catch (err) {
					busy(false);
					this.fail(error, err instanceof Error ? err.message : String(err));
				}
			};
			go.addEventListener("click", () => void connect());
		} else if (this.screen === "join") {
			this.titleEl.setText("Add this device");
			const steps = el.createEl("ol", { cls: "ownsync-steps" });
			steps.createEl("li", { text: "On a device that already syncs, open Settings → Ownsync → Add a device." });
			steps.createEl("li", { text: "On a phone or tablet: scan the code it shows with this device's camera." });
			steps.createEl("li", { text: "On a computer: copy the link it shows, and paste it here." });
			const pasted = field(el, "Pairing link", "");
			pasted.placeholder = "obsidian://ownsync-pair?…";
			attachmentsToggle(el, this.plugin.attachments, (on) => void this.plugin.setAttachments(on));
			const buttons = el.createDiv({ cls: "modal-button-container" });
			buttons.createEl("button", { text: "Back" }).addEventListener("click", () => this.go("choose"));
			buttons.createEl("button", { text: "Pair", cls: "mod-cta" }).addEventListener("click", async () => {
				const params = paramsOfPairLink(pasted.value);
				if (!params) return void new Notice("That isn't a Ownsync pairing link. Copy it again from your other device.", 8000);
				this.close();
				await handlePairLink(this.plugin, params);
			});
		} else {
			this.titleEl.setText("You're all set");
			el.createEl("p", { cls: "ownsync-lead", text: "This vault is syncing. Changes appear on your other devices as you type." });
			this.choice(el, "Add another device", "Your phone, tablet or another computer.", () => {
				this.close();
				void showPairingCode(this.plugin);
			});
			const buttons = el.createDiv({ cls: "modal-button-container" });
			buttons.createEl("button", { text: "Done", cls: "mod-cta" }).addEventListener("click", () => this.close());
		}
	}

	private async until(done: () => boolean, ms = 20000): Promise<boolean> {
		for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => window.setTimeout(r, 200))) if (done()) return true;
		return done();
	}

	private choice(el: HTMLElement, title: string, desc: string, onClick: () => void): void {
		const b = el.createEl("button", { cls: "ownsync-choice" });
		b.createDiv({ cls: "ownsync-choice-title", text: title });
		b.createDiv({ cls: "ownsync-choice-desc", text: desc });
		b.addEventListener("click", onClick);
	}

	private fail(el: HTMLElement, message: string): void {
		el.setText(message);
		el.show();
		el.scrollIntoView({ block: "nearest" });
	}
}

/**
 * "Set up another vault": once a vault exists the setup key claims nothing, so a device that syncs asks the Worker
 * for a fresh owner code (proving itself with its vault's token) and shows it, with the server address, to paste
 * into the other vault's setup screen.
 */
export async function showVaultCode(plugin: SetupHost): Promise<void> {
	const keys = plugin.session?.keys, server = trimHost(plugin.settings.host);
	if (!keys) return;
	const token = await keys.token();
	const res = await requestUrl({ url: `${server}/vault/${hex(keys.vaultId)}/mint`, method: "POST", body: token.buffer.slice(token.byteOffset, token.byteOffset + token.byteLength) as ArrayBuffer, throw: false }).catch(() => null);
	const owner = (() => { try { return (res?.json as { owner?: string } | undefined)?.owner; } catch { return undefined; } })();
	if (!owner || !/^[0-9a-f]{64}$/.test(owner)) return void new Notice("Couldn't get a code from your server. Wait until Ownsync shows synced, then try again.", 8000);
	const code = `${server}#${owner}`;
	const modal = new Modal(plugin.app);
	modal.modalEl.addClass("ownsync-setup");
	modal.titleEl.setText("Set up another vault");
	const el = modal.contentEl;
	el.createEl("p", { cls: "ownsync-lead", text: "Sync another Obsidian vault through the same server, with its own encryption key." });
	const steps = el.createEl("ol", { cls: "ownsync-steps" });
	steps.createEl("li", { text: "Open the other vault in Obsidian, on this or any device, and install Ownsync there." });
	steps.createEl("li", { text: "In Ownsync's setup screen, choose “Start syncing this vault” and paste this code as the setup key." });
	const box = el.createEl("textarea", { cls: "ownsync-code" });
	box.value = code;
	box.readOnly = true;
	box.rows = 3;
	el.createEl("p", { cls: "ownsync-quiet", text: "The code sets up one vault, within 24 hours. It opens none of your vaults, but keep it to yourself." });
	const buttons = el.createDiv({ cls: "modal-button-container" });
	buttons.createEl("button", { text: "Close" }).addEventListener("click", () => modal.close());
	buttons.createEl("button", { text: "Copy code", cls: "mod-cta" }).addEventListener("click", () => {
		void navigator.clipboard.writeText(code).then(() => new Notice("Code copied."), () => new Notice("Failed to copy the code.", 6000));
	});
	modal.open();
}

/** "Open dashboard": the server's front page, where the owner signs in with a passkey. */
export function openDashboard(plugin: SetupHost): void {
	window.open(`${trimHost(plugin.settings.host)}/`);
}
