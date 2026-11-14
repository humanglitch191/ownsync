# Ownsync

Real-time sync for Obsidian, end-to-end encrypted, through a server you own.

<picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png">
<img src="docs/images/hero.png" alt="The Ownsync dashboard, and the page a phone opens to join">
</picture>

I wanted my notes on my laptop and my phone, in sync as I type, without handing them to anyone. Ownsync runs on a free Cloudflare Worker in your own account. Every edit is encrypted on your device before it leaves, so the server only ever holds scrambled data. It couldn't read a note if it tried.

> **Work in progress.** Ownsync is very new, and I'm the only one testing it so far, on my own vault and phone. Expect rough edges, and keep a backup of your vault while you try it.

- **Live.** Edits show up on your other devices in under a second.
- **Yours.** Only your devices hold the key. No account with me, nothing collected.
- **Offline first.** Edit anywhere. It merges when you're back.
- **Tested hard.** 500,000 random crashes, renames and reconnects, and not one note lost. [Results](docs/stress-test-results.md).
- **Free.** Runs on Cloudflare's free plan. Open source.

<p align="center"><img src="docs/images/how-it-works.svg" width="720" alt="How Ownsync works: your devices encrypt and hold the key; your Cloudflare Worker only relays scrambled data"></p>

## Get started

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/humanglitch191/ownsync/tree/main/server)

1. **Deploy.** Press the button and choose a setup key.
2. **Sign in.** Open your server's address within 10 minutes, enter the setup key, and add a passkey.
3. **Connect.** Install Ownsync from Obsidian's community plugins, then press **Open in Obsidian** on your dashboard.

To add your phone, scan the QR code under Settings → Ownsync → Add a device. The [setup guide](docs/setup.md) has every step, with screenshots.

## Good to know

- It needs a free Cloudflare account, and the free plan is plenty for one person's notes. For more, Workers Paid is $5 a month. [Cost and limits](docs/cost-and-limits.md).
- The plugin only talks to your server. It reads every file in your vault to sync it, and uses the clipboard only when you press Copy. No telemetry, no ads.
- Your server sees when your devices connect and how much is stored, never what you wrote. [What it can and can't see](docs/security.md).
- I built Ownsync with AI. The calls on what it should be, and how it keeps notes safe, were mine. [How it was built](docs/how-it-was-built.md).

[Setup guide](docs/setup.md) · [Security](docs/security.md) · [Cost and limits](docs/cost-and-limits.md) · [Updating](docs/updating.md) · [Stress test results](docs/stress-test-results.md) · [How it was built](docs/how-it-was-built.md) · [Design notes](docs/DESIGN.md) · [Protocol](docs/PROTOCOL.md) · [Development](docs/development.md)

MIT © humanglitch191
