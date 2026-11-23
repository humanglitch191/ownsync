// The welcome screen: everything a first-time user does, in one place. A new vault connects with a one-time code
// from the server's dashboard, which also says which server; any other device is paired from one that already
// syncs. The setup key is only ever typed on the dashboard.

import { Modal } from "obsidian";
import { say } from "./notice";
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
			this.choice(el, "Start syncing this vault", "Your first vault, or a new one on your Worker.", () => this.go("first"));
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
			steps.createEl("li", { text: "Open your Worker's address in a browser and sign in." });
			steps.createEl("li", { text: "Under Connect a vault, press Open in Obsidian, or copy the code and paste it here." });
			const input = field(el, "Vault code", "The notes already in this vault are uploaded to your Worker, encrypted.");
			input.placeholder = "https://…#…";
			input.value = this.code;
			const server = el.createEl("p", { cls: "ownsync-server" });
			let attachments = this.plugin.attachments;
			attachmentsToggle(el, attachments, (on) => (attachments = on));
			const showServer = () => {
				const code = parseVaultCode(input.value);
				server.setText(code ? `Worker: ${code.host}` : "");
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
				if (!code) return this.fail(error, "That isn't a vault code. Copy it again from your Worker's dashboard.");
				busy(true);
				try {
					await this.plugin.setAttachments(attachments);
					await this.plugin.createVault(code.host, code.owner);
					if (!this.plugin.hasKey()) return busy(false); // the recovery kit was closed: nothing was created
					// The server says whether the code still works only once the vault connects.
					const outcome = await this.until(() => ["synced", "catching up", "needs owner code"].includes(this.plugin.status));
					if (this.plugin.status === "needs owner code") {
						await this.plugin.leave();
						throw new Error("This code was already used or has expired. Get a new one from your Worker's dashboard.");
					}
					if (!outcome) throw new Error("Couldn't reach the Worker yet. Ownsync keeps trying; check this device is online.");
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
			const pair = async () => {
				const params = paramsOfPairLink(pasted.value);
				if (!params) return void say("That isn't an Ownsync pairing link. Copy it again from your other device.", 8000);
				this.close();
				await handlePairLink(this.plugin, params);
			};
			pasted.addEventListener("keydown", (e) => { if (e.key === "Enter") void pair(); });
			window.setTimeout(() => pasted.focus(), 0);
			buttons.createEl("button", { text: "Pair", cls: "mod-cta" }).addEventListener("click", () => void pair());
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
 * "Open dashboard": the server's front page, where the owner signs in with a passkey; "connect" starts adding a vault,
 * "cleanup/<vault>" opens that vault's Clean up.
 */
export function openDashboard(plugin: SetupHost, start?: "connect" | `cleanup/${string}` | `settings/${string}`): void {
	window.open(`${trimHost(plugin.settings.host)}/${start ? `#${start}` : ""}`);
}
