# How Ownsync was built

I built Ownsync with AI. Claude, by Anthropic, working in Claude Code, wrote the code, the tests and these docs, and checked its own work in real Obsidian windows and a real browser.

It wasn't a one-shot prompt. I directed it over many sessions: I set what it should be, chose between the options it laid out, turned down some of its ideas, and sent it back when something wasn't right. These are the decisions that shaped it.

## What I wanted

- Live sync for Obsidian where the Worker can never read my notes, and only my devices hold the keys.
- Between my own devices. Not shared vaults.
- From scratch, with no code borrowed from other sync plugins.
- Easy enough for someone who isn't technical: one click to deploy, a guided setup, and big vaults of 10,000 notes and more.
- Quality over speed.

## How it keeps notes safe

- Every security decision went to an independent AI reviewer before it was built. What it found got fixed, or written down in the [design notes](DESIGN.md).
- Pairing a device: I asked for the safest option that's still easy. That became a one-time QR code and a mailbox the Worker opens only once.
- Recovery: an optional recovery kit, and a new recovery key only when a lost or stolen device is removed.

## Setup and the dashboard

- A setup key, so that finding your Worker's address isn't enough to take it over.
- One way in: the setup key works only on your Worker's own page, only in the first 10 minutes after you deploy, and only until your first passkey exists. After that you sign in with the passkey. A new setup key is the way back in.
- A dashboard for devices, when each was last online, conflicts and free-plan usage. Devices go by a random ID, never a name.
- One Worker for as many vaults as you like.
- Installed from Obsidian's own plugin browser.
- Everything runs on your own Worker. No page is hosted anywhere else.

## What I left out, on purpose

- Recovery with a passkey. It would let whoever controls the Cloudflare account steal the recovery code.
- Backups and restore, for now. Every device already holds a full copy, and a restore needs protection against rolling a vault back first.

## Look, name and license

- The calm look follows my own design style: neutral colours, thin borders, no shadows.
- The name, Ownsync, and the MIT license.
