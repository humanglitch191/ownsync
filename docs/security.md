# What your server can and can't see

Every edit is encrypted on your device before it leaves. Only your devices hold the vault key, so your server, and anyone who controls your Cloudflare account, can't read your notes.

## It can't see

Note text, attachment content, file names, folders, or the vault key. Your vault's address on the server is a hash of its ID.

## It can see

- How many notes and attachments a vault has, as meaningless IDs, and when and by how much each changes.
- Attachments as encrypted pieces of up to 1 MB: how many, their sizes, and when two files hold the same content.
- When a note is open in an editor and its cursor moves (not where, and not your device's name).
- When each device is online, its IP address, its random device ID, its Ownsync version, and how many conflict copies a vault has.

It can hold back or replay old edits, but it can't forge or change one: every edit is authenticated with the vault key.

## The setup key and the dashboard

- The setup key adds your first passkey, once, in the first 10 minutes after you deploy. Then it does nothing.
- The browser sends a hash of it tied to your server's address, never the key itself.
- Wrong keys are counted per internet connection: after 10 in an hour, that connection has to wait.
- The page looks the same whether or not your server is set up.

## Adding a device

The QR code opens your server's own page, which hands a one-time code to Obsidian. The code sits after the `#` in the address, which browsers never send to a server. But the page comes from your server: someone who had taken over your Cloudflare account could change it to catch a code while you add a device, and with it the vault key. On a computer, **Copy link** skips the page.

## On your devices

The vault key lives in Obsidian's secret storage (Obsidian 1.11.4 or later), never in the vault folder, so it doesn't end up in iCloud, Dropbox or git with your notes. A device that already syncs ignores pairing and connect links, so a link from a web page can't move it elsewhere.

## Network use and accounts

- **Account:** a Cloudflare account (the free plan is enough) runs your server. Nobody else runs or sees it, including me.
- **Network:** the plugin connects only to your server.
- **No telemetry, no ads, no payments.** Open source, MIT.

The full threat model and every trade-off are in the [design notes](DESIGN.md).
