// Checks for what arrives in obsidian:// links, which any web page can open. No Obsidian imports, so tests run them.

export const trimHost = (h: string) => h.trim().replace(/\/$/, "");

// The key travels sealed, but plain http would still let a network attacker block or spoof pairing.
export function isAllowedHost(host: string): boolean {
	try {
		const url = new URL(host);
		return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
	} catch {
		return false;
	}
}

/** A Worker address that is exactly an origin, so what the user is shown is where the device will connect. */
const isOrigin = (host: string) => isAllowedHost(host) && new URL(host).origin === host;

/** `obsidian://ownsync-pair?host=…&vaultId=…&code=…` from another device's pairing code, or null. */
export function parsePairLink(params: Record<string, string | undefined>): { host: string; vaultId: string; code: string } | null {
	const host = trimHost(params.host ?? ""), vaultId = (params.vaultId ?? "").trim().toLowerCase(), code = (params.code ?? "").trim().toLowerCase();
	if (!isOrigin(host) || !/^[0-9a-f]{32}$/.test(vaultId) || !/^[0-9a-f]{32}$/.test(code)) return null;
	return { host, vaultId, code };
}

/** `obsidian://ownsync-setup?host=…&code=…` from the dashboard's Open in Obsidian: a vault code, or null. */
export function parseSetupLink(params: Record<string, string | undefined>): string | null {
	const code = `${trimHost(params.host ?? "")}#${params.code ?? ""}`;
	return parseVaultCode(code) ? code : null;
}

/** The parameters of a pasted pairing link: the obsidian:// one, or the server's add-device page one. */
export function paramsOfPairLink(text: string): Record<string, string> | null {
	try {
		const url = new URL(text.trim());
		const page = isAllowedHost(url.origin) && url.pathname === "/add-device/";
		if (!page && !(url.protocol === "obsidian:" && (url.host || url.pathname.replace(/^\/+/, "")) === "ownsync-pair")) return null;
		const params = Object.fromEntries(new URLSearchParams((page ? url.hash : url.search).slice(1)));
		if (page) params.host = url.origin; // the page's own server
		return parsePairLink(params) ? params : null;
	} catch {
		return null;
	}
}

/** A code from the dashboard's Connect a vault: `<server address>#<owner code>`, or null. */
export function parseVaultCode(text: string): { host: string; owner: string } | null {
	const m = text.trim().match(/^(\S+)#([0-9a-fA-F]{64})$/);
	const host = m ? trimHost(m[1]!) : "";
	return m && isOrigin(host) ? { host, owner: m[2]!.toLowerCase() } : null;
}

/** A note's web link: a page on the Worker that hands the fragment, which never reaches the Worker, to Obsidian.
 * The note ID, not its path, so the link survives renames. */
export const noteUrl = (host: string, vaultId: string, noteId: string) => `${trimHost(host)}/open/#${vaultId}/${noteId}`;

/** `obsidian://ownsync-open?vaultId=…&note=…` from that page: exactly a vault ID and a note ID, or null. (Not
 * `vault=`: Obsidian itself reads that one, as a vault name.) */
export function parseOpenLink(params: Record<string, string | undefined>): { vaultId: string; noteId: string } | null {
	const { vaultId = "", note = "" } = params;
	return /^[0-9a-f]{32}$/.test(vaultId) && /^[0-9a-f]{16}$/.test(note) ? { vaultId, noteId: note } : null;
}
