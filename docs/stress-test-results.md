# Stress test results

Measured on 14 November 2026, on a Linux laptop (14 cores, 16 GB), against the Worker running locally under `wrangler dev`, the same runtime Cloudflare uses.

## A real vault in real Obsidian

Two Obsidian desktop instances: device A with an existing vault of 1,000 notes (3.8 MB of text), device B new and empty.

| | |
|---|---|
| A: first sync of the existing vault (read, encrypt, upload) | 3.0 s |
| B: new device downloads and writes every note | 4.2 s |
| B has every note, and sampled notes match A | yes |
| Typing on A appears in B's open editor | 65 ms |
| Opening Obsidian with nothing new, until synced | 1.3 to 1.7 s |
| Memory after the first sync | 73 MB (A), 49 MB (B) |

## The sync engine at 10,000 notes

The engine on its own, with in-memory disk and server, so it measures Ownsync's own cost.

| | |
|---|---|
| First sync: import and upload 10,000 notes | 3.6 s |
| A new device downloads all 10,000 | 1.0 s |
| Restart with nothing changed | 0.2 s |
| Notes lost or duplicated | 0 |

## Thousands of random accidents

Three simulated devices, 2,000 runs of 250 random steps each: edits, renames, moves, deletes, attachments, offline spells, crashes in the middle of a write, and reconnects. After every run, all three must hold the same notes, with nothing lost and nothing duplicated.

**500,000 steps, all passed, in 55 seconds.** A longer batch runs every night on GitHub.

## Live, offline, and the server's view

Two Obsidian instances, end to end:

- Typing on one shows up in the other's editor within a second.
- Both edit the same note offline; the edits merge when they reconnect.
- One restarts while the server is down, then catches up.
- The server's storage holds no note text, file name or key.

The setup itself (welcome screen, connecting with a code, adding a device, a second vault) and the dashboard (setup key, passkey, devices, sign-in) are also driven end to end, in real Obsidian and a real browser.

## Not measured yet

- A 10,000-note vault in real Obsidian; 1,000 notes is what the laptop allowed alongside everything else.
- Phones, and a deployed Cloudflare Worker over the internet.
