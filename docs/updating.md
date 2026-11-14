# Updating

## The plugin

Obsidian updates it: Settings → Community plugins → **Check for updates**.

## Your server

Your dashboard says when a new Ownsync is out. Then:

1. On GitHub, open **your Ownsync repository**: the one Cloudflare created in your account when you deployed.
2. Go to **Actions → Update Ownsync**, and press **Run workflow**. (If GitHub asks you to enable workflows first, do that.)
3. Cloudflare redeploys your server from it in a minute or two. Reload your dashboard.

It brings in the latest release only, never unreleased work, and runs only when you press it. Your vaults, devices and passkeys stay as they are.

**Deployed before 0.1.2?** Your repository doesn't have the button yet. Add it once: in your repository, choose **Add file → Create new file**, name it `.github/workflows/update-ownsync.yml`, paste in [this file](https://raw.githubusercontent.com/humanglitch191/ownsync/main/server/.github/workflows/update-ownsync.yml), and commit. From then on, use the steps above.

The plugin and the server don't have to be on the same version: each works with the other's earlier versions.
