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
	for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
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
const failure = (err) => (cancelled(err) ? "The passkey prompt was closed. Try again." : err?.name === "InvalidStateError" ? "This device already has a passkey for this server: sign in with it." : err?.message || String(err));

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
	"no setup key": "This server has no setup key. In your Cloudflare dashboard, open Workers → this Worker → Settings → Variables and Secrets, and add a secret named SETUP_KEY.",
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
		await dashboard();
	}, "btn primary");
	show(h("main", { class: "welcome" },
		brand(),
		h("h1", {}, "Your notes, in sync. ", h("span", {}, "Only you can read them.")),
		h("p", { class: "lead" }, "This is your own sync server. It relays your Obsidian vault between your devices and only ever sees scrambled data."),
		h("div", { class: "row" }, signIn.button, h("button", { class: "btn", onclick: () => { keybox.hidden = !keybox.hidden; if (!keybox.hidden) key.focus(); } }, "First time? Use setup key")),
		signIn.error,
		message ? h("p", { class: "quiet" }, message) : null,
		keybox,
		h("div", { class: "facts label" }, h("span", {}, "Encrypted on your devices"), h("span", {}, "Your own server"), h("span", {}, "No account, nothing collected"))));
}

// --- setup: one task per step on the left; the real dashboard filling in on the right ---
function stepItem(state, title, detail) {
	return h("li", { class: state }, h("span", { class: "c" }, state === "done" ? svg(CHECK, 11, 3) : null), h("div", {}, h("b", {}, title), h("small", {}, detail)));
}

function setup(token) {
	const STEPS = ["Passkey", "Connect", "Phone", "Done"];
	let at = 0, known = -1, stop = false, overview = null, first = null; // first: the device that connected the vault
	const dots = h("div", { class: "dots" }, STEPS.map(() => h("i")));
	const label = h("span", { class: "label" });
	const pane = h("div", { class: "step" });
	const live = h("div", { class: "inner" });
	show(h("main", { class: "setup-page" }, h("div", { class: "card setup" },
		h("div", { class: "form" }, h("div", { class: "stepper" }, mark(), h("div", { class: "row" }, dots, label)), pane),
		h("div", { class: "preview", "aria-hidden": "true" }, h("div", { class: "window" }, h("div", { class: "bar" }, h("i"), h("i"), h("i"), h("span", {}, location.host)), live)))));

	const go = (i) => {
		at = i;
		[...dots.children].forEach((d, j) => (d.className = j < at ? "done" : j === at ? "now" : ""));
		label.textContent = `${STEPS[at]} · ${at + 1}/${STEPS.length}`;
		pane.replaceChildren(...screens[at]());
		preview();
	};
	// The right side: what the dashboard shows right now.
	const preview = () => {
		const vault = (overview?.vaults ?? []).find((v) => v.devices.length);
		if (!vault) {
			if (at === 0) live.replaceChildren(h("div", { class: "skel title" }), ...[1, 2, 3].map(() => h("div", { class: "devrow" }, h("span", { class: "ic ghost" }), h("div", {}, h("div", { class: "skel mid" }), h("div", { class: "skel short" })), h("span"))));
			else live.replaceChildren(h("h3", { class: "appear" }, "Your sync server"), h("div", { class: "card appear" }, h("div", { class: "devrow" }, h("span", { class: "ic ghost" }), h("div", {}, h("div", { class: "skel mid" })), h("span", { class: "label" }, "Waiting"))));
			return;
		}
		live.replaceChildren(h("h3", {}, vault.label || `Vault ${shortId(vault.id)}`), h("div", { class: "card" },
			vault.devices.map((d) => deviceRow(d, "appear")),
			vault.devices.length < 2 ? h("div", { class: "devrow" }, h("span", { class: "ic ghost" }), h("div", { class: "meta" }, "Your phone goes here"), h("span", { class: "label" }, "Next")) : null));
	};
	// Watches for the vault and devices to arrive, as Obsidian connects.
	const poll = async () => {
		while (!stop) {
			try { overview = await api("/api/overview"); } catch { /* signed out: the next step says so */ }
			if (!app.contains(pane)) return;
			const devices = overview?.vaults.reduce((n, v) => n + v.devices.length, 0) ?? 0;
			if (devices !== known) { known = devices; go(at); }
			await sleep(2000);
		}
	};

	const screens = [
		() => {
			const create = action("Create passkey", async () => {
				const options = await api("/api/enrol/options", { token });
				await api("/api/enrol/verify", { token, response: await createPasskey(options) });
				at = 1;
				void poll();
			}, "btn primary");
			return [h("h2", {}, "Add a passkey"),
				h("p", { class: "sub" }, "From now on, this is how you sign in: your fingerprint, face or device PIN. The setup key stops working once it's added."),
				h("div", { class: "grow" }),
				note(INFO, "Your phone, laptop or password manager keeps it. Lost them all? A new setup key gets you back in."),
				h("div", { class: "row actions" }, create.button), create.error];
		},
		() => {
			const connected = (overview?.vaults ?? []).find((v) => v.devices.length);
			first ??= connected?.devices[0]?.id ?? null;
			const box = h("div");
			const open = action("Open in Obsidian", async () => {
				const { code, link } = await api("/api/vault-code", {});
				location.href = link;
				box.replaceChildren(h("div", { class: "code" }, h("span", {}, code), h("button", { class: "btn small", onclick: () => navigator.clipboard.writeText(code) }, "Copy code")));
			}, connected ? "btn" : "btn primary");
			return [h("h2", {}, "Connect your first vault"),
				h("p", { class: "sub" }, "Its notes upload encrypted. A few thousand notes take about a minute."),
				h("ol", { class: "checks" },
					stepItem(connected ? "done" : "now", "Install Ownsync in Obsidian", "Settings → Community plugins → Browse, search for Ownsync"),
					stepItem(connected ? "done" : "now", "Open the vault you want to sync", "A new, empty vault is fine too"),
					stepItem(connected ? "done" : "later", "Press Open in Obsidian, then Connect", "Obsidian shows this server before anything happens")),
				box,
				connected
					? h("div", { class: "waiting done" }, svg(CHECK, 13, 2.5), h("span", {}, `${connected.label || `Vault ${shortId(connected.id)}`} is syncing from ${first}`))
					: h("div", { class: "waiting" }, h("span", { class: "pulse" }), "Waiting for Obsidian…"),
				h("div", { class: "grow" }),
				h("div", { class: "row actions" }, connected ? h("button", { class: "btn primary", onclick: () => go(2) }, "Continue") : null, open.button), open.error];
		},
		() => {
			const vault = (overview?.vaults ?? []).find((v) => v.devices.length), two = vault && vault.devices.length > 1;
			const joined = vault?.devices.find((d) => d.id !== first);
			return [h("h2", {}, "Add your phone"),
				h("p", { class: "sub" }, "In Obsidian on your computer: Settings → Ownsync → Add a device. Scan the code with your phone's camera."),
				h("ol", { class: "checks" },
					stepItem("done", `${vault?.label || "Your vault"} is syncing`, first ? `From ${first}` : ""),
					stepItem(two ? "done" : "now", "Scan the code on your phone", "It hands over the key; this server never sees it"),
					stepItem(two ? "done" : "later", "Check both show the same ID", "So you know it's yours")),
				two ? h("div", { class: "waiting done" }, svg(CHECK, 13, 2.5), h("span", {}, `${joined?.id} joined`)) : h("div", { class: "waiting" }, h("span", { class: "pulse" }), "Waiting for your phone…"),
				h("div", { class: "grow" }),
				h("div", { class: "row actions" }, h("button", { class: two ? "btn primary" : "btn", onclick: () => go(3) }, two ? `Continue with ${plural(vault.devices.length, "device")}` : "Skip for now"))];
		},
		() => [
			h("div", { class: "badge" }, svg(CHECK, 20, 2.5)),
			h("h2", {}, "Nothing slips through now."),
			h("p", { class: "sub" }, "Your vault syncs between your devices, end to end encrypted."),
			h("div", { class: "nextup" },
				h("span", { class: "label" }, "Next up"),
				h("div", {}, h("span", {}, "Keep your recovery kit safe"), h("span", { class: "quiet" }, "Obsidian showed it")),
				h("div", {}, h("span", {}, "Another vault, like Work"), h("span", { class: "quiet" }, "From the dashboard"))),
			h("div", { class: "grow" }),
			h("div", { class: "row actions" }, h("button", { class: "btn primary", onclick: () => { stop = true; void dashboard(); } }, "Open dashboard")),
		],
	];
	go(0);
}

// --- dashboard ---
// One device: its name (the random ID unless the owner gave it one here), what it is, and when it was last seen.
// `vault`: where it can be renamed (the dashboard, not the setup preview).
function deviceRow(d, extra = "", vault = null) {
	const kind = [d.label ? d.id : null, d.mobile ? "Phone" : "Computer", d.notesOnly ? "notes only" : null, d.version ? `Ownsync ${d.version}` : null].filter(Boolean).join(" · ");
	const name = h("div", { class: `name${d.label ? " named" : ""}`, title: vault ? "Click to rename" : null }, d.label || d.id);
	if (vault) name.addEventListener("click", () => rename(name, d.label, d.id, `/api/vaults/${vault}/devices/${d.id}/label`));
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

function vaultSection(v) {
	const title = h("h3", { title: "Click to rename" }, v.label || `Vault ${shortId(v.id)}`);
	title.addEventListener("click", () => rename(title, v.label, "e.g. Personal", `/api/vaults/${v.id}/label`));
	return h("div", { class: "vault" },
		h("div", { class: "section" }, title, h("span", { class: "label" }, [size(v.bytes), v.lastActivity ? `changed ${ago(v.lastActivity)}` : null].filter(Boolean).join(" · "))),
		h("div", { class: "card" },
			v.devices.length ? v.devices.map((d) => deviceRow(d, "", v.id)) : h("div", { class: "devrow" }, h("span", { class: "ic ghost" }), h("div", { class: "meta" }, "No device has reported in yet."), h("span")),
			v.conflicts > 0 ? h("div", { class: "devrow flag" }, h("span", { class: "ic" }, "!"), h("div", {}, h("div", {}, `${plural(v.conflicts, "note")} ${v.conflicts === 1 ? "has" : "have"} a conflict copy`), h("div", { class: "meta" }, "Search for “(conflict” in Obsidian and keep what you want")), h("span")) : null));
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
		// A style property, not a style attribute: the page's content security policy forbids those.
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
	const box = h("div");
	const open = action("Connect another vault", async () => {
		const { code, link } = await api("/api/vault-code", {});
		location.href = link;
		const area = h("textarea", { rows: 3, readonly: true, "aria-label": "Vault code" });
		area.value = code;
		box.replaceChildren(h("p", { class: "quiet" }, "Obsidian didn't open? Open the vault, and in Ownsync's setup screen choose Start syncing this vault and paste:"), area);
	}, "btn wide");
	return h("div", { class: "side" },
		h("div", { class: "card panel" },
			h("h4", {}, "Add a device"),
			h("ol", { class: "checks" },
				stepItem("now", "Install Ownsync on it", "Settings → Community plugins → Browse"),
				stepItem("later", "Show a code on a synced device", "Settings → Ownsync → Add a device"),
				stepItem("later", "Scan it and compare IDs", "Both show the new device's ID")),
			open.button, open.error, box),
		note(LOCK, "This page sees when devices connect and how much is stored. Never a note, a file name or a key."));
}

function topBar(current) {
	return h("header", { class: "top" }, brand(), h("nav", {},
		h("button", { class: `link${current === "overview" ? " on" : ""}`, onclick: () => void dashboard() }, "Overview"),
		h("button", { class: `link${current === "passkeys" ? " on" : ""}`, onclick: () => void passkeys() }, "Passkeys"),
		h("button", { class: "link", onclick: async () => { await api("/api/logout", {}).catch(() => {}); welcome("Signed out."); } }, "Sign out")));
}

const NOTICE = "ownsync-notice-0.1.1";

async function dashboard() {
	let o;
	try { o = await api("/api/overview"); } catch (err) { return err.status === 401 ? welcome() : show(h("p", { class: "error" }, failure(err))); }
	const devices = o.vaults.reduce((n, v) => n + v.devices.length, 0);
	const headline = o.vaults.length
		? h("h1", { class: "headline" }, h("b", {}, plural(o.vaults.length, "vault")), " across ", h("b", {}, plural(devices, "device")), ". ",
			o.lastSync ? ["Last sync ", h("b", {}, ago(o.lastSync)), "."] : "No device has synced yet.")
		: h("h1", { class: "headline" }, "No vaults yet. ", h("b", {}, "Connect your first one"), " on the right.");
	// A newer Ownsync comes first; otherwise what's new in this one, until dismissed.
	const notice = o.update ? h("div", { class: "card notice" }, h("span", { class: "label" }, "Update"),
		h("p", {}, `Ownsync ${o.update} is out. On GitHub, open your Ownsync repository → Actions → Update Ownsync → Run workflow. Cloudflare redeploys your server.`),
		h("a", { href: "https://github.com/humanglitch191/ownsync/blob/main/docs/updating.md" }, "How"))
		: localStorage.getItem(NOTICE) ? null : h("div", { class: "card notice" }, h("span", { class: "label" }, "New"),
		h("p", {}, "Phones can sync notes only now, and skip attachments: Settings → Ownsync → Sync attachments."),
		h("button", { "aria-label": "Dismiss", onclick: (e) => { localStorage.setItem(NOTICE, "1"); e.target.closest(".notice").remove(); } }, "×"));
	const { usage, limits } = o;
	show(h("main", { class: "dash" },
		topBar("overview"), headline, notice,
		h("div", { class: "tiles" },
			meterTile("Storage", usage.bytes, limits.storageBytes, size, "Cloudflare free plan, all vaults together."),
			meterTile("Requests today", usage.requestsToday, limits.requestsPerDay, count, "Resets at midnight UTC.", days(usage.history ?? [], "requests")),
			meterTile("Rows written today", usage.rowsWrittenToday, limits.rowsWrittenPerDay, count, "Roughly one per saved edit.", days(usage.history ?? [], "rows"))),
		h("div", { class: "twocol" },
			h("div", {}, o.vaults.length ? o.vaults.map(vaultSection) : h("div", { class: "card empty" }, h("p", { class: "quiet" }, "Install Ownsync in Obsidian, open the vault you want to sync, then press Connect another vault."))),
			connectPanel()),
		h("footer", { class: "foot" }, h("span", {}, `Ownsync ${o.version} · your server`), h("span", {}, "Workers Free plan · ", h("a", { href: "https://github.com/humanglitch191/ownsync/blob/main/docs/cost-and-limits.md" }, "what Paid adds")))));
}

async function passkeys() {
	let o;
	try { o = await api("/api/overview"); } catch (err) { return err.status === 401 ? welcome() : show(h("p", { class: "error" }, failure(err))); }
	const add = action("Add a passkey", async () => {
		const options = await api("/api/passkeys/add/options", {});
		await api("/api/passkeys/add", { response: await createPasskey(options) });
		await passkeys();
	}, "btn");
	show(h("main", { class: "dash" }, topBar("passkeys"),
		h("h1", { class: "headline" }, h("b", {}, plural(o.passkeys.length, "passkey")), " can sign in here."),
		h("div", { class: "passkeys" },
			h("div", { class: "card" }, o.passkeys.map((p) => {
				const remove = action("Remove", async () => {
					const options = await api("/api/passkeys/remove/options", {});
					await api("/api/passkeys/remove", { id: p.id, response: await usePasskey(options) });
					await passkeys();
				}, "btn small danger");
				return h("div", { class: "devrow" }, h("span", { class: "ic" }, svg(KEY, 16, 1.75)), h("div", {}, h("div", {}, p.current ? "This one" : "Passkey"), h("div", { class: "meta" }, `Added ${ago(p.created)}`)), o.passkeys.length > 1 ? h("div", {}, remove.button, remove.error) : h("span"));
			})),
			h("div", { class: "row actions" }, add.button), add.error,
			h("p", { class: "quiet" }, "Lost every passkey? Set a new SETUP_KEY in your Cloudflare dashboard and use it here: that replaces all passkeys."))));
}

if (!window.PublicKeyCredential) show(h("main", { class: "welcome" }, brand(), h("p", { class: "error" }, "This browser doesn't support passkeys. Open this page in a current Safari, Chrome, Edge or Firefox.")));
else void dashboard();
