// Turns this page's #vaultId=…&code=… into the plugin's obsidian://ownsync-pair link, for this server.
// The plugin checks the link again and asks before it changes anything.
const p = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname); // the one-time code stays out of browser history
const host = location.origin, vaultId = p.get("vaultId") || "", code = p.get("code") || "";
if (/^[0-9a-f]{32}$/.test(vaultId) && /^[0-9a-f]{32}$/.test(code)) {
	document.getElementById("server").textContent = host.replace(/^https?:\/\//, "");
	document.getElementById("open").href = `obsidian://ownsync-pair?${new URLSearchParams({ host, vaultId, code })}`;
	document.getElementById("good").hidden = false;
} else {
	document.getElementById("bad").hidden = false;
}
