## The complete SQL schema

This is the v1 schema, written to be implemented from directly. It targets SQLite 3.51.3 as
bundled by `@op-engineering/op-sqlite` 17.1.3 with `"op-sqlite": { "sqlcipher": true }`. Every
table is `STRICT`. Every statement below belongs in checked-in migration SQL files, not in
generated-at-runtime DDL.

Where the six research agents disagreed, one option is taken and the rejected one is named in a
sentence at the point of decision, with the full list repeated in §3.22.

---

### 3.0 The nine rules the whole schema depends on

These are invariants, not style preferences. Every one of them traces to a specific failure the
research identified. They belong verbatim in `CLAUDE.md`.

1. **Money is `INTEGER` minor units. Never `REAL`, never a Drizzle `bigint`.** Every money column
   carries `CHECK (col BETWEEN -9007199254740991 AND 9007199254740991)` — `Number.MAX_SAFE_INTEGER`,
   because op-sqlite reads every `SQLITE_INTEGER` through `sqlite3_column_double()` (verified in
   `cpp/bridge.cpp` lines 249-254) and therefore truncates silently above 2^53. The CHECK converts a
   silent corruption into a loud constraint failure. *Rejected: Agent 1's tighter ±9e14 operational
   bound — 2^53−1 is the actual representability limit and needs no hand-waving about intermediate
   arithmetic; intermediates are computed in JS `BigInt` and only the rounded result touches a column.*
   *Rejected: `blob({mode:'bigint'})` — it type-checks in Drizzle, becomes a BLOB with no numeric
   ordering, and throws `Buffer is not defined` in Hermes on insert.*
2. **Every money column travels as a triple: `(*_amount_minor, *_currency_code, *_currency_exponent)`.**
   The exponent is denormalized onto the row and never looked up at read time. Correct one wrong row
   in `currencies` and a decade of history would otherwise silently change value.
3. **Primary keys are `TEXT` UUIDv7.** Time-ordered (sequential B-tree inserts), globally unique
   offline, readable in logs. *Rejected: Agent 1's 26-char ULID (equivalent, but UUIDv7 is what three
   of the six agents assumed and is the canonical form); Agent 2's content-addressed `source_hash`
   as the row id for captured rows — a non-time-ordered PK makes merge/unmerge and index locality
   worse. Content addressing is expressed as a `UNIQUE INDEX` on `dedupe_key` instead, which gives
   the same idempotency with none of the cost.*
4. **Hashes are lowercase hex `TEXT`, not `BLOB`.** A BLOB round-trips through op-sqlite as an
   `ArrayBuffer`, which is hostile in JS and unreadable in logs. 32 extra bytes per row is nothing at
   these row counts. *Rejected: `BLOB(32)` as proposed by Agents 5 and 6.*
5. **Timestamps are `INTEGER` unix epoch **milliseconds** UTC.** Local calendar dates are separate
   `TEXT 'YYYY-MM-DD'` columns, stored not computed — SQLite has no IANA timezone arithmetic.
6. **Soft delete everywhere (`deleted_at INTEGER`), `ON DELETE RESTRICT` on every ledger reference.**
   With no cloud copy, soft delete *is* the undo and restore mechanism.
7. **Additive-only migrations**: new nullable columns and new tables. No renames, no drops —
   deprecate in place. **One stated exception:** `STORED` generated columns cannot be added by
   `ALTER TABLE ADD COLUMN`, so the two that exist (`booked_month` on `transactions` and `entries`)
   are **frozen at v1**. Any future derived column is `VIRTUAL` or app-maintained. A table rebuild
   for a new `STORED` column is permitted only under the snapshot-and-rollback procedure and is a
   deliberate, reviewed migration — never routine.
8. **Writes touch only dirty columns.** No full-row `UPDATE`. This is what makes per-field merge free
   under any future sync engine and is unretrofittable after a year of ORM full-row writes.
9. **Rounding is ROUND_HALF_EVEN, in exactly one function, everywhere.** Splits use largest-remainder
   allocation so the parts sum to the original exactly. Re-derivation after an FX correction must be
   bit-identical or the correction job emits spurious diffs on unchanged rows.

---

### 3.1 Migration 0001 preamble — pragmas, in this order

`PRAGMA auto_vacuum` is irreversible after the first `CREATE TABLE`, so it is statement one.
`sqlite3_key_v2()` has already run inside op-sqlite's `open()` before any of this executes.

```sql
-- ─── migration 0001, part A: pragmas. NOTHING may precede auto_vacuum. ───────────────
--
-- Irreversible. SQLite: "Auto-vacuuming must be turned on before any tables are created.
-- It is not possible to enable or disable auto-vacuum after a table has been created."
-- Switching to/from `none` later requires a full VACUUM — on an encrypted multi-hundred-MB
-- file on a phone that is a multi-minute stall. INCREMENTAL lets us reclaim pages after
-- bulk deletes (image pruning, oplog truncation) via PRAGMA incremental_vacuum(N).
PRAGMA auto_vacuum = INCREMENTAL;

-- WAL must come AFTER any cipher pragma (it is itself a database operation) and after
-- auto_vacuum. SQLCipher encrypts WAL page data with the database key, so the -wal and
-- -shm sidecars are not a plaintext leak.
PRAGMA journal_mode = WAL;

-- FULL, not the usual WAL default of NORMAL. NORMAL survives an app crash but not a power
-- loss. This database is the sole system of record with no upstream copy, and the write
-- volume is a few dozen commits a day, so the fsync cost is irrelevant and the durability
-- is not. Rejected: Agent 1's synchronous=NORMAL.
PRAGMA synchronous = FULL;

-- OFF BY DEFAULT IN SQLITE. Every foreign key in this schema is inert without it, and it
-- must be re-asserted on every connection — it is a connection-level setting, not stored
-- in the file.
PRAGMA foreign_keys = ON;

-- Truncate the WAL after checkpoints instead of letting it grow unbounded.
-- wal_autocheckpoint defaults to 1000 pages (~4 MB at the 4096-byte SQLCipher page size).
PRAGMA journal_size_limit = 8388608;   -- 8 MiB

PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;            -- also set by -DSQLITE_TEMP_STORE=3 in op-sqlite's build
```

Connection-open checklist for the repository (all of `foreign_keys`, `busy_timeout`,
`synchronous` are per-connection and must be re-issued every open; `auto_vacuum`,
`journal_mode` and `journal_size_limit` are persisted in the file).

**Table creation order does not matter.** SQLite resolves foreign keys at DML time, not DDL time,
so the forward references below (`transactions` → `raw_captures`, `budget_lines` → `tags`, and so
on) are legal in any order. Keep the migration file in the reading order of this section.

---

### 3.2 Meta, identity and migration bookkeeping

```sql
-- ─── meta ─────────────────────────────────────────────────────────────────────────────
-- Never synced. Holds the device identity that HLCs are stamped with, so it must live
-- OUTSIDE any table that a future sync engine replicates.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

INSERT INTO meta (key, value) VALUES
  ('schema_version',      '1'),
  ('node_id',             '<uuidv4 generated once at install>'),  -- per-INSTALL, not per-user
  ('install_id',          '<uuidv4>'),
  ('base_currency_code',  'EUR'),          -- the reporting currency; changing it triggers §3.3.4
  ('taxonomy_version',    'cat:2026-08-01'),
  ('tzdata_version',      '2026a'),
  ('currency_source_version', 'iso4217:2026-01-01+cldr:47'),
  ('rounding_mode',       'half_even'),
  ('fx_gap_policy',       'nearest_prior'), -- ECB publishes business days only
  ('dedupe_algo_version', '1'),
  ('allow_hard_delete',   'no');           -- escape hatch for the no-hard-delete trigger (§3.19)
```

Schema version truth: **`__drizzle_migrations` is the single source of truth**, because
`sqlcipher_export()` copies it like any other table while it does *not* copy `user_version`
(Zetetic documents this explicitly). `PRAGMA user_version = N` is written inside the same
transaction as the final migration and is read **only** for the backup manifest and the
downgrade guard (`user_version > MAX_KNOWN` ⇒ open read-only, tell the user to update). Getting
this backwards makes a restored backup replay every migration against an already-current schema.
*Rejected: hand-rolling migrations on `user_version` alone.*

---

### 3.3 Currencies and FX

#### 3.3.1 currencies

Generated at build time by parsing the SIX Group ISO 4217 `list-one.xml` and cross-referencing
Unicode CLDR `currencyData`. Bundled as a seed migration — never fetched at runtime, both because
that would be a network dependency for something that changes a few times a year and because a
fetch failure would leave the app unable to parse money at all.

```sql
CREATE TABLE currencies (
  code                  TEXT PRIMARY KEY,      -- ISO 4217 alpha-3
  numeric_code          INTEGER,               -- ISO 4217 numeric; NULL for 'N.A.' entries
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL
    CHECK (kind IN ('fiat','metal','fund','crypto','test','none')),

  -- TWO exponents, deliberately. iso_exponent governs STORAGE and ALL ARITHMETIC and is
  -- copied onto every money row at write time. display_exponent governs the FORMATTER only.
  -- They differ for MGA and MRU: ISO assigns exponent 2 because its exponent field is a
  -- base-10 mechanism and cannot express a /5 subdivision, but nobody transacts in
  -- iraimbilanja or khoums, so display is 0. Storing at iso_exponent keeps import/export
  -- interchange-faithful with no rounding.
  iso_exponent          INTEGER NOT NULL CHECK (iso_exponent     BETWEEN 0 AND 8),
  display_exponent      INTEGER NOT NULL CHECK (display_exponent BETWEEN 0 AND 8),

  -- 0 = pure base-10. 5 for MGA and MRU (1 ariary = 5 iraimbilanja, 1 ouguiya = 5 khoums).
  -- Documentary metadata so a future formatter can render fifths without a migration.
  subunit_ratio         INTEGER NOT NULL DEFAULT 0 CHECK (subunit_ratio >= 0),

  -- CLDR cash rounding, in minor units. CHF = 5 (physical rounding to 0.05). Applies at
  -- display and at cash-payment entry ONLY, never to stored amounts.
  cash_rounding_minor   INTEGER NOT NULL DEFAULT 0 CHECK (cash_rounding_minor >= 0),

  symbol                TEXT,
  is_transactable       INTEGER NOT NULL DEFAULT 1 CHECK (is_transactable IN (0,1)),

  -- ISO 4217 churn is real and recent: ANG->XCG (2025-03-31), ZWL->ZWG (amendment 177),
  -- BGN->EUR (2026-01-01). Without these four columns each of those is a data migration.
  status                TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','retired')),
  retired_on            TEXT,
  successor_code        TEXT REFERENCES currencies(code),
  redenomination_factor TEXT,     -- exact decimal string, e.g. '1000'; TEXT so it is exact

  source_version        TEXT NOT NULL   -- 'iso4217:2026-01-01+cldr:47'
) STRICT;

CREATE INDEX ix_currencies_active ON currencies(status) WHERE status = 'active';
```

The exponent classes, all verified against the SIX primary list (`Pblshd="2026-01-01"`):

| iso_exponent | Members | Note |
| --- | --- | --- |
| 0 | JPY, KRW, VND, ISK, CLP, PYG, RWF, UGX, VUV, BIF, DJF, GNF, KMF, XAF, XOF, XPF, UYI | 17 active |
| 2 | everything else, including **MGA and MRU** | display_exponent 0 for those two |
| 3 | **BHD, IQD, JOD, KWD, LYD, OMR, TND** | **seven, not three** — a codebase that assumes /100 makes silent 1000x errors here |
| 4 | CLF, UYW | units of account, `is_transactable = 0` |
| N.A. | XAU XAG XPT XPD XDR XSU XBA-XBD XTS XXX | stored as `iso_exponent = 0`, `kind` in ('metal','fund','none','test'), `is_transactable = 0` |

`CHECK (iso_exponent BETWEEN 0 AND 8)` is the **crypto scope gate** and belongs in the ADR
verbatim: 1 ETH = 10^18 wei; int64 max is 9.223e18 so a 64-bit integer holds ~9.2 ETH at native
precision and the JS-safe range holds 0.009 ETH. Native-precision ERC-20 balances are not
representable in this design and no amount of care changes that. Exponent 8 is the ceiling that
still works — the entire 21,000,000 BTC supply in satoshis is 2.1e15, comfortably inside 2^53−1.
The named migration path if crypto is ever added is GnuCash's: add `amount_num TEXT` /
`amount_den TEXT` arbitrary-precision decimal strings alongside `amount_minor`, keep
`amount_minor` as the lossy display/index value, and move arithmetic to BigInt rationals.

Representative seed (the generator emits ~180 rows; these cover every class):

```sql
INSERT INTO currencies
  (code,numeric_code,name,kind,iso_exponent,display_exponent,subunit_ratio,
   cash_rounding_minor,symbol,is_transactable,status,source_version) VALUES
  ('EUR',978,'Euro',                'fiat',2,2,0,0,'€' ,1,'active','iso4217:2026-01-01+cldr:47'),
  ('USD',840,'US Dollar',           'fiat',2,2,0,0,'$' ,1,'active','iso4217:2026-01-01+cldr:47'),
  ('MXN',484,'Mexican Peso',        'fiat',2,2,0,0,'$' ,1,'active','iso4217:2026-01-01+cldr:47'),
  ('JPY',392,'Yen',                 'fiat',0,0,0,0,'¥' ,1,'active','iso4217:2026-01-01+cldr:47'),
  ('KWD',414,'Kuwaiti Dinar',       'fiat',3,3,0,0,NULL,1,'active','iso4217:2026-01-01+cldr:47'),
  ('CHF',756,'Swiss Franc',         'fiat',2,2,0,5,'CHF',1,'active','iso4217:2026-01-01+cldr:47'),
  ('MGA',969,'Malagasy Ariary',     'fiat',2,0,5,0,NULL,1,'active','iso4217:2026-01-01+cldr:47'),
  ('MRU',929,'Ouguiya',             'fiat',2,0,5,0,NULL,1,'active','iso4217:2026-01-01+cldr:47'),
  ('CLF',990,'Unidad de Fomento',   'fund',4,4,0,0,NULL,0,'active','iso4217:2026-01-01+cldr:47'),
  ('XAU',959,'Gold',                'metal',0,0,0,0,NULL,0,'active','iso4217:2026-01-01+cldr:47');

-- Retired-with-successor example, so the shape is exercised from day one.
INSERT INTO currencies
  (code,numeric_code,name,kind,iso_exponent,display_exponent,subunit_ratio,cash_rounding_minor,
   symbol,is_transactable,status,retired_on,successor_code,source_version) VALUES
  ('ANG',532,'Netherlands Antillean Guilder','fiat',2,2,0,0,NULL,0,'retired','2025-03-31','XCG',
   'iso4217:2026-01-01+cldr:47');
```

#### 3.3.2 fx_rates — append-only, exact rationals

```sql
CREATE TABLE fx_rates (
  id            TEXT PRIMARY KEY,
  base_code     TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  quote_code    TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  rate_date     TEXT NOT NULL
    CHECK (rate_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- EXACT RATIONAL, not a scaled integer and not REAL. A fixed scale (rate x 1e10) has a
  -- ceiling: weak-currency pairs reach 1e6+ (USD/IRR unofficial, historical ZWL, pre-
  -- redenomination VES) and 1e6 x 1e10 = 1e16 overruns 2^53. Frankfurter publishes 1.0873;
  -- we store 10873/10000 and it round-trips bit-for-bit.
  rate_num      INTEGER NOT NULL CHECK (rate_num BETWEEN 1 AND 9007199254740991),
  rate_den      INTEGER NOT NULL CHECK (rate_den BETWEEN 1 AND 9007199254740991),
  rate_text     TEXT    NOT NULL,   -- the source's exact published string, for audit and re-fetch diffing

  source        TEXT NOT NULL
    CHECK (source IN ('seed','frankfurter','self_hosted','manual','statement')),
  source_url    TEXT,

  -- Append-only correction protocol: a revised rate is a NEW ROW, never an UPDATE. An UPDATE
  -- would silently change every historical total that used it, with no record it happened.
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  supersedes_id TEXT REFERENCES fx_rates(id),

  retrieved_at  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  CHECK (base_code <> quote_code)
) STRICT;

CREATE UNIQUE INDEX ux_fx_rates
  ON fx_rates(base_code, quote_code, rate_date, source, revision);

-- The lookup index. Rate resolution for a transaction is:
--   WHERE base_code=? AND quote_code=? AND rate_date <= :booked_local_date
--   ORDER BY rate_date DESC, revision DESC LIMIT 1
-- ECB/Frankfurter publish business days only, so the <= gap fallback is the NORMAL path,
-- not an exception. The row actually used is recorded in transactions.reporting_rate_date
-- so a rate that is four days stale is visible in the UI rather than invisible.
CREATE INDEX ix_fx_rates_lookup
  ON fx_rates(base_code, quote_code, rate_date DESC, revision DESC);
```

Conversion is one function, and its definition is part of the schema contract because
re-derivation after a rate correction must be **bit-identical**:

```text
convert(amountMinor, expFrom, expTo, rateNum, rateDen) =
  roundHalfEven( amountMinor * rateNum * 10^max(0, expTo - expFrom),
                 rateDen                * 10^max(0, expFrom - expTo) )
```

All in `BigInt`, ROUND_HALF_EVEN, one implementation, unit-tested against a checked-in golden
vector file covering MGA, MRU, JPY, KWD, CHF, ISK. Cross rates (USD→JPY from EUR-based ECB data)
multiply rationals with **no intermediate rounding** — round exactly once, at the end.

#### 3.3.3 fx_rederivations — the audit trail for rate corrections

```sql
CREATE TABLE fx_rederivations (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,          -- groups one job; the whole run is one undo unit
  txn_id           TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  old_amount_minor INTEGER NOT NULL CHECK (old_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  new_amount_minor INTEGER NOT NULL CHECK (new_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  old_rate_id      TEXT REFERENCES fx_rates(id),
  new_rate_id      TEXT REFERENCES fx_rates(id),
  reason           TEXT NOT NULL
    CHECK (reason IN ('rate_revised','rate_backfilled','base_currency_changed','manual')),
  created_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_fx_rederivations_run ON fx_rederivations(run_id, created_at);
```

#### 3.3.4 The re-derivation path, stated as an ordered procedure

1. `INSERT` the corrected rate as a new `fx_rates` row, `revision = prev + 1`,
   `supersedes_id = <old id>`. Nothing else changes yet.
2. Select the affected set through the dedicated partial index (§3.6):
   ```sql
   SELECT id, amount_minor, currency_exponent, reporting_exponent
     FROM transactions
    WHERE reporting_rate_id = :old_rate_id
      AND reporting_source  = 'derived'
      AND reporting_locked  = 0
      AND deleted_at IS NULL;
   ```
   Rows with `reporting_source IN ('actual','manual')` or `reporting_locked = 1` are excluded by
   the `WHERE` clause and are **never** touched — those are numbers the user's bank actually
   charged, and recomputing them would be wrong.
3. Recompute with the same `convert()` function; `UPDATE` only the dirty columns
   (`reporting_amount_minor`, `reporting_rate_id`, `reporting_rate_num/den`, `reporting_rate_date`,
   `updated_at`, `hlc`).
4. Write one `fx_rederivations` row per changed transaction so the UI can say *"12 transactions
   changed by €0.34 total because the 2026-07-14 EUR/JPY rate was revised."*
5. `budget_periods.stale` is set to 1 automatically by `trg_budget_stale_on_reporting_change`
   (§3.19). Missing that coupling is what makes a budget silently disagree with the transaction
   list it is supposedly summing.

**Base-currency change** (emigration, relocation) reuses this path with
`reason = 'base_currency_changed'` and invalidates *every* `reporting_amount_minor` at once. It is
an explicit, resumable, progress-shown migration — not a settings toggle. Pre-flight it by
checking rate coverage for the required pairs and dates and refuse to start until gaps are filled
or the user accepts nearest-prior fallback. Budget minutes, not milliseconds.

---

### 3.4 Accounts and categories

#### 3.4.1 accounts

```sql
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL
    CHECK (type IN ('asset','liability','equity','expense','income')),
  subtype       TEXT NOT NULL CHECK (subtype IN (
                  'cash','checking','savings','credit_card','loan','investment',
                  'receivable','payable',
                  'opening_balance','fx_conversion','imbalance','clearing',
                  'expense','income')),
  parent_id     TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,

  -- NULL means "multi-currency account". Only system equity accounts may be multi-currency:
  -- sys_fx_conversion has to hold both legs of a cross-currency transfer simultaneously,
  -- and sys_imbalance absorbs residuals in whatever currency produced them.
  currency_code TEXT REFERENCES currencies(code) ON DELETE RESTRICT,

  is_system     INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),

  -- The single flag that stops a 401k contribution or a savings sweep from reading as a
  -- spending spike. Investment and savings accounts get 0.
  is_on_budget  INTEGER NOT NULL DEFAULT 1 CHECK (is_on_budget IN (0,1)),

  institution   TEXT,
  last4         TEXT CHECK (last4 IS NULL OR last4 GLOB '[0-9][0-9][0-9][0-9]'),
  color         TEXT,
  icon          TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived_at   INTEGER,          -- accounts with history are ARCHIVED, never deleted

  hlc           TEXT NOT NULL,    -- '<48-bit ms hex>:<16-bit counter hex>:<node_id>' — see §3.18
  node_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,

  CHECK (currency_code IS NOT NULL OR is_system = 1)
) STRICT;

-- Same child name under different parents is allowed; duplicates under one parent are not.
CREATE UNIQUE INDEX ux_accounts_name
  ON accounts(IFNULL(parent_id,''), name) WHERE deleted_at IS NULL;
CREATE INDEX ix_accounts_tree ON accounts(parent_id, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX ix_accounts_budget ON accounts(is_on_budget, type) WHERE deleted_at IS NULL;
```

Six system accounts, seeded with **fixed non-UUID ids** so application code can reference them
directly:

```sql
INSERT INTO accounts
  (id,type,subtype,name,currency_code,is_system,is_on_budget,hlc,node_id,created_at,updated_at) VALUES
  -- Every account's starting balance is a real balanced transaction against this, not a magic
  -- column. That is what makes the balance view a pure SUM with no special cases.
  ('sys_opening_balance','equity','opening_balance','Opening balances',NULL,1,0,'0:0:seed',0,0,0),
  -- Absorbs the two extra legs of a cross-currency transaction. Never rendered in the UI.
  ('sys_fx_conversion',  'equity','fx_conversion',  'Currency conversion',NULL,1,0,'0:0:seed',0,0,0),
  -- Absorbs residuals while a draft is mid-edit, so drafts are never unbalanced.
  -- "Needs attention" is literally: entries WHERE account_id = 'sys_imbalance'.
  ('sys_imbalance',      'equity','imbalance',      'Imbalance',         NULL,1,0,'0:0:seed',0,0,0),
  -- ATM withdrawals post here; cash receipts draw it down. Without it, every withdrawal is
  -- recorded as a ~$200 expense AND the coffee bought with it is recorded again.
  ('sys_cash',           'asset', 'cash',           'Cash wallet',       'EUR',1,1,'0:0:seed',0,0,0),
  -- One-sided transfers (counterpart account untracked, or its notification never arrived)
  -- post here: excluded from spend, visible as an open item, replaced if the counterpart lands.
  -- This is what gets the spend number right on iOS, where passive capture does not exist.
  ('sys_unmatched_transfer','asset','clearing','Unmatched transfers','EUR',1,0,'0:0:seed',0,0,0),
  ('sys_unaccounted_cash','expense','expense','Unaccounted cash','EUR',1,1,'0:0:seed',0,0,0);
```

`receivable` / `payable` subtypes are how shared expenses work: one account per person, created on
demand. "I paid 100, Alice owes me 60" becomes a −100 checking leg, a +40 category leg and a +60
`Asset:Receivable:Alice` leg — both the spending figure and the account balance stay correct,
which is unrepresentable in a flat transaction+category table.

#### 3.4.2 taxonomy_keys and categories

Two layers. A frozen, versioned canonical key set is the **only output space the LLM ever sees**;
a user-editable tree maps many-to-one onto it.

```sql
-- The closed set the constrained decoder compiles to a grammar alternation. ~70 leaves under
-- 12-14 groups. Shipped data, versioned, never user-writable. Because it is a table and not a
-- hardcoded enum, the GBNF / @Generable / LiteRT-LM function schema is GENERATED from it, so an
-- invalid category is structurally impossible to emit — 100% valid output, no post-hoc string
-- matching, no hallucinated category. A free-text category field cannot be constrained at all.
CREATE TABLE taxonomy_keys (
  key              TEXT NOT NULL,          -- 'food.groceries', 'transport.taxi', 'income.salary'
  taxonomy_version TEXT NOT NULL,
  group_key        TEXT NOT NULL,          -- 'food', 'transport', 'income'
  default_kind     TEXT NOT NULL CHECK (default_kind IN ('expense','income','transfer')),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (taxonomy_version, key)
) STRICT, WITHOUT ROWID;

-- categories is a 1:1 EXTENSION of an expense/income account, not a parallel dimension.
-- Because a category IS an account, entries.account_id is a single NOT NULL FK and the
-- balance invariant is one query over one column.
-- Rejected: nullable account_id XOR category_id on entries (makes the invariant unenforceable
-- — you cannot sum across a column that is sometimes NULL and sometimes means something else).
-- Rejected: one sys_expense control account with category_id as a dimension (stores one
-- concept in two columns, and someone eventually tags the checking-account leg).
CREATE TABLE categories (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
  parent_id        TEXT REFERENCES categories(id) ON DELETE RESTRICT,

  canonical_key    TEXT NOT NULL,          -- FK-by-convention into taxonomy_keys(key)
  taxonomy_version TEXT NOT NULL,

  name             TEXT NOT NULL,          -- localized, user-renameable. The model NEVER sees this.
  kind             TEXT NOT NULL CHECK (kind IN ('expense','income','transfer')),
  icon             TEXT,
  color            TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,

  origin           TEXT NOT NULL CHECK (origin IN ('seed','user','llm_suggested')),
  status           TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','pending','hidden','merged')),
  merged_into_id   TEXT REFERENCES categories(id),   -- merge without rewriting ledger history

  hlc              TEXT NOT NULL,
  node_id          TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,

  FOREIGN KEY (taxonomy_version, canonical_key)
    REFERENCES taxonomy_keys(taxonomy_version, key) ON DELETE RESTRICT,
  CHECK (status <> 'merged' OR merged_into_id IS NOT NULL)
) STRICT;

CREATE INDEX ix_categories_key    ON categories(canonical_key) WHERE deleted_at IS NULL;
CREATE INDEX ix_categories_tree   ON categories(parent_id, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX ix_categories_pending ON categories(status) WHERE status = 'pending';

-- Deterministic pre-pass: a known alias short-circuits the LLM entirely, which is the single
-- biggest latency and battery saving available. Also doubles as few-shot anchors.
CREATE TABLE category_aliases (
  id          TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,       -- normalized: casefolded, punctuation stripped, ws collapsed
  locale      TEXT NOT NULL DEFAULT '*',
  weight      REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0),
  origin      TEXT NOT NULL CHECK (origin IN ('seed','user','llm_suggested','learned')),
  hit_count   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_category_aliases ON category_aliases(alias, locale);
```

A user-proposed or model-proposed category lands with `status = 'pending'`; the user's
accept/reject is itself a labelled training signal. `taxonomy_version` is stamped on every
`extraction_runs` row (§3.11) so a taxonomy change does not silently poison the accumulated corpus.

#### 3.4.3 merchants

```sql
-- The strings arriving from SMS and card notifications are not merchant names:
-- "SQ *STARBUCKS 04122 SEATTLE WA" and "COMPRA STARBUCKS CDMX" are one merchant.
CREATE TABLE merchants (
  id                    TEXT PRIMARY KEY,
  canonical_name        TEXT NOT NULL,
  normalized_name       TEXT NOT NULL,
  default_category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,

  -- These two feed the currency-disambiguation ladder directly: '$' at a merchant with
  -- country_code='MX' is MXN, not USD.
  default_currency_code TEXT REFERENCES currencies(code),
  country_code          TEXT,          -- ISO 3166-1 alpha-2

  mcc                   TEXT,          -- ISO 18245; a strong category prior when the bank exposes it
  merchant_class        TEXT CHECK (merchant_class IS NULL OR merchant_class IN (
                          'restaurant','bar','taxi','salon','fuel','hotel','car_rental',
                          'ev_charging','retail','grocery','online','transport','other')),
  logo_ref              TEXT,          -- LOCAL asset path only. A remote URL would leak the
                                       -- user's merchant list to a third party.
  txn_count             INTEGER NOT NULL DEFAULT 0,
  last_seen_at          INTEGER,
  origin                TEXT NOT NULL CHECK (origin IN ('seed','user','learned')),
  hlc TEXT NOT NULL, node_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;

CREATE UNIQUE INDEX ux_merchants_norm ON merchants(normalized_name) WHERE deleted_at IS NULL;

-- Every confirmed mapping inserts or increments a pattern row, so the deterministic matcher
-- improves with zero model involvement.
CREATE TABLE merchant_patterns (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  raw         TEXT NOT NULL,     -- verbatim descriptor as it arrived
  normalized  TEXT NOT NULL,     -- acquirer noise stripped: 'SQ *', 'SUMUP *', 'PAYPAL *',
                                 -- 'MP*', 'IZ *', trailing city/state/store number, embedded dates
  source      TEXT NOT NULL CHECK (source IN ('notification','sms','receipt','statement','user')),
  hit_count   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_merchant_patterns_norm ON merchant_patterns(normalized);
CREATE UNIQUE INDEX ux_merchant_patterns ON merchant_patterns(merchant_id, normalized);
```

---

### 3.5 Transactions — the projection

`transactions` is a **denormalized header and projection**. The authoritative history is
`transaction_events` (§3.6); `entries` (§3.7) is the ledger. The header exists because on a phone
the timeline and the budget screen are the two hottest surfaces and neither can afford to fold an
event log at render time.

Three **orthogonal state axes**, not one status column. A single enum here would be a ~30-state
product where most states are illegal, and the illegal ones are the bugs.
*Rejected: Agent 3's single `status IN ('draft','unconfirmed','confirmed','void')`.*

```sql
CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'expense','income','transfer','refund','installment_payment',
                  'adjustment','opening_balance','inferred_gap')),

  -- ── AXIS 1: clearing_state — what the BANK says happened ────────────────────────────
  -- 'expired' is load-bearing and most apps omit it. Pending authorizations can vanish
  -- without ever posting (fuel, hotel and rental holds specifically). Without it a $1 fuel
  -- pre-auth or a $200 hotel hold pollutes the ledger forever. Its trigger is a LOCAL TIMER
  -- (hold_ttl_days), not a bank message, and it is NOT terminal: expired -> settled is legal.
  clearing_state TEXT NOT NULL DEFAULT 'unknown' CHECK (clearing_state IN (
                  'unknown','authorized','settled','reversed','expired',
                  'disputed','chargeback_won','chargeback_lost')),

  -- ── AXIS 2: confirm_state — what WE know, given ~0.80 F1 extraction ─────────────────
  -- 'needs_review' is the NORMAL path, not an error path. 'reconciled' requires an
  -- authoritative cross-check (matched statement line, or a continuous balance chain).
  -- On iOS the practical ceiling is 'confirmed', and the UI must say so rather than
  -- implying a reconciliation that never happened.
  confirm_state  TEXT NOT NULL DEFAULT 'extracted' CHECK (confirm_state IN (
                  'draft','extracted','auto_accepted','needs_review','confirmed','reconciled')),

  -- ── AXIS 3: disposition — what the USER did with the row ────────────────────────────
  disposition    TEXT NOT NULL DEFAULT 'active' CHECK (disposition IN (
                  'active','voided','merged_into','superseded')),
  merged_into_id TEXT REFERENCES transactions(id),
  needs_review   INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),

  -- ── primary money, in the currency of the ECONOMIC EVENT (the receipt's currency) ────
  direction         TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor      INTEGER NOT NULL
    CHECK (amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  currency_code     TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  currency_exponent INTEGER NOT NULL CHECK (currency_exponent BETWEEN 0 AND 8),
  -- The exact substring from the source, e.g. '1.234,56'. A separator misparse is a 1000x
  -- error; this column is what makes it forensically recoverable years later.
  amount_text_raw   TEXT,

  -- ── auth -> settlement. NEVER an overwrite; the original survives in three places:
  --    the immutable raw_capture text, authorized_amount_minor, and the AMOUNT_ASSERTED event.
  authorized_amount_minor INTEGER
    CHECK (authorized_amount_minor IS NULL OR authorized_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  settled_amount_minor    INTEGER
    CHECK (settled_amount_minor IS NULL OR settled_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  effective_amount_minor  INTEGER GENERATED ALWAYS AS
    (COALESCE(settled_amount_minor, authorized_amount_minor, amount_minor)) STORED,
  adjustment_minor        INTEGER GENERATED ALWAYS AS
    (CASE WHEN settled_amount_minor IS NOT NULL AND authorized_amount_minor IS NOT NULL
          THEN settled_amount_minor - authorized_amount_minor END) STORED,
  -- Set only when adjustment_minor > 0 and merchant_class is tip-bearing. Mastercard allows a
  -- 20% tip tolerance; Visa allows 15% auth-to-clearing plus gratuity up to 20% of base. So
  -- the legitimate settle/auth ratio is bounded ~1.25 — beyond that it is a CONFLICT, not a match.
  tip_minor               INTEGER,
  merchant_class          TEXT,
  -- Local expiry timer for an unsettled authorization. Defaults: 3 (fuel), 8 (default),
  -- 31 (hotel / car rental / cruise).
  hold_ttl_days           INTEGER CHECK (hold_ttl_days IS NULL OR hold_ttl_days > 0),

  -- ── reporting conversion (account/base currency). See §3.3 for why all of it is stored. ──
  reporting_currency_code TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  reporting_exponent      INTEGER NOT NULL CHECK (reporting_exponent BETWEEN 0 AND 8),
  reporting_amount_minor  INTEGER NOT NULL
    CHECK (reporting_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  reporting_rate_id       TEXT REFERENCES fx_rates(id) ON DELETE RESTRICT,
  reporting_rate_num      INTEGER,     -- denormalized so re-derivation needs no join
  reporting_rate_den      INTEGER,
  reporting_rate_date     TEXT,        -- the rate date ACTUALLY USED — makes staleness visible
  reporting_source        TEXT NOT NULL CHECK (reporting_source IN
                            ('same_currency','derived','actual','manual')),
  -- 'actual' = the number the bank actually charged, spread included. NEVER recomputed.
  reporting_locked        INTEGER NOT NULL DEFAULT 0 CHECK (reporting_locked IN (0,1)),

  -- ── time: four distinct concepts. See §3.5.1. ───────────────────────────────────────
  captured_at_utc   INTEGER NOT NULL,   -- immutable; drives sync ordering and the captures feed.
                                        -- NEVER used for reporting.
  booked_at_utc     INTEGER NOT NULL,
  booked_tz         TEXT    NOT NULL,   -- IANA, e.g. 'Asia/Tokyo'
  booked_precision  TEXT    NOT NULL CHECK (booked_precision IN ('minute','day','month')),
  booked_local_date TEXT    NOT NULL
    CHECK (booked_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  booked_month      TEXT GENERATED ALWAYS AS (substr(booked_local_date,1,7)) STORED,
  posted_at_utc     INTEGER,            -- bank settlement date; reconciliation only, never budgets
  posted_local_date TEXT
    CHECK (posted_local_date IS NULL OR
           posted_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- ── who / what ──────────────────────────────────────────────────────────────────────
  merchant_id     TEXT REFERENCES merchants(id) ON DELETE RESTRICT,
  merchant_raw    TEXT,                 -- the unnormalized string. Kept forever: it is training
                                        -- data and the merchant-matching input.
  account_id      TEXT REFERENCES accounts(id) ON DELETE RESTRICT,  -- primary money account,
                                        -- denormalized from entries for the dedupe blocking query
  parent_txn_id   TEXT REFERENCES transactions(id),                 -- refunds / adjustments
  note            TEXT,

  -- ── provenance summary (detail lives in §3.10-3.11) ─────────────────────────────────
  input_channel   TEXT NOT NULL CHECK (input_channel IN (
                    'manual','receipt_photo','screenshot_ocr','voice','free_text',
                    'android_sms','android_notification','ios_share','ios_wallet_intent',
                    'ios_shortcut','statement_import','file_import','inferred')),
  primary_capture_id    TEXT REFERENCES raw_captures(id) ON DELETE RESTRICT,
  primary_extraction_id TEXT REFERENCES extraction_runs(id) ON DELETE RESTRICT,
  confidence      REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  -- total - SUM(line items). Nullable. Soft reconciliation: surfaced and correctable, never
  -- a rejection. At 0.80 F1 a hard CHECK would reject a large fraction of real receipts.
  line_items_delta_minor INTEGER,
  external_id     TEXT,                 -- bank reference / statement line id
  dedupe_hash     TEXT,                 -- see §3.12

  -- ── sync scaffolding (§3.18) ────────────────────────────────────────────────────────
  hlc        TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,

  -- ── composite legality ──────────────────────────────────────────────────────────────
  CHECK (disposition <> 'merged_into' OR merged_into_id IS NOT NULL),
  CHECK (confirm_state <> 'reconciled' OR
         clearing_state IN ('settled','reversed','chargeback_won','chargeback_lost')),
  CHECK (clearing_state <> 'authorized' OR settled_amount_minor IS NULL),
  CHECK (reporting_source <> 'derived' OR reporting_rate_id IS NOT NULL),
  CHECK (reporting_source <> 'same_currency' OR currency_code = reporting_currency_code),
  CHECK (currency_code <> reporting_currency_code OR reporting_source = 'same_currency'),
  CHECK (kind <> 'installment_payment' OR parent_txn_id IS NOT NULL)
) STRICT;
```

Indexes — one per hot query, all partial on `deleted_at IS NULL` because every read path filters
on it:

```sql
-- the timeline
CREATE INDEX ix_txn_timeline   ON transactions(booked_local_date DESC)
  WHERE deleted_at IS NULL AND disposition = 'active';
-- monthly reports and budget actuals
CREATE INDEX ix_txn_month_kind ON transactions(booked_month, kind)
  WHERE deleted_at IS NULL AND disposition = 'active';
-- merchant history / "how much do I spend at X"
CREATE INDEX ix_txn_merchant   ON transactions(merchant_id, booked_local_date DESC)
  WHERE deleted_at IS NULL;
-- the review inbox — at 0.80 F1 plus a deliberate under-merge bias this is the app's MAIN
-- surface, not a badge, so it gets a first-class index
CREATE INDEX ix_txn_review     ON transactions(confirm_state, needs_review, captured_at_utc DESC)
  WHERE deleted_at IS NULL AND disposition = 'active';
-- FX re-derivation (§3.3.4) — the exact predicate the job runs
CREATE INDEX ix_txn_rate       ON transactions(reporting_rate_id)
  WHERE reporting_source = 'derived' AND reporting_locked = 0 AND deleted_at IS NULL;
-- dedupe blocking (§3.12) — the exact leading columns of the blocking SELECT
CREATE INDEX ix_txn_block      ON transactions(account_id, currency_code, effective_amount_minor,
                                               booked_at_utc)
  WHERE deleted_at IS NULL AND disposition = 'active';
-- recent captures feed
CREATE INDEX ix_txn_captured   ON transactions(captured_at_utc DESC) WHERE deleted_at IS NULL;
-- hold expiry sweep
CREATE INDEX ix_txn_holds      ON transactions(booked_at_utc)
  WHERE clearing_state = 'authorized' AND deleted_at IS NULL;
-- passive-capture duplicate suppression
CREATE UNIQUE INDEX ux_txn_dedupe ON transactions(dedupe_hash)
  WHERE dedupe_hash IS NOT NULL AND deleted_at IS NULL AND disposition = 'active';
```

#### 3.5.1 Why time needs four concepts

`booked_local_date` is stored, not computed, and it is the grouping key for **every** budget and
report. A 08:00 breakfast in Tokyo is 23:00 UTC the previous day and lands in yesterday's budget;
a 20:00 dinner in Honolulu is 06:00 UTC the next day and lands in tomorrow's. Both directions
fail, and they fail exactly for the travelling user who is the reason multi-currency exists.
Local date alone is equally broken — you cannot order two transactions across a timezone change —
hence storing both. Recomputing from `booked_at_utc + booked_tz` on every query is impossible in
SQLite (no IANA arithmetic) and, worse, would silently move historical rows between months after a
tzdata update; `meta.tzdata_version` records which rules were in force.

`booked_month` is a `STORED` generated column rather than a `strftime()` expression precisely
because a stored column is indexable. The `GLOB` CHECK on `booked_local_date` is not decoration:
`substr(NULL,1,7)` is NULL, which would silently drop rows from every month-grouped report.

#### 3.5.2 The reporting predicate, defined exactly once

Every spend total, budget actual and category rollup in the app uses **this predicate and no
other**. It is a single shared constant in the repository:

```sql
    deleted_at IS NULL
AND disposition = 'active'
AND clearing_state IN ('authorized','settled','disputed','chargeback_lost')
```

`authorized` counts because users want the coffee to appear immediately — which is exactly why
`expired` must exist to take phantom holds back out. `unconfirmed`/`needs_review` rows **do**
count, with a visible "N unreviewed" affordance: quarantining them makes the app lie about the
user's balance, which is worse than including a number that is 80% likely right and clearly
marked. Only `draft` (mid-edit, may be unbalanced) is excluded, via `disposition`/`confirm_state`.

---

### 3.6 transaction_events — the append-only log

```sql
CREATE TABLE transaction_events (
  id             TEXT PRIMARY KEY,
  txn_id         TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL CHECK (seq >= 1),   -- per-transaction monotonic
  kind           TEXT NOT NULL CHECK (kind IN (
                   'CREATED','AUTH_OBSERVED','SETTLE_OBSERVED','SETTLE_MATCHED',
                   'AMOUNT_ASSERTED','FIELD_REVISED','USER_VALUE_SUPERSEDED',
                   'REVERSAL_OBSERVED','HOLD_TTL_ELAPSED','LATE_SETTLE_MATCHED',
                   'DISPUTE_OPENED','DISPUTE_RESOLVED',
                   'MERGED','UNMERGED','LINKED','UNLINKED',
                   'USER_CONFIRMED','VOIDED','RECONCILED','REPLAY_APPLIED','REPLAY_UNDONE')),
  payload_json   TEXT NOT NULL,       -- e.g. {"amount_minor":2750,"currency":"MXN","prev":2500}
  observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
  actor          TEXT NOT NULL,       -- 'system' | 'user' | 'replay:<run_id>'
  hlc            TEXT NOT NULL,
  node_id        TEXT NOT NULL,
  occurred_at    INTEGER NOT NULL,
  UNIQUE (txn_id, seq)
) STRICT;

CREATE INDEX ix_txn_events_time ON transaction_events(occurred_at DESC);
CREATE INDEX ix_txn_events_kind ON transaction_events(kind, occurred_at DESC);
```

Append-only is enforced by `trg_transaction_events_immutable` (§3.19). Because this table plus
`raw_captures`, `extraction_runs`, `entries`, `transaction_links` and `oplog` are all append-only,
incremental export is `WHERE id > :watermark` — the event log doubles as the backup format, which
is exactly what the no-cloud constraint needs.

---

### 3.7 entries — the ledger, and the balance seal

Real double entry, balanced **per currency**, hidden behind a flat façade. The model still emits
flat JSON (`{merchant, total, currency, date, category, line_items[]}`); a pure
`buildEntries(draft) → Entry[]` function expands it into postings; neither the model nor the UI
ever sees the ledger. What it buys is one invariant that catches every arithmetic bug the app can
produce, including the ones an 0.80-F1 extractor generates.

**Per currency, not in a base currency.** `SUM(reporting_amount) = 0` is tempting and wrong:
converting each leg independently produces rounding residuals, so the sum is off by a minor unit
or two on a large fraction of cross-currency transactions and the constraint could never hold.
*Rejected: Agent 5's `SUM(home_amount_minor) = 0` trigger.*

```sql
CREATE TABLE entries (
  id            TEXT PRIMARY KEY,
  txn_id        TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  leg_index     INTEGER NOT NULL CHECK (leg_index >= 0),
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  role          TEXT NOT NULL CHECK (role IN (
                  'source','destination','category','fee','fx_conversion',
                  'imbalance','clearing','receivable','payable','opening_balance')),

  -- The leg IN ITS OWN CURRENCY. This is the column the balance invariant sums.
  amount_minor      INTEGER NOT NULL
    CHECK (amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  currency_code     TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  currency_exponent INTEGER NOT NULL CHECK (currency_exponent BETWEEN 0 AND 8),

  -- What actually moved IN THE ACCOUNT'S CURRENCY — the SETTLEMENT conversion, done by the
  -- bank, immutable ground truth. Distinct from the REPORTING conversion on the header.
  -- A Tokyo purchase on a USD card by a EUR-reporting user has three currencies: JPY (the
  -- receipt), USD (what the card moved, at the issuer's rate including spread), EUR (the report).
  account_amount_minor  INTEGER NOT NULL
    CHECK (account_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  account_currency_code TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  account_exponent      INTEGER NOT NULL CHECK (account_exponent BETWEEN 0 AND 8),
  settle_rate_num       INTEGER CHECK (settle_rate_num IS NULL OR settle_rate_num > 0),
  settle_rate_den       INTEGER CHECK (settle_rate_den IS NULL OR settle_rate_den > 0),
  settle_rate_source    TEXT CHECK (settle_rate_source IS NULL OR
                          settle_rate_source IN ('actual','derived','manual')),

  -- Issuer FX fee booked onto the leg in the ACCOUNT's currency, so "what did FX actually
  -- cost me" is a SUM rather than a reconstruction.
  fee_minor     INTEGER NOT NULL DEFAULT 0
    CHECK (fee_minor BETWEEN -9007199254740991 AND 9007199254740991),
  memo          TEXT,
  -- The two legs of a cross-currency conversion against sys_fx_conversion are never rendered.
  is_auto_balance INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_balance IN (0,1)),

  -- Denormalized from the header. Deliberate: category-by-month and account-balance-by-month
  -- are the two hottest queries and joining to transactions for a date on every one of them
  -- is the difference between a 5 ms and a 60 ms budget screen. Paid for with a coherence
  -- trigger + the startup sweep, not with hope.
  booked_local_date TEXT NOT NULL
    CHECK (booked_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  booked_month      TEXT GENERATED ALWAYS AS (substr(booked_local_date,1,7)) STORED,

  hlc TEXT NOT NULL, node_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,

  UNIQUE (txn_id, leg_index),

  -- A leg whose currency differs from its account's currency MUST carry the settlement rate
  -- that reconciles them. Makes the three-currency case structurally impossible to get
  -- half-right.
  CHECK ((account_currency_code = currency_code AND account_amount_minor = amount_minor)
         OR (settle_rate_num IS NOT NULL AND settle_rate_den IS NOT NULL))
) STRICT;

CREATE INDEX ix_entries_txn        ON entries(txn_id, leg_index);
CREATE INDEX ix_entries_acct_date  ON entries(account_id, booked_local_date);
CREATE INDEX ix_entries_acct_month ON entries(account_id, booked_month);
-- the "needs attention" queue is literally this
CREATE INDEX ix_entries_imbalance  ON entries(txn_id) WHERE account_id = 'sys_imbalance';
```

There is no `deleted_at` on `entries`: legs live and die with their header, which is soft-deleted.

#### 3.7.1 The balance seal — an honest guard, not a deferred constraint

SQLite has **no deferred constraint triggers** (only foreign keys can be deferred) and a `CHECK`
cannot span rows, so an `AFTER INSERT ON entries` trigger would fire mid-write on the first leg
and always fail. The seal pattern below is the closest implementable thing:

```sql
-- The repository's writeTransaction() inserts exactly one row here as the LAST statement
-- before COMMIT. That insert is what runs the verification.
CREATE TABLE transaction_seals (
  txn_id    TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  sealed_at INTEGER NOT NULL,
  leg_count INTEGER NOT NULL CHECK (leg_count > 0)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER trg_transaction_seal_verify
AFTER INSERT ON transaction_seals
BEGIN
  -- RAISE(ROLLBACK), not RAISE(ABORT). ABORT rolls back only the current STATEMENT and leaves
  -- the enclosing transaction open — a repository that swallowed the error would commit a
  -- half-written ledger. ROLLBACK unwinds the whole transaction; the repository must treat a
  -- SQLITE_CONSTRAINT from a seal as "already rolled back" and not attempt COMMIT.
  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM entries e
       WHERE e.txn_id = NEW.txn_id
       GROUP BY e.currency_code
      HAVING SUM(e.amount_minor) <> 0)
    THEN RAISE(ROLLBACK, 'seal: entries do not sum to zero per currency') END;

  SELECT CASE WHEN (SELECT COUNT(*) FROM entries e WHERE e.txn_id = NEW.txn_id) <> NEW.leg_count
    THEN RAISE(ROLLBACK, 'seal: leg_count does not match entry count') END;

  SELECT CASE WHEN (SELECT COUNT(*) FROM entries e WHERE e.txn_id = NEW.txn_id) = 0
    THEN RAISE(ROLLBACK, 'seal: transaction has no entries') END;
END;

-- Companion guards: once sealed, the leg set is frozen. Any write path that adds, changes or
-- removes a leg after the seal — a migration script, a debug tool, a future import feature —
-- fails loudly instead of silently unbalancing the ledger. To edit a sealed transaction the
-- repository DELETEs the seal row inside the same BEGIN, mutates, and re-inserts it.
CREATE TRIGGER trg_entries_insert_after_seal
BEFORE INSERT ON entries
WHEN EXISTS (SELECT 1 FROM transaction_seals s WHERE s.txn_id = NEW.txn_id)
BEGIN
  SELECT RAISE(ROLLBACK, 'ledger: cannot add a leg to a sealed transaction; unseal first');
END;

-- booked_local_date is in the watch list deliberately: it drives the STORED booked_month
-- generated column and ix_entries_acct_month, so editing it after the seal would silently
-- change indexed ledger data while sealed_at still asserts the transaction was verified in
-- its previous state. A header date edit therefore follows the same protocol as every other
-- ledger mutation: unseal -> update header (the propagate trigger rewrites the legs) -> re-seal.
CREATE TRIGGER trg_entries_update_after_seal
BEFORE UPDATE OF amount_minor, currency_code, currency_exponent, account_id,
                 booked_local_date ON entries
WHEN EXISTS (SELECT 1 FROM transaction_seals s WHERE s.txn_id = NEW.txn_id)
BEGIN
  SELECT RAISE(ROLLBACK, 'ledger: cannot change a leg on a sealed transaction; unseal first');
END;

CREATE TRIGGER trg_entries_delete_after_seal
BEFORE DELETE ON entries
WHEN EXISTS (SELECT 1 FROM transaction_seals s WHERE s.txn_id = OLD.txn_id)
BEGIN
  SELECT RAISE(ROLLBACK, 'ledger: cannot remove a leg from a sealed transaction; unseal first');
END;
```

**Be honest about what this is.** It is a *seal-time* check the repository must call, not a
deferred constraint: a write path that never inserts a seal row passes silently. Two things close
the gap and both are mandatory:

- The three companion triggers above make *entries-after-seal* an error, so the common failure
  (a second code path appending a leg later) is caught.
- The **startup integrity sweep** (§3.21) runs the same `GROUP BY … HAVING` across all
  transactions plus a "sealed?" check, writes offenders to a repair queue and shows a
  user-visible banner. That sweep, not the trigger, is the actual safety net.

Drafts are never left unbalanced: the repository emits an auto-generated leg against
`sys_imbalance` (`is_auto_balance = 1`) absorbing any residual while the user is mid-edit.

#### 3.7.2 Worked example — a cross-currency transfer

A €920 transfer out of a EUR account into a USD account that received $1,000. One transaction,
four legs, each currency summing to zero, with the FX position accumulating in equity where it
belongs:

| leg | account | role | amount_minor | currency |
| --- | --- | --- | --- | --- |
| 0 | Checking (EUR) | `source` | −92000 | EUR |
| 1 | `sys_fx_conversion` | `fx_conversion` | +92000 | EUR |
| 2 | `sys_fx_conversion` | `fx_conversion` | −100000 | USD |
| 3 | Savings (USD) | `destination` | +100000 | USD |

EUR sums to 0, USD sums to 0. Legs 1 and 2 carry `is_auto_balance = 1` and are never rendered.
Net worth is `SUM` over asset/liability accounts and the transfer contributes zero automatically —
there is no `WHERE kind <> 'transfer'` anywhere in the codebase, which is the entire point.

---

### 3.8 line_items

```sql
CREATE TABLE line_items (
  id            TEXT PRIMARY KEY,
  txn_id        TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  -- Set once the user splits the receipt across categories. AUTHORITATIVE for money.
  entry_id      TEXT REFERENCES entries(id) ON DELETE SET NULL,
  line_index    INTEGER NOT NULL CHECK (line_index >= 0),

  raw_text      TEXT,                 -- the OCR line, verbatim
  description   TEXT,
  -- 1000 = 1.000 unit. Handles 0.250 kg of cheese without a float.
  quantity_milli   INTEGER CHECK (quantity_milli IS NULL OR quantity_milli >= 0),
  unit_price_minor INTEGER
    CHECK (unit_price_minor IS NULL OR unit_price_minor BETWEEN -9007199254740991 AND 9007199254740991),
  amount_minor  INTEGER NOT NULL
    CHECK (amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  currency_code     TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  currency_exponent INTEGER NOT NULL CHECK (currency_exponent BETWEEN 0 AND 8),

  -- Without this, the extractor's "SUBTOTAL 42.00" line gets summed as an item and doubles
  -- the receipt. This enum is not optional.
  line_type     TEXT NOT NULL DEFAULT 'item' CHECK (line_type IN (
                  'item','tax','tip','discount','service_charge','deposit',
                  'rounding','subtotal','total','unknown')),
  tax_rate_bp   INTEGER CHECK (tax_rate_bp IS NULL OR tax_rate_bp BETWEEN 0 AND 100000), -- 2100 = 21%

  suggested_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,  -- advisory only
  confidence    REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  -- OCR bounding box, so tapping a line highlights the source region on the photo. The single
  -- highest-leverage correction affordance for a pipeline whose normal path is user correction.
  bbox_json     TEXT,

  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (txn_id, line_index)
) STRICT;

CREATE INDEX ix_line_items_entry ON line_items(entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX ix_line_items_type  ON line_items(txn_id, line_type);
```

**Deliberately no CHECK that line items sum to the transaction total.** At 0.80 F1 plus real
receipts carrying tax/tip/discount/rounding lines, a hard constraint rejects a large fraction of
genuine input. Reconciliation is soft: `transactions.line_items_delta_minor` records
`total − SUM(items where line_type='item')` and `needs_review` flags it.

---

### 3.9 transaction_links and installment_plans

Reversal before settlement is a **state change**; refund after settlement is a **separate linked
transaction**. Getting that backwards produces either phantom income (a counter-transaction for
money that never left the account) or retroactively mutated closed months.

```sql
CREATE TABLE transaction_links (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN (
                         'REFUND_OF','REVERSAL_OF','TRANSFER_COUNTERPART','INSTALLMENT_OF',
                         'SPLIT_OF','DUPLICATE_OF','CHARGEBACK_CREDIT_FOR','ADJUSTMENT_OF')),
  from_transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  to_transaction_id    TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  -- Partial refunds are N:1 by construction: several REFUND_OF links, each with its own amount.
  -- net = effective_amount_minor - SUM(refund links). Guard: SUM(refunds) > original means the
  -- refund was almost certainly linked to the wrong purchase -> flag, never allow negative net.
  amount_minor         INTEGER
    CHECK (amount_minor IS NULL OR amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  currency_code        TEXT REFERENCES currencies(code),
  confidence           REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  created_by           TEXT NOT NULL CHECK (created_by IN ('system','user','replay')),
  created_at           INTEGER NOT NULL,
  UNIQUE (kind, from_transaction_id, to_transaction_id),
  CHECK (from_transaction_id <> to_transaction_id)
) STRICT;

CREATE INDEX ix_txn_links_to ON transaction_links(to_transaction_id, kind);

-- LATAM "meses sin intereses" / MSI. One purchase generates N monthly card charges with the
-- same amount, same merchant and a ~monthly cadence — which sits exactly in the blast radius of
-- naive dedupe AND of naive spend reporting.
-- SPEND is accrual: recognised once, in full, on the purchase date.
-- CASH FLOW is the installment schedule. Two queries over the same rows; the link type is what
-- makes both correct.
CREATE TABLE installment_plans (
  id                       TEXT PRIMARY KEY,
  origin_transaction_id    TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id               TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  n_installments           INTEGER NOT NULL CHECK (n_installments >= 2),
  installment_amount_minor INTEGER NOT NULL
    CHECK (installment_amount_minor BETWEEN 0 AND 9007199254740991),
  currency_code            TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  currency_exponent        INTEGER NOT NULL CHECK (currency_exponent BETWEEN 0 AND 8),
  first_due_date           TEXT NOT NULL
    CHECK (first_due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  interest_minor           INTEGER NOT NULL DEFAULT 0,
  plan_marker              TEXT,     -- the literal text that triggered detection: 'a 12 meses','MSI','x12'
  status                   TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_installments_active ON installment_plans(account_id, status) WHERE status = 'active';
```

---

### 3.10 Capture and staging

The producers (Android `NotificationListenerService`, the iOS Share Extension, the iOS App Intent)
**never touch SQLite**. They write an atomically-renamed, sealed file into a spool directory
(Android: `createDeviceProtectedStorageContext().getFilesDir()/spool/`; iOS: the App Group
container at `NSFileProtectionCompleteUntilFirstUserAuthentication`). The main app drains the
spool into `raw_captures`. The database file itself stays in the app's own container and is never
reachable from a second process — SQLCipher + WAL inside an iOS App Group container is a
deterministic `0xdead10cc` termination on every backgrounding.

```sql
CREATE TABLE raw_captures (
  id             TEXT PRIMARY KEY,             -- UUIDv7, generated by the PRODUCER
  -- ── exact delivery idempotency. Layer 1 of two; NO fuzziness ever happens here. ──────
  -- Must contain an OS-assigned timestamp, never the app's own receipt time:
  --   android_notification: sha256(package || sbn.getKey() || sbn.getPostTime() || canonical_text)
  --   android_sms:          sha256(sender_address || sms.date_ms || body)
  --   ios_share/shortcut:   sha256(content_sha256 || extension_invocation_uuid)
  --   camera/photo:         sha256(image_bytes)
  -- getPostTime() is preserved when a notification is re-delivered via getActiveNotifications()
  -- on rebind, so re-delivery is byte-identical; two genuine coffees three minutes apart carry
  -- different postTimes and therefore different keys. Omitting postTime merges the two coffees;
  -- using System.currentTimeMillis() duplicates every re-delivery.
  dedupe_key     TEXT NOT NULL,                -- 64 lowercase hex
  content_hash   TEXT NOT NULL,                -- payload only, no timestamps — for "you already
                                               -- imported this" prompts on iOS

  source_channel TEXT NOT NULL CHECK (source_channel IN (
                   'android_notification','android_notification_sms','android_sms',
                   'ios_share','ios_shortcut','ios_wallet_intent',
                   'screenshot_ocr','camera_receipt','voice','manual_text',
                   'file_import','statement_import')),
  source_app     TEXT,                         -- package name / bundle id / SMS sender address
  source_ref     TEXT,                         -- sbn.key | Telephony.Sms._ID | PHAsset id.
                                               -- NOT stable across backup/restore, so never a key.

  spooled_at     INTEGER NOT NULL,             -- producer clock
  delivered_at   INTEGER,                      -- OS-assigned: postTime / sms.date
  event_at_hint  INTEGER,                      -- from the payload: EXIF DateTimeOriginal, in-body time
  received_at    INTEGER NOT NULL,             -- when the drain wrote this row
  tz             TEXT NOT NULL,                -- IANA at capture
  utc_offset_min INTEGER NOT NULL,
  device_locale  TEXT,
  device_region  TEXT,                         -- currency-disambiguation inputs

  payload_kind   TEXT NOT NULL CHECK (payload_kind IN ('text','image','audio','json')),
  -- VERBATIM. Never normalized, never trimmed. This is the re-extraction source, the redaction
  -- evidence, and the FunctionGemma-270M fine-tuning corpus.
  payload_text   TEXT,
  payload_meta_json TEXT,                      -- notification extras keyed by their android.* names,
                                               -- EXIF, Wallet intent parameters, sender, SIM sub_id
  notification_template TEXT,                  -- EXTRA_TEMPLATE: tells you which Style was used
  media_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,

  -- Android 15+ redacts "sensitive" notifications for third-party listeners: EXTRA_TITLE becomes
  -- the posting app's label and EXTRA_TEXT becomes "Sensitive notification content hidden".
  -- There is NO public API to detect it (Ranking has no hasSensitiveContent() through API 36),
  -- so this is heuristic: title == packageManager.getApplicationLabel() AND sub_text and
  -- text_lines both absent.
  redaction_suspected INTEGER NOT NULL DEFAULT 0 CHECK (redaction_suspected IN (0,1)),

  seen_count     INTEGER NOT NULL DEFAULT 1,   -- re-delivery storms are observable, not silent
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,

  process_state  TEXT NOT NULL DEFAULT 'queued' CHECK (process_state IN (
                   'queued','in_flight','parsed','unparseable',
                   -- first-class, NOT an error: the model may not be downloaded yet, may have
                   -- been deleted by the user to free space, or may have OOMed. Captures queue
                   -- indefinitely and drain when the engine becomes available.
                   'deferred_no_model',
                   'ignored',      -- filtered at ingest (OTP, non-financial sender)
                   'redacted',     -- Android 15 redaction: nothing extractable arrived
                   'purged')),     -- retention ran: body gone, row and hashes retained
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,                     -- backoff 1m/5m/30m/6h/24h then park
  last_error     TEXT,

  -- Consent SNAPSHOT at capture time, not a live join to a settings row: consent state at the
  -- moment of capture is the meaningful fact, and a later toggle must not retroactively
  -- relicense data already collected.
  training_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (training_opt_in IN (0,1)),
  purge_after     INTEGER,                     -- NULL = exempt (training-retained)
  purged_at       INTEGER,

  schema_version  INTEGER NOT NULL DEFAULT 1,
  app_version_code INTEGER,
  os_build        TEXT
) STRICT;

CREATE UNIQUE INDEX ux_raw_captures_dedupe ON raw_captures(dedupe_key);
CREATE INDEX ix_raw_captures_queue   ON raw_captures(next_attempt_at)
  WHERE process_state IN ('queued','deferred_no_model');
CREATE INDEX ix_raw_captures_state   ON raw_captures(process_state, received_at DESC);
CREATE INDEX ix_raw_captures_purge   ON raw_captures(purge_after) WHERE purged_at IS NULL;
CREATE INDEX ix_raw_captures_content ON raw_captures(content_hash);
CREATE INDEX ix_raw_captures_channel ON raw_captures(source_channel, source_app, received_at DESC);
```

**Purge redacts in place; it never deletes the row.** Deleting would let a device rescan re-import
the same message as new, and would orphan the audit chain. The purge statement is exactly:

```sql
UPDATE raw_captures
   SET payload_text = NULL, media_asset_id = NULL,
       process_state = 'purged', purged_at = :now
 WHERE id = :id;
UPDATE corrections SET training_eligible = 0 WHERE raw_capture_id = :id;
```

The second statement is the half everyone forgets: a `corrections` row is only a training example
if its **input** still exists. Purge the text and keep the label and the dataset silently rots.
`training_opt_in = 1` sets `purge_after = NULL`, and the consent copy must literally say *"these
stay on your device until you turn this off."*

```sql
-- Media lives on the FILESYSTEM, never as a BLOB. Receipt images, not rows, drive database size:
-- a transaction row is a few hundred bytes; one dewarped receipt JPEG is 200 KB-1 MB. BLOBs
-- would also mean SQLCipher encrypting megabytes on every touch and multi-minute VACUUMs.
CREATE TABLE media_assets (
  id            TEXT PRIMARY KEY,
  -- RELATIVE to the media root, never absolute: iOS rewrites the app container UUID on restore
  -- and every absolute path breaks. Layout: media/<yyyy>/<mm>/<uuidv7>.jpg
  rel_path      TEXT NOT NULL UNIQUE,
  sha256_hex    TEXT NOT NULL,        -- integrity, dedup, and broken-restore detection
  bytes         INTEGER NOT NULL CHECK (bytes >= 0),
  mime          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'receipt_image','screenshot','voice_audio','statement_pdf','thumbnail')),
  width         INTEGER, height INTEGER,
  thumbnail_of  TEXT REFERENCES media_assets(id) ON DELETE CASCADE,
  -- "free up space" deletes originals while retaining thumbnails and the extracted data
  original_deleted_at INTEGER,
  -- weekly reconciliation both ways: files with no row are orphans (delete after 24 h grace);
  -- rows whose file is gone get flagged here, never deleted — the extraction record is still
  -- valid audit.
  missing_since INTEGER,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_media_sha  ON media_assets(sha256_hex);
CREATE INDEX ix_media_kind ON media_assets(kind, created_at DESC);
CREATE INDEX ix_media_missing ON media_assets(missing_since) WHERE missing_since IS NOT NULL;
```

**The export/backup path must bundle the `.db` *and* the media directory or the restore is
silently incomplete.** That is a correctness requirement, not a nicety, because there is no cloud
copy.

#### 3.10.1 The ingest filter — never lose a capture, never persist an OTP

```sql
-- Enforced in the PRODUCER, before anything is spooled. Non-matching notifications and personal
-- SMS are never written at all — filter before insert, not after. That is both a privacy
-- property and the strongest sentence in the Play SMS declaration.
CREATE TABLE capture_senders (
  id             TEXT PRIMARY KEY,
  channel        TEXT NOT NULL CHECK (channel IN
                   ('android_notification','android_sms','ios_wallet_intent')),
  identifier     TEXT NOT NULL,          -- package name or normalized SMS sender address
  display_name   TEXT,
  enabled        INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  is_financial   INTEGER NOT NULL DEFAULT 0 CHECK (is_financial IN (0,1)),
  -- measured per bank, from day one, so redaction is a known property and not a platform mystery
  redaction_count   INTEGER NOT NULL DEFAULT 0,
  unsupported_count INTEGER NOT NULL DEFAULT 0,   -- fully-custom RemoteViews: nothing readable
  capture_count     INTEGER NOT NULL DEFAULT 0,
  -- user-initiated, time-boxed (24 h), per-sender "capture everything verbatim" switch for
  -- "my bank's messages aren't showing up". Expires automatically.
  diagnostics_until INTEGER,
  -- learned empirically: only start trusting balance_after as an oracle after 20 consecutive
  -- continuous observations; stop if the break rate exceeds 20%.
  balance_trusted   INTEGER NOT NULL DEFAULT 0 CHECK (balance_trusted IN (0,1)),
  last_seen_at   INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (channel, identifier)
) STRICT;
```

Rejected captures are still **recorded** — `process_state = 'ignored'` with `dedupe_key`,
`content_hash`, sender, length and reason, but `payload_text = NULL`. Idempotency survives (a
rescan will not reprocess) and OTPs never hit disk. One exception protects against a wrong filter:
for senders that *are* on the financial list but fail the amount-pattern test, the body **is**
retained so a wrongly-rejected real transaction is recoverable and replayable.

#### 3.10.2 observations — the join between a capture and a transaction

```sql
-- An "observation" is (raw_capture, its current extraction) with a derived role. This is the
-- table the dedupe engine actually operates on, and it is what makes unmerge possible: merging
-- repoints observation.txn_id, it never destroys history.
CREATE TABLE observations (
  id             TEXT PRIMARY KEY,
  raw_capture_id TEXT NOT NULL REFERENCES raw_captures(id) ON DELETE RESTRICT,
  extraction_id  TEXT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  txn_id         TEXT REFERENCES transactions(id) ON DELETE SET NULL,

  source_channel TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN (
                   'bank_auth','bank_settle','bank_statement','merchant_receipt',
                   'user_manual','voice','wallet_tap')),

  account_id     TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  card_last4     TEXT CHECK (card_last4 IS NULL OR card_last4 GLOB '[0-9][0-9][0-9][0-9]'),
  -- auth code / RRN / ARN / receipt folio / CFDI UUID, normalized. Gate G3 in §3.12: if both
  -- sides carry one and they differ, merging is FORBIDDEN regardless of score. This is what
  -- definitively separates two coffees.
  strong_ref     TEXT,

  amount_minor      INTEGER
    CHECK (amount_minor IS NULL OR amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  currency_code     TEXT REFERENCES currencies(code),
  currency_exponent INTEGER CHECK (currency_exponent IS NULL OR currency_exponent BETWEEN 0 AND 8),
  -- running balance when the message carries one. The only correctness oracle in the whole
  -- design that can detect a capture that NEVER ARRIVED.
  balance_after_minor INTEGER
    CHECK (balance_after_minor IS NULL OR balance_after_minor BETWEEN -9007199254740991 AND 9007199254740991),

  event_at_utc   INTEGER NOT NULL,      -- notification postTime / sms.date / receipt printed
                                        -- time / auth time. NEVER the capture time.
  created_at     INTEGER NOT NULL
) STRICT;

-- RULE R2, SLOT CAPACITY, enforced by the database rather than by application code: a
-- transaction holds AT MOST ONE observation per (channel, role). A second observation for an
-- occupied slot cannot merge — it becomes a new transaction or a conflict.
CREATE UNIQUE INDEX ux_observations_slot
  ON observations(txn_id, source_channel, role) WHERE txn_id IS NOT NULL;
CREATE INDEX ix_observations_capture ON observations(raw_capture_id);
CREATE INDEX ix_observations_chain
  ON observations(account_id, event_at_utc) WHERE balance_after_minor IS NOT NULL;
CREATE INDEX ix_observations_ref ON observations(strong_ref) WHERE strong_ref IS NOT NULL;
```

---

### 3.11 Extraction, provenance, corrections, harvest

**Three provenance tables, three different questions.** Read this before trying to normalize them
together:

| Table | Question it answers | Consumer |
| --- | --- | --- |
| `transaction_fields` | *What is the current value of this field, who says so, and may a new observation overwrite it?* | merge / settlement / replay |
| `extracted_fields` | *What did run R emit for field F, with what confidence?* | calibration, "why did it say that" |
| `corrections` | *What did the user change, from what to what, and is it training-eligible?* | FunctionGemma harvest |

#### 3.11.1 extraction_runs

```sql
CREATE TABLE extraction_runs (
  id             TEXT PRIMARY KEY,
  raw_capture_id TEXT NOT NULL REFERENCES raw_captures(id) ON DELETE CASCADE,

  -- MANDATORY even for non-LLM sources, via sentinel engines. A Wallet-trigger capture and a
  -- manual entry have no model; if this table were optional every consumer would special-case
  -- NULL. With sentinels, confidence is set by PROVENANCE rather than by a model, and the audit
  -- story reads correctly: "this amount came from Apple Pay, not from a 0.80-F1 extractor."
  engine         TEXT NOT NULL CHECK (engine IN (
                   'litert_lm','apple_fm','llama_rn','self_hosted','template','ocr',
                   'wallet_app_intent','manual','rule')),
  model_id       TEXT NOT NULL,          -- 'gemma-4-E2B-it' | 'apple-fm-system' | 'n/a'
  model_version  TEXT,
  model_sha256_hex TEXT,                 -- hash of the .litert-lm actually loaded: catches silent swaps
  quantization   TEXT,                   -- 'int4' | 'q8_0' | NULL
  backend        TEXT CHECK (backend IS NULL OR backend IN ('gpu','cpu','ane','npu')),
                                         -- needed to explain latency AND quality deltas
  modality       TEXT NOT NULL CHECK (modality IN ('text','image','audio','none')),
  prompt_version TEXT NOT NULL,          -- 'receipt.v7' — bump on ANY prompt edit, no exceptions
  schema_version TEXT NOT NULL,          -- 'expense.v3'
  taxonomy_version TEXT NOT NULL,        -- so a taxonomy change cannot silently poison the corpus
  decode_params_json TEXT,               -- temperature, top_k, seed, max_tokens

  -- monotonic; higher = newer pipeline. Drives the replay selection predicate.
  pipeline_id    TEXT NOT NULL,          -- 'llm:gemma4-e2b/0.13/p7/s4' | 'tmpl:bbva_mx/f3a19c@2'
  pipeline_rank  INTEGER NOT NULL,

  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  latency_ms     INTEGER,

  status         TEXT NOT NULL CHECK (status IN (
                   'ok','partial','json_invalid','schema_invalid','refused',
                   'oom','timeout','cancelled','no_model','not_financial')),
  raw_output     TEXT,                   -- VERBATIM model output before parsing. The audit anchor.
  -- compact JSON map keyed by RFC 6901 pointer: {"/total":0.93,"/merchant":0.71}. Queryable
  -- with json_extract(). Avoids materializing 80+ rows for a 20-line receipt.
  field_confidence_json TEXT,
  overall_confidence REAL
    CHECK (overall_confidence IS NULL OR (overall_confidence >= 0.0 AND overall_confidence <= 1.0)),
  -- Which fields were actually RENDERED on the confirm sheet. Without this you cannot tell
  -- "user accepted" from "user never saw it", and the correction dataset silently trains the
  -- model to repeat errors nobody looked at.
  fields_shown_json TEXT,

  -- the OCR+text -> VLM escalation chain, end to end auditable
  escalated_from_id TEXT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  escalation_reason TEXT CHECK (escalation_reason IS NULL OR escalation_reason IN (
                      'low_ocr_confidence','missing_required_field','total_mismatch',
                      'user_requested','template_disagreement')),

  is_current     INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  superseded_by  TEXT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  replay_run_id  TEXT REFERENCES replay_runs(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX ix_extraction_capture ON extraction_runs(raw_capture_id, is_current);
CREATE INDEX ix_extraction_pipeline ON extraction_runs(pipeline_id, started_at DESC);
CREATE INDEX ix_extraction_replay ON extraction_runs(pipeline_rank)
  WHERE is_current = 1;
CREATE INDEX ix_extraction_status ON extraction_runs(status, started_at DESC)
  WHERE status <> 'ok';
```

#### 3.11.2 extracted_fields

```sql
-- Materialize the CANONICAL SET ONLY (~7 rows/capture) plus, lazily, any deeper path a
-- correction touches. Everything else stays in extraction_runs.field_confidence_json.
-- Order of magnitude: 5,000 captures/year x ~7 rows ~= 35k rows, versus ~400k under full
-- materialization. What you give up is indexed range queries on per-line-item confidence —
-- acceptable, because every query that matters runs over the canonical set.
CREATE TABLE extracted_fields (
  run_id      TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  field_path  TEXT NOT NULL,      -- RFC 6901 JSON Pointer: '/total', '/line_items/3/amount'
  value_json  TEXT,               -- JSON-encoded scalar, so the TYPE survives the round trip
  confidence  REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  -- byte offsets into raw_captures.payload_text: grounding, plus the UI highlight that shows
  -- the user where a value came from
  span_start  INTEGER,
  span_end    INTEGER,
  PRIMARY KEY (run_id, field_path)
) STRICT, WITHOUT ROWID;
```

Canonical set: `/merchant`, `/total`, `/currency`, `/date`, `/tax`, `/payment_method`, `/category`.

#### 3.11.3 corrections — the fine-tuning harvest

```sql
CREATE TABLE corrections (
  id               TEXT PRIMARY KEY,
  raw_capture_id   TEXT NOT NULL REFERENCES raw_captures(id) ON DELETE CASCADE,
  txn_id           TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  -- NATURAL KEY (run_id, field_path). A correction links even when no extracted_fields row was
  -- ever materialized — which is exactly what makes the pruning strategy above safe.
  run_id           TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  field_path       TEXT NOT NULL,       -- same RFC 6901 pointer namespace

  old_value_json   TEXT,                -- what the model said; NULL = the model omitted the field
  new_value_json   TEXT,                -- what the user committed; NULL = user deleted a hallucination
  -- Denormalized so it survives extracted_fields pruning and enables calibration curves.
  old_confidence   REAL,
  correction_kind  TEXT NOT NULL CHECK (correction_kind IN (
                     'edit','fill_missing','delete_hallucination','reject_all','accept_all')),
  -- later edits are WEAKER training labels than confirm-sheet edits; weight them differently
  ui_surface       TEXT CHECK (ui_surface IS NULL OR ui_surface IN
                     ('confirm_sheet','later_edit','bulk_review','verify_carefully')),
  training_eligible INTEGER NOT NULL DEFAULT 1 CHECK (training_eligible IN (0,1)),
  corrected_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_corrections_run   ON corrections(run_id, field_path);
CREATE INDEX ix_corrections_field ON corrections(field_path, corrected_at DESC);
CREATE INDEX ix_corrections_train ON corrections(raw_capture_id)
  WHERE training_eligible = 1;
```

Accepts are **not** stored as rows: a confirmed capture with no correction row for field X means
the model was right about X. Derivable, zero storage. The one exception is a single
`correction_kind = 'accept_all'` row carrying the final accepted payload, written on confirm —
accepted-unchanged fields are as valuable a label as corrected ones, and this is the cheapest way
to record them.

`corrections` grouped by `field_path` is also the live product metric. If `/currency` is corrected
30% of the time, the currency-detection ladder is the thing to fix, and you know that from the
schema rather than from a guess.

#### 3.11.4 transaction_fields — current value provenance

```sql
-- TWO provenance columns, not one. One column cannot express "the model re-read a bank
-- settlement message" versus "the model read a photographed receipt", and the replay rule
-- breaks either way if you collapse them.
CREATE TABLE transaction_fields (
  txn_id              TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  field               TEXT NOT NULL,     -- 'amount' | 'currency' | 'occurred_at' | 'account_id'
                                         -- | 'direction' | 'merchant_id' | 'category_id' | 'note'
  value_json          TEXT NOT NULL,

  -- WHO produced the value
  value_source        TEXT NOT NULL CHECK (value_source IN
                        ('user','template','llm','vlm','asr_llm','ocr','import','derived')),
  value_source_rank   INTEGER NOT NULL,  -- monotonic with pipeline quality

  -- HOW AUTHORITATIVE the underlying evidence is
  evidence_authority  TEXT NOT NULL CHECK (evidence_authority IN
                        ('statement_line','bank_settlement','bank_auth','merchant_receipt',
                         'user_assertion','inference')),
  authority_rank      INTEGER NOT NULL CHECK (authority_rank IN (60,50,40,30,20,10)),
  observation_id      TEXT REFERENCES observations(id) ON DELETE SET NULL,

  pinned_by_user      INTEGER NOT NULL DEFAULT 0 CHECK (pinned_by_user IN (0,1)),
  pinned_at_authority INTEGER,
  observed_at         INTEGER NOT NULL,
  PRIMARY KEY (txn_id, field)
) STRICT, WITHOUT ROWID;
```

Fields are partitioned. **Bank-authoritative:** `amount`, `currency`, `occurred_at`, `account_id`,
`direction`, `clearing_state`, the FX original amount/currency. **User-authoritative:** `category`,
merchant display label, `note`, tags, splits, budget assignment, exclude-from-reports.

The replacement rule is one function used by merge, by settlement arrival and by replay:

```text
if field ∈ USER_AUTHORITATIVE and pinned_by_user      -> reject, always
if field ∈ BANK_AUTHORITATIVE and pinned_by_user      -> accept only if
                                                          new.authority_rank > pinned_at_authority;
                                                         emit USER_VALUE_SUPERSEDED and surface it
                                                         ("settled at 27.50 — you entered 25.00")
else accept if new.authority_rank > cur.authority_rank
       OR (new.authority_rank == cur.authority_rank
           AND new.value_source_rank >= cur.value_source_rank
           AND new.observed_at      >= cur.observed_at)
```

The equal-authority branch is exactly what makes replay safe: re-extracting the **same** bank
settlement message with a newer model (higher `value_source_rank`, identical `authority_rank`) is
allowed and fixes a misparse; re-extracting a merchant receipt can never clobber a settlement
amount, because authority 30 < 50.

**Large disagreements are conflicts, not precedence.** Receipt says 27.50, SMS says 275.00 — that
is a decimal-separator misparse, and silently applying precedence is how a 1000x error becomes
permanent:

```sql
CREATE TABLE field_conflicts (
  id           TEXT PRIMARY KEY,
  txn_id       TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  field        TEXT NOT NULL,
  value_a_json TEXT NOT NULL, observation_a TEXT REFERENCES observations(id),
  value_b_json TEXT NOT NULL, observation_b TEXT REFERENCES observations(id),
  status       TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved_a','resolved_b','resolved_other','dismissed')),
  detected_at  INTEGER NOT NULL, resolved_at INTEGER
) STRICT;

CREATE INDEX ix_field_conflicts_open ON field_conflicts(txn_id) WHERE status = 'open';
```

#### 3.11.5 replay_runs and training_exports

```sql
-- A model / prompt / output-schema version bump creates one of these. Every replayed field
-- change writes a FIELD_REVISED event, so the whole run is undoable as a unit for 7 days.
CREATE TABLE replay_runs (
  id                TEXT PRIMARY KEY,
  reason            TEXT NOT NULL CHECK (reason IN
                      ('model_upgrade','prompt_change','schema_change','template_promoted','manual')),
  from_pipeline_rank INTEGER NOT NULL,
  to_pipeline_rank   INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  captures_total    INTEGER NOT NULL DEFAULT 0,
  captures_changed  INTEGER NOT NULL DEFAULT 0,
  -- resumable watermark: run on charger + Wi-Fi + screen-off, chunked, cancellable
  last_capture_id   TEXT,
  state             TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running','paused','done','cancelled','undone')),
  undo_deadline     INTEGER
) STRICT;

-- Exports are IMMUTABLE SNAPSHOTS stored outside the app; the fine-tune concatenates snapshots
-- rather than re-querying the device. Without this, a later re-export after a purge silently
-- produces a smaller, differently-distributed dataset and the fine-tune is non-reproducible.
CREATE TABLE training_exports (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  schema_version   TEXT NOT NULL,
  prompt_versions  TEXT NOT NULL,      -- JSON array of the compatible set the query filtered on
  row_count        INTEGER NOT NULL,
  jsonl_sha256_hex TEXT NOT NULL,
  capture_ids_json TEXT NOT NULL,      -- exactly which captures went in
  destination_note TEXT
) STRICT;
```

The replay selection predicate, stated so it is not reinvented per site:

```sql
SELECT rc.id FROM raw_captures rc
  JOIN extraction_runs er ON er.raw_capture_id = rc.id AND er.is_current = 1
  LEFT JOIN transactions t ON t.primary_capture_id = rc.id AND t.deleted_at IS NULL
 WHERE er.pipeline_rank < :new_rank
   AND (er.status <> 'ok'
        OR er.overall_confidence < 0.90
        OR t.confirm_state IN ('extracted','needs_review'))
   AND NOT EXISTS (SELECT 1 FROM transaction_fields tf
                    WHERE tf.txn_id = t.id AND tf.pinned_by_user = 1
                      AND tf.field IN ('amount','currency','occurred_at','direction'))
   AND rc.process_state <> 'purged'
 ORDER BY rc.id
 LIMIT :chunk;
```

Export line format, one per training-eligible capture — the shape the FunctionGemma Cookbook and
Unsloth notebooks already consume, so there is no conversion step:

```json
{"messages":[{"role":"user","content":"<payload_text>"},
             {"role":"assistant","content":"<corrected function-call JSON>"}],
 "meta":{"capture_id":"…","source_channel":"android_notification","prompt_version":"receipt.v7",
         "schema_version":"expense.v3","model_id":"gemma-4-E2B-it",
         "corrected_fields":["/total"],"was_fully_accepted":false}}
```

Pseudonymize **format-preservingly**, per export, with a fresh salt kept out of the archive:
card tails → a different consistent tail, account numbers → same-length digit strings, names →
same-length plausible names. Keep merchant names, amounts, currency symbols, date formats and the
bank's template wording verbatim — that *is* the signal. Replacing a card tail with `[REDACTED]`
teaches the model a token that never occurs at inference.

---

### 3.12 Dedupe and matching

Deduplication is **two unrelated problems** and conflating them is the root cause of the classic
"two coffees merged into one" bug. Layer 1 is exact delivery idempotency and lives entirely in
`raw_captures.dedupe_key` (§3.10) — no fuzziness, ever. Layer 2 is cross-channel entity resolution
and runs **only between different `source_channel` values**.

```sql
-- Every decision is recorded with its full score vector. Three uses: the audit trail when a
-- user asks "why did you merge these", the labelled local dataset for tuning weights with zero
-- telemetry, and the source of vetoes.
CREATE TABLE match_decisions (
  id             TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  candidate_txn_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('auto_merge','suggested','new','blocked')),
  blocked_by     TEXT CHECK (blocked_by IS NULL OR blocked_by IN
                   ('G1_currency','G2_direction','G3_strong_ref','G4_account',
                    'G5_same_channel','G6_slot_occupied','G7_veto','G8_reconciled',
                    'G9_conservation')),
  score          REAL, margin REAL, density INTEGER,
  s_amount REAL, s_time REAL, s_merchant REAL, s_account REAL, s_ref REAL,
  algo_version   INTEGER NOT NULL,
  decided_at     INTEGER NOT NULL,
  user_response  TEXT CHECK (user_response IS NULL OR user_response IN
                   ('accepted','rejected','unmerged')),
  responded_at   INTEGER
) STRICT;

CREATE INDEX ix_match_decisions_obs  ON match_decisions(observation_id, decided_at DESC);
CREATE INDEX ix_match_decisions_open ON match_decisions(outcome, decided_at DESC)
  WHERE outcome = 'suggested' AND user_response IS NULL;

-- Vetoes key on CAPTURE identity, not transaction identity, because transaction ids change
-- under merge/unmerge while capture ids never do. A user who says "these are two different
-- coffees" is never asked again, and a smarter model is not allowed to overrule them — gate G7
-- consults this on every evaluation, INCLUDING during replay.
CREATE TABLE match_vetoes (
  capture_id_a TEXT NOT NULL REFERENCES raw_captures(id) ON DELETE CASCADE,
  capture_id_b TEXT NOT NULL REFERENCES raw_captures(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (capture_id_a, capture_id_b),
  CHECK (capture_id_a < capture_id_b)   -- canonical ordering, enforced
) STRICT, WITHOUT ROWID;
```

The blocking query the `ix_txn_block` index exists for:

```sql
SELECT t.* FROM transactions t
 WHERE t.deleted_at IS NULL AND t.disposition = 'active'
   AND t.direction = :dir
   AND (t.currency_code = :cur OR t.reporting_currency_code = :cur)
   AND t.booked_at_utc BETWEEN :t_lo AND :t_hi
   AND t.effective_amount_minor BETWEEN :a_lo AND :a_hi
   AND (t.account_id IS NULL OR :acct IS NULL OR t.account_id = :acct)
 LIMIT 200;
```

Fuzzy scoring runs in JS over those ≤200 candidates; no SQL-level fuzzy matching is needed. Five
**structural** rules — not tolerance tuning — protect two genuinely separate identical purchases:

1. **Same-channel rule (G5).** Two observations with the same `(source_channel, source_app, role)`
   are never fuzzy-merged; only exact `dedupe_key` equality collapses them. A bank emits exactly
   one auth message per authorization.
2. **Slot capacity (G6).** Enforced by `ux_observations_slot` in the database.
3. **Strong-identifier gate (G3).** Both sides carry an auth code / RRN / folio and they differ ⇒
   merging forbidden regardless of score.
4. **Density escalation.** ≥2 near-identical candidates ⇒ auto-merge requires a matching strong
   identifier or margin ≥ 0.25; otherwise the whole cluster goes to review as a group question.
5. **Conservation invariant (G9).** Per (account, local date):
   `count(active transactions) ≥ count(distinct bank_auth observations) − count(reversals + expiries)`.
   Any merge that would violate it is rejected. Checked in the startup sweep (§3.21).

**Explicit product decision, written into the schema comments: bias to under-merge.** A duplicate
is visible and one tap to fix; a wrong merge silently deletes a purchase from a database with no
cloud copy. Ship v1 with auto-merge **disabled** except for exact strong-identifier matches;
everything else becomes a suggestion. `match_decisions` accumulates the local dataset that lets
you enable it per role-pair after two weeks of real usage, and `algo_version` makes the
before/after comparison possible.

---

### 3.13 bank_templates — format drift

```sql
CREATE TABLE bank_templates (
  id              TEXT PRIMARY KEY,
  sender          TEXT NOT NULL,        -- SMS address or notification package
  -- Structural fingerprint: replace every number with '#', every date/time with <D>/<T>,
  -- collapse whitespace, hash the remaining token skeleton. Two messages from the same bank
  -- template hash identically regardless of amount or merchant. A NEW fingerprint from a
  -- KNOWN sender is the drift signal.
  fingerprint     TEXT NOT NULL,
  regex           TEXT NOT NULL,
  field_map_json  TEXT NOT NULL,        -- named group -> field path

  -- Decided ONCE PER TEMPLATE, never re-detected per message and never inherited from the
  -- device locale. This is the guard against the worst silent bug in the app: '1.234,56'
  -- parsed as 1.23 or as 1234.56 — a 1000x error.
  decimal_separator TEXT NOT NULL CHECK (decimal_separator IN ('.', ',')),
  thousands_separator TEXT CHECK (thousands_separator IS NULL OR
                                  thousands_separator IN ('.', ',', ' ', '')),
  date_format     TEXT NOT NULL,
  default_currency_code TEXT REFERENCES currencies(code),

  state           TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN
                    ('candidate','active','quarantined','retired',
                     -- a REQUIRED field had no locatable span in the raw text, which means the
                     -- model INFERRED it rather than extracting it. Never attempt a template
                     -- for this (sender, fingerprint) again.
                     'llm_only')),
  support_count      INTEGER NOT NULL DEFAULT 0,
  disagreement_count INTEGER NOT NULL DEFAULT 0,
  match_count        INTEGER NOT NULL DEFAULT 0,
  timeout_count      INTEGER NOT NULL DEFAULT 0,   -- 2 timeouts -> auto-quarantine
  version         INTEGER NOT NULL DEFAULT 1,
  -- Promoted templates are IMMUTABLE and versioned: drift produces a new fingerprint and a new
  -- candidate, never an edit.
  supersedes_id   TEXT REFERENCES bank_templates(id),
  created_at INTEGER NOT NULL, promoted_at INTEGER, quarantined_at INTEGER
) STRICT;

CREATE UNIQUE INDEX ux_bank_templates ON bank_templates(sender, fingerprint, version);
CREATE INDEX ix_bank_templates_active ON bank_templates(sender, fingerprint)
  WHERE state = 'active';
```

Parser ladder, degrading with nothing dropped at any rung: **active template** (deterministic,
~0 ms, works before the model is downloaded and after the user deletes it to free space) → **LLM
extraction** → **`needs_review` showing the raw text** → **`deferred_no_model`, replayed later**.

Promotion: shadow-run a candidate against every subsequent message with the same
`(sender, fingerprint)`; promote at `support_count ≥ 3` with zero disagreements on any required
field. Demotion: 2 consecutive disagreements, or match rate < 0.80 over the last 20 messages.
Generated regexes bound the merchant group non-greedily with an explicit `{1,60}` cap, reject
nested quantifiers, and run under a 10 ms timeout on a worker — a learned pattern is code
generated from model output and user input, and catastrophic backtracking would hang the ingest
worker.

---

### 3.14 capture_gaps, capture_health, balance_breaks

Honest answer to "how does the app know it missed something?": for notifications, largely it
cannot. So gaps are **first-class data** — a month with no spending must not look identical to a
month where capture was dead.

```sql
CREATE TABLE capture_gaps (
  id             TEXT PRIMARY KEY,
  channel        TEXT NOT NULL,
  from_utc       INTEGER NOT NULL,
  to_utc         INTEGER,                 -- NULL = still open
  cause          TEXT NOT NULL CHECK (cause IN (
                   'binding_died','permission_revoked','boot_before_unlock','probe_failed',
                   'app_updated','user_disabled','oem_killed','unknown')),
  backfilled_at  INTEGER,
  backfill_source TEXT CHECK (backfill_source IS NULL OR backfill_source IN ('sms','statement','user')),
  note           TEXT,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_capture_gaps_open ON capture_gaps(channel, from_utc DESC) WHERE to_utc IS NULL;

CREATE TABLE capture_health (
  channel                    TEXT PRIMARY KEY,
  last_connected_at          INTEGER,
  last_disconnected_at       INTEGER,
  last_probe_ok_at           INTEGER,
  consecutive_probe_failures INTEGER NOT NULL DEFAULT 0,
  recovery_attempts          INTEGER NOT NULL DEFAULT 0,
  last_recovery_at           INTEGER,
  permission_granted         INTEGER NOT NULL DEFAULT 0 CHECK (permission_granted IN (0,1)),
  updated_at                 INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
```

`boot_before_unlock` is a **documented, permanent** product limitation, not a bug to fix: the same
`MATCH_DIRECT_BOOT_AUTO` default that gates a non-direct-boot-aware listener gates every *sender*
too, so a bank app cannot post a notification in that window at all. Do not build a CE/DE
direct-boot spool. SMS-sourced transactions in that window are recovered on the next
`content://sms` scan, which is what `backfill_source = 'sms'` records.

```sql
-- The balance chain: a free correctness oracle wherever the bank includes a running balance.
--   expect = prev.balance_after_minor + this.signed_amount_minor
--   gap    = this.balance_after_minor - expect
-- Recomputed across a rolling 30-day window on every insert, because out-of-order delivery is
-- normal. Three causes, three responses — see below.
CREATE TABLE balance_breaks (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_obs_id  TEXT REFERENCES observations(id) ON DELETE SET NULL,
  to_obs_id    TEXT REFERENCES observations(id) ON DELETE SET NULL,
  delta_minor  INTEGER NOT NULL
    CHECK (delta_minor BETWEEN -9007199254740991 AND 9007199254740991),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  detected_at  INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
                 'open','resolved_by_insert','resolved_by_reparse','resolved_by_user',
                 'accepted_unknown')),
  resolution_txn_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  resolved_at  INTEGER
) STRICT;

CREATE INDEX ix_balance_breaks_open ON balance_breaks(account_id, detected_at DESC)
  WHERE status = 'open';
```

1. **Out-of-order delivery** — a later-arriving earlier message closes the chain. Auto-resolve to
   `resolved_by_insert`, never alarm inside a 6-hour grace period.
2. **Parse error** — test whether `gap ≈ amount × k` for `k ∈ {1000, 1/1000, 100, 1/100}`
   (separator misparse) or `gap ≈ 2 × amount` (sign flip). If so, re-extract under the alternate
   separator convention; if the chain closes, accept, write `FIELD_REVISED`, and flag the template
   for demotion. This turns the most dangerous silent failure in the app into a self-healing one.
3. **Missed capture** — the gap persists past 48 hours and matches no distortion pattern. Create a
   `kind = 'inferred_gap'` transaction, `evidence_authority = 'inference'`,
   `confirm_state = 'needs_review'`, dated to the interval between the bracketing observations:
   *"we think something for MXN 340.00 happened between Tue and Wed — we didn't catch the
   message."* Only emitted for senders with `capture_senders.balance_trusted = 1`.

---

### 3.15 Budgets

```sql
CREATE TABLE budgets (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  period            TEXT NOT NULL CHECK (period IN ('weekly','monthly','quarterly','yearly','custom')),
  period_anchor     INTEGER,      -- day-of-month (1-28) or ISO weekday; handles payday-aligned months
  currency_code     TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  currency_exponent INTEGER NOT NULL CHECK (currency_exponent BETWEEN 0 AND 8),
  rollover          INTEGER NOT NULL DEFAULT 0 CHECK (rollover IN (0,1)),
  -- inherits the local-vs-home decision from the time model. 'local' matches what the receipt
  -- says; 'home' suits users reconciling against a home-country statement.
  date_basis        TEXT NOT NULL DEFAULT 'local' CHECK (date_basis IN ('local','home')),
  starts_on         TEXT NOT NULL
    CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ends_on           TEXT,
  archived_at       INTEGER,
  hlc TEXT NOT NULL, node_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;

CREATE TABLE budget_lines (
  id              TEXT PRIMARY KEY,
  budget_id       TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id     TEXT REFERENCES categories(id) ON DELETE CASCADE,
  include_subtree INTEGER NOT NULL DEFAULT 1 CHECK (include_subtree IN (0,1)),
  tag_id          TEXT REFERENCES tags(id) ON DELETE CASCADE,
  limit_minor     INTEGER NOT NULL CHECK (limit_minor BETWEEN 0 AND 9007199254740991),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  -- A line targets EITHER a category subtree OR a tag (a trip budget), never both.
  CHECK ((category_id IS NOT NULL) <> (tag_id IS NOT NULL))
) STRICT;

CREATE INDEX ix_budget_lines_budget ON budget_lines(budget_id, sort_order);

-- Materialized actuals. On a phone the budget screen is the home screen, and recomputing a
-- multi-currency category subtree sum on every render is not free. carry_in_minor implements
-- rollover as stored state rather than a recursive query over all prior periods.
CREATE TABLE budget_periods (
  id              TEXT PRIMARY KEY,
  budget_line_id  TEXT NOT NULL REFERENCES budget_lines(id) ON DELETE CASCADE,
  period_start    TEXT NOT NULL
    CHECK (period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_end      TEXT NOT NULL
    CHECK (period_end   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  limit_minor     INTEGER NOT NULL CHECK (limit_minor BETWEEN 0 AND 9007199254740991),
  carry_in_minor  INTEGER NOT NULL DEFAULT 0,
  actual_minor    INTEGER NOT NULL DEFAULT 0
    CHECK (actual_minor BETWEEN -9007199254740991 AND 9007199254740991),
  computed_at     INTEGER,
  -- Set to 1 by trg_budget_stale_on_reporting_change whenever FX re-derivation moves a
  -- transaction inside this window. Missing that coupling is how a budget silently disagrees
  -- with the transaction list it is supposedly summing.
  stale           INTEGER NOT NULL DEFAULT 1 CHECK (stale IN (0,1)),
  UNIQUE (budget_line_id, period_start)
) STRICT;

CREATE INDEX ix_budget_periods_stale ON budget_periods(budget_line_id) WHERE stale = 1;
CREATE INDEX ix_budget_periods_window ON budget_periods(period_start, period_end);
```

---

### 3.16 Tags

```sql
-- Flat, deliberately not a tree. Tags are the escape valve from the category tree's
-- one-category-per-posting rule: a dinner is food.restaurant AND #tokyo-2026 AND #reimbursable.
-- Giving tags a hierarchy recreates the category tree and leaves users with two overlapping
-- trees and no rule for which to use.
CREATE TABLE tags (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  normalized            TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'user'
    CHECK (kind IN ('user','trip','project','person','system')),
  color                 TEXT,
  -- The traveller primitive: while a trip is active, new captures default to the TRIP's
  -- timezone and currency instead of the device's. This removes the most common
  -- multi-currency data-entry error — recording a Tokyo dinner in EUR because the device
  -- never left the home locale.
  default_tz            TEXT,
  default_currency_code TEXT REFERENCES currencies(code),
  starts_on             TEXT, ends_on TEXT,
  hlc TEXT NOT NULL, node_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;

CREATE UNIQUE INDEX ux_tags_norm ON tags(normalized) WHERE deleted_at IS NULL;
CREATE INDEX ix_tags_trip ON tags(kind, starts_on) WHERE kind = 'trip' AND deleted_at IS NULL;

-- WITHOUT ROWID on a pure junction table saves the redundant rowid index.
CREATE TABLE transaction_tags (
  txn_id     TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (txn_id, tag_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_transaction_tags_rev ON transaction_tags(tag_id, txn_id);
```

---

### 3.17 Full-text search

```sql
-- Contentless-delegate FTS5 over the searchable text, kept in sync by triggers. Note for the
-- backup path: sqlcipher_export() is documented to copy virtual tables, but verify FTS5 shadow
-- tables round-trip on a realistic fixture before relying on it.
CREATE VIRTUAL TABLE transactions_fts USING fts5(
  merchant_raw, note, memo,
  content = '',                 -- contentless: we store only the index
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE transactions_fts_map (
  rowid  INTEGER PRIMARY KEY,
  txn_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE
) STRICT;
```

---

### 3.18 Sync scaffolding — HLC, tombstones, oplog

None of this is used in v1. All of it costs nothing now and is a painful migration later. The
sync engine itself is deferred (see the sync section); the schema is designed for it today.

**Hybrid logical clock, not `updated_at`.** Device clocks are user-settable; an NTP jump, a manual
clock change or a timezone move silently reorders edits under `updated_at`, and the loss is
invisible. `hlc TEXT NOT NULL` is
`'<48-bit ms hex>:<16-bit counter hex>:<node_id>'` — lexicographically sortable with plain `<`,
monotonic per device, one column, no library.

**Tombstones, not hard deletes.** Without `deleted_at`, a delete on device A is resurrected by
device B's stale row on the next sync. Purge job after 180 days.

```sql
-- Append-only. Triple duty: future sync payload, undo stack, and — because a user correction
-- of an LLM extraction IS an oplog row with before/after — a second view of the FunctionGemma
-- harvest. Written from the SAME repository chokepoint that enforces dirty-columns-only writes.
CREATE TABLE oplog (
  id          INTEGER PRIMARY KEY,          -- local autoincrement; the export watermark
  hlc         TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  column_name TEXT NOT NULL,
  old_value   TEXT,                          -- JSON-encoded
  new_value   TEXT,
  origin      TEXT NOT NULL CHECK (origin IN
                ('user','extraction','replay','import','system','fx_rederive')),
  occurred_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_oplog_row ON oplog(table_name, row_id, id DESC);
CREATE INDEX ix_oplog_hlc ON oplog(hlc);
```

`oplog.id` is one of only two `INTEGER PRIMARY KEY` rowid aliases in the schema (the other is
`transactions_fts_map.rowid`, which FTS5 requires). It is local-only, never synced, and
capped by a retention policy (default: keep 90 days or 200k rows, whichever is larger) — it is
simultaneously the fastest-growing table and three things with different natural retentions, so
the policy is explicit and user-visible rather than emergent.

**Dirty-columns-only writes are what make all of this work.** `UPDATE transactions SET merchant_id=? WHERE id=?`
from device A and `UPDATE transactions SET amount_minor=? WHERE id=?` from device B both survive
under Turso-style last-push-wins *and* under a hand-rolled per-field merge; a single ORM-generated
full-row `UPDATE` from either device clobbers the other's field with a stale value. Add a
repository-level test that fails on any `UPDATE` touching more columns than were marked dirty.

---

### 3.19 Triggers, in one place

```sql
-- ─── 1. Append-only enforcement ───────────────────────────────────────────────────────
CREATE TRIGGER trg_transaction_events_no_update
BEFORE UPDATE ON transaction_events
BEGIN SELECT RAISE(ROLLBACK, 'transaction_events is append-only'); END;

CREATE TRIGGER trg_transaction_events_no_delete
BEFORE DELETE ON transaction_events
WHEN (SELECT value FROM meta WHERE key = 'allow_hard_delete') IS NOT 'yes'
BEGIN SELECT RAISE(ROLLBACK, 'transaction_events is append-only'); END;

CREATE TRIGGER trg_fx_rates_no_update
BEFORE UPDATE ON fx_rates
BEGIN
  SELECT RAISE(ROLLBACK,
    'fx_rates is append-only: insert a new row with revision+1 and supersedes_id');
END;

CREATE TRIGGER trg_fx_rates_no_delete
BEFORE DELETE ON fx_rates
WHEN (SELECT value FROM meta WHERE key = 'allow_hard_delete') IS NOT 'yes'
BEGIN SELECT RAISE(ROLLBACK, 'fx_rates is append-only'); END;

CREATE TRIGGER trg_oplog_no_update
BEFORE UPDATE ON oplog
BEGIN SELECT RAISE(ROLLBACK, 'oplog is append-only'); END;

-- raw_captures bodies may be NULLed by the purge path, but the ROW must never disappear:
-- deleting it would let a device rescan re-import the same message as new.
CREATE TRIGGER trg_raw_captures_no_delete
BEFORE DELETE ON raw_captures
WHEN (SELECT value FROM meta WHERE key = 'allow_hard_delete') IS NOT 'yes'
BEGIN
  SELECT RAISE(ROLLBACK, 'raw_captures rows are redacted in place, never deleted');
END;

-- ─── 2. Soft-delete enforcement on the ledger ─────────────────────────────────────────
CREATE TRIGGER trg_transactions_no_hard_delete
BEFORE DELETE ON transactions
WHEN (SELECT value FROM meta WHERE key = 'allow_hard_delete') IS NOT 'yes'
BEGIN
  SELECT RAISE(ROLLBACK,
    'transactions are soft-deleted; set meta.allow_hard_delete=yes for maintenance only');
END;

-- ─── 3. Money coherence: the row exponent must equal the currency's ISO exponent ──────
-- A CHECK cannot reference another table, so this has to be a trigger. It is the guard that
-- makes rule #2 in §3.0 real rather than a convention.
CREATE TRIGGER trg_transactions_exponent_insert
AFTER INSERT ON transactions
WHEN NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
  OR NEW.reporting_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.reporting_currency_code)
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

CREATE TRIGGER trg_entries_exponent_insert
AFTER INSERT ON entries
WHEN NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
  OR NEW.account_exponent  <> (SELECT iso_exponent FROM currencies WHERE code = NEW.account_currency_code)
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

CREATE TRIGGER trg_line_items_exponent_insert
AFTER INSERT ON line_items
WHEN NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

-- ─── 4. Ledger date coherence ─────────────────────────────────────────────────────────
-- VALIDATE, do not silently fix. SQLite cannot assign to NEW.* in a BEFORE INSERT trigger, and
-- an AFTER-INSERT self-UPDATE would mask a repository bug rather than surface it. The
-- repository copies the header date onto every leg; this trigger makes disagreement loud.
CREATE TRIGGER trg_entries_date_coherence
AFTER INSERT ON entries
WHEN NEW.booked_local_date <>
     (SELECT t.booked_local_date FROM transactions t WHERE t.id = NEW.txn_id)
BEGIN
  SELECT RAISE(ROLLBACK, 'ledger: entries.booked_local_date disagrees with its header');
END;

-- The propagation half: an edit to the header date must reach the legs. This DOES trip
-- trg_entries_update_after_seal on a sealed transaction, by design — the repository must
-- unseal, edit the header, then re-seal, so the date edit is verified like any other ledger
-- mutation instead of quietly changing indexed data behind a stale seal.
CREATE TRIGGER trg_transactions_date_propagate
AFTER UPDATE OF booked_local_date ON transactions
WHEN NEW.booked_local_date <> OLD.booked_local_date
BEGIN
  UPDATE entries SET booked_local_date = NEW.booked_local_date, updated_at = NEW.updated_at
   WHERE txn_id = NEW.id;
END;

-- ─── 5. Budget invalidation on FX re-derivation ───────────────────────────────────────
-- Deliberately coarse (marks every line's period covering that date). Recomputing a budget
-- period is cheap; showing a budget that disagrees with its own transaction list is not.
CREATE TRIGGER trg_budget_stale_on_reporting_change
AFTER UPDATE OF reporting_amount_minor ON transactions
WHEN NEW.reporting_amount_minor <> OLD.reporting_amount_minor
BEGIN
  UPDATE budget_periods SET stale = 1
   WHERE period_start <= NEW.booked_local_date
     AND period_end   >= NEW.booked_local_date;
END;

CREATE TRIGGER trg_budget_stale_on_amount_change
AFTER UPDATE OF settled_amount_minor, authorized_amount_minor, amount_minor ON transactions
BEGIN
  UPDATE budget_periods SET stale = 1
   WHERE period_start <= NEW.booked_local_date
     AND period_end   >= NEW.booked_local_date;
END;

-- ─── 6. Merchant / alias counters ─────────────────────────────────────────────────────
-- DRIFTS UPWARD BY DESIGN and is repaired by sweep check I9, not by a decrement trigger.
-- A soft delete (deleted_at) fires no DELETE, and an undone replay run soft-deletes the
-- transactions it created, so txn_count would otherwise ratchet. It is a display counter and
-- a merchant-pattern ranking hint, never money — a periodic recompute is the right cost.
CREATE TRIGGER trg_merchant_seen
AFTER INSERT ON transactions
WHEN NEW.merchant_id IS NOT NULL
BEGIN
  UPDATE merchants
     SET txn_count = txn_count + 1, last_seen_at = NEW.captured_at_utc
   WHERE id = NEW.merchant_id;
END;

-- ─── 7. FTS sync ──────────────────────────────────────────────────────────────────────
CREATE TRIGGER trg_txn_fts_insert AFTER INSERT ON transactions BEGIN
  INSERT INTO transactions_fts_map (txn_id) VALUES (NEW.id);
  INSERT INTO transactions_fts (rowid, merchant_raw, note, memo)
    VALUES ((SELECT rowid FROM transactions_fts_map WHERE txn_id = NEW.id),
            COALESCE(NEW.merchant_raw,''), COALESCE(NEW.note,''), '');
END;

CREATE TRIGGER trg_txn_fts_update AFTER UPDATE OF merchant_raw, note ON transactions BEGIN
  INSERT INTO transactions_fts (transactions_fts, rowid, merchant_raw, note, memo)
    VALUES ('delete', (SELECT rowid FROM transactions_fts_map WHERE txn_id = NEW.id),
            COALESCE(OLD.merchant_raw,''), COALESCE(OLD.note,''), '');
  INSERT INTO transactions_fts (rowid, merchant_raw, note, memo)
    VALUES ((SELECT rowid FROM transactions_fts_map WHERE txn_id = NEW.id),
            COALESCE(NEW.merchant_raw,''), COALESCE(NEW.note,''), '');
END;
```

**`RAISE(ROLLBACK)` everywhere, deliberately.** `RAISE(ABORT)` rolls back only the current
statement and leaves the enclosing transaction open — a repository that swallowed the error would
commit a half-written ledger. Every one of these guards is an invariant violation that must not be
recoverable in-place, so the whole transaction goes. The repository treats `SQLITE_CONSTRAINT` from
any of them as "already rolled back" and must not attempt `COMMIT`.

---

### 3.20 Views

```sql
-- A pure SUM with no special cases, which is only possible because opening balances are real
-- balanced transactions against sys_opening_balance rather than a magic column.
CREATE VIEW v_account_balances AS
SELECT e.account_id, e.currency_code, e.currency_exponent,
       SUM(e.amount_minor) AS balance_minor
  FROM entries e
  JOIN transactions t ON t.id = e.txn_id
 WHERE t.deleted_at IS NULL
   AND t.disposition = 'active'
   AND t.clearing_state IN ('authorized','settled','disputed','chargeback_lost')
 GROUP BY e.account_id, e.currency_code, e.currency_exponent;

CREATE VIEW v_category_month AS
SELECT c.id AS category_id, c.canonical_key, e.booked_month,
       e.currency_code, e.currency_exponent,
       SUM(e.amount_minor) AS amount_minor
  FROM entries e
  JOIN categories   c ON c.account_id = e.account_id
  JOIN transactions t ON t.id = e.txn_id
 WHERE t.deleted_at IS NULL
   AND t.disposition = 'active'
   AND t.clearing_state IN ('authorized','settled','disputed','chargeback_lost')
 GROUP BY c.id, e.booked_month, e.currency_code, e.currency_exponent;

-- Net refund position. Derived, never stored as truth.
CREATE VIEW v_txn_net AS
SELECT t.id AS txn_id,
       t.effective_amount_minor
         - COALESCE((SELECT SUM(l.amount_minor) FROM transaction_links l
                      WHERE l.to_transaction_id = t.id AND l.kind = 'REFUND_OF'), 0)
       AS net_amount_minor
  FROM transactions t
 WHERE t.deleted_at IS NULL;

-- The review inbox, as one query. At 0.80 F1 plus under-merge bias this is the app's main
-- surface, so it is a view rather than ad-hoc SQL scattered across screens.
-- CONTRACT for any future branch: `at` is ALWAYS unix epoch ms UTC (never a local-date TEXT)
-- and `reason` is ALWAYS a short TEXT enum value. A branch selecting a 'YYYY-MM-DD' string
-- into `at` would sort catastrophically against the INTEGER branches, and silently.
CREATE VIEW v_review_inbox AS
SELECT 'transaction' AS item_kind, t.id AS item_id, t.captured_at_utc AS at,
       t.confirm_state AS reason
  FROM transactions t
 WHERE t.deleted_at IS NULL AND t.disposition = 'active'
   AND (t.confirm_state IN ('extracted','needs_review') OR t.needs_review = 1)
UNION ALL
SELECT 'capture', rc.id, rc.received_at, rc.process_state
  FROM raw_captures rc
 WHERE rc.process_state IN ('unparseable','redacted','deferred_no_model')
UNION ALL
SELECT 'duplicate_suggestion', md.id, md.decided_at, 'possible_duplicate'
  FROM match_decisions md
 WHERE md.outcome = 'suggested' AND md.user_response IS NULL
UNION ALL
SELECT 'conflict', fc.id, fc.detected_at, fc.field
  FROM field_conflicts fc WHERE fc.status = 'open'
UNION ALL
SELECT 'balance_break', bb.id, bb.detected_at, 'unexplained_balance_change'
  FROM balance_breaks bb WHERE bb.status = 'open';
```

---

### 3.21 The startup integrity sweep

This is the actual safety net behind the seal pattern (§3.7.1). It runs on app start, off the
critical path, and writes offenders to a repair queue with a user-visible banner.

```sql
-- I1. Unbalanced transactions. This is the same query the seal trigger runs, applied globally —
--     it catches any write path that bypassed the repository.
SELECT e.txn_id, e.currency_code, SUM(e.amount_minor) AS residual
  FROM entries e GROUP BY e.txn_id, e.currency_code HAVING SUM(e.amount_minor) <> 0;

-- I2. Unsealed transactions: a write path that never called seal at all. Invisible to every
--     trigger, which is exactly why this check exists.
SELECT t.id FROM transactions t
  LEFT JOIN transaction_seals s ON s.txn_id = t.id
 WHERE s.txn_id IS NULL AND t.confirm_state <> 'draft' AND t.deleted_at IS NULL;

-- I3. Date denormalization drift between header and legs.
SELECT e.id FROM entries e JOIN transactions t ON t.id = e.txn_id
 WHERE e.booked_local_date <> t.booked_local_date;

-- I4. Exponent drift after a currencies-table correction.
SELECT t.id FROM transactions t JOIN currencies c ON c.code = t.currency_code
 WHERE t.currency_exponent <> c.iso_exponent;

-- I5. Conservation invariant (dedupe gate G9): more bank_auth observations than transactions
--     on an account-day means a merge ate a purchase.
SELECT o.account_id, date(o.event_at_utc/1000,'unixepoch') AS d,
       COUNT(DISTINCT o.id) AS auths,
       (SELECT COUNT(*) FROM transactions t
         WHERE t.account_id = o.account_id
           AND t.booked_local_date = date(o.event_at_utc/1000,'unixepoch')
           AND t.deleted_at IS NULL AND t.disposition = 'active') AS txns
  FROM observations o WHERE o.role = 'bank_auth'
 GROUP BY 1,2 HAVING auths > txns;

-- I6. Orphaned media (row points at a file that is gone) — flag, never delete: the extraction
--     record is still valid audit.
SELECT id, rel_path FROM media_assets WHERE missing_since IS NOT NULL;

-- I7. Training labels whose input was purged. Should always be empty; non-empty means the
--     purge path skipped its second statement.
SELECT c.id FROM corrections c
  JOIN raw_captures rc ON rc.id = c.raw_capture_id
 WHERE rc.process_state = 'purged' AND c.training_eligible = 1;

-- I8. Refunds exceeding their original — almost always a mis-linked refund.
SELECT v.txn_id FROM v_txn_net v WHERE v.net_amount_minor < 0;

-- I9. Denormalized merchant counter drift (soft deletes and undone replay runs fire no
--     decrement). Repair, do not alarm: this is a display counter, not money.
UPDATE merchants SET txn_count = (
  SELECT COUNT(*) FROM transactions t
   WHERE t.merchant_id = merchants.id AND t.deleted_at IS NULL AND t.disposition = 'active');
```

```sql
CREATE TABLE integrity_findings (
  id           TEXT PRIMARY KEY,
  check_id     TEXT NOT NULL CHECK (check_id IN
                 ('I1','I2','I3','I4','I5','I6','I7','I8','I9')),
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  detail_json  TEXT,
  status       TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','repaired','accepted','dismissed')),
  detected_at  INTEGER NOT NULL, resolved_at INTEGER,
  UNIQUE (check_id, subject_kind, subject_id, status)
) STRICT;
```

Alongside these, the periodic maintenance job runs `PRAGMA quick_check`,
`PRAGMA foreign_key_check`, and `PRAGMA incremental_vacuum(N)` with N capped so it stays off the
critical path.

---

### 3.22 Rejected alternatives, in one table

| Decision | Chosen | Rejected, and why |
| --- | --- | --- |
| Ledger shape | `transactions` header + `entries` postings, balanced per currency | Flat transaction+category table — four everyday cases (cross-currency transfer, "Alice owes me 60", credit-card bill payment, partial refund against a split) are unrepresentable without a hack that leaks into every report forever |
| Balance invariant | Per currency | `SUM(home_amount) = 0` — independent per-leg conversion produces rounding residuals, so it could never hold exactly |
| Invariant enforcement | Seal-table trigger + companion entry guards + startup sweep | `AFTER INSERT ON entries` trigger — fires mid-write on the first leg and always fails. SQLite has no deferred constraint triggers |
| Trigger failure mode | `RAISE(ROLLBACK)` | `RAISE(ABORT)` — rolls back the statement only, leaving a half-written ledger committable |
| Categories | 1:1 extension of an expense/income account | Nullable `account_id` XOR `category_id` on entries (invariant unenforceable); one `sys_expense` control account with a category dimension (one concept in two columns) |
| Transaction status | Three orthogonal axes | A single `status` enum — ~30 states, most illegal, and the illegal ones are the bugs |
| Primary keys | `TEXT` UUIDv7 | ULID (equivalent, less canonical); content-addressed `source_hash` as PK (kills time-ordering and complicates merge — expressed as a UNIQUE index instead); `BLOB(16)` (unreadable in JS and logs) |
| Hashes | lowercase hex `TEXT` | `BLOB(32)` — round-trips as `ArrayBuffer` through op-sqlite |
| Money bound | `±9007199254740991` (2^53−1) | ±9e14 operational bound — 2^53−1 is the actual representability limit given op-sqlite's `sqlite3_column_double()` reads |
| Big integers | Never | Drizzle `integer({mode:'bigint'})` (does not exist); `blob({mode:'bigint'})` (BLOB with no numeric ordering, throws `Buffer is not defined` in Hermes) |
| Durability | `synchronous = FULL` | `NORMAL` — survives an app crash but not power loss, and there is no upstream copy |
| Line-item reconciliation | Soft, via `line_items_delta_minor` + `needs_review` | A CHECK that items sum to the total — rejects a large fraction of real receipts at 0.80 F1 |
| Receipt images | Filesystem + `media_assets` rows | BLOBs in the DB — SQLCipher would encrypt megabytes per touch and VACUUM becomes a multi-minute phone stall |
| Table names | Plural | Singular — `transaction` is a SQL keyword and would need quoting at every use |
| Purge | Redact in place, keep row + hashes | `DELETE` the row — a rescan re-imports the same message as new, and the audit chain breaks |
| Sync clock | HLC `TEXT` | `updated_at` — an NTP jump or manual clock change silently reorders edits, invisibly |
| Direct-boot capture | Not built; `capture_gaps.cause = 'boot_before_unlock'` | CE/DE split with a device-protected spool — the same gate blocks every *sender*, so there is nothing to capture |
