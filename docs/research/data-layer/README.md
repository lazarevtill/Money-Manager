# Data layer design

Date: 2026-08-02 · Companion docs: [`../2026-08-02-on-device-ai-stack.md`](../2026-08-02-on-device-ai-stack.md), [`../2026-08-02-app-layers.md`](../2026-08-02-app-layers.md), [`../2026-08-02-image-preprocessing.md`](../2026-08-02-image-preprocessing.md)

The on-device data layer for the expense manager: storage, schema, capture pipeline, provenance, and the "you will not lose your data" story. Split into section files because it is ~10,900 lines; read them in order.

| File | Contents |
| --- | --- |
| [`01-decisions.md`](01-decisions.md) | Decisions D1–D131, each with its rationale and the failure it prevents. **Start here.** |
| [`02-storage.md`](02-storage.md) | SQLite binding, encryption at rest, key management, the locked-device write path |
| [`03-schema.md`](03-schema.md) | The complete DDL — 43 tables, 33 triggers, 74 indexes, 4 views. The centrepiece |
| [`04-capture.md`](04-capture.md) | Lifecycle state machine, dedupe algorithm, staging and replay |
| [`05-provenance.md`](05-provenance.md) | Field provenance, correction diffs, the fine-tuning harvest, consent |
| [`06-sync-backup.md`](06-sync-backup.md) | Backup container, restore, platform backup, migrations, deferred sync |
| [`07-platforms-risks.md`](07-platforms-risks.md) | iOS vs Android, risk register, gates G-1–G-39, open questions |

## How this was produced

Six parallel research agents, a schema-first synthesis pass, four adversarial reviewers (data-loss, Android reality, crypto/privacy, accounting correctness), and a revision pass that folded findings back into the sections. **54 findings, 19 critical.** Findings judged wrong were rejected in writing with reasoning rather than silently dropped — see the "Rejected findings" sections.

Every claim carries an evidence marker. Several were settled by reading primary source (op-sqlite `cpp/bridge.cpp`, the SQLCipher amalgamation) rather than documentation, and those are the ones that changed the design most.

## The load-bearing invariants

These belong in `CLAUDE.md` before implementation starts. Each traces to a specific failure.

1. **Money is `INTEGER` minor units with `CHECK (col BETWEEN -9007199254740991 AND 9007199254740991)`.** Not a style rule. op-sqlite reads every `SQLITE_INTEGER` through `sqlite3_column_double()` (verified in `cpp/bridge.cpp`), so values above 2^53 truncate **silently**. The CHECK converts silent corruption into a loud constraint failure.
2. **Every money column travels as a triple** — `(amount_minor, currency_code, currency_exponent)` — with the exponent denormalized onto the row. Correcting one wrong row in `currencies` would otherwise retroactively change a decade of history.
3. **Double-entry balances per currency, not in home currency.**
4. **Transaction state is three orthogonal axes**, not one enum. A single status enum needs ~30 states, most of them illegal, and the illegal ones are the bugs.
5. **`synchronous = FULL`.** `NORMAL` survives an app crash but not power loss, and there is no upstream copy.
6. **Primary keys are `TEXT` UUIDv7**; hashes are lowercase hex `TEXT`, never `BLOB` — BLOBs round-trip as `ArrayBuffer` through op-sqlite.
7. **Filter before persistence.** Non-financial notifications and personal SMS are never written at all. This is a privacy property and the strongest sentence available in the Play SMS declaration.
8. **All value writes pass through one chokepoint** so a re-parse can never silently overwrite a user correction.
9. **Ordering is by sequence number, never wall clock.** A flat battery or an NTP correction otherwise reorders edits invisibly.

## Cross-workstream dependencies

- **Foundation → storage, resolved.** `app-layers.md` §2.4 confirms prebuild + New Architecture leaves `op-sqlite`, `expo-sqlite`, and WatermelonDB all available. This design assumes **op-sqlite 17.1.3 with SQLCipher**, SQLite 3.51.3, all tables `STRICT`.
- **Image preprocessing → schema, outstanding.** [`../2026-08-02-image-preprocessing.md`](../2026-08-02-image-preprocessing.md) §7 requests a `media_assets` delta (derivation lineage, source geometry, segment index, `crop_method`). Not yet applied.
- **Backup must bundle the media directory, not just the `.db`.** A restore that omits it is silently incomplete, and there is no cloud copy to repair from.

## Known-open, before implementation

- The `media_assets` delta above.
- Gates G-1–G-39 in `07-platforms-risks.md` — the ones marked blocking must be closed before the corresponding code is written.
- The iOS engine decision in `app-layers.md` §16.4 affects which platform this schema is exercised on first, but not the schema itself.
