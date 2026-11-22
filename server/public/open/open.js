// Turns this page's #<vaultId>/<noteId> into the plugin's obsidian://ownsync-open link. The plugin checks it again.
const m = location.hash.match(/^#([0-9a-f]{32})\/([0-9a-f]{16})$/);
if (m) {
	const link = `obsidian://ownsync-open?${new URLSearchParams({ vaultId: m[1], note: m[2] })}`;
	document.getElementById("open").href = link;
	location.replace(link);
} else {
	document.querySelector("main").textContent = "This link is incomplete.";
}
