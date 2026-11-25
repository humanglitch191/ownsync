// The owner's site: sign in, first-time setup, and the dashboard. Everything the server sends is shown as text,
// never as HTML.

const app = document.getElementById("app");

// --- helpers ---
function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") el.className = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
	return el;
}
// Icons, from fixed markup in this file only.
const svg = (inner, size = 15, stroke = 2) => {
	const t = document.createElement("template");
	t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
	return t.content.firstChild;
};
const LOCK = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
const CHECK = '<path d="m5 12 5 5 9-10"/>';
const KEY = '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3m-3 3 3 3m-6 0 2 2"/>';
const LAPTOP = '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>';
const PHONE = '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>';
const INFO = '<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>';
const mark = () => h("span", { class: "mark" }, svg(LOCK));
const brand = () => h("div", { class: "brand" }, mark(), "Ownsync");
const note = (icon, text) => h("p", { class: "note" }, svg(icon, 13), h("span", {}, text));

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
const size = (b) => (b < 1e6 ? `${Math.max(0, Math.round(b / 1e3))} KB` : b < 1e9 ? `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB` : `${(b / 1e9).toFixed(2)} GB`);
const count = (n) => Math.round(n).toLocaleString();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const failure = (err) => (cancelled(err) ? "The passkey prompt was closed. Try again." : err?.name === "InvalidStateError" ? "This device already has a passkey for this Worker: sign in with it." : err?.message || String(err));

// A button that runs `fn`, shows it's busy, and shows what went wrong under it.
function action(label, fn, cls = "btn") {
	const error = h("p", { class: "error", hidden: true });
	const button = h("button", { class: cls, onclick: async () => {
		button.disabled = true;
		error.hidden = true;
		try { await fn(); } catch (err) { error.textContent = failure(err); error.hidden = false; } finally { button.disabled = false; }
	} }, label);
	return { button, error };
}

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
	"no setup key": "This Worker has no setup key. In your Cloudflare dashboard, open Workers → this Worker → Settings → Variables and Secrets, and add a secret named SETUP_KEY.",
};

// --- first visit: the same page for everyone, set up or not ---
function welcome(message) {
	const key = h("input", { class: "field", type: "password", "aria-label": "Setup key", autocomplete: "off", placeholder: "The passphrase you chose when deploying" });
	const go = action("Continue", async () => {
		const res = await fetch("/api/setup", { method: "POST", body: await setupProof(key.value) });
		const data = await res.json().catch(() => ({}));
		if (!data.token) throw new Error(SETUP_ERRORS[data.error] || `Something went wrong (${res.status}).`);
		setup(data.token);
	}, "btn primary");
	key.addEventListener("keydown", (e) => { if (e.key === "Enter") go.button.click(); });
	const keybox = h("div", { class: "keybox", hidden: true },
		h("span", { class: "label" }, "Setup key"),
		h("div", { class: "row" }, h("div", { class: "grow" }, key), go.button),
		go.error,
		note(LOCK, "It works once, in the first 10 minutes after you deploy. Only a hash of it leaves this browser."));
	const signIn = action([svg(KEY), "Sign in with passkey"], async () => {
		const options = await api("/api/login/options", {});
		await api("/api/login/verify", { response: await usePasskey(options) });
		await home();
	}, "btn primary");
	show(h("main", { class: "welcome" },
		brand(),
		h("h1", {}, "Your notes, in sync. ", h("span", {}, "Only you can read them.")),
		h("p", { class: "lead" }, "This is your own sync Worker. It relays your Obsidian vault between your devices and only ever sees scrambled data."),
		h("div", { class: "row" }, signIn.button, h("button", { class: "btn", onclick: () => { keybox.hidden = !keybox.hidden; if (!keybox.hidden) key.focus(); } }, "First time? Use setup key")),
		signIn.error,
		message ? h("p", { class: "quiet" }, message) : null,
		keybox,
		h("div", { class: "facts label" }, h("span", {}, "Encrypted on your devices"), h("span", {}, "Your own Worker"), h("span", {}, "No account, nothing collected"))));
}

// --- setup: one task per step on the left; the real dashboard filling in on the right ---
function stepItem(state, title, detail) {
	return h("li", { class: state }, h("span", { class: "c" }, state === "done" ? svg(CHECK, 11, 3) : null), h("div", {}, h("b", {}, title), h("small", {}, detail)));
}

// First run (`token` from the setup key): passkey, connect, phone, done. Another vault (`token` null): the same
// steps from connect on, waiting for a vault that wasn't there before.
async function setup(token) {
	const another = !token;
	const STEPS = another ? ["Connect", "Phone", "Done"] : ["Passkey", "Connect", "Phone", "Done"];
	let at = 0, known = -1, stop = false, overview = null, first = null; // first: the device that connected the vault
	const before = new Set(another ? (await api("/api/overview")).vaults.map((v) => v.id) : []);
	const dots = h("div", { class: "dots" }, STEPS.map(() => h("i")));
	const label = h("span", { class: "label" });
	const pane = h("div", { class: "step" });
	const live = h("div", { class: "inner" });
	show(h("main", { class: "setup-page" }, h("div", { class: "card setup" },
		h("div", { class: "form" }, h("div", { class: "stepper" }, mark(), h("div", { class: "row" }, dots, label)), pane),
		h("div", { class: "preview", "aria-hidden": "true" }, h("div", { class: "window" }, h("div", { class: "bar" }, h("i"), h("i"), h("i"), h("span", {}, location.host)), live)))));

	const step = (name) => STEPS.indexOf(name);
	const go = (i) => {
		at = i;
		[...dots.children].forEach((d, j) => (d.className = j < at ? "done" : j === at ? "now" : ""));
		label.textContent = `${STEPS[at]} · ${at + 1}/${STEPS.length}`;
		pane.replaceChildren(...screens[STEPS[at]]());
		preview();
	};
	const leave = () => { stop = true; void dashboard(); };
	// The vault this setup is about: the first one connected since it began.
	const target = () => (overview?.vaults ?? []).find((v) => !before.has(v.id) && v.devices.length);
	// The right side: what the dashboard shows right now.
	const preview = () => {
		const vault = target();
		if (!vault) {
			if (STEPS[at] === "Passkey") live.replaceChildren(h("div", { class: "skel title" }), ...[1, 2, 3].map(() => h("div", { class: "devrow" }, h("span", { class: "ic ghost" }), h("div", {}, h("div", { class: "skel mid" }), h("div", { class: "skel short" })), h("span"))));
			else live.replaceChildren(h("h3", { class: "appear" }, another ? "Another vault" : "Your sync Worker"), h("div", { class: "card appear" }, h("div", { class: "devrow" }, h("span", { class: "ic ghost" }), h("div", {}, h("div", { class: "skel mid" })), h("span", { class: "label" }, "Waiting"))));
			return;
		}
		live.replaceChildren(h("h3", {}, vaultName(vault)), h("div", { class: "card" },
			vault.devices.map((d) => deviceRow(d, "appear")),
			vault.devices.length < 2 ? h("div", { class: "devrow" }, h("span", { class: "ic ghost" }), h("div", { class: "meta" }, "Your phone goes here"), h("span", { class: "label" }, "Next")) : null));
	};
	// Watches for the vault and devices to arrive, as Obsidian connects.
	const poll = async () => {
		while (!stop) {
			try { overview = await api("/api/overview"); } catch { /* signed out: the next step says so */ }
			if (!app.contains(pane)) return;
			const devices = target()?.devices.length ?? 0;
			if (devices !== known) { known = devices; go(at); }
			await sleep(2000);
		}
	};

	const screens = {
		Passkey: () => {
			const create = action("Create passkey", async () => {
				const options = await api("/api/enrol/options", { token });
				await api("/api/enrol/verify", { token, response: await createPasskey(options) });
				at = step("Connect");
				void poll();
			}, "btn primary");
			return [h("h2", {}, "Add a passkey"),
				h("p", { class: "sub" }, "From now on, this is how you sign in: your fingerprint, face or device PIN. The setup key stops working once it's added."),
				h("div", { class: "grow" }),
				note(INFO, "Your phone, laptop or password manager keeps it. Lost them all? A new setup key gets you back in."),
				h("div", { class: "row actions" }, create.button), create.error];
		},
		Connect: () => {
			const connected = target();
			first ??= connected?.devices[0]?.id ?? null;
			const box = h("div");
			const open = action("Open in Obsidian", async () => {
				const { code, link } = await api("/api/vault-code", {});
				location.href = link;
				box.replaceChildren(h("div", { class: "code" }, h("span", {}, code), h("button", { class: "btn small", onclick: () => navigator.clipboard.writeText(code) }, "Copy code")));
			}, connected ? "btn" : "btn primary");
			return [h("h2", {}, another ? "Connect another vault" : "Connect your first vault"),
				h("p", { class: "sub" }, another ? "Each vault gets its own key. Its notes upload encrypted." : "Its notes upload encrypted. A few thousand notes take about a minute."),
				h("ol", { class: "checks" },
					stepItem(connected ? "done" : "now", "Install Ownsync in Obsidian", another ? "Already there? Skip ahead" : "Settings → Community plugins → Browse, search for Ownsync"),
					stepItem(connected ? "done" : "now", another ? "Open the other vault in Obsidian" : "Open the vault you want to sync", "A new, empty vault is fine too"),
					stepItem(connected ? "done" : "later", "Press Open in Obsidian, then Connect", "Obsidian shows this Worker before anything happens")),
				box,
				connected
					? h("div", { class: "waiting done" }, svg(CHECK, 13, 2.5), h("span", {}, `${vaultName(connected)} is syncing from ${first}`))
					: h("div", { class: "waiting" }, h("span", { class: "pulse" }), "Waiting for Obsidian…"),
				h("div", { class: "grow" }),
				h("div", { class: "row actions" }, connected ? h("button", { class: "btn primary", onclick: () => go(step("Phone")) }, "Continue") : null, open.button,
					another && !connected ? h("button", { class: "btn ghost", onclick: leave }, "Back to dashboard") : null), open.error];
		},
		Phone: () => {
			const vault = target(), two = vault && vault.devices.length > 1;
			const joined = vault?.devices.find((d) => d.id !== first);
			return [h("h2", {}, another ? "Add your phone to it" : "Add your phone"),
				h("p", { class: "sub" }, "In Obsidian on your computer, in this vault: Settings → Ownsync → Add a device. Scan the code with your phone's camera."),
				h("ol", { class: "checks" },
					stepItem("done", `${vault ? vaultName(vault) : "Your vault"} is syncing`, first ? `From ${first}` : ""),
					stepItem(two ? "done" : "now", "Scan the code on your phone", "It hands over the key; this Worker never sees it"),
					stepItem(two ? "done" : "later", "Check both show the same ID", "So you know it's yours")),
				two ? h("div", { class: "waiting done" }, svg(CHECK, 13, 2.5), h("span", {}, `${joined?.name || joined?.id} joined`)) : h("div", { class: "waiting" }, h("span", { class: "pulse" }), "Waiting for your phone…"),
				h("div", { class: "grow" }),
				h("div", { class: "row actions" }, h("button", { class: two ? "btn primary" : "btn", onclick: () => go(step("Done")) }, two ? `Continue with ${plural(vault.devices.length, "device")}` : "Skip for now"))];
		},
		Done: () => [
			h("div", { class: "badge" }, svg(CHECK, 20, 2.5)),
			h("h2", {}, "Nothing slips through now."),
			h("p", { class: "sub" }, "Your vault syncs between your devices, end to end encrypted."),
			h("div", { class: "nextup" },
				h("span", { class: "label" }, "Next up"),
				h("div", {}, h("span", {}, "Keep your recovery kit safe"), h("span", { class: "quiet" }, "Obsidian showed it")),
				h("div", {}, h("span", {}, "Another vault, like Work"), h("span", { class: "quiet" }, "From the dashboard"))),
			h("div", { class: "grow" }),
			h("div", { class: "row actions" }, h("button", { class: "btn primary", onclick: leave }, "Open dashboard")),
		],
	};
	go(0);
	if (another) void poll();
}

// --- dashboard: a sidebar (this vault, then your Worker) and one page at a time ---
// One device: its name (the random ID unless the owner gave it one here), what it is, and when it was last seen.
// `vault`: where it can be renamed (the dashboard, not the setup preview).
function deviceRow(d, extra = "", vault = null) {
	const shown = d.label || d.name; // named here first, then as Obsidian has it; else the random ID
	const kind = [shown ? d.id : null, d.mobile ? "Phone" : "Computer", d.notesOnly ? "notes only" : null, d.version ? `Ownsync ${d.version}` : null].filter(Boolean).join(" · ");
	const name = h("div", { class: `name${shown ? " named" : ""}`, title: vault ? "Click to rename" : null }, shown || d.id);
	if (vault) name.addEventListener("click", () => rename(name, d.label, d.name || d.id, `/api/vaults/${vault}/devices/${d.id}/label`));
	const state = d.online
		? h("span", { class: "state ok" }, h("span", { class: "dot ok" }), "Online now")
		: h("span", { class: "state" }, h("span", { class: "dot" }), `Last seen ${ago(d.lastOnline)}`,
			d.lost ? h("span", { title: "Not seen for 30 days. If it's lost, remove it in Obsidian: Settings → Ownsync → Devices." }, "· lost?") : null);
	if (d.behind) state.append(" · ", h("a", { href: "obsidian://show-plugin?id=ownsync", title: "Another device runs a newer Ownsync" }, "update"));
	return h("div", { class: `devrow ${extra}` }, h("span", { class: "ic" }, svg(d.mobile ? PHONE : LAPTOP, 16, 1.75)), h("div", {}, name, h("div", { class: "meta" }, kind)), state);
}

// Swaps a name for a text box; saving an empty name goes back to the default.
function rename(el, current, placeholder, path) {
	const input = h("input", { class: "rename", maxlength: 40, value: current || "", "aria-label": "Name", placeholder });
	let done = false;
	const save = async () => { if (done) return; done = true; await api(path, { label: input.value }).catch(() => {}); await dashboard(); };
	input.addEventListener("keydown", (e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") { done = true; void dashboard(); } });
	input.addEventListener("blur", () => void save());
	el.replaceWith(input);
	input.focus();
	input.select();
}

// Named here first, then as Obsidian calls it; else its short ID.
const vaultName = (v) => v.label || v.name || `Vault ${shortId(v.id)}`;
const lastSync = (devices) => (devices.some((d) => d.online) ? Date.now() : Math.max(0, ...devices.map((d) => d.lastOnline)) || null);
const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
const listed = (items) => new Intl.ListFormat(undefined, { type: "conjunction" }).format(items);

const GRID = '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>';
const DISK = '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>';
const LAYERS = '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>';
const GAUGE = '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>';
const UPDATE = '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>';
const OUT = '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>';
const UPDOWN = '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>';
const MENU = '<path d="M4 7h16M4 12h16M4 17h16"/>';
const CAMERA = '<path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>';
const PLUS = '<path d="M12 5v14M5 12h14"/>';

// What's on screen: the overview, the vault the sidebar is about, its page, and Clean up's period length.
let o = null, here = { page: "overview", vault: null }, months = 12;
const VAULT_PAGES = ["overview", "devices", "storage"];
const vaultOf = () => o.vaults.find((v) => v.id === here.vault) ?? null;
document.addEventListener("click", () => { for (const m of document.querySelectorAll(".vmenu")) m.hidden = true; });

async function dashboard(page = here.page, vault = here.vault) {
	let buckets = [];
	try {
		o = await api("/api/overview");
		here = { page, vault: (o.vaults.find((v) => v.id === vault) ?? o.vaults[0])?.id ?? null };
		if (!here.vault && VAULT_PAGES.includes(page)) here.page = "vaults";
		if (here.vault && (here.page === "overview" || here.page === "storage")) buckets = await api(`/api/vaults/${here.vault}/cleanup/sizes`, {});
	} catch (err) { return err.status === 401 ? welcome() : show(h("p", { class: "error" }, failure(err))); }
	const moved = app.dataset.page !== here.page;
	show(shell(PAGES[here.page](vaultOf(), buckets)));
	if (moved) scrollTo(0, 0);
	app.dataset.page = here.page;
}

// The vault switcher: this vault and how it syncs; its menu switches vaults or connects another.
function switcher(v, compact = false) {
	const sync = v && lastSync(v.devices);
	const menu = h("div", { class: "vmenu", hidden: true },
		o.vaults.map((x) => h("button", { class: x.id === v?.id ? "on" : "", onclick: () => void dashboard(VAULT_PAGES.includes(here.page) ? here.page : "overview", x.id) }, vaultName(x))),
		h("button", { onclick: () => void setup(null) }, svg(PLUS, 14), "Connect a vault"));
	const button = h("button", { class: compact ? "vpm" : "vp", "aria-haspopup": "menu", onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } },
		compact ? [v ? vaultName(v) : "No vaults yet", svg(UPDOWN, 13)]
			: [h("div", {}, h("b", {}, v ? vaultName(v) : "No vaults yet"), v ? h("small", {}, [plural(v.devices.length, "device"), sync ? `synced ${ago(sync)}` : null].filter(Boolean).join(" · ")) : null), svg(UPDOWN, 14)]);
	return h("div", { class: "vswitch" }, button, menu);
}

function shell(content) {
	const v = vaultOf();
	const nav = (page, icon, label, n) => h("button", { class: `nav${here.page === page ? " on" : ""}`, "aria-current": here.page === page ? "page" : null, onclick: () => void dashboard(page) }, svg(icon, 15, 1.8), label, n != null ? h("span", { class: "n" }, n) : null);
	const side = h("aside", { class: "sidebar" },
		h("div", { class: "brand" }, mark(), "Ownsync"),
		switcher(v),
		v ? [nav("overview", GRID, "Overview"), nav("devices", LAPTOP, "Devices", v.devices.length), nav("storage", DISK, "Storage", size(v.bytes))] : null,
		h("div", { class: "nl" }, "Your Worker"),
		nav("vaults", LAYERS, "All vaults", o.vaults.length), nav("usage", GAUGE, "Usage"), nav("updates", UPDATE, "Updates", o.version),
		h("div", { class: "grow" }),
		nav("passkeys", KEY, "Passkeys"),
		h("button", { class: "nav", onclick: async () => { await api("/api/logout", {}).catch(() => {}); welcome("Signed out."); } }, svg(OUT, 15, 1.8), "Sign out"));
	const menu = h("button", { class: "menu", "aria-label": "Menu", "aria-expanded": "false", onclick: () => menu.setAttribute("aria-expanded", String(side.classList.toggle("open"))) }, svg(MENU, 20));
	return h("div", { class: "shell" },
		h("div", { class: "mtop" }, mark(), switcher(v, true), menu),
		v ? h("nav", { class: "mtabs" }, [["overview", "Overview"], ["devices", "Devices"], ["storage", "Storage"]].map(([p, label]) => h("button", { class: here.page === p ? "on" : "", onclick: () => void dashboard(p) }, label))) : null,
		h("div", { class: "app" }, side, h("main", {}, h("div", { class: "wrap" }, content))));
}

const head = (crumb, title) => [h("div", { class: "crumb" }, crumb), h("h1", {}, title)];
const flowOf = () => (o.repo ? `https://github.com/${o.repo}/actions/workflows/update-ownsync.yml` : null);
const NOTICE = "ownsync-notice-0.1.1";

// A newer Ownsync comes first; otherwise what's new in this one, until dismissed.
function notice(dismissable = true) {
	const flow = flowOf();
	if (o.update) return h("div", { class: "card notice" }, h("span", { class: "label" }, "Update"),
		h("p", {}, flow ? `Ownsync ${o.update} is out. Press Update, then Run workflow on GitHub; Cloudflare redeploys your Worker.` : `Ownsync ${o.update} is out. On GitHub, open your Ownsync repository → Actions → Update Ownsync → Run workflow. Cloudflare redeploys your Worker.`,
			o.autoUpdate ? h("span", { class: "quiet" }, " Updates install on their own after 3 days.") : null),
		flow ? h("a", { class: "btn primary small", href: flow }, "Update") : null,
		h("a", { href: "https://github.com/humanglitch191/ownsync/blob/main/docs/updating.md" }, "How"));
	if (!dismissable || localStorage.getItem(NOTICE)) return null;
	return h("div", { class: "card notice" }, h("span", { class: "label" }, "New"),
		h("p", {}, "Phones can sync notes only now, and skip attachments: Settings → Ownsync → Sync attachments."),
		h("button", { "aria-label": "Dismiss", onclick: (e) => { localStorage.setItem(NOTICE, "1"); e.target.closest(".notice").remove(); } }, "×"));
}

const conflicts = (v) => (v.conflicts > 0 ? h("div", { class: "devrow flag" }, h("span", { class: "ic" }, "!"), h("div", {}, h("div", {}, `${plural(v.conflicts, "note")} ${v.conflicts === 1 ? "has" : "have"} a conflict copy`), h("div", { class: "meta" }, "Search for “(conflict” in Obsidian and keep what you want")), h("span")) : null);
const deviceCard = (v) => h("section", { class: "card list" },
	v.devices.length ? v.devices.map((d) => deviceRow(d, "", v.id)) : h("div", { class: "devrow" }, h("span", { class: "ic ghost" }), h("div", { class: "meta" }, "No device has reported in yet."), h("span")),
	conflicts(v));

// What the vault's storage is made of. Old attachment history: what Clean up lists (every period, the current one too).
function sizeBar(v, buckets) {
	const old = sum(buckets, (b) => b.old + b.deleted), snap = sum(v.snapshots, (s) => s.size), back = v.historyCopies.bytes;
	const parts = [["notes", "Notes and current attachments", Math.max(0, v.bytes - old - snap - back)], ["snap", "Snapshots", snap], ["back", "History backup", back], ["old", "Old attachment history", old]];
	// A style property, not a style attribute: the page's content security policy forbids those.
	return [h("div", { class: "split" }, parts.filter((p) => p[2] > 0).map(([c, , b]) => { const i = h("i", { class: c }); i.style.flex = String(b); return i; })),
		h("div", { class: "legend" }, parts.map(([c, label, b]) => h("div", {}, h("span", { class: `sw ${c}` }), label, h("b", {}, size(b)))))];
}

function meterTile(title, used, limit, fmt, ctx, history) {
	const pct = Math.min(100, (used / limit) * 100);
	const tile = h("div", { class: `card tile${pct >= 80 ? " high" : ""}` }, h("span", { class: "label" }, title));
	const big = h("div", { class: "big" }, fmt(used), " ", h("small", {}, `of ${fmt(limit)}`));
	if (history) {
		const yesterday = history.at(-2)?.v, today = history.at(-1)?.v ?? 0;
		if (yesterday) {
			const change = Math.round((today / yesterday - 1) * 100);
			big.append(h("span", { class: `delta${change > 0 ? " up" : ""}`, title: "Compared with yesterday" }, `${change > 0 ? "+" : ""}${change}%`));
		}
	}
	tile.append(big, h("div", { class: "ctx" }, ctx));
	if (history) {
		const max = Math.max(1, ...history.map((d) => d.v));
		tile.append(h("div", { class: "bars", title: "The last 14 days" }, history.map((d) => { const b = h("i"); b.style.height = `${Math.max(4, (d.v / max) * 100)}%`; return b; })));
	} else {
		tile.append(h("div", { class: "segs", title: `${pct.toFixed(1)}% used` }, Array.from({ length: 24 }, (_, i) => h("i", { class: i < Math.max(1, Math.round((pct / 100) * 24)) ? "on" : "" }))));
	}
	return tile;
}

// The last 14 days, one value a day, today last; a day with nothing is zero.
function days(history, key) {
	const today = Math.floor(Date.now() / 86400000), by = new Map(history.map((d) => [d.day, d[key]]));
	return Array.from({ length: 14 }, (_, i) => ({ v: by.get(today - 13 + i) ?? 0 }));
}

function connectPanel() {
	return h("div", { class: "stack" },
		h("div", { class: "card panel" },
			h("h4", {}, "Add a device"),
			h("ol", { class: "checks" },
				stepItem("now", "Install Ownsync on it", "Settings → Community plugins → Browse"),
				stepItem("later", "Show a code on a synced device", "Settings → Ownsync → Add a device"),
				stepItem("later", "Scan it and compare IDs", "Both show the new device's ID")),
			h("button", { class: "btn wide", onclick: () => void setup(null) }, "Connect another vault")),
		note(LOCK, "This page sees when devices connect and how much is stored. Never a note, a file name or a key."));
}

// --- Clean up: removable history by calendar period, in this browser's time zone (DESIGN.md section 10) ---
const VIEWS = [["Month", 1], ["Quarter", 3], ["Half-year", 6], ["Year", 12]];
const monthName = new Intl.DateTimeFormat(undefined, { month: "short" });
const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

// The month, quarter, half-year or year holding `t` here: its start and end (ms), and its name.
function period(t, months) {
	const d = new Date(t), y = d.getFullYear(), m = d.getMonth() - (d.getMonth() % months);
	const start = new Date(y, m, 1).getTime(), end = new Date(y, m + months, 1).getTime();
	const label = months === 12 ? String(y) : months === 1 ? monthYear.format(start) : `${monthName.format(start)}–${monthName.format(new Date(y, m + months - 1, 1))} ${y}`;
	return { start, end, label };
}

const FAILED = "Couldn't save. Try again.";

// A small yes/no before deleting; `go` throws when it didn't work.
function confirmDialog(title, text, keep, yes, go) {
	const dialog = h("dialog", { class: "card dlg" }, h("h3", {}, title), h("p", {}, text),
		h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => dialog.remove() }, keep),
			h("button", { class: "btn danger", onclick: async (e) => { e.currentTarget.disabled = true; await go().finally(() => dialog.remove()); } }, yes)));
	dialog.addEventListener("close", () => dialog.remove()); // Esc
	document.body.append(dialog);
	dialog.showModal();
}

// Snapshots or history backup: an Off/On switch for every device of the vault (null: not chosen yet), what's kept,
// and deleting it all. A save or delete that fails says so under the card; the switch goes back.
function settingCard(v, key, title, detail, lines, total, del) {
	let on = v.settings?.[key] ?? null;
	const error = h("p", { class: "error cerr", hidden: true }, FAILED);
	const unset = h("p", { class: "unset" }, "Not chosen yet — each device uses its own setting.");
	const buttons = [false, true].map((value) => h("button", { onclick: () => void set(value) }, value ? "On" : "Off"));
	const paint = () => { buttons.forEach((b, i) => { b.className = on === !!i ? "on" : ""; b.setAttribute("aria-pressed", String(on === !!i)); }); unset.hidden = on !== null; };
	const set = async (value) => {
		if (value === on) return;
		const was = on;
		on = value;
		error.hidden = true;
		paint();
		try { await api(`/api/vaults/${v.id}/settings`, { [key]: value }); v.settings[key] = value; } catch { on = was; paint(); error.hidden = false; }
	};
	paint();
	const remove = del && h("button", { class: "btn small danger", onclick: () => confirmDialog(...del.ask, async () => {
		try { await api(`/api/vaults/${v.id}/${del.path}/clear`, {}); await dashboard("storage"); } catch { error.hidden = false; }
	}) }, del.label);
	return h("section", { class: "card", id: `card-${key}` },
		h("div", { class: "ch" }, h("div", {}, h("h3", {}, title), h("p", {}, detail)), h("div", { class: "seg", role: "group", "aria-label": title }, buttons)),
		unset, lines, h("div", { class: "cf" }, total, remove), error);
}

const line = (icon, label, right) => h("div", { class: "lr" }, svg(icon, 14, 1.8), h("span", {}, label), h("span", { class: "r" }, right));
const dayOf = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const dayLabel = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
function when(t) {
	const back = Math.round((dayOf(Date.now()) - dayOf(t)) / 86400000), time = new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `${back === 0 ? "Today" : back === 1 ? "Yesterday" : dayLabel(t)}, ${time}`;
}

function migrationCard(v) {
	const error = h("p", { class: "error cerr", hidden: true }, FAILED);
	const button = h("button", { class: "btn primary", onclick: async () => {
		button.disabled = true;
		try { await api(`/api/vaults/${v.id}/migrate`, {}); await dashboard("storage"); }
		catch { error.hidden = false; button.disabled = false; }
	} }, "Migrate now");
	return h("section", { class: "card" }, h("h3", {}, "Vault sync migration"),
		h("p", {}, v.migration === "failedToday" ? "Migration could not complete today. The vault still uses legacy sync." : v.migration === "requested" ? "Waiting for an updated device to complete migration." :
			"Migration normally waits until every recently active device has updated. Migrating now requires older devices to update before syncing again."),
		v.migration === "requested" ? null : button, error);
}

function storagePage(v, buckets) {
	const view = VIEWS.find(([, m]) => m === months)[0];
	const current = period(Date.now(), months), periods = new Map([[current.start, { ...current, old: 0, deleted: 0 }]]);
	for (const b of buckets) {
		const p = period(b.at, months);
		if (!periods.has(p.start)) periods.set(p.start, { ...p, old: 0, deleted: 0 });
		const row = periods.get(p.start);
		row.old += b.old;
		row.deleted += b.deleted;
	}
	const rows = [...periods.values()].sort((a, b) => b.start - a.start), selected = new Set();
	const bytes = (r) => r.old + r.deleted;
	const removable = rows.filter((r) => r.end <= current.start && bytes(r)); // only past periods can be removed
	const total = () => sum([...selected], bytes);
	const summary = h("span"), remove = h("button", { class: "btn primary", onclick: () => review(v, rows, selected) });
	const update = () => {
		summary.replaceChildren(h("b", {}, plural(selected.size, "period")), ` selected · ${size(total())}`);
		remove.textContent = `Remove ${size(total())} of history`;
		remove.disabled = !total();
	};
	const list = rows.map((r) => {
		const box = h("input", { type: "checkbox", class: "box", disabled: !removable.includes(r) });
		box.addEventListener("change", () => { if (box.checked) selected.add(r); else selected.delete(r); update(); });
		const parts = [r.old ? `Old attachment versions ${size(r.old)}` : null, r.deleted ? `Deleted attachments ${size(r.deleted)}` : null].filter(Boolean);
		return h("label", { class: `period${r.start === current.start ? " cur" : ""}` }, box,
			h("div", {}, h("b", {}, r.label), r.start === current.start ? h("span", { class: "tag" }, "current") : null, h("p", { class: "quiet" }, parts.join(" · ") || "Nothing to remove")),
			h("span", { class: "size" }, size(bytes(r))));
	});
	update();

	const snaps = v.snapshots, shown = snaps.length > 3 ? 2 : 3;
	const snapLines = snaps.slice(0, shown).map((s) => line(CAMERA, when(s.at), size(s.size)));
	if (snaps.length > 3) snapLines.push(line(CAMERA, [dayLabel(snaps[2].at), " ", h("span", { class: "m" }, `and ${snaps.length - 3} more`)], size(sum(snaps.slice(2), (s) => s.size))));
	const copies = v.historyCopies;
	return [head(vaultName(v), "Storage"),
		h("p", { class: "lede" }, h("b", {}, size(v.bytes)), " on your Worker.",
			removable.length ? [" ", h("b", {}, size(sum(removable, bytes))), ` of it is attachment history from ${listed(removable.map((r) => r.label).reverse())} that you can remove.`] : null),
		sizeBar(v, buckets),
		...(v.migration === "failedToday" || v.migration === "legacy" || v.migration === "requested" ? [migrationCard(v)] : []),
		h("div", { class: "cols" },
			h("section", { class: "card" },
				h("div", { class: "ch col" }, h("div", {}, h("h3", {}, "Clean up"), h("p", {}, "Old versions of attachments and attachments you deleted, by period. Notes and current attachments are never touched.")),
					h("div", { class: "seg", role: "group", "aria-label": "Periods" }, VIEWS.map(([label, m]) => h("button", { class: m === months ? "on" : "", "aria-pressed": String(m === months), onclick: () => { months = m; void dashboard("storage"); } }, label)))),
				h("div", { class: "periods" }, list), // compact rows that scroll inside the card once there are many (months over years)
				h("p", { class: "cnote" }, `The current ${view.toLowerCase()} can be cleaned up once it is over. Past periods only.`),
				h("div", { class: "cf total" }, summary, remove)),
			h("div", { class: "stack" },
				settingCard(v, "snapshots", "Snapshots", "Once a day, an encrypted copy of the whole vault. Kept for 30 days.", snapLines,
					snaps.length ? `${plural(snaps.length, "snapshot")} · ${size(sum(snaps, (s) => s.size))}` : plural(0, "snapshot"),
					snaps.length ? { label: "Delete all", path: "snapshots", ask: ["Delete all snapshots?", "This permanently deletes all vault snapshots from your Worker.", "Cancel", "Delete all snapshots"] } : null),
				settingCard(v, "historyBackup", "History backup", "Encrypted copies of the notes each device edits, kept 30 days.", null,
					`${count(copies.copies)} ${copies.copies === 1 ? "copy" : "copies"}${copies.copies ? ` · ${size(copies.bytes)}` : ""}`,
					copies.copies ? { label: "Delete history backups", path: "history", ask: ["Delete history backups?", "This permanently deletes the history backups on your Worker, the copies from all your devices.", "Keep backups", "Delete backups"] } : null)))];
}

// The review before removing: how much goes, what goes and what stays; Remove waits for the tick.
function review(v, rows, selected) {
	const chosen = rows.filter((r) => selected.has(r)).reverse(), kept = rows.filter((r) => !selected.has(r) && r.old + r.deleted);
	const old = sum(chosen, (r) => r.old), deleted = sum(chosen, (r) => r.deleted);
	const l = (k, v, stay) => h("div", { class: `l${stay ? " stay" : ""}` }, h("span", {}, stay ? svg(CHECK, 13, 2.2) : null, k), h("span", {}, v));
	const tick = h("input", { type: "checkbox", class: "box" });
	const error = h("p", { class: "error", hidden: true }, FAILED);
	const go = h("button", { class: "btn primary", disabled: true, onclick: async () => {
		go.disabled = true;
		error.hidden = true;
		try {
			// Explicit ranges, all before the current period; the Worker checks that on its own clock, and removes a
			// bounded amount at a time.
			const body = { ranges: chosen.map((r) => [r.start, r.end]), zone: Intl.DateTimeFormat().resolvedOptions().timeZone, months };
			for (let more = true; more;) ({ more } = await api(`/api/vaults/${v.id}/cleanup`, body));
			dialog.remove();
			await dashboard("storage");
		} catch { error.hidden = false; go.disabled = !tick.checked; }
	} }, `Remove ${size(old + deleted)} of history`);
	tick.addEventListener("change", () => { go.disabled = !tick.checked; });
	const dialog = h("dialog", { class: "card dlg review", "aria-label": "Review" },
		h("h3", {}, "Review"),
		h("div", { class: "big" }, size(old + deleted)),
		h("p", { class: "lead" }, `leaves ${vaultName(v)}’s storage, from ${listed(chosen.map((r) => r.label))}.`),
		h("div", { class: "ledger" },
			h("div", { class: "k" }, "Removed"),
			old ? l("Old attachment versions", size(old)) : null,
			deleted ? l("Deleted attachments", size(deleted)) : null,
			h("div", { class: "k" }, "Stays"),
			l("Every note", "as is", true), l("Current attachments", "as is", true),
			kept.map((r) => l(`${r.label} history`, size(r.old + r.deleted), true))),
		h("label", { class: "confirm" }, tick, h("span", {}, "I understand old versions from these periods can’t be brought back.")),
		go, h("button", { class: "btn", onclick: () => dialog.remove() }, "Cancel"), error);
	dialog.addEventListener("close", () => dialog.remove()); // Esc
	document.body.append(dialog);
	dialog.showModal();
}

const PAGES = {
	overview: (v, buckets) => {
		const sync = lastSync(v.devices);
		return [head(vaultName(v), "Overview"), notice(),
			h("p", { class: "lede" }, h("b", {}, plural(v.devices.length, "device")), ". ", sync ? ["Last sync ", h("b", {}, ago(sync)), "."] : "No device has synced yet.", " ", h("b", {}, size(v.bytes)), " on your Worker."),
			sizeBar(v, buckets), deviceCard(v)];
	},
	devices: (v) => [head(vaultName(v), "Devices"), h("div", { class: "cols" }, deviceCard(v), connectPanel())],
	storage: storagePage,
	vaults: () => {
		const devices = sum(o.vaults, (v) => v.devices.length);
		return [head("Your Worker", "All vaults"),
			h("p", { class: "lede" }, o.vaults.length
				? [h("b", {}, plural(o.vaults.length, "vault")), " across ", h("b", {}, plural(devices, "device")), ". ", o.lastSync ? ["Last sync ", h("b", {}, ago(o.lastSync)), "."] : "No device has synced yet."]
				: ["No vaults yet. ", h("b", {}, "Connect your first one"), "."]),
			h("div", { class: "cols" },
				h("section", { class: "card list" }, o.vaults.length ? o.vaults.map((v) => {
					const title = h("div", { class: "name named", title: "Click to rename" }, vaultName(v));
					title.addEventListener("click", () => rename(title, v.label, v.name || "e.g. Personal", `/api/vaults/${v.id}/label`));
					return h("div", { class: "devrow" }, h("span", { class: "ic" }, svg(DISK, 16, 1.75)),
						h("div", {}, title, h("div", { class: "meta" }, [plural(v.devices.length, "device"), size(v.bytes), v.lastActivity ? `changed ${ago(v.lastActivity)}` : null].filter(Boolean).join(" · "))),
						h("button", { class: "btn small", onclick: () => void dashboard("overview", v.id) }, "Open"));
				}) : h("div", { class: "empty" }, h("p", { class: "quiet" }, "No vaults yet. Press Connect another vault to connect your first."))),
				connectPanel())];
	},
	usage: () => {
		const { usage, limits } = o;
		return [head("Your Worker", "Usage"),
			h("div", { class: "tiles" },
				meterTile("Storage", usage.bytes, limits.storageBytes, size, "Cloudflare free plan, all vaults together."),
				meterTile("Requests today", usage.requestsToday, limits.requestsPerDay, count, "Resets at midnight UTC.", days(usage.history ?? [], "requests")),
				meterTile("Rows written today", usage.rowsWrittenToday, limits.rowsWrittenPerDay, count, "Roughly one per saved edit.", days(usage.history ?? [], "rows"))),
			h("p", { class: "quiet" }, "Workers Free plan · ", h("a", { href: "https://github.com/humanglitch191/ownsync/blob/main/docs/cost-and-limits.md" }, "what Paid adds"))];
	},
	updates: () => {
		const flow = flowOf();
		return [head("Your Worker", "Updates"), notice(false),
			h("p", { class: "quiet" }, `Ownsync ${o.version}${o.deployed ? `, updated ${new Date(o.deployed).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : ""} · your Worker`,
				flow ? [h("br"), h("a", { href: flow }, "Stay on this version"), " (turn off automatic updates: on GitHub, ⋯ → Disable workflow)"] : null)];
	},
	passkeys: () => {
		const add = action("Add a passkey", async () => {
			const options = await api("/api/passkeys/add/options", {});
			await api("/api/passkeys/add", { response: await createPasskey(options) });
			await dashboard("passkeys");
		}, "btn");
		return [head("Your Worker", "Passkeys"),
			h("p", { class: "lede" }, h("b", {}, plural(o.passkeys.length, "passkey")), " can sign in here."),
			h("div", { class: "passkeys" },
				h("section", { class: "card list" }, o.passkeys.map((p) => {
					const remove = action("Remove", async () => {
						const options = await api("/api/passkeys/remove/options", {});
						await api("/api/passkeys/remove", { id: p.id, response: await usePasskey(options) });
						await dashboard("passkeys");
					}, "btn small danger");
					return h("div", { class: "devrow" }, h("span", { class: "ic" }, svg(KEY, 16, 1.75)), h("div", {}, h("div", {}, p.current ? "This one" : "Passkey"), h("div", { class: "meta" }, `Added ${ago(p.created)}`)), o.passkeys.length > 1 ? h("div", {}, remove.button, remove.error) : h("span"));
				})),
				h("div", { class: "row actions" }, add.button), add.error,
				h("p", { class: "quiet" }, "Lost every passkey? Set a new SETUP_KEY in your Cloudflare dashboard and use it here: that replaces all passkeys."))];
	},
};

// Obsidian's "Add another vault" opens /#connect: straight into the steps, once signed in. Its "Clean up storage…"
// (/#cleanup/<vault>) and "Snapshots and history backup" (/#settings/<vault>) open that vault's Storage page.
let pending = /^#(connect|(?:cleanup|settings)\/[0-9a-f]{32})$/.exec(location.hash)?.[1] ?? null;
if (location.hash) history.replaceState(null, "", location.pathname);
async function home() {
	if (!pending) return dashboard();
	try { await api("/api/overview"); } catch (err) { return err.status === 401 ? welcome() : show(h("p", { class: "error" }, failure(err))); }
	const start = pending;
	pending = null;
	const [page, id] = start.split("/");
	return page === "connect" ? setup(null) : dashboard("storage", id);
}

if (!window.PublicKeyCredential) show(h("main", { class: "welcome" }, brand(), h("p", { class: "error" }, "This browser doesn't support passkeys. Open this page in a current Safari, Chrome, Edge or Firefox.")));
else void home();
