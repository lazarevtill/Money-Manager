## Sync, backup, export and migrations

The entire "you will not lose your data" story collapses onto one decision: **where the
data-encryption key lives.** Everything else — container format, restore flow, platform-backup
interaction, sync — is downstream of it. A database encrypted under a key that exists only in
Android Keystore or the iOS Keychain is *unrecoverable after phone loss even if the user has a
perfect copy of the file*, because Keystore keys are non-extractable by design and
`kSecAttrAccessible…ThisDeviceOnly` items never migrate to another device (that is the point of
the suffix). Under constraint #2 — the on-device DB is the sole system of record — that is not a
gap, it is total loss.

So the order of construction is: envelope encryption first, container second, verification third,
restore fourth. Sync is a v1.5 workstream that the schema already pays for and v1 does not build.

| Deliverable | v1? | Shape |
| --- | --- | --- |
| Envelope encryption (two wraps) | **yes, first** | random 32-byte DEK; wrapped by Keystore/Keychain *and* by a recovery phrase |
| Encrypted backup container `.mmbak` | **yes** | zip of a `sqlcipher_export`ed DB + encrypted media + plaintext manifest |
| Verify-by-read-back | **yes** | a backup is not "successful" until a second connection has read it and passed nine assertions |
| Restore onto a new phone | **yes, as an onboarding branch** | recovery phrase → DEK → rewrap → migrate → rebuild FTS → new `node_id` |
| Human-readable export | **yes** | CSV + JSONL, lossy, explicitly *not* restorable |
| Self-hosted sync | **no — v1.5, gated** | schema carries HLC, tombstones, oplog, dirty-column writes today |
| Migrations that survive skipped versions | **yes** | forward-only, numbered, snapshot-and-rollback |

---

### 6.1 Envelope encryption: two wraps, and why the second one is load-bearing

> **This section is normative for the recovery secret, the wrap format and the wrap path.** Three
> earlier drafts specified three mutually incompatible wraps — `01-decisions.md` D4/D5, an earlier
> `02-storage.md` §2.7, and this section — differing in the secret itself (32-char base32 code vs
> 15-word phrase), the KDF, the AEAD, the dependency set and the file path
> (`recovery/dek.wrap` vs `keys/recovery.wrap`). Two engineers building in parallel would each have
> produced a file the other's recovery flow cannot open, and neither would find out until a phone
> died. `02-storage.md` §2.7.1 now references this section instead of restating it; the D4/D5/D99
> reconciliation is requested in that file's "Rejected findings (storage-sync)", item X1.

```
                      ┌──────────────────────────────────────┐
   random 32 bytes ──►│  DEK  (never leaves the device        │
   (libsodium         │        unwrapped, never in a log)     │
    randombytes_buf)  └───────────┬──────────────┬───────────┘
                                  │              │
              WRAP A (silent open)│              │WRAP B (survives phone loss)
                                  ▼              ▼
                    Keystore / Keychain     KDF(recovery phrase, salt) → KEK
                    AES-GCM, hardware-      → AEAD(DEK)
                    backed, ThisDeviceOnly  → plain file, mmwrap/1 format
                                  │              │   <appdir>/keys/recovery.wrap
                                  └──────┬───────┘
                                         ▼
                    SQLCipher raw key  x'<64 hex>'  (67 chars, exactly)
                                         │
                                         ├─ HKDF(DEK, "mm/spool-x25519/v1") → spool keypair (§2.8.1)
                                         └─ … every other non-credential key in the app
```

The DEK is **the only root secret**. Anything else the app needs that is not a user credential is
derived from it (`MMKeyStore.deriveSubkey()`), so it inherits both wraps and cannot be lost
independently of the database. Adding a second *stored* secret is a design change that needs its own
recovery story and a row in `02-storage.md` §2.7.4's item inventory — it is not an implementation
detail, and the spool sealed-box key was exactly that mistake before §2.8.1 corrected it.

#### 6.1.1 Wrap A, Wrap B, and the secret

**Wrap A — daily open.** The DEK, AES-GCM-encrypted under an Android Keystore key
(`AES/GCM/NoPadding`) or stored directly in the iOS Keychain. Accessibility is
**`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`** on iOS. Two research inputs disagreed here
(one proposed `WHEN_UNLOCKED_THIS_DEVICE_ONLY`); the functional constraint breaks the tie —
the iOS spool drain and any background work must open the database while the screen is locked
after first unlock, which `WHEN_UNLOCKED` forbids. On Android, do **not** call
`setUnlockedDeviceRequired(true)` or `setUserAuthenticationRequired(true)` on the wrapping key:
bank alerts arrive while the phone is locked, and the write must not fail exactly when it matters.
Both defaults are already `false`, so this is a rule about what *not* to add.

`expo-secure-store` (SDK 57 cadence, actively released) rather than `react-native-keychain`
(last publish 10.0.0, 2025-03-23). Its default is `WHEN_UNLOCKED` — you must pass
`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` explicitly. **That applies to every item the app stores, not
just the DEK**: `backup_kek`, the WebDAV credential and the optional LLM endpoint token are all in
`02-storage.md` §2.7.4's inventory table with the same class and `kSecAttrSynchronizable = false`,
and gates G-10/G-11 iterate that table rather than checking one item. A `backup_kek` written at the
`WHEN_UNLOCKED` default is iCloud-Keychain-eligible, which would put the key that opens every
`.mmbak` on Apple's servers while the `.mmbak` files sit in the user's Nextcloud folder. Do **not**
introduce `androidx.security:security-crypto` (EncryptedSharedPreferences) — deprecated at
1.1.0-alpha07 over main-thread StrictMode violations and OEM keyset-corruption crashes.

**Wrap B — the one that makes phone loss survivable.** The secret is an app-generated **15-word
recovery phrase** (BIP39 English wordlist: 160 bits of entropy plus a checksum, unambiguous in the
first four letters, no confusable pairs, and it round-trips through a password manager). A KDF over
it produces a KEK that AEAD-encrypts the DEK into a **plain file** at exactly
`<appdir>/keys/recovery.wrap` — the `KEYS_DIR` constant of `02-storage.md` §2.9.1, and the only
spelling of that path anywhere. That file is what makes an Android `<device-transfer>` restore
possible at all (§6.6) and it travels inside every `.mmbak`.

#### 6.1.2 `mmwrap/1` — the wrap file is self-describing, and that is the whole point

Earlier text put the KDF salt in `meta.recovery_salt_hex` and the parameters in the backup manifest.
Both are unreachable on the two paths that actually need the wrap:

- **`02-storage.md` §2.7.5's Keystore-invalidation flow** reads `recovery.wrap` precisely *because*
  the database cannot be opened, so `meta` is unreadable by definition;
- **an Android `<device-transfer>`** delivers `keys/recovery.wrap` with no `.mmbak` and therefore no
  manifest anywhere on the device.

In both, the user types the correct phrase and the app cannot derive the KEK. The alternatives are a
hardcoded fallback salt (which silently degrades every wrap to a shared-salt scheme) or total loss
with the right phrase in hand — on the very path §6.6.1 cites to justify `allowBackup="true"`.

So the wrap carries everything needed to open it, and nothing outside it is ever consulted:

```
mmwrap/1  (little-endian; 121 bytes at kdf_id = 0x02)
  offset  size  field
  0       6     magic            "MMWRAP"
  6       1     format_version   0x01
  7       1     kdf_id           0x01 = PBKDF2-HMAC-SHA512 | 0x02 = Argon2id
  8       1     aead_id          0x01 = AES-256-GCM        | 0x02 = XChaCha20-Poly1305-IETF
  9       1     reserved         0x00
  10      4     kdf_p1           Argon2id m_kib   | PBKDF2 iterations
  14      4     kdf_p2           Argon2id t       | 0
  18      4     kdf_p3           Argon2id p       | 0
  22      4     generation       meta.recovery_code_generation at write time
  26      16    salt
  42      24    nonce            (12 bytes used + 12 zero when aead_id = 0x01)
  66      32    ciphertext       AEAD(DEK)
  98      16    tag
  114     4     crc32            over bytes 0..113 — cheap "is this file truncated" check
  118     3     padding          0x00
```

`aad` for the AEAD is bytes 0..25 (the whole header through `generation`), so a downgrade of
`kdf_id` or a tampered `generation` fails authentication rather than producing a wrong key.

- **`kdf_id = 0x01` (PBKDF2-HMAC-SHA512, 210,000 iterations)** is available from both platforms'
  system crypto with no JS dependency, so `MMKeyStore` can unwrap without a JS runtime. Registered
  and implemented from v1; both readers ship from v1.
- **`kdf_id = 0x02` (Argon2id)** is the v1 **default**, because the rotation, backup and restore
  paths all already run in JS. Parameters below.
- `meta.recovery_salt_hex` and the manifest's `kdf` block survive as **redundant convenience
  copies**, never as the source of truth. §6.5 step 3 reads its parameters from the wrap file.
- An unknown `kdf_id`/`aead_id`/`format_version` fails with a message naming the app version that
  can read it, never with "wrong phrase".

Argon2id parameters, from `react-native-argon2` 4.0.0 (MIT), run off the JS thread:

| Recovery secret | m | t | p | Rationale |
| --- | --- | --- | --- | --- |
| App-generated 15-word phrase (**default**) | 64 MiB | 3 | 1 | 160 bits is unbrute-forceable regardless of KDF cost; the KDF is only slowing an attacker who already has the file, and 64/3/1 stays under ~1.5 s on a 4-year-old midrange |
| User-chosen passphrase (**opt-in, gated — §6.1.3**) | 256 MiB | 4 | 1 | A human-chosen string is the weak link; the only lever left is cost |

`react-native-libsodium` 1.7.0 does not expose `crypto_pwhash` on native (sumo/web only), which is
why Argon2 is a separate dependency; libsodium still supplies `randombytes_buf`,
`crypto_generichash` and `crypto_aead_xchacha20poly1305_ietf_*`.

**The 67-character footgun, which now applies twice.** SQLCipher's raw-key mode requires the key
string to be *exactly* `x'` + 64 lowercase hex + `'`. The check in the codec is
`pass_sz == raw_key_sz + 3` = 67. Off by one, uppercase-with-a-stray-space, 63 hex digits — and
SQLCipher does not error; it falls through to running 256,000 PBKDF2-HMAC-SHA512 iterations over
the literal string `x'…'`, producing a *different* key. A database written under the wrong-length
string can never be opened with the right one, and there is no cloud copy. There is exactly one
function in the codebase that constructs a key string, it asserts
`/^x'[0-9a-f]{64}'$/.test(k) && k.length === 67` and throws otherwise, and both the DB key and the
backup key go through it. A startup self-test creates a throwaway DB with the key, closes it,
reopens it and reads a sentinel row. That function is also the injection defence at the two `ATTACH`
call sites — and per `02-storage.md` §2.15, those call sites additionally scrub the key out of every
error they can throw, because the statement itself contains it in cleartext.

#### 6.1.3 The user-chosen passphrase option, gated

`02-storage.md` §2.7.2 said "prefer not to offer it" while this section offered it as an opt-in.
Resolved: **it is offered, and it is gated by a measured entropy floor, not by a warning.** The
reason it cannot be a warning is specific to this artifact: §6.2.2 publishes the salt and the KDF
parameters in the manifest **in plaintext by design** (restore needs them before it can decrypt
anything), so an attacker holding a `.mmbak` knows the exact work factor and the attack is
embarrassingly parallel on rented GPUs. Argon2id at 256 MiB is a real per-guess cost and is not a
wall against a 40-bit passphrase.

- zxcvbn score 4 **and** ≥ 70 bits estimated. Below the floor the flow **refuses**; it does not warn
  and proceed.
- The screen states, in the flow and not in a footnote, that the file's KDF parameters are public
  and that the artifact is designed to be stored somewhere the user does not control.
- The same floor and the same KDF apply to §5.6.6's training-corpus archive, which currently
  specifies "a passphrase the user types" with no parameters anywhere. **Counterpart change in
  `05-provenance.md` §5.6.6**: reuse `mmwrap/1`'s `kdf_id = 0x02` and this floor rather than
  inventing a second scheme, and add to the export summary screen an explicit list of what is *not*
  pseudonymised — merchant names, amounts, currencies, dates and the bank's exact wording — since
  the current screen shows only counts and distributions.

#### 6.1.4 Rotation: two different flows, because there are two different problems

The old text had one flow and described it as safe. It is safe for one of the two cases and
actively misleading for the other.

**Flow 1 — "I want a new phrase" (forgotten, hygiene, phrase written somewhere untidy).** A 32-byte
rewrap, not `PRAGMA rekey`. But it is *not* a single atomic step, because the old text left the user
holding a folder of `.mmbak` files that nothing could open:

1. Generate the new phrase; display it; require re-entry of four randomly chosen word positions.
2. Derive the new KEK and write `keys/recovery.wrap.gen<N+1>` **alongside** the current wrap.
3. **Perform and verify (A1–A11) at least one full backup under the new phrase**, to a destination
   the user picks, and require it to be `delivered = 1`.
4. Only now: `rename()` the new wrap over `keys/recovery.wrap`, bump
   `meta.recovery_code_generation`, cache the new `backup_kek`, and drop the generation-suffixed
   file.
5. Until step 4 completes, the device is still on generation *N*: the old wrap is intact, the old
   `backup_kek` stays cached, and an interrupted rotation degrades to "nothing happened" rather
   than to "no valid backup exists".

The old flow bumped the generation immediately and relied on `meta.backup_staleness_days` (default
7) to eventually produce a backup under the new phrase — so a phone stolen two days after a rotation
left the user with a correct new phrase and a folder of containers that only the phrase they had
just destroyed could open. Replace "say loudly that existing files require the old phrase" with a
**non-dismissable instruction to retain the old phrase until every retained backup has been
re-made**, and surface in the backup-history screen the count of `backup_runs` rows at older
generations.

**Flow 2 — "my recovery phrase was seen by someone else".** Rewrapping does not help, and presenting
it as though it does is the actual defect. The DEK is unchanged; every prior `.mmbak` still contains
a `recovery.wrap` the *old* phrase opens, which yields the *same* DEK, which opens the live
`ledger.db` and any copy of it — a `<device-transfer>` payload, a `snapshots/pre_N.db` left by an
interrupted migration, an `adb backup`. So this flow rotates the key material for real:

1. Mint a new DEK (`randombytes_buf(32)`).
2. `sqlcipher_export` the live database into a new file keyed with it — the same primitive §6.5
   step 9 already uses, so this is existing code — with both §6.2.3 traps applied.
3. Swap atomically (`rename()`, after unlinking the old `-wal`/`-shm`), then `quick_check`.
4. Delete the old database file and **every** `snapshots/` and `export/staging/` artifact, since
   each is keyed with the retired DEK.
5. Generate a new phrase and wrap the new DEK under it and under a freshly generated
   Keystore/Keychain key; purge the cached `backup_kek`; run Flow 1's steps 3–4 to force a verified
   backup before the generation bump lands.
6. Re-derive every subkey (today: the spool keypair, §2.8.1). Records already in `spool/inbox/` were
   sealed under the old public key, so **drain the spool before step 1** and refuse to start the
   flow if the drain leaves anything behind.
7. Mark every prior `backup_runs` row `superseded = 1`.

The completion screen states plainly that `.mmbak` files created before the rotation remain
decryptable with the old phrase and should be destroyed. `02-storage.md` §2.7.1 carries the same
sentence, because that is where an implementer reads "rewrap, not rekey" and infers safety.

#### 6.1.5 Onboarding sequence, non-negotiable order

Generate the phrase → display it → offer "save to password manager" as a first-class button →
require re-entry of four randomly chosen word positions → perform one full backup to a destination
the user picks and verify it → *then* let the user enter real data. A phrase set once and never used
is forgotten, and there is no reset. Product will want to cut steps 4 and 5; they are the two that
must not be cut. A "remind me later" is permitted for at most the first ten transactions, after
which the prompt becomes non-dismissable.

---

### 6.2 The backup container — `.mmbak`

#### 6.2.1 Why a container and not a file

§3.10 puts receipt images on the filesystem in `media_assets`, not as BLOBs, and states that
bundling the media directory with the `.db` is a **correctness requirement, not a nicety**. So the
artifact cannot be a single database file. It also cannot be a bare directory, because the two
realistic hand-off mechanisms (share sheet, WebDAV `PUT`) both want one object.

```
receipts-2026-08-02T1930Z.mmbak     (zip; STORE for pre-encrypted members, DEFLATE for manifest)
├── manifest.json                   plaintext by design — see below
├── ledger.db                       SQLCipher, keyed with the BACKUP key, not the DEK
├── recovery.wrap                   Argon2id-wrapped DEK (ciphertext; safe to ship)
└── media/
    ├── 2026/07/019826….jpg.enc     XChaCha20-Poly1305, 24-byte nonce prefixed
    └── …
```

Encryption is done **per member before zipping**. Never rely on zip password encryption — legacy
ZipCrypto is broken, AES-zip support varies by implementation, and it would put a second,
weaker key hierarchy next to the real one. `react-native-zip-archive` 9.0.2 (MIT) is used purely
as a container writer.

Key derivation for the container, no user interaction required at backup time:

```
backup_kek   = KDF(recovery_phrase, salt, params)   -- kdf_id/salt/params READ FROM keys/recovery.wrap
                                                    -- (§6.1.2), never from meta and never from a
                                                    -- manifest. Computed ONCE when the phrase is
                                                    -- created; cached as mm.backup.kek.v1 at
                                                    -- AfterFirstUnlockThisDeviceOnly, synchronizable
                                                    -- = false (02-storage.md §2.7.4)
backup_key   = crypto_generichash(key = backup_kek, msg = backup_id, 32)
media_key    = crypto_generichash(key = backup_key, msg = "media",    32)
```

`backup_key` is per-file (info = the `backup_runs.id`), so two backups never share a key, and
restore needs only the phrase, the salt and the `backup_id` — the first from the user, the second
from the container's own `recovery.wrap`, the third from the manifest. This is what makes an
unattended, opportunistic backup possible without ever prompting for the phrase.

> **`_backup_meta` (D99) is rejected, and the reason is structural, not stylistic.** D99 proposes
> writing backup metadata into a table inside the attached database before `DETACH`. Restore must
> read the KDF salt and parameters *before* it can decrypt anything, so metadata inside the
> encrypted member cannot serve that purpose — it is not a duplicate mechanism, it is
> unimplementable. The plaintext `manifest.json` of §6.2.2 is the only workable carrier, and the
> `recovery.wrap` inside the container is what makes even the manifest non-load-bearing for key
> derivation. Requested edit to `01-decisions.md` is recorded in `02-storage.md`'s rejected-findings
> item X1.

**On-device media is *not* app-encrypted** (Android FBE and iOS
`NSFileProtectionCompleteUntilFirstUserAuthentication` cover it, and encrypting it would cost CPU
on every thumbnail render). That is precisely why it *must* be encrypted on the way into the
container: the container leaves the device and the platform's at-rest protection does not travel
with it.

#### 6.2.2 The manifest

Plaintext by design — restore must read the salt and KDF parameters before it can derive anything.
It therefore carries **only** versions, counts, salts, parameters and hashes. Never a merchant
name, never an amount, never a sender address.

```json
{
  "format": "mmbak/1",
  "backup_id": "019826f1-…",
  "created_at": 1785600000000,
  "kind": "full",
  "app_version_code": 1042,
  "schema_version": 7,
  "migration_head": "0007_installment_plans",
  "node_id": "…",
  "recovery_code_generation": 2,
  "kdf": { "alg": "argon2id", "m_kib": 65536, "t": 3, "p": 1, "salt_hex": "…" },
  "//kdf": "CONVENIENCE COPY. The authority is the container's own recovery.wrap (§6.1.2).",
  "spool_pending_at_start": 0,
  "db":  { "member": "ledger.db", "bytes": 41238528, "sha256_hex": "…",
           "auto_vacuum": "incremental", "page_size": 4096 },
  "tables": { "transactions": 18422, "entries": 41903, "raw_captures": 26104, "…": 0 },
  "media": { "count": 3120, "bytes": 612833280, "pack_id": "…", "prior_pack_id": "…" },
  "verify": { "status": "passed", "assertions": ["A1","A2","…","A9"] }
}
```

Manifest hashes are a **fast-fail convenience only**. The authoritative integrity check is
decrypting and running `PRAGMA quick_check`: SQLCipher 4 HMAC-SHA512s every page, so a bit-flip in
the ciphertext surfaces as a corrupt-page error rather than as silently wrong money. A tampered
manifest cannot make a bad backup look good, because §6.3 re-derives every assertion from the file.

The manifest is written **last**, after all other members, and its presence is the commit marker —
the same pattern §4.4.1 uses for the spool. A container with no manifest is an interrupted write
and is deleted by the sweeper.

#### 6.2.3 The export procedure, in order, with the two traps

`sqlcipher_export()` — not `VACUUM INTO`, not a file copy, not JSON. It produces a consistent,
fully-encrypted, self-contained copy in one statement with no plaintext intermediate and nothing
streamed through Hermes, and — the decisive property — **it can be keyed with a different key**,
which is the whole point of an artifact that must survive the loss of the device holding the DEK.
Zetetic reports it as substantially faster than `VACUUM` (their example: 30 s vs 3 min). The output
is an ordinary SQLCipher database the user can open in DB Browser for SQLite — real data ownership,
not a proprietary blob.

**Run it on a second connection, not the live write connection.** `PRAGMA foreign_keys` is
per-connection, and the live connection is the one every subsequent write in the process uses
(`02-storage.md` §2.10.2). An export that dies at `SQLITE_FULL` between step 0b and the trailing
`PRAGMA foreign_keys = ON` leaves that connection with FK enforcement off for the rest of the
process lifetime: the next account archive succeeds where `ON DELETE RESTRICT` should have stopped
it, thousands of `entries` rows point at a nonexistent account, `v_account_balances` silently drops
them, net worth changes, and nothing raises until the next launch's sweep. Opening a dedicated
read-only-ish connection for the export costs one `open()` in raw-key mode — a `memcpy` — and makes
the whole class of leak impossible. The per-connection pragma list in `02-storage.md` §2.10.1
applies to it identically.

Belt as well as braces, because a second connection is easy to "optimise" away later: steps 0b
through the `DETACH` are a `try`, `PRAGMA foreign_keys = ON` plus a read-back assertion is the
`finally`, and `PRAGMA foreign_key_check` runs afterwards on the **live** database and not only on
the copy.

```sql
-- 0. Quiesce. Without this the -wal holds committed rows the copied main file does not have.
PRAGMA wal_checkpoint(TRUNCATE);

-- 0b. MANDATORY, and OUTSIDE any transaction (the pragma is a no-op inside one). §3.1 requires
--     foreign_keys = ON on every connection open, and sqlcipher_export copies data in
--     sqlite_master order — so it inserts fx_rederivations rows (created at §3.3.3) before the
--     transactions rows they reference, and the whole export fails on a FK violation. Turn them
--     back ON in a finally — NOT on the success path — and read the pragma back to confirm.
--     Assertion A4 re-checks integrity on the destination anyway.
PRAGMA foreign_keys = OFF;

-- 1. Attach the destination under the BACKUP key (67-char raw form, validated).
ATTACH DATABASE '<staging>/ledger.db' AS bk KEY "x'<64 hex of backup_key>'";

-- 2. TRAP #1. sqlcipher_export does NOT copy auto_vacuum, and §3.1 makes auto_vacuum
--    irreversible after the first CREATE TABLE. sqlcipher_export creates tables. So without
--    this line every restored database is permanently auto_vacuum = NONE, and the only way
--    back is a full VACUUM of an encrypted multi-hundred-MB file on a phone. The destination
--    is still empty here, which is the only moment this statement is legal.
PRAGMA bk.auto_vacuum = INCREMENTAL;

-- 3. Copy schema, data, indexes, triggers and views.
SELECT sqlcipher_export('bk');

-- 4. TRAP #2. sqlcipher_export does NOT copy user_version either. §3.2 reads user_version for
--    the backup manifest and the downgrade guard, so a backup with user_version = 0 would
--    later be treated as pre-migration and replayed against an already-current schema.
--    (__drizzle_migrations IS copied and remains the single source of truth — this write only
--    keeps the cheap read consistent with it.)
PRAGMA bk.user_version = <N>;

DETACH DATABASE bk;
PRAGMA foreign_keys = ON;        -- in the FINALLY, then SELECT it back and assert it is 1
PRAGMA foreign_key_check;        -- on the LIVE database, not only on the copy
```

The `ATTACH` at step 1 interpolates a cleartext key into a SQL string, which is safe against
injection because `assertRawKey()` has already proved its shape — and **unsafe against disclosure**,
because any wrapper that logs a failing statement ships that key to the crash reporter. Every
`ATTACH` in this design goes through the `attachKeyed()` helper in `02-storage.md` §2.11.2, which
discards the original error object and rethrows a scrubbed message. On this path the key opens one
`.mmbak`; on §6.8.2 step 5's path the identical statement carries the **live DEK**.

Two consequences of `sqlcipher_export` copying triggers that the restore path must absorb rather
than hope about:

- If triggers were created **before** the data copy, `trg_txn_fts_insert` would double-populate the
  FTS index and `trg_merchant_seen` would double `merchants.txn_count`. The implementation creates
  tables → copies data → creates indexes/triggers/views, so this does not fire — but the restore
  path rebuilds FTS unconditionally (§6.5) and runs sweep check **I9** unconditionally, which
  repairs both regardless of the order. Verify the order once on a fixture; do not depend on it.
- `transactions_fts` is a **contentless** FTS5 table (`content = ''`, §3.17). Contentless tables
  have no `'rebuild'` path, because there is no content table to read from. Rather than leaving
  virtual-table round-trip fidelity as a live question on the one path that must not have
  surprises, **the restore path always drops and re-creates the FTS index from `transactions`
  joined to `transactions_fts_map`.** This is deterministic and cheap at these row counts. Do not
  let anyone "optimize" it away later.

  ```sql
  -- One transaction, so trg_txn_fts_insert / trg_txn_fts_update never fire against a table
  -- that momentarily does not exist. transactions_fts_map is NOT rebuilt — keeping it preserves
  -- the rowid↔txn_id mapping the triggers depend on.
  BEGIN IMMEDIATE;
  DROP TABLE transactions_fts;
  CREATE VIRTUAL TABLE transactions_fts USING fts5(
    merchant_raw, note, memo,
    content = '', tokenize = 'unicode61 remove_diacritics 2');
  INSERT INTO transactions_fts (rowid, merchant_raw, note, memo)
  SELECT m.rowid, COALESCE(t.merchant_raw,''), COALESCE(t.note,''), ''
    FROM transactions_fts_map m
    JOIN transactions t ON t.id = m.txn_id;
  COMMIT;
  ```

  The literal `''` for `memo` is not a shortcut — it mirrors `trg_txn_fts_insert` (§3.19) exactly,
  which also writes `''` and never reads `entries.memo`. A rebuild that helpfully populated `memo`
  would make restored rows searchable differently from rows written afterwards, and nobody would
  ever trace that divergence back to here. If `memo` is ever wired up for real, the trigger and
  this statement change in the same commit.

#### 6.2.4 Three backup kinds, so size never blocks the honest path

| `kind` | Contents | When |
| --- | --- | --- |
| `db_only` | `ledger.db` + `recovery.wrap` + manifest | **default**; a few MB even at 3 years — 10k transactions of rows is single-digit MB |
| `full` | `db_only` + every live media asset | explicit user choice; hundreds of MB |
| `media_pack` | only assets whose `sha256_hex` is absent from the previous pack's manifest | incremental companion to `db_only` |
| `pre_migration` | `ledger.db` keyed with the **DEK** (no KDF, near-instant), no media | internal, §6.8. Deleted only after the reopened database passes `quick_check` (§6.8.2). It is the one artifact in the app that is a complete ledger under the *live* key, so it is excluded from every platform backup and from the share sheet, and it is never a destination the user can pick |

`media_assets` is content-addressed by `sha256_hex`, so the incremental pack is a set difference
and needs no change-tracking. Each media pack's manifest lists the **full expected asset set**
(sha256 → owning pack id), so a restore that is missing an older pack can say exactly which packs
it needs and still restore, marking the absent assets `missing_since` (§6.5) instead of failing.
That is the concrete answer to "does three years of receipts fit in one WebDAV `PUT`" — it does not
have to.

---

### 6.3 Verification: a backup is not successful until it has been read back

The single most common way a backup story fails is that nothing ever reads the artifact until the
day it is needed. Every backup here is opened on a **separate connection to the finished file**,
before the UI is allowed to say the word "backed up". The app has `backup_key` without any user
interaction, so this is fully automatic.

Verification runs against the DB member **in the staging directory, before zipping** (full checks),
then against the zip **after writing** (cheap checks: every member's CRC, the manifest's own
sha256, and the DB member's sha256 against the manifest). Splitting it this way avoids unzipping
hundreds of megabytes twice while still catching a truncated or partially-flushed write.

| # | Assertion | Catches |
| --- | --- | --- |
| A1 | `/^x'[0-9a-f]{64}'$/` and length 67 on the backup key, asserted **before** the ATTACH | the silent PBKDF2 fallback — an unopenable file with no error |
| A2 | reopen succeeds and `SELECT count(*) FROM sqlite_master` > 0 | wrong key, truncated file, failed ATTACH |
| A3 | `PRAGMA quick_check` = `ok` | page corruption; SQLCipher's per-page HMAC makes this authoritative |
| A4 | `PRAGMA foreign_key_check` returns no rows | a copy that lost referential integrity |
| A5 | `PRAGMA auto_vacuum` = 2 (incremental) and `PRAGMA user_version` = N | the two `sqlcipher_export` omissions in §6.2.3 |
| A6 | per-table `COUNT(*)` equals the manifest, for **every** table in `sqlite_master` (enumerated at runtime, not a hardcoded list — a table added in a later migration must not silently escape the check) | a partial copy |
| A7 | sweep **I1** (`SUM(amount_minor)` per `(txn_id, currency_code)` ≠ 0) returns nothing | the strongest single check available: an unbalanced ledger in the *copy* means the copy is not the ledger |
| A8 | sweep **I3** (entries/header date drift) and **I4** (exponent drift) return nothing | denormalization damage in the copy |
| A9 | for every `media_assets` row with `original_deleted_at IS NULL AND missing_since IS NULL`, the encrypted member exists and decrypts to the recorded `sha256_hex` and `bytes` | a `full` backup that silently shipped no images |
| **A10** | the container's `recovery.wrap` parses as `mmwrap/1`, its CRC checks, and it unwraps to the DEK **with `meta` unreadable and no manifest in scope** — run it against a fixture with an empty `meta` table and the manifest deliberately withheld | the wrap depending on something outside itself, which is total loss on exactly the two paths that need it (§6.1.2). Extends gate **G-16** |
| **A11** | `spool/inbox/` was empty at the moment `wal_checkpoint(TRUNCATE)` ran, or the count is recorded in `manifest.spool_pending_at_start` and surfaced to the user | a backup taken while undrained captures sat next to it — the container looks complete and silently predates real transactions (§6.4) |

A7 is the one worth arguing for: it costs one `GROUP BY … HAVING` over `entries` and it is the same
query the seal trigger and the startup sweep already run (§3.7.1, §3.21). If a backup passes A7 it
is a ledger, not just a file that opens.

A10 is the one that is cheapest to skip and worst to be missing: it is the only assertion that
exercises the artifact the way a dead phone will.

**The `A` series is append-only.** Numbers are referenced from §6.5 step 6, §6.10 item 5, §6.11
question 6 and `02-storage.md`; a renumbering breaks all of them silently. Add, never renumber.

On failure: keep the artifact in `<appdir>/export/failed/<backup_id>/`, write
`backup_runs.verify_status = 'failed'` with the failing assertion in `verify_detail_json`, and
surface it as a review-inbox item. Never delete a failed backup silently — it is evidence.

Two bounds on "never delete", because a directory that grows forever and holds full ledger copies is
its own problem: keep at most the three most recent failed containers, and no failed container older
than 30 days once a later backup has verified. Both `export/` and `snapshots/` are covered by
§6.6.1's deny-all and §6.6.2's exclusion list — a failed `.mmbak` is encrypted, but a
`snapshots/pre_N.db` is keyed with the **live DEK**, and neither may ever reach Google Drive or
iCloud.

#### 6.3.1 `backup_runs` — a proposed addition to the schema

> **Schema disagreement, flagged for reconciliation:** `03-schema.md` has no backup-bookkeeping
> table. Without one there is no way to answer "when was the last successful backup", which §6.4
> makes a first-class UI element. The table below is modelled on `training_exports` (§3.11.5) and
> should be added to migration 0001; I have written the rest of this section against it.

```sql
CREATE TABLE backup_runs (
  id                  TEXT PRIMARY KEY,        -- UUIDv7; also the KDF info string (§6.2.1)
  kind                TEXT NOT NULL CHECK (kind IN
                        ('db_only','full','media_pack','pre_migration')),
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,

  destination_kind    TEXT NOT NULL CHECK (destination_kind IN
                        ('share_sheet','saf','webdav','local_only')),
  destination_note    TEXT,                    -- user-visible label. NEVER a credential.

  schema_version      INTEGER NOT NULL,        -- PRAGMA user_version written into the backup
  migration_head      TEXT NOT NULL,           -- last applied __drizzle_migrations tag
  app_version_code    INTEGER NOT NULL,

  bytes               INTEGER,
  db_bytes            INTEGER,
  media_count         INTEGER NOT NULL DEFAULT 0,
  media_bytes         INTEGER NOT NULL DEFAULT 0,
  db_sha256_hex       TEXT,
  manifest_sha256_hex TEXT,

  -- Which recovery phrase opens this file. After a phrase rotation the UI can say
  -- "this backup needs your previous recovery phrase" instead of "wrong phrase".
  -- NULLABLE, because kind='pre_migration' is keyed with the DEK and runs no KDF at all
  -- (§6.2.4). Declaring these NOT NULL would make §6.8.2 step 5 fail on the constraint.
  recovery_code_generation INTEGER,
  kdf_salt_hex        TEXT,
  kdf_params_json     TEXT,                    -- {"alg":"argon2id","m_kib":65536,"t":3,"p":1}
  wrap_format_version INTEGER,                 -- mmwrap format_version byte (§6.1.2). A reader that
                                               -- does not know it must say "update the app", not
                                               -- "wrong phrase".

  -- Set to 1 by §6.1.4 Flow 2 (DEK rotation after a disclosed phrase). A superseded backup still
  -- opens with its own generation's phrase — that is precisely the exposure — so the UI must be
  -- able to list these and tell the user to destroy them. Never used by the staleness query.
  superseded          INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0,1)),

  -- How many undrained spool records existed when the export quiesced. A11 requires this to be 0
  -- on the happy path; a non-zero value is surfaced, not swallowed, because those captures are in
  -- no backup and in no restore path (§2.8.3).
  spool_pending_at_start INTEGER NOT NULL DEFAULT 0,

  verify_status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (verify_status IN ('pending','passed','failed','skipped')),
  verify_detail_json  TEXT,                    -- per-assertion results; failures keep the reason
  delivered           INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0,1)),
  error               TEXT,                    -- scrubbed per 02-storage.md §2.15. An ATTACH
                                               -- failure message can embed the raw key.

  -- Every backup that can leave the device must record how to re-derive its key.
  CHECK (kind = 'pre_migration'
         OR (kdf_salt_hex IS NOT NULL AND kdf_params_json IS NOT NULL
             AND recovery_code_generation IS NOT NULL))
) STRICT;

-- "last successful backup" is exactly this index's first row.
CREATE INDEX ix_backup_runs_ok ON backup_runs(finished_at DESC)
  WHERE verify_status = 'passed' AND delivered = 1;
CREATE INDEX ix_backup_runs_recent ON backup_runs(started_at DESC);

-- "which of my saved files still open with a phrase I have retired?" — §6.1.4 needs this list to
-- be cheap, in both flows: Flow 1 to nag until they are re-made, Flow 2 to tell the user to
-- destroy them.
CREATE INDEX ix_backup_runs_generation ON backup_runs(recovery_code_generation, finished_at DESC)
  WHERE verify_status = 'passed' AND delivered = 1;
```

Companion `meta` rows (a KV table, so this is non-breaking): `recovery_code_generation`,
`backup_staleness_days` (default `7`), `backup_destination_json`. `recovery_salt_hex` is retained
only as a convenience copy of what `keys/recovery.wrap` already carries (§6.1.2) and must never be
read on a path where the database might not open. `recovery_wrap_path` is **removed** — the path is
the `RECOVERY_WRAP` constant of `02-storage.md` §2.9.1, and a second, mutable copy of it in a KV
table is exactly how the two sections drifted to `recovery/dek.wrap` and `keys/recovery.wrap` in the
first place.

`delivered` is separate from `verify_status` on purpose. A backup that verified but was never
actually handed off (the user cancelled the share sheet, the WebDAV `PUT` failed) is **not** a
backup, and the staleness indicator must not count it.

---

### 6.4 Destinations and scheduling

Ranked by what a non-expert can actually operate. Every one of these is a destination the *user*
owns; there is no first-party endpoint and no code path that could become one.

1. **Share sheet / Files provider — the default.** `UIActivityViewController` /
   `UIDocumentPickerViewController` on iOS, SAF `ACTION_CREATE_DOCUMENT` on Android. The user
   writes the `.mmbak` into a folder their own Nextcloud, Syncthing or Dropbox client already
   watches, or AirDrops it, or pulls it over USB. Zero network code, works with literally any
   user-owned destination, and no reachability failure mode. `@react-native-documents/picker`
   12.0.2 (MIT) covers the import side. On naming Dropbox: the container is end-to-end encrypted
   and where the user puts it is their call, but constraint #1 is written as absolute, so the
   picker copy names user-operated destinations first and says in one line that a third-party sync
   folder means the ciphertext is on someone else's disk — the app cannot stop it and should not
   pretend the choice is neutral.
2. **WebDAV `PUT` with basic auth** — about twenty lines of `fetch` against the user's Nextcloud.
   The only built-in "endpoint", and it mirrors the base-URL-plus-token pattern already used for
   the optional self-hosted LLM endpoint. Credentials go to the Keychain/Keystore as
   `mm.webdav.cred.v1` at `AfterFirstUnlockThisDeviceOnly` (`02-storage.md` §2.7.4 — the default
   `WHEN_UNLOCKED` breaks exactly the foreground-with-screen-locked case this feature fires in, and
   surfaces as a bogus "destination unreachable"), never to `backup_runs.destination_note`. See the
   consent gate below: this path is **not** simply "the default plus a URL".
3. *Rejected:* S3-compatible (MinIO/Garage) — SigV4 signing is real work for marginal benefit;
   SFTP — no maintained RN library.

#### 6.4.1 The WebDAV push transmits SMS-derived content, and that is a v1 decision

`05-provenance.md` §5.5 states there must never be code in this app that could become a background
upload path, and §5.7.1 enforces it with a grep forbidding the HTTP client in `src/export/`. The
WebDAV `PUT` is that path, and the grep does not cover `src/backup/`. Concretely: the `.mmbak`'s
`ledger.db` contains the whole `raw_captures` table, including every retained bank SMS body
(`sqlcipher_export` copies it unconditionally — §6.9's include toggles govern CSV/JSONL only), and
§6.4's opportunistic trigger fires it **on app foreground with no per-invocation user action**.

A Play reviewer running the app, configuring a destination and observing an automatic HTTPS `PUT` of
SMS-derived content to a host the app cannot demonstrate the user owns is looking at a data flow the
SMS declaration does not describe. "The user typed the URL" is not a distinction the spyware policy
draws. An inaccurate declaration is materially worse than a declared flow, and the remedy — pulling
the feature or amending mid-review — blocks release. §6.11 question 7 previously deferred this to
"before shipping sync"; **sync is v1.5 and this ships in v1**, so it is answered here:

- A fourth `consent_grants.purpose`, **`transmit_offdevice`**, gates both the WebDAV destination and
  the Tier C escalation endpoint. Default off. Enabling it requires typing the destination host
  explicitly; there is no preset and no discovery. **Counterpart change in `05-provenance.md`
  §5.5.1**: add the purpose to the enum and to the consent screen inventory.
- The WebDAV push is **per-invocation by default**. The automatic-on-foreground variant is a
  separate opt-in whose consent screen names what the artifact contains — "your full ledger,
  including the bank messages we captured" — rather than saying "your backup".
- HTTPS only. Redirects disabled (a 302 to another host is an exfiltration primitive). No plaintext
  fallback, no "ignore certificate errors" toggle, ever.
- **Counterpart change in `05-provenance.md` §5.5**: exclude `source_channel IN ('android_sms',
  'android_notification_sms')` from Tier C submission unless separately enabled. The
  hard-receipt-escalation use case that justifies Tier C never needs SMS text.
- Extend §5.7.1's grep to `src/backup/`, or state plainly in §5.5 that the "no code that could
  become an upload path" guarantee now has two documented exceptions. Leaving it stated absolutely
  while two features contradict it is the worst of the three options.

#### 6.4.2 Drain before backup, always

The backup path runs the spool drain (§4.4.2) to completion **before** `wal_checkpoint(TRUNCATE)`.
Without it a backup can be perfectly valid and still predate real transactions sitting in
`spool/inbox/` a directory away, and those records are in no container and no `<device-transfer>`
payload — a phone lost the next morning loses them with no `capture_gaps` row and no line on the
restore-complete screen. Assertion **A11** records the outcome; a non-zero
`spool_pending_at_start` (a drain that could not finish — no model, a quarantined record) is
surfaced in the backup summary rather than swallowed.

The same reasoning runs the other way: the drain's **insert half** must not wait for a foreground.
§4.4.2 already separates "write `raw_captures` rows and commit" from "extract", so the insert half is
triggered from the WorkManager liveness probe §4.13/D68 already schedules, putting the
spool-to-durability window at minutes rather than days. **Counterpart change in `04-capture.md`
§4.4.2.**

**Scheduling is platform-asymmetric and must not be over-promised.** iOS `BGProcessingTask` is
best-effort and can go days without firing depending on usage, charging state and Low Power Mode;
force-quitting the app from the switcher stops background execution entirely until the user
relaunches. Android WorkManager is more reliable but Doze-throttled and OEM-killed on some vendors.
A scheduled backup the user *believes* is running but isn't is strictly worse than none, because it
manufactures false confidence about the only copy of their financial history.

So v1 promises exactly this:

- **User-triggered backup, always available, one tap, from the top level of settings.**
- **Opportunistic attempt on app foreground** when `MAX(finished_at) WHERE verify_status='passed'
  AND delivered=1` is older than `meta.backup_staleness_days`, a configured destination is
  reachable, **and** the automatic-push opt-in of §6.4.1 is granted. Without that grant the
  staleness banner still fires and the backup is one tap — it is the unattended network `PUT` that
  is gated, not the reminder.
- **A loud, non-dismissable staleness banner**: *"Last off-device backup: 12 days ago."* This is the
  single highest-value UI element in the whole feature, because it is the only thing that converts
  a silent failure into a visible one.
- Background scheduling (`BGProcessingTask` / WorkManager) is a best-effort accelerator layered on
  top, never the promise.

Never block capture on destination reachability. Queue and retry.

---

### 6.5 Restore onto a new phone

Restore is an **onboarding branch**, not a settings-screen afterthought: the very first screen after
install offers "Start fresh" or "Restore from backup". It is tested Android→iOS and iOS→Android
before v1, on a factory-reset device.

**Ordering is load-bearing at steps 5–8 and was wrong in the previous draft.** It minted a DEK and
wrote the live database under it *before* either wrap of that DEK was persisted. A jetsam or an OOM
kill in that window — a fresh device mid-setup with Photos and iCloud sync running is exactly when
one happens — left a live database keyed by a DEK that existed nowhere on disk, no marker saying so,
and a startup path (`02-storage.md` §2.7.5) that routed to the recovery-phrase flow, found no wrap
or an older one, and then refused to provision because a database file existed. Permanently wedged,
with "delete app data" as the only escape, which the user reads as *the restore destroyed my
backup*. The migration path has `meta.migration_in_progress` and a three-way crash comparison; the
longer, more memory-hungry, first-run-on-a-new-phone operation had nothing.

The marker cannot live in `meta`: `meta` is inside the live database, which does not exist yet on a
fresh phone — that is the whole scenario. It is a fsynced sidecar.

```
1.  User picks the .mmbak (document picker) and enters the 15-word phrase.
2.  Read manifest.json → backup_id + schema_version + migration_head. (Counts and the kdf block
    are read too, but only as convenience: the KDF authority is the container's recovery.wrap.)
3.  Read the container's recovery.wrap header → kdf_id, params, salt (§6.1.2).
      KDF(phrase, salt, params) → backup_kek
      → backup_key = generichash(key=backup_kek, msg=backup_id)
    Wrong phrase fails HERE, cheaply, with a clear message — not with "database is corrupt".
4.  DOWNGRADE GUARD. If manifest.schema_version > this build's MAX_KNOWN:
      stop. Do not migrate backwards, do not import partially, do not crash.
      "This backup was made by a newer version of the app. Update, then restore."
5.  Write and fsync <appdir>/restore/in_progress.json  ← BEFORE anything else touches disk state
      { "backup_id": "…", "source_path": "…", "stage": "extracting",
        "wrap_b_written": false, "wrap_a_written": false, "db_created": false }
    Every subsequent step updates and re-fsyncs this file before it begins.
6.  Extract to <appdir>/restore/<backup_id>/. Open ledger.db with backup_key on its own
    connection and run assertions A2, A3, A4, A6, A7, A10 from §6.3 BEFORE touching anything else.
7.  Mint a NEW DEK (randombytes_buf(32)) for this device — held in memory only, so far.
8.  PERSIST BOTH WRAPS BEFORE THE FIRST BYTE OF THE LIVE DATABASE EXISTS:
      8a. Wrap B: KDF over the SAME phrase the user just typed → write keys/recovery.wrap
          (mmwrap/1), fsync the file, fsync the keys/ directory.  stage="wrap_b"
      8b. Wrap A: Keystore/Keychain, AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY.  stage="wrap_a"
      8c. Re-fsync the marker with wrap_b_written / wrap_a_written = true.
    A crash anywhere in 8 leaves wraps for a DEK that keys nothing — harmless and idempotent.
    A crash after 8 leaves a DB whose key is recoverable from two places.
9.  stage="writing_db".  PRAGMA foreign_keys = OFF (outside any transaction, same reason as
    §6.2.3 step 0b, and in a TRY whose FINALLY re-enables and reads it back), then
    sqlcipher_export the restored DB into the live location keyed with the new DEK, with
    PRAGMA auto_vacuum = INCREMENTAL and PRAGMA user_version set (§6.2.3, both traps again).
    PRAGMA foreign_key_check afterwards, on the live file.
    stage="db_written" ONLY after the export, the user_version write and foreign_key_check have
    all succeeded — see §6.5.4 for why a key proof is not an acceptable substitute for this.
10. Decrypt media/*.enc into the new media root, preserving media_assets.rel_path exactly
    (it is relative precisely because iOS rewrites the container UUID on restore).
    Each file is written as <name>.part, fsynced, then rename()d into place — the same primitive
    the spool uses. Without it a kill mid-decrypt leaves truncated .jpg files that step 11 sees as
    "file present, row present" and leaves alone, and A9's sha256 check does not run on this path.
11. Reconcile media both ways:
      - file with no row      → orphan, delete after a 24 h grace
      - row with no file      → UPDATE media_assets SET missing_since = :now   (never delete)
12. Forward-migrate: run migrations from manifest.migration_head to head (§6.8).
13. Rebuild FTS unconditionally (§6.2.3).
14. Regenerate identity:  meta.node_id = new uuidv4,  meta.install_id = new uuidv4.
15. Initialise the HLC physical clock to max(MAX(hlc) ms component, now).
16. Write the capture mirror files Kotlin needs (capture/senders.v1.json, capture/spool_pk.v1)
    from the restored tables — a restored phone whose mirror is absent captures NOTHING and says
    nothing about it (§4.4, 02-storage.md §2.9.1).
17. Run the full startup sweep (§3.21) and show any findings before the first ledger screen.
18. Run sweep I9 (merchant counter recompute) unconditionally.
19. Walk the user through re-granting platform permissions (§6.5.2).
20. Write a backup_runs row with kind='full', destination_kind='local_only',
    verify_status='passed', delivered=0 — so the restore is visible in backup history, but the
    staleness banner fires IMMEDIATELY. That is the correct behaviour, not a bug: a freshly
    restored phone has no off-device backup OF ITS OWN, and the first thing it should ask for
    is one. `delivered` exists precisely to keep this distinction.
21. Delete <appdir>/restore/in_progress.json and the <appdir>/restore/<backup_id>/ staging tree.
    ONLY here. The marker is the last thing to go.
```

#### 6.5.1 Why steps 14 and 15 are not bookkeeping

`meta.node_id` is the device identity stamped into every `hlc` (§3.18), and the schema deliberately
puts it in `meta` — outside any table a future sync engine replicates. Restoring the old `node_id`
onto a new phone would make two devices stamp **identical** HLCs, which silently breaks ordering
the moment sync ships and cannot be repaired retroactively. Existing rows keep their old `hlc`
strings, which is correct: history stays attributed to the device that produced it.

Step 15 matters for the same reason in the other direction. If the backup came from a device with a
fast clock, a fresh HLC seeded from `now` could sort *before* rows already in the database. Seed the
physical component from `max(existing, now)` and the monotonicity invariant holds across the
restore boundary.

#### 6.5.2 What restore honestly cannot recover

Say all of this in the restore-complete screen. Silence here is what destroys trust.

- **Anything captured after the last backup.** The staleness banner exists to keep this number small.
- **Anything captured *before* the last backup that had not yet been drained.** This is the one the
  user's mental model gets wrong: "the app already caught it" feels like "it is safe", and it is
  not. Spool records live only on the device's filesystem — they are in no `.mmbak`, in no
  `<device-transfer>` payload, and (correctly) in no cloud backup. §6.4.2 shrinks the window by
  draining before every backup and by moving the insert half onto the liveness probe, and
  `backup_runs.spool_pending_at_start` records what was still outstanding at the last verified
  backup. Drive the `capture_gaps` row from **that recorded value**, not from a fixed procedural
  step, and name the count on this screen.
- **Platform grants.** The Android notification-listener grant is keyed to the flattened
  `ComponentName` and does not restore; the iOS Wallet Shortcut automation is user-built per card
  and does not restore. Both need an explicit re-setup walkthrough, with a "make a small tap-to-pay
  purchase to confirm" verification on iOS.
- **`raw_captures.source_ref`** — `Telephony.Sms._ID` and `PHAsset` identifiers are device-local and
  meaningless on the new phone. The schema already says so. The saving grace is that
  `raw_captures.dedupe_key` for SMS is `sha256(sender || sms.date_ms || body)`, which is
  device-independent, so a post-restore SMS re-scan is **idempotent**: it re-imports history and
  `ux_raw_captures_dedupe` collapses everything that was already there. That property is free only
  because the key excludes the app's own clock.
- **Android notification history.** There is nothing to re-scan. Write a `capture_gaps` row covering
  the window between the backup and the restore, so the UI can say "capture was down 3 days" rather
  than showing an unexplained quiet period.
- **Media excluded by a `db_only` backup.** Those rows come back with `missing_since` set and
  surface through sweep check **I6** — the extraction record is still valid audit, and the
  transaction is still correct.

#### 6.5.3 Degraded restores

Every one of these is a supported path, not an error:

| Situation | Behaviour |
| --- | --- |
| `db_only` backup, no media packs | restore fully; every `media_assets` row gets `missing_since` |
| Some media packs missing | restore; list the missing pack ids by name; mark only the absent assets |
| A3 (`quick_check`) fails | refuse. Offer the previous `.mmbak` if one is present in the same folder |
| A7 (unbalanced ledger) fails | restore anyway, but force the startup sweep to the foreground and write `integrity_findings` rows before the ledger is shown. A slightly wrong ledger the user can see beats no ledger |
| Phrase rejected | check `recovery_code_generation` in the manifest against the user's other backups and say "this file needs your *previous* recovery phrase" |
| A10 (standalone wrap unwrap) fails | refuse **before** writing anything. A container whose `recovery.wrap` does not parse can still be restored via the manifest's convenience `kdf` copy, but the resulting device would have no working Wrap B — offer that only as an explicit "restore without recovery material, then immediately set a new phrase" branch, never silently |
| Unknown `mmwrap` `format_version` / `kdf_id` | "This backup needs app version X or newer", naming the version. Never "wrong phrase" |

#### 6.5.4 Resuming an interrupted restore

`<appdir>/restore/in_progress.json` is checked at step 0 of the startup sequence
(`02-storage.md` §2.14), **before any key work**, and it takes precedence over the recovery-phrase
routing rule. The comparison mirrors §6.8.3's:

| Marker | Live DB | Wraps | Action |
| --- | --- | --- | --- |
| absent | — | — | normal start |
| present, `stage` ∈ {`extracting`,`wrap_b`,`wrap_a`} | absent | partial or none | nothing durable was written. Delete the staging tree and any partial wrap, clear the marker, re-offer the restore from step 1 |
| present, `stage = "writing_db"` | present **or** absent, key proof irrelevant | both written | **`writing_db` is restartable, never resumable.** Delete the live DB and its `-wal`/`-shm` unconditionally, then re-run step 9 from scratch using the DEK read back from Wrap A |
| present, `stage = "db_written"` | present, opens | both written | the export finished and was verified. Resume from step 10 |
| present, `stage` ≥ `"post"` | present, opens | both written | resume from the recorded step; every step from 10 on is idempotent by construction |
| present, staging tree gone | either | — | the user cleared storage mid-restore. Clear the marker and route to a plain "restore from backup" prompt, keeping the wraps if a database exists |

**Why `writing_db` cannot use the key proof as its discriminator, however tempting it looks.**
`ATTACH … KEY` writes a valid SQLCipher header immediately; `sqlcipher_export` then creates tables
and copies rows into it. Kill that halfway and the file has a correct header and *some* tables, so
`SELECT count(*) FROM sqlite_master` returns N > 0 and the key proof **passes** on a truncated
ledger. Resuming from step 10 there hands the user a database silently missing transactions, and
nothing downstream catches it: A6's per-table counts ran at step 6 against the *container*, not
against the live file, and step 17's I1 sweep is happy because whole absent transactions still
balance. Restarting is cheap — the container is still in `restore/<backup_id>/` — and correct.

Restarting also fixes a second-order bug the pass branch would have caused: `sqlcipher_export` into
a destination that already contains tables appends rather than replaces, and
`PRAGMA bk.auto_vacuum = INCREMENTAL` silently no-ops on a non-empty database, so the retry would
have produced doubled rows *and* lost incremental vacuum permanently (§6.2.3 trap #1).

`stage = "db_written"` is therefore fsynced **only after** the export, the `user_version` write and
`PRAGMA foreign_key_check` have all succeeded. That marker, not a key proof, is what lets a resume
move past step 9.

Two rules that make the table implementable. **The DEK is read back from Wrap A on resume, never
re-minted** — a second mint would orphan the partially written file and reintroduce the original
bug. And **`provision()` refuses while the marker exists** (`02-storage.md` §2.7.5), so no code path
can quietly decide the device is blank and start fresh over a half-restored ledger.

---

### 6.6 Platform backup, and the key-not-backed-up trap

**The trap, stated plainly.** Both platforms will, by default, cheerfully copy the encrypted
database off the device — and the key will not go with it. Android Auto Backup includes
`getDatabasePath()`, `getFilesDir()` and `getExternalFilesDir()` by default (only `getCacheDir()`
and `getNoBackupFilesDir()` are excluded). iCloud Backup includes everything under `Library/`
except `Caches/`, and op-sqlite's iOS default location is `Library/`. Meanwhile Android Keystore
keys are non-extractable and destroyed on uninstall, and iCloud Backup's keychain copy is encrypted
under a Secure Enclave UID key that "can be restored only to the same device from which it
originated". Even an *encrypted* Finder/iTunes backup does not carry
`kSecAttrAccessible…ThisDeviceOnly` items. So the platform backup is simultaneously (a) a violation
of constraint #1, since it is public cloud, and (b) completely useless, because it restores an
undecryptable blob onto a phone whose Keystore has never seen the key. A user who believes they are
protected by iCloud is in the worst possible state.

Add a third problem on Android: Auto Backup's quota is **25 MB per app**. Exceed it and the system
calls `onQuotaExceeded()` and stops backing up. The Large Backups API lifts this but is
approval-only and targets ~100M-MAU apps. So the default configuration also produces visible backup
failures.

#### 6.6.1 Android configuration

`android:allowBackup="true"` with explicit rules, **not** `allowBackup="false"`. Two research inputs
disagreed; the discriminator is whether the recovery-wrapped DEK travels as a plain file that
`<device-transfer>` can carry. In this design it does (`<appdir>/keys/recovery.wrap`, §6.1), so
device-to-device transfer becomes a real restore path and is worth keeping — and
`allowBackup="false"` would kill it. *Rejected: the stricter `allowBackup="false"` position; it is
the honest choice only if the recovery wrap is Keystore-bound, which here it deliberately is not.*

> **This is the only `<data-extraction-rules>` block in the design.** `02-storage.md` §2.9 used to
> carry a second, drifted copy; it now owns the path constants (§2.9.1) and this section consumes
> them. Every `path` string below is `===` a constant from that module, asserted in CI, because an
> `<include>` whose path matches nothing is accepted silently by Android — a `<device-transfer>`
> that says `recovery/dek.wrap` while the code writes `keys/recovery.wrap` moves the database and
> media to the new phone and not the one artifact that can open them.

**`<cloud-backup>` is deny-all, not a list of excludes.** Exclusion lists are allowlist-by-omission:
everything not named is uploaded, so every directory the app grows later escapes silently, with no
build error and no runtime symptom. The earlier enumerated version omitted `restore/` (a full
extracted backup after every restore) and, in `02-storage.md`'s copy, `snapshots/` and `export/`
too — `snapshots/pre_N.db` being a complete `sqlcipher_export` of the ledger **keyed with the live
DEK**, present on disk during every update window, sitting next to `keys/recovery.wrap`. Those two
files together are an offline-attackable package: encrypted ledger plus wrapped key, needing only
the phrase. Against the app-generated 160-bit phrase that is infeasible; against the user-chosen
passphrase §6.1.3 gates, it is a routine offline crack with the Argon2 parameters helpfully
published in the manifest.

```xml
<!-- res/xml/data_extraction_rules.xml  (android:dataExtractionRules, API 31+) -->
<data-extraction-rules>
  <cloud-backup>
    <!-- Constraint #1: this is Google's servers. Also useless (no key) and over quota (25 MB).
         DENY EVERY DOMAIN AT THE ROOT. Nothing is re-included. A directory added in a future
         migration is covered the day it is created, which an enumerated list can never promise. -->
    <exclude domain="root"              path="." />
    <exclude domain="file"              path="." />
    <exclude domain="database"          path="." />
    <exclude domain="sharedpref"        path="." />
    <exclude domain="external"          path="." />
    <exclude domain="device_file"       path="." />
    <exclude domain="device_database"   path="." />
    <exclude domain="device_sharedpref" path="." />
  </cloud-backup>

  <!-- Direct device-to-device. Never touches a Google server, so it is constraint-compliant,
       and it works ONLY because keys/recovery.wrap is a plain file. The user still re-enters
       the recovery phrase on the new device: Keystore material does not transfer.
       Every path here is a §2.9.1 constant; the set is a SUBSET of the cloud-backup excludes. -->
  <device-transfer>
    <include domain="database" path="." />        <!-- DB_DIR/DB_NAME -->
    <include domain="file"     path="media/" />   <!-- MEDIA_DIR -->
    <include domain="file"     path="keys/" />    <!-- KEYS_DIR — recovery.wrap lives here -->
    <include domain="file"     path="capture/" /> <!-- CAPTURE_DIR — the Kotlin↔SQLite mirror -->
  </device-transfer>
</data-extraction-rules>
```

`capture/` is in `<device-transfer>` for a reason that is easy to miss and fails silently: the
notification listener reads its allowlist and the spool public key from files, not from SQLCipher
(§4.4, `02-storage.md` §2.8.1). A transferred phone whose `capture_senders` rows arrived inside the
database but whose mirror did not **captures nothing at all**, with no error and no gap row, until
the user next opens the app. It is small, it is not secret, and leaving it out costs days of
transactions.

The device-protected spool spelling that still appears in `03-schema.md` §3.10 and
`07-platforms-risks.md` §7.1.3 must be struck: it puts the spool in `domain="device_file"`, and any
`file`-domain rule written for it matches nothing. The deny-all above covers both domains anyway,
which is exactly the property an enumerated list lacks.

A parallel `android:fullBackupContent` file with the same deny-all shape is required for API ≤ 30 —
apps targeting 12+ still need both. `<cross-platform-transfer platform="ios">` exists but is left
unconfigured for v1: it is unproven for this shape and the `.mmbak` path already covers
Android→iOS.

#### 6.6.2 iOS configuration

Put the database in its own directory and set the exclusion flag on the **directory**, not the
file. The `-wal` and `-shm` sidecars are created by SQLite after the fact, so per-file flags are a
race you will lose; a directory-level `NSURLIsExcludedFromBackupKey` covers everything inside it,
now and later.

The list is **every constant in `02-storage.md` §2.9.1**, not a subset. Two directories were missing
from earlier drafts and both hold complete copies of the ledger: `restore/` (the extracted contents
of a `.mmbak`, present after every restore until step 21 clears it) and `snapshots/` (a full
`sqlcipher_export` keyed with the live DEK, present during every migration window and after any
interrupted one).

```
Library/Application Support/mm/db/        ← isExcludedFromBackup = true  (ledger.db, -wal, -shm)
Library/Application Support/mm/media/     ← isExcludedFromBackup = true
Library/Application Support/mm/keys/      ← isExcludedFromBackup = true  (recovery.wrap)
Library/Application Support/mm/capture/   ← isExcludedFromBackup = true  (Kotlin/Swift mirror)
Library/Application Support/mm/spool/     ← isExcludedFromBackup = true  (sealed capture records)
Library/Application Support/mm/export/    ← isExcludedFromBackup = true  (staging/ and failed/)
Library/Application Support/mm/snapshots/ ← isExcludedFromBackup = true  (pre-migration, DEK-keyed)
Library/Application Support/mm/restore/   ← isExcludedFromBackup = true  (staging + in_progress.json)
```

The flag is set on each directory **at creation**, in the one helper that creates them, so a
directory added later cannot be created without it. A per-call `try?` that swallows the failure is
not acceptable here: an unset flag is a constraint-#1 violation with no symptom, so the helper
throws and first launch fails loudly.

File protection class stays `NSFileProtectionCompleteUntilFirstUserAuthentication` for all of them.
Do **not** raise the DB or its sidecars to `NSFileProtectionComplete` — that makes them unreadable
whenever the screen is locked and produces intermittent, unreproducible write failures.

#### 6.6.3 The CI checks that keep it that way

These are build-time, because there is no runtime symptom and no build error if they regress:

- **G-7a** Grep the merged manifest (`app/build/outputs/logs/manifest-merger-*.txt`) and assert
  `android:dataExtractionRules` **and** `android:fullBackupContent` are both present, that
  `allowBackup` is `true`, and that the listener is **not** declared `android:directBootAware`
  (§7.4's N5).
- **G-7b — shape, not enumeration.** Parse `data_extraction_rules.xml` and assert that
  `<cloud-backup>` contains an `<exclude path=".">` for **every** backup domain and **zero**
  `<include>` elements. Asserting "the file mentions `keys/`" is what let the previous version pass
  while the include pointed at a path nothing writes.
- **G-7c — path-constant equality.** Every `<device-transfer>` `path` string is `===` an exported
  constant from `src/storage/paths.ts` (§2.9.1), and the set of transfer paths is a subset of the
  cloud-backup excludes. Fails the build on a string literal.
- **G-7d — runtime directory enumeration.** Script a first run + backup + migration + restore on an
  emulator, list every directory the app created, and fail if any is not covered by the deny-all.
  This is the gate that catches the directory a future feature adds.
- iOS unit test: after first launch, `resourceValues(forKeys: [.isExcludedFromBackupKey])` is
  `true` for **all eight** directories in §6.6.2, enumerated from the same constants module.
- iOS unit test: the resolved DB path does **not** resolve under
  `containerURL(forSecurityApplicationGroupIdentifier:)`. A widget or App Intents Extension that
  later moves it there reintroduces `0xdead10cc` as a background-termination statistic weeks later
  rather than as a reproducible bug.
- **G-10 / G-11** iterate `02-storage.md` §2.7.4's item inventory — every Keychain item's
  `kSecAttrAccessible` is the `AfterFirstUnlockThisDeviceOnly` constant and its
  `kSecAttrSynchronizable` is `false`; every Android Keystore alias has the matching flags. Reading
  one item back is what let `backup_kek` and the WebDAV credential take the wrong default.
- Lint: no `SecureStore.setItemAsync` call without an explicit `keychainAccessible` option.
- **G-16** additionally runs assertion **A10** — unwrap a `recovery.wrap` on a device with an empty
  `meta` table and no manifest present.
- **A real device-to-device transfer test.** The whole `allowBackup="true"` position rests on
  `keys/recovery.wrap` and `capture/` actually arriving; §6.11 question 4 records that this is
  unverified. Perform a D2D transfer between two devices and assert both are present on the target
  **before first launch completes**, then that the recovery-phrase flow opens the database and that
  the listener captures a synthetic notification without the app being opened first.

---

### 6.7 Self-hosted sync — a v1.5 workstream the schema already pays for

**v1 ships no sync engine.** What v1 ships is a schema that makes adding one additive rather than a
rewrite, and a small set of convergence rules pre-committed now so they do not have to be
retrofitted onto data that was written under different assumptions.

#### 6.7.1 What §3.18 already carries

| Carried today | Why it cannot be retrofitted |
| --- | --- |
| `hlc TEXT` on every mutable row | Device clocks are user-settable; under `updated_at`, an NTP jump or a timezone move silently reorders edits and the loss is invisible. Backfilling HLCs onto a year of rows produces a clock with no real ordering |
| `node_id` per install, stored in `meta` (never replicated) | Two devices with the same node id produce colliding HLCs, unrepairably |
| `deleted_at` tombstones everywhere, 180-day purge | Without them, a delete on device A is resurrected by device B's stale row — the single most common bug in `updated_at`-based designs |
| `oplog` (append-only, per-column old/new, `origin`) | This *is* the sync payload. It also happens to be the undo stack and a second view of the FunctionGemma harvest. **Precondition, below** |
| **Dirty-columns-only writes** (rule #8) | The one that is genuinely unretrofittable. `UPDATE transactions SET merchant_id=?` from A and `UPDATE transactions SET amount_minor=?` from B both survive under last-push-wins *and* under per-field merge; a single ORM full-row `UPDATE` clobbers the other's field with a stale value. After a year of full-row writes, fixing it means auditing every write path |
| Append-only tables with UUIDv7 keys | Incremental transfer is `WHERE id > :watermark` per (table, node). §3.6 already assumes this |
| `transaction_fields` replacement rule (§3.11.4) | This is already a per-field merge function. Sync reuses it verbatim — authority rank, source rank, pin semantics and all |

> **Precondition on `oplog` as the sync payload — a content-column allowlist, settled before v1.5
> and preferably at v1.** `oplog` records one row per changed column, written from the same
> repository chokepoint the drain's `raw_captures` insert goes through, so unless something stops it
> the table holds a verbatim copy of every bank message body — `('raw_captures', <id>,
> 'payload_text', NULL, '"Compra por MXN 480.00 en LA DOCENA con tarjeta *4471…"')`. §5.8.3's purge
> touches five tables and `oplog` is not one of them, so a user who set 30-day retention keeps those
> bodies for 90 days **or 200k rows, whichever is larger** (D118) — years, for a light user. The
> `.mmbak` copies `oplog` like any other table, and this section would then transmit it to a sync
> server.
>
> So: `oplog` records ledger and provenance mutations only, and **never**
> `raw_captures.payload_text`, `raw_captures.payload_meta_json`, `extraction_runs.raw_output`,
> `extracted_fields.value_json` or `media_assets.rel_path`. The cleanest form is to exclude
> `raw_captures` and `extraction_runs` from `oplog` entirely — both are append-only with their own
> audit story, so `oplog` adds nothing there. **Counterpart changes: `03-schema.md` §3.18** (state
> the allowlist and add the sweep check that flags any `(table_name, column_name)` outside it) and
> **`05-provenance.md` §5.8.3** (add `DELETE FROM oplog WHERE table_name = 'raw_captures' AND row_id
> = :capture_id` to the purge transaction). Until both land, the relay in §6.7.3 must not ship —
> and gate **G-20** should run the amount/message regex over `oplog` after a purge, which is what
> §5.9's "run the amount-regex over every purged row's remaining columns" was meant to cover and
> does not, because `oplog` is a different table.

#### 6.7.2 The hard multi-device problem here is duplicate capture, not conflicting edits

Two Android phones on the same accounts both run the notification listener; both see the same bank
push; both mint a transaction. No conflict fires — the rows have different UUIDv7 ids, LWW has
nothing to resolve, and the user's totals are quietly doubled. No CRDT and no LWW policy helps.

The defence is already in the schema: `transactions.dedupe_hash` is content-addressed, and
`ux_txn_dedupe` is `UNIQUE(dedupe_hash) WHERE dedupe_hash IS NOT NULL AND deleted_at IS NULL AND
disposition = 'active'`. That index is per-device. The sync rule that extends it across devices is
pre-committed here so nothing in the schema has to change:

> **Convergence rule D.** Two `active` rows with equal non-NULL `dedupe_hash` are the same logical
> transaction. Keep the one with the lexicographically smaller `id` (UUIDv7 → earlier capture);
> set the other to `disposition = 'merged_into'` with `merged_into_id` pointing at the survivor and
> repoint its `observations.txn_id`. Both devices compute this independently and reach the same
> answer, with no coordination and no server arbitration.
>
> **Convergence rule O.** `ux_observations_slot` (`txn_id`, `source_channel`, `role`) collisions
> resolve the same way: smaller `id` wins, the loser's `txn_id` is set NULL and it becomes a
> candidate for re-matching.
>
> **Convergence rule F.** Everything else goes through the existing
> `transaction_fields` replacement rule, with `hlc` as the tie-break at equal authority and equal
> source rank. Derived data — budget rollups, `budget_periods.actual_minor`, category totals,
> `merchants.txn_count` — is **never** synced. It is recomputed locally, which is exactly what
> keeps CRDT counters out of the design.

#### 6.7.3 The recommended v1.5 shape: an append-only relay you own

Given that every interesting table is already append-only with UUIDv7 keys and an `oplog` exists,
the smallest thing that works is also the most constraint-compliant:

- Each device pushes, per (table, node), the rows above its watermark, plus its `oplog` rows,
  **encrypted client-side** with a key derived from the DEK.
- The server is an ordered blob store per node. It never parses a row, never resolves a conflict,
  never sees a merchant name. Zero-knowledge by construction, which no off-the-shelf engine below
  gives you.
- Each device pulls other nodes' streams and applies them through rules D, O and F.
- Transport is HTTPS to a user-configured base URL with a bearer token — the same Tier-C pattern as
  the optional self-hosted LLM endpoint. A WebDAV directory works as a degenerate server.

A few hundred lines of app code and a container the user actually can run. Compare the alternatives:

| Candidate | Verdict |
| --- | --- |
| **Self-hosted Turso** (`tursodb ./server.db --sync-server`, MIT, single binary; `@tursodatabase/sync-react-native` 0.7.2) | The strongest off-the-shelf option, but **gated** (§6.7.4). It also inverts the model: sync is remote-authoritative (outbound logical mutations, inbound *physical pages* until the replica is byte-identical), and its BYOK encryption is **server-side, not end-to-end** — the server holds the key in memory and sees plaintext rows. Acceptable for a machine the user owns; must never be described as "the server never sees my finances" |
| **CouchDB + PouchDB** (`pouchdb-adapter-react-native-sqlite` 4.2.1, MIT, sits directly on op-sqlite) | The only candidate a genuine non-expert can self-host — one Apache-2.0 container, replication and per-user databases built in. But it is a document store: the SQL reporting, FTS5 and joins this schema is built on either disappear or need a hand-maintained shadow projection. A real fallback, but a data-model fork, not a bolt-on |
| **ElectricSQL** | Disqualified by its own docs: "Electric does not do write-path sync." Read-path only |
| **PowerSync** | Disqualified architecturally: it requires a central backend database as the source of record, contradicting constraint #2. Self-hosting means Postgres-with-logical-replication + the service container + a JWKS issuer + a write API you author — four services for one user with two phones. The self-hosted service is also FSL, not OSI open source |
| **rsync / file copy** | Not sync. In WAL mode the committed state spans `.db`/`-wal`/`-shm`, and two devices each pushing a whole file means one device's history is silently destroyed with no error. Excellent as a *backup* transport (§6.4), disqualified as sync |
| **CRDTs / cr-sqlite** | Not needed — nothing here is CRDT-shaped (no shared counters, no ordered lists, no collaborative text), and derived data is recomputed rather than synced. cr-sqlite is also in maintenance mode and near-certainly cannot compile alongside op-sqlite's `sqlcipher` flag |

#### 6.7.4 The Turso gate, as a testable condition

Do not name Turso as *the* path until all three are true, and re-check rather than assume:

1. `@tursodatabase/sync-react-native` exposes **local at-rest encryption**. Today its constructor
   takes a `path`; `tursodb`'s encryption lives behind `--experimental-encryption` with
   `cipher=`/`hexkey=` in a connection URI. Until this is exposed, adopting Turso means an
   **unencrypted local finance database**.
2. `tursodb --sync-server` documents an **authentication mechanism**. The self-hosted docs show
   only an address and a DB path. An unauthenticated sync server beyond a Tailscale/LAN boundary is
   a non-starter.
3. op-sqlite's `turso` and `sqlcipher` compile flags are resolved. The docs state `turso`
   "switches the backend to Turso SDK kit" and that some feature combinations fail at pod-install
   or Android build time. If they are mutually exclusive — which is near-certain, since they are
   different SQLite sources — choosing Turso means **giving up SQLCipher**, and §6.1 with it.

Keep every database access behind the repository interface (`open/close/exec/transaction/prepare`)
so the engine stays swappable, and keep migrations as checked-in SQL files rather than
generated-at-runtime, so the history is portable off Drizzle entirely.

---

### 6.8 Migrations that cannot brick the database when a user skips versions

Skipping versions is the **normal case**, not an edge case: a user reinstalls after eight months,
or restores a v3 backup into a v9 build. Every mechanism below assumes it.

#### 6.8.1 Non-negotiables

- **Checked-in numbered SQL files** (`0001_init.sql`, `0002_….sql`), applied strictly in sequence.
  Never `if (version < 5) { doTheBigOne() }` — that is the construct that breaks on skipped
  versions, and it breaks silently.
- **`__drizzle_migrations` is the single source of truth** (§3.2). It is copied by
  `sqlcipher_export`; `user_version` is not, and is written only for the manifest and the
  downgrade guard.
- **Additive-only** (rule #7): new nullable columns, new tables. No renames, no drops — deprecate
  in place. Given that harvesting training data means columns get added constantly, this is the
  common path, and it needs no table rebuild and therefore none of §6.8.4.
- **Pin `drizzle-orm` 0.45.2 exactly** (non-caret), with a matching `drizzle-kit`. 1.0 has been in
  RC since ~May 2026 and its relational-query API changed; a data layer that must survive years
  should not ride an RC.

#### 6.8.2 The procedure

Ordering here is load-bearing in three places, all marked.

```
 1. Open and key the database. Migrations cannot run before the key.
 2. PRAGMA foreign_keys = OFF          ← OUTSIDE any transaction. SQLite documents this pragma as
                                          "a no-op within a transaction"; wrapping it in the
                                          migration transaction silently leaves FK enforcement ON
                                          during a table rebuild, which is the exact trap it exists
                                          to avoid.
                                       ← AND: steps 2-12 are a TRY. Step 12 moves into a FINALLY.
                                          This window is the longest of the three FK-off windows in
                                          the design (it spans a multi-second data migration) and
                                          it is on the process-lifetime write connection, so a
                                          throw that skips the re-enable leaves every ON DELETE
                                          RESTRICT in §3 inert until the app is killed.
 3. Disk pre-flight: free space >= db_bytes * 1.2 + 50 MB. Refuse with a clear message otherwise —
    a snapshot that fails halfway leaves you with neither copy.
 4. Write meta.migration_in_progress = '<target head>' and COMMIT it.   ← its own transaction, so
                                          it survives the rollback of the migration transaction.
 5. Snapshot: sqlcipher_export to <appdir>/snapshots/pre_<target>.db, keyed with the SAME DEK
    (raw key, no KDF, near-instant), with PRAGMA snap.auto_vacuum = INCREMENTAL and
    PRAGMA snap.user_version = <current> (§6.2.3, both traps). Write a backup_runs row with
    kind='pre_migration'.
 6. BEGIN IMMEDIATE
 7. Apply migrations n+1 … N in order. SQLite DDL is transactional, so this batch is genuinely
    atomic — the snapshot is belt for what leaks around it (pragmas, the 12-step rebuild's FK
    state, and a process kill during a long data migration).
 8. PRAGMA foreign_key_check   → any returned row aborts.
 9. Run sweep checks I1, I3, I4 (§3.21) → any finding aborts. A migration that unbalances the
    ledger must never commit.
10. PRAGMA user_version = N     ← same transaction as the final migration, per §3.2.
11. COMMIT
12. FINALLY: PRAGMA foreign_keys = ON, then SELECT it back and assert it is 1. Then
    PRAGMA foreign_key_check on the LIVE database and PRAGMA quick_check.
13. Assert meta.allow_hard_delete = 'no' (§6.8.4 Trap A can leave it on). Clear
    meta.migration_in_progress (own transaction), delete the snapshot, mark the
    pre_migration backup_runs row delivered = 0, verify_status = 'skipped'.
```

`PRAGMA journal_mode` and `VACUUM` cannot run inside a transaction; if a migration ever needs
either, it runs outside the batch, after step 12, and is idempotent.

**On failure at any step 6–12, rollback is an ordered sequence, not "replace the file".** The old
wording — close, replace the live DB with the snapshot, reopen — is neither atomic nor WAL-aware:

1. **Close the connection.**
2. **`unlink()` `<db>-wal` and `<db>-shm`.** This is the step that was missing and it is the
   dangerous one. If the process was *killed* rather than cleanly closed, a `-wal` survives holding
   frames written against the half-migrated file. SQLite recovers a WAL by frame checksum and does
   **not** verify that it belongs to the main database it finds — so those frames get replayed onto
   the substituted pre-migration snapshot. Best case `quick_check` reports corruption; worse case it
   recovers cleanly into a mixed-generation database that passes `quick_check` and has silently
   wrong pages, with no cloud copy and a last verified backup that may be days old.
3. **`rename()` the snapshot over the live path** — atomic on APFS / ext4 / f2fs, the same primitive
   the spool relies on. Never `copy`: a kill mid-copy leaves a truncated file with the snapshot
   possibly already consumed.
4. **Reopen, `PRAGMA quick_check`, and compare the `__drizzle_migrations` head** against the
   pre-migration value.
5. **Only if 4 passes, delete the snapshot.** An interrupted rollback is then simply retried rather
   than being a third, unrecoverable state.

Surface the error with the migration number. Never leave a partially-migrated database reachable.

#### 6.8.3 Crash recovery, done correctly

The naive version of step 4 loses a successful migration. If the process dies *after* COMMIT but
*before* clearing the flag, a startup that blindly restores the snapshot throws away work that
actually completed. The flag therefore records the **target head**, and startup compares:

| `meta.migration_in_progress` | `__drizzle_migrations` head | Action |
| --- | --- | --- |
| absent | anything | normal start |
| `T` | `= T` | the migration completed; clear the flag, delete the snapshot, start |
| `T` | `< T` | interrupted; **run the full §6.8.2 rollback sequence** (unlink sidecars, `rename()`, reopen, `quick_check`), clear the flag, retry once, then surface |
| `T` | `> T` | impossible; treat as corruption, run the rollback sequence, write an `integrity_findings` row |
| `T`, and `<db>` is missing or fails `quick_check` while `snapshots/pre_T.db` exists | any | **a kill during the rollback itself.** Re-run the rollback from step 2 — the snapshot is still there precisely because §6.8.2 does not delete it until the reopened database passes. Idempotent by construction |

Two things startup must also settle here, because both are set by the migration runner and neither
is covered by the head comparison:

- **`meta.allow_hard_delete` must be `'no'`.** Trap A sets it to `'yes'` mid-procedure; a kill
  between the rebuild and the reset leaves it on **forever**, with no visible symptom, on the
  branch where the migration had already committed and the snapshot is therefore never consulted.
  The five append-only guards — including the one protecting `consent_grants`, the table whose whole
  purpose is to make a consent claim provable — are simply not there any more, and nobody notices
  until the audit trail is needed. Assert, force-reset, and write an `integrity_findings` row so the
  occurrence is recorded rather than silently corrected (`02-storage.md` §2.14 step 8;
  **counterpart in `03-schema.md` §3.21** for the check id, which §5.9 already flags as needing the
  `check_id` CHECK opened up).
- **`PRAGMA foreign_keys` must read `1`** before the first write batch. Startup issues it, and the
  repository re-reads it per batch (`02-storage.md` §2.10.1).

#### 6.8.4 The two traps specific to *this* schema

**Trap A — a table rebuild trips the append-only triggers.** §3.19 installs
`BEFORE DELETE` / `BEFORE UPDATE` guards on `transaction_events`, `fx_rates`, `oplog` and
`raw_captures`, and a soft-delete guard on `transactions`. The 12-step table-rebuild procedure
copies rows out and drops the original, which fires those guards and rolls back the migration.
A rebuild therefore requires, inside the migration and in this order: set
`meta.allow_hard_delete = 'yes'` → `DROP` the affected triggers → rebuild → **re-`CREATE` the
triggers verbatim and reset `meta.allow_hard_delete = 'no'` in the SAME statement batch, so no
committed state ever has the triggers back without the flag cleared** → re-verify sweeps I1/I2 (I2
catches any transaction whose `transaction_seals` row was lost in the rebuild) → re-seal anything
I2 reports. This is a deliberate, reviewed migration and is never routine.

`meta.allow_hard_delete` is an **in-band kill switch for five append-only guards, reachable by every
write path in the app**, which is a poor shape for something D51 calls "a reviewed operation, never
application code" — and Trap A is precisely application code setting it. The mitigations are
therefore belt and braces: the same-batch reset above, the startup assertion in §6.8.3, and the
§6.8.6 test that kills the process during a rebuild and asserts the flag is `'no'` after recovery.

**Trap B — the two `STORED` generated columns are frozen at v1.** `ALTER TABLE ADD COLUMN` cannot
add a `STORED` generated column, so `transactions.booked_month` and `entries.booked_month` can only
ever change via Trap A. Rule #7 already states this; the practical consequence for migration
authors is that any *new* derived column must be `VIRTUAL` or app-maintained. If you find yourself
wanting a third `STORED` column, you are proposing a full table rebuild of the two largest tables
on the device.

**Seed-data migrations are data, not DDL, and one of them is dangerous.** Refreshing `currencies`
from a newer ISO 4217 / CLDR snapshot is additive (new rows; `status='retired'`, `retired_on`,
`successor_code` on departures) and safe. Changing an existing `currencies.iso_exponent` is **not**:
the exponent triggers in §3.19 only fire on INSERT, so historical rows would keep the old exponent
and silently disagree with the currency table. Sweep check **I4** detects the drift, but the correct
handling is a deliberate re-derivation through the §3.3.4 path with
`fx_rederivations.reason = 'manual'` — never a bare `UPDATE currencies`. Bump
`meta.currency_source_version` in the same migration.

#### 6.8.5 Backup ⇄ migration interaction

- **Restoring an older backup into a newer build** is the common case: restore at
  `manifest.schema_version = 3`, then run migrations 4…N as step 12 of §6.5. Because
  `__drizzle_migrations` travels inside the backup, the migrator knows exactly where to start.
- **Restoring a newer backup into an older build** is refused at §6.5 step 4. Read-only, clear
  message, no partial import, no crash. Never migrate backwards.
- **A backup taken mid-migration cannot exist** — the migration batch holds `BEGIN IMMEDIATE`, and
  the backup path takes `PRAGMA wal_checkpoint(TRUNCATE)` first, so the two serialise on the write
  lock (`busy_timeout = 5000`, §3.1).

#### 6.8.6 The test matrix, run in CI on a real device profile

| Test | Asserts |
| --- | --- |
| Fresh install at every released version → migrate to head | no version is a dead end |
| Install v1, jump straight to v9 | skipped versions apply in sequence |
| Restore a v3 `.mmbak` into a v7 build | forward migration after restore |
| Restore a v7 `.mmbak` into a v3 build | refused, read-only, database unmodified |
| Kill the process mid-batch | §6.8.3 restores the snapshot and retries |
| Kill the process after COMMIT, before clearing the flag | §6.8.3 keeps the migration |
| **Kill the process during the rollback, with a stale `-wal` present** | the sidecars are unlinked before the `rename()`, the snapshot survives because it is deleted only after `quick_check` passes, and the retry converges. Assert the recovered DB's `quick_check` is `ok` **and** that its page contents match the snapshot byte-for-byte — a WAL replayed onto the wrong main file can pass `quick_check` and still be wrong |
| **Kill the process during a Trap A table rebuild** | `meta.allow_hard_delete` reads `'no'` after recovery and the five append-only guards exist |
| **Throw a `SQLITE_FULL` out of the snapshot step** | `PRAGMA foreign_keys` reads `1` afterwards on the live connection, and the next repository write batch is not refused |
| Migration with `foreign_keys` deliberately left ON | the procedure catches it rather than corrupting |
| 50k transactions + 2 GB media | wall-clock budget, and the disk pre-flight fires when it should |
| Round-trip: backup → wipe → restore → backup again | the two manifests' per-table counts match exactly |
| **Kill the process at each §6.5 stage marker in turn** (`extracting`, `wrap_b`, `wrap_a`, `writing_db`, `db_written`, `post`) | §6.5.4 resumes to a working ledger from every one, never reaches the recovery-phrase flow, and never leaves a database whose DEK is not in both wraps |
| **Kill the export *mid-copy* at `writing_db`, then resume** | the live DB is deleted and re-exported, not appended to; per-table counts equal the manifest's and `PRAGMA auto_vacuum` is `2`. A resume that trusted the key proof would pass a truncated ledger here |
| **Kill first provisioning between the Wrap B write and database creation** | next launch discards the orphan wrap via `keys/.provisioning` and provisions cleanly — it does **not** park on "we found recovery material but no data" with nothing to restore |
| **Restore, then D2D-transfer the restored phone** | `keys/recovery.wrap` and `capture/` arrive; the recovery-phrase flow opens the DB; the listener captures without the app being opened first |
| Same synthetic bank push ingested from two `node_id`s | one transaction (rule D regression test) |

---

### 6.9 Export is not backup, and the UI must say so

Two different deliverables, conflated at your peril.

| | **Backup** (`.mmbak`) | **Export** (CSV / JSONL) |
| --- | --- | --- |
| Purpose | restore the app | outlive the app |
| Fidelity | complete, byte-exact | lossy by design |
| Format | SQLCipher DB in an encrypted container | plain text |
| Restorable | yes, and it is the only thing that is | **no** — the UI says this in the export sheet, not in a footnote |
| Openable elsewhere | DB Browser for SQLite (SQLCipher build) | any spreadsheet |

JSON is the wrong *backup* format — it loses SQLite types, bloats 3–5×, and turns reimport into a
schema-mapping exercise. It is the right *export* format for full fidelity, alongside CSV for the
spreadsheet case.

**The export must carry the whole FX tuple or it is a silent data-loss bug.** Dropping the original
currency is the classic failure: `€7.72` is a derived figure that appears nowhere in the physical
world, while the receipt and any merchant dispute both say `¥1,250`. Every transaction row exports:

```
id, booked_local_date, booked_tz, booked_precision, kind, direction,
amount_minor, currency_code, currency_exponent, amount_text_raw,
authorized_amount_minor, settled_amount_minor, effective_amount_minor, tip_minor,
reporting_amount_minor, reporting_currency_code, reporting_exponent,
reporting_rate_num, reporting_rate_den, reporting_rate_date, reporting_source, reporting_locked,
account_id, merchant_raw, category canonical_key, tags, note,
clearing_state, confirm_state, disposition, input_channel, confidence
```

A second CSV for `line_items`, a third for `entries` and a fourth for `transaction_links` (so the
double-entry structure and the refund/installment graph survive for anyone who wants them). The
`entries` CSV carries the per-leg reporting tuple — `reporting_amount_minor`,
`reporting_currency_code`, `reporting_exponent`, `reporting_rate_num`, `reporting_rate_den`,
`reporting_rate_date` — and `transaction_links` carries `currency_code` **and**
`currency_exponent`; both sets are additions the accounting review requires of `03-schema.md` §3.7
and §3.9, and an export written before they land silently drops the only per-leg record of how a
category total was converted. Amounts export as **minor units plus the exponent**, not as formatted
decimals — a formatted decimal reintroduces the separator ambiguity the whole money design exists
to eliminate, and `1.234,56` in a CSV is a coin flip.

Include toggles, with these defaults. **They govern CSV/JSONL only.** The `.mmbak` is complete by
definition — `sqlcipher_export` copies every table unconditionally, `raw_captures` included — so a
user who set "raw captured SMS bodies" to *off* here and then configured a WebDAV destination has
been pushing exactly those bodies to their NAS on every foreground. Say that sentence in the backup
UI, not only in this document, and see §6.4.1 for the consent gate that now stands in front of it:

| Content | Default |
| --- | --- |
| Transactions, entries, line items, budgets, tags | **on** |
| Receipt images | off (size) |
| Raw captured SMS / notification bodies (`raw_captures.payload_text`) | **off** — the most sensitive rows in the database |
| Voice transcripts | **off** |
| LLM training pairs | **off** — that is `training_exports` (§3.11.5), a separate, separately-consented flow with its own manifest and its own format-preserving pseudonymisation |

Export is never a setting and never a background job. It is a per-invocation explicit action with a
summary screen showing the record count and date range before anything is written.

---

### 6.10 What v1 ships, and what it ships switched off

**Ships on:**

1. SQLCipher at rest under an envelope DEK, raw-key mode, 67-character assertion, startup self-test.
   The DEK is the **only** root secret; everything else is derived from it (§6.1).
2. Recovery-phrase generation **forced during onboarding**, with re-entry verification, and the
   self-describing `mmwrap/1` wrap file (§6.1.2) with both `kdf_id` readers.
3. One **verified** backup to a user-chosen destination forced during onboarding, before real data
   is entered.
4. One-tap `db_only` backup, always available; `full` and incremental `media_pack` as explicit
   choices. Every backup drains the spool first (§6.4.2).
5. Verify-by-read-back (assertions **A1–A11**) before the word "backed up" appears anywhere.
6. Restore as a first-class onboarding branch — wraps persisted before the live database exists,
   behind the `restore/in_progress.json` marker, with the §6.5.4 resume table. Tested Android→iOS
   and iOS→Android on factory-reset hardware, **including a kill at every stage marker**.
7. Non-dismissable staleness banner driven by `backup_runs`.
8. Platform-backup **deny-all** rules on both OSes (§6.6.1, §6.6.2), plus the CI gates in §6.6.3
   including the real device-to-device transfer test.
9. Pre-migration snapshot with the ordered, WAL-aware rollback and the §6.8.3 crash-recovery
   comparison, including the kill-during-rollback row.
10. CSV/JSONL export with the full FX tuple and raw-capture bodies defaulted off — with the UI
    stating that those toggles do not govern the `.mmbak`.
11. The `transmit_offdevice` consent gate in front of the WebDAV push and the Tier C endpoint
    (§6.4.1), and per-invocation push as the default.
12. An allowlisted logger and a crash-reporter scrubber (`02-storage.md` §2.15) — without them the
    migration path's `ATTACH … KEY "x'…'"` ships the live DEK to the crash reporter on any failure.

**Ships off, deliberately:**

- Any sync engine. The schema carries HLC, tombstones, `oplog`, dirty-column writes and convergence
  rules D/O/F; none of it is exercised in v1.
- `<cross-platform-transfer platform="ios">`.
- S3-compatible and SFTP backup destinations.
- Background-scheduled backup as a *promise* (the opportunistic foreground attempt ships; the
  promise does not).
- Encrypting on-device media under the DEK. Platform FBE / Data Protection covers it; the container
  encrypts on the way out. Revisit only with a threat model that includes an attacker who has
  already defeated platform disk encryption.

---

### 6.11 Open questions, honestly labelled

1. **Does `sqlcipher_export` create triggers *after* copying data?** The implementation order says
   yes, and the restore path is self-healing either way (unconditional FTS rebuild + sweep I9), but
   this should be confirmed on a realistic fixture rather than reasoned about.
2. **Do FTS5 shadow tables and `WITHOUT ROWID` tables round-trip through `sqlcipher_export`** at
   3-year sizes? Verify with `quick_check` + row counts + an FTS query comparison. The unconditional
   rebuild makes this a performance question rather than a correctness one, which is why it was
   made unconditional.
3. **What Argon2id parameters keep derivation under ~1.5 s on the oldest supported Android
   midrange** without an ANR? 64 MiB / t=3 / p=1 is the starting point; measure on a 4 GB
   Android-Go-class device relevant to LATAM before locking the default into shipped manifests.
4. **Does an Android `<device-transfer>` actually move `keys/recovery.wrap` and `capture/`** in
   practice, and does the receiving install see them before first launch completes? The whole
   `allowBackup="true"` position in §6.6.1 depends on those files arriving, and §6.6.3 now specifies
   the two-device test rather than leaving it as reasoning. If the answer is no, `allowBackup`
   becomes `"false"` and the `.mmbak` is the only restore path — a real product change, so measure
   before v1, not after.
5. **Does `tursodb --sync-server` authenticate at all**, and can
   `@tursodatabase/sync-react-native` open a locally encrypted database? Both are gates in §6.7.4,
   not assumptions — re-check at the time of the v1.5 decision rather than trusting this document.
6. **What is the wall-clock cost of the A1–A11 verification pass on a 40 MB encrypted DB** on a
   low-end device? If A6 (a `COUNT(*)` per table) and A7 (a `GROUP BY` over `entries`) push the
   backup past a few seconds, they move behind a progress indicator — they do not become optional.
   A10 is one KDF run, so it costs whatever question 3 measures; A11 is a `readdir`.
7. ~~**Play policy and a self-hosted sync target** — deferred to "before shipping sync".~~
   **Answered, and moved forward to v1, in §6.4.1.** The deferral was wrong on its own terms: the
   two features that transmit SMS-derived content to a user-configured endpoint — the WebDAV `PUT`
   and the Tier C escalation — both ship in v1, before sync. The remaining verification is narrow
   and is a Play-console question, not an engineering one: **confirm that a per-invocation,
   consent-gated upload to a user-entered host is disclosable as a user-initiated export rather than
   as a third-party recipient**, and have the declaration's data-flow diagram drawn that way before
   submission. If the answer is unfavourable, the automatic-on-foreground variant is cut and the
   share-sheet destination carries v1 alone.
8. **Does `mmwrap/1` round-trip through `react-native-argon2` 4.0.0 and the platform PBKDF2
   implementations byte-identically on both OSes?** The format is only worth having if a wrap
   written by the JS path unwraps through `MMKeyStore` and vice versa. One fixture, both directions,
   both `kdf_id` values — and it belongs in the same commit as the format, because a format that
   ships with one working reader is a format with one reader forever.
9. **What does a real Android D2D transfer do with a `<cloud-backup>` block that excludes every
   domain?** The deny-all shape in §6.6.1 is the right default, but `<device-transfer>` and
   `<cloud-backup>` are independent element sets and this combination is not one the documentation
   works through. Verify that the transfer includes still take effect. *(inferred — the elements
   are documented as independent, but "documented as" is not "observed to".)*
