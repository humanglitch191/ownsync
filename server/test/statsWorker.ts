// The Worker as deployed, plus two things for tests only: a route for a Vault's dashboard stats, which in
// production only the owner's dashboard reads (over RPC), and headers standing in for a redeploy:
// `x-test-deployed-ago` (ms since this version was deployed) and `x-test-setup-key` (a new SETUP_KEY). `wrangler dev` runs this file in place of src/index.ts.

import worker, { type Vault } from "../src/index";
export { Owner, Pairing, Vault } from "../src/index";

export default {
	async fetch(req: Request, env: { VAULT: DurableObjectNamespace<Vault> }): Promise<Response> {
		const stats = new URL(req.url).pathname.match(/^\/test-stats\/([0-9a-f]{32})$/);
		if (stats) return Response.json(await env.VAULT.get(env.VAULT.idFromName(stats[1]!)).stats());
		const ago = Number(req.headers.get("x-test-deployed-ago") ?? 0);
		const deployed = ago ? { CF_VERSION_METADATA: { id: "", tag: "", timestamp: new Date(Date.now() - ago).toISOString() } } : {};
		const key = req.headers.get("x-test-setup-key");
		return worker.fetch(req, { ...env, ...deployed, ...(key ? { SETUP_KEY: key } : {}) } as never);
	},
};
