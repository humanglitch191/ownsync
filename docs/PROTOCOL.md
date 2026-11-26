# Ownsync protocol v1

Status: draft, 2026-11-14; file table added 2026-11-26 (0.2.6). Covers keys, envelopes, the file table, rotation, recovery, the membership log, pairing, history backup and whole-vault snapshots. WebSocket frames are implemented in `server/src/wire.ts`, which is the source of truth for their layouts.

The reference implementation is `protocol/ownsync.ts`, and `protocol/vectors.json` holds fixed test vectors. `cd protocol && npm test` checks the code against them; `npm run vectors` rewrites the outputs after a deliberate format change. Any other implementation (plugin, headless client) must reproduce every output in `vectors.json`. Design reasoning is in `DESIGN.md` section 1; this file states only the rules.

## Conventions

- All integers are unsigned big-endian: `u8`, `u16`, `u32`, `u64`. `|` is byte concatenation.
- `vaultId` and `deviceId` are 16 random bytes. `docId` is 16 random bytes, chosen once per document and stored inside the encrypted vault, so it stays the same across epochs. A table row's `file` ID and a request's `req` ID are 16 random bytes each.
- P-256 public keys are 65-byte uncompressed points (WebCrypto `raw`). Private keys travel only as the 32-byte scalar `d` and are imported as JWK.
- `HKDF(ikm, salt, info)` is HKDF-SHA256 with 32 bytes of output. `HMAC` is HMAC-SHA256. `SEAL(key, nonce, plaintext, ad)` is AES-256-GCM with a 16-byte tag appended.
- `L(name)` is the ASCII string `ownsync/v1/<name>`.
- `VERSION = 1`. `SUITE = 1` means AES-256-GCM, HKDF-SHA256, HMAC-SHA256, ECDH P-256. Receivers reject any other version or suite.
- `RECOVERY_ID` is 16 zero bytes: the member ID of the recovery key pair.
- The all-zero nonce is used only with keys that seal exactly one message (marked "one-shot" below).

## Key schedule

Every key below comes from the VMK of one epoch, with `salt = vaultId`.

| Key | Derivation | Use |
|---|---|---|
| seal key | `HKDF(VMK, vaultId, L("seal") \| deviceId)` | seals that device's updates, snapshots, presence, attachment chunks, table records, history copies and whole-vault snapshot parts |
| name key | `HKDF(VMK, vaultId, L("name"))` | with epoch 0's VMK: chunk names, version tags, path keys, migrated file IDs and conflict suffixes; with the current one: document tags |
| auth token | `HKDF(VMK, vaultId, L("auth"))` | sent in `hello`; the server stores only `SHA-256(auth token)` |
| member key | `HKDF(VMK, vaultId, L("member"))` | encrypts membership records |
| keyring key | `HKDF(VMK, vaultId, L("keyring"))` | one-shot: seals the previous epoch's VMK |

A key per device means each AES-GCM key sees only one device's random nonces, which keeps every key far below the 2^32 limit for random nonces. Every kind of envelope uses the same seal key, because `kind` is bound in the AD.

## Envelopes

```
envelope = header(23) | nonce(12) | ciphertext+tag
header   = u8 VERSION | u8 SUITE | u8 kind | u32 epoch | deviceId(16)
AD       = header | vaultId | docId
key      = seal key of (VMK of epoch, deviceId)
```

- `kind`: 1 update, 2 snapshot, 3 presence, 4 attachment chunk, 5 update part, 6 history copy, 7 whole-vault snapshot part, 8 attachment record, 9 note record.
- **Update parts.** A Worker WebSocket frame holds at most 1 MiB, so an update larger than `PART_SIZE` (512 KiB) is split. Each part is its own kind-5 envelope with plaintext `groupId(16) | u16 index | u16 count | bytes`. The server stores parts as ordinary log entries. A receiver applies the update only when every part of the group has arrived. A group that never completes is resent whole by its sender's next catch-up. A snapshot can't be split yet, so a device sends no snapshot larger than `PART_SIZE`.
- For chunks, `docId` in the AD is the chunk name. For table records (kinds 8 and 9), it is the row's `file` ID.
- `nonce` is 12 random bytes.
- The header is in clear so a receiver can pick the key. The Worker can read it without opening the envelope.
- `deviceId` is self-asserted. It picks the key and identifies the sender; it doesn't authenticate anyone, since every member holds every seal key.
- Rules for receivers:
  - Reject an unknown version or suite.
  - Apply the epoch rules for the envelope kind (see "After a rotation", "File table", "History backup" and "Whole-vault snapshots").
  - Find the VMK for the epoch in the key ring.

Plaintexts: an update is a Yjs update (`Y.mergeUpdates` of about 250 ms of edits). A snapshot is `Y.encodeStateAsUpdate`. Presence is a y-protocols awareness update. A chunk (kind 4) is up to 1 MiB (`MAX_CHUNK`) of an attachment's content, with no framing. A table record (kinds 8 and 9) is UTF-8 JSON (see "File table").

**Documents.** Text syncs as separate Yjs documents: one per note, holding its text in the Yjs text `t`, and one named `index`. Paths, deletions and attachments are not in any document; they are rows of the file table. The `index` document now holds only the whole-vault snapshot ledger, in its map `snapshots` (see "Whole-vault snapshots"). An update or snapshot envelope's plaintext is `u8 length | document ID | Yjs update`, where the ID is the ASCII string `index` or a note's ID in lowercase hex. Its AD uses the document's tag in place of `docId`:

`tag = HMAC(name key, "doc:" | document ID)[0..16]`

The Worker files entries under the tag. That lets it drop the entries a snapshot replaces, and tells it how many documents a vault has and when each changes, but not which note is which.

**Chunk name** = `HMAC(name key of epoch 0, SHA-256(chunk plaintext))`, all 32 bytes, hex. The name key is always the first epoch's, for the vault's whole life: names are how devices recognise content (an attachment's version is named the same way over the whole file), so they mustn't change when the key rotates. Duplicate chunks are stored once. A chunk envelope is sealed under the epoch current when it was uploaded and keeps it; any device opens it with that epoch's key from its key ring. A device that joined after a rotation fills in the older keys from the rotation records' `prevVmkSealed` before it starts syncing.

**Version tags and scoped chunks.** Every attachment version has an ID `u`, a string of at most 64 bytes, unique to that version. Since 0.2.0 a version's chunks are its own. Both formulas use epoch 0's name key, as the chunk name does:

```
version tag       = HMAC(name key, "version" | u)                                              32 bytes
scoped chunk name = HMAC(name key, u8 len(u) | u | u32 index | SHA-256(chunk plaintext))       32 bytes
```

`index` counts the version's chunks from 0. The tag is what the Worker files a version's chunks under (`vput`) and what a table row carries as `version`. In `vectors.json`, `versionTag` and `scopedChunkName` use `u = "3f9a1c0e5b7d2a46"`, index 2 and the vector plaintext.

## File table

Every file, note or attachment, is one row at the Worker. The Worker compares the fields in clear; only a device can open `record`.

```
row = file(16) | u8 hasVersion | version(32, only if hasVersion = 1) | pathkey(32) | u64 seq
    | u8 isDeleted | u64 deleted (only if isDeleted = 1) | record
```

- `file`: the file's ID, chosen by the device that creates it and fixed from then on, across renames, edits, deletion and restore.
- `version`: an attachment's version tag. A note has none: `hasVersion = 0` is what makes a row a note.
- `pathkey`: the path key below. No two rows that aren't deleted may share one.
- `seq`: the table's own counter, separate from the log's. The Worker sets it to a new highest value each time the row changes. It is the `base` the next change must name.
- `deleted`: the Worker's clock at deletion, in Unix milliseconds.
- `record`: the rest of the frame, 1 byte to 4 MiB: an envelope of kind 8 (attachment) or 9 (note), with `file` as `docId` in the AD.

**Derived values.** All three use epoch 0's name key for the vault's whole life. `\0` is one zero byte.

```
path key         = HMAC(name key, "ownsync/table-path\0" | path as UTF-8)                      32 bytes
migrated file ID = HMAC(name key, "ownsync/table-file\0" | 0.2.x ID)[0..16]                    16 bytes
conflict suffix  = hex(HMAC(name key, "ownsync/conflict-suffix\0" | h(32) | u32 counter))[0..6]
```

- The path key takes the exact path, with no normalisation. `vectors.json` `tablePathKey` is the key of `Images/Café.png`.
- The migrated file ID is used only at migration, so every device derives the same `file` for a 0.2.x note or attachment. The input is that ID's bytes (its hex decoded). `vectors.json` `tableFileId` uses `3f9a1c0e5b7d2a46`. A file created later has a random `file`.
- The conflict suffix names an attachment's conflict copy: `<name> (conflict <suffix>)<.ext>`, where `h` is the copy's content hash (below) as 32 bytes. `counter` is left out entirely when it is 0. A device tries 0, then 1, 2 … while the name is taken, so two devices holding the same bytes pick the same name. There is no test vector for it yet.
- A note's conflict copy is named from the note it was copied from: `<name> (conflict <first 6 hex of that note's ID>).md`, applied again while the name is taken. A copy made after a crash with an open editor is `<name> (recovered <first 6 hex>).md`, then `(recovered <first 6 hex> 2)` and so on.

**Attachment record (kind 8).** JSON `{ path, bytes, mtime }`. `mtime` is the file's modification time in milliseconds, or `null`. `bytes` is the version, `{ h, n, c, u, s }`:

- `h`: the chunk name formula applied to the whole content (`hex`), which identifies the content;
- `n`: the size in bytes;
- `c`: the names (`hex`) of its chunks in order: the content split every 1 MiB, the last one shorter (none for an empty file);
- `u`: the version's ID;
- `s`: `1` when the chunks are named as scoped chunks of `u`. Absent on a version carried over from before 0.2.0, whose chunks use the plain chunk name.

**Note record (kind 9).** JSON `{ kind: "note", path, id }`. `id` is the note's document ID in hex: the document tag derives from it, so the text is found whatever the path. The note's text is never in the row, and editing text doesn't change the row.

**Note tombstones.** The record of a deleted note also carries what its deleter had seen, as exactly one of:

- `snapshot`: base64 of `Y.encodeSnapshot(Y.snapshot(doc))`, the state vector and delete set of the note's document as the deleting device knew it;
- `vector`: base64 of a Yjs state vector. Only on tombstones migrated from 0.2.x, which recorded no delete set.

A device whose copy of the document holds anything outside that (an update `Y.snapshotContainsUpdate` rejects; for `vector`, any client clock beyond it) sends `restore` naming the deleted row's `seq`. A note comes back only through `restore`.

**What a record is bound to.** The seal binds the vault, the kind, the epoch, the sealing device and the `file` ID. The rest a receiver checks itself, and rejects the row if any check fails:

- the kind matches the row: 8 with a `version`, 9 without;
- the path key of the record's `path` equals the row's `pathkey`;
- for an attachment, the version tag of `bytes.u` equals the row's `version`; `h` and every name in `c` are 64 hex characters, `n` is a non-negative integer, `u` is a non-empty string, `s` is absent or `1`, and the path doesn't end in `.md`;
- for a note, the path ends in `.md` and has no `\` and no empty, `.` or `..` segment; `id` is hex; a live row carries neither `snapshot` nor `vector`, a deleted one exactly one, which must decode.

`seq` and `deleted` are the Worker's and are not sealed. Nothing in a record names its `seq`, so a Worker could serve an earlier record of the same file with the path key and version it had then; it can't alter one or move it to another file. A record is sealed under the epoch current when it was made, and one not yet accepted is sealed again after a rotation. Records already stored are not re-sealed: a device opens them with that epoch's key from its key ring, as it does chunks. `vectors.json` `tableEnvelope` is a kind-8 envelope of the vector plaintext with the vector `docId` standing for `file`.

**Attachment rules.**

- A device proposes a version only after the Worker has acknowledged (`stored`) every chunk in `c`.
- A device writes the file only when it holds every chunk, each matching its name, and the whole is `n` bytes and matches `h`. Otherwise it writes nothing and tries again later.

### The 0.2.x format, read once at migration

Before 0.2.6 the `index` document's map `notes` held one value per note or attachment ID: `{ p: path }` if live, `{ p, d: base64 state vector, t: deletion time in ms (may be absent) }` if deleted. A path ending in `.md` was a note; any other was an attachment, whose own Yjs document held an array `v` of versions `{ h, n, c, u, s }`. The first element was the current version; any other distinct `h` was a concurrent version not yet split off.

Nothing writes this format any more. The device that migrates a vault reads it from the Worker's log and turns it into rows:

- each note becomes a note row with its `id` kept, and `d` becomes the tombstone's `vector`;
- each attachment becomes a row for its first version; each other distinct `h` becomes a row of its own, at the conflict-copy name for that `h`;
- `file` is the migrated file ID of the 0.2.x ID, or of the version's `u` for a split-off version. If an attachment with ID `u` already exists and has moved on to other content, the input is `u` twice and the row is installed as deleted;
- a deletion with no `t` is dated by the Worker when migration commits.

## Membership log

A hash-chained list of records. The server stores them as opaque blobs and serves the chain; devices verify it. Records are encrypted, not only authenticated, so the server can't read pairing times, who paired whom, removals or the recovery public key. It (and anyone who knows the vault's address, since records can be fetched without a token) can still infer roughly how many devices there are from a record's length, and sees the random device IDs each rotation's key is wrapped to.

```
record = header | nonce(12) | SEAL(member key, nonce, body, header | vaultId)
header = u8 VERSION | u32 number | u32 epoch | u16 len | prevVmkSealed(len, 0 or 48)
body   = prevHash(32) | senderId(16)
       | u16 nMembers | nMembers × (deviceId(16) | publicKey(65) | u64 pairedAtMs | pairedBy(16))
       | u16 nRemoved | nRemoved × deviceId(16)
       | u16 len | recoveryPub(len, 0 or 65)
record hash = SHA-256(record)
```

- **Sealing key.** The member key of the epoch the sender is in. For a rotation record (`prevVmkSealed` present), that is the *old* epoch (`epoch - 1`), so a removed device can still read the record that removed it. Trailing bytes are rejected.
- **What stays in clear.** The record number, its epoch and `prevVmkSealed`, which is already sealed under the new VMK. `prevVmkSealed` has to be outside the body: a device holding only the new VMK (just paired, or recovered) opens it first to get the old VMK, then opens the body. The server already sees epochs on every envelope.
- **First record:** number 0, epoch 0, `prevHash` = 32 zero bytes, sealed under `VMK_0`, written by the device that creates the vault (members: itself, `pairedBy` = itself). If a recovery key is set up at creation it carries `recoveryPub`, and `VMK_0` is wrapped to it (and to the creator) as in "Rotation wraps", with the first record's hash as salt.
- **Pairing record:** same epoch as the previous record, adds one member, `prevVmkSealed` absent.
- **Rotation record:** epoch = previous + 1, lists the full new member list and the removed IDs, and carries `prevVmkSealed = SEAL(keyring key of VMK_new, 0, VMK_old, vaultId | u32 newEpoch)`. From the current VMK a device can unseal every older one by walking the chain.
- `recoveryPub` is repeated in every record while a recovery key exists (absent if none), so the newest record alone says what to wrap to.
- **Accepting a record.** A device keeps the hash of the newest record it accepted (its head). It accepts a new record only if:
  1. it decrypts,
  2. `number` = head's number + 1 and `prevHash` = head hash,
  3. `senderId` is in the head's member list, or is `RECOVERY_ID` while the head has a `recoveryPub`, or (pairing records only) is the one device the record adds,
  4. the sender is still in the new member list (or is `RECOVERY_ID`),
  5. for a rotation record: `epoch` = head's epoch + 1, and the device holds a wrap addressed to it from that sender that unwraps, with the sender's public key taken from the head's member list (or the head's `recoveryPub`), and `prevVmkSealed` opens to the head epoch's VMK,
  6. the member list has no repeated ID and no `RECOVERY_ID`, keeps every remaining member's public key, and its removed IDs are exactly the head's members it lacks,
  7. a pairing record (no `prevVmkSealed`) keeps `epoch`, adds exactly one member, removes none and keeps `recoveryPub`; a rotation record adds no member, except one when the sender is `RECOVERY_ID`.

  A device that was a member and isn't in a rotation record's new member list alerts the user and stops: it was removed by a rotation it didn't start (a device can't remove itself).
- **Where a device starts.** A device paired with the code below starts from the pairing device's newest record, checked against its hash; any other device starts from record 0 (one it wrote, or, for a vault set up before the log existed, whatever record 0 the server holds that decrypts under its key). A device holding the VMK but missing from the member list then appends a pairing record adding itself.
- **Claims about yourself.** A device alerts the user when it sees a valid record whose `senderId`, or a newly added member's `pairedBy`, names this device, but which it didn't create. Pairing records are authenticated only by the member key, which every member has, so a stolen device can write "paired by laptop". The laptop is the one device that can tell the claim is false. Since a paired device writes its own record naming the pairing device, the pairing device remembers each code it showed for 10 minutes and lets one such record through per code.
- **"Paired by" is a claim.** The removal screen labels `pairedBy` and `pairedAtMs` as reported by the pairing device, not verified. The list of members itself is reliable: only members can add records, and every member can see every record.
- **Forks at the head.** Two valid records extending the device's current head (same `prevHash` = head hash) are a fork. The device stops publishing and shows both records (sender, members added and removed). It resumes on the record the user picks (checked again by the rules above); the user then removes the other side's sender. There is no automatic tie-break. The Worker keeps one record per number, so only a misbehaving Worker shows a fork.
- **Conflicts behind the head.** A valid record whose `prevHash` points to an older record than the head (a competitor to a record the device already accepted) does not freeze the device. The device ignores it, logs it, and shows a single dismissible alert per conflicting record. Without this rule, a removed device that still holds an old epoch's key could freeze every device, with the server's help, by posting competitors at old positions. A removed device can't produce a valid record at the current head: that would need the current epoch's key. The alert still matters, because in a real race a device usually accepts whichever record it sees first.
- **Pairing a device.** The existing device hands the new one the current VMK, its newest record's number and hash, so the server can't feed it a stale chain, and its own device ID (see "Pairing"). The new device appends the pairing record itself: `senderId` = its own ID, `pairedBy` = the pairing device.
- **Stored form.** What the server keeps per record number (`protocol/ownsync.ts` `packStored`):

  ```
  stored = u32 recordLength | record | u16 n | n × (recipientId(16) | wrap(113)) | [senderId(16) | senderPub(65), only when n > 0]
  ```

  Wraps travel with their record. The sender is in clear only so a recovering device, which can't open the record yet, can open its wrap; every other device takes the sender's key from the member list, never from here. The server keeps records strictly in order and stores one only if its number is the next, so two devices adding a record at once can't fork an honest server's log: the slower one gets the winner's record back and builds on it.

## Rotation wraps

A rotation sends `VMK_new` to every remaining member and, if one exists, to the recovery key pair (recipient `RECOVERY_ID`, `recoveryPub`). Each wrap combines a one-time key with both parties' permanent keys (Noise-style `es + ss`):

```
e    = fresh P-256 key pair, one per wrap
IKM  = ECDH(e, recipientPub) | ECDH(senderPriv, recipientPub)      (x-coordinates, 32 bytes each)
info = L("wrap") | u8 SUITE | vaultId | u32 newEpoch | senderId | senderPub | recipientId | recipientPub | ePub
key  = HKDF(IKM, rotation record hash, info)                       one-shot
wrap = ePub(65) | SEAL(key, 0, VMK_new, info)                      113 bytes
```

- The static `ss` half is what authenticates the sender. A wrap built only from a one-time key (plain ECIES) can be made by anyone who knows the recipient's public key, so a removed device could send a VMK it chose under any sender ID. The test `a wrap from a non-member claiming to be a member is rejected` checks exactly this.
- The `es` half means a leaked sender private key alone doesn't open past wraps.
- The record hash and epoch bind a wrap to one rotation, so it can't be replayed into another.
- Public keys are in `info`, not just IDs, because IDs are self-asserted.
- The server stores wraps as opaque blobs, inside the stored record. (Deleting each once its recipient has acknowledged it is not built.)
- The rotating device wraps to itself too, so if it crashes before the server answers it takes in its own rotation like any other.
- When a recovered device rotates, the sender is `RECOVERY_ID` and `senderPriv` is the recovery private key.

## Pairing

- The existing device picks a one-time 16-byte code K. It stores `SEAL(HKDF(K, "", L("pair")), 0, payload, L("pair"))` (one-shot) at `PUT /pair/<room>`, where `room = hex(SHA-256(L("pair-room") | K)[0..16])` and `payload = VMK(32) | u32 epoch | u32 number | hash(32) | pairerId(16)`: the current VMK and epoch, the number and hash of the existing device's newest record, and its device ID.
- **Link:** `obsidian://ownsync-pair?host=<server URL>&vaultId=<vault ID>&code=<hex K>`, shown as text. It never contains the VMK. The QR code holds `vaultId` and `code` after the `#` of `<server URL>/add-device/`, the Worker's static page that turns them back into the link with its own origin as `host`; the part after `#` never reaches a server.
- **Mailbox.** The server's pairing mailbox accepts one `PUT` (at most 1 KiB) and serves one `GET`. It refuses refills and deletes everything after 2 minutes. The server sees only `room` and the sealed bytes.
- **New device.** It accepts only `https://` hosts (or `http://` on localhost) and a 32-hex-character vault ID, and asks the user to confirm the server and vault ID before anything changes. Then it `GET`s the room, opens the payload with K (exactly 88 bytes), makes its device ID and key pair, and saves host, vault ID, the VMK and the record to start from. It joins the log as in "Pairing a device".
- **Code already used.** The mailbox answers `410` for a code that was already used, and the new device tells the user the vault key may be exposed. A used or expired room keeps a tombstone and can never be refilled.
- Not yet: telling the existing device that its code was used.

## Recovery key

- **Recovery code.** 16 random bytes, shown as 26 characters of RFC 4648 base32 (`A-Z2-7`). The last 2 padding bits must be zero. Input ignores case, spaces and dashes.
- **Setup and replacement.**
  1. Generate a fresh recovery code and a fresh P-256 recovery key pair.
  2. Store `SEAL(HKDF(code bytes, vaultId, L("recovery-priv")), 0, d | recoveryPub, vaultId)` on the server. This is one-shot: a new code always comes with a new key pair.
  3. Append a membership record carrying the new `recoveryPub`: the first record at creation, otherwise a rotation, so the new VMK is wrapped to the new public key. The sealed private key goes to the server in the same `append` or `rotate` frame, and replaces the old one there.
  4. Delete the old sealed private key and its wraps. (The server replaces the sealed key; old wraps stay in their records.)
- **Replacing after a removal.** It is required when the removed device was lost or stolen, and suggested otherwise. A removed device knows the old `recoveryPub` and, together with the server, could plant a fake rotation chain. The removal and the replacement are then one rotation.
- **Recovery.**
  1. Fetch the records and the sealed private key (no token needed), decode the code and unseal the private key.
  2. Take the newest stored record with a wrap for `RECOVERY_ID`, unwrap it using the clear sender, open `prevVmkSealed` if present, then decode the record and check that it carries this `recoveryPub` and that its `senderId` and (for a device) the member's public key match the clear sender. The device can't check the chain behind this record; it then accepts later records by the usual rules.
  3. Catch up on the vault under that epoch, then rotate as `RECOVERY_ID`, enrolling the new device (`pairedBy` = `RECOVERY_ID`), removing every other member, and replacing the recovery key (the old one is known to the removed devices).
- Because devices hold only `recoveryPub`, a removed device can't read new epochs through the recovery path.

## After a rotation

- **A rotation includes a snapshot.** The rotating device first applies the whole log up to the current head, then publishes, together with the rotation record and wraps, a snapshot sealed under epoch e+1. This snapshot is the cut-off point: everything before the rotation reaches devices through it, so no device ever needs an epoch-e update or snapshot again.
- **Old epochs are rejected.** Once a device accepts epoch e+1, it rejects every update, snapshot and presence envelope with epoch ≤ e. That includes a device that was just paired or is catching up: it loads the e+1 snapshot, then the e+1 log.
- **Why the snapshot, not the server's `seq`.** A cut-off based on the server's sequence number (accept old-epoch entries stored before the rotation) would rely on the server. A removed device still holds `VMK_e`, so with the server's help it could write an epoch-e update and have it stored under an old `seq`. The snapshot is sealed under the new key, so the server can't fake it.
- **No edits lost.** Edits other devices made under epoch e that the rotating device hadn't seen are not in the snapshot. As built, each device, on accepting the new epoch and catching up, sends a snapshot of every document under e+1 (a superset of the difference), and seals any unacknowledged pending updates under e+1 when it resends them. Envelopes are always sealed under the epoch current at sealing time.
- **Chunks and table records are the exception.** Attachment chunks keep their epoch and stay readable through the key ring. That is safe because an attachment record names each chunk, and a device checks that a downloaded chunk's plaintext hashes to its name. Table records keep their epoch too (see "File table"): the Worker holds one record per file and nothing re-seals them, so a device accepts a record under any epoch in its key ring. Unlike updates, old-epoch records are therefore not rejected: a removed device working with the Worker could seal a new record under an epoch it still holds and have devices accept it. This is not defended against.
- Compaction may delete epoch-e log entries and snapshots once the e+1 snapshot is stored.
- A device that learns of a newer epoch than it can decrypt (a record exists, but no wrap for it arrives) stops publishing and alerts the user. This is a partial defence against a server holding back a rotation.

## Messages to the Worker

Binary WebSocket frames, `u8 type | fields`, implemented for both sides in `server/src/wire.ts`. The log frames are listed in that file's header: `hello`, `subscribe`, `publish`, `snapshot`, `live`, `fetch`, `append`, `rotate`, `status` from a device; `entry`, `more`, `synced`, `ack`, `live`, `record`, `records` from the Worker. The Worker's rules are in `DESIGN.md` section 3.

A connection starts with `fetch` (from the head's number, so the device sees whether the server still holds its head), takes in the records, then sends `hello` with the token of the epoch it is now in, and `append` or `rotate` if it has a record to add. A rotation is sent only once the device is caught up. `table` follows `hello` (below).

**Chunks.** `vput` (12) is `tag(32) | name(32) | envelope`: a version tag, a scoped chunk name and a kind-4 envelope of at most `MAX_CHUNK` + 64 bytes. The Worker records the name under the tag only if this `vput` stored the chunk or the name is already under that tag, and answers `stored` (24) `name(32)`; otherwise `missing` (26) `name(32)`. A version has at most 1,024 chunks. `get` (10) `name(32)` is answered with `chunk` (25) `name(32) | envelope` or `missing`. Chunks are not log entries: catch-up never carries them. `put` (9) and `mark` (13) belong to 0.2.x devices; a migrated vault refuses `mark`.

**Table handshake.** Right after `hello`, and before any `subscribe`, a device sends `table` (14, no fields). The Worker answers `format` (28) `u8 table`: 1 if the vault has its file table, 0 if it still holds only 0.2.x state and must be migrated first. Once a vault has its table, a connection that never sent `table` is closed with code 4005 ("update needed") on the next frame it sends after `hello`, and those open when migration commits are closed the same way. `since`, `set`, `del`, `restore` and `forget` are refused (close 4000) until the vault is migrated.

**Catch-up.** `since` (15) `u64 after` asks for every row whose `seq` is above `after`. The Worker sends `row` (29) frames, each one `row` as laid out in "File table", in `seq` order, at most 400 rows or 4 MiB a page. A page ends with `tableMore` (30) `u64 seq` (ask again from there) or `tableSynced` (31) `u64 seq` (the table's head; rows that change from now on arrive as `row` frames, the device's own included). This cursor is separate from the log's `subscribe` cursor. A row frame is a file's current state, not a history: a device that was away sees only the latest row of each file.

**Changes.** One frame per request, each with a fresh `req`. `chunks` is `u8 0`, or `u8 1 | u16 n` with n at most 1,024.

```
set      (16)  chunks | req(16) | file(16) | u64 base | u8 hasVersion | version(32, if 1) | pathkey(32) | record
del      (17)  req(16) | file(16) | u64 base | record (notes only)
restore  (18)  chunks | req(16) | file(16) | u64 base | pathkey(32) | record
ok       (32)  req(16) | u64 seq
refused  (33)  req(16) | u8 missing | row (may be absent)
forget   (21)  req(16)
forgotten(35)  req(16)
```

- `set` creates a file (`base` 0), or changes a live row's path, version or both. `del` deletes a live row. `restore` makes a deleted row live again at `pathkey`, with the version it had.
- `base` must equal the row's current `seq` (0: no such row yet). Otherwise the answer is `refused` with the row as it now is.
- `set` and `restore` are refused with the other row if another live row holds `pathkey`.
- A row never changes between note and attachment. A note's `set` and `restore` carry no `version` and `chunks = 0`; its `del` carries the tombstone record, which replaces the row's record. An attachment's `del` carries no record and the row keeps the one it had.
- For an attachment, `chunks` declares how many chunks `version` has, and every one must be stored under its tag, or the answer is `refused` with `missing = 1`: after a `set` the device uploads them again, after a `restore` it reports that the file is no longer stored. A change the Worker couldn't store is answered the same way. `chunks = 0` on an attachment means a version from before 0.2.0 that the row already holds, as in a rename.
- A `set` on a deleted row is accepted only for an attachment with a new version, which brings it back with that content. A deleted note is refused: it returns only by `restore`.
- `ok` carries the row's new `seq`. The Worker keeps each `ok` and sends it again if the same `req` arrives again, so a lost answer is never taken for a refusal. A refusal is not kept: the request is judged again on a retry. Once a device has recorded an `ok`, it sends `forget`, and the Worker drops the answer and replies `forgotten`.
- A `refused` whose row is another file's means the path is taken; one with no row means the file doesn't exist.

These frames may be as large as 4 MiB plus 117 bytes; every other frame at most 4 MiB plus 64.

**Migration.** A vault whose `format` says 0 is migrated by the first device that connects with this release. All of it happens on one connection that has sent `table`:

```
migrationEstimate   (24)  u64 writes
migrationBudget     (39)  u8 allowed
stagePart           (23)  u64 part | data (1 byte to 1 MiB)
stagedPart          (34)  u64 part
genesis             (20)  u64 base | u64 rows
migrationFailed     (38)  reason as UTF-8
migrationWriteFailed(37)  no fields
```

1. The device builds the rows from the 0.2.x state at log head `base`, numbering their `seq` from 1. Each becomes a `stageRow` frame: `u8 19 | u8 dateAtCommit | chunks | row`. `dateAtCommit = 1` makes the row a deletion dated by the Worker at commit.
2. The stream is every `stageRow` frame prefixed by its `u32` length, one after another, cut into parts of 1 MiB (the last one shorter). A frame may cross a part boundary. `stageRow` is never sent as a frame of its own.
3. `writes = 3 × live rows + 2 × deleted rows + 2 × parts + 2`. The device sends `migrationEstimate`; the Worker answers `migrationBudget` with 1 if that fits what is left of the day's write allowance, shared by all its vaults (or `format` 1 if the vault has been migrated meanwhile). With 0 nothing is staged and the device tries again later.
4. The device sends each part as `stagePart`, numbered from 1, and waits for its `stagedPart`. Parts are refused without a granted estimate. A failed attempt is discarded whole: the next needs a new estimate and starts again at part 1.
5. `genesis` commits. The Worker installs the rows only if the log head still equals `base`, there are exactly `rows` rows numbered 1 to `rows`, the writes equal the granted estimate, no version is declared with two chunk counts, and every live attachment's chunks are stored. All of it happens in one transaction, or none of it does.
6. The answer is `format`: 1 means migrated, by this device or another; 0 means the head had moved, and the device starts again. A commit that fails answers `migrationFailed` with a reason, or `migrationWriteFailed` when the Worker's daily write allowance ran out part-way.

## History backup

Kind 6 is used only by these HTTP endpoints. WebSocket entries, live frames and chunk downloads refuse it. The plaintext is UTF-8 JSON with `v` equal to `1`, `note` holding the permanent note ID, `t` holding the copy time in Unix milliseconds and `text` holding the note text. The sender appends zero bytes up to the smallest bucket that fits, from 1 KiB through 1 MiB in powers of two, and skips anything larger. The receiver removes trailing zero bytes before decoding JSON.

Seal with the current epoch's VMK and use that epoch's document tag as `docId` in the envelope's associated data. A receiver skips a copy unless its kind is 6, its epoch is current, AES-GCM verifies for the requested vault and tag, the plaintext matches the requested note ID and `t` is an integer timestamp at most five minutes ahead of the receiver's clock. Clients sort by the sealed copy time, newest first. The header's device ID is a claim made by a vault member.

All three requests are binary `POST`s under `/vault/{vaultId hex}`. The leading 32 bytes are the current vault auth token.

| Path suffix | Request body | `200` response |
|---|---|---|
| `/history` | `token[32] \| docTag[16] \| envelope` | Upload acknowledged |
| `/history/list` | `token[32] \| docTag[16]` | `application/octet-stream` with up to 200 `u32 envelopeLength \| envelope` records, newest upload first |
| `/history/clear` | `token[32] \| docTag[16]` for one note's current tag, or `token[32]` for the entire vault | Clear acknowledged |

A `404` leaves only local history available. A `401` or `410` disables backup requests for the remainder of the vault session.

## Whole-vault snapshots

Kind 7 is used only by the snapshot HTTP endpoints. WebSocket entries, live frames and chunk downloads refuse it. The envelope's associated data uses the 16-byte snapshot ID as `docId`. New snapshots use the current epoch's VMK.

The UTF-8 JSON body is `{ v: 1, id, day, takenAt, notesOnly, notes, attachments }`. `id` is a fresh random 16-byte ID encoded in lowercase hex. `day` is the number of UTC days since the Unix epoch and `takenAt` is the device's Unix timestamp in milliseconds. Notes are `{ id, path, text }`. Attachments are `{ id, path, ref }`, where `id` is the row's `file` ID in hex and `ref` holds `h`, `n`, `c`, `u` and `s` as `bytes` does in an attachment record (a snapshot taken by 0.2.x may lack `u`). A notes-only snapshot has an empty attachment list.

Gzip the JSON and split the resulting stream into slices of up to 1 MiB. For a single slice, pad its payload with zeros to the smallest fitting power-of-two bucket from 64 KiB through 1 MiB. For multiple slices, every padded payload is 1 MiB. Seal each part independently with this plaintext, using big-endian integers and zero-based indices.

```
snapshotId[16] | u32 day | u64 takenAt | u16 partIndex | u16 partCount | u32 payloadLength | payload | zero padding
```

The sealed header adds 36 bytes inside the envelope. With the 51-byte envelope overhead, the largest envelope is 1 MiB + 87 bytes. Clients cap snapshots at 512 parts and 512 MiB of decompressed UTF-8 JSON. They reject invalid gzip or UTF-8 and stop reading if the output exceeds the byte limit.

Every request is a binary `POST` under `/vault/{vaultId hex}` with the current 32-byte auth token first.

| Path suffix | Request body | `200` response |
|---|---|---|
| `/snapshot` | `token[32] \| snapshotId[16] \| u16 partIndex \| u16 partCount \| envelope` | `{ ok, day, complete }` |
| `/snapshot/list` | `token[32]` | JSON array of `{ id, day, epoch, parts, received, size, complete, at }` |
| `/snapshot/get` | `token[32] \| snapshotId[16]` | Repeated `u16 partIndex \| u32 envelopeLength \| envelope` frames |
| `/snapshot/delete` | `token[32] \| snapshotId[16]` for one snapshot, or `token[32]` for all | `{ ok }` |

The Worker reserves the day on the first upload. It returns `409` with `{ "error": "taken" }` when another snapshot holds that day and `413` when a size cap is exceeded. The sender seals using its local UTC day and accepts the first acknowledgement's day only if it agrees. A mismatch ends the attempt without resealing. A missing list endpoint (`404`) or rejected token (`401` or `410`) disables requests for the session. A `404` on a download can also mean the snapshot is absent.

After the complete upload is acknowledged, the sender records `{ day, epoch, parts, notesOnly, takenAt }` under the ID in the map `snapshots` of the `index` document. This ledger is all that document still holds. `parts` holds the lowercase SHA-256 hex digests of the complete envelopes, in index order. To open a snapshot of any epoch, the receiver checks every envelope against its ledger digest and opens it with that epoch's key. It requires exactly one of each index, with the sealed ID, day, timestamp, index and part count matching the request and ledger. The decoded body must agree with the sealed metadata and ledger, and every note and attachment path must pass vault path validation. Worker list metadata alone cannot authorize opening any snapshot.

## Key storage on the device

- The key ring, `{ "<epoch>": "<hex VMK>" }` as JSON, in Obsidian's secret storage under `ownsync-ring-<vault ID>`.
- The device ID, its P-256 key pair (private key non-extractable) and its view of the log (head, accepted hashes, pending record) in the vault's IndexedDB store, key `keys`.

## Not yet specified

- Fixed size padding for sync envelope kinds.
- A test vector for the conflict suffix.
- Rejecting table records sealed under an old epoch (see "After a rotation").
