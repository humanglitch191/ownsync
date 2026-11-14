// Starts `wrangler dev` for this Worker (with its test-only stats route) on a random port with fresh local storage.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setUpDashboard } from "./passkey.ts";

/** The setup key the test Worker is started with. */
export const SETUP_KEY = "test-setup-key-0123";

const sessions = new Map<string, Promise<string>>();

/** An owner code, as the owner gets one: setup key and passkey on the dashboard (once), then "Connect a vault". */
export async function claim(host: string, key = SETUP_KEY): Promise<string> {
	if (!sessions.has(host)) sessions.set(host, setUpDashboard(host, key).then((s) => s.cookie));
	const cookie = await sessions.get(host)!;
	const { code } = (await (await fetch(`${host}/api/vault-code`, { method: "POST", headers: { origin: host, cookie, "content-type": "application/json" }, body: "{}" })).json()) as { code?: string };
	if (!code) throw new Error("the dashboard gave no vault code");
	return code.split("#")[1]!;
}

/**
 * Owner codes for test vaults, as a person gets them: the setup key makes a first vault, then "Set up another
 * vault" from it gives one code per new vault.
 */
export async function ownerCodes(host: string): Promise<() => Promise<string>> {
	const first = await claim(host);
	const token = crypto.getRandomValues(new Uint8Array(32));
	const base = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
	const ws = new WebSocket(`${host.replace(/^http/, "ws")}/vault/${base}`);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	ws.send(Uint8Array.from([1, ...token, ...first.match(/../g)!.map((h) => parseInt(h, 16))])); // hello with the owner code
	const mint = async () => {
		const r = await fetch(`${host}/vault/${base}/mint`, { method: "POST", body: token });
		return r.ok ? ((await r.json()) as { owner: string }).owner : undefined;
	};
	for (let i = 0; i < 100 && !(await mint()); i++) await new Promise((r) => setTimeout(r, 20));
	ws.close();
	return async () => (await mint()) ?? Promise.reject(new Error("no owner code minted"));
}

/** What a Vault's `stats()` gives the owner's dashboard, read through the test-only route. */
export type Stats = { bytes: number; requestsToday: number; rowsWrittenToday: number; lastActivity: number | null; deleted: boolean; devices: { id: string; lastOnline: number; online: boolean; version: string; conflicts: number }[] };
export const stats = async (host: string, vault: string): Promise<Stats> => (await fetch(`${host}/test-stats/${vault}`)).json() as Promise<Stats>;

export async function startDev() {
	const port = 18787 + Math.floor(Math.random() * 1000);
	const persistDir = mkdtempSync(join(tmpdir(), "ownsync-dev-"));
	// Its own process group: npx starts wrangler, which starts workerd, and stopping npx alone leaves those running.
	const dev = spawn("npx", ["wrangler", "dev", "test/statsWorker.ts", "--port", String(port), "--persist-to", persistDir, "--var", `SETUP_KEY:${SETUP_KEY}`], {
		detached: true,
		cwd: new URL("..", import.meta.url).pathname,
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise<void>((resolve, reject) => {
		const onData = (d: Buffer) => { if (d.toString().includes("Ready on")) resolve(); };
		dev.stdout.on("data", onData);
		dev.stderr.on("data", onData);
		dev.on("exit", (code) => reject(new Error(`wrangler dev exited ${code}`)));
	});
	const stop = () => { try { process.kill(-dev.pid!, "SIGTERM"); } catch { /* already gone */ } };
	process.once("exit", stop);
	return { port, persistDir, stop };
}
