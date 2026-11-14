// The owner dashboard's API, run inside the Owner Durable Object (one per Worker) so passkeys, sessions and
// challenges live in one place. It shows only what the server knows without any key: nothing here opens a vault.
// docs/DESIGN.md section 6.

import {
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";

/** What a Vault reports about itself (Vault.stats). */
export interface VaultStats {
	bytes: number;
	requestsToday: number;
	rowsWrittenToday: number;
	lastActivity: number | null;
	deleted: boolean;
	devices: { id: string; lastOnline: number; online: boolean; version: string; conflicts: number }[];
}

// Workers Free plan, from Cloudflare's pricing and limits pages (2026-11-13).
export const LIMITS = { storageBytes: 5e9, vaultBytes: 1e9, requestsPerDay: 100_000, rowsWrittenPerDay: 100_000 };

export const DASHBOARD_TABLES = `
	CREATE TABLE IF NOT EXISTS site (id INTEGER PRIMARY KEY CHECK (id = 0), origin TEXT NOT NULL, user_id BLOB NOT NULL, mac_key BLOB NOT NULL, setup_key BLOB NOT NULL);
	CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, created INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS sessions (hash BLOB PRIMARY KEY, passkey TEXT NOT NULL, expires INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS enrolments (hash BLOB PRIMARY KEY, setup_key BLOB NOT NULL, origin TEXT NOT NULL, expires INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS used_challenges (nonce BLOB PRIMARY KEY, expires INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS tries (at INTEGER NOT NULL, key BLOB NOT NULL, who BLOB NOT NULL);
`;

const SESSION_MS = 12 * 60 * 60 * 1000, CHALLENGE_MS = 5 * 60 * 1000, ENROL_MS = 10 * 60 * 1000, MAX_ENROLMENTS = 5;
// The setup key works this long after a deploy; then only a new SETUP_KEY (a new deploy) opens it again.
export const SETUP_WINDOW_MS = 10 * 60 * 1000;
// Wrong setup keys per connection per hour, and from everywhere together: only a large botnet reaches the second.
const MAX_TRIES = 10, MAX_TRIES_ALL = 1000, LOCK_MS = 60 * 60 * 1000;
const COOKIE = "__Host-vs";
const UNKNOWN_PASSKEY = "That passkey isn't one this dashboard knows.";
const LOST_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// What a challenge was issued for: a signature made for one can't be used for another.
const PURPOSE = { enrol: 1, login: 2, confirm: 3, add: 4 } as const;
type Purpose = keyof typeof PURPOSE;

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const sha256 = async (b: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? enc.encode(b) : b));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const fail = (status: number, error: string) => json({ error }, status);

type Site = { origin: string; user_id: ArrayBuffer; mac_key: ArrayBuffer; setup_key: ArrayBuffer };
type Passkey = { id: string; public_key: ArrayBuffer; counter: number; created: number };
export type SetupState = { state: "open" | "used" | "expired" | "no key"; until: number };

export class Dashboard {
	constructor(
		private readonly sql: SqlStorage,
		private readonly stats: (vault: string) => Promise<VaultStats | null>,
		private readonly mint: () => Promise<string>,
		private readonly vaults: () => { id: string; created: number; label: string }[],
	) {
		sql.exec(DASHBOARD_TABLES);
	}

	/**
	 * Whether the setup key can add a passkey: only within SETUP_WINDOW_MS of the deploy, and only while no
	 * passkey was added with this setup key (a new SETUP_KEY is how an owner who lost every passkey gets back in).
	 */
	setupState(setupKey: Uint8Array | null, deployed: number): SetupState {
		const until = deployed + SETUP_WINDOW_MS;
		if (!setupKey) return { state: "no key", until };
		const site = this.site();
		if (site && same(new Uint8Array(site.setup_key), setupKey)) return { state: "used", until };
		return { state: Date.now() < until ? "open" : "expired", until };
	}

	/** The setup key, as a hash bound to this address: right, within the window, and not used, gives an enrol token. */
	async setup(given: Uint8Array, expected: Uint8Array, setupKey: Uint8Array, who: Uint8Array, deployed: number, origin: string): Promise<{ token?: string; error?: string }> {
		const now = Date.now();
		// Wrong tries count against the setup key they were made against: setting a new one starts afresh.
		this.sql.exec("DELETE FROM tries WHERE at < ? OR key != ?", now - LOCK_MS, setupKey);
		const mine = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tries WHERE who = ?", who).one().n;
		const all = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tries").one().n;
		if (mine >= MAX_TRIES || all >= MAX_TRIES_ALL) return { error: "locked" };
		if (!same(given, expected)) {
			this.sql.exec("INSERT INTO tries (at, key, who) VALUES (?, ?, ?)", now, setupKey, who);
			return { error: "wrong key" };
		}
		// Only after the key checked out: nobody without it learns how setup stands.
		const { state } = this.setupState(setupKey, deployed);
		if (state !== "open") return { error: state };
		this.sql.exec("DELETE FROM enrolments WHERE expires < ?", now);
		if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM enrolments").one().n >= MAX_ENROLMENTS) return { error: "locked" };
		const token = crypto.getRandomValues(new Uint8Array(32));
		this.sql.exec("INSERT INTO enrolments (hash, setup_key, origin, expires) VALUES (?, ?, ?, ?)", await sha256(token), setupKey, origin, Math.min(now + ENROL_MS, deployed + SETUP_WINDOW_MS));
		return { token: b64url(token) };
	}

	async handle(req: Request): Promise<Response> {
		const url = new URL(req.url), path = url.pathname, site = this.site();
		if (req.method === "GET" && path === "/api/overview") {
			const session = await this.session(req);
			return session ? json(await this.overview(session, site!)) : fail(401, "signed out");
		}
		if (req.method !== "POST") return fail(405, "method not allowed");
		const length = Number(req.headers.get("content-length") ?? 0);
		if (length > 64 * 1024) return fail(413, "too large");
		const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
		const origin = req.headers.get("origin");

		// Adding the first passkey, with a token the setup key gave. A new setup key replaces every passkey: whoever
		// set it controls the Cloudflare account, and the old passkeys may be lost or in other hands.
		if (path === "/api/enrol/options" || path === "/api/enrol/verify") {
			const enrolment = await this.enrolment(String(body.token ?? ""));
			if (!enrolment) return fail(403, "This step expired. Reload the page and enter the setup key again.");
			if (origin !== enrolment.origin) return fail(403, "wrong origin");
			const s = this.siteFor(enrolment.origin);
			if (path === "/api/enrol/options") return json(await this.registrationOptions(s, "enrol"));
			const response = body.response as RegistrationResponseJSON;
			if (!(await this.checkRegistration(s, "enrol", response))) return fail(400, "The passkey couldn't be checked. Try again.");
			// From here on, no await until it's all written: one setup key adds one passkey, first come first served,
			// even if two people with the key got this far at once.
			const now = this.site();
			const taken = !this.sql.exec("SELECT 1 FROM enrolments WHERE hash = ?", enrolment.hash).toArray().length || (now && same(new Uint8Array(now.setup_key), enrolment.setupKey));
			if (taken) return fail(409, "Someone already added a passkey with this setup key. If it wasn't you, set a new SETUP_KEY in Cloudflare and start again.");
			for (const table of ["sessions", "passkeys", "enrolments", "used_challenges"]) this.sql.exec(`DELETE FROM ${table}`);
			const passkey = this.register(response)!;
			// A fresh signing key too, so nothing issued before the new setup key still checks out.
			this.sql.exec("INSERT OR REPLACE INTO site (id, origin, user_id, mac_key, setup_key) VALUES (0, ?, ?, ?, ?)", s.origin, s.user_id, crypto.getRandomValues(new Uint8Array(32)), enrolment.setupKey);
			return this.signIn(passkey);
		}
		// Everything else happens on the site the first passkey was made for, from its own pages. Before there is one,
		// signing in looks the same and just fails: nobody learns whether this Worker is set up.
		if (origin !== (site?.origin ?? url.origin)) return fail(403, "wrong origin");
		if (!site?.setup_key.byteLength) {
			if (path === "/api/login/options") return json(await generateAuthenticationOptions({ rpID: url.hostname, challenge: crypto.getRandomValues(new Uint8Array(57)), userVerification: "required" }));
			return fail(401, path === "/api/login/verify" ? UNKNOWN_PASSKEY : "signed out");
		}

		if (path === "/api/login/options") return json(await this.authenticationOptions(site, "login"));
		if (path === "/api/login/verify") {
			const passkey = await this.authenticate(site, "login", body.response as AuthenticationResponseJSON);
			return passkey ? this.signIn(passkey) : fail(401, UNKNOWN_PASSKEY);
		}
		if (path === "/api/logout") {
			const hash = await this.cookieHash(req);
			if (hash) this.sql.exec("DELETE FROM sessions WHERE hash = ?", hash);
			return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
		}

		const session = await this.session(req);
		if (!session) return fail(401, "signed out");
		const label = path.match(/^\/api\/vaults\/([0-9a-f]{32})\/label$/);
		if (label) {
			if (!this.vaults().some((v) => v.id === label[1])) return fail(404, "no such vault");
			this.sql.exec("UPDATE vaults SET label = ? WHERE id = ?", String(body.label ?? "").trim().slice(0, 40), label[1]!);
			return json({ ok: true });
		}
		if (path === "/api/vault-code") {
			const owner = await this.mint();
			return json({ code: `${site.origin}#${owner}`, link: `obsidian://ownsync-setup?${new URLSearchParams({ host: site.origin, code: owner })}` });
		}
		if (path === "/api/passkeys/add/options") return json(await this.registrationOptions(site, "add"));
		if (path === "/api/passkeys/add") {
			const response = body.response as RegistrationResponseJSON;
			const ok = (await this.checkRegistration(site, "add", response)) && this.register(response);
			return ok ? json({ ok: true }) : fail(400, "The passkey couldn't be checked. Try again.");
		}
		if (path === "/api/passkeys/remove/options") return json(await this.authenticationOptions(site, "confirm"));
		if (path === "/api/passkeys/remove") {
			// A fresh passkey check, not only the session: removing one locks someone out.
			if (!(await this.authenticate(site, "confirm", body.response as AuthenticationResponseJSON))) return fail(401, "The passkey check failed.");
			const id = String(body.id ?? "");
			if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM passkeys").one().n <= 1) return fail(409, "That's your only passkey. Add another one first.");
			this.sql.exec("DELETE FROM sessions WHERE passkey = ?", id);
			this.sql.exec("DELETE FROM passkeys WHERE id = ?", id);
			return json({ ok: true });
		}
		return fail(404, "not found");
	}

	private site(): Site | undefined {
		return this.sql.exec<Site>("SELECT origin, user_id, mac_key, setup_key FROM site").toArray()[0];
	}

	// The site being set up: the current one (keys and user ID kept), at the address the setup key was typed on.
	private siteFor(origin: string): Site {
		const site = this.site();
		if (site) return { ...site, origin };
		const fresh = { origin, user_id: crypto.getRandomValues(new Uint8Array(16)).buffer, mac_key: crypto.getRandomValues(new Uint8Array(32)).buffer, setup_key: new Uint8Array(0).buffer };
		// Kept now (not yet as used) so the challenge it signs checks out on the next request.
		this.sql.exec("INSERT INTO site (id, origin, user_id, mac_key, setup_key) VALUES (0, ?, ?, ?, ?)", origin, fresh.user_id, fresh.mac_key, fresh.setup_key);
		return fresh;
	}

	private async enrolment(token: string): Promise<{ hash: Uint8Array; setupKey: Uint8Array; origin: string } | null> {
		let raw: Uint8Array;
		try { raw = unb64url(token); } catch { return null; }
		if (raw.length !== 32) return null;
		const hash = await sha256(raw);
		const row = this.sql.exec<{ setup_key: ArrayBuffer; origin: string }>("SELECT setup_key, origin FROM enrolments WHERE hash = ? AND expires >= ?", hash, Date.now()).toArray()[0];
		return row ? { hash, setupKey: new Uint8Array(row.setup_key), origin: row.origin } : null;
	}

	// Challenges are signed by the Worker, not stored, so asking for one costs nothing; each is used once.
	private async challenge(site: Site, purpose: Purpose): Promise<Uint8Array> {
		const head = new Uint8Array(25);
		head.set(crypto.getRandomValues(new Uint8Array(16)));
		new DataView(head.buffer).setBigUint64(16, BigInt(Date.now() + CHALLENGE_MS));
		head[24] = PURPOSE[purpose];
		return new Uint8Array([...head, ...(await this.mac(site, head))]);
	}

	private async mac(site: Site, data: Uint8Array): Promise<Uint8Array> {
		const key = await crypto.subtle.importKey("raw", site.mac_key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
	}

	private async useChallenge(site: Site, purpose: Purpose, challenge: string): Promise<boolean> {
		let raw: Uint8Array;
		try { raw = unb64url(challenge); } catch { return false; }
		if (raw.length !== 57 || raw[24] !== PURPOSE[purpose]) return false;
		const head = raw.slice(0, 25), now = Date.now();
		if (!same(raw.slice(25), await this.mac(site, head))) return false;
		const expires = Number(new DataView(head.buffer).getBigUint64(16));
		if (expires < now) return false;
		this.sql.exec("DELETE FROM used_challenges WHERE expires < ?", now);
		if (this.sql.exec("SELECT 1 FROM used_challenges WHERE nonce = ?", head.slice(0, 16)).toArray().length) return false;
		this.sql.exec("INSERT INTO used_challenges (nonce, expires) VALUES (?, ?)", head.slice(0, 16), expires);
		return true;
	}

	private async registrationOptions(site: Site, purpose: Purpose) {
		const host = new URL(site.origin).hostname;
		return generateRegistrationOptions({
			rpName: "Ownsync",
			rpID: host,
			userID: new Uint8Array(site.user_id),
			userName: `Ownsync (${host})`,
			userDisplayName: "Ownsync dashboard",
			challenge: await this.challenge(site, purpose),
			attestationType: "none",
			authenticatorSelection: { residentKey: "required", userVerification: "required" },
			supportedAlgorithmIDs: [-7, -257],
			excludeCredentials: this.sql.exec<{ id: string }>("SELECT id FROM passkeys").toArray().map((p) => ({ id: p.id })),
		});
	}

	// Verified once, kept by `register`: the two steps let the first passkey replace the old ones only once it checks out.
	private readonly verified = new Map<string, { publicKey: Uint8Array; counter: number }>();

	private async checkRegistration(site: Site, purpose: Purpose, response: RegistrationResponseJSON): Promise<boolean> {
		try {
			const { verified, registrationInfo } = await verifyRegistrationResponse({
				response,
				expectedChallenge: (c) => this.useChallenge(site, purpose, c),
				expectedOrigin: site.origin,
				expectedRPID: new URL(site.origin).hostname,
				requireUserVerification: true,
				supportedAlgorithmIDs: [-7, -257],
			});
			if (!verified || !registrationInfo) return false;
			this.verified.set(registrationInfo.credential.id, { publicKey: registrationInfo.credential.publicKey, counter: registrationInfo.credential.counter });
			return true;
		} catch {
			return false;
		}
	}

	private register(response: RegistrationResponseJSON): string | null {
		const credential = this.verified.get(response.id);
		this.verified.delete(response.id);
		if (!credential) return null;
		this.sql.exec("INSERT OR REPLACE INTO passkeys (id, public_key, counter, created) VALUES (?, ?, ?, ?)", response.id, credential.publicKey, credential.counter, Date.now());
		return response.id;
	}

	private async authenticationOptions(site: Site, purpose: Purpose) {
		return generateAuthenticationOptions({ rpID: new URL(site.origin).hostname, challenge: await this.challenge(site, purpose), userVerification: "required" });
	}

	private async authenticate(site: Site, purpose: Purpose, response: AuthenticationResponseJSON): Promise<string | null> {
		try {
			const row = this.sql.exec<Passkey>("SELECT * FROM passkeys WHERE id = ?", String(response?.id ?? "")).toArray()[0];
			if (!row) return null;
			const { verified, authenticationInfo } = await verifyAuthenticationResponse({
				response,
				expectedChallenge: (c) => this.useChallenge(site, purpose, c),
				expectedOrigin: site.origin,
				expectedRPID: new URL(site.origin).hostname,
				credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter },
				requireUserVerification: true,
			});
			if (!verified) return null;
			this.sql.exec("UPDATE passkeys SET counter = ? WHERE id = ?", authenticationInfo.newCounter, row.id);
			return row.id;
		} catch {
			return null;
		}
	}

	private async signIn(passkey: string): Promise<Response> {
		const id = crypto.getRandomValues(new Uint8Array(32)), now = Date.now();
		this.sql.exec("DELETE FROM sessions WHERE expires < ?", now);
		this.sql.exec("INSERT INTO sessions (hash, passkey, expires) VALUES (?, ?, ?)", await sha256(id), passkey, now + SESSION_MS);
		return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=${b64url(id)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}` });
	}

	private async cookieHash(req: Request): Promise<Uint8Array | null> {
		const value = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
		if (!value) return null;
		try {
			const raw = unb64url(value);
			return raw.length === 32 ? sha256(raw) : null;
		} catch {
			return null;
		}
	}

	private async session(req: Request): Promise<{ passkey: string } | null> {
		const hash = await this.cookieHash(req);
		if (!hash) return null;
		return this.sql.exec<{ passkey: string }>(
			"SELECT s.passkey AS passkey FROM sessions s JOIN passkeys p ON p.id = s.passkey WHERE s.hash = ? AND s.expires >= ?",
			hash, Date.now(),
		).toArray()[0] ?? null;
	}

	private async overview(session: { passkey: string }, site: Site) {
		const now = Date.now();
		const vaults = await Promise.all(this.vaults().map(async (v) => ({ ...v, stats: await this.stats(v.id).catch(() => null) })));
		const live = vaults.filter((v) => v.stats && !v.stats.deleted);
		const sum = (f: (s: VaultStats) => number) => live.reduce((n, v) => n + f(v.stats!), 0);
		// Behind the newest version any device of this Worker runs: the closest thing to "an update is out".
		const versions = live.flatMap((v) => v.stats!.devices.map((d) => d.version)).filter(Boolean);
		const newest = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() ?? "";
		return {
			origin: site.origin,
			limits: LIMITS,
			usage: { bytes: sum((s) => s.bytes), requestsToday: sum((s) => s.requestsToday), rowsWrittenToday: sum((s) => s.rowsWrittenToday) },
			vaults: live.map((v) => ({
				id: v.id,
				label: v.label,
				created: v.created,
				bytes: v.stats!.bytes,
				lastActivity: v.stats!.lastActivity,
				conflicts: Math.max(0, ...v.stats!.devices.map((d) => d.conflicts)),
				devices: v.stats!.devices.map((d) => ({ ...d, behind: !!newest && d.version !== newest && d.version.localeCompare(newest, undefined, { numeric: true }) < 0, lost: !d.online && now - d.lastOnline > LOST_AFTER_MS })),
			})),
			passkeys: this.sql.exec<{ id: string; created: number }>("SELECT id, created FROM passkeys ORDER BY created").toArray().map((p) => ({ ...p, current: p.id === session.passkey })),
		};
	}
}
