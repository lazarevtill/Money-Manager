## The complete SQL schema

This is the v1 schema, written to be implemented from directly. It targets SQLite 3.51.3 as
bundled by `@op-engineering/op-sqlite` 17.1.3 with `"op-sqlite": { "sqlcipher": true }`. Every
table is `STRICT`. Every statement below belongs in checked-in migration SQL files, not in
generated-at-runtime DDL.

Where the six research agents disagreed, one option is taken and the rejected one is named in a
sentence at the point of decision, with the full list repeated in §3.22.

---

### 3.0 The eleven rules the whole schema depends on

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
   in `currencies` and a decade of history would otherwise silently change value. The rule has **no
   exemptions**: it binds `transactions.amount_minor`, the bank auth/settle family, `entries`,
   `line_items`, `transaction_links`, `observations` (both its amount *and* its `balance_after`),
   `budgets`, `budget_periods` and `installment_plans`. A money column whose currency is inherited
   implicitly from a parent row is a bug waiting for the parent's currency to be edited. Enforcement
   is the exponent-coherence trigger family in §3.19 plus sweep check I4 (§3.21), which cover **every**
   one of those tables, not a subset.
   The same 2^53 bound in rule 1 applies to **rate numerators and denominators** wherever they are
   stored (`fx_rates`, `transactions.reporting_rate_*`, `entries.settle_rate_*`), because those are
   read back through the same `sqlite3_column_double()` path.
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
   deprecate in place. **Two stated exceptions.**
   (a) `STORED` generated columns cannot be added by `ALTER TABLE ADD COLUMN`, so the **five** that
   exist are **frozen at v1**: `booked_month` on `transactions`, `booked_month` on `entries`,
   and `effective_amount_minor`, `bank_effective_amount_minor` and `adjustment_minor` on
   `transactions`. Any future derived column is `VIRTUAL` or app-maintained. A table rebuild for a
   new `STORED` column is permitted only under the snapshot-and-rollback procedure and is a
   deliberate, reviewed migration — never routine.
   (b) **Closed `CHECK … IN (…)` lists are forbidden on append-only, diagnostic and pipeline-state
   columns**, because adding a value to one requires exactly the table rebuild (a) forbids, and the
   failure mode is not a mislabelled row — it is `SQLITE_CONSTRAINT` inside `BEGIN IMMEDIATE`, which
   under §3.19's `RAISE(ROLLBACK)` convention aborts the whole enclosing batch. The columns that are
   therefore **deliberately unconstrained in SQL and validated in the repository** are
   `raw_captures.process_state`, `raw_captures.ignored_reason`, `capture_senders.channel`,
   `capture_gaps.cause`, `integrity_findings.check_id` and `transaction_fields.authority_rank`.
   Each carries its known vocabulary as a comment. A build-time schema lint fails on any new closed
   list added to a table in that class.
8. **Writes touch only dirty columns.** No full-row `UPDATE`. This is what makes per-field merge free
   under any future sync engine and is unretrofittable after a year of ORM full-row writes.
9. **Rounding is ROUND_HALF_EVEN, in exactly one function, everywhere.** Splits use largest-remainder
   allocation so the parts sum to the original exactly. Re-derivation after an FX correction must be
   bit-identical or the correction job emits spurious diffs on unchanged rows.
10. **Signs are conventional and stated, never inferred.**
    - `transactions` header money (`amount_minor`, `authorized_amount_minor`, `settled_amount_minor`,
      `tip_minor`, `reporting_amount_minor`, `effective_amount_minor`) is a **non-negative magnitude**;
      `direction` carries the sign. `adjustment_minor` is the one deliberate exception — it is a
      signed delta.
    - `entries.amount_minor` is **signed**: debits negative, credits positive, in the usual
      double-entry sense, so the per-currency sum is zero.
    - `line_items.amount_minor` is **signed with the same sign as the transaction's category legs**,
      so `discount` and `rounding` rows are negative and the whole line set is summable.
    - `observations.amount_minor` is a magnitude; `observations.direction` carries the sign.
    A sign convention that is only implied by a worked example gets re-invented, in the opposite
    direction, by the second person to touch the code.
11. **Whether a transaction counts toward money is decided in exactly one predicate (§3.5.2), and
    leaving that predicate is a user-visible event.** No screen, view or job may write its own
    `clearing_state IN (…)` list. A state transition that moves a row out of the predicate must set
    `needs_review = 1` or produce a review-inbox row, because "the number silently got smaller" is
    indistinguishable from "the user spent less".

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

  -- 'derived_cross' is a rate the app COMPOSED (USD->JPY from EUR-based ECB data). It is a real
  -- row with a real id, because transactions.reporting_rate_id is a single FK and a composed
  -- rational that exists only inside a function call is re-derivable but not ATTRIBUTABLE — and
  -- attribution is what the correction job selects on. See fx_rate_inputs below.
  source        TEXT NOT NULL
    CHECK (source IN ('seed','frankfurter','self_hosted','manual','statement','derived_cross')),
  source_url    TEXT,

  -- Total ordering for the lookup. Without it the resolver ties whenever two sources published
  -- the same (base, quote, date) at the same revision — 'manual' (the user typed their card's
  -- actual rate) versus 'frankfurter' (the nightly backfill) is the everyday collision — and
  -- LIMIT 1 then returns whichever the index traversal reaches first. That makes the SAME
  -- transaction convert to a different amount after an index rebuild or a restore, which
  -- violates rule 9's bit-identical requirement invisibly.
  --   statement 50 > manual 40 > self_hosted 30 > frankfurter 20 > derived_cross 15 > seed 10
  source_priority INTEGER NOT NULL,

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

-- The lookup index. Rate resolution for a transaction is EXACTLY:
--   WHERE base_code=? AND quote_code=? AND rate_date <= :booked_local_date
--   ORDER BY rate_date DESC, source_priority DESC, revision DESC, id DESC
--   LIMIT 1
-- All four ORDER BY terms are required and the last one (id) is what makes the ordering TOTAL:
-- ties on the first three must still be broken deterministically or re-derivation is not
-- reproducible. ECB/Frankfurter publish business days only, so the <= gap fallback is the NORMAL
-- path, not an exception. The row actually used is recorded in transactions.reporting_rate_date
-- so a rate that is four days stale is visible in the UI rather than invisible — and §3.3.4's
-- backfill pass upgrades it once the real fixing publishes.
CREATE INDEX ix_fx_rates_lookup
  ON fx_rates(base_code, quote_code, rate_date DESC, source_priority DESC, revision DESC);

-- Composition lineage for source='derived_cross'. One row per component leg. This is the table
-- that makes a revision to ANY component discoverable: the correction job selects derived rows
-- via input_rate_id, recomposes them, and only then selects transactions via reporting_rate_id.
-- Without it, a EUR-based rate source plus a non-EUR base currency means EVERY FX transaction is
-- unattributable and no revision ever reaches it.
CREATE TABLE fx_rate_inputs (
  rate_id       TEXT NOT NULL REFERENCES fx_rates(id) ON DELETE RESTRICT,
  ordinal       INTEGER NOT NULL CHECK (ordinal >= 0),
  input_rate_id TEXT NOT NULL REFERENCES fx_rates(id) ON DELETE RESTRICT,
  -- 1 = the component is used as its reciprocal (EUR->JPY inverted to get JPY->EUR)
  inverted      INTEGER NOT NULL DEFAULT 0 CHECK (inverted IN (0,1)),
  PRIMARY KEY (rate_id, ordinal)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_fx_rate_inputs_rev ON fx_rate_inputs(input_rate_id);
```

Conversion is one function, and its definition is part of the schema contract because
re-derivation after a rate correction must be **bit-identical**:

```text
convert(amountMinor, expFrom, expTo, rateNum, rateDen) =
  roundHalfEven( amountMinor * rateNum * 10^max(0, expTo - expFrom),
                 rateDen                * 10^max(0, expFrom - expTo) )
```

All in `BigInt`, ROUND_HALF_EVEN, one implementation, unit-tested against a checked-in golden
vector file covering MGA, MRU, JPY, KWD, CHF, ISK.

**Cross rates are composed, then persisted.** USD→JPY from EUR-based ECB data multiplies rationals
with **no intermediate rounding** — round exactly once, at the end — and the resulting rational is
then written as a real `fx_rates` row with `source = 'derived_cross'`, one `fx_rate_inputs` row per
component, and `rate_text` set to the composed decimal rendered to 12 significant figures for audit.
Two requirements make that row safe:

- **Reduce to lowest terms before insert** (`n/gcd`, `d/gcd`, in `BigInt`). This is a correctness
  requirement, not tidiness: a ten-significant-figure source composed with another gives a
  denominator around 1e20, which blows the `BETWEEN 1 AND 9007199254740991` CHECK. Reduction fixes
  the common case; if the reduced denominator still exceeds 2^53 the composition is **rejected** and
  the transaction falls back to `reporting_source = 'manual'` with a review-inbox item, rather than
  silently storing a rate that truncates on read.
- **The composed row is content-addressed by `(base, quote, date, 'derived_cross', revision)` like
  any other**, so the same composition performed twice reuses the same row and `reporting_rate_id`
  stays stable.

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
2. **Close the composition graph first.** A revised rate invalidates not only the transactions that
   used it directly but every `derived_cross` row composed from it:
   ```sql
   -- 2a. every composed rate that consumed the revised component, transitively
   WITH RECURSIVE affected(rate_id) AS (
     SELECT rate_id FROM fx_rate_inputs WHERE input_rate_id = :old_rate_id
     UNION
     SELECT i.rate_id FROM fx_rate_inputs i JOIN affected a ON i.input_rate_id = a.rate_id)
   SELECT rate_id FROM affected;
   ```
   For each of those, recompose from the current components (§3.3.2's reduce-to-lowest-terms rule)
   and insert the recomposed row at `revision + 1` with fresh `fx_rate_inputs`. Collect
   `:stale_rate_ids` = `{:old_rate_id} ∪ {recomposed predecessors}`.
3. Select the affected transactions through the dedicated partial index `ix_txn_rate`:
   ```sql
   SELECT id, effective_amount_minor, currency_exponent, reporting_exponent
     FROM transactions
    WHERE reporting_rate_id IN (:stale_rate_ids)
      AND reporting_source  = 'derived'
      AND reporting_locked  = 0
      AND deleted_at IS NULL;
   ```
   Rows with `reporting_source IN ('actual','manual')` or `reporting_locked = 1` are excluded by
   the `WHERE` clause and are **never** touched — those are numbers the user's bank actually
   charged, and recomputing them would be wrong.
4. Recompute with the same `convert()` function, **over `effective_amount_minor`, never
   `amount_minor`** — the settled figure is the one the reporting number must track, and computing
   from `amount_minor` is what makes a re-derivation pass *reconfirm* a stale pre-settlement value.
   `UPDATE` only the dirty columns (`reporting_amount_minor`, `reporting_rate_id`,
   `reporting_rate_num/den`, `reporting_rate_date`, `updated_at`, `hlc`) and, in the same statement
   batch, re-run the per-leg allocation of §3.7.3 so `entries.reporting_amount_minor` moves with the
   header. A header that moves without its legs makes `v_category_month` and the transaction detail
   screen disagree permanently, and nothing in the sweep would notice.
5. Write one `fx_rederivations` row per changed transaction so the UI can say *"12 transactions
   changed by €0.34 total because the 2026-07-14 EUR/JPY rate was revised."*
6. `budget_periods.stale` is set to 1 automatically by `trg_budget_stale_on_reporting_change`
   (§3.19). Missing that coupling is what makes a budget silently disagree with the transaction
   list it is supposedly summing.

**The gap-fallback upgrade pass, which is a separate and equally mandatory job.** D33 makes
`rate_date <= :booked_local_date` the normal path, so a Saturday purchase is converted with
Friday's fixing. Nothing above ever revisits that row, because no rate was *revised* — one was
merely *published later*. Without this pass every weekend and holiday transaction keeps a
permanently approximate reporting amount, and the staleness is invisible because
`reporting_rate_date` is only rendered on the detail screen.

```sql
-- Runs after every successful rate fetch, chunked, under reason = 'rate_backfilled'.
SELECT id, booked_local_date, reporting_rate_date, currency_code, reporting_currency_code
  FROM transactions
 WHERE reporting_source  = 'derived'
   AND reporting_locked  = 0
   AND deleted_at IS NULL
   AND reporting_rate_date < booked_local_date
 ORDER BY booked_local_date DESC
 LIMIT :chunk;
```

```sql
-- The index that predicate needs. Without it this is a full scan of every FX transaction ever.
CREATE INDEX ix_txn_rate_stale ON transactions(reporting_rate_date)
  WHERE reporting_source = 'derived' AND reporting_locked = 0 AND deleted_at IS NULL;
```

For each row, re-resolve the rate for `booked_local_date`; if the resolved row is different from
the stored one, apply steps 4–6 above. A rate that is *still* unavailable leaves the row untouched
and it is retried on the next fetch.

**Base-currency change** (emigration, relocation) reuses this path with
`reason = 'base_currency_changed'` and invalidates *every* `reporting_amount_minor` at once. It is
an explicit, resumable, progress-shown migration — not a settings toggle. Pre-flight it by
checking rate coverage for the required pairs and dates and refuse to start until gaps are filled
or the user accepts nearest-prior fallback. Budget minutes, not milliseconds.

#### 3.3.5 Stocks versus flows — the accounting policy that makes "net worth in X as of D" answerable

`reporting_amount_minor` is a **flow** conversion: each transaction converted at its own
`booked_local_date` rate. Summing flows over an account gives **historical cost**, not value. A
balance is a **stock** and must be revalued at the rate on the valuation date, or a EUR-reporting
user with a USD savings account sees a net worth that is wrong by the entire currency move since
deposit and a month-over-month chart that is flat until the day they convert, then steps.

The policy, stated once and binding on every report:

- **Income and expense flows stay at transaction-date rates.** What a dinner cost is what it cost.
- **Asset and liability balances are revalued at the valuation date**, using the §3.3.2 resolver
  with `rate_date <= :as_of_date`. Never by summing per-transaction reporting amounts.
- The difference between the two is **unrealized FX gain/loss**. It is not zero, it is not noise,
  and it needs somewhere to live: `sys_unrealized_fx` (§3.4.1) is a system equity account that
  exists so a revaluation is representable as a balanced transaction rather than an off-ledger
  computation. v1 computes revaluation on read (§3.20's `v_net_worth_asof` query); the account
  exists from v1 so that periodic materialized revaluation is an additive change later.
- A **realized** conversion — the user actually moves USD into EUR — books through
  `sys_fx_conversion` per §3.7.2 and is unaffected by any of this.

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
                  -- the deferred-balance child of a credit card, created on demand the first
                  -- time an MSI plan is detected on it. See §3.7.4.
                  'installment_deferred',
                  'opening_balance','fx_conversion','imbalance','clearing','unrealized_fx',
                  'expense','income')),
  parent_id     TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,

  -- NULL means "multi-currency account", and there are exactly two classes of them:
  --   (a) system equity/clearing accounts — sys_fx_conversion holds both legs of a
  --       cross-currency conversion simultaneously, sys_imbalance absorbs residuals in
  --       whatever currency produced them, sys_unrealized_fx accrues revaluation;
  --   (b) EXPENSE AND INCOME (i.e. category) accounts. A category is not denominated: a user
  --       spends on "Food" in JPY in Tokyo and in EUR at home, v_category_month already groups
  --       by leg currency, and forcing a single currency onto a category account would make a
  --       foreign-currency category leg unrepresentable — which is precisely the hole that let
  --       the account-currency dimension go unchecked in the first draft.
  -- Everything else (cash, checking, savings, cards, loans, receivables) is single-currency,
  -- and trg_entries_account_currency (§3.19) enforces that every leg posted to such an account
  -- is denominated in that account's currency. That trigger, plus explicit fx_conversion legs
  -- for the settlement conversion, is what makes v_account_balances a correct pure SUM.
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

  CHECK (currency_code IS NOT NULL OR is_system = 1 OR type IN ('expense','income'))
) STRICT;

-- Same child name under different parents is allowed; duplicates under one parent are not.
CREATE UNIQUE INDEX ux_accounts_name
  ON accounts(IFNULL(parent_id,''), name) WHERE deleted_at IS NULL;
CREATE INDEX ix_accounts_tree ON accounts(parent_id, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX ix_accounts_budget ON accounts(is_on_budget, type) WHERE deleted_at IS NULL;
```

Eight system accounts, seeded with **fixed non-UUID ids** so application code can reference them
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
  -- NULL currency deliberately: a traveller's wallet holds EUR and JPY at the same time, and
  -- v_account_balances already reports one row per (account, currency).
  ('sys_cash',           'asset', 'cash',           'Cash wallet',       NULL,1,1,'0:0:seed',0,0,0),
  -- One-sided transfers (counterpart account untracked, or its notification never arrived)
  -- post here: excluded from spend, visible as an open item, replaced if the counterpart lands.
  -- This is what gets the spend number right on iOS, where passive capture does not exist.
  -- "Visible as an open item" is ix_entries_unmatched + the v_review_inbox branch at 14 days +
  -- sweep check I13 at 60 days, and all three are mandatory: an unresolved one-sided transfer
  -- subtracts from spend AND adds to net worth simultaneously, so twelve EUR 25.00 person-to-
  -- person payments understate the month by EUR 300 and overstate net worth by EUR 300 at the
  -- same time. The lexicon that routes traffic here must not fire on P2P rails (BIZUM, ZELLE,
  -- PIX, generic P2P) without a counterparty match against the user's OWN accounts — that is
  -- 04-capture.md §4.11's half of the fix.
  -- NULL currency: a one-sided transfer can arrive in any currency, and forcing EUR here would
  -- make trg_entries_account_currency reject the leg. Aged out by sweep check I13.
  ('sys_unmatched_transfer','asset','clearing','Unmatched transfers',NULL,1,0,'0:0:seed',0,0,0),
  ('sys_unaccounted_cash','expense','expense','Unaccounted cash',NULL,1,1,'0:0:seed',0,0,0),
  -- Issuer FX fees, cross-border fees and ATM fees are REAL LEGS against this account, never a
  -- denormalized column on entries. "What did FX cost me this year" is then an ordinary category
  -- query and the fee is inside the balance invariant instead of beside it.
  ('sys_bank_fees',      'expense','expense','Bank and FX fees', NULL,1,1,'0:0:seed',0,0,0),
  -- Counterpart for balance-sheet revaluation (§3.3.5). Nothing posts here in v1 — the net-worth
  -- query revalues on read — but the account exists from v1 so materialized revaluation is an
  -- additive change rather than a schema migration.
  ('sys_unrealized_fx',  'equity','unrealized_fx','Unrealized currency gain/loss',NULL,1,0,'0:0:seed',0,0,0);
```

**The two seeded expense accounts need `categories` rows, and this is not bookkeeping tidiness.**
`v_category_month` and `budget_periods.actual_minor` both `JOIN categories c ON c.account_id =
e.account_id`, so an expense account with no `categories` row is invisible to every rollup and every
budget. Without these rows the §3.7.2(b) claim that *"what did FX cost me this year is an ordinary
category query"* is false as shipped, and sweep check I13's reclassification of an aged unmatched
transfer into `sys_unaccounted_cash` would move the money into an account no report can see —
reproducing the exact disappearing-money shape I13 exists to fix. `categories` has
`FOREIGN KEY (taxonomy_version, canonical_key) REFERENCES taxonomy_keys`, so the seed migration
carries two `taxonomy_keys` rows as well. Both keys are added to the **existing** taxonomy version
in the same seed rather than bumping it: a taxonomy bump invalidates the accumulated correction
corpus (§3.4.2), which is far too high a price for two leaves.

```sql
INSERT INTO taxonomy_keys (taxonomy_version, key, group_key, default_kind, sort_order) VALUES
  ('cat:2026-08-01','fees.bank',        'fees', 'expense', 900),
  ('cat:2026-08-01','other.unaccounted','other','expense', 990);

INSERT INTO categories
  (id,account_id,canonical_key,taxonomy_version,name,kind,origin,status,
   hlc,node_id,created_at,updated_at) VALUES
  ('cat_sys_bank_fees','sys_bank_fees','fees.bank','cat:2026-08-01',
   'Bank and FX fees','expense','seed','active','0:0:seed',0,0,0),
  ('cat_sys_unaccounted_cash','sys_unaccounted_cash','other.unaccounted','cat:2026-08-01',
   'Unaccounted cash','expense','seed','active','0:0:seed',0,0,0);
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
  -- UNSIGNED MAGNITUDE (rule 10). direction carries the sign.
  direction         TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor      INTEGER NOT NULL
    CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  currency_code     TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  currency_exponent INTEGER NOT NULL CHECK (currency_exponent BETWEEN 0 AND 8),
  -- The exact substring from the source, e.g. '1.234,56'. A separator misparse is a 1000x
  -- error; this column is what makes it forensically recoverable years later.
  amount_text_raw   TEXT,

  -- ── auth -> settlement. NEVER an overwrite; the original survives in three places:
  --    the immutable raw_capture text, authorized_amount_minor, and the AMOUNT_ASSERTED event.
  --
  -- THESE ARE DENOMINATED IN THE BANK'S CURRENCY, NOT THE RECEIPT'S. A bank auth or settlement
  -- message states the figure in the CARD's currency; currency_code above states the currency of
  -- the economic event. For a EUR-reporting user paying JPY 5,000 in Tokyo on a USD card those
  -- are three different currencies (§3.7.2). Storing a USD figure in a row whose declared
  -- currency is JPY is a ~150x error that then propagates into the dedupe amount band, into
  -- adjustment_minor, and into every report — so the bank family gets its own explicit triple.
  bank_currency_code      TEXT REFERENCES currencies(code) ON DELETE RESTRICT,
  bank_exponent           INTEGER CHECK (bank_exponent IS NULL OR bank_exponent BETWEEN 0 AND 8),
  authorized_amount_minor INTEGER
    CHECK (authorized_amount_minor IS NULL OR authorized_amount_minor BETWEEN 0 AND 9007199254740991),
  settled_amount_minor    INTEGER
    CHECK (settled_amount_minor IS NULL OR settled_amount_minor BETWEEN 0 AND 9007199254740991),

  -- The amount to use for anything denominated in currency_code: reports, dedupe bands, refund
  -- netting. The CASE is the whole point — when the bank's currency differs from the event's,
  -- settlement does NOT change the event amount (JPY 5,000 is JPY 5,000 whatever the issuer
  -- charged), so the bank figures must not leak into it.
  effective_amount_minor  INTEGER GENERATED ALWAYS AS (
    CASE WHEN bank_currency_code IS NULL OR bank_currency_code = currency_code
         THEN COALESCE(settled_amount_minor, authorized_amount_minor, amount_minor)
         ELSE amount_minor END) STORED,
  -- The amount to use for anything denominated in bank_currency_code: matching an arriving
  -- settlement message against an existing authorization, and the account-side dedupe band.
  bank_effective_amount_minor INTEGER GENERATED ALWAYS AS
    (COALESCE(settled_amount_minor, authorized_amount_minor)) STORED,
  -- Signed delta, the one deliberate exception to rule 10. Both operands are in
  -- bank_currency_code by construction, so it is coherent without further qualification.
  adjustment_minor        INTEGER GENERATED ALWAYS AS
    (CASE WHEN settled_amount_minor IS NOT NULL AND authorized_amount_minor IS NOT NULL
          THEN settled_amount_minor - authorized_amount_minor END) STORED,
  -- Set only when adjustment_minor > 0 and merchant_class is tip-bearing. In bank_currency_code,
  -- like everything else in this block. Mastercard allows a 20% tip tolerance; Visa allows 15%
  -- auth-to-clearing plus gratuity up to 20% of base. So the legitimate settle/auth ratio is
  -- bounded ~1.25 — beyond that it is a CONFLICT, not a match.
  tip_minor               INTEGER
    CHECK (tip_minor IS NULL OR tip_minor BETWEEN 0 AND 9007199254740991),
  merchant_class          TEXT,
  -- Local expiry timer for an unsettled authorization. Defaults: 3 (fuel), 8 (default),
  -- 31 (hotel / car rental / cruise). NULL means "never expire on a timer" and is the correct
  -- setting wherever settlement is structurally unobservable — an iOS-only install, or an
  -- account whose sender has never produced a bank_settle observation. Expiring a hold because
  -- the settlement message could never have arrived removes a real purchase from every total.
  hold_ttl_days           INTEGER CHECK (hold_ttl_days IS NULL OR hold_ttl_days > 0),

  -- ── reporting conversion (account/base currency). See §3.3 for why all of it is stored. ──
  reporting_currency_code TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  reporting_exponent      INTEGER NOT NULL CHECK (reporting_exponent BETWEEN 0 AND 8),
  reporting_amount_minor  INTEGER NOT NULL
    CHECK (reporting_amount_minor BETWEEN 0 AND 9007199254740991),
  reporting_rate_id       TEXT REFERENCES fx_rates(id) ON DELETE RESTRICT,
  -- Denormalized so re-derivation needs no join. The 2^53 bound is NOT decoration here: a
  -- composed cross rate can carry a denominator of 1e20 before reduction, the insert would
  -- succeed without the CHECK, and every subsequent read would come back truncated through
  -- sqlite3_column_double() — producing an fx_rederivations row for a transaction whose rate
  -- never actually changed. See rule 2 and §3.3.2's reduce-to-lowest-terms requirement.
  reporting_rate_num      INTEGER
    CHECK (reporting_rate_num IS NULL OR reporting_rate_num BETWEEN 1 AND 9007199254740991),
  reporting_rate_den      INTEGER
    CHECK (reporting_rate_den IS NULL OR reporting_rate_den BETWEEN 1 AND 9007199254740991),
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
  -- effective_amount_minor - SUM(line_items.amount_minor WHERE line_type NOT IN
  -- ('subtotal','total')). Nullable. Soft reconciliation: surfaced and correctable, never a
  -- rejection. At 0.80 F1 a hard CHECK would reject a large fraction of real receipts.
  -- The exclusion set is 'subtotal','total' ONLY — see §3.8. Summing just line_type='item'
  -- makes this non-zero on every taxed or tipped receipt (a Spanish restaurant bill with 21%
  -- IVA and a tip is off by 23% with zero extraction errors), which floods the review inbox
  -- with correct receipts and forces a tolerance so wide it swallows a real 27.50-vs-275.00
  -- decimal misparse.
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
  CHECK (kind <> 'installment_payment' OR parent_txn_id IS NOT NULL),
  -- a bank figure without its currency is the whole three-currency bug in one row
  CHECK ((authorized_amount_minor IS NULL AND settled_amount_minor IS NULL AND tip_minor IS NULL)
         OR (bank_currency_code IS NOT NULL AND bank_exponent IS NOT NULL)),
  CHECK (bank_currency_code IS NULL OR bank_exponent IS NOT NULL),
  -- an FX rate is a pair or it is nothing
  CHECK ((reporting_rate_num IS NULL) = (reporting_rate_den IS NULL))
) STRICT;
```

Two coherence rules that a `CHECK` cannot express, because they reference a generated column
whose evaluation order relative to table constraints SQLite does not guarantee, or reference
another table. Both are triggers in §3.19 and both are load-bearing:

- **`reporting_source = 'same_currency'` ⇒ `reporting_amount_minor = effective_amount_minor`.**
  Without it, a €25.00 authorization that settles at €27.50 with a tip leaves
  `reporting_amount_minor` at 2500 forever: `effective_amount_minor` is generated and updates
  itself, `reporting_amount_minor` is a plain column and does not. Every base-currency report is
  then €2.50 short on every tipped transaction, permanently, and the budget-staleness trigger
  happily recomputes the period from the same stale number.
  (`trg_txn_reporting_same_currency_ins` / `_upd`.)
- **`reporting_source = 'actual'` ⇒ `reporting_currency_code` = the primary account's currency.**
  "The number the bank actually charged" is only meaningful when the card is denominated in the
  reporting currency; otherwise what the bank charged is the *settlement* conversion, which lives
  on `entries`, not here. (`trg_txn_reporting_actual`.)

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
-- dedupe blocking (§3.12) — the exact leading columns of the blocking SELECT, EVENT-currency arm
CREATE INDEX ix_txn_block      ON transactions(account_id, currency_code, effective_amount_minor,
                                               booked_at_utc)
  WHERE deleted_at IS NULL AND disposition = 'active';
-- dedupe blocking, BANK-currency arm. An arriving settlement message is denominated in the
-- card's currency; on a foreign purchase that is not currency_code, and without this arm the
-- settlement never blocks against its own authorization and becomes a duplicate transaction.
CREATE INDEX ix_txn_block_bank ON transactions(account_id, bank_currency_code,
                                               bank_effective_amount_minor, booked_at_utc)
  WHERE deleted_at IS NULL AND disposition = 'active' AND bank_currency_code IS NOT NULL;
-- recent captures feed
CREATE INDEX ix_txn_captured   ON transactions(captured_at_utc DESC) WHERE deleted_at IS NULL;
-- hold expiry sweep. hold_ttl_days IS NOT NULL is part of the predicate: a NULL TTL means
-- settlement is structurally unobservable on this account and the row must never be expired
-- by a timer.
CREATE INDEX ix_txn_holds      ON transactions(booked_at_utc)
  WHERE clearing_state = 'authorized' AND hold_ttl_days IS NOT NULL AND deleted_at IS NULL;
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
AND clearing_state IN ('unknown','authorized','settled','disputed','chargeback_lost')
```

`authorized` counts because users want the coffee to appear immediately — which is exactly why
`expired` must exist to take phantom holds back out. `unconfirmed`/`needs_review` rows **do**
count, with a visible "N unreviewed" affordance: quarantining them makes the app lie about the
user's balance, which is worse than including a number that is 80% likely right and clearly
marked. Only `draft` (mid-edit, may be unbalanced) is excluded, via `disposition`/`confirm_state`.

**`'unknown'` counts, and its absence from an earlier draft of this predicate was the single most
consequential omission in the schema.** `clearing_state` defaults to `'unknown'` and only a bank
message, a statement line or an explicit cash confirmation moves it off that default. Nothing does
so for manual entry, `camera_receipt`, `screenshot_ocr`, `voice`, `ios_share`, `ios_shortcut`,
`ios_wallet_intent` or `kind = 'opening_balance'` — which between them are *every* transaction an
iOS user will ever create, plus the seeded opening balances on both platforms. With `'unknown'`
excluded, an iPhone user gets a full timeline and a €0.00 spend figure, and D42's "opening balances
are real balanced transactions, which is exactly what makes `v_account_balances` a pure SUM"
silently evaluates to zero. Two rules follow and both are enforced:

- The repository sets `clearing_state = 'settled'` at insert for any transaction whose
  `input_channel` is not a passive bank channel, and for `kind = 'opening_balance'`. `'unknown'` is
  reserved for a row that came from a bank channel and has not yet been classified as auth or
  settlement (§4.2.1's transition table).
- Sweep check **I14** (§3.21) reports bank-channel rows still at `'unknown'` more than seven days
  after capture. Leaving the default in place forever means the auth/settle state machine never
  engaged for that sender.

**Leaving this predicate is a user-visible event, never a silent one** (rule 11). The transition
that matters is `authorized → expired`, which is driven by a *local timer* rather than by any
message: the moment it fires, the amount disappears from every budget, category rollup and account
balance. That is correct when the hold really was phantom and catastrophic when the settlement
message merely went missing — a two-week notification-listener outage, or an iPhone, where
settlement is unobservable by construction. So `HOLD_TTL_ELAPSED` **must** set `needs_review = 1`,
`v_review_inbox` carries an explicit `clearing_state = 'expired'` branch (§3.20) reading *"hold
expired — did this go through?"*, and `hold_ttl_days` is left NULL wherever settlement cannot be
observed, so no timer fires at all.

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
*Rejected: Agent 5's `SUM(home_amount_minor) = 0` trigger.* (§3.7.3 does add per-leg **reporting**
amounts, but they are an *allocation* of the header total across category legs, not an independent
per-leg conversion, and no zero-sum invariant is asserted over them. That is the distinction that
makes them safe.)

**One leg, one currency, and it is the account's.** Every leg posted to a single-currency account
must be denominated in that account's currency (`trg_entries_account_currency`, §3.19). The
settlement conversion — what a JPY purchase actually took out of a USD card — is expressed as an
explicit pair of `fx_conversion` legs against `sys_fx_conversion`, exactly the way §3.7.2 already
models a cross-currency transfer, and **not** as a parallel per-leg account-currency column.
*Rejected, and this is a correction to an earlier draft of this section: `account_amount_minor` /
`account_currency_code` / `account_exponent` on `entries`. Those columns were written on every
foreign transaction and read by nothing — no view summed them, no seal predicate checked them, no
sweep verified them — so the account-currency dimension was a second, silently unbalanced ledger.
The concrete symptom: `v_account_balances` sums `amount_minor` grouped by leg currency, so a USD
card carrying a ¥5,000 leg reported a balance line of "−¥5,000" and a USD balance of $0.00 while
the bank said −$33.42. Explicit conversion legs fix it without a second invariant.*

```sql
CREATE TABLE entries (
  id            TEXT PRIMARY KEY,
  txn_id        TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  leg_index     INTEGER NOT NULL CHECK (leg_index >= 0),
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  role          TEXT NOT NULL CHECK (role IN (
                  'source','destination','category','fee','fx_conversion',
                  'imbalance','clearing','receivable','payable','opening_balance',
                  -- the two legs of an MSI monthly charge: current balance down, deferred
                  -- balance up, both on the same card, no category leg. See §3.7.4.
                  'installment_deferral')),

  -- The leg IN ITS OWN CURRENCY, which is also its ACCOUNT's currency unless the account is
  -- multi-currency (§3.4.1). SIGNED (rule 10). This is the column the balance invariant sums
  -- and the column every balance and category view sums. There is no second amount column.
  amount_minor      INTEGER NOT NULL
    CHECK (amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  currency_code     TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  currency_exponent INTEGER NOT NULL CHECK (currency_exponent BETWEEN 0 AND 8),

  -- ── settlement conversion, expressed as a linked PAIR of fx_conversion legs ───────────
  -- Two legs sharing a non-NULL fx_pair_index within one transaction form one conversion:
  -- opposite signs, different currencies, and the rate below relates them. This is what
  -- carries "the issuer converted ¥5,000 into $33.42 at their rate including spread" as
  -- auditable ledger data instead of a write-only column.
  fx_pair_index     INTEGER CHECK (fx_pair_index IS NULL OR fx_pair_index >= 0),
  settle_rate_num   INTEGER CHECK (settle_rate_num IS NULL OR
                                   settle_rate_num BETWEEN 1 AND 9007199254740991),
  settle_rate_den   INTEGER CHECK (settle_rate_den IS NULL OR
                                   settle_rate_den BETWEEN 1 AND 9007199254740991),
  settle_rate_source TEXT CHECK (settle_rate_source IS NULL OR
                          settle_rate_source IN ('actual','derived','manual')),

  memo          TEXT,
  -- The two legs of a cross-currency conversion against sys_fx_conversion are never rendered.
  -- NOT set on installment-deferral legs: those must stay visible or the user sees an empty
  -- transaction where their monthly card charge should be.
  is_auto_balance INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_balance IN (0,1)),

  -- Denormalized from the header. Deliberate: category-by-month and account-balance-by-month
  -- are the two hottest queries and joining to transactions for a date on every one of them
  -- is the difference between a 5 ms and a 60 ms budget screen. Paid for with a coherence
  -- trigger + the startup sweep, not with hope.
  booked_local_date TEXT NOT NULL
    CHECK (booked_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  booked_month      TEXT GENERATED ALWAYS AS (substr(booked_local_date,1,7)) STORED,

  -- ── reporting allocation (§3.7.3). Category legs only; NULL on every other role. ──────
  reporting_amount_minor  INTEGER
    CHECK (reporting_amount_minor IS NULL OR
           reporting_amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
  reporting_currency_code TEXT REFERENCES currencies(code) ON DELETE RESTRICT,
  reporting_exponent      INTEGER
    CHECK (reporting_exponent IS NULL OR reporting_exponent BETWEEN 0 AND 8),
  reporting_rate_num      INTEGER
    CHECK (reporting_rate_num IS NULL OR reporting_rate_num BETWEEN 1 AND 9007199254740991),
  reporting_rate_den      INTEGER
    CHECK (reporting_rate_den IS NULL OR reporting_rate_den BETWEEN 1 AND 9007199254740991),
  reporting_rate_date     TEXT
    CHECK (reporting_rate_date IS NULL OR
           reporting_rate_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  hlc TEXT NOT NULL, node_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,

  UNIQUE (txn_id, leg_index),

  -- A settlement rate only means something on a conversion pair.
  CHECK ((settle_rate_num IS NULL) = (settle_rate_den IS NULL)),
  CHECK (settle_rate_num IS NULL OR (fx_pair_index IS NOT NULL AND role = 'fx_conversion')),
  CHECK (fx_pair_index IS NULL OR role = 'fx_conversion'),
  -- reporting allocation is present as a set or absent as a set
  CHECK ((reporting_amount_minor IS NULL) = (reporting_currency_code IS NULL)),
  CHECK (reporting_amount_minor IS NULL OR reporting_exponent IS NOT NULL),
  CHECK (reporting_amount_minor IS NULL OR role = 'category')
) STRICT;

CREATE INDEX ix_entries_txn        ON entries(txn_id, leg_index);
CREATE INDEX ix_entries_acct_date  ON entries(account_id, booked_local_date);
CREATE INDEX ix_entries_acct_month ON entries(account_id, booked_month);
-- the "needs attention" queue is literally this
CREATE INDEX ix_entries_imbalance  ON entries(txn_id) WHERE account_id = 'sys_imbalance';
-- the OTHER "needs attention" queue: a one-sided transfer whose counterpart never arrived is
-- money removed from the spend number AND added to net worth, in a clearing account that will
-- never resolve on its own. Aged by sweep check I13 and surfaced in v_review_inbox.
CREATE INDEX ix_entries_unmatched  ON entries(booked_local_date)
  WHERE account_id = 'sys_unmatched_transfer';
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

  -- THE HEADER/LEG TIE. Without it, a two-leg balanced transaction is indistinguishable from a
  -- correct one even when a user's three-way category split has just been silently collapsed
  -- into one leg by a settlement rebuild: legs still sum to zero, so I1 stays quiet. This is
  -- the check whose absence let that happen. Only applies where category legs exist (transfers
  -- and installment charges legitimately have none) and only over legs denominated in the
  -- header's own currency.
  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM entries e
       WHERE e.txn_id = NEW.txn_id AND e.role = 'category')
   AND (SELECT COALESCE(SUM(e.amount_minor),0) FROM entries e
         WHERE e.txn_id = NEW.txn_id AND e.role = 'category'
           AND e.currency_code = (SELECT t.currency_code FROM transactions t
                                   WHERE t.id = NEW.txn_id))
     <> (SELECT CASE WHEN t.direction = 'debit' THEN t.effective_amount_minor
                     ELSE -t.effective_amount_minor END
           FROM transactions t WHERE t.id = NEW.txn_id)
    THEN RAISE(ROLLBACK, 'seal: category legs do not sum to the header effective amount') END;

  -- FX conversion pairs are exactly two legs, opposite signs, different currencies, both
  -- carrying the SAME non-NULL rate. A half-written pair balances per currency and is still
  -- wrong, and a pair with no rate at all is a conversion nobody can audit — which is the whole
  -- reason the pair replaced a write-only rate column. Deliberately STRICTER than the
  -- column-level CHECK, which only says a rate implies a pair and not the converse: the column
  -- constraint fires per row and cannot see its partner, so requiring the rate has to happen
  -- here.
  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM entries e
       WHERE e.txn_id = NEW.txn_id AND e.fx_pair_index IS NOT NULL
       GROUP BY e.fx_pair_index
      HAVING COUNT(*) <> 2
          OR COUNT(DISTINCT e.currency_code) <> 2
          OR COUNT(e.settle_rate_num) <> 2            -- COUNT ignores NULLs: both must be set
          OR COUNT(DISTINCT e.settle_rate_num) <> 1   -- and both must agree
          OR COUNT(e.settle_rate_den) <> 2
          OR COUNT(DISTINCT e.settle_rate_den) <> 1
          OR MIN(e.amount_minor) >= 0 OR MAX(e.amount_minor) <= 0)
    THEN RAISE(ROLLBACK, 'seal: malformed fx_conversion pair') END;

  -- The reporting allocation must reconstitute the header exactly (§3.7.3). A drifting
  -- allocation is how the category report and the transaction list end up disagreeing by a
  -- cent per receipt, forever, with nothing looking for it.
  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM entries e
       WHERE e.txn_id = NEW.txn_id AND e.reporting_amount_minor IS NOT NULL
         AND e.currency_code = (SELECT t.currency_code FROM transactions t
                                 WHERE t.id = NEW.txn_id))
   AND (SELECT COALESCE(SUM(ABS(e.reporting_amount_minor)),0) FROM entries e
         WHERE e.txn_id = NEW.txn_id AND e.reporting_amount_minor IS NOT NULL
           AND e.currency_code = (SELECT t.currency_code FROM transactions t
                                   WHERE t.id = NEW.txn_id))
     <> (SELECT t.reporting_amount_minor FROM transactions t WHERE t.id = NEW.txn_id)
    THEN RAISE(ROLLBACK, 'seal: leg reporting allocation does not sum to the header') END;
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

#### 3.7.2 Worked examples — the three shapes `buildEntries` must produce

These are normative. `buildEntries(draft) → Entry[]` is implemented from them.

**(a) A cross-currency transfer.** €920 out of a EUR account into a USD account that received
$1,000. One transaction, four legs, each currency summing to zero, with the FX position
accumulating in equity where it belongs:

| leg | account | role | amount_minor | currency | fx_pair |
| --- | --- | --- | --- | --- | --- |
| 0 | Checking (EUR) | `source` | −92000 | EUR | — |
| 1 | `sys_fx_conversion` | `fx_conversion` | +92000 | EUR | 0 |
| 2 | `sys_fx_conversion` | `fx_conversion` | −100000 | USD | 0 |
| 3 | Savings (USD) | `destination` | +100000 | USD | — |

EUR sums to 0, USD sums to 0. Legs 1 and 2 carry `is_auto_balance = 1`, share `fx_pair_index = 0`
and carry `settle_rate_num/den = 92/100`, and are never rendered. Net worth is `SUM` over
asset/liability accounts and the transfer contributes zero automatically — there is no
`WHERE kind <> 'transfer'` anywhere in the codebase, which is the entire point. There are no
category legs, so the seal's header/leg tie does not apply.

**(b) The three-currency case.** A EUR-reporting user buys a ¥5,000 lunch in Tokyo on a USD card.
The issuer converts at their own rate including spread and charges $33.42, plus a $1.00
cross-border fee. Header: `currency_code='JPY'`, `amount_minor=5000`, `direction='debit'`,
`bank_currency_code='USD'`, `bank_exponent=2`, `authorized_amount_minor=3342`. Six legs:

| leg | account | role | amount_minor | currency | fx_pair | reporting |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Card (USD) | `source` | −3342 | USD | — | NULL |
| 1 | `sys_fx_conversion` | `fx_conversion` | +3342 | USD | 0 | NULL |
| 2 | `sys_fx_conversion` | `fx_conversion` | −5000 | JPY | 0 | NULL |
| 3 | `Expenses:Food` | `category` | +5000 | JPY | — | +2900 EUR |
| 4 | Card (USD) | `source` | −100 | USD | — | NULL |
| 5 | `sys_bank_fees` | `category` | +100 | USD | — | — |

USD sums to 0 (−3342 +3342 −100 +100), JPY sums to 0. `v_account_balances` now reports the card at
−$34.42, which is what the statement says; before explicit conversion legs it reported "−¥5,000"
and a USD balance of $0.00. Legs 1 and 2 share `fx_pair_index = 0` and carry
`settle_rate_num/den = 3342/5000`, `settle_rate_source = 'actual'` — that is the issuer's real
rate, spread included, recoverable years later.

The fee is a **real leg pair** against `sys_bank_fees`, not a `fee_minor` column. *Rejected, and a
correction to an earlier draft: `entries.fee_minor`. It sat outside the balance invariant — the
seal, `v_account_balances` and `v_category_month` all sum `amount_minor` only — so a $1.00 fee
booked into it left the ledger balanced and the dollar in no balance, no category and no budget.
Money vanishing from the sole system of record. `role = 'fee'` remains in the enum for legs against
a user's own bank-fee category; the seeded `sys_bank_fees` account is the default target and
"what did FX cost me this year" is then an ordinary category query.*

Leg 5's reporting allocation is elided in the table for width; in reality legs 3 and 5 are both
category legs and the allocation of §3.7.3 runs over both. Note that leg 5 is denominated in USD
while the header is JPY, so it is **excluded** from the seal's header/leg tie (which filters on
`currency_code = t.currency_code`) — the fee is not part of the ¥5,000 economic event.

**(c) A split receipt.** €120 at a supermarket, split €90 to `food.groceries` and €30 to
`household.supplies`:

| leg | account | role | amount_minor | currency |
| --- | --- | --- | --- | --- |
| 0 | Card (EUR) | `source` | −12000 | EUR |
| 1 | `Expenses:Food:Groceries` | `category` | +9000 | EUR |
| 2 | `Expenses:Household:Supplies` | `category` | +3000 | EUR |

Category legs sum to +12000 = the header's `effective_amount_minor`, so the seal's header/leg tie
holds. `line_items` rows point at leg 1 or leg 2 via `entry_id`.

#### 3.7.3 Rebuilding legs, and the reporting allocation

**Rebuilding is a re-scale, not a regeneration, whenever the user has split the transaction.**
A settlement arrival and any money-bearing user edit must adjust the existing leg set; only a
single-category transaction may be rebuilt wholesale from the flat draft. The reason is blunt:
`buildEntries(draft)` takes the flat façade as input, and the flat façade **has no representation
for a multi-way split**. Regenerating from it silently un-splits every split receipt the first time
a settlement lands or the user fixes an OCR typo in the amount. The rule:

1. If the transaction has **at most one** `role = 'category'` leg, rebuild from the draft.
2. If it has **two or more**, re-scale: keep every leg's `account_id`, `role`, `leg_index` and
   `line_items.entry_id` linkage, and allocate the delta across the existing category legs by
   largest remainder (rule 9) in proportion to their current magnitudes.
3. A rebuild that *would* drop or orphan a user-created leg is **not** performed. It raises
   `needs_review = 1` and writes a `field_conflicts` row, because the alternative is deleting a
   user's work with no event naming it.
4. `line_items.entry_id` is `ON DELETE RESTRICT` (§3.8), so step 3 is enforced by the database
   rather than by the caller remembering: a rebuild that tries to delete a linked leg fails loudly
   instead of nulling twenty-three line items on the way past.
5. A write of `category_id` onto a transaction that already has two or more category legs is
   **rejected**, not treated as a money-bearing rebuild trigger. "Set the category" has no
   well-defined meaning on a split.

**The reporting allocation.** `entries.reporting_amount_minor` exists because every category
rollup, budget actual and `budget_periods.actual_minor` is computed over `entries`, while
`reporting_amount_minor` previously lived only on the header — so the conversion from many leg
currencies into the budget currency happened somewhere unspecified, with no stored amount, no rate
id and no re-derivability. It is computed by exactly one function:

```text
allocateReporting(txn):
  total  = txn.reporting_amount_minor                    # header, converted ONCE
  # ONLY the legs that are parts of the header amount: category legs denominated in the
  # header's own currency. A category leg in some OTHER currency is a separate economic item
  # riding along on the same posting — the $1.00 cross-border fee on a ¥5,000 lunch — and is
  # converted independently below, not carved out of the ¥5,000.
  legs   = entries WHERE role = 'category' AND currency_code = txn.currency_code
  shares = largestRemainder(total, [abs(l.amount_minor) for l in legs])   # rule 9
  for l, s in zip(legs, shares):
      l.reporting_amount_minor  = sign(l.amount_minor) * s
      l.reporting_currency_code = txn.reporting_currency_code
      l.reporting_exponent      = txn.reporting_exponent
      l.reporting_rate_num/den  = txn.reporting_rate_num/den
      l.reporting_rate_date     = txn.reporting_rate_date

  # other-currency category legs: one convert() each, with their OWN resolved rate, recorded
  # per leg so they are re-derivable by the same §3.3.4 pass.
  for l in entries WHERE role = 'category' AND currency_code <> txn.currency_code:
      rate = resolveRate(l.currency_code -> txn.reporting_currency_code, txn.booked_local_date)
      l.reporting_amount_minor  = convert(l.amount_minor, l.currency_exponent,
                                          txn.reporting_exponent, rate.num, rate.den)
      l.reporting_currency_code = txn.reporting_currency_code   # required by the column CHECKs
      l.reporting_exponent      = txn.reporting_exponent        # required by the column CHECKs
      l.reporting_rate_num/den/date = rate.*
```

Converting each leg independently is what produces the classic off-by-one-cent: ¥1,000 split
334/333/333 at 5/1000 gives 167 + 166 + 166 = 499 while the header says 500, so the category report
and the transaction detail screen disagree by a cent that has no home. Allocating the *converted
total* makes the sum exact by construction, and the seal asserts it. Non-category legs carry NULL
reporting amounts deliberately — account balances are revalued at the valuation date (§3.3.5), not
summed from transaction-date conversions, so they never need one.

Whenever `transactions.reporting_amount_minor` changes — FX re-derivation (§3.3.4 step 4), a
settlement that moved `effective_amount_minor`, a base-currency change — `allocateReporting` re-runs
in the same batch.

#### 3.7.4 Installment (MSI) leg composition

D49's promise — "spend is accrual, recognised once in full on the purchase date; cash flow is the
schedule; two queries over the same rows" — is only realisable if the monthly charges carry **no
category leg**. §3.5.2's predicate has no `kind` filter and D47 depends on there never being one,
so the accrual/cash-flow split has to come from leg composition, not from a `WHERE`.

- **Origin purchase** (MXN 12,000.00 television at 12 MSI): ordinary expense shape — −1200000 on
  the card, +1200000 to `Electronics`. The full amount is recognised on the purchase date.
- **Each of the twelve monthly charges**: `kind = 'installment_payment'`, `parent_txn_id` set,
  two legs, both on the card, no category leg:

| leg | account | role | amount_minor | currency |
| --- | --- | --- | --- | --- |
| 0 | Card (MXN) | `source` | −100000 | MXN |
| 1 | Card:Deferred (MXN) | `installment_deferral` | +100000 | MXN |

  `Card:Deferred` is a child account of subtype `installment_deferred`, created on demand. The
  charge moves the liability from deferred to current; it is economically real, it appears in the
  timeline and in the account's transaction list, and it adds **nothing** to any category. Without
  this shape the twelve charges either double-count MXN 12,000.00 of Electronics spend across the
  year (if they carry category legs) or land in the `sys_imbalance` "needs attention" queue forever
  (if they carry none and nothing absorbs the other side).
- These legs keep `is_auto_balance = 0`. Auto-balance legs are never rendered, and a monthly card
  charge that renders as an empty transaction is worse than the double-count it was avoiding.
- Both legs have `role <> 'category'`, so the seal's header/leg tie does not apply and no category
  rollup sees them. `interest_minor` on the plan, when non-zero, is booked as a separate ordinary
  expense leg pair against `sys_bank_fees` on each charge.

---

### 3.8 line_items

```sql
CREATE TABLE line_items (
  id            TEXT PRIMARY KEY,
  txn_id        TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  -- Set once the user splits the receipt across categories. AUTHORITATIVE for money.
  -- ON DELETE RESTRICT, per rule 6 — NOT SET NULL. SET NULL was the mechanism by which a
  -- settlement rebuild silently un-split a receipt: rewriteLegs deleted the three legs, the FK
  -- quietly nulled entry_id on all twenty-three line items, two fresh legs were built from the
  -- flat draft, and the seal passed because the new legs balanced. RESTRICT converts that from
  -- undetectable data loss into a caught error at the first attempt (§3.7.3 rule 4).
  entry_id      TEXT REFERENCES entries(id) ON DELETE RESTRICT,
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
  -- the receipt. This enum is not optional. 'subtotal' and 'total' are RECAPITULATION lines and
  -- are the only two excluded from the delta sum (§3.5); everything else is a real component of
  -- what was paid.
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
  UNIQUE (txn_id, line_index),

  -- Sign convention (rule 10): amount_minor carries the SAME SIGN as the transaction's category
  -- legs, so discounts and cash-rounding reduce the sum rather than being subtracted by a reader
  -- who has to guess. Without a stated convention, items 50.00 / discount 5.00 / total 45.00
  -- yields a delta of -500 or +500 depending on who wrote the extractor, and both look plausible.
  CHECK (line_type <> 'discount' OR amount_minor <= 0),
  CHECK (line_type <> 'rounding' OR amount_minor IS NOT NULL)
) STRICT;

CREATE INDEX ix_line_items_entry ON line_items(entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX ix_line_items_type  ON line_items(txn_id, line_type);
```

*One consequence of `RESTRICT` to know about: `transactions → entries` and `transactions →
line_items` are both `ON DELETE CASCADE`, and SQLite does not order the two cascade branches, so a
**hard** delete of a transaction can hit `line_items.entry_id`'s RESTRICT before the `line_items`
rows themselves are removed. Transactions are soft-deleted and hard delete is blocked by
`trg_transactions_no_hard_delete` (§3.19) unless `meta.allow_hard_delete = 'yes'`, so this only
arises in the reviewed maintenance path — where the procedure is to `DELETE FROM line_items WHERE
txn_id = ?` first, explicitly. That is the correct trade: a noisy maintenance step in exchange for
the everyday write path being unable to silently orphan a split.*

**Deliberately no CHECK that line items sum to the transaction total.** At 0.80 F1 plus real
receipts carrying tax/tip/discount/rounding lines, a hard constraint rejects a large fraction of
genuine input. Reconciliation is soft: `transactions.line_items_delta_minor` records

```text
effective_amount_minor − SUM(line_items.amount_minor WHERE line_type NOT IN ('subtotal','total'))
```

and `needs_review` flags it. The exclusion set is exactly those two recapitulation types — **not**
"only `line_type='item'`". A correctly extracted Spanish restaurant receipt (items €42.00, IVA 21%
€8.82, tip €4.00, total €54.82) has a delta of 0 under this definition and a delta of 1282 — 23% of
the total — under the items-only one. Getting it wrong means every taxed receipt lands in the review
inbox with zero extraction errors, which trains the dismiss-the-inbox reflex, and forces a tolerance
band wide enough to swallow a genuine 27.50-vs-275.00 decimal misparse on a small receipt. With this
definition the tolerance is tight: one minor unit plus `currencies.cash_rounding_minor`.

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
    CHECK (amount_minor IS NULL OR amount_minor BETWEEN 0 AND 9007199254740991),
  -- Rule 2 has no exemptions, and this one bites hard: v_txn_net subtracts refund amounts from
  -- effective_amount_minor. A ¥5,000 Tokyo purchase refunded as €30.90 gave net = 5000 − 3090 =
  -- 1910, so the UI reported ¥1,910 outstanding on a fully refunded purchase and sweep check I8
  -- stayed silent; the mirror case raised I8 on a perfectly correct link. §4.10 explicitly
  -- contemplates cross-currency refunds, so this is the expected case, not an edge one.
  currency_code        TEXT REFERENCES currencies(code),
  currency_exponent    INTEGER CHECK (currency_exponent IS NULL OR currency_exponent BETWEEN 0 AND 8),
  confidence           REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  created_by           TEXT NOT NULL CHECK (created_by IN ('system','user','replay')),
  created_at           INTEGER NOT NULL,
  UNIQUE (kind, from_transaction_id, to_transaction_id),
  CHECK (from_transaction_id <> to_transaction_id),
  CHECK (amount_minor IS NULL OR (currency_code IS NOT NULL AND currency_exponent IS NOT NULL))
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
(Android: the **credential-protected** `context.getFilesDir()/spool/` — see 02-storage.md §2.8.1,
which owns this decision; iOS: the App Group container at
`NSFileProtectionCompleteUntilFirstUserAuthentication`). The main app drains the spool into
`raw_captures`. The database file itself stays in the app's own container and is never reachable
from a second process — SQLCipher + WAL inside an iOS App Group container is a deterministic
`0xdead10cc` termination on every backgrounding.

*A device-protected (`createDeviceProtectedStorageContext()`) spool is explicitly **not** used, and
this section previously said otherwise. Two reasons: the unsealing key is credential-gated anyway
so a DE-placed file could not be drained before first unlock regardless, and DE storage is backup
domain `device_file`, which means every `<exclude domain="file" path="spool/">` rule written against
it silently matches nothing and ships the spool to Google Drive.*

**The producer cannot read this database, so anything it must consult is a mirror file, not a
table.** op-sqlite's Android Kotlin surface is `install()` / `getDylibPath()` /
`moveAssetsDatabase()` — there is no native query API. Two tables in this section are therefore
paired with a versioned file mirror owned by 04-capture.md: `capture_senders` (the ingest allowlist
the listener must consult before spooling) and the `capture_health` heartbeat the listener must
append to. The contract in both directions — JS writes files Kotlin reads, Kotlin appends files the
drain folds in — is specified once in 04-capture.md and referenced here. The important consequence
for the schema is that **the mirror can be absent** (fresh restore, first launch after a
device-to-device transfer), so the producer's fail-closed path must leave a trace the drain can turn
into a `capture_gaps` row with `cause = 'mirror_unavailable'`. Silence is the one failure this
design cannot tolerate.

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
  -- There is NO public API to detect it (Ranking has no hasSensitiveContent() through API 36).
  --
  -- The PRIMARY test is DIFFERENTIAL and runs at DRAIN time, because it needs the fingerprint
  -- history in bank_templates and the producer cannot read this database: for a sender with >= N
  -- successfully-parsed captures, a capture whose §3.13 skeleton fingerprint is novel, whose
  -- EXTRA_TEXT_LINES and EXTRA_SUB_TEXT are both absent, and whose body yields no amount-pattern
  -- match is redaction_suspected = 1.
  --
  -- Label equality (title == packageManager.getApplicationLabel()) is a CORROBORATING signal
  -- only, evaluated in a try/catch by the producer and recorded in payload_meta_json as one of
  -- three states: 'label_equal' | 'label_differs' | 'label_unavailable'. It cannot be the primary
  -- test because every way it fails returns "not redacted": Android 11+ package-visibility
  -- filtering can make getApplicationInfo() throw NameNotFoundException (QUERY_ALL_PACKAGES is
  -- Play-restricted and budgeting is not a permitted use), and the system label is localized to
  -- the SYSTEM locale while the comparison string is read under the APP locale. A heuristic that
  -- can only ever return 0 makes redaction_count a flat line, which is exactly the measurement
  -- the READ_SMS scope decision is gated on.
  redaction_suspected INTEGER NOT NULL DEFAULT 0 CHECK (redaction_suspected IN (0,1)),

  -- Why an 'ignored' capture was ignored. Open vocabulary (rule 7b), validated in the repository:
  --   'not_allowlisted' | 'no_amount_pattern' | 'otp_lexicon' | 'promo_lexicon'
  --   | 'group_summary'   -- Android group-summary notification; the child carries the real event
  --   | 'own_package'     -- our own liveness probe / "N items waiting" notification
  --   | 'sender_unresolvable'  -- relay-channel SMS whose originating sender could not be recovered
  -- NULL whenever process_state <> 'ignored'.
  ignored_reason TEXT,

  -- 1 when the capture was spooled while capture_senders.diagnostics_until > now, i.e. with the
  -- ingest filter's negative lexicon DISABLED for that sender. A diagnostics capture is a normal
  -- pipeline citizen (it still goes queued -> parsed), so this is a separate dimension and not a
  -- process_state value. It force-stamps training_opt_in = 0 and purge_after = diagnostics_until
  -- regardless of any grant, and is excluded from the training-export query by construction.
  -- Diagnostics mode is precisely the switch that turns off "OTPs never hit disk"; without this
  -- flag those bodies inherit the 30-day sms_text TTL, or NULL forever under training consent,
  -- and ship inside every .mmbak.
  captured_under_diagnostics INTEGER NOT NULL DEFAULT 0
    CHECK (captured_under_diagnostics IN (0,1)),

  seen_count     INTEGER NOT NULL DEFAULT 1,   -- re-delivery storms are observable, not silent
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,

  -- NO CLOSED CHECK LIST, per rule 7b — validated in the repository. This column has already
  -- had to absorb 'deferred_no_model' and will absorb more; a SQLITE_CONSTRAINT here aborts the
  -- whole drain batch under BEGIN IMMEDIATE, so the failure is "captures stop landing on the
  -- devices that needed the new state", not "one row is mislabelled". Known vocabulary:
  --   'queued' | 'in_flight' | 'parsed' | 'unparseable'
  --   | 'deferred_no_model'  -- first-class, NOT an error: the model may not be downloaded yet,
  --                          -- may have been deleted by the user to free space, or may have
  --                          -- OOMed. Captures queue indefinitely and drain when the engine
  --                          -- becomes available. NEVER purge-eligible (see below).
  --   | 'ignored'            -- filtered at ingest; see ignored_reason
  --   | 'redacted'           -- Android 15 redaction: nothing extractable arrived
  --   | 'purged'             -- retention ran: body gone, row and hashes retained
  process_state  TEXT NOT NULL DEFAULT 'queued',
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,                     -- backoff 1m/5m/30m/6h/24h then park
  last_error     TEXT,

  -- Consent, resolved as the AND of two facts, because each alone has a failure case:
  --   hint  = the consent state the PRODUCER observed at capture, carried in the spool manifest;
  --   grant = the authoritative consent_grants state the DRAIN reads at insert.
  --   training_opt_in = hint AND grant.
  -- Capture-time alone lets a Monday opt-in retroactively relicense a weekend of captures that
  -- were collected under no consent at all. Drain-time alone lets forty captures spooled under
  -- consent land as opted-in seconds AFTER the user revoked, because revocation can only reach
  -- rows that already exist. The AND honours revocation and forbids retroactive relicensing, and
  -- it is never recomputed afterwards.
  -- NOTE: 05-provenance.md §5.5.2 currently specifies drain-time only and must be amended to
  -- this rule; 04-capture.md §4.4.1's manifest field is the hint and is correct as written.
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
the same message as new, and would orphan the audit chain.

**A capture is purge-eligible only if the user has already had a chance to act on it.** `purge_after`
elapsing is necessary and not sufficient. The selection predicate is:

```sql
SELECT rc.id FROM raw_captures rc
 WHERE rc.purge_after IS NOT NULL AND rc.purge_after <= :now
   AND rc.purged_at IS NULL
   -- (1) it reached a terminal pipeline state. 'queued', 'in_flight' and especially
   --     'deferred_no_model' are inputs the user has not been able to act on yet.
   AND rc.process_state IN ('parsed','ignored','redacted')
   -- (2) nothing it produced is still awaiting the user
   AND NOT EXISTS (SELECT 1 FROM observations o JOIN transactions t ON t.id = o.txn_id
                    WHERE o.raw_capture_id = rc.id
                      AND t.confirm_state IN ('extracted','needs_review'))
   -- (3) it is not evidence in an open investigation
   AND NOT EXISTS (SELECT 1 FROM observations o JOIN field_conflicts fc ON fc.txn_id = o.txn_id
                    WHERE o.raw_capture_id = rc.id AND fc.status = 'open')
   AND NOT EXISTS (SELECT 1 FROM observations o JOIN balance_breaks bb
                     ON bb.from_obs_id = o.id OR bb.to_obs_id = o.id
                    WHERE o.raw_capture_id = rc.id AND bb.status = 'open');
```

Without clause (1) the failure is silent and total: a user who declines the 3.66 GB model download
on mobile data accumulates 600 `deferred_no_model` bank alerts that correctly show in the review
inbox as *"600 alerts we couldn't read yet"*, and on day 31 the purge nulls every body and sets
`process_state = 'purged'` — which is **not** in `v_review_inbox`'s capture branch, so the backlog
they were waiting to get onto Wi-Fi for silently drops from 600 to 0 and reads as "processed".
Notification-sourced captures have no retroactive source (§7.1.1); they are simply gone.
The same reasoning governs `receipt_image` retention: a flat TTL that deletes the original of a
receipt whose capture has never been extracted is the identical bug from the other direction, so
media purge takes the same predicate.

Two consequences that must not be dropped:

- **Nothing leaves the review inbox by expiring.** `v_review_inbox` (§3.20) carries a `'purged'`
  branch with a distinct reason, and the purge job reports *"N captures are past their retention
  window but have not been processed"* rather than either purging them or staying silent.
- **`captured_under_diagnostics = 1` overrides everything upward, not downward**: those rows get
  `purge_after = diagnostics_until` at insert and a dedicated sweep purges them on the first
  foreground after the window lapses, regardless of training consent.

The purge statement is exactly:

```sql
UPDATE raw_captures
   SET payload_text = NULL, payload_meta_json = :stripped_meta, media_asset_id = NULL,
       process_state = 'purged', purged_at = :now
 WHERE id = :id;
UPDATE corrections SET training_eligible = 0 WHERE raw_capture_id = :id;
UPDATE extraction_runs SET raw_output = NULL WHERE raw_capture_id = :id;
UPDATE extracted_fields SET span_start = NULL, span_end = NULL
 WHERE run_id IN (SELECT id FROM extraction_runs WHERE raw_capture_id = :id);
-- The statement nobody writes: oplog holds a verbatim copy of every column it recorded, and it
-- is retained for 90 days OR 200k rows WHICHEVER IS LARGER, copied into every .mmbak, and
-- designated the sync payload. See §3.18's column allowlist — with the allowlist in place this
-- deletes nothing, and it is kept as a belt-and-braces assertion that stays cheap.
DELETE FROM oplog WHERE table_name IN ('raw_captures','extraction_runs') AND row_id = :id;
```

The `corrections` statement is the half everyone forgets: a `corrections` row is only a training
example if its **input** still exists. Purge the text and keep the label and the dataset silently
rots. `training_opt_in = 1` sets `purge_after = NULL`, and the consent copy must literally say
*"these stay on your device until you turn this off."*

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
                  'receipt_image','screenshot','voice_audio','statement_pdf','thumbnail',
                  -- derived artifacts of the L1 crop/segment pipeline (see
                  -- ../2026-08-02-image-preprocessing.md). They are DERIVED, never authoritative:
                  -- re-extraction after a model upgrade always re-derives from the original, so a
                  -- cropping bug is never baked in permanently.
                  'receipt_crop','receipt_segment')),
  width         INTEGER, height INTEGER,
  -- Lineage. Generalized from the original `thumbnail_of`: a thumbnail is just one derivation, and
  -- crops/segments want the identical ON DELETE CASCADE — delete the original and every artifact
  -- derived from it goes too, which is exactly the "free up space" semantics.
  derived_from  TEXT REFERENCES media_assets(id) ON DELETE CASCADE,
  derivation_kind TEXT CHECK (derivation_kind IN ('thumbnail','content_crop','segment')),
  -- Source geometry in the PARENT's pixel space, so a bad crop is diagnosable after the fact
  -- without re-running the pipeline, and so a segment can be located in the receipt it came from.
  src_x         INTEGER, src_y INTEGER, src_w INTEGER, src_h INTEGER,
  segment_index INTEGER,        -- NULL unless derivation_kind = 'segment'
  segment_count INTEGER,
  -- Which tier produced the crop: the platform document scanner's quad, the union of OCR text-line
  -- boxes, or no crop at all. This is a METRIC, not bookkeeping — it is the only way to learn
  -- whether the document scanner earns its place on the receipts users actually photograph.
  crop_method   TEXT CHECK (crop_method IN ('scanner_quad','ocr_union','none')),
  -- Lineage columns are meaningful only together, and only on a derived row.
  CHECK ((derived_from IS NULL) = (derivation_kind IS NULL)),
  CHECK (derivation_kind IS NOT NULL OR (segment_index IS NULL AND segment_count IS NULL)),
  CHECK ((segment_index IS NULL) = (segment_count IS NULL)),
  CHECK (segment_index IS NULL OR (segment_index >= 0 AND segment_index < segment_count)),
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
-- Fetch every artifact derived from one original (segment merge, diagnosis, cascade preview).
CREATE INDEX ix_media_derived ON media_assets(derived_from, segment_index)
  WHERE derived_from IS NOT NULL;
-- Field measurement of scanner-quad vs OCR-union vs no-crop rates, feeding the metrics ledger.
CREATE INDEX ix_media_crop_method ON media_assets(crop_method, created_at DESC)
  WHERE crop_method IS NOT NULL;
```

**The export/backup path must bundle the `.db` *and* the media directory or the restore is
silently incomplete.** That is a correctness requirement, not a nicety, because there is no cloud
copy.

#### 3.10.1 The ingest filter — never lose a capture, never persist an OTP

```sql
-- Enforced in the PRODUCER, before anything is spooled, VIA THE MIRROR FILE — the producer is
-- native Kotlin / Swift and cannot read this table (see §3.10). This table is the authority; the
-- mirror is derived state, rewritten by the drain immediately after any COMMIT that mutates it.
-- Non-matching notifications and personal SMS are never written at all — filter before insert,
-- not after. That is both a privacy property and the strongest sentence in the Play SMS
-- declaration, and it is only true if the mirror actually reaches the producer, which is why the
-- fail-closed path leaves a marker the drain converts into a capture_gaps row.
CREATE TABLE capture_senders (
  id             TEXT PRIMARY KEY,
  -- NO CLOSED CHECK LIST (rule 7b). Known vocabulary:
  --   'android_notification'      -- the bank's own app posts the alert
  --   'android_notification_sms'  -- the MESSAGING app posts a notification relaying a bank SMS.
  --                               -- First-class and, in SMS-heavy markets, the PRIMARY Android
  --                               -- channel until READ_SMS ships. See sub_identifier.
  --   'android_sms'               -- READ_SMS / content://sms, v1.5
  --   'ios_wallet_intent'
  channel        TEXT NOT NULL,
  identifier     TEXT NOT NULL,          -- package name or normalized SMS sender address
  -- Second key component, NULL on every channel except 'android_notification_sms'. On the relay
  -- channel `identifier` is the messaging app's package and `sub_identifier` is the normalized
  -- bank shortcode, because the posting package for a relayed bank SMS is
  -- com.google.android.apps.messaging, not the bank. Without it the only way to receive Banorte's
  -- SMS-only alerts is to allowlist the entire messaging app — at which point every personal SMS
  -- reaches the amount-pattern test ("te debo 450, te pago el viernes" matches), lands verbatim
  -- in payload_text under the 30-day sms_text policy, and the Play declaration's "per-package and
  -- per-sender allowlist enforced in the producer" sentence is untrue in exactly the
  -- configuration the target market runs.
  -- The producer recovers the SMS sender from EXTRA_TITLE for the standard template and from
  -- MessagingStyle.extractMessagingStyleFromNotification() (conversationTitle / per-Message
  -- sender) for MessagingStyle posts. A relay notification whose sender cannot be recovered is
  -- ignored with ignored_reason = 'sender_unresolvable' — never admitted.
  sub_identifier TEXT,
  display_name   TEXT,
  enabled        INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  is_financial   INTEGER NOT NULL DEFAULT 0 CHECK (is_financial IN (0,1)),
  -- measured per bank, from day one, so redaction is a known property and not a platform mystery
  redaction_count   INTEGER NOT NULL DEFAULT 0,
  unsupported_count INTEGER NOT NULL DEFAULT 0,   -- fully-custom RemoteViews: nothing readable
  capture_count     INTEGER NOT NULL DEFAULT 0,
  -- user-initiated, time-boxed (24 h), per-sender "capture everything verbatim" switch for
  -- "my bank's messages aren't showing up". Expires automatically. IT DISABLES THE NEGATIVE
  -- LEXICON, i.e. it is the switch that turns off "OTPs never hit disk", so every capture taken
  -- during the window is stamped raw_captures.captured_under_diagnostics = 1, force-stamped
  -- training_opt_in = 0 regardless of any grant, and given purge_after = diagnostics_until.
  -- The consent screen must say that in those words.
  diagnostics_until INTEGER,
  -- learned empirically: only start trusting balance_after as an oracle after 20 consecutive
  -- continuous observations; stop if the break rate exceeds 20%.
  balance_trusted   INTEGER NOT NULL DEFAULT 0 CHECK (balance_trusted IN (0,1)),
  last_seen_at   INTEGER,
  -- Bumped on every mutation; the producer's mirror carries the same number so a stale mirror is
  -- detectable rather than merely wrong.
  mirror_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (channel, identifier, sub_identifier)
) STRICT;
```

*`UNIQUE (channel, identifier, sub_identifier)`, not `(channel, identifier)`: SQLite treats NULLs
as distinct in a UNIQUE index, so the relay channel's rows are keyed on the shortcode while every
other channel — where `sub_identifier` is always NULL — is effectively keyed on the pair. The
repository additionally rejects a second NULL-`sub_identifier` row for the same
`(channel, identifier)` on the non-relay channels, since the index will not.*

Rejected captures are still **recorded** — `process_state = 'ignored'` with `dedupe_key`,
`content_hash`, sender, length and `ignored_reason`, but `payload_text = NULL`. Idempotency
survives (a rescan will not reprocess) and OTPs never hit disk. One exception protects against a
wrong filter: for senders that *are* on the financial list but fail the amount-pattern test, the
body **is** retained so a wrongly-rejected real transaction is recoverable and replayable.

Two producer-side rejections that are **not** filter decisions and must be recorded distinctly, or
they read as bank silence:

- `ignored_reason = 'own_package'` — the app's own liveness-probe notification and its "N items
  waiting" notification must be rejected ahead of the allowlist test, or the probe spools itself
  back into the pipeline.
- `ignored_reason = 'group_summary'` — see §3.12 rule 1. A bank that posts *only* group summaries
  shows up as a rising `group_summary` count in diagnostics rather than as a sender that mysteriously
  stopped producing transactions.

**Failing closed is only safe if it leaves a trace.** When the mirror is missing, stale or
unparseable the producer drops the notification — the alternative, failing open, sends every
notification on the device through the amount-pattern test and into `payload_text`, which falsifies
the Play declaration's central sentence. But a silent drop is the exact loss mode `capture_gaps`
exists to prevent, so the producer writes a zero-byte marker that the drain converts into a
retroactive `capture_gaps` row with `cause = 'mirror_unavailable'`. This matters most immediately
after a restore: `capture_senders` comes back inside the `.mmbak`, the Kotlin-side mirror does not,
and without the marker the phone captures nothing until the user next opens the app with no
indication that it is not capturing.

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
  -- Denormalized from raw_captures so the dedupe gates stay single-table checks.
  -- source_ref is load-bearing for G5's escape hatch: two captures carrying the SAME
  -- sbn.getKey() are ONE notification updated in place (pending -> confirmed, merchant name
  -- filled in once the acquirer resolves), not two authorizations, and must resolve as a
  -- supersede on the newer postTime rather than as a second transaction.
  source_app     TEXT,
  source_ref     TEXT,
  role           TEXT NOT NULL CHECK (role IN (
                   'bank_auth','bank_settle','bank_statement','merchant_receipt',
                   'user_manual','voice','wallet_tap')),

  account_id     TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  card_last4     TEXT CHECK (card_last4 IS NULL OR card_last4 GLOB '[0-9][0-9][0-9][0-9]'),
  -- auth code / RRN / ARN / receipt folio / CFDI UUID, normalized. Gate G3 in §3.12: if both
  -- sides carry one and they differ, merging is FORBIDDEN regardless of score. This is what
  -- definitively separates two coffees.
  strong_ref     TEXT,

  -- The figure AS STATED IN THE MESSAGE, as an unsigned magnitude (rule 10).
  amount_minor      INTEGER
    CHECK (amount_minor IS NULL OR amount_minor BETWEEN 0 AND 9007199254740991),
  currency_code     TEXT REFERENCES currencies(code),
  currency_exponent INTEGER CHECK (currency_exponent IS NULL OR currency_exponent BETWEEN 0 AND 8),
  -- WITHOUT THIS THE BALANCE CHAIN CANNOT BE COMPUTED. §3.14's oracle is
  -- expect = prev.balance_after + this.SIGNED amount, and "Compra 340.00, saldo 12,660.00" and
  -- "Deposito 340.00, saldo 13,340.00" are otherwise byte-identical in this table — so the
  -- expectation is wrong by 2x the amount on every credit.
  direction      TEXT CHECK (direction IS NULL OR direction IN ('debit','credit')),

  -- The same movement expressed in the ACCOUNT's currency, when the message states it (or when
  -- it can be derived from a stated balance delta). For "Compra JPY 5,000 ... saldo USD 1,234.56"
  -- the message amount is JPY and the balance is USD; the chain arithmetic is only valid in the
  -- account's currency, so it uses THIS column and never amount_minor.
  account_amount_minor  INTEGER
    CHECK (account_amount_minor IS NULL OR
           account_amount_minor BETWEEN 0 AND 9007199254740991),
  account_currency_code TEXT REFERENCES currencies(code),
  account_exponent      INTEGER
    CHECK (account_exponent IS NULL OR account_exponent BETWEEN 0 AND 8),

  -- running balance when the message carries one. The only correctness oracle in the whole
  -- design that can detect a capture that NEVER ARRIVED — which is why it needs its OWN currency
  -- triple rather than borrowing currency_code, which describes the transaction amount.
  balance_after_minor INTEGER
    CHECK (balance_after_minor IS NULL OR balance_after_minor BETWEEN -9007199254740991 AND 9007199254740991),
  balance_currency_code TEXT REFERENCES currencies(code),
  balance_exponent      INTEGER
    CHECK (balance_exponent IS NULL OR balance_exponent BETWEEN 0 AND 8),

  event_at_utc   INTEGER NOT NULL,      -- notification postTime / sms.date / receipt printed
                                        -- time / auth time. NEVER the capture time.
  -- Set when a LATER observation of the SAME notification (identical source_app + source_ref,
  -- i.e. one notification re-posted in place) takes over this one's slot. The superseded row
  -- keeps its raw_capture_id and its extraction, and its txn_id is nulled so the slot is free —
  -- so the history survives and unmerge can walk back to it, which it could not if the row were
  -- simply overwritten or deleted. See §3.12 rule 1.
  superseded_by_observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,

  CHECK (amount_minor IS NULL OR (currency_code IS NOT NULL AND currency_exponent IS NOT NULL)),
  CHECK (account_amount_minor IS NULL OR
         (account_currency_code IS NOT NULL AND account_exponent IS NOT NULL)),
  CHECK (balance_after_minor IS NULL OR
         (balance_currency_code IS NOT NULL AND balance_exponent IS NOT NULL))
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
-- G5's escape hatch: find the earlier observation of the SAME notification (same sbn.getKey())
CREATE INDEX ix_observations_sref ON observations(source_app, source_ref)
  WHERE source_ref IS NOT NULL;
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
  -- Computed at exactly ONE chokepoint and never accepted from a caller. Its formula is defined
  -- in 05-provenance.md §5.2.2 and NOWHERE ELSE; this column stores the result. The formula must
  -- compose BOTH ranking dimensions, because two sections previously each defined it as one of
  -- them and the two gave opposite answers for the case that matters most:
  --     value_source_rank = channel_precedence * 100000 + ENGINE_BASE * 100 + min(pipeline_rank, 99)
  -- channel_precedence (04-capture.md §4.5.1's table) encodes "the full SMS text beats the
  -- truncated notification"; ENGINE_BASE/pipeline_rank encodes "a newer Gemma may fix an older
  -- Gemma". The column must be wide enough for the composed value — it is, at 2^53.
  value_source_rank   INTEGER NOT NULL,

  -- HOW AUTHORITATIVE the underlying evidence is
  evidence_authority  TEXT NOT NULL CHECK (evidence_authority IN
                        ('statement_line','bank_settlement','bank_auth','merchant_receipt',
                         'user_assertion','inference')),
  -- No closed CHECK list (rule 7b): the rank ladder gains values (a reconciled statement import,
  -- a user-confirmed reconciliation) and a table rebuild to add one is not available.
  -- Known values: statement_line 60, bank_settlement 50, bank_auth 40, merchant_receipt 30,
  -- user_assertion 20, inference 10.
  authority_rank      INTEGER NOT NULL,
  observation_id      TEXT REFERENCES observations(id) ON DELETE SET NULL,

  -- SET BY THE CHOKEPOINT, NOT BY THE CALLER. See the rule below: any write with actor = 'user'
  -- to a bank-authoritative field sets pinned_by_user = 1 and pinned_at_authority = the authority
  -- of the value being DISPLACED. Leaving these to an optional caller flag meant an ordinary
  -- confirm-sheet correction landed at rank 20, unpinned, and was silently reverted by the next
  -- replay of the very message the user was correcting.
  pinned_by_user      INTEGER NOT NULL DEFAULT 0 CHECK (pinned_by_user IN (0,1)),
  pinned_at_authority INTEGER,
  observed_at         INTEGER NOT NULL,
  PRIMARY KEY (txn_id, field),
  CHECK (pinned_by_user = 0 OR pinned_at_authority IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_txn_fields_pinned ON transaction_fields(txn_id) WHERE pinned_by_user = 1;
```

Fields are partitioned. **Bank-authoritative:** `amount`, `currency`, `occurred_at`, `account_id`,
`direction`, `clearing_state`, the FX original amount/currency. **User-authoritative:** `category`,
merchant display label, `note`, tags, splits, budget assignment, exclude-from-reports.

The replacement rule is one function used by merge, by settlement arrival and by replay:

```text
# STEP 0 — WRITE-SIDE, and it is what makes every branch below actually protect the user.
if actor == 'user':
    write.value_source       = 'user'
    write.evidence_authority = 'user_assertion'   # rank 20
    if field ∈ BANK_AUTHORITATIVE:
        write.pinned_by_user      = 1
        write.pinned_at_authority = cur.authority_rank   # what the user DISPLACED, not 20

# STEP 1 — a reversal of a user value is a CONFLICT, not a precedence question.
if cur.value_source == 'user' and new.value != cur.value
   and field ∈ ('amount','currency','occurred_at','account_id','direction','merchant_id'):
       open a field_conflicts row; do not apply; raise needs_review

# STEP 2 — precedence
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

Step 0 is not "pin everything". It is what makes the ladder mean what §3.11.4 and D79 say it means.
Consider the everyday case: a BBVA push is extracted with the merchant as `OXXO GAS 4471` and the
posting date instead of the purchase date, `overall_confidence` 0.71; the user fixes both on the
confirm sheet. Without step 0 those land at authority 20, unpinned. Three weeks later a prompt
version bump creates a replay run, the selection predicate matches (confidence < 0.90 is true
regardless of `confirm_state`), the same push re-classifies as `bank_auth` at rank 40, and the final
clause accepts — 40 > 20 — reverting both corrections. `USER_VALUE_SUPERSEDED` is not emitted
because that branch requires `pinned_by_user`, `needs_review` is not raised, and the 7-day undo
window expires unnoticed. With step 0, `pinned_at_authority = 40`, so the re-parse of the *same*
message is rejected (40 > 40 is false) while a genuine settlement (50) or statement line (60) still
supersedes — loudly.

Step 1 widens the divergence test beyond numeric fields. A merchant name and a date are exactly
where a 0.80-F1 extractor is worst and exactly where the user's correction carries the most
information; treating a reversal of either as a precedence question rather than a conflict is how a
correct value gets quietly replaced by the output that provoked the correction.

The equal-authority branch is what makes replay safe: re-extracting the **same** bank settlement
message with a newer model (higher `value_source_rank`, identical `authority_rank`) is allowed and
fixes a misparse; re-extracting a merchant receipt can never clobber a settlement amount, because
authority 30 < 50.

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
   -- ANY pinned field excludes the whole transaction, not just the four money fields. Once a
   -- user has corrected anything on a row, re-running a newer pipeline over it risks reverting
   -- work the user did — and at a 0.80-F1 operating point the rows with pinned fields are
   -- exactly the rows the confidence filter above also selects.
   AND NOT EXISTS (SELECT 1 FROM transaction_fields tf
                    WHERE tf.txn_id = t.id AND tf.pinned_by_user = 1)
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
   AND t.booked_at_utc BETWEEN :t_lo AND :t_hi
   AND (t.account_id IS NULL OR :acct IS NULL OR t.account_id = :acct)
   -- TWO amount arms, because a candidate observation is denominated in exactly one of two
   -- currencies and they are not the same one. The event arm matches a receipt or an
   -- own-currency alert; the bank arm matches an arriving settlement message on a foreign
   -- purchase, where the figure is in the CARD's currency and the event arm would search around
   -- ¥3,342 for a ¥5,000 purchase and find nothing.
   AND ( (t.currency_code = :cur AND t.effective_amount_minor BETWEEN :a_lo AND :a_hi)
      OR (t.bank_currency_code = :cur
          AND t.bank_effective_amount_minor BETWEEN :a_lo AND :a_hi)
      OR (t.reporting_currency_code = :cur
          AND t.reporting_amount_minor BETWEEN :a_lo AND :a_hi) )
 LIMIT 200;
```

The band `[:a_lo, :a_hi]` is derived from the candidate's own exponent, never from a fixed number
of minor units: a KWD figure at exponent 3 and an assumed exponent of 2 puts the band off by
exactly 1000x.

Fuzzy scoring runs in JS over those ≤200 candidates; no SQL-level fuzzy matching is needed. Five
**structural** rules — not tolerance tuning — protect two genuinely separate identical purchases:

1. **Same-channel rule (G5), with one explicit escape hatch.** Two observations with the same
   `(source_channel, source_app, role)` are never fuzzy-merged; only exact `dedupe_key` equality
   collapses them. A bank emits exactly one auth message per authorization.
   **The escape hatch: identical `(source_app, source_ref)`.** On Android that is `sbn.getKey()`,
   and two captures sharing it are *one notification updated in place* — pending → confirmed, or
   the merchant name filled in once the acquirer resolves — not two authorizations. `dedupe_key`
   includes `getPostTime()`, which changes on the re-post, so Layer 1 does not collapse them, and
   without this hatch G5 then forbids Layer 2 from doing so and G6 pushes the update out as a
   **new transaction**. Same `(source_app, source_ref)` therefore resolves as a **supersede on the
   newer postTime**, never as a second transaction.
   The supersede is an ordered two-statement sequence, and the order is forced by
   `ux_observations_slot` — the slot is `UNIQUE (txn_id, source_channel, role)`, so the newer
   observation cannot be inserted into an occupied slot and the naive "just insert it" path fails:
   ```sql
   UPDATE observations SET txn_id = NULL, superseded_by_observation_id = :new_obs_id
    WHERE id = :old_obs_id;                       -- vacates the slot, keeps the history
   INSERT INTO observations (…, txn_id, …) VALUES (…, :txn_id, …);   -- takes the slot
   ```
   The superseded row keeps its `raw_capture_id` and `extraction_id`, so `match_decisions`,
   `match_vetoes` and unmerge all still resolve through it. Unmerge reverses the pair: null the
   newer row's `txn_id`, clear `superseded_by_observation_id`, restore the older row's.
   The other half of this failure lives in the producer, not here: an `InboxStyle` **group
   summary** repeats its children's amounts verbatim under a different key and a different
   postTime, so it must be dropped before spooling
   (`process_state = 'ignored'`, `ignored_reason = 'group_summary'`, `payload_text = NULL`) — a
   bank that posts only summaries then shows up in diagnostics rather than going silently unread.
   Without both halves, duplicates grow superlinearly with notification volume and every pair
   lands in the review inbox for the user to resolve by hand, forever.
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

**Captures with `redaction_suspected = 1` are excluded from template learning entirely.** A
redacted Android 15 notification has a stable, novel fingerprint whose body is literally "Sensitive
notification content hidden", so without the exclusion `learnTemplate` spends `support_count` trying
to promote a template for a message that contains no data — and the resulting captures route to
`needs_review` labelled "the model is bad at this bank" rather than "this bank is redacted". The
`bank_templates` fingerprint history is also the input to the drain-side redaction test itself
(§3.10), which is why that test cannot live in the producer.

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
  -- NO CLOSED CHECK LIST (rule 7b). This is the column that proves the rule: the first Xiaomi
  -- field reports require 'hibernated', and writing a value the CHECK rejects raises
  -- SQLITE_CONSTRAINT inside the drain's BEGIN IMMEDIATE — so the symptom is not a mislabelled
  -- gap, it is "the drain aborts on exactly the devices that needed the fix". The pragmatic
  -- workaround (log everything as 'unknown') destroys the per-cause diagnostics that made this
  -- table first-class in the first place. Known vocabulary:
  --   'binding_died' | 'permission_revoked' | 'boot_before_unlock' | 'probe_failed'
  --   | 'app_updated' | 'app_replaced' | 'user_disabled' | 'oem_killed'
  --   | 'force_stopped'       -- package put in the stopped state; scheduled work was cancelled
  --   | 'hibernated'          -- App Hibernation auto-revoke
  --   | 'mirror_unavailable'  -- producer failed closed: no readable capture_senders mirror
  --   | 'spool_full'          -- producer refused records because the spool hit its cap
  --   | 'spool_key_lost'      -- sealed records exist but are permanently undecryptable
  --   | 'probe_unavailable'   -- POST_NOTIFICATIONS denied, so liveness cannot be probed at all
  --   | 'unknown'
  cause          TEXT NOT NULL,
  backfilled_at  INTEGER,
  backfill_source TEXT CHECK (backfill_source IS NULL OR backfill_source IN ('sms','statement','user')),
  note           TEXT,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_capture_gaps_open ON capture_gaps(channel, from_utc DESC) WHERE to_utc IS NULL;

-- Three of those causes exist because the mechanisms that were supposed to detect downtime
-- cannot run in the states they were meant to detect, and every one of them fails toward silence:
--   * a force-stop (OEM battery manager, App Hibernation, or the user tapping the ANR dialog's
--     only button) cancels the package's scheduled JobScheduler work, so the WorkManager liveness
--     probe dies together with the thing it was watching and never reschedules;
--   * a WorkManager Worker is a Kotlin class and op-sqlite has no native query API, so it cannot
--     advance any column in this table by itself;
--   * onListenerDisconnected() is an orderly-unbind callback and does not fire on a process kill,
--     so last_disconnected_at is NULL precisely when it matters.
-- Therefore: the probe is an ACCELERATOR, and FOREGROUND-TIME RECONCILIATION is the primary
-- detector — the same stance the design already takes for the drain (D65) and for backup (D101).
-- On every foreground, before render, compare `now` against last_heartbeat_at and against each
-- sender's last capture versus its learned inter-arrival distribution, and open a RETROACTIVE gap
-- row spanning the silence. Kotlin's only writer is an append-only heartbeat file that the drain
-- folds into the columns below.
CREATE TABLE capture_health (
  channel                    TEXT PRIMARY KEY,
  last_connected_at          INTEGER,
  last_disconnected_at       INTEGER,
  last_probe_ok_at           INTEGER,
  consecutive_probe_failures INTEGER NOT NULL DEFAULT 0,
  recovery_attempts          INTEGER NOT NULL DEFAULT 0,
  last_recovery_at           INTEGER,
  permission_granted         INTEGER NOT NULL DEFAULT 0 CHECK (permission_granted IN (0,1)),

  -- "the probe passed" and "the probe cannot run" must be distinguishable IN DATA, not implied
  -- by a NULL. If the user denied POST_NOTIFICATIONS the app cannot post its own probe
  -- notification at all; R20 correctly suppresses the false recovery loop, after which
  -- consecutive_probe_failures stays 0 forever and the channel reports healthy while capturing
  -- nothing. 0 means the capture-health UI must render an explicitly reduced-confidence state.
  probe_available            INTEGER NOT NULL DEFAULT 0 CHECK (probe_available IN (0,1)),

  -- Folded in from the producer's append-only heartbeat file by the drain. last_notification_seen_at
  -- advances on ANY notification the listener sees, allowlisted or not, so it distinguishes
  -- "the listener is alive and this bank went quiet" from "the listener is dead".
  last_heartbeat_at          INTEGER,
  last_notification_seen_at  INTEGER,
  heartbeat_source           TEXT,   -- 'listener_connected'|'listener_disconnected'|'posted'|'drain'

  -- Answered by NotificationManagerCompat.getEnabledListenerPackages(), which needs no
  -- permission, costs nothing, works whether or not the app can post, and is the FIRST check on
  -- every foreground — it is the authoritative separator between cause='permission_revoked' and
  -- cause='binding_died', which the design otherwise distinguishes in an enum with no mechanism.
  grant_checked_at           INTEGER,
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
--   signed = CASE observations.direction WHEN 'credit' THEN +1 ELSE -1 END
--            * observations.account_amount_minor
--   expect = prev.balance_after_minor + signed
--   gap    = this.balance_after_minor - expect
-- BOTH inputs are qualified, and both qualifications are load-bearing:
--   * `direction`, because "Compra 340.00, saldo 12,660.00" and "Deposito 340.00, saldo
--     13,340.00" are otherwise identical rows and the expectation is wrong by 2x on every credit;
--   * `account_amount_minor` (not amount_minor), because "Compra JPY 5,000 ... saldo USD 1,234.56"
--     states the movement in one currency and the balance in another. The chain is evaluated ONLY
--     over observations whose balance_currency_code equals the account's currency and which carry
--     both a direction and an account-currency amount; everything else is skipped, not guessed.
--     Subtracting 5000 from a USD balance produces a break of 1,658 in no currency at all, which
--     matches none of the distortion patterns below and manufactures an inferred_gap transaction
--     for an amount that cannot be denominated.
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
  -- Rule 2: carried explicitly, not inherited from budgets. Copied from the parent budget at
  -- materialization and never recomputed, so editing a budget's currency after periods exist
  -- cannot silently reinterpret months of stored actuals. Sweep check I15 compares them.
  currency_code     TEXT NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
  currency_exponent INTEGER NOT NULL CHECK (currency_exponent BETWEEN 0 AND 8),
  limit_minor     INTEGER NOT NULL CHECK (limit_minor BETWEEN 0 AND 9007199254740991),
  carry_in_minor  INTEGER NOT NULL DEFAULT 0,
  actual_minor    INTEGER NOT NULL DEFAULT 0
    CHECK (actual_minor BETWEEN -9007199254740991 AND 9007199254740991),
  -- Which conversion produced actual_minor, so a recompute after an FX correction is comparable
  -- with the value it replaced: 'reporting' (legs' allocated reporting amounts, the only mode in
  -- v1) or 'native' (single-currency budget over legs already in the budget's currency).
  rate_basis      TEXT NOT NULL DEFAULT 'reporting'
    CHECK (rate_basis IN ('reporting','native')),
  computed_at     INTEGER,
  -- Set to 1 by the trg_budget_stale_* family (§3.19) whenever ANYTHING that could move this
  -- window's total changes: the reporting amount, the raw amounts, clearing_state, disposition,
  -- deleted_at, the booked date, or a brand-new transaction landing in the window. Missing any
  -- one of those couplings is how a budget silently disagrees with the transaction list it is
  -- supposedly summing.
  stale           INTEGER NOT NULL DEFAULT 1 CHECK (stale IN (0,1)),
  UNIQUE (budget_line_id, period_start)
) STRICT;

CREATE INDEX ix_budget_periods_stale ON budget_periods(budget_line_id) WHERE stale = 1;
CREATE INDEX ix_budget_periods_window ON budget_periods(period_start, period_end);
```

**`actual_minor`'s source query, stated so it is not reinvented per screen.** It sums the *legs'*
allocated reporting amounts (§3.7.3), never the header, because a budget line targets a category
subtree and only legs carry category identity:

```sql
-- for one budget_periods row, given its budget_line
SELECT COALESCE(SUM(e.reporting_amount_minor), 0)
  FROM entries e
  JOIN transactions t ON t.id = e.txn_id
  JOIN categories   c ON c.account_id = e.account_id
  JOIN accounts     a ON a.id = e.account_id
 WHERE e.role = 'category'
   AND a.is_on_budget = 1
   AND t.deleted_at IS NULL
   AND t.disposition = 'active'
   AND t.clearing_state IN ('unknown','authorized','settled','disputed','chargeback_lost')
   AND CASE :date_basis WHEN 'home'
         THEN COALESCE(t.posted_local_date, t.booked_local_date)
         ELSE e.booked_local_date END
       BETWEEN :period_start AND :period_end
   AND (c.id = :category_id
        OR (:include_subtree = 1 AND c.id IN (SELECT id FROM category_subtree(:category_id))))
   -- tag lines substitute a transaction_tags EXISTS clause for the two category clauses
;
```

`e.reporting_amount_minor` is already denominated in `meta.base_currency_code`. A budget whose
`currency_code` differs from the base currency converts that sum once, at period close, with the
§3.3.2 resolver at `period_end`, and records `rate_basis`.

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

**`oplog` records ledger and provenance mutations only, and the exclusion list is normative.**
The chokepoint writes one row per changed column, so without an explicit allowlist the drain's
`INSERT` into `raw_captures` puts the **verbatim bank message body** into `oplog.new_value`. The
retention purge (§3.10) then correctly nulls `payload_text`, the purge-verification test that runs
the amount regex over "every purged row's remaining columns" passes — it looks at `raw_captures`,
and `oplog` is a different table — and the complete message body survives for *90 days or 200,000
rows, whichever is larger*, which for a light iOS user is years. It is copied into every `.mmbak`
because `sqlcipher_export()` copies ordinary tables, and §6.7.1 designates `oplog` as the sync
payload, so under the v1.5 relay every purged body is transmitted. The user set 30-day retention
and the retention screen reports success.

The rule: `oplog` **never** records `raw_captures.payload_text`, `raw_captures.payload_meta_json`,
`extraction_runs.raw_output`, `extracted_fields.value_json` or `media_assets.rel_path`. In practice
`raw_captures` and `extraction_runs` are excluded from `oplog` **entirely** — both are append-only
with their own audit story, so an oplog row adds nothing but a second copy with a longer retention.
Where a content column must be tracked at all, the chokepoint stores a hash, never the value.
Sweep check **I12** (§3.21) fails on any row outside the allowlist, and the CI gate runs the
amount/message regex over `oplog` after a purge and asserts zero matches.

```sql
-- Append-only. Triple duty: future sync payload, undo stack, and — because a user correction
-- of an LLM extraction IS an oplog row with before/after — a second view of the FunctionGemma
-- harvest. Written from the SAME repository chokepoint that enforces dirty-columns-only writes,
-- which is also where the content allowlist above is applied.
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
-- The family covers EVERY table carrying a money triple, not the three that happened to be
-- written first. A JPY budget created at exponent 2 renders ¥50,000 as ¥50,000.00 and computes
-- actuals from exponent-0 legs, so the budget reads 99% unused all month with nothing firing;
-- an installment_plans row in KWD at exponent 2 makes every scheduled payment off by 10x.
CREATE TRIGGER trg_transactions_exponent_insert
AFTER INSERT ON transactions
WHEN NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
  OR NEW.reporting_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.reporting_currency_code)
  OR (NEW.bank_currency_code IS NOT NULL
      AND NEW.bank_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.bank_currency_code))
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

CREATE TRIGGER trg_entries_exponent_insert
AFTER INSERT ON entries
WHEN NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
  OR (NEW.reporting_currency_code IS NOT NULL
      AND NEW.reporting_exponent <>
          (SELECT iso_exponent FROM currencies WHERE code = NEW.reporting_currency_code))
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

CREATE TRIGGER trg_line_items_exponent_insert
AFTER INSERT ON line_items
WHEN NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

CREATE TRIGGER trg_budgets_exponent_insert
AFTER INSERT ON budgets
WHEN NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

CREATE TRIGGER trg_budget_periods_exponent_insert
AFTER INSERT ON budget_periods
WHEN NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

CREATE TRIGGER trg_installment_plans_exponent_insert
AFTER INSERT ON installment_plans
WHEN NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

CREATE TRIGGER trg_observations_exponent_insert
AFTER INSERT ON observations
WHEN (NEW.currency_code IS NOT NULL
      AND NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code))
  OR (NEW.account_currency_code IS NOT NULL
      AND NEW.account_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.account_currency_code))
  OR (NEW.balance_currency_code IS NOT NULL
      AND NEW.balance_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.balance_currency_code))
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

CREATE TRIGGER trg_transaction_links_exponent_insert
AFTER INSERT ON transaction_links
WHEN NEW.currency_code IS NOT NULL
 AND NEW.currency_exponent <> (SELECT iso_exponent FROM currencies WHERE code = NEW.currency_code)
BEGIN
  SELECT RAISE(ROLLBACK, 'money: exponent must equal currencies.iso_exponent at write time');
END;

-- ─── 3b. Leg currency must be the account's currency ──────────────────────────────────
-- This is the trigger that replaces the deleted account_amount_minor column as the guarantee
-- that v_account_balances is meaningful. A single-currency account may only receive legs in its
-- own currency; the settlement conversion is expressed as an fx_conversion pair (§3.7.2b).
-- Multi-currency accounts (currency_code IS NULL: system equity/clearing, cash, and every
-- expense/income category account) are exempt by construction.
CREATE TRIGGER trg_entries_account_currency
AFTER INSERT ON entries
WHEN (SELECT a.currency_code FROM accounts a WHERE a.id = NEW.account_id) IS NOT NULL
 AND (SELECT a.currency_code FROM accounts a WHERE a.id = NEW.account_id) <> NEW.currency_code
BEGIN
  SELECT RAISE(ROLLBACK,
    'ledger: leg currency must equal its account currency; use an fx_conversion pair');
END;

-- ─── 3c. Reporting coherence on the header ────────────────────────────────────────────
-- Triggers rather than CHECKs: effective_amount_minor is a STORED generated column and SQLite
-- does not guarantee its evaluation order relative to table-level CHECK constraints, and the
-- second rule reaches into accounts.
CREATE TRIGGER trg_txn_reporting_same_currency_ins
AFTER INSERT ON transactions
WHEN NEW.reporting_source = 'same_currency'
 AND NEW.reporting_amount_minor <> NEW.effective_amount_minor
BEGIN
  SELECT RAISE(ROLLBACK,
    'money: same_currency reporting amount must equal effective_amount_minor');
END;

-- The UPDATE arm is the one that matters. effective_amount_minor is generated and moves itself
-- when a settlement lands; reporting_amount_minor is a plain column and does not. Without this,
-- a EUR restaurant authorization of 25.00 that settles at 27.50 with a tip leaves every
-- base-currency report 2.50 short forever, and trg_budget_stale_on_amount_change dutifully
-- recomputes the period from the same stale number.
-- CONTRACT, and it is not discoverable from the trigger body: the settle UPDATE must carry
-- reporting_amount_minor IN THE SAME STATEMENT. Rule 8's dirty-columns-only convention naturally
-- leads an implementer to issue the settle write and the reporting write as two statements, and
-- the first one then rolls the whole transaction back with a message that does not name the
-- cause. One statement:
--   UPDATE transactions SET settled_amount_minor = ?, reporting_amount_minor = ?,
--          clearing_state = 'settled', posted_at_utc = ?, updated_at = ?, hlc = ? WHERE id = ?;
-- (04-capture.md §4.9 owns that statement; this trigger is what makes forgetting it loud.)
CREATE TRIGGER trg_txn_reporting_same_currency_upd
AFTER UPDATE OF settled_amount_minor, authorized_amount_minor, amount_minor,
                reporting_amount_minor ON transactions
WHEN NEW.reporting_source = 'same_currency'
 AND NEW.reporting_amount_minor <> NEW.effective_amount_minor
BEGIN
  SELECT RAISE(ROLLBACK,
    'money: settlement moved effective_amount_minor without updating reporting_amount_minor '
    || '(both must be written in the SAME statement)');
END;

CREATE TRIGGER trg_txn_reporting_actual
AFTER INSERT ON transactions
WHEN NEW.reporting_source = 'actual'
 AND NEW.account_id IS NOT NULL
 AND (SELECT a.currency_code FROM accounts a WHERE a.id = NEW.account_id) IS NOT NULL
 AND (SELECT a.currency_code FROM accounts a WHERE a.id = NEW.account_id)
     <> NEW.reporting_currency_code
BEGIN
  SELECT RAISE(ROLLBACK,
    'money: reporting_source=actual requires reporting currency = the account currency');
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

-- ─── 5. Budget invalidation ───────────────────────────────────────────────────────────
-- Deliberately coarse (marks every line's period covering that date). Recomputing a budget
-- period is cheap; showing a budget that disagrees with its own transaction list is not.
--
-- THE MARKING PREDICATE, used identically by every trigger below. It respects budgets.date_basis
-- because a 'home'-basis budget windows on the posting date, and a trigger that only ever
-- compares booked_local_date silently fails to invalidate exactly the budgets whose owner is
-- reconciling against a home-country statement:
--
--   UPDATE budget_periods SET stale = 1
--    WHERE id IN (SELECT bp.id FROM budget_periods bp
--                   JOIN budget_lines bl ON bl.id = bp.budget_line_id
--                   JOIN budgets      b  ON b.id  = bl.budget_id
--                  WHERE (CASE b.date_basis WHEN 'home'
--                              THEN COALESCE(<row>.posted_local_date, <row>.booked_local_date)
--                              ELSE <row>.booked_local_date END)
--                        BETWEEN bp.period_start AND bp.period_end);
--
-- Written out per trigger below because SQLite has no shareable trigger body.
--
-- THE SET OF TRIGGERING EVENTS IS THE POINT. Earlier drafts covered only the two amount columns,
-- which misses every transition that moves a row ACROSS the §3.5.2 reporting predicate rather
-- than changing its value. The important one is clearing_state, because it is driven by a SWEEP
-- rather than by a user write, so "the repository marks it stale on write" is not available as a
-- defence: a $200.00 hotel hold counted in June, the July 3rd expiry sweep flipped it to
-- 'expired', and June's budget kept reporting $200.00 of travel spend that the transaction list
-- no longer contained. Identical for disposition (VOIDED, the losing side of a MERGE), for soft
-- delete, and — the quiet one — for INSERT, without which a live budget only updates when some
-- OTHER row in the period happens to be edited.

CREATE TRIGGER trg_budget_stale_on_reporting_change
AFTER UPDATE OF reporting_amount_minor ON transactions
WHEN NEW.reporting_amount_minor <> OLD.reporting_amount_minor
BEGIN
  UPDATE budget_periods SET stale = 1
   WHERE id IN (SELECT bp.id FROM budget_periods bp
                  JOIN budget_lines bl ON bl.id = bp.budget_line_id
                  JOIN budgets      b  ON b.id  = bl.budget_id
                 WHERE (CASE b.date_basis WHEN 'home'
                             THEN COALESCE(NEW.posted_local_date, NEW.booked_local_date)
                             ELSE NEW.booked_local_date END)
                       BETWEEN bp.period_start AND bp.period_end);
END;

CREATE TRIGGER trg_budget_stale_on_amount_change
AFTER UPDATE OF settled_amount_minor, authorized_amount_minor, amount_minor ON transactions
BEGIN
  UPDATE budget_periods SET stale = 1
   WHERE id IN (SELECT bp.id FROM budget_periods bp
                  JOIN budget_lines bl ON bl.id = bp.budget_line_id
                  JOIN budgets      b  ON b.id  = bl.budget_id
                 WHERE (CASE b.date_basis WHEN 'home'
                             THEN COALESCE(NEW.posted_local_date, NEW.booked_local_date)
                             ELSE NEW.booked_local_date END)
                       BETWEEN bp.period_start AND bp.period_end);
END;

-- The sweep-driven one. Without it the expiry timer silently rewrites history.
CREATE TRIGGER trg_budget_stale_on_state_change
AFTER UPDATE OF clearing_state, disposition, deleted_at ON transactions
BEGIN
  UPDATE budget_periods SET stale = 1
   WHERE id IN (SELECT bp.id FROM budget_periods bp
                  JOIN budget_lines bl ON bl.id = bp.budget_line_id
                  JOIN budgets      b  ON b.id  = bl.budget_id
                 WHERE (CASE b.date_basis WHEN 'home'
                             THEN COALESCE(NEW.posted_local_date, NEW.booked_local_date)
                             ELSE NEW.booked_local_date END)
                       BETWEEN bp.period_start AND bp.period_end);
END;

CREATE TRIGGER trg_budget_stale_on_insert
AFTER INSERT ON transactions
BEGIN
  UPDATE budget_periods SET stale = 1
   WHERE id IN (SELECT bp.id FROM budget_periods bp
                  JOIN budget_lines bl ON bl.id = bp.budget_line_id
                  JOIN budgets      b  ON b.id  = bl.budget_id
                 WHERE (CASE b.date_basis WHEN 'home'
                             THEN COALESCE(NEW.posted_local_date, NEW.booked_local_date)
                             ELSE NEW.booked_local_date END)
                       BETWEEN bp.period_start AND bp.period_end);
END;

-- A date edit invalidates BOTH the period it left and the period it entered.
CREATE TRIGGER trg_budget_stale_on_date_change
AFTER UPDATE OF booked_local_date, posted_local_date ON transactions
BEGIN
  UPDATE budget_periods SET stale = 1
   WHERE id IN (SELECT bp.id FROM budget_periods bp
                  JOIN budget_lines bl ON bl.id = bp.budget_line_id
                  JOIN budgets      b  ON b.id  = bl.budget_id
                 WHERE (CASE b.date_basis WHEN 'home'
                             THEN COALESCE(NEW.posted_local_date, NEW.booked_local_date)
                             ELSE NEW.booked_local_date END)
                       BETWEEN bp.period_start AND bp.period_end
                    OR (CASE b.date_basis WHEN 'home'
                             THEN COALESCE(OLD.posted_local_date, OLD.booked_local_date)
                             ELSE OLD.booked_local_date END)
                       BETWEEN bp.period_start AND bp.period_end);
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

Every view below repeats §3.5.2's reporting predicate **verbatim**. It is written out three times
here rather than hidden behind a helper because SQLite views cannot take one, and the standing rule
is that the copies change together or not at all. The CI schema lint greps the migration SQL for
`t.clearing_state IN (` — the reporting-predicate form, as distinct from the column's own CHECK and
from the `confirm_state = 'reconciled'` composite CHECK — and fails if any occurrence differs from
the canonical string in §3.5.2. `budget_periods.actual_minor`'s source query (§3.15) is the fourth
copy and is covered by the same lint.

```sql
-- A pure SUM with no special cases, which is only possible because (a) opening balances are real
-- balanced transactions against sys_opening_balance rather than a magic column, and (b) every leg
-- is denominated in its own account's currency, with the settlement conversion expressed as
-- explicit fx_conversion legs. Before (b) this view summed leg currency while the settlement
-- amount sat in a write-only column, so a USD card carrying a JPY leg reported "-¥5,000" and a
-- USD balance of zero.
-- BALANCE AS OF NOW. For a valuation date, use v_account_balances_asof below — and note that a
-- net-worth figure REVALUES these balances at the valuation date's rate (§3.3.5); it never sums
-- per-transaction reporting amounts.
CREATE VIEW v_account_balances AS
SELECT e.account_id, e.currency_code, e.currency_exponent,
       SUM(e.amount_minor) AS balance_minor
  FROM entries e
  JOIN transactions t ON t.id = e.txn_id
 WHERE t.deleted_at IS NULL
   AND t.disposition = 'active'
   AND t.clearing_state IN ('unknown','authorized','settled','disputed','chargeback_lost')
 GROUP BY e.account_id, e.currency_code, e.currency_exponent;

CREATE VIEW v_category_month AS
SELECT c.id AS category_id, c.canonical_key, e.booked_month,
       e.currency_code, e.currency_exponent,
       SUM(e.amount_minor) AS amount_minor,
       -- the base-currency rollup, from the §3.7.3 allocation rather than from an independent
       -- per-leg conversion, so it ties to the transaction detail screen exactly
       SUM(e.reporting_amount_minor) AS reporting_amount_minor
  FROM entries e
  JOIN categories   c ON c.account_id = e.account_id
  JOIN transactions t ON t.id = e.txn_id
 WHERE t.deleted_at IS NULL
   AND t.disposition = 'active'
   AND t.clearing_state IN ('unknown','authorized','settled','disputed','chargeback_lost')
 GROUP BY c.id, e.booked_month, e.currency_code, e.currency_exponent;

-- Net refund position. Derived, never stored as truth.
-- The currency predicate is not optional: transaction_links.amount_minor carries its own currency
-- and §4.10 explicitly contemplates cross-currency refunds. Without it, a ¥5,000 purchase refunded
-- as €30.90 nets to 1,910 of nothing, the UI claims ¥1,910 is still outstanding on a fully
-- refunded purchase, and sweep check I8 stays silent; the mirror case raises I8 on a correct link
-- and sends the user hunting for a mistake that does not exist.
CREATE VIEW v_txn_net AS
SELECT t.id AS txn_id,
       t.effective_amount_minor
         - COALESCE((SELECT SUM(l.amount_minor) FROM transaction_links l
                      WHERE l.to_transaction_id = t.id AND l.kind = 'REFUND_OF'
                        AND l.currency_code = t.currency_code), 0)
       AS net_amount_minor,
       -- refunds booked in some other currency, surfaced separately rather than silently
       -- arithmetic'd into the line above. The UI renders "plus 1 refund in another currency".
       (SELECT COUNT(*) FROM transaction_links l
         WHERE l.to_transaction_id = t.id AND l.kind = 'REFUND_OF'
           AND l.currency_code <> t.currency_code) AS foreign_refund_count
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
-- An expired hold LEAVES the §3.5.2 predicate, so the money disappears from every budget and
-- balance. That is right when the hold was phantom and catastrophic when the settlement message
-- was merely missed — a listener outage, or an iPhone, where settlement is unobservable by
-- construction. An explicit branch, not a reliance on needs_review, because a confirmed-then-
-- expired row matches nothing in the branch above.
SELECT 'expired_hold', t.id, t.captured_at_utc, 'hold_expired_did_this_go_through'
  FROM transactions t
 WHERE t.deleted_at IS NULL AND t.disposition = 'active'
   AND t.clearing_state = 'expired'
UNION ALL
SELECT 'capture', rc.id, rc.received_at, rc.process_state
  FROM raw_captures rc
 WHERE rc.process_state IN ('unparseable','redacted','deferred_no_model')
UNION ALL
-- NOTHING LEAVES THIS INBOX BY EXPIRING. A capture that was purged before it was ever extracted
-- is a permanent hole the user must be told about; without this branch a 600-item backlog of
-- unread bank alerts silently drops to zero overnight and reads as "processed".
SELECT 'capture', rc.id, rc.received_at, 'purged_before_extraction'
  FROM raw_captures rc
 WHERE rc.process_state = 'purged'
   AND NOT EXISTS (SELECT 1 FROM extraction_runs er
                    WHERE er.raw_capture_id = rc.id AND er.status = 'ok')
UNION ALL
SELECT 'duplicate_suggestion', md.id, md.decided_at, 'possible_duplicate'
  FROM match_decisions md
 WHERE md.outcome = 'suggested' AND md.user_response IS NULL
UNION ALL
SELECT 'conflict', fc.id, fc.detected_at, fc.field
  FROM field_conflicts fc WHERE fc.status = 'open'
UNION ALL
SELECT 'balance_break', bb.id, bb.detected_at, 'unexplained_balance_change'
  FROM balance_breaks bb WHERE bb.status = 'open'
UNION ALL
-- An unresolved one-sided transfer is removed from the spend number AND added to net worth, and
-- until now the "visible as an open item" promise in §3.4.1 had no surface anywhere. Twelve
-- €25.00 Bizums to friends understate the month by €300 and overstate net worth by €300
-- simultaneously. 14 days, then it is a question, then sweep check I13 reclassifies.
SELECT 'unmatched_transfer', e.txn_id, t.captured_at_utc, 'transfer_counterpart_never_arrived'
  FROM entries e
  JOIN transactions t ON t.id = e.txn_id
 WHERE e.account_id = 'sys_unmatched_transfer'
   AND t.deleted_at IS NULL AND t.disposition = 'active'
   AND e.booked_local_date <= date('now','-14 days')
UNION ALL
-- Capture is down and the user cannot be expected to notice a quiet month.
SELECT 'capture_gap', cg.id, cg.from_utc, cg.cause
  FROM capture_gaps cg WHERE cg.to_utc IS NULL;
```

The `at`-is-always-epoch-ms contract holds across all nine branches: `from_utc`,
`captured_at_utc`, `received_at`, `decided_at` and `detected_at` are all `INTEGER`. The
`sys_unmatched_transfer` branch deliberately selects `t.captured_at_utc` rather than
`e.booked_local_date` for exactly that reason — a `'YYYY-MM-DD'` string in that column would sort
catastrophically against the INTEGER branches, and silently.

**Balances and net worth as of a date.** SQLite views cannot take parameters, so these are
repository-owned parameterized queries, defined here so they are not reinvented per screen:

```sql
-- v_account_balances_asof(:as_of_date)
SELECT e.account_id, e.currency_code, e.currency_exponent,
       SUM(e.amount_minor) AS balance_minor
  FROM entries e
  JOIN transactions t ON t.id = e.txn_id
 WHERE t.deleted_at IS NULL
   AND t.disposition = 'active'
   AND t.clearing_state IN ('unknown','authorized','settled','disputed','chargeback_lost')
   AND e.booked_local_date <= :as_of_date          -- served by ix_entries_acct_date
 GROUP BY e.account_id, e.currency_code, e.currency_exponent;

-- v_net_worth_asof(:as_of_date, :currency)
--   for each (account, currency) row above where accounts.type IN ('asset','liability'):
--     resolve the (currency -> :currency) rate at :as_of_date via §3.3.2
--     convert the BALANCE with convert(), never the individual transactions
--   sum the converted balances.
-- Summing per-transaction reporting_amount_minor here gives historical cost and is WRONG: a
-- $10,000 deposit at EUR/USD 1.10 contributes EUR 9,090.91 forever, while at 1.05 on the
-- valuation date it is worth EUR 9,523.81. The EUR 432.90 difference is unrealized FX gain; it
-- belongs to sys_unrealized_fx (§3.3.5), not to nobody.
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

-- I4. Exponent drift after a currencies-table correction. EVERY table carrying a money triple,
--     not just transactions — a JPY budget written at exponent 2 or a KWD installment plan at
--     exponent 2 is a 100x/10x error that no trigger catches after the fact.
SELECT 'transactions' AS tbl, t.id FROM transactions t
  JOIN currencies c ON c.code = t.currency_code WHERE t.currency_exponent <> c.iso_exponent
UNION ALL SELECT 'transactions_reporting', t.id FROM transactions t
  JOIN currencies c ON c.code = t.reporting_currency_code WHERE t.reporting_exponent <> c.iso_exponent
UNION ALL SELECT 'transactions_bank', t.id FROM transactions t
  JOIN currencies c ON c.code = t.bank_currency_code WHERE t.bank_exponent <> c.iso_exponent
UNION ALL SELECT 'entries', e.id FROM entries e
  JOIN currencies c ON c.code = e.currency_code WHERE e.currency_exponent <> c.iso_exponent
UNION ALL SELECT 'line_items', li.id FROM line_items li
  JOIN currencies c ON c.code = li.currency_code WHERE li.currency_exponent <> c.iso_exponent
UNION ALL SELECT 'budgets', b.id FROM budgets b
  JOIN currencies c ON c.code = b.currency_code WHERE b.currency_exponent <> c.iso_exponent
UNION ALL SELECT 'budget_periods', bp.id FROM budget_periods bp
  JOIN currencies c ON c.code = bp.currency_code WHERE bp.currency_exponent <> c.iso_exponent
UNION ALL SELECT 'installment_plans', ip.id FROM installment_plans ip
  JOIN currencies c ON c.code = ip.currency_code WHERE ip.currency_exponent <> c.iso_exponent
UNION ALL SELECT 'observations', o.id FROM observations o
  JOIN currencies c ON c.code = o.currency_code WHERE o.currency_exponent <> c.iso_exponent
UNION ALL SELECT 'transaction_links', l.id FROM transaction_links l
  JOIN currencies c ON c.code = l.currency_code WHERE l.currency_exponent <> c.iso_exponent;

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

-- I8. Refunds exceeding their original — almost always a mis-linked refund. SAME-CURRENCY LINKS
--     ONLY: v_txn_net already filters, and a cross-currency refund landing here is a false
--     positive that sends the user hunting for a mistake that does not exist.
SELECT v.txn_id FROM v_txn_net v WHERE v.net_amount_minor < 0;

-- I9. Denormalized merchant counter drift (soft deletes and undone replay runs fire no
--     decrement). Repair, do not alarm: this is a display counter, not money.
UPDATE merchants SET txn_count = (
  SELECT COUNT(*) FROM transactions t
   WHERE t.merchant_id = merchants.id AND t.deleted_at IS NULL AND t.disposition = 'active');

-- I10. Header/leg amount tie. THE CHECK WHOSE ABSENCE LET A SPLIT RECEIPT BE SILENTLY UN-SPLIT.
--      I1 only asks whether legs balance; a rebuilt two-leg transaction balances perfectly while
--      having destroyed a user's three-way split. This is the seal predicate applied globally,
--      so it also catches any write path that never sealed.
SELECT t.id FROM transactions t
 WHERE t.deleted_at IS NULL AND t.disposition = 'active'
   AND EXISTS (SELECT 1 FROM entries e WHERE e.txn_id = t.id AND e.role = 'category')
   AND (SELECT COALESCE(SUM(e.amount_minor),0) FROM entries e
         WHERE e.txn_id = t.id AND e.role = 'category' AND e.currency_code = t.currency_code)
       <> CASE WHEN t.direction = 'debit' THEN t.effective_amount_minor
               ELSE -t.effective_amount_minor END;

-- I11. Reporting allocation drift: legs no longer reconstitute the header. Fires after any code
--      path that moved reporting_amount_minor without re-running allocateReporting().
SELECT t.id FROM transactions t
 WHERE t.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM entries e
                WHERE e.txn_id = t.id AND e.reporting_amount_minor IS NOT NULL
                  AND e.currency_code = t.currency_code)
   AND (SELECT COALESCE(SUM(ABS(e.reporting_amount_minor)),0) FROM entries e
         WHERE e.txn_id = t.id AND e.currency_code = t.currency_code)
       <> t.reporting_amount_minor;

-- I12. oplog content-allowlist violation. Verbatim bank message bodies must never reach a table
--      that outlives the retention purge, ships inside every .mmbak and is designated the sync
--      payload. Should always be empty.
SELECT o.id FROM oplog o
 WHERE o.table_name IN ('raw_captures','extraction_runs')
    OR (o.table_name = 'extracted_fields' AND o.column_name = 'value_json')
    OR (o.table_name = 'media_assets'     AND o.column_name = 'rel_path');

-- I13. Aged one-sided transfers. Removed from spend AND counted in net worth, forever, unless
--      something ages them out. Report at 14 days (v_review_inbox), reclassify to an expense
--      against sys_unaccounted_cash at 60 days with a user-visible event.
SELECT e.txn_id, e.currency_code, e.amount_minor, e.booked_local_date
  FROM entries e JOIN transactions t ON t.id = e.txn_id
 WHERE e.account_id = 'sys_unmatched_transfer'
   AND t.deleted_at IS NULL AND t.disposition = 'active'
   AND e.booked_local_date <= date('now','-60 days');

-- I14. Bank-channel transactions still at the clearing_state default a week after capture: the
--      auth/settle state machine never engaged for that sender.
SELECT t.id FROM transactions t
 WHERE t.clearing_state = 'unknown'
   AND t.input_channel IN ('android_sms','android_notification','statement_import')
   AND t.captured_at_utc < (unixepoch() - 604800) * 1000
   AND t.deleted_at IS NULL AND t.disposition = 'active';

-- I15. A budget's currency changed after its periods were materialized, so stored actuals are
--      denominated in one currency and interpreted in another.
SELECT bp.id FROM budget_periods bp
  JOIN budget_lines bl ON bl.id = bp.budget_line_id
  JOIN budgets      b  ON b.id  = bl.budget_id
 WHERE bp.currency_code <> b.currency_code OR bp.currency_exponent <> b.currency_exponent;

-- I16. meta.allow_hard_delete left ON. It is an in-band kill switch for every append-only and
--      soft-delete guard in §3.19 — including the one protecting consent_grants, the table whose
--      entire purpose is to make a consent claim provable — and §6.8.4 Trap A requires the
--      migration runner to set it to 'yes' mid-procedure.
--      A kill between the rebuild and the reset leaves it on permanently
--      with nothing visibly wrong; the protection is simply gone. Force-reset AND record it, so
--      the occurrence is evidence rather than a silent self-heal.
SELECT value FROM meta WHERE key = 'allow_hard_delete' AND value <> 'no';
UPDATE meta SET value = 'no' WHERE key = 'allow_hard_delete' AND value <> 'no';
```

I16 runs **first** in the sweep, and the same assertion runs in §2.14's startup sequence before any
write path opens, so a database that came back from an interrupted migration is re-protected before
it can be written to.

```sql
CREATE TABLE integrity_findings (
  id           TEXT PRIMARY KEY,
  -- NO CLOSED CHECK LIST (rule 7b). This column has already had to absorb I10-I16 and will
  -- absorb more; a closed list makes every new sweep check a table rebuild.
  -- Known: I1 unbalanced | I2 unsealed | I3 date drift | I4 exponent drift | I5 conservation
  --        | I6 orphaned media | I7 orphaned training label | I8 over-refund
  --        | I9 merchant counter | I10 header/leg tie | I11 reporting allocation
  --        | I12 oplog allowlist | I13 aged unmatched transfer | I14 stuck clearing_state
  --        | I15 budget currency drift | I16 allow_hard_delete left on
  check_id     TEXT NOT NULL,
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
| Per-leg reporting amounts | Allocation of the header total across category legs by largest remainder, asserted at seal | Independent per-leg conversion (the thing the row above rejects — ¥334/¥333/¥333 converts to 167+166+166 = 499 against a header of 500); no per-leg reporting at all (leaves `budget_periods.actual_minor`'s conversion unspecified, unstored and non-re-derivable) |
| Settlement conversion | Explicit `fx_conversion` leg pair, `fx_pair_index` + `settle_rate_*` | `entries.account_amount_minor/_currency_code/_exponent` — written on every foreign transaction, read by no view, no seal predicate and no sweep. A second, silently unbalanced ledger |
| Issuer FX / cross-border fees | Real legs against `sys_bank_fees` | `entries.fee_minor` — outside the balance invariant, so the fee left the account in the bank's world and existed in no balance, category or budget in ours |
| Account currency scope | Categories, cash and system accounts are multi-currency; everything else single | Every account single-currency — makes a foreign-currency category leg unrepresentable, which is what forced the account-currency shadow ledger in the first place |
| Bank auth/settle amounts | Own `(bank_currency_code, bank_exponent)` triple; `effective_amount_minor` never mixes currencies | Untyped integers inheriting the header's currency — a USD auth on a JPY receipt is a 150x error that lands directly in the dedupe amount band |
| Net worth as of a date | Balances revalued at the valuation-date rate; flows stay at transaction-date rates | Summing per-transaction `reporting_amount_minor` — that is historical cost, and it hides the entire unrealized FX position |
| Cross-rate attribution | Composed rate persisted as a `derived_cross` row + `fx_rate_inputs` lineage | An unpersisted rational (re-derivable but not attributable, so no revision ever reaches the transactions that used it); a `transaction_rate_uses` junction (needs a second selection path and leaves `reporting_rate_id` ambiguous) |
| Enum columns on pipeline/diagnostic tables | Open `TEXT`, validated in the repository | Closed `CHECK … IN (…)` — adding a value needs the table rebuild rule 7 forbids, and the failure is `SQLITE_CONSTRAINT` aborting the whole drain batch, not a mislabelled row |
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
| Direct-boot capture | Not built; `capture_gaps.cause = 'boot_before_unlock'` | CE/DE split with a device-protected spool — the same gate blocks every *sender*, so there is nothing to capture, and DE storage is backup domain `device_file`, which makes every `domain="file"` exclusion rule silently miss |

---

## Rejected findings (schema)

Findings from the adversarial review that this section does **not** implement as written, and why.
Everything not listed here was folded in.

**1. "Make `v_account_balances` sum `account_amount_minor` and add a second seal predicate
`SUM(account_amount_minor) = 0` per account currency" (accounting, critical #1, option a).**
Accepted as a defect, implemented via the reviewer's option (b) instead. Option (a) cannot work:
the second invariant does not hold. In the Tokyo lunch the card leg's account-currency amount is
−3342 USD and the category leg has no USD counterpart at all, because nothing absorbs the two sides
of the conversion — so a per-account-currency zero-sum would fail on every foreign transaction. It
only becomes satisfiable once `fx_conversion` legs exist, at which point `account_amount_minor` is
redundant. Deleted the columns; see §3.7 and §3.7.2b.

**2. "Sweep check I12: for every active transaction, SUM of non-auto-balance legs in the header
currency must equal `effective_amount_minor`" (accounting/data-loss, critical #4).** Accepted as a
defect; the stated predicate is arithmetically wrong and would fire on every correct transaction in
the database. On an ordinary same-currency expense the non-auto-balance legs are −5000 (card) and
+5000 (category), which sum to 0, not to 5000 — that is the balance invariant, and asserting it
equals a non-zero header amount fails universally. Implemented as **I10** over `role = 'category'`
legs in the header currency only, which is the predicate that actually catches the un-split-receipt
bug it was written for.

**3. I12 numbering collision.** Three separate reviewers each proposed "add sweep check I12" for
three different checks (header/leg tie, oplog allowlist, `allow_hard_delete`). Renumbered: header/leg
tie is **I10**, reporting-allocation drift **I11**, oplog allowlist **I12**, aged unmatched transfer
**I13**, stuck `clearing_state` **I14**, budget currency drift **I15**, `allow_hard_delete` **I16**.
`integrity_findings.check_id` no longer carries a closed list, so the numbering can extend without a
table rebuild.

**4. "Consent snapshot: resolve in favour of capture time" (data-loss, minor) versus "it has to be
the drain; remove the manifest field entirely" (security, major).** Both reviewers are right about
the failure they found and wrong about the fix, because each proposal reintroduces the other's bug.
Capture-time-only lets a Monday opt-in retroactively relicense a weekend of captures collected under
no consent — which §5.5.2's own justification forbids. Drain-time-only lets forty captures spooled
under consent land as opted-in *seconds after* the user revoked, because `UPDATE … WHERE
training_opt_in = 1` cannot reach rows that do not exist yet. Resolved as
`training_opt_in = manifest_hint AND current_grant`, documented on the column in §3.10.
**This requires a change I cannot make: 05-provenance.md §5.5.2 currently says "stamped at drain
time from the then-current grant" and must be amended to the AND rule.** 04-capture.md §4.4.1's
manifest field is the hint and is correct as written; the security reviewer's instruction to delete
it would remove half the resolution. Flagged rather than assumed.

**5. "Either add `currency_code`/`currency_exponent` to `budget_periods` **or** state in §3.15 that
they are inherited" (accounting, minor).** Took the first branch unconditionally rather than
treating it as a choice. Inheritance is the failure — rule 2 exists because a money amount whose
currency is read from a parent row silently reinterprets itself the moment the parent is edited, and
`budgets.currency_code` is user-editable.

**6. "Drop `budgets.date_basis` if the staleness trigger cannot respect it" (accounting, major).**
Rejected: `date_basis` is a real product requirement for users reconciling against a home-country
statement. The trigger can respect it — it joins `budget_lines → budgets` and switches on
`date_basis` inside the marking predicate (§3.19 §5). Slightly more expensive per write; a budget
that fails to invalidate is not.

**7. "Add `'diagnostics'` to the `process_state` enum" (security, major, offered as one of two
options).** Took the other option. `process_state` is a pipeline position and a diagnostics capture
still runs `queued → parsed`; putting a capture-condition into it makes two dimensions share one
column, which is the shape of the bug the finding is about. Implemented as
`raw_captures.captured_under_diagnostics`.

**8. "Restrict the §3.14 chain to observations whose `balance_currency_code` matches the account's
currency, and use each observation's account-currency amount — which requires finding 1's fix"
(accounting, major).** The fix is implemented, but not by the route named: finding 1's fix deletes
`entries.account_amount_minor`, so the chain cannot borrow it. The account-currency amount is added
to `observations` instead, where the balance chain actually reads. Noted because a reader following
the finding's cross-reference will otherwise look for a column that no longer exists.

**9. "`transactions.reporting_amount_minor` should be added to the settle path's dirty-column set"
(accounting, major).** Accepted, and the schema-side half is implemented here
(`trg_txn_reporting_same_currency_upd` makes the omission a loud failure rather than a silent
€2.50 shortfall). **The repository-side half lives in 04-capture.md §4.9 and is not mine to
edit** — this section can only guarantee that skipping it aborts the write.

**10. Findings addressed entirely outside this file.** Restore ordering and the restore-in-progress
marker, the Android backup rules-file path constants, the spool sealed-box key derivation, the
`PRAGMA foreign_keys = OFF` finally-block, WAL-aware migration rollback, spool cap behaviour and
fsync, undrained-spool backup coverage, recovery-phrase rotation, `recovery.wrap`'s self-describing
format, Keychain accessibility classes, the logging/crash-reporting policy, off-device transmission
consent, and the `onNotificationPosted` threading contract. Each is named at the point in this
section where the schema depends on it (§3.10's mirror contract, §3.14's `cause` vocabulary,
§3.3.5's `sys_unrealized_fx`) so the dependency is visible from here, but the change belongs to
02-storage.md, 04-capture.md, 06-sync-backup.md or 07-platforms-risks.md.
