// The settings flows for the vault's devices and recovery key (keys.ts does the protocol): creating a vault
// with a recovery kit, removing a device, replacing the recovery key, recovering a vault on a new device, and
// choosing between two competing device lists.

import { type App, Modal, Platform, Setting } from "obsidian";
import { say } from "./notice";
import { decodeRecoveryCode, hex, openRecoveryPrivate, randomBytes } from "../../protocol/ownsync";
import { type Candidate, type Recovery, type VaultKeys, newRecovery, shortId, vaultIdOf } from "./keys";
import { isAllowedHost, trimHost } from "./links";
import { type Transport, fetchRecords } from "./transport";

export interface DevicesHost {
	app: App;
	settings: { host: string; vaultId: string };
	session: { keys: VaultKeys; transport: Transport } | null;
	setUp(host: string, vaultId: string, ring: Map<number, Uint8Array>, init?: (keys: VaultKeys) => Promise<void>): Promise<void>;
}

const guarded = <A extends unknown[]>(fn: (...args: A) => Promise<void>) => (...args: A): Promise<void> =>
	fn(...args).catch((err) => void say(`Ownsync: ${err instanceof Error ? err.message : String(err)}`, 10000));

function synced(host: DevicesHost) {
	const s = host.session;
	if (s?.transport.status === "synced") return s;
	say("Wait until Ownsync shows synced, then try again.", 7000);
	return null;
}

/** A question with a button per answer; resolves to the answer's index, or -1 if the user closed it. */
function ask(app: App, title: string, text: string, answers: string[]): Promise<number> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let answer = -1;
		modal.titleEl.setText(title);
		modal.contentEl.createEl("p", { text });
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		answers.forEach((a, i) => buttons.createEl("button", { text: a }).addEventListener("click", () => { answer = i; modal.close(); }));
		modal.onClose = () => resolve(answer);
		modal.open();
	});
}

/** Shows a new recovery kit. Resolves true once the user confirms they saved it, "skip" if they chose `skip`. */
function showRecoveryKit(app: App, why: string, host: string, vaultId: string, code: string, skip?: string): Promise<boolean | "skip"> {
	const kit = [
		"Ownsync recovery kit", `Worker address: ${host}`, `Vault ID: ${vaultId}`, `Recovery code: ${code.match(/.{1,4}/g)!.join("-")}`, "",
		"With this code and the vault ID, anyone who can reach the Worker can read the vault. Keep it offline, for example printed.",
	].join("\n");
	return new Promise((resolve) => {
		const modal = new Modal(app);
		modal.modalEl.addClass("ownsync-setup");
		let answer: boolean | "skip" = false, saved = false;
		modal.titleEl.setText("Your recovery kit");
		modal.contentEl.createEl("p", { text: `${why} If you lose every device, this kit is the only way back into the vault. It won't be shown again.` });
		const text = modal.contentEl.createEl("textarea");
		text.value = kit;
		text.readOnly = true;
		text.rows = 7;
		new Setting(modal.contentEl).setName("I have saved this kit somewhere safe").addToggle((t) => t.onChange((v) => { saved = v; done.disabled = !v; }));
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(kit).then(() => say("Recovery kit copied."), () => say("Failed to copy the recovery kit.", 6000));
		});
		// Outside the vault on purpose: the vault syncs, and the recovery code must not.
		if (!Platform.isMobile) buttons.createEl("button", { text: "Save as file" }).addEventListener("click", () => {
			const url = URL.createObjectURL(new Blob([kit], { type: "text/plain" }));
			const a = createEl("a");
			a.href = url;
			a.download = "Ownsync recovery kit.txt";
			a.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 1000); // revoking at once can cancel the download
		});
		if (skip) buttons.createEl("button", { text: skip }).addEventListener("click", () => { answer = "skip"; modal.close(); });
		const done = buttons.createEl("button", { text: "Done", cls: "mod-cta" });
		done.disabled = true;
		done.addEventListener("click", () => { answer = saved; modal.close(); });
		modal.onClose = () => resolve(answer);
		modal.open();
	});
}

export const createVault = guarded(async (host: DevicesHost, server: string, vaultId: string = hex(randomBytes(16))) => {
	const recovery = await newRecovery(await vaultIdOf(vaultId));
	const saved = await showRecoveryKit(host.app, "A recovery key is optional, and recommended.", server, vaultId, recovery.code, "Skip: no recovery key");
	if (!saved) return void say("Nothing was created.");
	await host.setUp(server, vaultId, new Map([[0, randomBytes(32)]]), (keys) => keys.genesis(saved === true ? recovery : undefined));
});

export const removeDevice = guarded(async (host: DevicesHost, id: Uint8Array) => {
	const s = synced(host);
	if (!s) return;
	const answer = await ask(host.app, `Remove device ${shortId(id)}?`, "It stops syncing: the vault gets a new key that device won't have, and every note is sent again under it. Notes already on it stay there. Was it lost or stolen?", ["Lost or stolen", "I still have it", "Cancel"]);
	if (answer < 0 || answer === 2) return;
	const hasRecovery = !!s.keys.state.head?.recoveryPub;
	let recovery: Recovery | undefined;
	if (answer === 0 && hasRecovery) {
		// It knows the current recovery public key: with the server's help it could plant a fake history that a recovery would trust.
		recovery = await newRecovery(s.keys.vaultId);
		const why = "A lost or stolen device knows your current recovery key, so it is replaced as well.";
		if (!(await showRecoveryKit(host.app, why, host.settings.host, host.settings.vaultId, recovery.code))) return void say("Nothing was removed.");
	}
	await s.keys.remove(id, recovery);
	s.transport.offer();
	say(recovery ? "Removing the device, then replacing the recovery key." : answer === 1 && hasRecovery ? "Removing the device. Consider replacing the recovery key too." : "Removing the device.", 8000);
});

export const replaceRecovery = guarded(async (host: DevicesHost) => {
	const s = synced(host);
	if (!s) return;
	const recovery = await newRecovery(s.keys.vaultId);
	if (!(await showRecoveryKit(host.app, "This replaces the old recovery code, which stops working.", host.settings.host, host.settings.vaultId, recovery.code))) {
		return void say("The recovery key was not changed.");
	}
	await s.keys.replaceRecovery(recovery);
	s.transport.offer();
});

export const recoverVault = guarded(async (host: DevicesHost, server: string, vaultIdInput: string, code: string) => {
	server = trimHost(server);
	const vaultId = vaultIdInput.trim().toLowerCase();
	if (!isAllowedHost(server) || !/^[0-9a-f]{32}$/.test(vaultId)) throw new Error("enter the Worker address (https://…) and the 32-character vault ID from the recovery kit");
	const id = await vaultIdOf(vaultId);
	const { records, recovery } = await fetchRecords(server, id);
	if (!recovery.length) throw new Error("the Worker has no recovery key for this vault ID");
	await openRecoveryPrivate(decodeRecoveryCode(code), id, recovery).catch(() => { throw new Error("this recovery code doesn't open the vault"); });
	const next = await newRecovery(id);
	const why = "Recovering uses up the old recovery code, and removes every other device (pair them again afterwards). Here is the new kit.";
	if (!(await showRecoveryKit(host.app, why, server, vaultId, next.code))) return void say("Nothing changed.");
	await host.setUp(server, vaultId, new Map(), (keys) => keys.recover(code, recovery, records, next));
	say("Recovered. Ownsync catches up, then gives the vault a new key.", 10000);
});

export class RecoverModal extends Modal {
	constructor(private readonly host: DevicesHost, private readonly done: () => void) {
		super(host.app);
	}

	onOpen(): void {
		const v = { server: this.host.settings.host, vaultId: "", code: "" };
		this.titleEl.setText("Recover a vault");
		this.contentEl.createEl("p", { text: "Enter what's on your recovery kit. This device joins the vault, and every other device is removed." });
		new Setting(this.contentEl).setName("Worker address").addText((t) => t.setValue(v.server).onChange((x) => (v.server = x)));
		new Setting(this.contentEl).setName("Vault ID").addText((t) => t.onChange((x) => (v.vaultId = x)));
		new Setting(this.contentEl).setName("Recovery code").addText((t) => t.onChange((x) => (v.code = x)));
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Recover").setCta().onClick(async () => {
			this.close();
			await recoverVault(this.host, v.server, v.vaultId, v.code);
			this.done();
		}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Sync stays paused until the user picks: no device can tell which change is theirs.
export const chooseFork = guarded(async (host: DevicesHost) => {
	const s = host.session, fork = s?.keys.state.fork;
	if (!s || !fork) return;
	const describe = (c: Candidate, i: number) => `${i + 1}: by ${shortId(c.senderId)}, ${[...c.added.map((id) => `adds ${shortId(id)}`), ...c.removed.map((id) => `removes ${shortId(id)}`)].join(", ")}.`;
	const text = `Two devices changed the device list at the same moment. ${fork.map(describe).join(" ")} Keep the change you made; then remove the device that made the other one if you don't recognise it.`;
	const i = await ask(host.app, "Competing changes to the device list", text, fork.map((_, i) => `Keep ${i + 1}`));
	if (i < 0) return;
	await s.keys.choose(fork[i]!);
	await s.transport.connect();
});
