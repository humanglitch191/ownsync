// Starts `wrangler dev` for this Worker (with its test-only stats route) on a random port with fresh local storage.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

export async function ownerOverview(host: string) {
	const cookie = await sessions.get(host);
	if (!cookie) throw new Error("no dashboard session");
	return (await fetch(host + "/api/overview", { headers: { cookie } })).json() as Promise<{
		limits: { rowsWrittenPerDay: number }; usage: { rowsWrittenToday: number };
		vaults: { id: string; migrationNeedsWrites?: number }[];
	}>;
}

/** Owner codes for test vaults, one per vault, from the dashboard as the owner gets them. */
export async function ownerCodes(host: string): Promise<() => Promise<string>> {
	return () => claim(host);
}

/** What a Vault's `stats()` gives the owner's dashboard, read through the test-only route. */
export type Stats = { bytes: number; requestsToday: number; rowsWrittenToday: number; history: { day: number; requests: number; rows: number }[]; lastActivity: number | null; name: string; deleted: boolean; devices: { id: string; name: string; lastOnline: number; online: boolean; version: string; conflicts: number; mobile: boolean; notesOnly: boolean }[]; settings: { snapshots: boolean; historyBackup: boolean } };
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
	const stop = () => {
		try { process.kill(-dev.pid!, "SIGTERM"); } catch { /* already gone */ }
		rmSync(persistDir, { recursive: true, force: true }); // each run gets a fresh one; /tmp is often in memory
	};
	process.once("exit", stop);
	return { port, persistDir, stop };
}
