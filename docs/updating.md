# Updating

## The plugin

Obsidian updates it: Settings → Community plugins → **Check for updates**.

## Your Worker

It updates itself. Once a day, a workflow in **your Ownsync repository** (the one Cloudflare created in your account when you deployed) looks for a new Ownsync release. It installs one only if:

- it's signed with my release key, which never leaves my laptop. A release from anyone else, or one changed after I signed it, installs nothing, and the run fails so GitHub emails you.
- it's newer than yours. It never goes back to an older one.
- it has been out for 3 days. The wait starts when your updater first sees the release, and starts again if the release changes. A newer release doesn't hold up an older one: each waits its own 3 days.

Then Cloudflare redeploys your Worker from it in a minute or two. Your vaults, devices and passkeys stay as they are.

**Don't want to wait?** Press **Update** on your dashboard, or in your repository go to **Actions → Update Ownsync → Run workflow**. That skips the 3 days, never the signature.

**Updates that change how your Worker stores data** never install on their own. The daily run fails with "This update changes how your Worker stores data; press Run workflow to install it", and GitHub emails you. Press it when you're ready.

**To stay on your version,** turn the updater off: **Actions → Update Ownsync → ⋯ → Disable workflow**. Enable it again to catch up.

**Deployed before 0.1.6?** Your updater only runs when you press it, and doesn't check signatures. GitHub doesn't let a workflow change itself, so replace it once: in your repository, open `.github/workflows/update-ownsync.yml`, press the pencil, replace everything with [this file](https://raw.githubusercontent.com/humanglitch191/ownsync/main/server/.github/workflows/update-ownsync.yml), and commit. (No such file? Choose **Add file → Create new file**, with that name.) If GitHub asks you to enable workflows, do that.

The plugin and your Worker don't have to be on the same version: each works with the other's earlier versions.
