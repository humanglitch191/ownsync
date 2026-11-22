// Runs before every `wrangler deploy` / `wrangler dev` (wrangler.toml [build]): writes src/repo.generated.ts with the
// GitHub repository this was built from, so the dashboard can link to its update workflow. Any failure means null.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** "owner/repo" from a github.com remote URL (https, ssh or scp-style; credentials and .git dropped), else null. */
export function repoFrom(url) {
	const m = String(url).trim().match(/^(?:https?:\/\/(?:[^/@]*@)?|ssh:\/\/(?:[^/@]*@)?|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
	const repo = m ? `${m[1]}/${m[2]}` : null;
	return repo && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	let repo = null;
	try { repo = repoFrom(execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { /* no git or no origin */ }
	const sha = /^[0-9a-f]{7,40}$/i.test(process.env.WORKERS_CI_COMMIT_SHA ?? "") ? process.env.WORKERS_CI_COMMIT_SHA : null;
	writeFileSync(new URL("../src/repo.generated.ts", import.meta.url), `// Written by scripts/repo.mjs at build time. The default (nothing known) is committed.\nexport const REPO: string | null = ${JSON.stringify(repo)};\nexport const COMMIT: string | null = ${JSON.stringify(sha)};\n`);
}
