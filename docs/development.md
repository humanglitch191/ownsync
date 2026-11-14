# Development

- `server/`: the Cloudflare Worker (one Durable Object per vault, a pairing mailbox, and the owner's dashboard). `npm test` runs it under `wrangler dev`. To deploy from a terminal: `npm install && npx wrangler login && npm run deploy`.
- `plugin/`: the Obsidian plugin. `src/core/` is the sync engine, which knows nothing about Obsidian. `src/keys.ts` handles the device list, key changes and recovery. `npm test` runs the tests, including a fuzz test of the engine; `npm run build` writes `main.js`.
- `protocol/`: the encryption and message format, with fixed test vectors (`npm test`). Specified in [PROTOCOL.md](PROTOCOL.md).
- [DESIGN.md](DESIGN.md): architecture, threat model and open questions.

GitHub Actions test everything on each push and run a large fuzz batch nightly.

## Releasing

`node scripts/sync-manifest.mjs 0.2.0` sets the version in `plugin/manifest.json` and updates `manifest.json` and `versions.json` at the root. Commit, then push the tag `0.2.0`: the release workflow builds the plugin and publishes `main.js`, `manifest.json` and `styles.css`, where Obsidian's plugin browser picks them up.
