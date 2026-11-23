# Ownsync design

End-to-end encrypted, real-time collaborative sync for Obsidian. A Cloudflare Worker (one Durable Object per vault) relays and stores only ciphertext, while devices still see each other's edits live, in real time.

Status: started as a design draft on 2026-11-13; kept up to date with what's built (0.2.0). Section 8 onwards covers note history, Recently deleted and vault snapshots.

## Goal

- Edits from one device appear on others within about a second, character by character.
- The server (Cloudflare) can't read note text, file names, folder structure or attachments.
- Works on Obsidian desktop and iOS, offline first.
- Out of scope for v1: sharing part of a vault with other people (the key design leaves room for it, see "Later"). People can already collaborate by joining the vault as a device: they then see and edit every note.

## The core idea: three planes

| Plane | Job | Runs on |
|---|---|---|
| Semantic | Merge edits from all devices (Yjs CRDT) | devices only |
| Confidentiality | Seal every update, path and attachment | devices only |
| Ordering and delivery | Store sealed updates in order, fan them out live | Worker |

Rule: the server only ever participates in the third plane. Any feature that needs the server to understand content (merging, compaction, snapshots, search, setup links) is either moved to devices or dropped.

```
  laptop ──┐                                         ┌── iPhone
  (Yjs + keys)  sealed update {doc, seq, ...}        (Yjs + keys)
           └──► Durable Object: append-only log  ◄───┘
                 assigns seq, broadcasts live, holds
                 encrypted snapshots, prunes old updates,
                 keeps encrypted attachment chunks
```

## 1. Keys

- **Vault master key (VMK).** A random 256-bit key created on the first device. It never leaves a device except wrapped: to another device during pairing or rotation, or to the recovery public key.
- **Subkeys via HKDF from the VMK:**
  - seal key, one per device: seals that device's updates, snapshots, presence, attachment chunks, history copies and whole-vault snapshot parts (the kind is bound in the AD, so one key serves all of them)
  - name key: HMAC that names attachment chunks
  - auth token: proves to the server that a socket belongs to the vault. The server stores only its SHA-256 and rejects anything else.
- **No per-device signatures in v1.** Every device holds the VMK and the server doesn't, so AES-GCM already stops the server forging or altering content. Signatures would only tell your own devices apart. Each envelope starts with a version byte and a cipher-suite id, both covered by the AD, and receivers reject unknown versions, so signatures can be added as a trailer later (needed for sharing) without breaking old data. Decided 2026-11-13 after an independent review.
- **Device keys.** Each device has a random 16-byte device ID and an ECDH P-256 key pair per vault (native in WebCrypto), made when it joins the vault. The private key is generated non-extractable and kept, as a `CryptoKey`, in the vault's IndexedDB store: it can be used, never exported. It is used only to send and receive wrapped VMKs when the epoch rotates.
- **Membership log.** The list of enrolled devices and their public keys is a hash-chained log of records, never a server table (a server-controlled key list authenticates nothing) and never derived from the merged Yjs document (a concurrent CRDT edit could re-add a removed device). Each record holds the record number, epoch, the hash of the previous record, the sender's device ID, the full new member list as `(deviceId, publicKey)` pairs, the removed IDs, and when and by which device each member was paired. It is encrypted (AES-GCM) under a key derived from the VMK of the epoch it was written in, so the server sees only the record number and epoch, not the member list. The first device writes record 0 when it creates the vault; pairing appends a record in the same epoch; removal appends one that starts a new epoch. The server stores the records as opaque blobs, strictly in order, first come first served, and serves them without a token (they are sealed, and a device whose token a rotation replaced, or a recovering device, needs them to find the new key). Devices check every record themselves (`plugin/src/keys.ts`, rules in PROTOCOL.md). A vault set up before the log existed gets its record 0 from the first device that connects; every other device holding the key then adds itself.
- **Pairing a new device.** An existing device shows a QR code (and the same link as text, for desktop-to-desktop): `obsidian://ownsync-pair?...` with the server URL, vault ID and a one-time 128-bit code K. It seals the VMK under K and leaves it in a single-use server mailbox named by a hash of K, which expires after 2 minutes. The new device asks the user to confirm (showing the server), then fetches the sealed VMK and opens it with K. The server never sees K or the VMK. This is a one-way mailbox, not the two-way exchange first drafted: an independent review (2026-11-13) found the two-way exchange adds only "the existing device sees the code used". Instead, a used code answers "already used", so the new device can warn that the key is exposed. The confirmation is required because any web page can open an `obsidian://` link and would otherwise silently swap a device's server and key. Anyone who sees the QR before it's used gets the VMK, so the UI warns about that. While the pairing screen stays open and visible, it replaces each code once it has run out (one live code at a time, renewals count as one shown code for "claims about yourself"), stops after 10 minutes or when hidden, and when a new member appears shows its short ID, which the new device also shows, so the user can tell their own device from someone who used the code first (reviewed 2026-11-14).
- **How a paired device enters the log: it adds itself.** The mailbox carries, with the VMK and epoch, the pairing device's newest record (number and hash) and its device ID. The new device trusts that record as its starting point, so the server can't feed it a stale or different chain, reads forward from it, then appends a record adding only itself, with `pairedBy` = the pairing device. Reasoning: with the one-way mailbox the existing device never learns the new device's public key, and a second mailbox round trip would add a moving part for nothing, since anyone holding the VMK can already write any record that verifies (records are authenticated only by the member key, and `senderId` is self-asserted). So the rules only keep a same-epoch record from doing more than add one device: it may not remove anyone, change a key or the recovery key, and its sender must be an existing member or the one device it adds. The pairing device remembers each code it showed for 10 minutes; a record naming it as the pairer outside that window makes it alert the user ("claims about yourself").
- **Recovery key (optional, offered at setup).** About 128 bits generated by the app, shown as 26 base32 characters, saved by the user. It never wraps a VMK directly, because then every device would need to keep material derived from it to wrap future VMKs, and a stolen device would keep reading every new epoch through the recovery copy after removal. Instead:
  - Setup generates a random P-256 recovery key pair. Its private key is sealed under `HKDF(recovery key, "recovery-priv")` and stored on the server. Devices keep only the recovery public key, in the membership log. (WebCrypto can't derive an EC key pair from a seed, so it's generated, then sealed.) It is offered right after "Create": the app shows the code and a recovery kit (Worker URL, vault ID, code) and goes on only once the user confirms they saved it, or skips. Record 0 then carries the recovery public key and wraps `VMK_0` to it. Setting one up later is the same as replacing it.
  - Every rotation wraps the new VMK to the recovery public key, the same way as to a device (see "Rotation wraps are authenticated").
  - Recovery ("Recover a vault" on a fresh device): enter the Worker URL, vault ID and code; the device fetches the records and the sealed private key without a token, unseals it, unwraps the newest VMK wrapped to it, catches up on the vault under that epoch, then rotates as `RECOVERY_ID`, enrolling itself. The recovery key pair counts as a member when checking who sent a rotation record, so a recovered device can rotate. The recovery rotation removes every other device (they were lost, and may be in someone else's hands) and replaces the recovery key, since those devices know the old one; the user is shown the new kit first. A recovering device can't check the chain behind the record it recovers from, only that the record agrees with its wrap: that is why a lost or stolen device's removal requires a new recovery key.
  - Without a recovery key, losing every device loses the vault. There are no user-chosen passphrases, so the server never holds anything that can be brute-forced offline.
- **Replacing the recovery key** generates a new recovery key pair and a new 26-character code, and deletes the old sealed private key and its wraps. It's needed when the code leaks, and after removing a lost or stolen device: that device knows the old recovery public key, so together with the server it could plant a fake chain of rotations that a user recovering with no devices left would adopt. Removal asks whether the device was lost or stolen; if yes, replacing the recovery key is required, otherwise it's only suggested. Decided 2026-11-13.
- **Removing a device** rotates the epoch in one step: a membership record for epoch e+1, a fresh VMK wrapped to each remaining device (the rotating device included, so a crash before the Worker answers loses nothing) and to the recovery public key, and a new auth token. The device sends all three in one `rotate` frame; the Worker accepts it only from a socket that said hello with the current token and only if the record's number is the next one, then stores the hash of the new token and closes every other socket (close code 4003). Each device reconnects, reads the records first, takes in the new key and says hello with the new token; the removed device finds itself missing from the member list, alerts the user and stops, and its old token is refused from then on. The removed device can still read what it already had, but nothing new. The rotating device must be caught up first. The settings screen lists every enrolled device by short ID with when and by which device it was paired, because a stolen device can quietly pair extra devices before it's removed. "Paired by" is a claim, not proof: any member can write it. It's labelled as such, and a device that sees a record falsely naming it as the pairer alerts the user.
- **Rotation wraps are authenticated.** Without signatures, a wrap with only a one-time sender key (plain ECIES) proves nothing about the sender: a removed device knows every public key and could send a VMK it chose, claim any sender ID, and read everything written afterwards. So each wrap combines a one-time key with both devices' permanent keys (Noise-style `es + ss`): `IKM = ECDH(ephemeral, recipient) || ECDH(sender, recipient)`, HKDF salt = hash of the rotation record, info and AEAD AD = `"ownsync/v1/wrap" | suite | vaultId | epoch | senderId | senderPub | recipientId | recipientPub | ephemeralPub`. Public keys are included, not only IDs, because IDs are self-asserted. The static part authenticates the sender; the one-time part means a leaked sender key alone doesn't open past wraps. The server deletes a wrap once its recipient acknowledges it.
- **Accepting a new epoch.** A device accepts a rotation record only if its epoch is current + 1, its previous-record hash matches the device's stored head, the sender's public key is in the current member list, and the sender is still in the new list.
- **Competing rotations.** Two valid records with the same previous hash are a fork. No automatic tie-break works, because a stolen device that hasn't been removed yet is indistinguishable from the user's own. Devices freeze, stop publishing, and show both records (sender, who was removed, time); the user picks one, and the chosen side rotates again, removing the other side's sender. Only a fork at a device's current head freezes it; a competitor to a record it already accepted is ignored and shown as a dismissible alert, or a removed device could use its old-epoch key, with the server's help, to freeze the vault forever. A device removed by a rotation it didn't start alerts the user; it can still decrypt the record, which is sealed under the old epoch's key. As built, the Worker keeps records first come first served, so an honest Worker never holds two records with one number: two devices pairing at once just add themselves one after the other, and a removal that loses a race is reported to the user to try again. A fork therefore means the Worker served two different records at one number; the device freezes (status "paused"), stops syncing, and opens a dialog showing each record's sender and the devices it adds and removes. Removing the other side's sender afterwards is left to the user.
- **After a rotation.** The rotating device publishes a snapshot under the new epoch as part of the rotation. From then on, devices reject envelopes from older epochs, updates included, not only snapshots, or a removed device and the server could inject old-epoch edits. A cut-off by the server's sequence number wouldn't stop that, since the server assigns it. Edits other devices made under the old epoch that the rotating device hadn't seen aren't lost: on accepting a new epoch, every device, not only the rotating one, sends a snapshot of every document under it (`Engine.snapshotAll`), which holds whatever the rotating device's snapshot lacked. That costs every device one upload of the vault per rotation, which is simpler than working out the difference. Attachment chunks are exempt: they're checked against their content-hash name.
- **Older data after a rotation.** Attachment chunks and the membership log itself stay under old VMKs, and a device paired after the rotation (or recovered) needs those keys. Each rotation record carries the previous VMK sealed under the new one, so the chain of records is a key ring: from the current VMK a device can unseal every older one.
- **A server can hold back a rotation.** If the server never delivers the new epoch to a remaining device, that device keeps writing under the old VMK, which the removed device can still read. It needs Cloudflare (or whoever controls the Worker) and the removed device working together. Partial fix: a device that sees a newer epoch number than it can decrypt stops publishing and alerts the user. It doesn't help if the server also hides the epoch number. As built, a rotation record that lists a device but holds no key it can open is refused and reported, and the device stays on its old token, which an honest Worker then refuses.
- **Binding.** Each envelope's AEAD additional data covers `version | suite | vaultId | docId | epoch | kind | deviceId`, so the server can't move an update to another document, epoch or message type, or replay it as something else. `deviceId` is self-asserted: it identifies, it doesn't authenticate.
- **Nonces.** AES-GCM with random 96-bit nonces is safe for about 2^32 messages per key; a seal key per device keeps each key far below that.
- **Crypto library.** WebCrypto only: AES-256-GCM, HKDF, HMAC, ECDH P-256, SHA-256. No libsodium and no WASM.

## 2. Data on devices

- **One Yjs document per note, plus one index.** The index maps a permanent note ID to the note's path, or marks it deleted. Each note's text is its own small document. Only notes open in an editor stay loaded; the rest are bytes in the local database. Paths live inside the encrypted index, so renames are invisible to the server, and a rename keeps the note's identity and history.
- **Local database.** One IndexedDB store per vault holds the index, each note's state, what this device last agreed with each file, the position in the server's sequence, and edits not yet sent. Every change is one atomic commit, so these can't drift apart.
- **Files stay plain.** Each device keeps the vault as ordinary markdown files. Devices are trusted; disk encryption is the operating system's job.
- **Attachments** are every file that isn't `.md` (outside Obsidian's settings folder). Each has a permanent ID in the index like a note, and a small Yjs document holding its versions instead of text. A version (`Ref`) records the content's name, its size and its chunks: up to 1 MiB each, sealed with the uploading device's seal key and named by `HMAC(name key, SHA-256(plaintext))`, so identical content is stored once. The content itself is never in the local database, only in the file and on the server.
  - The ref is in the attachment's document, not in the index value, because the index map is last-writer-wins per key: a rename on one device and a new version on another, or two new versions, would silently drop one.
  - Files over a size limit (20 MB by default, a setting) are reported and neither synced nor overwritten.

## 3. Server: deliberately small

One Durable Object per vault, SQLite storage, hibernating WebSockets. Code: `server/src/index.ts`; messages: `server/src/wire.ts`.

- **A mailbox, not a history.** One table, `entries(seq, doc, snapshot, envelope)`. `doc` is an opaque 16-byte tag per document. The server never opens an envelope.
- **Live and stored are separate.** A `live` frame is relayed to the vault's other connected devices and forgotten. A `publish` is stored, acknowledged and relayed. Devices send every edit live at once, and store the edits to a document together every few seconds, so typing costs a row every few seconds, not every keystroke. Presence (cursors) also travels as `live` frames, sealed as `KIND.presence` under the note's tag; the Worker can't tell it from an edit except by the kind byte in the envelope header.
- **Snapshots bound the storage.** A device uploads a `snapshot` of one document "as of seq N"; the server stores it as a new entry and deletes that document's entries up to N. Storage stays near the size of the vault.
- **Attachment chunks** are a second table, `chunks(name, envelope)`, outside the log: `put` stores a chunk unless its name is there, `get` returns it or says it's missing. They count toward the Durable Object's storage (1 GB on the free plan; a row holds at most 8 MB, a chunk about 1 MiB). R2 isn't used: it may need a payment method on a free account.
- **Catch-up in pages.** `subscribe(after)` returns up to 400 entries or 4 MiB, then `more` or `synced`. A snapshot is never skipped for a device that hasn't read past it: a device's position says how far it has read, not that it holds what a snapshot replaced.
- **Auth.** The first frame is `hello` with the auth token (only `fetch` may come before it); the server stores only its hash. The first `hello` for a vault sets that hash, and is accepted only with the Worker's owner code (closed with 4002 otherwise). A `rotate` from an authenticated socket replaces the hash and closes every other socket with 4003; a socket that said hello with the old token can't send anything more. A vault deleted from Obsidian keeps only a tombstone, and every frame to it is closed with 4004.
- **Membership records.** A table `records(number, blob)` and the sealed recovery private key. `append` and `rotate` store a record only if its number is the next one; either way the sender gets back the record now at that number. A new record is pushed to the vault's other devices. `fetch` returns the records from a number on, plus the sealed recovery key, to anyone who knows the vault's address.
- **Owner.** A third Durable Object class, one instance per Worker: the owner codes, the vault list and the dashboard (section 6). An owner code (256 bits, only its SHA-256 kept, single use) is what a new vault's first `hello` needs; it opens no existing vault. Codes come only from the dashboard ("Connect a vault", valid 1 hour; a device can't make one), shown as `<origin>#<code>` or the link `obsidian://ownsync-setup?host=<origin>&code=<code>`; the 20 newest unused are kept. Obsidian's setup screen shows which server a code names and does nothing until the user presses Connect; a code the server refuses (used or expired) leaves nothing behind. The setup key is never typed into Obsidian.
- **Pairing mailbox.** A second Durable Object class: put once, get once, gone after 2 minutes (section 1).

## 4. Sync engine

`plugin/src/core/engine.ts`, about 1,300 lines, knows nothing about Obsidian. Its rules are in the file's header. The ones that shape everything else:

- Every input is handled one at a time and committed atomically, before anything is sent.
- A note's document is committed before its file is written, and the file's intended place is recorded before the write, so a crash at any point is finished or undone at the next start.
- A file the user changed while the document also changed is merged on top of the version both last agreed on. There are no conflict files for ordinary edits.
- A deletion only holds against devices that had nothing the deleter hadn't seen.
- Two notes claiming one path both survive; every device works out the same suffix for the loser.
- A note open in an editor belongs to the editor. If the app stops while it's open, the document wins and a save that might hold unrecorded typing is kept as a "(recovered …)" note.
- At startup, notes are matched to files by content similarity, as git matches renames.
- A change this device makes to the index (a deletion, a rename, a note brought back) settles the other notes claiming the same path, as a remote change does.
- Attachments reuse all of the above; what differs:
  - A device uploads every chunk of a new version, and has each acknowledged, before it publishes the version. It writes a file only once every chunk is downloaded and checked against its name, and the whole content against the version's. A missing chunk is retried on the next connection; nothing is ever written in part. One file moves at a time each way, with up to 4 chunks in flight, so a file is in memory whole only while it is read or written (Obsidian reads and writes whole files).
  - A new version deletes the version it was made from and adds itself, so two made concurrently both stay in the document. The first (in Yjs order, the same everywhere) keeps the attachment; every other one becomes an attachment of its own, `name (conflict xxxxxx).ext`, under an ID carried in the version, so every device that resolves the conflict makes the same copy. If two devices resolve at once and leave no version, the copies hold them all and the attachment itself is deleted.
  - Until its upload finishes, a new version wins over a remote deletion (the deleter never saw it), and the file is never overwritten.
  - At startup an attachment is matched to a file by exact content only. Renamed and changed while the app was closed counts as deleted and new.

It is tested by a fuzzer (`plugin/test/engine.fuzz.test.ts`): three simulated devices creating, editing, renaming and deleting notes and attachments while the network drops messages and devices crash mid-operation, checked for identical vaults (attachments byte for byte), no lost text or attachment content and nothing duplicated.

## 5. Plugin

`plugin/src/`: the engine (`core/`), and a thin layer that connects it to Obsidian.

- `transport.ts`: seals every message and speaks the server's frames; reconnects. Presence goes to the editors, never to the engine, at most one batch every 150 ms; an envelope whose kind doesn't match its frame is refused. Each connection reads the membership records before it says hello.
- `keys.ts`: the device identity, the membership log and its rules, rotation and recovery, headless.
- `idbStore.ts`, `vaultDisk.ts`: the local database and the vault's files, as the engine sees them. `vaultDisk.ts` refuses paths from other devices that leave the vault or enter its settings or hidden folders.
- `editors.ts`: binds each markdown editor that is on screen in edit mode to its note's document (`y-codemirror.next`). Reading view and tabs not loaded yet count as closed.
- `collab.ts`: what a bound editor adds. Each note shown here has a y-protocols `Awareness` (cursor, device name, colour), cleared when the last editor showing it unbinds and timed out 30 s after a device stops renewing it. Arriving presence is cleaned first: a name of at most 40 characters without control characters, rendered as text; a `#rrggbb` colour; a well-formed cursor or none; never this device's own state. Frames from one device arrive in order, so the newest wins, whatever its clock. Undo uses a `Y.UndoManager` per editor that tracks only that editor's own changes, so another device's typing (and the engine's own merges) are never undone. It takes Mod-z, Mod-y and Mod-Shift-z at highest precedence over Obsidian's CodeMirror history, the platform's `historyUndo`/`historyRedo` input events, and the editor's `undo()`/`redo()`, which Obsidian's Undo command and the phone toolbar call directly. Unbound editors keep Obsidian's undo.
- **Other people.** Someone else edits the vault by pairing their device like any other (section 1): they can read and change every note, and are removed like a device. While pairing, a device can be given a name ("Anna's iPhone 17 Pro"), shown next to its cursor and on the dashboard; there is no separate person or account.
- **Note links.** Copy URL gives `https://<Worker>/open/#<vault ID>/<note ID>`: the note ID, so a rename doesn't break it. The page (`server/public/open/`, its own script only) passes the fragment, which never reaches the Worker, to `obsidian://ownsync-open?vaultId=…&note=…` (not `vault=`, which Obsidian reads as a vault name). The plugin takes only a 32-hex vault ID equal to its own and a 16-hex note ID, and only opens that note.
- `pairing.ts`: QR pairing (section 1). `devices.ts`: the recovery kit, device removal, recovery and fork dialogs. `main.ts`: settings, status, commands.
- The key ring (every epoch's VMK this device holds, as JSON) is kept in Obsidian's secret storage (`app.secretStorage`, Obsidian 1.11.4 and later), not in the vault folder; the device's key pair and its view of the membership log are in the vault's IndexedDB store. A key found in local storage, where earlier versions kept it, is moved on start.

## 6. Dashboard (2026-11-14, reviewed twice)

The Worker's site is the owner's dashboard, signed in with a passkey. It shows only what the server can know without any key, and its only actions need no key: notes stay unreadable to the server, the dashboard and the Cloudflare account. Anything destructive happens in Obsidian, on a device that holds the vault's current token.

- **Hosting.** Workers static assets: the dashboard at `/`, the add-device page, the font. CSP `default-src 'self'; frame-ancestors 'none'; base-uri 'none'`, `Referrer-Policy: no-referrer`, no third-party code.
- **The setup key adds the first passkey, and nothing else.** On the page, "First time here?" sends `hex(SHA-256("ownsync-setup\n" | origin | "\n" | key))` to `POST /api/setup` (Origin must be the Worker's own). It works only within 10 minutes of the deploy (`CF_VERSION_METADATA.timestamp`; a new `SETUP_KEY` is a new version, so a new window; a missing timestamp shuts it) and only once per setup key: right, in time and unused gives a one-time enrol token (expires with the window), with which the page registers a passkey. One setup key adds one passkey, first come first served: the check and the writes happen with no await between them, so two people with the key at once can't both get in, and the loser is told the key leaked. A new setup key's passkey replaces every passkey and ends every session (whoever set it controls the Cloudflare account); that's also the way back for an owner who lost every passkey. The hash binds the key to this address against a look-alike server's reuse, but a look-alike page could still read the typed key and use it within the window: the window and the one-passkey rule are the real defence.
- **Strangers learn nothing.** The page looks the same set up or not; signing in with no passkey yet fails like a wrong passkey; `/api/setup` answers "wrong key" (and counts it) before saying "expired" or "used". Wrong keys are counted per connection (`CF-Connecting-IP`, IPv6 by /64, kept as a hash keyed with the setup key): 10 an hour lock that connection, 1,000 from everywhere lock all.
- **Passkeys.** RP ID: the Worker's hostname, fixed with its origin by the setup key's passkey. User verification required, attestation `none`, ES256 and RS256, discoverable. Verified with `@simplewebauthn/server`. More passkeys only while signed in. Removing one needs a fresh assertion and ends its sessions; the last can't be removed. Devices can't add passkeys, so a stolen device gives no way into the dashboard.
- **Signing in.** A discoverable-passkey assertion against a challenge HMAC-signed by the Worker (stateless, 5 minutes, used once). Then a session: a random 32-byte ID in a `__Host-` cookie (HttpOnly, Secure, SameSite=Strict, 12 hours), its hash stored. Every request that changes something also needs `Origin` equal to the stored origin.
- **Attachments, per device.** Each device chooses, when it starts syncing a vault and later in Settings, whether it syncs attachments or notes only. A notes-only device neither uploads, downloads nor deletes attachments (the engine skips them in every place it looks at files) and forgets the ones it knew, so turning them back on finds its own files by content and downloads the rest. The fuzzer makes one of its three devices notes-only every third run.
- **Devices.** The random device ID is a device's name until it has another: after catching up, a device sends `POST /vault/<id>/names` (its token, then its short ID, its name from Settings and the vault's name in Obsidian, as JSON), stored readable for the dashboard; an older server answers 404 and the plugin ignores it. A name the owner types on the dashboard wins over it (stored readable too, and cleared with the vault) (the plugin shows the same 8-character short ID). A device sends `status` after catching up: its short ID, plugin version (followed by `mobile` and `notes-only` where they apply, so an older server just shows them as part of the version) and how many "(conflict …)"/"(recovered …)" copies the vault has; one short ID per connection, at most 64 kept per vault. "Last online" comes from the Worker's own record of the connection. The dashboard shows each device's last online and version (with an "update" badge), flags any not seen for 30 days (removing it is done in Obsidian), and shows the conflict count, labelled as reported by the devices.
- **Vaults.** Registered by the Owner when created. Listed by short vault ID with an optional label (stored readable, said so), devices, last change and storage; "Connect a vault" with install steps and an Open in Obsidian button.
- **Free-plan meter.** Storage (each Vault's `sql.databaseSize`, summed) against 5 GB, and today's requests and rows written (per-Vault daily counters, written along with activity at most once a minute and when the last device leaves, reset 00:00 UTC, the last 14 days kept for the activity bars) against 100,000 each; incoming WebSocket messages count at Cloudflare's 20 to one. Warns from 80%.
- **Deleting a vault** is in Obsidian (Settings → Ownsync → Advanced), from a device with the current token, after typing the vault's short ID. The Vault keeps a tombstone: it can't be created again, and its devices are told "deleted on the server" (close 4004). The notes on devices stay.
- **Not built (owner decisions):** restoring the whole vault from the dashboard (encrypted history copies and vault snapshots exist, sections 8 and 9, but only a device can open them), recovery with a passkey (it would put the Cloudflare account in the trust path for the recovery code), and any page hosted elsewhere than the Worker.
- **Tests.** `server/test/dashboard.test.ts` runs setup, the race, the window, the lockout and replacing passkeys with a software authenticator (`server/test/passkey.ts`, real CBOR and ES256).

## 7. Updates (2026-11-22)

The owner's rule: only a release I author and sign myself can install. Each Worker runs code from my releases, so this is the one place someone other than the Owner can change what a Worker does.

- **The release key.** An SSH key (`gpg.format ssh`) used only to sign release tags, behind a passphrase, on my laptop. GitHub never holds it. `scripts/sign-release.sh` makes the annotated, signed tag (bare version, `0.2.0`) and checks it; `release.yml` refuses to publish a tag that isn't annotated, signed with that key, naming itself and pointing at the commit it builds.
- **One pinned key.** Its public half is in `server/.github/workflows/update-ownsync.yml` as an allowed-signers line (`* namespaces="git" ssh-ed25519 …`). `scripts/verify-release-tag.sh` and `release.yml` read it from there, so a release passes exactly the check the updaters run. While it's the placeholder, every check fails.
- **The updater** lives in each Owner's repository, and the update never touches `.github`, so the copy an Owner has is frozen: its checks and its key are those of the day it was installed. Daily and on "Run workflow" it takes the newest published release by version number, fetches that tag with git, checks it's an annotated tag naming itself, verifies its SSH signature against the pinned key (OpenPGP and X.509 are switched off), and from then on uses only the commit it signs. It installs that commit's `server/` only if it's newer than the installed `VERSION` and its own `VERSION` matches the tag.
- **The 3-day wait** is counted on the Owner's side, per version: each run records the first time it saw each verified (version, commit) newer than the installed one (the 5 newest), with its own clock, in a commit on `refs/notes/ownsync-update` in the Owner's repository. That ref isn't a branch, so Workers Builds doesn't redeploy for it. A scheduled run installs the newest version that has waited 3 days, even while a newer one still waits. A different commit for a version starts that version's wait again and fails the run. State that can't be read or saved fails the run; a missing ref is a first run. "Run workflow" installs the newest at once, never skipping the signature.
- **Storage changes** (`[[migrations]]` or Durable Object bindings in `wrangler.toml`) never install on a schedule: the run fails, so GitHub emails the Owner, and "Run workflow" installs.
- **Failures install nothing** and fail the run.
- **Limits.** If my release key is stolen, its holder can ship any Worker code; the 3-day wait is the only window to notice, and every updater trusts that key until its Owner replaces the file by hand (there's no rotation). A tag signs a SHA-1 commit ID. Replacing an older updater, or installing the first one, trusts whatever `main` serves that day. The plugin isn't covered: Obsidian downloads `main.js` from the GitHub release with no signature check, so whoever controls this GitHub repository controls the plugin, attested build or not.

## 8. Note history, Recently deleted and history backup

**Local note history.** Each device keeps copies of the notes edited on it in its own IndexedDB, at most one every 10 minutes per note: everything from the last day, then one a day per note for 30 days, up to 50 MB in all. Only an explicit restore writes to the vault.

**Recently deleted.** A deleted note's ID stays in the synced index, marked deleted, and every device keeps its state (see "Deleted notes keep their state" below). So any device can list deleted notes and bring one back; the restore is an ordinary change to the index that syncs like any other.

**Encrypted history backup.** The plugin can upload copies from its local note history and list them from another device. Each copy is a separate encrypted envelope filed under the note's current-epoch document tag. The plugin pads the encoded copy to a power-of-two KiB bucket and skips copies larger than 1 MiB. When opening history, it checks the current epoch, vault, note tag, note ID and copy time. Copies appear newest first by their sealed timestamp. The reported device ID comes from the envelope and is a claim any vault member can make.

Uploads wait a random 30 seconds to 5 minutes. On session stop, the plugin drops unsent uploads and keeps their local copies. Pending clears and requests already on the wire get up to five seconds to finish.

After a key rotation, the plugin lists copies from the new epoch. It can clear copies for a note's current tag or for the whole vault. An older Worker leaves local history available. The Worker keeps copies for 30 days and at most 50 MiB per vault, dropping the oldest first; that counts toward the vault's Durable Object storage. A restore writes the selected text as an ordinary edit, which the sync engine handles like any other edit.

## 9. Encrypted whole-vault snapshots

Once a device is connected and caught up, it can take a daily snapshot of Markdown text and the current attachment references. If references are unavailable, it can take a notes-only snapshot. The Worker assigns the UTC day and stores individually encrypted parts. The device checks the Worker's list before collecting files and records the ordered hashes in the encrypted synced index after the Worker acknowledges the complete upload. It remembers the successful day in local storage so a restart after deletion won't recreate the day's snapshot.

The Worker keeps seven UTC days and the newest snapshot in each of the four ISO weeks entirely before that window. It can prune older complete snapshots as uploads arrive to stay within 150 MiB, and always protects the newest complete copy.

The synced index determines which snapshots a device can open. The Worker can supply ciphertext and report availability. Devices verify each envelope against the ledger before decrypting it, including when using an older key from the key ring. After validating every part and the bounded gzip stream, the plugin checks all file paths against the vault's path rules. The snapshot client exposes note text and attachment paths to the caller. File restores are handled by the caller.

The list shows ledger entries whose data is absent from the Worker. Removing a snapshot asks the Worker to delete it and then removes the ledger entry. Upload and deletion are serialized within each vault session.

## 10. Storage window (design for 0.2.0, not built)

One per-vault setting on the Worker, chosen in the dashboard: 30 days (default), 90 days, 6 months, 1 year. The Worker keeps **history** only inside that window, a hard limit on its own clock. No device clock and no device's view of what references what decides an erasure.

**What the window covers.**

- *Never windowed:* every note's state, deleted notes included (they are small, and stay as today), and the current version of every live attachment.
- *Windowed, from the moment it stopped being current:* an attachment version that was replaced, and the versions of a deleted attachment.
- *Windowed, from when it was made:* history backup copies (the fixed 30 days becomes the window; the 50 MiB cap stays) and vault snapshots.

There is no note purge, and nothing is added to the index.

**Version-scoped chunks.** From 0.2.0 a chunk belongs to exactly one version, so erasing an expired version needs no analysis of who else uses its chunks.

- A version already has a unique ID (`Ref.u`). Its *tag* is `HMAC(name key, "version" | u)`; its chunks are named `HMAC(name key, u | index | SHA-256(plaintext))`. Both use the first epoch's name key, as `chunkName` does, so a rotation changes neither. The plaintext hash stays in the name, so a device still checks each chunk against its name; `Ref.h` stays the content's keyed hash, so matching files by content is unchanged. `Ref` gains `s: 1` to say its chunks are scoped.
- The scope is the version, not the attachment ID: a version that loses a conflict becomes an attachment of its own (`split`) and keeps its chunks.
- The cost: identical content is stored once per version, not once per vault. A copied file uploads again. The gain, besides erasure: a removed device can no longer test whether a file is in the vault.
- Chunks written before 0.2.0 are content-addressed and may be shared. They have no tag and are never erased.

**Retirement, on the Worker.** Tables `versions(tag PRIMARY KEY, retired_at)` and `version_chunks(name PRIMARY KEY, tag)`, indexed on `tag`, both added to `erase`; `chunks` itself is unchanged. Neither holds an envelope, so nothing below reads one.

- `vput tag(32) | name(32) | envelope`: stores the chunk as `put` does (the first writer's envelope is kept). The name is recorded under the tag only if this `vput` inserted the chunk, or the name is already recorded under the same tag; otherwise the reply is `missing` and nothing changes. A name belongs to one tag for good, so no device can claim an old-style chunk, or another version's, and have it erased. At most 1,024 chunks a tag. A recorded `vput` clears the tag's `retired_at`. Reply `stored`.
- `mark id(4) | flags(1) | n × tag(32)`, n ≤ 1024. Flag *retired*: set `retired_at` to the Worker's now where it is empty. Flag *current*: clear it. Flag *last*: this ends a device's full list of what is current. Reply `marked id(4) | n × tag(32)`: every tag it called current that has a recorded chunk missing from `chunks`. That is computed from what is stored, every time; there is no "erased" flag to go stale after a half-finished erasure or a half-finished re-upload.
- Erasure: after a `mark` flagged *last*, and only then, the Worker deletes chunks of versions with `retired_at + window < now`, a bounded number per pass. The `version_chunks` rows stay (about 65 bytes a chunk), which is how a missing chunk is known later.
- Both frames need the vault's token like every frame. Tags are opaque to the Worker.

**Devices.** Every 0.2.0 device that holds the attachment documents reports; none decides.

- A device's *current set* is every `u` in `v` of every live attachment, not only the head: `split` moves a version to a copy under the same `u`, and keeps same-content entries with different ones. After each input the device reports the difference: what left the set is *retired*, what joined is *current*. That one rule covers a replaced version, a deletion, a conflict copy, a restore and a note brought back.
- An upload dropped before it was published (replaced by a newer save, or its file gone) is marked *retired*. `publish` marks nothing itself; the set difference does.
- Reports are kept locally as `mark:<tag>`, the latest state per tag, written in the same commit as the change that causes them, sent after `synced`, deleted on `marked`. A device catching up sends only where each version ended.
- Once a day, after `synced`, each device sends its whole current set as *current*, the last frame flagged *last*. That repairs a lost or misordered report, long before a window passes.
- If `marked` names a version with missing chunks and the device's file matches it, the device uploads the chunks again, after checking that the names it computes equal `Ref.c`. This is how an attachment deleted on one device and renamed offline on another, past the window, gets its content back when the rename wins.

**Why it is safe, and where it isn't.** A version is erased only if it stayed retired for the whole window by the Worker's clock, and a device's daily list un-retires anything current. The window never makes a loss faster than the window. But in a vault no honest device opens for longer than the window, a stolen device that hasn't been removed can retire everything and have it erased. Device IDs are chosen by the device on each connection, so the Worker's record doesn't say who did it. The only recovery is a device that still holds the file uploading it again, which the rule above does. That device could already delete the attachments on every device, and a malicious Worker can already delete anything.

**The invariant the tests check:** with every device synced and idle, no live attachment's current version names an erased chunk; nothing current was erased; every erasure came after `retired_at + window` on the Worker's clock.

**Setting, snapshots, dashboard.**

- Table `window(id = 0, days, next_days, next_at)` in the vault's object, set through an RPC method like `stats()`, not a `/vault/` route. A longer window applies at once. A shorter one applies 7 days later, to everything it covers; until then the dashboard shows "Changes to 30 days on 3 December · Cancel". The dashboard deletes nothing immediately (section 6).
- Snapshots are thinned inside the window: every day for 7 days, the newest of each ISO week for 8 weeks (4 at 30 days, as today), then the newest of each 28-day block. That is 11, 16, 20 and 26 snapshots.
- Snapshot budget: the smaller of a cap per option (150, 250, 350, 500 MiB) and the vault's free space less 100 MB, so snapshots give way before note sync does. Over budget, the snapshot with the smallest (days to its next newer neighbour) ÷ (age in days) goes first; the two newest complete ones never go. A 5 MB vault needs 55, 80, 100 and 130 MB; a 40 MB vault keeps 3, 6, 8 and 12 snapshots under the caps.
- The dashboard shows, per vault, the window, the snapshot count and size, how much retired attachment content is waiting to expire, and an estimate for each option.

**Recently deleted** lists deleted notes and attachments from within the window; `names` tells the plugin the window, for display only. A deleted note restores as today. A deleted attachment is restored in this order, online only: `mark` its version current, wait for `marked`; if it names missing chunks, show "its file is no longer stored" and restore nothing; otherwise publish the index change. The list is drawn from the deleter's clock and erasure runs on the Worker's, so only the Worker's answer counts.

**Mixed versions.**

- An older Worker closes the socket on an unknown frame, so the plugin uses `vput` and `mark` only when `names` reports Worker 0.2.0 or later.
- A 0.1.5 device checks a chunk against a name made from its content alone, so it cannot download a scoped version: it reports the chunk as damaged and retries. So a 0.2.0 device uploads scoped chunks only when every device the Worker has seen in the last 30 days reports 0.2.0 or later (`names` says so). A device with no version on record counts as old, and so does a full device list (64, the most the Worker keeps), since an old device may have fallen off it. Until then uploads go the old way, and those chunks are never erased.
- What a 0.1.5 device uploads is never erased. It sends no reports: the versions it replaces are retired by whichever 0.2.0 device applies its change.

**Tests.** Sim (`plugin/test/engine.test.ts`; the sim server gains the tables, both frames and a clock the test moves):

- A replaced version's chunks are there at window − 1 day and gone after the next daily list past the window; the current version's never go.
- A deleted attachment brought back inside the window has its content; past the window, a device holding the file uploads it again.
- A retire report that arrives after the version became current again is undone by the next list.
- A vault unused for longer than the window loses nothing current on the first connection back.
- A conflict copy keeps its chunks, and so does a second entry with the same content.
- A restore of a deleted attachment past the window is refused with the message, and nothing is published.
- A stolen device retires everything in a vault left unused past the window: the content is erased, and a device that holds the files puts it back on its next list.
- A report is on record after a crash between the change and the send.
- Old-style chunks survive everything.
- No scoped upload while a 0.1.5 device is listed.

Worker (`server/test/server.test.ts`): `vput` un-retires and caps a tag, and refuses a name that exists as an old-style chunk or under another tag; `mark` sets the time once and clears it; erasure only after *last* and only past the window; `marked` names a version half erased or half uploaded again, every time; a lowered window waits 7 days and can be cancelled; history copies follow the window; snapshot counts, eviction order and budget. Fuzz: time jumps beyond the window, with the invariant checked at the end.

**Left open.**

- No screen restores an older version of an attachment yet; the window only keeps them.
- A live attachment whose content was erased and whose file no device holds stays without content. It takes a 0.1.5 device winning a rename against a deletion past the window, or the file being deleted everywhere meanwhile.
- A version put but never published by a device that never returns is never retired, so never erased.
- The rows of erased versions (about 65 bytes a chunk) and note tombstones stay for good.
- Old-epoch entries of live documents still stay after a rotation.
- A snapshot can hold a deleted note for as long as the window.

## What the server can still see

- the number of documents and log entries, their sizes, and edit times and frequency
- which device is online when, and roughly from where (IP)
- when a note is open in an editor and its cursor moves (presence frames), though not where or by whom
- attachment chunk count and sizes, when chunks are uploaded and which device fetches which; that two files in the vault hold the same content (same chunk names)
- which note tags get history copies, the padded sizes and upload times, and which device's connection sends them
- whole-vault snapshot IDs, upload days and times, epochs, part counts and padded envelope sizes
- the number and size of membership records, when the epoch changes, whether there is a recovery key, and for each rotation the IDs of the devices it wraps the key to and the rotating device's ID and public key (in clear so a recovering device can open its wrap). Device IDs are also in every envelope header.

History envelopes and whole-vault snapshot parts use fixed size buckets. Identifiers are random or HMAC-derived.

## Prior art

- **secsync** (nikgraf/secsync, Apache-2.0): an architecture for end-to-end encrypted CRDTs with snapshots, updates and ephemeral messages. Last updated 2024-09, so use it as a protocol reference, not a dependency.
- **Keyhive / Beelay** (inkandswitch/keyhive, Apache-2.0, active): research on encrypted sync with group key management. Relevant later for sharing.
- **Self-hosted LiveSync**: tested 2026-11-13 against R2 with E2EE and path obfuscation. The bucket held no plaintext content or names; device names, vault names and versions were stored in clear. Shows the metadata to avoid.

## Build order

1. Sync engine and fuzz test, headless. Done.
2. Worker mailbox and encrypted transport. Done, and running on real free Cloudflare accounts.
3. Obsidian layer. Done on desktop and in daily use with an iPhone; a real-Obsidian run at 1,000 notes is in the stress test results. Still to do: real-Obsidian runs at 10,000 and 50,000 notes, and Android.
4. Setup page, pairing helper page, dashboard, CI and releases. Done. Ownsync is in Obsidian's community plugins since 15 November 2026.
5. Recovery key, device removal (section 1), moving the vault key into Obsidian's secret store. The key in secret storage and the recovery kit at setup are in use in real Obsidian. Recovering a vault and removing a device are done headless and against `wrangler dev`, not yet tried in Obsidian or on phones.
6. Attachments. Done, and tried by hand in real Obsidian on 15 November 2026: attachments synced between two devices, with two vaults on one server.

## Open questions

- ~~Can a stolen device that hasn't been removed yet start its own rotation first?~~ Yes, and the protocol can't stop it, only detect it: see "Competing rotations" in section 1.
- Minimum iOS and Electron versions for Obsidian: confirm that ECDH P-256 and HKDF in WebCrypto cover them, and whether Obsidian on iOS can open `obsidian://` links scanned with the Camera app.
- One Durable Object per vault caps storage at the Durable Object limit; check whether a large vault's log plus snapshots fit, or move snapshots to R2.
- How long can a device stay offline before the grace period bites? 30 days is a guess.

Deferred so far, one line each:

- Anyone holding the vault key (a stolen device not removed yet, or a stolen pairing code) can store a record that no device accepts; the device list is then stuck and devices say so. The remedy is a new vault. Without signatures the Worker can't tell good records from bad.
- A device that is behind can be marked "removed" by a removed device working with the Worker, as long as it is still at an epoch the attacker knows.
- The pairing mailbox still takes a `PUT` from anyone.
- If a pairing code is stolen (the new device sees "someone else used this code"), the vault key must be treated as exposed; until device removal and key rotation exist, the only remedy is a new vault.
- Deleted notes keep their state on devices and on the server forever. They are small, and section 10 leaves them alone.
- A live edit is relayed before it is stored. If the sending device is destroyed in the seconds before it stores it, the edit reaches the server only with another device's snapshot.
- One note's sealed state must fit in 4 MiB.
- A device that disconnects with a note open isn't told to clear its cursor; the others drop it after the 30 s awareness timeout. A device still catching up gets cursors at their next 15 s renewal.
- Rotation wraps stay on the Worker inside their record; they aren't deleted once the recipient has its key.
- After a rotation, the old epoch's log entries stay on the Worker; devices joining later download and skip them.
- Devices are shown by an 8-character ID, not a name: the record format has no name field.
- After the user resolves a fork, removing the other record's sender is left to them.
- A removed device keeps the first epoch's name key, which names attachment chunks for the vault's whole life; with the Worker's help it could test whether a file it already has is in the vault. It can't read anything.
- The pairing device remembers the codes it showed in memory only; restarting within 10 minutes of a pairing gives a false "paired by" alert.
- The snapshots after a rotation count as sent once they're on the socket, not once the Worker has stored them.
- A device a rotation overtook while it was being paired (its starting record is no longer the head's epoch) can't join; pair it again.
- The pairing mailbox has no rate limit. The existing device learns a code was used only from the new member appearing (the pairing screen shows its ID); a code taken and never followed by a join goes unnoticed.
- Before the first vault exists, a botnet sending over 1,000 wrong setup keys an hour can block creating it; the way out is a new `SETUP_KEY` in the Cloudflare dashboard, which the locked message says.
- Scanning a real pairing QR on iOS is untested; the handler is tested by calling it directly. The QR opens the Worker's own add-device page, which hands the link to Obsidian, because a phone's camera opens web links. That page can read the pairing code, so whoever controls the Worker (or the Cloudflare account) could change it and take the vault key while a device is being added. Accepted (owner decision 2026-11-14: everything on the Worker, no other site); copying the link on a computer skips the page.
- File names that are invalid on one platform, or differ only by case, are reported per note and not synced there.
- Sync envelopes use their encoded size.
- Attachment chunks no longer referenced are never deleted from the Worker (garbage collection), so replaced and deleted attachments keep using its 1 GB (the storage window in section 10 is designed, not built).
- A chunk reference records no epoch: every chunk is under epoch 0 until rotation exists, which must add it.
- A file is in memory whole while it is read, hashed or written (Obsidian has no partial reads or writes), so the size limit also bounds memory. A download interrupted by a crash starts over.
- A device that joins with its own copy of an attachment that differs from the vault's keeps both, and uploads its copy.
- The Deploy button needs this repository public on GitHub at `humanglitch191/ownsync`, branch `main`.

## Later

- Sharing a folder with another person: a key per shared folder, wrapped to each member's device keys; invitations through the pairing relay.
- Per-note documents (section 2).
