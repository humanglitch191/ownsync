# Cost and limits

Ownsync runs on your own Cloudflare account. For one person's notes, the free plan is usually all you need. Prices are Cloudflare's, as of November 2026.

## Free plan: $0

| What Cloudflare counts | Free, per day | What it means for Ownsync |
|---|---|---|
| Rows written | 100,000 | Every saved edit is about one row. Typing in a note saves roughly every 3 seconds, so this is about 80 hours of nonstop typing a day. The first upload of a vault is about one row per note. |
| Requests | 100,000 | 20 messages from your devices count as one request, so about 2 million messages a day. |
| Active time | 13,000 GB-s | About 29 hours a day of your Worker actively relaying. It sleeps between edits, so idle devices cost nothing. |
| Storage | 5 GB in total | Notes are small: 1,000 notes took 15 MB in the stress test. Attachments are what fill it, then history backups (up to 50 MB a vault) and vault snapshots if you turn them on (up to 400 MB a vault). Keep each vault under about 1 GB, those included. |

The counts reset at midnight UTC. If a vault hits a limit, syncing pauses until then. Nothing is lost: your devices keep your edits and send them after the reset.

**When you might hit a limit:**
- Uploading a vault of 50,000 or more notes, or gigabytes of attachments, in one day. The upload pauses at the limit and carries on the next day.
- A lot of attachments in total: past 5 GB across your vaults, or about 1 GB in one vault, history backups and snapshots included.

Your dashboard shows today's storage, requests and rows written against these limits, and warns from 80%.

## Workers Paid: $5 a month

The paid plan swaps the daily limits for much larger monthly ones. Nothing changes in Ownsync.

| | Included each month | Beyond that |
|---|---|---|
| Rows written | 50 million | $1.00 per million |
| Requests | 1 million (about 20 million device messages) | $0.15 per million |
| Active time | 400,000 GB-s | $12.50 per million GB-s |
| Storage | 5 GB | $0.20 per GB a month |

For one person's notes, the $5 covers everything. Storage past the included 5 GB costs $0.20 per GB a month, so even several full vaults add only cents.

**To switch:** in your Cloudflare dashboard, go to **Workers & Pages → Plans** and choose **Workers Paid**. Your Worker, vaults and passkeys stay as they are.

Sources: Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
