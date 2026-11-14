// Obsidian's catalog reads manifest.json and versions.json at the repository root. They are copies of
// plugin/manifest.json: run this after changing it. CI fails when they differ. A new version also goes into
// the plugin's package.json and the server's dashboard, which shows it.
// Usage: node scripts/sync-manifest.mjs [new version]

import { readFileSync, writeFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const write = (f, v) => writeFileSync(new URL(`../${f}`, import.meta.url), JSON.stringify(v, null, "\t") + "\n");

const manifest = read("plugin/manifest.json");
if (process.argv[2]) {
	if (!/^\d+\.\d+\.\d+$/.test(process.argv[2])) throw new Error("version must be x.y.z");
	manifest.version = process.argv[2];
	write("plugin/manifest.json", manifest);
	write("plugin/package.json", { ...read("plugin/package.json"), version: manifest.version });
	const dashboard = new URL("../server/src/dashboard.ts", import.meta.url);
	writeFileSync(dashboard, readFileSync(dashboard, "utf8").replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${manifest.version}";`));
}
write("manifest.json", manifest);
write("versions.json", { ...read("versions.json"), [manifest.version]: manifest.minAppVersion });
