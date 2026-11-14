// The owner dashboard: sign in with a passkey, then see vaults, devices and usage. Everything the server sends
// is shown as text, never as HTML.

const app = document.getElementById("app");
const signout = document.getElementById("signout");

// --- small helpers ---
function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") el.className = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
	return el;
}
const show = (...nodes) => app.replaceChildren(...nodes.flat());
const shortId = (hex) => hex.slice(0, 8).toUpperCase();
const ago = (t) => {
	if (!t) return "never";
	const s = Math.max(0, (Date.now() - t) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
	const d = Math.floor(s / 86400);
	return d === 1 ? "yesterday" : `${d} days ago`;
};
const size = (b) => (b < 1e6 ? `${Math.max(0, Math.round(b / 1e3))} KB` : b < 1e9 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e9).toFixed(2)} GB`);
const count = (n) => Math.round(n).toLocaleString();

async function api(path, body) {
	const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw Object.assign(new Error(data.error || `Something went wrong (${res.status}).`), { status: res.status });
	return data;
}

// --- passkeys: the server's JSON options to the browser's binary ones, and back ---
const bin = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function createPasskey(o) {
	const cred = await navigator.credentials.create({ publicKey: {
		...o, challenge: bin(o.challenge), user: { ...o.user, id: bin(o.user.id) },
		excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: bin(c.id) })),
	} });
	const r = cred.response;
	return {
		id: cred.id, rawId: b64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
		authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
		response: { clientDataJSON: b64(r.clientDataJSON), attestationObject: b64(r.attestationObject), transports: r.getTransports?.() ?? [] },
	};
}

async function usePasskey(o) {
	const cred = await navigator.credentials.get({ publicKey: {
		...o, challenge: bin(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: bin(c.id) })),
	} });
	const r = cred.response;
	return {
		id: cred.id, rawId: b64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
		authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
		response: { clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature), userHandle: r.userHandle ? b64(r.userHandle) : undefined },
	};
}

const cancelled = (err) => err?.name === "NotAllowedError" || err?.name === "AbortError";
const failure = (err) => (cancelled(err) ? "The passkey prompt was closed. Try again." : err?.name === "InvalidStateError" ? "This device already has a passkey for this dashboard: sign in with it." : err?.message || String(err));

// A button that runs `fn`, shows it's busy, and shows what went wrong next to it.
function action(label, fn, cls = "button") {
	const error = h("p", { class: "error", hidden: true });
	const button = h("button", { class: cls, onclick: async () => {
		button.disabled = true;
		error.hidden = true;
		try { await fn(); } catch (err) { error.textContent = failure(err); error.hidden = false; } finally { button.disabled = false; }
	} }, label);
	return [button, error];
}

// --- screens ---
// The setup key never leaves the browser as typed: a hash of it bound to this address.
async function setupProof(key) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ownsync-setup\n${location.origin}\n${key}`));
	return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const SETUP_ERRORS = {
	"wrong key": "That setup key isn't right. It's the passphrase you chose when you deployed.",
	locked: "Too many wrong setup keys from this connection. Try again in an hour, or set a new SETUP_KEY in Cloudflare.",
	expired: "The setup key works only in the first 10 minutes after you deploy. In your Cloudflare dashboard, open Workers → this Worker → Settings → Variables and Secrets, and set a new SETUP_KEY: that opens it again for 10 minutes.",
	used: "A passkey was already added with this setup key: sign in with it. Lost it? Set a new SETUP_KEY in Cloudflare, then come back here.",
	"no setup key": "This server has no setup key. In your Cloudflare dashboard, open Workers → this Worker → Settings → Variables and Secrets, and add a secret named SETUP_KEY.",
};

function addPasskeyStep(token) {
	show(
		h("h1", {}, "Add your passkey"),
		h("p", { class: "lead" }, "From now on you sign in with it: your fingerprint, face or device PIN. Your phone, computer or password manager keeps it."),
		h("section", { class: "card" },
			h("h2", {}, "One more step"),
			h("p", { class: "quiet" }, "After this, the setup key stops working."),
			h("div", { class: "actions" }, action("Create passkey", async () => {
				const options = await api("/api/enrol/options", { token });
				await api("/api/enrol/verify", { token, response: await createPasskey(options) });
				await load();
			}))),
	);
}

function signInScreen(message) {
	signout.hidden = true;
	const key = h("input", { type: "password", "aria-label": "Setup key", autocomplete: "off", placeholder: "Setup key" });
	const [go, error] = action("Continue", async () => {
		const res = await fetch("/api/setup", { method: "POST", body: await setupProof(key.value) });
		const data = await res.json().catch(() => ({}));
		if (!data.token) throw new Error(SETUP_ERRORS[data.error] || `Something went wrong (${res.status}).`);
		addPasskeyStep(data.token);
	}, "button secondary");
	key.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
	show(
		h("h1", {}, "Your sync server"),
		h("p", { class: "lead" }, "Ownsync syncs your Obsidian notes between your devices, end-to-end encrypted. This server only ever sees scrambled data."),
		h("section", { class: "card" },
			h("h2", {}, "Sign in"),
			h("p", { class: "quiet" }, message || "With your passkey."),
			h("div", { class: "actions" }, action("Sign in with passkey", async () => {
				const options = await api("/api/login/options", {});
				await api("/api/login/verify", { response: await usePasskey(options) });
				await load();
			}))),
		h("section", { class: "card" },
			h("h2", {}, "First time here?"),
			h("p", { class: "quiet" }, "Enter the setup key you chose when you deployed. It works once, in the first 10 minutes after deploying."),
			h("div", { class: "actions" }, key, go), error),
	);
	key.focus();
}

function meter(label, used, limit, fmt) {
	const pct = Math.min(100, (used / limit) * 100);
	const fill = h("div", { class: "fill" });
	fill.style.width = `${pct.toFixed(1)}%`; // a style attribute would break the page's CSP; a style property doesn't
	return h("div", { class: `meter${pct >= 80 ? " high" : ""}` },
		h("div", { class: "meter-row" }, h("span", {}, label), h("span", {}, `${fmt(used)} of ${fmt(limit)}`)),
		h("div", { class: "track", role: "progressbar", "aria-label": label, "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 }, fill));
}

function vaultCard(v) {
	const title = h("h2", {}, v.label || `Vault ${shortId(v.id)}`);
	const rename = h("button", { class: "link", onclick: () => {
		const input = h("input", { type: "text", maxlength: 40, value: v.label, "aria-label": "Vault label", placeholder: "e.g. Personal" });
		const save = async () => { await api(`/api/vaults/${v.id}/label`, { label: input.value }); await load(); };
		input.addEventListener("keydown", (e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") void load(); });
		input.addEventListener("blur", () => void save());
		title.replaceWith(input);
		rename.remove();
		input.focus();
	} }, "Rename");
	const devices = v.devices.length
		? v.devices.map((d) => h("div", { class: "row" },
			h("span", { class: `dot${d.online ? " on" : ""}`, title: d.online ? "Online" : "Offline" }),
			h("span", { class: "name" }, d.id),
			h("span", { class: "grow" }, d.online ? "Online now" : `Last online ${ago(d.lastOnline)}`),
			d.lost ? h("span", { class: "badge warn", title: "Not seen for 30 days. If it's lost, remove it in Obsidian: Settings → Ownsync → Devices." }, "Lost?") : null,
			d.behind ? h("span", { class: "badge amber", title: "Another device runs a newer Ownsync. Update this one in Obsidian." }, `${d.version} · update`) : h("span", { class: "badge" }, d.version || "?")))
		: [h("p", { class: "quiet" }, "No device has reported in yet.")];
	return h("section", { class: "card" },
		h("div", { class: "card-head" }, title, rename),
		h("div", { class: "facts" }, v.label ? h("span", {}, `ID ${shortId(v.id)}`) : null, h("span", {}, size(v.bytes)), h("span", {}, v.lastActivity ? `Last change ${ago(v.lastActivity)}` : "No changes yet")),
		v.conflicts > 0 ? h("div", { class: "note" }, `${v.conflicts} ${v.conflicts === 1 ? "note has" : "notes have"} a conflict copy. In Obsidian, search for "(conflict" and keep what you want.`) : null,
		h("div", { class: "rows" }, devices),
		h("p", { class: "quiet" }, "Devices are named by their random ID, the same one Obsidian shows. Versions and conflicts are as the devices report them."));
}

function connectVault() {
	const box = h("div");
	return h("section", { class: "card" },
		h("h2", {}, "Connect a vault"),
		h("ol", { class: "steps" },
			h("li", {}, "In Obsidian, open Settings → Community plugins and turn them on."),
			h("li", {}, "Choose Browse, search for Ownsync (or ", h("a", { href: "obsidian://show-plugin?id=ownsync" }, "open it directly"), "), then Install and Enable."),
			h("li", {}, "Open the vault you want to sync, then press the button. Its notes upload, encrypted.")),
		box,
		h("div", { class: "actions" }, action("Open in Obsidian", async () => {
			const { code, link } = await api("/api/vault-code", {});
			location.href = link;
			const area = h("textarea", { rows: 3, readonly: true, "aria-label": "Vault code" });
			area.value = code;
			box.replaceChildren(h("p", { class: "quiet" }, "Obsidian didn't open? In Ownsync's setup screen choose Start syncing this vault, and paste this code:"), area,
				h("div", { class: "actions" }, h("button", { class: "button secondary", onclick: () => navigator.clipboard.writeText(code) }, "Copy code")),
				h("p", { class: "quiet" }, "It sets up one vault, within an hour."));
		})),
		h("p", { class: "quiet" }, "More devices for a vault: on a device that already syncs, open Settings → Ownsync → Add a device and scan the code."));
}

function passkeys(list) {
	const rows = list.map((p) => h("div", { class: "row" },
		h("span", { class: "grow" }, `Added ${ago(p.created)}`),
		p.current ? h("span", { class: "badge" }, "This one") : null,
		list.length > 1 ? action("Remove", async () => {
			const options = await api("/api/passkeys/remove/options", {});
			await api("/api/passkeys/remove", { id: p.id, response: await usePasskey(options) });
			await load();
		}, "button danger") : null));
	return h("section", { class: "card" },
		h("h2", {}, "Passkeys"),
		h("div", { class: "rows" }, rows),
		h("p", { class: "quiet" }, "Lost every passkey? Set a new SETUP_KEY in your Cloudflare dashboard, then use it here: that replaces all passkeys."),
		h("div", { class: "actions" }, action("Add a passkey", async () => {
			const options = await api("/api/passkeys/add/options", {});
			await api("/api/passkeys/add", { response: await createPasskey(options) });
			await load();
		}, "button secondary")));
}

function dashboard(o) {
	signout.hidden = false;
	const { usage, limits } = o;
	show(
		h("h1", {}, "Your sync server"),
		h("p", { class: "lead" }, o.origin.replace(/^https?:\/\//, "")),
		h("section", { class: "card" },
			h("h2", {}, "Cloudflare free plan"),
			meter("Storage", usage.bytes, limits.storageBytes, size),
			meter("Requests today", usage.requestsToday, limits.requestsPerDay, count),
			meter("Rows written today", usage.rowsWrittenToday, limits.rowsWrittenPerDay, count),
			h("p", { class: "quiet" }, "Daily counts reset at midnight UTC. Past a limit, syncing pauses until then; nothing is lost.")),
		o.vaults.map(vaultCard),
		connectVault(),
		passkeys(o.passkeys),
	);
}

async function load() {
	try {
		dashboard(await api("/api/overview"));
	} catch (err) {
		if (err.status === 401) signInScreen();
		else show(h("p", { class: "error" }, failure(err)));
	}
}

signout.addEventListener("click", async () => { await api("/api/logout", {}).catch(() => {}); signInScreen("Signed out."); });

if (!window.PublicKeyCredential) show(h("p", { class: "error" }, "This browser doesn't support passkeys. Open this page in a current Safari, Chrome, Edge or Firefox."));
else void load();
