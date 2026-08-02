## The storage stack

Everything in this section serves one sentence: **the database file on this phone is the only copy
of the user's financial history that exists.** That makes three things load-bearing that would be
merely nice elsewhere — the key can never become unrecoverable, a write must never be lost because
the screen happened to be locked, and the file must never leave the device by a path nobody chose.

Section numbering: this is §2. The schema is §3, the capture pipeline §4. Table and column names
here are exactly those in §3; where a fact in §3's prose is wrong, it is corrected once, in §2.10,
and marked.

---

### 2.1 The decision, in one table

| Layer | Choice | Version | Why not the alternative |
| --- | --- | --- | --- |
| SQLite binding | `@op-engineering/op-sqlite` with `sqlcipher` + `fts5` | **17.1.3** (published 2026-07-27) | `expo-sqlite` 57.0.1 vendors SQLCipher **3.49.1** vs op-sqlite's 3.51.3, and makes you issue `PRAGMA key` yourself — which hands you the 67-character raw-key footgun and the pragma-ordering hazard that op-sqlite's `sqlite3_key_v2()` call removes. Kept as the named fallback (§2.2). |
| Cipher | SQLCipher 4 (bundled amalgamation, SQLite 3.51.3), **raw-key mode** | n/a | SQLite3MC (ChaCha20-Poly1305, AEAD) is technically nicer but no RN binding ships it; adopting it means forking a binding's native build. |
| Typed query layer | `drizzle-orm` + `drizzle-kit`, migrations as checked-in SQL | **`drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`**, both pinned exactly | Kysely 0.29.4 has no op-sqlite dialect (hand-rolled `Dialect` + introspector + no migration generator), and its one real advantage — a plugin layer where you could intercept int64 — is neutralised because the truncation happens in C++ below any JS plugin. |
| 64-bit integers | **Do not plumb them.** `TEXT` UUIDv7 keys, money as `INTEGER` minor units under a ±2^53−1 `CHECK` | n/a | op-sqlite reads every `SQLITE_INTEGER` through `sqlite3_column_double()` and throws on a `bigint` bind. Drizzle has no `integer({mode:'bigint'})` at all. See §2.5. |
| Key storage | One small native module (`MMKeyStore`), Android Keystore + iOS Keychain, DEK wrapped **twice** | n/a | A Keystore-only DEK makes phone loss permanent loss *even with a valid backup file*. See §2.7. |
| Key accessibility | Android: `setUnlockedDeviceRequired(false)`. iOS: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, **on every item, not only the DEK** | n/a | Any stricter class breaks the 3am screen-locked write, which is the whole point of Android passive capture. See §2.8. The full item inventory is §2.7.4. |
| Recovery wrap (Wrap B) | **Specified normatively in §6.1**, not here | wrap format `mmwrap/1` | Three earlier drafts described three incompatible wraps (D4/D5 vs §2.7 vs §6.1). One file owns the bytes now; §2.7 references it. See §2.7.1. |
| Media | Filesystem, `media_assets` rows hold a **relative** path + sha256 | n/a | BLOBs mean SQLCipher encrypting megabytes per touch and a multi-minute `VACUUM` on a phone (§3.22 already settled this). |

Two non-negotiables that fall out of the above and are easy to skip:

- **`"op-sqlite": { "sqlcipher": true, "fts5": true }`** — `fts5` is not optional. §3.17 creates
  `transactions_fts` with `USING fts5(...)`; without the build flag, migration 0001 fails at
  runtime with `no such module: fts5` on a device that has never had a working database.
- **`android:allowBackup="true"` with explicit `dataExtractionRules`**, not `allowBackup="false"`.
  See §2.9 — `false` also kills device-to-device transfer, which is not cloud and is the only
  free restore path this app gets.

---

### 2.2 What this section depends on: the app-foundation decision

The app-foundation workstream is choosing bare React Native vs Expo. That decision constrains this
one, and in one branch it *blocks* it. Stated as a matrix so nobody has to infer it:

| Foundation choice | Consequence for storage | Action |
| --- | --- | --- |
| **Bare React Native** (RN 0.86.x, New Architecture) | op-sqlite 17.1.3 with `sqlcipher` + `fts5`. This section as written. | None. This is the assumed baseline. |
| **Expo with prebuild / development builds (CNG)** | Identical. op-sqlite is a normal autolinked native module; SQLCipher is a `package.json` config flag, not a config plugin. | None, except the `expo-updates` note below. |
| **Expo Go** | **Blocking.** Expo Go ships a fixed native runtime; neither op-sqlite nor `expo-sqlite`'s SQLCipher variant is available in it. There is no encrypted database, therefore no v1. | The foundation workstream must know this *before* it decides. Expo Go is fine for the first week of UI work and cannot ship. |
| **Expo with `expo-updates`** | op-sqlite and `expo-updates` both vendor a SQLite pod on iOS → duplicate symbols and header conflicts. | Add `"expo.updates.useThirdPartySQLitePod": "true"` to `ios/Podfile.properties.json`. *(verified — op-sqlite installation docs)* |
| **`expo-sqlite` mandated** (fallback) | Works, at a cost: SQLCipher **3.49.1** instead of 3.51.3; enabled via the config plugin `["expo-sqlite", { "useSQLCipher": true }]` + `npx expo prebuild`; and **you must issue `PRAGMA key` yourself immediately after open**, which puts the 67-character raw-key format and the pragma-ordering rule back in application code where they can be got wrong silently. Not available in Expo Go either. | Only if forced. Cost is one adapter implementation (§2.4) plus a Drizzle driver import swap — Drizzle ships `drizzle-orm/expo-sqlite` alongside `drizzle-orm/op-sqlite`. |

`op-sqlite` also documents that some flag combinations fail at pod-install or Android build time,
naming `sqlcipher` + `iosSqlite` explicitly *(verified)*. Two consequences the **sync workstream**
must read:

- **`turso` "switches the backend to Turso SDK kit"** — it is an alternative SQLite source, not a
  companion to `sqlcipher`. Choosing Turso sync means giving up SQLCipher and depending on Turso's
  experimental server-side encryption instead, i.e. an unencrypted local finance database. That is
  a v1.5 decision that this section forecloses for as long as SQLCipher is in.
- **`crsqlite` + `sqlcipher` is unverified.** The docs name only the `iosSqlite` conflict, but
  SQLCipher disables runtime extension loading and cr-sqlite is compiled in statically. Whether the
  CRDT escape hatch actually exists is one afternoon of build spike. *(open — §2.17)*

Everything downstream of the adapter interface in §2.4 is binding-agnostic. Everything in §2.6
(raw-key format), §2.8 (protection classes) and §2.9 (platform backup) applies identically under
either binding, because those are OS and SQLCipher facts, not binding facts.

---

### 2.3 op-sqlite build configuration

```jsonc
// package.json
{
  "dependencies": {
    "@op-engineering/op-sqlite": "17.1.3",   // exact, no caret
    "drizzle-orm": "0.45.2"
  },
  "devDependencies": {
    "drizzle-kit": "0.31.10"                 // NOT 0.45.x — the two packages version independently
  },
  "op-sqlite": {
    "sqlcipher": true,     // -DOP_SQLITE_USE_SQLCIPHER=1 -DSQLITE_HAS_CODEC -DSQLITE_TEMP_STORE=3
                           //   -DSQLITE_EXTRA_INIT=sqlcipher_extra_init
                           //   -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown
    "fts5": true           // REQUIRED by §3.17. Without it migration 0001 dies at runtime.
    // performanceMode: OMITTED. See below.
    // rtree, sqliteVec, tokenizers, turso, crsqlite, iosSqlite: all omitted.
  }
}
```

**`performanceMode` stays off.** It compiles with `-DSQLITE_THREADSAFE=2` (multi-thread: no
per-connection serialisation) while `cpp/bridge.cpp` still opens with `SQLITE_OPEN_FULLMUTEX`,
which that build ignores; and `cpp/OPThreadPool.cpp` hardcodes `numberOfThreads = 1`. Since
op-sqlite exposes both `execute()` (async, on the single pool thread) and `executeSync()` (on the
JS thread) against the *same* `sqlite3*` handle, mixing them under `performanceMode` is
unsynchronised access to one connection. This workload — a few dozen commits a day and a review
inbox — does not need it. *(verified from the 17.1.3 tarball by the storage research pass; no
failure reproduced, so treat as a reason to abstain rather than a known bug.)*

Related discipline, independent of `performanceMode`: **use `execute()`, not `executeSync()`, for
everything on the shared write connection.** `executeSync()` blocks the JS thread and, on a
250 MB encrypted database, a report query will be visible as a dropped frame.

Bundled versions to record in the SBOM, because op-sqlite vendors all three and a CVE in any of
them waits on one maintainer: **SQLite 3.51.3**, **SQLCipher amalgamation at 3.51.3 (`...alt1`)**,
**OpenSSL 3.3.2** (`io.github.ronickg:openssl:3.3.2-1` on Android, the `OpenSSL-Universal` pod on
iOS). Subscribe to OpenSSL and SQLCipher advisories directly rather than waiting for a package bump.

---

### 2.4 The typed query layer, and the one place writes happen

**Drizzle is the schema-and-migration tool, not an abstraction to hide behind.** Concretely:

1. `drizzle-kit generate` emits **SQL files that are checked into the repo**. Those files are the
   migration history. Nothing is generated at runtime. This is what makes the history portable if
   Drizzle 1.0 lands with a changed migration format, or if the project moves off Drizzle entirely.
2. The migration *runner* is hand-rolled (§2.11.3) rather than `drizzle-orm/op-sqlite/migrator`,
   because the runner must wrap the whole batch in the snapshot-and-rollback procedure and
   `migrate()` owns its own transaction. It writes the same `__drizzle_migrations` bookkeeping table
   drizzle uses (`id`, `hash`, `created_at`), keeping §3.2's "`__drizzle_migrations` is the single
   source of truth" true. *(inferred — confirm the exact DDL the op-sqlite driver emits before
   relying on hash compatibility.)* Note this is the one table in the database that is **not**
   `STRICT`, because drizzle creates it.
3. Hot analytics queries and every report use Drizzle's `sql` template or raw `execute()`. The
   relational query API is convenience, not a requirement, and Drizzle 1.0 changed it — another
   reason to pin 0.45.2 exactly and stay off the RC.

**All writes go through one repository function.** This is not style; four separate invariants
depend on it and none of them can be enforced by the database:

- the balance seal (§3.7.1) — the seal row must be the last insert before `COMMIT`;
- **dirty-columns-only writes** (§3.0 rule 8) — no full-row `UPDATE`, ever;
- the `oplog` write (§3.18) — same chokepoint, same transaction;
- the HLC stamp (§3.18) — one monotonic counter per process.

```ts
// The only shape allowed to touch the database.
export interface SqliteAdapter {
  open(opts: { name: string; location?: string; encryptionKey: string; readOnly?: boolean }): Promise<Db>;
  // Db: execute(sql, params) -> Promise<Rows>; executeBatch(); prepareStatement(); close(); interrupt();
}
```

Keeping the adapter thin is what makes the `expo-sqlite` fallback in §2.2 a driver swap rather than
a rewrite. It is *not* an attempt to be database-agnostic — the schema is full of SQLite-specific
`STRICT`, generated columns and partial indexes, and that is correct.

**Transaction handling has one non-obvious rule.** §3.19's triggers use `RAISE(ROLLBACK)`, which
unwinds the entire transaction, not just the statement — that is deliberate (`RAISE(ABORT)` would
leave a half-written ledger committable). The consequence: after a trigger fires, **no transaction
is active**, so a `catch` block that unconditionally issues `ROLLBACK` gets a second, confusing
error. Use hand-rolled `BEGIN IMMEDIATE` / `COMMIT` with a `ROLLBACK` that swallows
`cannot rollback - no transaction is active`, rather than op-sqlite's `transaction()` helper.
`BEGIN IMMEDIATE`, not plain `BEGIN`, so a read-then-write never has to upgrade its lock.

---

### 2.5 64-bit integers: what actually happens, and why the schema's CHECK is the fix

Three verified facts, then the design that makes them irrelevant.

1. **op-sqlite truncates every 64-bit integer to a double on read.** `cpp/bridge.cpp` lines
   249-254 and 569-574 handle `case SQLITE_INTEGER` with
   `double column_value = sqlite3_column_double(statement, i);`, preceded by the literal source
   comment *"Warning this will loose precision because JS can only represent Integers up to 53
   bits"*. Two further read paths (444-449, 736-741) fall `SQLITE_INTEGER` through to
   `SQLITE_FLOAT` and also call `sqlite3_column_double`. There is no flag and no alternate API.
   *(verified from the 17.1.3 tarball.)*
2. **A JS `BigInt` bind throws.** `Scalar` is exactly
   `string | number | boolean | null | ArrayBuffer | ArrayBufferView` — no `bigint`
   *(verified against `src/types.ts` on `main`)* — and `cpp/utils.cpp`'s `to_variant()` has no
   `isBigInt()` branch, falling through to
   `throw std::runtime_error("Cannot convert JSI value to C++ Variant value")`.
3. **Drizzle has no `integer({mode:'bigint'})` for SQLite** in either 0.45.2 or 1.0.0-rc.4. The
   only bigint column is `blob({mode:'bigint'})`, whose write path calls the Node global `Buffer`
   **unguarded** and therefore throws `Buffer is not defined` in Hermes — and which is a BLOB, so
   it gets no numeric ordering, comparison or arithmetic.

**The resolution is the schema's, and it is complete.** §3.0 rule 1 puts
`CHECK (col BETWEEN -9007199254740991 AND 9007199254740991)` on every money column. The mechanism
worth stating explicitly, because it is what makes the lossy read path *lossless in practice*: an
IEEE-754 double represents **every** integer of magnitude ≤ 2^53 exactly, so a value that passed
the CHECK on write round-trips through `sqlite3_column_double()` bit-for-bit. The CHECK is not
belt-and-braces; it is the thing that makes reads correct.

Three residuals the CHECK does not cover, each with its own answer:

- **`BridgeResult.insertId` is declared `double`** in `cpp/types.hpp`. Never read it. §3's `TEXT`
  UUIDv7 primary keys mean the app already knows every id before insert, so this never comes up.
- **`oplog.id` and `transactions_fts_map.rowid`** are the schema's only `INTEGER PRIMARY KEY`
  rowid aliases and carry no CHECK. `oplog` is capped at 200k rows / 90 days by retention (§3.18)
  and `transactions_fts_map` tracks transaction count; neither approaches 2^53 in any lifetime.
  Both are local-only and never synced, so a hypothetical rollover is not a data-integrity issue.
- **The BigInt boundary is one function.** All intermediate arithmetic (`amount_minor × rate_num`,
  which reaches ~1e20) happens in JS `BigInt` per §3.0 rule 9. Converting back to `number` before a
  bind happens at exactly one chokepoint, and that chokepoint asserts `Number.isSafeInteger(v)` and
  throws otherwise. A `BigInt` that escapes to a bind throws in C++ anyway — noisy, but with a
  useless message.

Add a schema lint that greps the Drizzle schema for `mode: 'bigint'` and fails the build. This is
the mistake a well-meaning future contributor makes while "fixing the money precision problem".

---

### 2.6 Encryption at rest: SQLCipher in raw-key mode

#### 2.6.1 The 67-character string, and the footgun

op-sqlite calls `sqlite3_key_v2(db, "main", key.data(), key.size())` immediately after
`sqlite3_open_v2` and before any statement runs, with a source comment explaining that this avoids
the SQL-injection shape of `PRAGMA key = '...'`. So the classic "key must come first" ordering bug
is already handled for you. *(verified — `cpp/bridge.cpp:110-128`.)*

Because the raw-key parsing lives in the codec (`sqlcipher_cipher_ctx_key_derive`), not in the
PRAGMA parser, it works through `sqlite3_key_v2` — which is exactly how op-sqlite passes
`encryptionKey`. Read directly from the bundled amalgamation (~line 111184): `blob_format`
requires a leading `x'`, a trailing `'`, even-length hex contents, and then
`if (blob_format && c_ctx->pass_sz == raw_key_sz + 3)` where `raw_key_sz = key_sz * 2 = 64`. So:

```
key string = "x'" + <exactly 64 lowercase hex chars> + "'"   →  exactly 67 characters
```

Hit it and SQLCipher logs *"using raw key only"* and does a `cipher_hex2bin`. Miss it — 66 or 68
characters, 63 hex digits, a stray space — and SQLCipher **silently falls through** to deriving a
key by running **256,000 iterations of PBKDF2-HMAC-SHA512 over the literal string `x'...'`**. No
error is raised. A database created under the wrong-length string is encrypted with a *different*
key and can never be opened with the correct one. **This bug fails open, not closed, and there is
no cloud copy to restore from.**

Three mitigations, all mandatory:

```ts
const RAW_KEY = /^x'[0-9a-f]{64}'$/;

export function assertRawKey(raw: string): string {
  // NORMALISE, do not reject, on case: SQLCipher's blob_format accepts [0-9a-fA-F] and
  // cipher_hex2bin decodes both cases identically, so rejecting uppercase would fail to open
  // a perfectly valid database if the native side ever emits it. Fail closed only on shape.
  const k = raw.toLowerCase();
  if (k.length !== 67 || !RAW_KEY.test(k)) {
    throw new Error(`SQLCipher key malformed: length=${k.length}`);   // NEVER log k
  }
  return k;
}
```

1. `assertRawKey()` at the **single** choke point that constructs the key, plus a unit test
   asserting the string is exactly 67 characters.
2. **First-install self-test**, run once before any real data exists: create a throwaway
   `selftest.db` with the key, write a sentinel row, `close()`, reopen, read it back, `delete()`.
   This proves the whole key path end to end while the stakes are zero.
3. **Every open runs a key proof.** `sqlite3_key_v2` does not validate — a wrong key succeeds and
   the *first statement* fails with `SQLITE_NOTADB` ("file is not a database"). The proof must work
   on a fresh install too, so it is **`SELECT count(*) FROM sqlite_master`** — `0` on a newly keyed
   empty file, `N` on an existing one, `SQLITE_NOTADB` on a wrong key. Do **not** use
   `SELECT value FROM meta …` as the proof: on first launch `meta` does not exist yet and the
   `no such table` error would be misread as a key failure. (A `meta` read is still worth keeping as
   a *post-migration* assertion.)
4. **A failed key proof is a KEY problem, not a CORRUPTION problem** — see §2.7.5. The two are
   indistinguishable at the SQLCipher layer, and telling the user their database is corrupt when the
   correct action is "enter your recovery phrase" converts a recoverable state into perceived total
   loss.

#### 2.6.2 What raw-key mode buys

SQLCipher 4 defaults: AES-256-CBC, 4096-byte pages, per-page HMAC-SHA512, and **256,000
PBKDF2-HMAC-SHA512 iterations** (~512,000 SHA-512 operations) on *every* `open()`. That is hundreds
of milliseconds on a mid-range Android, paid on every cold start. Raw-key mode turns it into a
`memcpy`. This is the single biggest performance decision in the encryption design, and it is why
holding a passphrase-derived key would be unacceptable even before the recovery-wrap argument.

Zetetic and the SQLCipher README cite *"as little as 5-15% overhead for encryption on many
operations"* for the ongoing cost; page-level AES-256-CBC + HMAC is cheap on ARMv8 with crypto
extensions. There is also a small on-disk overhead: SQLCipher reserves per-page space for the IV
and the page HMAC (visible as the *reserved bytes per page* field at header offset 20), so a
4096-byte page carries somewhat less than 4096 bytes of payload. *(inferred — measure the exact
reserve on a real file rather than assuming a number.)*

Two knobs deliberately left alone: `PRAGMA cipher_memory_security` is off by default for
performance — leave it off, the threat model here does not include an attacker scraping process
memory on a locked-bootloader phone; and `cipher_page_size` is tunable 512-65536 for a claimed
5-30% on some query patterns but must be re-applied on **every** open, which is exactly the class
of silent-mismatch footgun this section is trying to eliminate.

#### 2.6.3 The pragma-ordering guard (an addition to §3.1)

§3.1's order — `auto_vacuum` first, then `journal_mode = WAL` — is correct **only because raw-key
mode requires zero cipher pragmas.** That is a load-bearing coincidence, so write the rule down
before someone breaks it:

> `kdf_iter`, `cipher_use_hmac`, `cipher_page_size` and `cipher_plaintext_header_size` must be
> issued **immediately after the key and before the first database operation.** Issued later they
> silently have no effect. `PRAGMA journal_mode = WAL` **is** a database operation. So if any cipher
> pragma is ever added, it goes after the key and **before** `journal_mode = WAL`, and
> `auto_vacuum` moves with it.

Corollary for the export path (§2.13): the same rule applies to an `ATTACH`ed database — any
`PRAGMA bk.cipher_*` goes immediately after the `ATTACH ... KEY` and before
`SELECT sqlcipher_export('bk')`.

And a note on WAL specifically: in WAL mode SQLCipher encrypts the WAL page data with the database
key, so `-wal` and `-shm` are **not** a plaintext leak. They are, however, still files that must be
excluded from platform backup (§2.9) and checkpointed before export (§2.13).

---

### 2.7 Key management: the two-wrap envelope

#### 2.7.1 The shape

```
DEK  = 32 random bytes (CSPRNG), generated once at first launch, never changes in normal operation
       ↓ rendered as "x'" + hex + "'"  →  SQLCipher raw key  →  the database file

Wrap A (daily):    AES-256-GCM under a non-exportable Android Keystore / iOS Keychain key
                   → silent open at app launch, no user interaction

Wrap B (recovery): the `mmwrap/1` self-describing file specified in §6.1.2, at exactly
                   <appdir>/keys/recovery.wrap
                   → shipped INSIDE every .mmbak, and included in Android <device-transfer>
```

> **§6.1 is normative for Wrap B; this section is not.** Earlier drafts of this design specified
> the recovery wrap three mutually incompatible ways — D4/D5 (Argon2id + AES-GCM over a 160-bit
> code via `react-native-argon2`), an earlier §2.7 (PBKDF2-HMAC-SHA512 + AES-GCM over a 32-char
> Crockford base32 code, native), and §6.1 (Argon2id + XChaCha20-Poly1305 over a 15-word BIP39
> phrase, libsodium) — with two different file paths and two different secrets. Two engineers
> building from two sections would each produce a file the other's recovery flow cannot open, and
> nobody would find out until a phone died. Resolution:
>
> - **The secret is the 15-word BIP39 phrase** (§6.1.1). It has a checksum, round-trips through a
>   password manager, and the re-entry verification in onboarding is built for it.
> - **The wrap file format is `mmwrap/1`** (§6.1.2), self-describing: it carries its own KDF id,
>   parameters, salt, nonce and AEAD id, so nothing outside the file is needed to unwrap it. That
>   property is what makes §2.7.5 and the Android `<device-transfer>` restore possible at all — in
>   both, `meta` is unreadable and there is no manifest.
> - **The path is `<appdir>/keys/recovery.wrap`**, one exported constant (§2.9.1). The
>   `recovery/dek.wrap` spelling that appeared in earlier §2.7.5 and §2.9 text is dead; if you find
>   it anywhere, it is a bug.
> - **The KDF is a registered `kdf_id` byte**, not a section-level opinion. `kdf_id = 0x01` is
>   PBKDF2-HMAC-SHA512 (available from both platforms' system crypto with no JS dependency);
>   `kdf_id = 0x02` is Argon2id. v1 ships `0x02` as the default because §6.1's rotation and backup
>   paths already run in JS; `0x01` stays registered so `MMKeyStore` can be made self-sufficient
>   later without orphaning a single existing wrap. Both readers ship from v1.
>
> `01-decisions.md` D4/D5 and D99 need the same reconciliation and are not this section's to edit —
> see "Rejected findings (storage-sync)", item X1, for the exact change requested.

**Wrap B is mandatory, and this is the argument.** Android Keystore keys are non-extractable by
design. iOS Keychain items marked `...ThisDeviceOnly` are wrapped with the Secure Enclave UID key
and never migrate — that is the entire point of the suffix. Apple documents that the iCloud Backup
copy of the keychain *"can be restored only to the same device from which it originated."* So if
the DEK exists only in Wrap A, a diligent user who exports backups every week and then drops their
phone in a river has **an undecryptable blob and total loss of their financial history** — the
single worst failure mode available to this app, made worse by the fact that they believed they
were protected. Wrap B is also the *only* mechanism by which Android → iPhone migration is possible
at all.

Two consequences, one pleasant and one that has been mis-sold:

- Restore on a new device = enter the recovery phrase → unwrap the DEK → **rewrap under the new
  device's Keystore/Keychain** → open. Wrap A is regenerated, not migrated.
- Changing the recovery phrase **rewraps 32 bytes** rather than `PRAGMA rekey`-ing every page of an
  encrypted multi-hundred-megabyte file. That is genuinely cheap — **and it is not a remediation
  for a phrase that was seen by someone else.** The DEK is unchanged, and every previously written
  `.mmbak` still contains a `recovery.wrap` that the *old* phrase opens, which yields the *same*
  DEK, which opens the live `ledger.db` and every copy of it (a `<device-transfer>` payload, a
  leftover `snapshots/pre_N.db`, an `adb backup`). An old phrase plus any one old container is a
  permanent skeleton key. §6.1.4 therefore splits rotation into two flows — **rewrap** (forgotten
  phrase / hygiene) and **full DEK rotation** (phrase disclosed) — and only the second one closes
  the exposure. Do not describe rewrap-not-rekey as an unqualified win anywhere in the UI.

#### 2.7.2 Do the wrapping in native code, not JS

Recommendation: one small native module, `MMKeyStore`, with six methods —
`provision()`, `getDatabaseKey(): string`, `wrapForRecovery(phrase): Uint8Array`,
`unwrapFromRecovery(phrase, blob): void`, `deriveSubkey(context: string): Uint8Array`, and
`rotateDek(): void` (§6.1.4). Everything else stays inside Kotlin/Swift.

`deriveSubkey()` exists so that **the DEK is the only root secret in the system**. Every other
key the app needs that is not a user credential is `HKDF-SHA256(DEK, info = <context>)` — today
that is exactly one caller, the spool sealed-box keypair (`info = "mm/spool-x25519/v1"`, §2.8.1) —
so those keys inherit both wraps for free and cannot be lost independently of the database. Adding
a *second* independently-stored secret to this app is a design change requiring its own recovery
story, not an implementation detail; §2.7 is where that argument lives and §2.15's risk table
records the consequence of getting it wrong.

`MMKeyStore` is also **the only writer of `<appdir>/keys/recovery.wrap`**, and it opens that path
for writing on exactly two code paths: first provisioning, and the §6.1.4 rotation flows. No other
call site may create, truncate or replace it — see the provisioning guard in §2.7.5.

This avoids adding `react-native-quick-crypto` (1.1.6, which pulls in `react-native-nitro-modules`),
`react-native-libsodium` (1.7.0 — and note it does **not** expose `crypto_pwhash`/Argon2id on
native, sumo/web only) and `react-native-argon2` (4.0.0) to the dependency tree purely to wrap
32 bytes. The platform already ships everything needed: Android
`SecretKeyFactory.getInstance("PBKDF2WithHmacSHA512")` + `Cipher.getInstance("AES/GCM/NoPadding")`,
iOS `CCKeyDerivationPBKDF` + `CryptoKit.AES.GCM`. The project is already committing to native
module work (LiteRT-LM, the notification listener, the spool), so the setup cost is paid once.

If the team prefers a JS dependency over a fourth native module, `react-native-quick-crypto@1.1.6`
(MIT, Nitro, audited May 2026) covers `randomBytes`, PBKDF2 and AES-GCM in one package. Name that
as the fallback, not the default.

**On the KDF — the argument, not the decision.** The decision is §6.1.2's `kdf_id` register; what
follows is why both entries exist. The recovery secret is **app-generated and 160 bits** (§6.1.1's
15-word BIP39 phrase). Against a uniformly random 160-bit secret KDF hardness is very nearly
irrelevant — there is no dictionary to run — so PBKDF2-HMAC-SHA512 at 210,000 iterations (the OWASP
floor for SHA-512) is cryptographically sufficient *and* is the only KDF both platforms ship from
system crypto with no JS dependency, which is why it is registered as `kdf_id = 0x01` and why
`MMKeyStore` implements it. Argon2id (`kdf_id = 0x02`, the v1 default) is the better choice the
moment a human-chosen passphrase is in scope, and §6.1.3 gates that option behind a measured
entropy floor rather than a warning. The one thing that must not happen is a section picking a KDF
by prose: **the wrap file states its own `kdf_id`, and the reader honours it.**

`unwrapFromRecovery()` must therefore dispatch on the byte in the file, must reject an unknown
`kdf_id` with a message naming the app version that can read it, and must never assume the
in-database `meta.recovery_salt_hex` or a `.mmbak` manifest is available — both are absent on the
two paths that need it most (§2.7.5, `<device-transfer>`).

#### 2.7.3 Android Keystore, exactly

```kotlin
KeyGenParameterSpec.Builder("mm_dek_wrap_v1",
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
    .setKeySize(256)
    .setRandomizedEncryptionRequired(true)
    // ── The two lines that decide whether 3am capture works. Both default to false;
    //    they are written out so nobody "hardens" them later without reading §2.8.
    .setUserAuthenticationRequired(false)
    .setUnlockedDeviceRequired(false)      // NEVER true. See §2.8.1.
    .build()
```

The GCM ciphertext + 12-byte IV go into ordinary `SharedPreferences`. **Do not use
`androidx.security:security-crypto` / `EncryptedSharedPreferences`** — it was deprecated at
1.1.0-alpha07 in April 2025 over main-thread StrictMode violations and keyset-corruption crashes on
specific OEMs, and the official direction is DataStore + Tink. For a single wrapped 32-byte DEK it
buys nothing over a Keystore key plus plain prefs, and it adds a deprecated dependency.

StrongBox (`setIsStrongBoxBacked(true)`) is optional and must be wrapped in a `try/catch` for
`StrongBoxUnavailableException` with a TEE fallback. It buys little here — the threat is offline
file extraction, which TEE-backed keys already defeat — and OEM StrongBox implementations have a
history of bugs. Default to TEE.

#### 2.7.4 iOS Keychain, exactly — and why three sources disagree

Use **`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`**. The two halves of that constant do two
different jobs and both are required:

- **`AfterFirstUnlock`, not `WhenUnlocked`.** The item must be readable from the first unlock after
  boot so that the background drain, a `BGContinuedProcessingTask`, and any post-reboot work can
  open the database. `WhenUnlocked` breaks all of them, and the failure signature is nasty: the
  drain silently fails only when the screen happens to be locked, which is exactly the case nobody
  tests. (One research pass recommended `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; that is wrong for this
  app.)
- **`...ThisDeviceOnly`.** This is what excludes the item from encrypted device backups and from
  device migration. Note that iCloud **Keychain sync** is controlled separately by
  `kSecAttrSynchronizable` (default `false`) — so the two properties are not redundant, and the
  suffix is what actually keeps the DEK from travelling inside a backup. (Another research pass
  recommended plain `kSecAttrAccessibleAfterFirstUnlock`; that lets the DEK ride along in an
  encrypted backup, which is a constraint-#1 violation.)

Via `expo-secure-store@57.0.1`, this must be passed explicitly — **the default is `WHEN_UNLOCKED`,
which is wrong on both counts**:

```ts
await SecureStore.setItemAsync('mm.dek.v1', wrappedDekB64, {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
});
```

`expo-secure-store` is preferred over `react-native-keychain` on maintenance grounds:
react-native-keychain's latest release is **10.0.0, 2025-03-23** — roughly 17 months with no
publish — while expo-secure-store ships on the Expo SDK cadence (57.0.1). A 44-character base64
wrapped DEK is far under expo-secure-store's ~2048-byte value limit. Abstract key storage behind a
two-method interface either way; swapping is a day.

**The `ThisDeviceOnly` decision is what makes Wrap B mandatory rather than optional.** Say that
sentence in the onboarding copy, in `CLAUDE.md`, and in the ADR, because someone will eventually
propose dropping the recovery phrase to shorten onboarding.

##### The item inventory — every secret, with its class

The accessibility argument above was written for the DEK and then applied to nothing else, while
the app in fact creates several Keychain/Keystore items. An item written with
`SecureStore.setItemAsync(k, v)` and no options takes the `WHEN_UNLOCKED` default, which is wrong
on **both** axes: it fails a foreground read while the screen is locked (the opportunistic backup
in §6.4 fires exactly there, and returns `errSecInteractionNotAllowed` −25308 surfaced as a generic
failure), and it is not `ThisDeviceOnly`, so it is eligible for iCloud Keychain sync and for an
encrypted Finder/iTunes backup. For `backup_kek` that second failure is the whole ballgame: the key
that opens every `.mmbak` under the current phrase generation would leave the device while the
`.mmbak` files themselves sit in the user's Nextcloud folder.

This table is normative and is the thing CI iterates. Adding a row is the only sanctioned way to
create a new item.

| Item key | What it is | iOS class | `kSecAttrSynchronizable` | Android |
| --- | --- | --- | --- | --- |
| `mm.dek.v1` | Wrap A — the DEK under a platform key | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | `false` | Keystore `mm_dek_wrap_v1` (§2.7.3) + ciphertext/IV in plain `SharedPreferences` |
| `mm.backup.kek.v1` | `backup_kek` = KDF(recovery phrase, salt) — cached so backups need no prompt (§6.2.1) | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | `false` | Keystore-wrapped blob, same spec as the DEK wrap |
| `mm.webdav.cred.v1` | WebDAV base URL + basic-auth credential (§6.4) | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | `false` | Keystore-wrapped blob |
| `mm.llm.endpoint.v1` | Optional self-hosted inference base URL + token | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | `false` | Keystore-wrapped blob |
| *(none — derived)* | Spool sealed-box X25519 secret | — | — | `HKDF-SHA256(DEK, "mm/spool-x25519/v1")`, never stored (§2.8.1) |

Rules that fall out of it:

- **Every** `SecureStore.setItemAsync` call passes `keychainAccessible` explicitly. Add an ESLint
  rule (or a grep gate) that fails the build on a call without it; the default is wrong and the
  failure is invisible.
- Gate **G-10** in §7.3 stops reading one item back. It iterates this table, calls
  `SecItemCopyMatching` with `kSecReturnAttributes` for each, and asserts both `kSecAttrAccessible`
  is the `AfterFirstUnlockThisDeviceOnly` constant and `kSecAttrSynchronizable` is `false`. Gate
  **G-11** does the Android mirror over every Keystore alias, not just the DEK-wrapping one.
- A read that fails with `errSecInteractionNotAllowed` is **never** reported as "destination
  unreachable" or "backup failed". It is its own error state, because the remedy (unlock the phone)
  has nothing to do with the remedy for the others.
- `<appdir>/keys/recovery.wrap` is deliberately **not** in this table. It is a plain file, and that
  is the entire reason phone loss is survivable (§2.7.1). Do not "harden" it into the Keychain.

#### 2.7.5 When Wrap A fails but the database is fine

This branch is missing from most designs and it is the one that turns a recoverable state into a
support ticket that reads *"the app deleted my finances"*. Wrap A can fail on a device that still
has a perfectly good database file:

- **Android**: `KeyPermanentlyInvalidatedException`, or Keystore corruption / keyset loss after an
  OS update or an OEM migration — documented failure modes, not hypotheticals.
- **iOS**: the Keychain item is simply *absent* after a restore that did not carry it, which is the
  designed behaviour of `...ThisDeviceOnly`. A device-transfer or a new-phone setup lands the
  database and media but never the DEK.
- Either platform: the app is reinstalled while the data directory survives, or the user restores a
  `<device-transfer>` payload.

**At the SQLCipher layer all of these are indistinguishable from a corrupt file** — both surface as
`SQLITE_NOTADB` on the first statement. So the routing rule has to be explicit, and it has to test
the restore marker **first**, because a half-written restore is the one case where the recovery-code
flow is the wrong answer:

> On `MMKeyStore.getDatabaseKey()` throwing, **or** the §2.6.1 key proof failing:
>
> 1. **If `<appdir>/restore/in_progress.json` exists** → the previous run died mid-restore. Route
>    to the **restore-resume branch** (§6.5.4). Never the recovery-code flow, never a corruption
>    message: the live database is a partial artifact under a key that may not have been persisted,
>    and the correct action is to discard it and resume from the container.
> 2. **Else if the Wrap B file is present** → the **recovery-phrase flow**.
> 3. **Else** → the database is genuinely unrecoverable, and the message names the missing artifact
>    (`keys/recovery.wrap` and any `.mmbak` the user can point at) rather than blaming the file.
>
> None of the three branches is a corruption message, a "reset app data" button, or a silent
> re-provision.

Recovery-phrase flow: prompt for the phrase → read `kdf_id`, parameters and salt **from the wrap
file itself** (§6.1.2 — `meta` is unreadable here by definition, and there is no manifest on the
`<device-transfer>` path) → unwrap the DEK → **rewrap under a freshly generated Keystore/Keychain
key** → retry the open. The Wrap B blob lives in three places, deliberately: the app's own
`<appdir>/keys/recovery.wrap`, every `.mmbak`, and the Android `<device-transfer>` payload.

##### The provisioning guard, in full

**`provision()` must be idempotent and must refuse to overwrite — and the thing it must not
overwrite is not only the database.** The earlier guard, `!databaseFileExists() || wrapAPresent()`,
covers re-keying an existing database and nothing else. It permits two states it must not:

```ts
// MMKeyStore.provision() — refuses unless the device is genuinely blank, and is itself
// crash-safe, because it has exactly the same write-ordering hazard restore does.
function provision(): void {
  if (restoreMarkerExists())  throw new NeedsRestoreResume();    // → §6.5.4, resume the restore
  if (databaseFileExists())   throw new NeedsRecovery();         // → recovery-phrase flow

  if (recoveryWrapExists()) {
    // A wrap with no database is one of two very different things, and discarding the wrong one
    // is unrecoverable. The sidecar is what tells them apart.
    if (!provisioningMarkerExists()) throw new FoundKeysWithoutData();  // partial device transfer
    unlinkRecoveryWrap();            // orphan from OUR own crashed first run — safe to discard
  }

  writeAndFsync(PROVISIONING_MARKER);      // keys/.provisioning
  const dek = csprng(32);
  writeAndFsync(RECOVERY_WRAP, wrapB(dek));      // Wrap B first, fsync file AND keys/ dir
  writeWrapA(dek);                               // then Wrap A
  createDatabase(dek);                           // only now does a keyed file exist
  unlink(PROVISIONING_MARKER);                   // last, after the database opens and proves
}
```

**Why the `keys/.provisioning` sidecar is not optional.** Without it, a crash between the Wrap B
write and the database creation — on a **fresh install**, where there is no restore marker and no
backup to restore from — leaves a wrap with no database, and the `FoundKeysWithoutData` branch parks
the user on "we found recovery material but no data → restore from a backup?" **permanently, on
first launch, with nothing to restore.** That is the same class of dead end §6.5's reordering just
removed from the restore path, reintroduced on the path every single user takes. The sidecar
distinguishes an orphan *we* created from an orphan a partial `<device-transfer>` delivered, and
only the first may ever be discarded. If the screen also offers an explicit "start fresh", it
deletes the orphan wrap only after confirming no database file exists anywhere in the container.

- **Database present, Wrap A missing** — generating a new DEK and silently re-keying is the single
  action that makes the data permanently unreadable. Route to recovery.
- **Wrap file present, database absent, no `.provisioning` marker** — this is a partial
  `<device-transfer>` (the `file` domain landed, the `database` domain did not) or an interrupted
  restore. Minting a fresh DEK here writes a *new* `keys/recovery.wrap` over the transferred one,
  destroying the only key that could open a database recovered later from the old device. Route to
  a distinct "we found recovery material but no data" screen that offers restore.
- **Wrap file present, database absent, `.provisioning` marker present** — our own first run
  crashed. Discard the orphan wrap and provision normally; the DEK it wraps keys nothing.
- **Restore marker present** — §6.5.4, always.
- Ordering inside `provision()` is itself load-bearing: **both wraps are written and fsynced before
  the first byte of the database exists.** A DEK that keys a file on disk and lives nowhere else is
  the failure §6.5's reordering exists to prevent, and first provisioning has the same shape.

---

### 2.8 The locked-device write path

This is the part of the storage design that is genuinely load-bearing and most often got wrong.

#### 2.8.1 Android: the 3am trap is mostly not real, and the fix is one line

The fear: a bank notification arrives at 03:00, the phone is locked, the Keystore key or the
credential-encrypted storage is unavailable, the write fails, the transaction is lost forever.

**It does not happen, for two independent reasons.**

1. **`setUnlockedDeviceRequired` and `setUserAuthenticationRequired` both default to `false`.** A
   plain Keystore AES key is usable whenever your process runs — screen locked included. The only
   way to create the 3am problem is to opt into it. §2.7.3 writes both lines out explicitly so that
   a later "security hardening" pass has to read this section before flipping them.
2. **Credential-encrypted (CE) storage unlocks at the *first* unlock after boot and stays unlocked
   until reboot.** Locking the screen again does not re-lock CE. A phone unlocked at 9pm has fully
   available CE storage and a fully usable Keystore key at 3am.

The genuinely dead window is narrow: **rebooted (OTA, battery died) and not yet unlocked.** And in
that window there is nothing to capture, because the same
`MATCH_DIRECT_BOOT_AUTO` default that gates a non-`directBootAware` `NotificationListenerService`
gates every **sender** too — a bank app that is not direct-boot-aware cannot have its components
resolved or its process started while the user is locked, so it cannot post a notification at all.
FCM reinforces this: receiving pushes in direct boot requires both `firebase-messaging-directboot`
+ `android:directBootAware="true"` on the app side **and** `"direct_boot_ok": true` set by the
sender; consumer banking apps do neither. SMS is delayed rather than lost (telephony holds
pre-unlock messages), so READ_SMS backfill covers it.

**Therefore: do not build the CE/DE split, the device-protected database, or a direct-boot-aware
capture stub.** §3.22 already records this as a closed decision, and §3.14's
`capture_gaps.cause = 'boot_before_unlock'` is the product-visible statement: *"transactions that
arrive between a reboot and the first unlock are not captured passively; SMS-sourced ones are
recovered on the next scan."* The bar for reopening it is a device experiment showing a real bank
notification arriving pre-first-unlock.

**Resolving an internal contradiction in §3.** §3.10's prose puts the Android spool at
`createDeviceProtectedStorageContext().getFilesDir()/spool/` (device-protected, DE) while §3.22's
table rejects "CE/DE split with a device-protected spool". Those cannot both stand. **The spool
lives in credential-protected storage: `context.getFilesDir()/spool/`. Do not call
`createDeviceProtectedStorageContext()`.**

The reason is stronger than "we rejected the split", and it is specific to §4.4.1's design: **the
spool record is a libsodium sealed box, and the X25519 secret that opens it is reachable only after
first unlock.** So a DE-placed spool file cannot be *drained* until after first unlock regardless.
DE placement therefore extends **zero** capability — it does not widen the capture window (the
listener is not bound, and no sender can post), and it does not widen the drain window. All it does
is downgrade the protection class on the most sensitive bytes in the app, from *encrypted under the
user's credential* to *encrypted under a device-bound key the OS can use before anyone has
authenticated*. One storage context, the stronger class, no lost coverage.

##### The spool secret is derived from the DEK, not stored beside it

The earlier text said the sealed box's private key "lives in the credential-protected keystore",
which is both unimplementable and a second unrecoverable secret. Unimplementable because
`crypto_box_seal_open()` takes the raw 32-byte X25519 scalar as an argument and an Android Keystore
key is non-extractable by construction — it can only be *used* through `KeyAgreement`, never handed
to libsodium. And a second unrecoverable secret because this design spends §2.7.1, §6.1 and R1
arguing that a Keystore-only key is the worst failure available for the DEK, and then created
exactly that for the capture inbox: no Wrap B, no recovery path, and a stated mitigation
("quarantined records are retained forever… the private key may be recoverable") that describes no
mechanism by which recovery ever occurs. An OS update that invalidates the Keystore keyset — the
documented failure §2.7.5 exists for — would recover the whole database and lose a weekend of bank
notifications with no `capture_gaps` row, because the design classifies them as decryptable-later
rather than gone.

**Therefore the spool keypair is derived, not stored:**

```
spool_sk = HKDF-SHA256(ikm = DEK, info = "mm/spool-x25519/v1", len = 32)   // clamped per X25519
spool_pk = crypto_scalarmult_base(spool_sk)      // baked into the producer at provision time
```

`MMKeyStore.deriveSubkey("mm/spool-x25519/v1")` (§2.7.2) is the only caller. Consequences:

- There is exactly **one** root secret in the app, and it already carries two wraps. A restore, a
  device transfer or a Keystore invalidation that recovers the DEK recovers the spool with it.
- The producer needs only `spool_pk`, which is public. It is written once at provision time to
  `<appdir>/capture/spool_pk.v1` (the same Kotlin-readable mirror directory as §4.4's allowlist
  mirror), so `onNotificationPosted` never touches a key store and never touches SQLite.
- The CE-gating argument above now rests on where the **DEK's Wrap A** lives, which is the
  credential-protected Keystore — same conclusion, correct mechanism.
- **Counterpart change required in `04-capture.md` §4.4.1**: replace "the private key lives in the
  credential-protected keystore" with this derivation, delete the sentence "the private key may be
  recoverable even when the file currently is not" (it is the only thing making permanent loss read
  as temporary), and make a record that fails `openSealed()` open a `capture_gaps` row bracketed by
  the file's mtime rather than only incrementing a quarantine counter. The `capture_gaps.cause`
  value that needs adding in `03-schema.md` §3.14 is `'spool_unreadable'`.

**What the Android write path therefore is, end to end:**

```
NotificationListenerService.onNotificationPosted   [MAIN THREAD — do almost nothing here]
  → copy every needed extra out of Notification.extras into an immutable Kotlin data class
    (a Bundle is parcel-backed; it must never cross a thread boundary or outlive the callback)
  → post() that object to the service's single dedicated HandlerThread and RETURN
        ⋯ on the spool thread, serialised so file order still matches arrival order ⋯
  → ingest filter (§4.4 allowlist mirror; §3.10.1 semantics) evaluated BEFORE anything is written
  → sealed-box record under spool_pk (§2.8.1) → context.getFilesDir()/spool/tmp/<uuidv7>.part
  → fd.sync()  →  rename() into spool/inbox/  →  fsync() the inbox DIRECTORY descriptor
        ⋯ later, app foreground / ACTION_USER_UNLOCKED / WorkManager probe ⋯
  → JS drain (§4.4.2) → SQLCipher INSERT into raw_captures
```

Three properties of that diagram are load-bearing and are easy to drop during implementation:

- **Nothing expensive runs on the callback thread.** `onNotificationPosted` and
  `onListenerConnected` are dispatched on the service's main Looper — the same thread React Native
  renders on when the app is foregrounded. Two SHA-256s, an X25519 sealed box, a `System.loadLibrary`
  for libsodium and a file write on that thread, multiplied by the 50–200 notifications
  `getActiveNotifications()` returns on reconnect, is a multi-second freeze and then an ANR whose
  offered remedy is *force-stop* — which is precisely the undetectable dead state the watchdog
  exists to prevent.
- **`rename()` is atomic for the directory entry and says nothing about the data.** f2fs is the
  default filesystem on most modern Android devices and offers no replace-via-rename writeback
  guarantee; a present-but-truncated manifest is a state the naive sequence permits. The `fd.sync()`
  before the rename and the directory `fsync()` after it are what make the manifest's arrival a real
  commit marker. The cost lands on the spool thread, never on the callback thread, and is accepted
  because the spool file is the *only* copy of a capture between arrival and drain.
- **The app's own package is rejected before the allowlist test**, so the liveness probe and the
  "N items waiting" notification are never spooled back into the pipeline.

The listener never opens SQLite. That is not only a protection-class decision: **op-sqlite cannot
be called from native code at all.** Its entire Android Kotlin surface is three files, ~157 lines,
exposing only `install()`, `getDylibPath()` and `moveAssetsDatabase()`; everything else is a
`jsi::HostObject` reachable only from a JS runtime *(verified)*. The two alternatives are worse:
a second SQLCipher stack in Kotlin (`net.zetetic:sqlcipher-android:4.17.0`) means owning byte-level
cipher-config parity across two independently-versioned SQLCipher builds forever, with a mismatch
surfacing as the useless error *"file is not a database"*; and a headless JS task per notification
spins the JS bundle — hundreds of milliseconds and tens of megabytes — inside a process the system
is already keeping resident, to do work the model is not loaded for anyway.

#### 2.8.2 iOS: the database never leaves the app container

**Never put the database in the App Group container.** With SQLCipher + WAL this is a
**deterministic `0xdead10cc` termination on every backgrounding** — not an edge case. Signal built
a reproduction repo (`signalapp/SQLCipherVsSharedData`) showing it on all iOS versions and all
device models; the unencrypted case does not exhibit it, because an encrypted database holds the
file lock continuously rather than only during write transactions. The documented mitigations
(async open, read-only connections, dropping locks on backgrounding, `beginBackgroundTask`) are
described by practitioners as *"surprisingly difficult"* to get right, and this app is encrypted by
requirement.

So: **the `.db` lives in the app's own container and is physically unreachable from a second
process.** The Share Extension and the App Intent write sealed spool records into the App Group
container; the main app drains them (§4.4). One drain implementation serves both platforms.

This also means `cipher_plaintext_header_size` — which Zetetic notes exists *"primarily... for use
on iOS when a WAL mode database will be stored in a shared container"* — is never needed, so the
salt stays in the file header and the raw key stays at the simple 64-hex form rather than the
96-hex key+salt form.

**File protection classes, and the failure signature when they mismatch:**

| Artifact | Class | Why |
| --- | --- | --- |
| `<db>`, `<db>-wal`, `<db>-shm` | `NSFileProtectionCompleteUntilFirstUserAuthentication` | The app container default — but **assert it explicitly** rather than relying on the default. |
| App Group `staging/inbox/*` | `NSFileProtectionCompleteUntilFirstUserAuthentication` | Written explicitly via `Data.write(options: .completeFileProtectionUntilFirstUserAuthentication)`. A share initiated from the Lock Screen fails under `.complete`. |
| media root | same | Thumbnail rendering and OCR re-runs happen in background tasks. |
| Keychain DEK item | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | Must **match** the file class. |

**Never `NSFileProtectionComplete` on the database or its sidecars** — it makes them unreadable
whenever the screen is locked, producing intermittent, unreproducible failures.

The mismatch to watch for, stated so it is recognisable in a bug report: a database at
`CompleteUntilFirstUserAuthentication` paired with a Keychain item at `WhenUnlocked` fails the
background drain with a Keychain `errSecInteractionNotAllowed` (−25308) that surfaces as "could not
open database" — the file was fine, the key was not. Add a startup assertion that the retrieved
Keychain item's `kSecAttrAccessible` is an `AfterFirstUnlock*` variant, and fail loudly if it is not.

iOS has no passive capture (locked constraint #3), so nothing legitimately needs to write before
first unlock. The iOS locked-device requirement is purely *after first unlock, screen locked*, which
`CompleteUntilFirstUserAuthentication` + `AfterFirstUnlockThisDeviceOnly` satisfies exactly.

#### 2.8.3 The gap that is real, and where it is recorded

| Window | Android | iOS |
| --- | --- | --- |
| Screen locked, already unlocked once since boot | **Writes work.** CE unlocked, Keystore key usable. | **Writes work.** `AfterFirstUnlock` + `CompleteUntilFirstUserAuthentication`. |
| Boot → first unlock | **No capture possible** — senders are gated too. `capture_gaps.cause = 'boot_before_unlock'`; backfilled from `content://sms` when READ_SMS is granted. | No passive capture exists in any window. |
| Process killed by LMK / OEM killer | Recovered by `BIND_AUTO_CREATE`; spool files survive. | n/a |
| Spool written, app never opened | Bounded by `CFG.spool.maxBytes` for text records and `maxItems` for media-bearing ones (§4.4.1). Nothing is lost **while the device survives** — the drain is idempotent via `ux_raw_captures_dedupe`. See the caveat below; this row used to read "nothing is lost" unqualified and that was wrong. | same |

**The caveat: an undrained spool record exists in no backup and in no restore path.** The `.mmbak`
container is manifest + `ledger.db` + `recovery.wrap` + media (§6.2.1); `<device-transfer>` carries
database, media, keys and the capture mirror; `<cloud-backup>` carries nothing. The spool is
correctly kept out of the cloud and incorrectly kept out of *recovery*. A phone destroyed on Sunday
after a Saturday of spooling restores Friday's backup and loses Saturday silently, because those
captures were never `raw_captures` rows and so were never in anything. Three consequences, all
specified in §6:

- the drain's insert half runs opportunistically, not foreground-only (§6.4), so the window between
  spooling and durability is minutes rather than days;
- a backup runs the drain first, so it never captures a database that is stale relative to the spool
  sitting next to it (§6.4, assertion **A11**);
- undrained spool records are named on the restore-complete screen's "cannot recover" list, and the
  `capture_gaps` row is driven by the spool state recorded at the last backup rather than by a fixed
  step (§6.5.2).

---

### 2.9 Where the files live, and platform backup interaction

**`android:allowBackup` defaults to `true` and Auto Backup includes `getDatabasePath()` by
default.** Shipped unchanged, this app uploads the transaction database to the user's Google Drive
on day one — a violation of constraint #1 with no build error and no runtime symptom. It is also
useless: the file is SQLCipher ciphertext that would restore onto a phone whose Keystore lacks
Wrap A. And it would blow the **25 MB per-app Auto Backup quota** within months (§2.12), after
which the system calls `onQuotaExceeded()` and stops backing up entirely — so the user also sees
backup failures.

**Keep `allowBackup="true"` and exclude by rule.** Setting it `false` also kills device-to-device
transfer, which is direct and never touches a Google server, is therefore constraint-compliant, and
is a real restore path.

> **One owner for the rules file.** Two earlier drafts each contained a full
> `<data-extraction-rules>` block — this section's and §6.6.1's — and they disagreed on where the
> recovery wrap lives (`recovery/dek.wrap` vs `keys/`), on which directories are excluded from
> cloud backup, and on the `sharedpref` filename. An `<include>` whose path matches nothing is
> silently accepted by Android, so the drifted copy would have shipped a device transfer that
> carries the database and not the key that opens it. **§6.6.1 now owns the single XML block.**
> This section owns the *paths it references*, below, and nothing else.

#### 2.9.1 The path constants — one module, exported, referenced everywhere

Every path in the rules XML, in the iOS exclusion list, in `MMKeyStore`, and in the CI gates comes
from one TypeScript module with a Kotlin/Swift mirror generated from it at build time. This is not
tidiness: a string literal that appears twice is the defect class this section exists to prevent.

```ts
// src/storage/paths.ts — the only place any of these strings is written.
export const APP_SUBDIR   = 'mm';                    // iOS: Library/Application Support/mm/
export const DB_DIR       = 'db';                    // ledger.db, -wal, -shm
export const DB_NAME      = 'ledger.db';
export const MEDIA_DIR    = 'media';                 // receipt originals + thumbnails
export const KEYS_DIR     = 'keys';                  // recovery.wrap  ← Wrap B, §6.1.2
export const RECOVERY_WRAP = `${KEYS_DIR}/recovery.wrap`;
export const PROVISIONING_MARKER = `${KEYS_DIR}/.provisioning`;   // §2.7.5 crash sidecar
export const SPOOL_DIR    = 'spool';                 // tmp/ inbox/ quarantine/, §4.4.1
export const CAPTURE_DIR  = 'capture';               // Kotlin↔SQLite mirror: senders.v1.json,
                                                     //   spool_pk.v1, heartbeat.log  (§4.4)
export const EXPORT_DIR   = 'export';                // staging/ and failed/, §6.3
export const SNAPSHOT_DIR = 'snapshots';             // pre_<head>.db, §6.8.2
export const RESTORE_DIR  = 'restore';               // extraction target + in_progress.json, §6.5
```

Android domain mapping, which is the half that silently fails when it drifts:

| Constant | Android location | Backup `domain` | Cloud backup | `<device-transfer>` |
| --- | --- | --- | --- | --- |
| `DB_DIR/DB_NAME` | `getDatabasePath()` | `database` | **excluded** | **included** |
| `MEDIA_DIR` | `getFilesDir()` | `file` | **excluded** | **included** |
| `KEYS_DIR` | `getFilesDir()` | `file` | **excluded** | **included** — D2D restores nothing without it |
| `CAPTURE_DIR` | `getFilesDir()` | `file` | **excluded** | **included** — a restored phone that lacks the allowlist mirror captures nothing, silently (§4.4) |
| `SPOOL_DIR` | `getFilesDir()` — **credential-protected, per §2.8.1** | `file` | **excluded** | excluded (device-local sealed records) |
| `EXPORT_DIR`, `SNAPSHOT_DIR`, `RESTORE_DIR` | `getFilesDir()` | `file` | **excluded** | excluded |
| expo-secure-store prefs | `getSharedPreferences()` | `sharedpref` | **excluded** | excluded |

Two entries in that table were wrong in earlier drafts and are worth naming so they are not
reintroduced:

- **`SPOOL_DIR` is `getFilesDir()`, not `createDeviceProtectedStorageContext().getFilesDir()`.**
  §2.8.1 settles this. The stale device-protected spelling still appears in `03-schema.md` §3.10 and
  `07-platforms-risks.md` §7.1.3 and must be struck there — it is not merely a weaker protection
  class, it also changes the backup domain from `file` to `device_file`, so
  `<exclude domain="file" path="spool/">` would match nothing and the sealed bank-notification
  bodies would go to Google Drive.
- **The `sharedpref` filename is read from the library, never guessed.** Two drafts named two
  different files (`mm_keys.xml`, `secure_store.xml`) and neither was checked against
  `expo-secure-store` 57.0.1's actual Android preferences file. The deny-all shape in §6.6.1 makes
  the literal non-load-bearing, but the constant must still be resolved from the library source and
  asserted by the gate. *(unverified — one grep of the installed package settles it.)*

**The trap that produces a silent leak with no build error: the `domain` must match where the file
actually is.** op-sqlite exports `ANDROID_DATABASE_PATH` (the `getDatabasePath()` directory →
`domain="database"`), `ANDROID_FILES_PATH` (`getFilesDir()` → `domain="file"`) and
`ANDROID_EXTERNAL_FILES_PATH`; `location` is optional in `open()` and the fallback is chosen in C++
*(the databases directory — confirm before relying on it)*. A mismatch between the chosen directory
and the `domain` in the rule silently stops the exclusion from matching, with no error anywhere.
**Therefore: always pass `location` explicitly in the open call, from §2.9.1's constant, and pin the
`domain` to match, in the same commit.** Do not reach for `getNoBackupFilesDir()` as a shortcut — it
is excluded from `<device-transfer>` too, so it throws away the one platform backup path worth
having.

**The second trap, which is the reason §6.6.1's block is deny-all: exclusion lists are
allowlist-by-omission.** Everything not excluded is uploaded, so every directory the app grows later
— `restore/` after the first restore, `snapshots/` during every migration window, `export/failed/`
which §6.3 keeps *forever* because it is evidence — leaks by default, with no build error, no
runtime symptom and no diff to review. `snapshots/pre_N.db` is the worst of them: a complete
`sqlcipher_export` of the ledger **keyed with the live DEK**, sitting next to `keys/recovery.wrap`
in the same upload. §6.6.1 therefore excludes every domain at the root and re-includes nothing.

**iOS:** op-sqlite's default is `IOS_LIBRARY_PATH` (`Library/`), which iCloud backs up (only
`Caches/` and `tmp/` are excluded by default). Set `NSURLIsExcludedFromBackupKey = true` — and set
it on the **containing directory, not the file**. SQLite creates `-wal` and `-shm` itself at open,
so a flag on the `.db` alone misses them and the sidecars — which contain committed transaction
data — go to iCloud. The full directory list is §6.6.2's, and it is every constant in §2.9.1: `db/`,
`media/`, `keys/`, `capture/`, `spool/`, `export/`, `snapshots/`, `restore/`.

**CI checks, in the same commit that creates the manifest** (the gate names are §7.3's):

- **G-7** greps the merged manifest (`app/build/outputs/logs/manifest-merger-*.txt`) for
  `allowBackup="true"` **without** a `dataExtractionRules` attribute, and for any
  `allowBackup="false"`;
- G-7 also asserts the **shape** of `data_extraction_rules.xml` rather than enumerating expected
  excludes: every backup domain appears exactly once under `<cloud-backup>` as
  `<exclude … path="."/>`, and `<cloud-backup>` contains no `<include>` at all. Enumerating excludes
  is what lets a new directory escape;
- a gate asserting every `<device-transfer>` `path` string is `===` a §2.9.1 constant, and that the
  set of `<device-transfer>` includes is a subset of the `<cloud-backup>` excludes;
- a runtime test that enumerates every directory the app creates during a scripted first-run +
  backup + migration + restore, and fails if any is not covered by the deny-all;
- a device/simulator test asserting `NSURLIsExcludedFromBackupKey` is set on **all eight**
  directories after first launch;
- **G-10 / G-11** iterate §2.7.4's item inventory rather than checking the DEK alone.

---

### 2.10 WAL configuration

#### 2.10.1 The per-connection / persistent split

> **⚠ Disagreement with §3.1.** §3.1's connection-open checklist states that
> *"`auto_vacuum`, `journal_mode` and `journal_size_limit` are persisted in the file"* —
> **`journal_size_limit` is not persisted.** The SQLite database header has no field for it (nor for
> `wal_autocheckpoint`): the 100-byte header carries page size, write/read format version (which is
> where WAL mode lives, offsets 18-19), auto-vacuum (offset 52) and incremental-vacuum mode
> (offset 64), `user_version` (offset 60) and `application_id` — and nothing else relevant.
> `journal_size_limit` and `wal_autocheckpoint` are per-connection Pager settings and **must be
> re-issued on every `open()`**. Left as-is, migration 0001's connection is the only one that ever
> has a size limit, and every subsequent app launch runs with the default of *no limit* — a WAL
> that a single long-lived read transaction can grow without bound on a device where storage
> pressure is the user's problem. *(verified against sqlite.org/pragma.html and
> sqlite.org/fileformat2.html.)*

Corrected table — this is the authoritative version:

| Pragma | Persisted in the file? | Where it is issued |
| --- | --- | --- |
| `auto_vacuum` | **Yes** (header offsets 52 + 64) | Migration 0001, statement one, before any DDL. Irreversible. |
| `journal_mode = WAL` | **Yes** (header offsets 18-19) | Migration 0001, after `auto_vacuum`. |
| `user_version` | **Yes** (header offset 60) | Same transaction as the final migration; read only for the backup manifest and the downgrade guard (§3.2). |
| `journal_size_limit` | **No** | **Every connection open.** |
| `wal_autocheckpoint` | **No** | Every connection open (or leave at the default 1000 pages). |
| `foreign_keys` | **No** | Every connection open. Off by default; every FK in §3 is inert without it. |
| `busy_timeout` | **No** | Every connection open. |
| `synchronous` | **No** | Every connection open. §3.1 chose `FULL`; keep it. |
| `temp_store` | **No** | Every connection open, though op-sqlite's `-DSQLITE_TEMP_STORE=3` under `sqlcipher` already forces memory unconditionally — which also closes Zetetic's plaintext-temp-file leak on both platforms. |

**The connection-open sequence, in full:**

```ts
const db = open({
  name: DB_NAME,                        // 'ledger.db' — §2.9.1, the same constant the backup,
                                        // restore and rules-XML paths are built from
  location: dbLocation(),               // ANDROID_DATABASE_PATH, or the pinned iOS dir
  encryptionKey: assertRawKey(await MMKeyStore.getDatabaseKey()),
});

// KEY PROOF — sqlite_master, NOT meta. §2.6.1 states this and an earlier draft of this very
// code block contradicted it: on a fresh install `meta` does not exist until migration 0001,
// and the `no such table` error would be misread as a bad key and routed to recovery.
await db.execute(`SELECT count(*) FROM sqlite_master`);
await db.execute(`PRAGMA foreign_keys = ON`);
await db.execute(`PRAGMA busy_timeout = 5000`);
await db.execute(`PRAGMA synchronous = FULL`);
await db.execute(`PRAGMA journal_size_limit = 8388608`);   // 8 MiB — NOT persisted, re-issue
await db.execute(`PRAGMA wal_autocheckpoint = 1000`);      // default; stated for clarity
```

**`foreign_keys` is a connection-level setting, and three procedures turn it off.** The backup
export (§6.2.3), the migration batch (§2.11.3 / §6.8.2) and the restore re-key (§6.5) all issue
`PRAGMA foreign_keys = OFF` outside any transaction — correctly, since the pragma is a no-op inside
one — on the single long-lived write connection every subsequent write in the process uses. Each of
them must restore it **in a `finally`, on every exit path including a thrown `SQLITE_FULL`**, or the
process runs the rest of its life with every `ON DELETE RESTRICT` in §3 inert; the next account
archive then succeeds and orphans thousands of `entries` rows, and nothing notices until the next
startup sweep. Two defences, both cheap:

- the repository reads back `PRAGMA foreign_keys` before every write batch and refuses to proceed
  if it is `0` — this is the one that actually catches a leaked window;
- the backup export runs on a **dedicated second connection** opened for that purpose (§6.2.3), so
  the live connection's FK state is never touched at all. The per-connection pragma list above
  applies to that connection identically.

#### 2.10.2 Checkpointing and connections

`wal_autocheckpoint` defaults to 1000 pages ≈ 4 MB at SQLCipher's 4096-byte page size; a passive
checkpoint runs automatically at that threshold. `journal_size_limit = 8388608` then truncates the
WAL back to 8 MiB after any checkpoint or WAL reset, which bounds the case where a long-running
read transaction (a full-history report, or the startup integrity sweep of §3.21) holds a snapshot
open while writes accumulate.

- **On app background: `PRAGMA wal_checkpoint(PASSIVE)`.** Do **not** close the database. Holding
  an open file handle while suspended is only a problem for files in a *shared* container
  (`0xdead10cc`, §2.8.2), and the database is deliberately not there. Closing and reopening churns
  the WAL for no benefit — raw-key mode already made reopening cheap, but it is not free.
- **Before any export or file copy: `PRAGMA wal_checkpoint(TRUNCATE)`.** Skip this and the `-wal`
  sidecar holds committed data the copied main file lacks. This applies to `sqlcipher_export` too
  (§2.13), not just to naive file copies.
- **One write connection for the process lifetime**, opened once, all writes serialised through the
  repository (§2.4). `busy_timeout = 5000` is a backstop, not a strategy.
- **No read replica in v1.** WAL makes readers non-blocking, so a second read-only connection
  (op-sqlite supports `readOnly: true` for SQLCipher) would only help if long analytics scans
  measurably queue behind the drain. If one is added later it needs its own `encryptionKey` and its
  own `foreign_keys` / `busy_timeout` / `journal_size_limit` pragmas — the per-connection column
  above applies to it identically.
- `db.interrupt()` is the cancel primitive for a long drain or an FX re-derivation run; wire it to
  app-background and to an explicit user cancel.

---

### 2.11 Vacuum, free pages, and migrations

#### 2.11.1 `auto_vacuum = INCREMENTAL` is a day-one, irreversible decision

SQLite, verbatim: *"Auto-vacuuming must be turned on before any tables are created. It is not
possible to enable or disable auto-vacuum after a table has been created."* Switching
`full` ↔ `incremental` is allowed at any time; changing to or from `none` requires a full `VACUUM`,
which on an encrypted multi-hundred-megabyte file on a phone means rewriting the whole thing. §3.1
correctly makes it statement one of migration 0001.

`incremental_vacuum(N)` is then called from the periodic maintenance job (§3.21), with `N` capped
so it stays off the critical path. It matters here specifically because this schema has three
recurring bulk-delete paths: retention purges on `raw_captures` (which NULL large `payload_text`
values), media original deletion (`media_assets.original_deleted_at`), and `oplog` truncation. All
three free pages that would otherwise stay allocated forever.

#### 2.11.2 The restore bug nobody has written down yet

**`sqlcipher_export()` does not copy `auto_vacuum`.** Zetetic documents that it does not copy
`user_version`, and §3.2 handles that; the `auto_vacuum` half is the one that gets missed. A backup
produced by `sqlcipher_export` and then restored is a database with `auto_vacuum = NONE` — and
because auto-vacuum cannot be enabled after tables exist, **every restored database permanently
loses incremental vacuum** and can only ever reclaim space via a full `VACUUM`.

The fix is one statement, and it works because the attached database is empty at that moment:

```sql
PRAGMA wal_checkpoint(TRUNCATE);
ATTACH DATABASE :path AS bk KEY "x'<64 hex of the recovery-derived key>'";
PRAGMA bk.auto_vacuum = INCREMENTAL;      -- ← MUST precede sqlcipher_export, which creates tables
SELECT sqlcipher_export('bk');
PRAGMA bk.user_version = :n;              -- sqlcipher_export does not copy this either
DETACH DATABASE bk;
```

Note the key is interpolated into the `ATTACH` statement rather than bound — SQLCipher's `KEY`
clause with a bind parameter is not something to rely on. **That interpolation is safe only because
`assertRawKey()` has already proved the string is 67 characters of `x'[0-9a-f]{64}'`.** Apply the
assert on this path too; it is the same choke point (§2.6.1) doing double duty as injection defence.

**`assertRawKey()` answers injection and not disclosure, and disclosure is the live risk here.**
Every `ATTACH … KEY "x'…'"` statement in this design is a string containing a key in cleartext:
§2.11.2's uses the **DEK**, §6.8.2 step 5's snapshot uses the **DEK**, §6.2.3's uses a per-backup
key. Any wrapper that logs a failing statement — a Drizzle query logger left on, a
`catch (e) { log.error('sql failed', { sql, e }) }`, a crash-reporter breadcrumb that records DB
operations — ships that key to the self-hosted GlitchTip instance, indexed and searchable next to
the install id. So every `ATTACH` call site is wrapped:

```ts
async function attachKeyed(db: Db, alias: string, path: string, rawKey: string): Promise<void> {
  const stmt = `ATTACH DATABASE '${path}' AS ${alias} KEY "${assertRawKey(rawKey)}"`;
  try { await db.execute(stmt); }
  catch (e) { throw new Error(`ATTACH ${alias} failed: ${redactKeys(String(e))}`); }
  // the original error object is discarded here ON PURPOSE — it may embed the statement.
}
```

`redactKeys()` is the scrubber from §2.15, and this is the one call site where dropping the original
error is worth the debuggability it costs.

#### 2.11.3 The migration procedure for an encrypted database

Users skip versions; that is the normal case, not an exception. The runner is forward-only and
strictly sequential — never `if (version < 5) { do the big one }`.

1. `open()` with the key; prove it with `SELECT count(*) FROM sqlite_master` (§2.6.1).
2. **Downgrade guard**: if `PRAGMA user_version > MAX_KNOWN`, `PRAGMA query_only = ON` and tell the
   user to update the app. Never migrate backwards, never crash.
3. `PRAGMA foreign_keys = OFF` — **outside any transaction, and inside a `try`.** SQLite documents
   this pragma as *"a no-op within a transaction"*; wrapping it in the migration transaction
   silently leaves FK enforcement on during a table rebuild, which is a real and very confusing
   trap. Steps 3–10 are the `try`; **step 11 is the `finally`.**
4. `sqlcipher_export` a pre-migration snapshot under the **same** DEK (not the recovery key).
5. `BEGIN IMMEDIATE`.
6. Apply migrations *n+1 … N* in sequence, writing `__drizzle_migrations` rows as you go.
7. `PRAGMA user_version = N` — same transaction.
8. `PRAGMA foreign_key_check` — abort on any returned row.
9. `COMMIT`.
10. `PRAGMA quick_check`; delete the snapshot **only after it passes** (see the rollback rule).
11. **`finally`: `PRAGMA foreign_keys = ON`, then read it back and assert it is `1`.** Not on the
    success path — on *every* path, including a `SQLITE_FULL` thrown out of step 4 and a
    constraint failure in step 6. A leaked FK-off window on the process-lifetime write connection
    makes every `ON DELETE RESTRICT` in §3 inert until the app is killed, and §3's RESTRICTs are
    what D50 calls "the undo and restore mechanism". Also run `PRAGMA foreign_key_check` on the
    **live** database here, not only on a copy.

**Rollback is an ordered sequence, not "replace the file".** "Close the connection and replace the
database file with the snapshot" is neither atomic nor WAL-aware, and both halves bite:

- the live database is in WAL mode, and a `-wal`/`-shm` pair left by a process that was **killed**
  rather than cleanly closed will be replayed against whatever main file is sitting there. SQLite
  recovers a WAL by frame checksum and **does not verify that the WAL belongs to that main
  database** — so frames written against the half-migrated file get replayed onto the pre-migration
  snapshot. Best case `quick_check` reports corruption; worse case it recovers cleanly into a
  mixed-generation database that passes `quick_check` and has silently wrong pages;
- a plain copy-over is not atomic, so a kill during the replacement leaves a truncated file with the
  snapshot possibly already consumed, and per §6.4 the last verified off-device backup may be days
  old.

So, in exactly this order: **close the connection → `unlink()` `<db>-wal` and `<db>-shm` →
`rename()` the snapshot over the live path** (atomic on APFS / ext4 / f2fs, the same primitive the
spool relies on) **→ reopen → `PRAGMA quick_check` → only now delete nothing.** The snapshot is not
removed until the reopened database has passed `quick_check` *and* its `__drizzle_migrations` head
equals the pre-migration value, so an interrupted rollback is simply retried rather than being a
third failure state. Never `copy`, and never leave sidecars next to a substituted main file.

SQLite DDL is transactional, but `PRAGMA journal_mode = WAL` and `VACUUM` cannot run inside a
transaction and the 12-step table-rebuild pattern leaks around FK state — **the snapshot is the belt
that actually holds.** Migration 0001's pragma block therefore runs outside any transaction. The
crash-recovery comparison table, including the row for a kill *during the rollback*, is §6.8.3.

§3.0 rule 7 (additive-only migrations) is what keeps this cheap: new nullable columns and new
tables only, with the stated `STORED` generated-column exception. Given that harvesting training
data means columns get added constantly (§3.11), this is the right constraint.

#### 2.11.4 When a full `VACUUM` is ever allowed

Never automatically. `VACUUM` on an encrypted 200 MB file rewrites every page and is a multi-minute
stall with no progress affordance and no safe interruption point. Offer it only as an explicit,
user-initiated *"Compact database"* action in a maintenance screen, on charger, with a progress
indicator and a warning, and only when `PRAGMA freelist_count * page_size` exceeds a meaningful
fraction of the file. `incremental_vacuum(N)` covers the routine case.

---

### 2.12 Database size: the budget, the drivers, the levers

Two profiles, at three years. Row-size estimates are computed from §3's actual column lists (TEXT
UUIDv7 = 36 bytes each, hex hashes = 64 bytes) plus index entries; treat them as ±40%, not as
measurements. *(inferred — replace with numbers from a synthetic-fixture generator before relying
on them.)*

**Profile H — Android, heavy: 8 transactions/day, 2 banks with notification + SMS overlap
(~20 raw captures/day), 400 receipt photos/year.**

| Table | Rows @ 3 y | Est. size incl. indexes |
| --- | ---: | ---: |
| `oplog` | 200,000 (capped) | **~36 MB** |
| `raw_captures` | ~22,000 | ~25 MB |
| `extraction_runs` | ~26,000 | ~25 MB |
| `extracted_fields` | ~180,000 | ~18 MB |
| `transaction_events` | ~35,000 | ~12 MB |
| `entries` | ~26,000 | ~11 MB |
| `transactions` | ~8,800 | ~8 MB |
| `observations` | ~22,000 | ~7 MB |
| `line_items` | ~21,000 | ~5 MB |
| `transactions_fts` | — | ~5 MB |
| everything else (`corrections`, `fx_rates`, `merchants`, `budgets`, seeds) | — | ~8 MB |
| **Database total** | | **~160 MB** |
| **Media on disk** (1,200 receipts @ ~280 KB after downscale) | | **~340 MB** |

**Profile L — iOS, light: 3 transactions/day, no passive capture, 100 receipts/year.** Roughly
25 MB database, 85 MB media.

Four conclusions:

1. **Media dominates, roughly 2:1 over the database.** §3.10 already put it on the filesystem;
   the drain downscales to 1600 px long edge at JPEG q0.7 (~200-350 KB from a 2-4 MB HEIC), which
   is a ~10× reduction and a far bigger lever than any storage-layout choice. Keep it.
2. **`oplog` is the single largest table and it is not user data.** §3.18's default (90 days or
   200k rows, whichever is larger) is doing real work. It serves three purposes with three
   different natural retentions — future sync payload, undo stack, and a second view of the
   training harvest — so the policy must stay explicit and user-visible, not emergent.
3. **The 25 MB Android Auto Backup quota is exceeded within the first year even by Profile L.**
   That is a second, independent reason for the §2.9 exclusion rules: without them the user gets
   `onQuotaExceeded()` and *all* Auto Backup silently stops, including for whatever else they might
   have wanted backed up.
4. **`training_opt_in = 1` is an unbounded-growth switch, and the schema does not bound it.**
   §3.10 sets `purge_after = NULL` for opted-in captures — purge-exempt forever — which pins
   `raw_captures.payload_text` and `extraction_runs.raw_output`, the two largest *text* growth
   drivers, in place permanently. **The size lever for opted-in users has to be something other
   than `purge_after`:** an explicit *"export training corpus and prune"* action that writes the
   encrypted JSONL archive to the user's chosen destination and only then runs the standard purge
   (§3.10's two-statement form, including
   `UPDATE corrections SET training_eligible = 0`). This is a storage problem that the consent
   design created and did not solve; it needs a UI surface, not just a policy row.

**Free-space handling.** Check available bytes before a drain that will write media and before any
export. On low space: stop accepting new spool records (the Share Extension already shows
*"N unprocessed items"*), surface the *"free up space"* action that deletes originals while
retaining thumbnails and extracted data (`media_assets.original_deleted_at`), and run
`incremental_vacuum`. **Never** silently drop a capture to save space — that is the one behaviour
the sole-system-of-record constraint forbids.

---

### 2.13 Export and backup: the storage-layer mechanics

The full backup/sync design belongs to another section; these four points are storage's
responsibility and are easy to get wrong.

1. **Use `sqlcipher_export()`, not `VACUUM INTO`, not a file copy.** It is present in the bundled
   amalgamation (10 references), duplicates schema, triggers, virtual tables and all data into a new
   internally-consistent file in one statement with no plaintext intermediate and nothing streamed
   through Hermes, and — critically — the destination can be keyed with a **different** key, which
   is exactly what the recovery-passphrase-derived backup key needs. Whether `VACUUM INTO` produces
   an encrypted destination on a SQLCipher connection is unconfirmed; do not assume it does.
2. **`PRAGMA wal_checkpoint(TRUNCATE)` first**, always (§2.10.2).
3. **Set `auto_vacuum` and `user_version` on the target explicitly** (§2.11.2). Neither is copied.
4. **The export artifact must bundle the `.db` *and* the media directory**, or the restore is
   silently incomplete — a correctness requirement, not a nicety, since there is no cloud copy.
   `media_assets.sha256_hex` is what lets a restore detect that it is incomplete rather than
   discovering it months later.

Two verification items before shipping the export path:

- **FTS5 round-trip.** §3.17 uses a **contentless** FTS5 table (`content = ''`). Zetetic claims
  `sqlcipher_export` copies virtual tables, but contentless FTS5 tables **cannot** be repaired with
  `INSERT INTO transactions_fts(transactions_fts) VALUES('rebuild')` — rebuild requires a content
  table. So if the shadow tables do not round-trip, search is broken on every restored database
  with no SQL-level recovery. The app-level fallback (re-index from `transactions.merchant_raw`,
  `transactions.note` and `entries.memo`, which are all still present) must exist and be tested, or
  §3.17 should switch to external-content FTS5. Verify empirically on a realistic fixture with
  `PRAGMA integrity_check`, row counts, and an actual FTS query.
- **Storing images encrypted.** On-device, receipt images sit in plaintext under platform FBE /
  Data Protection, which is the right call — encrypting them under the DEK costs CPU on every
  thumbnail render and buys protection only against an attacker who has already defeated platform
  disk encryption. **But the export container is different**: an exported media directory is
  plaintext receipts sitting next to an encrypted `.db`, in a Nextcloud folder. The export must
  encrypt media inside the container (keys derived from the backup key), or the backup artifact is
  only as protected as its weakest member.

---

### 2.14 Startup sequence, end to end

```
 0. restore marker check                 → <appdir>/restore/in_progress.json present?
        └─ yes ───────────────────────────────────────────────────► RESTORE-RESUME  (§6.5.4)
                                                                     before ANY key work
 1. MMKeyStore.getDatabaseKey()          → Keystore/Keychain unwrap of the DEK  (Wrap A)
        └─ throws ────────────────────────────────────────────────► §2.7.5 ROUTING RULE
 2. assertRawKey()                       → lowercase, 67 chars, /^x'[0-9a-f]{64}'$/, else fail loud
 3. op-sqlite open({ name, location, encryptionKey })   → sqlite3_key_v2 internally
 4. SELECT count(*) FROM sqlite_master   → KEY PROOF. 0 = fresh, N = existing.
        └─ SQLITE_NOTADB ─────────────────────────────────────────► §2.7.5 ROUTING RULE
                                                                     NEVER a corruption message
 5. per-connection pragmas               → foreign_keys, busy_timeout, synchronous,
                                            journal_size_limit, wal_autocheckpoint     (§2.10.1)
 6. downgrade guard                      → user_version > MAX_KNOWN ⇒ PRAGMA query_only = ON,
                                            tell the user to update the app
 7. migration crash recovery + migrations → §6.8.3 comparison table, then snapshot →
                                            BEGIN IMMEDIATE → apply → check → COMMIT
 8. post-migration assertions            → SELECT value FROM meta WHERE key='install_id';
                                            assert meta.allow_hard_delete = 'no'      (see below)
 9. capture-health reconciliation        → listener grant + heartbeat staleness       (§4.4)
10. drain spool/inbox                    → idempotent via ux_raw_captures_dedupe      (§4.4.2)
11. startup integrity sweep (async, off the critical path)                            (§3.21)
12. render                               → the timeline does not wait for steps 9-11
```

Step 4 deliberately queries `sqlite_master` rather than `meta`: on a fresh install `meta` does not
exist until step 7, and a `no such table` error there would be misdiagnosed as a bad key.

**Step 0 is new and it is not defensive programming.** Without it, a restore interrupted after the
live database was created but before its wraps were persisted lands in step 1, `getDatabaseKey()`
throws, and the old routing rule sent the user to the recovery-phrase flow — which either finds no
wrap for that DEK or finds the wrap of a *different, older* DEK, and then `provision()` refuses to
generate a new one because a database file exists. The app is permanently wedged and the only escape
is deleting app data, which the user reads as "the restore destroyed my backup". §6.5's reordering
makes that window small; step 0 makes it survivable.

**Step 8's `allow_hard_delete` assertion.** `meta.allow_hard_delete` is an in-band kill switch for
five append-only triggers, including the one protecting `consent_grants` — the table whose entire
purpose is to make a consent claim provable. D51 calls turning it on "a reviewed operation, never
application code", but §6.8.4's Trap A requires the migration runner to set it to `'yes'` mid-
procedure, and a kill between the rebuild and the reset leaves it on forever with no visible symptom.
So startup asserts it is `'no'`, force-resets it if not, and writes an `integrity_findings` row so
the occurrence is recorded rather than silently corrected. **Counterpart change in `03-schema.md`
§3.21**: add this as a numbered sweep check (03 owns the `I` numbering) and add its id to the
`integrity_findings.check_id` CHECK — which §5.9 already flags as needing to be opened up.

Step 6 uses `PRAGMA query_only = ON` rather than reopening with `readOnly: true` — opening a WAL
database read-only requires a writable `-shm`, which is an avoidable wrinkle when all you need is
to stop writes.

Steps 9 and 10 must never block step 11. Forty queued notifications after a weekend land as
`raw_captures` rows in bulk; extraction commits per-capture and the timeline shows
*"N still processing"*.

---

### 2.15 Logging and crash reporting: the field allowlist

No section of this design specified a logging policy, and two of them build SQL strings with a
cleartext key in them by design (§2.11.2, §6.2.3, §6.8.2 step 5). Meanwhile the programme commits to
self-hosted GlitchTip crash reporting, D18 justifies UUIDv7 keys partly because they are "readable
in logs", and the app holds bank SMS bodies, merchant names and amounts in memory throughout the
extraction path. `assertRawKey()` carries a `// NEVER log k` comment, which shows the authors were
thinking about this in exactly one place. This section is the other places.

**Allowlist, not denylist, at the logger.** A structured logger that accepts arbitrary objects will
eventually be handed one containing `payload_text`, because a developer chasing a parse failure will
put it there. So the logger's field set is closed:

| Loggable | Never loggable |
| --- | --- |
| ids (`txn_id`, `capture_id`, `backup_id`, `run_id`), enum states, counts, durations, byte sizes, error *classes*, migration numbers, sweep check ids | `payload_text`, `payload_meta_json`, `raw_output`, `value_json`, `merchant_raw`, `note`, `memo`, any `*_amount_minor`, `*_rate_num`/`_den`, `amount_text_raw`, `rate_text`, media paths, any `x'…'` string, any recovery phrase word, any Keychain value |

**A scrubber runs at both boundaries** — inside the logger and again in the crash reporter's
`beforeSend`, because the second one catches what never went through the first (an unhandled
exception's message, a breadcrumb, a native stack). Minimum patterns:

```ts
const SCRUB: Array<[RegExp, string]> = [
  [/x'[0-9a-fA-F]{64}'/g,            "x'<redacted-64>'"],   // any raw SQLCipher key, incl. in SQL
  [/\bKEY\s+"[^"]*"/gi,              'KEY "<redacted>"'],   // the whole ATTACH clause
  [/[0-9a-fA-F]{64}/g,               '<hex64>'],            // bare hex keys and sha256 hexes
  [/\b\d[\d.,\s]{2,}\b/g,            '<num>'],              // amounts inside a message body
];
export const redactKeys = (s: string) => SCRUB.reduce((a, [re, to]) => a.replace(re, to), s);
```

**Crash-reporter configuration is part of the policy, not deployment trivia:** `sendDefaultPii:
false`; DB, HTTP and console breadcrumbs disabled (a DB breadcrumb is how the `ATTACH` statement
reaches the server in the first place); no `extra` context populated from any capture or ledger
object; release-build source maps uploaded so the stack is readable without the payload being.

**Gates**, added to §7.3 alongside the existing schema-conformance checks: a grep gate that fails on
`console.*` or a direct logger call in `src/capture/`, `src/extraction/`, `src/repository/`,
`src/backup/` and `src/keystore/`; and a unit test asserting `redactKeys()` reduces a real
`ATTACH … KEY "x'<64 hex>'"` statement and a real bank SMS body to strings containing neither the
key nor the amount. §2.16's residual-risk table already accepts that the DEK transits Hermes as a
plain string; that acceptance is only defensible with this section in place.

---

### 2.16 Risks specific to this layer

| Risk | Why it is bad here specifically | Mitigation |
| --- | --- | --- |
| A malformed raw-key string silently becomes a PBKDF2 passphrase | Fails **open**, not closed. Every affected user's database is permanently unopenable, with no cloud copy. | `assertRawKey()` at one choke point; 67-character unit test; first-install create/close/reopen self-test; one debug build with SQLCipher logging on, confirming *"using raw key only"* appears. |
| Default `allowBackup` ships the database to Google Drive | Constraint-#1 violation with no build error and no runtime symptom, plus a 25 MB quota failure later. | §6.6.1's deny-all rules + G-7 shape assertion, in the same commit that creates the manifest. |
| A directory added later escapes an enumerate-the-excludes backup rule | `snapshots/pre_N.db` is a full `sqlcipher_export` **keyed with the live DEK**, and it sits on disk during every update window; `keys/recovery.wrap` is next to it. Uploaded together they are an offline-attackable package. No build error, no runtime symptom, no diff to review. | §6.6.1 excludes every domain at the root and re-includes nothing; the runtime gate in §2.9 enumerates directories the app actually creates and fails on any not covered. |
| The recovery wrap needs something outside itself to be unwrapped | The two paths that need it — a Keystore invalidation (§2.7.5) and an Android D2D transfer — have no readable `meta` and no manifest, by construction. A salt in `meta` means the correct phrase fails. | §6.1.2's `mmwrap/1` is self-describing: magic, version, `kdf_id`, parameters, salt, nonce, AEAD, tag. Assertion **A10** unwraps one with an empty `meta` and no manifest present. |
| A second independently-stored secret is added (spool key, sync key, anything) | It will not have two wraps, so it becomes a way to lose user data that the DEK's recovery story does not cover — and the loss reads as "temporary" in the UI. | One root secret. Everything else is `HKDF-SHA256(DEK, info)` via `MMKeyStore.deriveSubkey()` (§2.7.2). Adding a stored secret requires a row in §2.7.4 and its own recovery argument. |
| An FK-off window leaks past its procedure | The window is on the process-lifetime write connection, so every `ON DELETE RESTRICT` in §3 — "the undo and restore mechanism" — is inert until the app is killed. The first symptom is an account archive that orphans thousands of `entries`. | `finally` re-issues and re-reads the pragma (§2.11.3); the repository refuses a write batch when `PRAGMA foreign_keys` reads `0`; the backup export uses a second connection. |
| A key-bearing SQL statement reaches the crash reporter | `ATTACH … KEY "x'…'"` on the migration path carries the **live DEK**. One breadcrumb ships it to a searchable store next to the install id. | §2.15: allowlisted logger, `beforeSend` scrubber, DB breadcrumbs off, `ATTACH` call sites discard the original error. |
| Rotating a *disclosed* recovery phrase is sold as remediation | The DEK is unchanged and every old `.mmbak` still yields it, so the old phrase remains a skeleton key to the live database. The user destroys the old phrase believing the exposure is closed. | §6.1.4 splits rewrap from full DEK rotation; §2.7.1 no longer describes rewrap-not-rekey as an unqualified win. |
| A Keystore-only DEK | A diligent user with weekly backups still loses everything on phone loss — the worst possible failure, because they believed they were protected. | Wrap B generated during onboarding with forced re-entry verification, and **one proven backup before the user enters real data.** Test full restore on a factory-reset device before v1. |
| Wrap A failure misdiagnosed as corruption | Keystore invalidation, or a Keychain item absent after a `ThisDeviceOnly` restore, is indistinguishable from a corrupt file (`SQLITE_NOTADB` either way). Showing "your database is corrupt" converts a fully recoverable state into perceived total loss — and a "reset app data" button next to it makes it real. | §2.7.5's three-branch routing rule: restore marker first, then recovery phrase, then a message naming the missing artifact. Never corruption copy. `provision()` refuses on database-present, on wrap-present-without-database, and on restore-marker-present. |
| An interrupted restore wedges the app permanently | The live DB exists under a DEK that was never persisted; the recovery flow finds the wrong wrap or none, and `provision()` correctly refuses because a database file exists. The only escape is deleting app data, which the user reads as "the restore destroyed my backup". | §6.5 writes and fsyncs both wraps **before** the first byte of the live DB, behind a `restore/in_progress.json` sidecar marker; §2.14 step 0 and §6.5.4 resume from it and never route to recovery. |
| `journal_size_limit` assumed persistent | WAL grows unbounded after migration 0001's connection closes; shows up as unexplained storage growth months later. | §2.10.1. Re-issue on every open; add it to the connection-open test. |
| `sqlcipher_export` drops `auto_vacuum` | Every restored database permanently loses incremental vacuum, and the only remedy is a multi-minute full `VACUUM`. | `PRAGMA bk.auto_vacuum = INCREMENTAL` before `sqlcipher_export` (§2.11.2), plus a restore integration test asserting the pragma on the restored file. |
| Someone puts the database in the App Group container for a widget | Deterministic `0xdead10cc` on every backgrounding; surfaces weeks later as a background-termination statistic, not a reproducible bug. | Architecture test asserting the resolved DB path is never under `containerURL(forSecurityApplicationGroupIdentifier:)`. Document the widget pattern (main app serialises a small Codable snapshot into the group container) in `CLAUDE.md` **before** the first widget is requested. |
| The DEK transits Hermes as a plain string | op-sqlite's `encryptionKey` is a JS `string`; there is no native-pointer API, and Hermes strings cannot be zeroed. | Accepted residual. Hold it in one module-scoped variable, never log it, never put it in Redux/AsyncStorage/state, and open the database exactly once per process. |
| op-sqlite bus factor is one, and it vendors SQLite + SQLCipher + OpenSSL | A CVE in any of the three waits on one maintainer. | Thin adapter (§2.4) so the `expo-sqlite` swap is a driver change; record all three versions in the SBOM; subscribe to OpenSSL and SQLCipher advisories directly. |
| Drizzle 1.0 has been in RC since ~May 2026 | Churn in the relational-query API and migration format, in a data layer that must survive years. | Pin `drizzle-orm@0.45.2` and `drizzle-kit@0.31.10` exactly. Migrations are checked-in SQL, so the history is portable off Drizzle entirely. |

---

### 2.17 Open questions and spikes

Ordered by what blocks what.

1. **Does `crsqlite` compile alongside `sqlcipher`?** One afternoon of build spike. Decides whether
   the CRDT escape hatch exists at all, which the sync workstream needs before it commits.
   *(Everything else about Turso is already settled: `turso` replaces `sqlcipher`, so it is out.)*
2. **Confirm the `encryptionKey` string reaches `sqlcipher_cipher_ctx_key_derive` byte-identically**
   — no JS-side normalisation, no trailing NUL from the `std::string` conversion that would make
   `pass_sz` 68 instead of 67. The source path looks clean (`key.data()`, `key.size()`), but the
   length check is unforgiving enough to warrant one debug build with SQLCipher logging enabled,
   confirming *"using raw key only"* rather than *"deriving key using PBKDF2"*.
3. **Measure cold-open latency, raw-key vs passphrase, on a 4 GB Android Go-class device** relevant
   to LATAM. Quantifies what the raw-key decision buys and whether warm-connection reuse is also
   needed.
4. **Does `sqlcipher_export` faithfully reproduce FTS5 shadow tables** at realistic sizes
   (3 years, ~9k transactions, 200k oplog rows)? If not, §3.17 needs external-content FTS5. See
   §2.13.
5. **Measure the actual SQLCipher per-page reserve** on a real file (header offset 20) and the
   resulting on-disk overhead, so §2.12's size estimates can be corrected rather than hedged.
6. **Does `VACUUM INTO` on a SQLCipher connection produce an encrypted destination?** Ten minutes.
   `sqlcipher_export` is used regardless, but `VACUUM INTO` would be a much simpler snapshot
   primitive for the migration path in §2.11.3.
7. **Confirm the exact `__drizzle_migrations` DDL** the op-sqlite driver emits, so the hand-rolled
   runner (§2.4) writes hash-compatible rows and a future switch back to `migrate()` is possible.
8. **Verify `expo-sqlite`'s SQLCipher 3.49.1 build produces files compatible with op-sqlite's
   3.51.3** before relying on the fallback in §2.2 as a live migration route. The SQLCipher 4 format
   should be stable across those versions, but "should" is not good enough for the sole system of
   record.
9. **What is `expo-secure-store` 57.0.1's actual Android `SharedPreferences` filename?** Two earlier
   drafts guessed two different values. The deny-all rules in §6.6.1 make it non-load-bearing for
   the leak, but §2.9.1's constant table must hold the real string and the gate must assert it. One
   grep of the installed package.
10. **Measure `HKDF-SHA256` + `crypto_scalarmult_base` cost at provision time on the floor device**
    (§2.8.1). It runs once, so the answer is almost certainly "irrelevant" — confirm rather than
    assume, because it sits in the first-launch critical path next to Argon2id.

---

## Rejected findings (storage-sync)

Nothing in the review that landed on these two files was wrong on the merits. What follows is the
disposition of the items that could not be *fully* closed here, so the gap is visible rather than
silently dropped. Each names the file that owns the rest.

**X1 — `01-decisions.md` D4, D5 and D99 still contradict §6.1, and I cannot edit that file.**
Not a rejection; a request. Three changes are needed there and none of them is optional:

- **D4**: the recovery secret is the 15-word BIP39 phrase of §6.1.1, not "an app-generated 160-bit
  recovery code" rendered as base32. Same entropy, different UX, and the onboarding re-entry
  verification is built for word positions.
- **D5**: "No libsodium" is contradicted by §6.1's `crypto_aead_xchacha20poly1305_ietf_*`,
  `randombytes_buf` and `crypto_generichash`, all of which `react-native-libsodium` 1.7.0 *does*
  expose on native (only `crypto_pwhash` is sumo/web-only, which is exactly why Argon2 is a separate
  dependency). Restate D5 as: libsodium for AEAD, hashing and CSPRNG; `react-native-argon2` 4.0.0
  for `kdf_id = 0x02`; platform system crypto inside `MMKeyStore` for `kdf_id = 0x01`.
- **D99**: delete the `_backup_meta`-table-inside-the-attached-database proposal, with the reason
  recorded — **restore must read the KDF salt before it can decrypt anything**, so metadata inside
  the encrypted member cannot serve that purpose. §6.2.2's plaintext manifest is not an alternative
  design, it is the only implementable one.

**X2 — the spool sealed-box key: fixed here in principle, and the mechanism lives in
`04-capture.md`.** §2.8.1 now specifies `HKDF-SHA256(DEK, "mm/spool-x25519/v1")` and states why a
second stored secret is not acceptable. §4.4.1 must adopt the derivation, delete the sentence "the
private key may be recoverable even when the file currently is not", and turn an unreadable record
into a `capture_gaps` row; `03-schema.md` §3.14 must add the `cause` value. Until those land, the
design still describes two different mechanisms.

**X3 — the Kotlin↔SQLite mirror is referenced here and specified nowhere.** §2.9.1 reserves
`capture/` and puts it in `<device-transfer>`, and §2.8.1's write-path diagram routes the ingest
filter through it, because a restored phone that lacks the allowlist mirror captures nothing and
says nothing. But the file format, the writer, the versioning and the fail-closed rule are
`04-capture.md`'s to define (§4.4). Storage's contribution is the path and the backup treatment;
that is all it can be.

**X4 — retention purge preconditions and `oplog` content are provenance's, not storage's.** §6.7.1
now states the content-column allowlist as a precondition on the v1.5 relay, because the sentence
that would transmit purged message bodies to a sync server is in *this* file. The allowlist itself
belongs in `03-schema.md` §3.18 and the purge statement in `05-provenance.md` §5.8.3.

**X5 — sweep-check and CI-gate numbering was deliberately not extended.** Two reviewers each
proposed a check called "I12" for different things, and the `I` series is `03-schema.md` §3.21's to
allocate while the `G` series is `07-platforms-risks.md` §7.3's. Where this pass needed a new check
it is described in prose with its owning section named (the `allow_hard_delete` assertion in §2.14,
the FK read-back in §2.10.1, the directory-enumeration gate in §2.9). Existing gates that these
files *strengthen* are named directly: **G-7** (shape, not enumeration), **G-10 / G-11** (iterate
§2.7.4's inventory), **G-16** (add the standalone-wrap unwrap). The `A` series in §6.3 **is** ours,
and it grew by appending **A10** and **A11** — no renumbering, and §6.5 step 6, §6.10 item 5 and
§6.11 question 6 were updated with it.

**X6 — "the DEK protects the smaller and less revealing half of the data" is accepted, not fixed.**
The security review is right that receipt images are ~2× the database by size (§2.12) and arguably
more revealing, and that they sit unencrypted under platform FBE / Data Protection by deliberate
choice (D11, §6.10). That trade — CPU on every thumbnail render, against an attacker who has already
defeated platform disk encryption — is unchanged and is recorded as such. What the review did change
is the boundary that *actually* matters here: the artifact that leaves the sandbox. Media is
encrypted inside the container (§6.2.1), and the platform-backup rules are now deny-all (§6.6.1),
which is where the value of SQLCipher in this app really lies.
