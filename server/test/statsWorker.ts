// The Worker as deployed, plus things for tests only: routes for a Vault's dashboard stats and Clean up, which in
// production only the owner's dashboard reaches (over RPC), and headers standing in for a redeploy:
// `x-test-deployed-ago` (ms since this version was deployed) and `x-test-setup-key` (a new SETUP_KEY). `wrangler dev` runs this file in place of src/index.ts.

import worker, { type Vault } from "../src/index";
export { Owner, Pairing, Vault } from "../src/index";

export default {
	async fetch(req: Request, env: { VAULT: DurableObjectNamespace<Vault> }): Promise<Response> {
		const stats = new URL(req.url).pathname.match(/^\/test-stats\/([0-9a-f]{32})$/);
		if (stats) return Response.json(await env.VAULT.get(env.VAULT.idFromName(stats[1]!)).stats());
		// Clean up as the dashboard asks for it, with the Worker's clock and the per-request limit set by the test.
		const cleanup = new URL(req.url).pathname.match(/^\/test-cleanup\/([0-9a-f]{32})(\/sizes)?$/);
		if (cleanup) {
			const vault = env.VAULT.get(env.VAULT.idFromName(cleanup[1]!));
			if (cleanup[2]) return Response.json(await vault.cleanupSizes());
			const b = (await req.json()) as { ranges: unknown; zone: unknown; months: unknown; now?: number; limit?: number };
			return Response.json(await vault.cleanUp(b.ranges, b.zone, b.months, b.now, b.limit));
		}
		const ago = Number(req.headers.get("x-test-deployed-ago") ?? 0);
		const deployed = ago ? { CF_VERSION_METADATA: { id: "", tag: "", timestamp: new Date(Date.now() - ago).toISOString() } } : {};
		const key = req.headers.get("x-test-setup-key");
		return worker.fetch(req, { ...env, ...deployed, ...(key ? { SETUP_KEY: key } : {}) } as never);
	},
};
