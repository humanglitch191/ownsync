# What your Worker can and can't see

Every edit is encrypted on your device before it leaves. Only your devices hold the vault key, so your Worker, and anyone who controls your Cloudflare account, can't read your notes.

## It can't see

Note text, attachment content, file names, folders, or the vault key. Your vault's address on your Worker is a hash of its ID.

## It can see

- How many notes and attachments a vault has, as meaningless IDs, and when and by how much each changes.
- Attachments as encrypted pieces of up to 1 MB: how many, their sizes, and when two files hold the same content.
- Encrypted copies from your note history, grouped by opaque note tags. Your Worker can see when each copy arrives and its padded size.
- If you turn on vault snapshots, your Worker stores them as encrypted parts. It can see when you upload them, how many parts there are, and their padded sizes.
- When a note is open in an editor and its cursor moves (not where, and not your device's name).
- When each device is online, its IP address, its random device ID, its Ownsync version, whether it's a phone or a computer, whether it syncs notes only, and how many conflict copies a vault has.

Names are stored on your Worker as they are: the vault's name and your device names as Obsidian has them (so the dashboard can show them), and any names you type on the dashboard. The dashboard has no key to encrypt them with. Everything else about your notes stays encrypted.

It can hold back or replay old edits, but it can't forge or change one: every edit is authenticated with the vault key.

## The setup key and the dashboard

- The setup key adds your first passkey, once, in the first 10 minutes after you deploy. Then it does nothing.
- The browser sends a hash of it tied to your Worker's address, never the key itself.
- Wrong keys are counted per internet connection: after 10 in an hour, that connection has to wait.
- The page looks the same whether or not your Worker is set up.

## Adding a device

The QR code opens your Worker's own page, which hands a one-time code to Obsidian. The code sits after the `#` in the address, which browsers never send to a server. But the page comes from your Worker: someone who had taken over your Cloudflare account could change it to catch a code while you add a device, and with it the vault key. On a computer, **Copy link** skips the page.

## On your devices

The vault key lives in Obsidian's secret storage (Obsidian 1.11.4 or later), never in the vault folder, so it doesn't end up in iCloud, Dropbox or git with your notes. A device that already syncs ignores pairing and connect links, so a link from a web page can't move it elsewhere.

## Network use and accounts

- **Account:** a Cloudflare account (the free plan is enough) runs your Worker. I can't see it or sign in to it.
- **Updates:** your Worker runs code I publish. Its updater installs only releases signed with my own release key, which never leaves my laptop, and only 3 days after it first sees one. You can turn it off ([updating](updating.md)).
- **Plugin updates** come from Obsidian, which downloads them from this project's GitHub releases without checking a signature. So the plugin is only as safe as my GitHub account. Each release carries a build attestation, so you can check its files were built by GitHub from the signed release tag: `gh attestation verify main.js -R humanglitch191/ownsync`.
- **Network:** the plugin connects only to your Worker.
- **Your vault:** to sync it, the plugin lists and reads every file in it (except Obsidian's settings folder), and writes what arrives from your other devices.
- **Clipboard:** written only when you press a Copy button (a pairing link, a code); never read.
- **No telemetry, no ads, no payments.** Open source, MIT.

The full threat model and every trade-off are in the [design notes](DESIGN.md).
