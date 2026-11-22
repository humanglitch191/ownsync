import { test } from "node:test";
import assert from "node:assert/strict";
import { noteUrl, paramsOfPairLink, parseOpenLink, parsePairLink, parseSetupLink, parseVaultCode } from "../src/links";

test("a setup link is a vault code: a bare secure server address and a 64-hex owner code", () => {
	const code = "ab".repeat(32);
	assert.equal(parseSetupLink({ host: " https://ownsync.me.workers.dev/ ", code }), `https://ownsync.me.workers.dev#${code}`);
	for (const host of ["http://ownsync.me.workers.dev", "https://ownsync.me.workers.dev/x", "javascript:alert(1)", "", undefined]) {
		assert.equal(parseSetupLink({ host, code }), null, String(host));
	}
	for (const bad of ["ab", "zz".repeat(32), "", undefined]) assert.equal(parseSetupLink({ host: "https://ownsync.me.workers.dev", code: bad }), null, String(bad));
});

test("a pasted pairing link: the obsidian:// one or the web page one, nothing else", () => {
	const ok = { host: "https://ownsync.me.workers.dev", vaultId: "0123456789abcdef0123456789abcdef", code: "fedcba9876543210fedcba9876543210" };
	const q = new URLSearchParams(ok).toString();
	assert.deepEqual(paramsOfPairLink(` obsidian://ownsync-pair?${q} `), ok);
	const page = new URLSearchParams({ vaultId: ok.vaultId, code: ok.code }).toString();
	assert.deepEqual(paramsOfPairLink(`https://ownsync.me.workers.dev/add-device/#${page}`), ok);
	assert.deepEqual(paramsOfPairLink(`https://ownsync.me.workers.dev/add-device/#${page}&host=https://evil.example`), ok); // the page's own server, always
	for (const bad of [`obsidian://ownsync-setup?${q}`, `http://example.com/add-device/#${page}`, `https://example.com/elsewhere/#${page}`, `https://example.com/add-device/?${page}`, "obsidian://ownsync-pair?host=https://x.example", "not a link", ""]) {
		assert.equal(paramsOfPairLink(bad), null, bad);
	}
});

test("pairing links: only a bare https origin, a hex vault ID and a hex code", () => {
	const ok = { host: "https://ownsync.me.workers.dev", vaultId: "0123456789abcdef0123456789abcdef", code: "fedcba9876543210fedcba9876543210" };
	assert.deepEqual(parsePairLink(ok), ok);
	assert.deepEqual(parsePairLink({ ...ok, host: "https://ownsync.me.workers.dev/" }), ok); // a trailing slash is fine
	for (const host of ["https://ownsync.me.workers.dev@evil.example", "https://evil.example/#ownsync.me.workers.dev", "https://evil.example/path", "http://evil.example", "javascript:alert(1)", ""]) {
		assert.equal(parsePairLink({ ...ok, host }), null, host);
	}
	for (const vaultId of ["Security update: press Pair", "abc", `${ok.vaultId}0`, ""]) assert.equal(parsePairLink({ ...ok, vaultId }), null, vaultId);
	for (const code of ["xyz", `${ok.code}00`, ""]) assert.equal(parsePairLink({ ...ok, code }), null, code);
});

test("a vault code: a bare secure server address, #, and a 64-hex owner code", () => {
	const owner = "ab".repeat(32);
	assert.deepEqual(parseVaultCode(` https://ownsync.me.workers.dev#${owner.toUpperCase()} `), { host: "https://ownsync.me.workers.dev", owner });
	assert.deepEqual(parseVaultCode(`https://ownsync.me.workers.dev/#${owner}`), { host: "https://ownsync.me.workers.dev", owner });
	for (const bad of [owner, `http://evil.example#${owner}`, `https://a.example/x#${owner}`, `https://a.example#${owner}0`, "correct horse battery staple", ""]) {
		assert.equal(parseVaultCode(bad), null, bad);
	}
});

test("a note's link: built from the Worker, vault ID and note ID; only exact hex IDs open", () => {
	const vaultId = "0123456789abcdef0123456789abcdef", noteId = "fedcba9876543210";
	assert.equal(noteUrl("https://ownsync.me.workers.dev/", vaultId, noteId), `https://ownsync.me.workers.dev/open/#${vaultId}/${noteId}`);
	assert.deepEqual(parseOpenLink({ vaultId, note: noteId }), { vaultId, noteId });
	for (const bad of [{ vaultId: vaultId.toUpperCase(), note: noteId }, { vaultId: vaultId.slice(1), note: noteId }, { vaultId: `${vaultId}0`, note: noteId },
		{ vaultId, note: `${noteId}0` }, { vaultId, note: "../../etc/passwd" }, { vaultId, note: ` ${noteId}` }, { vault: vaultId, note: noteId }, { vaultId }, {}]) {
		assert.equal(parseOpenLink(bad), null, JSON.stringify(bad));
	}
});
