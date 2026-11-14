// A software passkey that builds exactly what a browser's authenticator would (CBOR attestation, ES256
// signatures), so the Worker's real verification runs in tests. Also the dashboard's setup sign-in, as the page does it.

import { createHash, webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const sha256 = async (b: Uint8Array) => new Uint8Array(await subtle.digest("SHA-256", b));
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const u16 = (n: number) => new Uint8Array([n >> 8, n & 255]);
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

// Just enough CBOR for an attestation object and a COSE key.
function cbor(v: unknown): Uint8Array {
	const head = (major: number, n: number) => (n < 24 ? new Uint8Array([(major << 5) | n]) : n < 256 ? new Uint8Array([(major << 5) | 24, n]) : cat(new Uint8Array([(major << 5) | 25]), u16(n)));
	if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
	if (typeof v === "string") { const b = new TextEncoder().encode(v); return cat(head(3, b.length), b); }
	if (v instanceof Uint8Array) return cat(head(2, v.length), v);
	if (v instanceof Map) return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
	throw new Error("cbor: unsupported");
}

// ECDSA signatures from WebCrypto are r|s; WebAuthn wants DER.
function der(sig: Uint8Array): Uint8Array {
	const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let x = b.slice(i); if (x[0]! & 0x80) x = cat(new Uint8Array([0]), x); return cat(new Uint8Array([2, x.length]), x); };
	const body = cat(int(sig.slice(0, 32)), int(sig.slice(32)));
	return cat(new Uint8Array([0x30, body.length]), body);
}

/** A passkey on a software authenticator. */
export async function authenticator(origin: string) {
	const keys = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const jwk = await subtle.exportKey("jwk", keys.publicKey);
	const id = webcrypto.getRandomValues(new Uint8Array(16));
	const rpHash = await sha256(new TextEncoder().encode(new URL(origin).hostname));
	let counter = 0;
	const clientData = (type: string, challenge: string) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin }));
	return {
		id: b64url(id),
		create(options: { challenge: string }) {
			const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)]]));
			const authData = cat(rpHash, new Uint8Array([0x45]), u32(counter), new Uint8Array(16), u16(id.length), id, cose); // UP | UV | AT
			const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
			return { id: b64url(id), rawId: b64url(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64url(clientData("webauthn.create", options.challenge)), attestationObject: b64url(attestationObject), transports: ["internal"] } };
		},
		async get(options: { challenge: string }) {
			const authData = cat(rpHash, new Uint8Array([0x05]), u32(++counter)); // UP | UV
			const client = clientData("webauthn.get", options.challenge);
			const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, cat(authData, await sha256(client))));
			return { id: b64url(id), rawId: b64url(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64url(client), authenticatorData: b64url(authData), signature: b64url(der(sig)) } };
		},
	};
}


/** Signs in with the setup key and adds a software passkey, as the dashboard's first visit does; returns the session cookie. */
export async function setUpDashboard(origin: string, setupKey: string): Promise<{ cookie: string; key: Awaited<ReturnType<typeof authenticator>> }> {
	const post = async (path: string, body: string) => {
		const r = await fetch(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
		return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any>, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
	};
	const proof = createHash("sha256").update(`ownsync-setup\n${origin}\n${setupKey}`).digest("hex");
	const setup = await post("/api/setup", proof);
	if (!setup.body.token) throw new Error(`setup: ${setup.status} ${JSON.stringify(setup.body)}`);
	const key = await authenticator(origin);
	const options = (await post("/api/enrol/options", JSON.stringify({ token: setup.body.token }))).body;
	const done = await post("/api/enrol/verify", JSON.stringify({ token: setup.body.token, response: key.create(options as { challenge: string }) }));
	if (!done.cookie) throw new Error(`enrol: ${done.status} ${JSON.stringify(done.body)}`);
	return { cookie: done.cookie, key };
}
