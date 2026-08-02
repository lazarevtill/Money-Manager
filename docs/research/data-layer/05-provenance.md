## Provenance, corrections, and the fine-tuning harvest

Extraction runs at roughly 0.80 F1. That number is not a defect to be engineered away before v1;
it is the operating point, and it means **user correction is the normal path**. Everything in this
section follows from taking that literally: the schema must be able to say *who produced this
number, from what evidence, with what model, and whether a human has since overruled it* — for
every field, forever, with no cloud service to reconcile against.

The tables are already defined in §3.10 and §3.11 (`raw_captures`, `observations`,
`extraction_runs`, `extracted_fields`, `corrections`, `transaction_fields`, `field_conflicts`,
`replay_runs`, `training_exports`). This section does not restate that DDL. It specifies the
**procedures the schema cannot express**: how a pipeline identity is assigned, the single
chokepoint every value write passes through, what makes a correction a training label, the consent
model, and the retention/purge/export mechanics.

New DDL introduced here belongs folded back into §3: two tables (`consent_grants`,
`retention_policies` → §3.11), one partial unique index (`ux_extraction_current` → §3.11.1), two
guard triggers (`trg_transaction_fields_pin_guard`, `trg_observations_balance_currency` → §3.19),
and two startup-sweep checks (I17, I18 → §3.21). **§5.10 reconciles every change this section
needs from §3**; the capture-side changes are in 04-capture §4.17, and the two are disjoint.

---

### 5.1 The provenance chain, end to end

```text
raw_captures            the verbatim input. Immutable. Redacted in place, never deleted.
  └─ extraction_runs    one row per parse ATTEMPT. Carries the full pipeline identity.
       ├─ extracted_fields          what run R emitted for field F, with confidence + spans
       └─ field_confidence_json     the long tail (line items) as a compact pointer→conf map
  └─ observations       (capture, current run) with a role — the unit the dedupe engine matches

transaction_fields      the CURRENT value of each field, with two provenance axes, and the
                        pinned flag. This is the arbiter of "may a new observation overwrite?"
corrections             the user's diffs. The fine-tuning harvest.
transaction_events      the append-only narrative (FIELD_REVISED, USER_VALUE_SUPERSEDED, …)
oplog                   the per-column before/after, written from the same chokepoint
```

Five different questions, five different tables, deliberately not normalized together:

| Question | Table |
| --- | --- |
| What text/image did we actually receive? | `raw_captures.payload_text` / `media_assets` |
| Which model, prompt and schema produced this parse? | `extraction_runs` |
| What did that run emit for `/total`, and how sure was it? | `extracted_fields` |
| What is the value **now**, and may a re-parse change it? | `transaction_fields` |
| What did the human change, and is it training-eligible? | `corrections` |

The critical structural property: `corrections` links to `extraction_runs` by the **natural key
`(run_id, field_path)`**, not to `extracted_fields` by FK. That is what makes the pruning strategy
in §3.11.2 safe — only ~7 canonical fields are materialized per run, but a correction on
`/line_items/3/amount` still links, because it does not require an `extracted_fields` row to
exist.

---

### 5.2 Pipeline identity — what gets stamped on every value

`extraction_runs` records the identity in twelve columns. The ones people get wrong:

| Column | Why it is not optional |
| --- | --- |
| `model_sha256_hex` | Hash of the `.litert-lm` file actually loaded. Catches a partially-downloaded model, a user side-loading a different quant, and a CDN serving a re-uploaded file under the same name. Without it, a quality regression is unattributable. |
| `backend` | `gpu` / `cpu` / `ane` / `npu`. Same weights, different runtime, measurably different outputs at int4. Explains latency *and* quality deltas. |
| `quantization` | An `int4` and a `q8_0` run of the same checkpoint are different extractors. |
| `prompt_version` | Bump on **any** prompt edit, including whitespace. A correction harvested under a prompt you later rewrote is a mislabeled example for the new prompt. |
| `schema_version` | The function-call output shape. Version-gates the export. |
| `taxonomy_version` | §3.4.2 freezes the canonical key set per version; a taxonomy change silently poisons the accumulated corpus otherwise. |
| `fields_shown_json` | Which canonical fields were actually rendered on the confirm sheet. Without it you cannot distinguish "the user accepted this" from "the user never saw it", and the corpus trains the model to repeat errors nobody looked at. |
| `decode_params_json` | temperature, top_k, seed, max_tokens. A non-zero temperature makes a run non-reproducible; recording it is the only way to know that. |

#### 5.2.1 `pipeline_rank`: one monotonic integer, assigned from a checked-in registry

`pipeline_rank` is **not** computed at runtime. It is the index into a checked-in constant array in
app code:

```ts
// src/extraction/pipelineRegistry.ts — APPEND ONLY. Never reorder. Never recycle a rank.
export const PIPELINES = [
  /* 0 */ { id: 'manual',                          engine: 'manual' },
  /* 1 */ { id: 'wallet:ios',                      engine: 'wallet_app_intent' },
  /* 2 */ { id: 'llm:gemma4-e2b/0.11/p5/s3/t1',    engine: 'litert_lm', ... },
  /* 3 */ { id: 'llm:gemma4-e2b/0.13/p7/s4/t1',    engine: 'litert_lm', ... },
  /* 4 */ { id: 'vlm:gemma4-e4b/0.13/p3/s4/t1',    engine: 'litert_lm', ... },
] as const;
```

Rank is bumped on any change to `(model_id, model_version, quantization, prompt_version,
schema_version, taxonomy_version)`. `backend` is deliberately **excluded** from the identity: a
device that falls back from GPU to CPU must not look like a pipeline upgrade. Templates get their
rank from `bank_templates.version` offset into a reserved band, so a promoted template always
outranks the LLM that trained it.

#### 5.2.2 `value_source_rank` — ONE formula, defined here and nowhere else

The §3.11.4 replacement rule compares `value_source_rank` in its equal-authority branch. That
column must encode **three** things, and the design previously encoded two of them twice, in two
sections, incompatibly:

- **which channel the evidence arrived on** — the full untruncated SMS must beat the truncated,
  redaction-prone notification of the same purchase regardless of arrival order (04-capture §4.5.1);
- **which kind of extractor** produced it — an active template beats any LLM;
- **which generation** of that extractor — a newer Gemma must be able to fix an older Gemma's
  misparse of the same bank message.

04-capture.md §4.5.1 defined `channel_precedence * 1000 + pipeline_rank`; this section defined
`ENGINE_BASE * 100 + pipeline_rank`. Both were presented as *the* formula, both were consumed by
the same branch, and they **disagree in opposite directions** on the case that matters most —
under the first a user edit scores ~10,000 and an SMS re-extraction ~80,003; under the second a
user edit scores ~1,000 and any LLM run ~403. Whichever an implementer picked, the other section's
worked example became wrong, and both produce plausible-looking integers so the divergence is
invisible.

**This is the single normative definition.** It is a two-part sort key flattened into one integer,
evaluated channel-first, then engine, then generation:

```text
value_source_rank = CHANNEL_PRECEDENCE[source_channel] * 100000
                  + ENGINE_BASE[value_source]          * 100
                  + min(pipeline_rank, 99)

ENGINE_BASE        = { derived: 1, ocr: 2, asr_llm: 3, llm: 4, vlm: 5,
                       template: 6, import: 7, user: 10 }
CHANNEL_PRECEDENCE = the table in 04-capture.md §4.5.1, which is its ONLY definition.
                     manual_text 10 · voice 20 · screenshot_ocr 30 · camera_receipt/ios_share 40
                     · android_notification 50 · android_notification_sms 60 · ios_wallet_intent 70
                     · android_sms 80 · statement_import/file_import 90
```

Worked: `gemma4-e2b @ rank 3` over an `android_notification` → 5,000,403; the same model over the
`android_sms` copy of the same message → 8,000,403, so **the SMS wins regardless of arrival
order**, which is the entire point of §4.5.1. Bump the model to rank 7 and the notification goes to
5,000,407 — accepted at equal authority against the older notification run, still beaten by the
SMS. An active template on the notification → 5,000,6xx, always ahead of any LLM on the same
channel. This is also why ranks must never be recycled: a recycled rank silently makes an older
pipeline able to overwrite a newer one.

> **The one case this formula gets "wrong", and the mechanism that makes it safe.** A user edit
> arrives on `manual_text` (channel precedence 10) and scores ≈ 1,001,000, which an `android_sms`
> re-extraction at ≈ 8,000,403 beats. **A machine must never out-rank a human on the equal-authority
> tiebreak**, and the reason it does not is that the tiebreak is never reached: §5.3.2 step 6 sets
> `pinned_by_user = 1` and `pinned_at_authority = cur.authority_rank` on every user write to a
> bank-authoritative field, so a re-parse at the same authority hits `REJECT_PINNED` two branches
> earlier. `value_source_rank` deliberately encodes *evidence quality*, not *who is in charge*;
> authority and the pin encode who is in charge. **Do not ship this formula without §5.3.2 step 6**
> — separately they are each defensible and together they are the design; the formula alone makes
> §4.5.1's failure mode unconditional.

`commitFieldValues` computes this at step 2 and **never** accepts it from a caller. It is the only
site in the codebase permitted to reference `CHANNEL_PRECEDENCE` or `ENGINE_BASE`.

#### 5.2.3 Sentinel engines and the provenance→authority map

`extraction_runs` is **mandatory even when no model ran**. A Wallet-trigger capture, a manual entry
and a template parse all get a run row with a sentinel engine. If the table were optional every
consumer downstream would branch on NULL, and the audit story would be unreadable. With sentinels,
confidence comes from provenance rather than from a model, and the UI can honestly say *"this
amount came from Apple Pay, not from a 0.80-F1 extractor."*

This is the canonical mapping. It is a single frozen table in app code, consumed by the chokepoint:

| `engine` | `modality` | `value_source` | Capture role → `evidence_authority` | `authority_rank` | default `overall_confidence` |
| --- | --- | --- | --- | --- | --- |
| `manual` | `none` | `user` | `user_assertion` | 20 | 1.0 |
| `import` (statement) | `none` | `import` | `statement_line` | 60 | 1.0 |
| `wallet_app_intent` | `none` | `import` | `bank_auth` | 40 | 1.0 *(see caveat)* |
| `template` (state `active`) | `text` | `template` | `bank_settle` 50 / `bank_auth` 40 | 50 / 40 | 0.99 |
| `litert_lm` text | `text` | `llm` | role of the capture | 50 / 40 / 30 | model-reported |
| `litert_lm` image | `image` | `vlm` | `merchant_receipt` | 30 | model-reported |
| `litert_lm` audio | `audio` | `asr_llm` | `user_assertion` | 20 | model-reported |
| `ocr` | `image` | `ocr` | `merchant_receipt` | 30 | per-word min |
| `rule` | `none` | `derived` | `inference` | 10 | 1.0 |

**Wallet caveat.** The iOS Wallet/Transaction trigger is documented to hand back an empty
`Merchant` or a zero `Amount` with some card providers. `overall_confidence = 1.0` applies only to
fields that arrived present and non-degenerate; a Wallet run with `amount == 0` or an empty
merchant is written with `status = 'partial'`, the offending field is simply absent from
`extracted_fields`, and the transaction lands `confirm_state = 'needs_review'` with
`raw_captures.payload_meta_json` holding the literal intent parameters received. **The intent stages whatever it
receives and never validates-and-discards** — a silently dropped transaction in a finance ledger is
worse than a visibly wrong one.

#### 5.2.4 Confidence is for routing, never for display

Field-level confidence lives in `extracted_fields.confidence` for the canonical seven and in
`extraction_runs.field_confidence_json` (RFC 6901 pointer → number) for everything else. Where it
comes from:

- **Constrained-decode LLM** — mean token probability over the field's generated span. Under GBNF /
  `@Generable` / LiteRT-LM function calling the *structure* is guaranteed valid, so confidence
  measures content uncertainty only. Do not confuse "parsed" with "correct".
- **Template** — 1.0 for a field with a located regex span, absent otherwise. A template does not
  guess.
- **OCR** — the minimum per-word confidence over the field's bounding region.
- **Sentinels** — set by the table above.

**These numbers are not calibrated and must never be shown to the user as a percentage.** An LLM's
self-reported confidence at int4 on a phone is a routing signal, nothing more. It is used for
exactly three decisions: escalate to VLM, route to `needs_review`, and select a capture for replay.

Calibration is derived locally from the corrections the app already has. The `fields_shown_json`
filter is the whole point — without it, "not corrected" silently includes "never displayed":

```sql
-- Correction rate by confidence decile, per field, per pipeline. Run monthly; retune the
-- needs_review threshold per (field, pipeline_rank) from the result.
SELECT ef.field_path,
       CAST(ef.confidence * 10 AS INTEGER)                      AS conf_decile,
       COUNT(*)                                                  AS shown,
       SUM(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END)         AS corrected
  FROM extracted_fields ef
  JOIN extraction_runs  er ON er.id = ef.run_id
  LEFT JOIN corrections c
         ON c.run_id     = ef.run_id
        AND c.field_path = ef.field_path
        AND c.correction_kind IN ('edit','fill_missing','delete_hallucination')
 WHERE er.pipeline_rank = :rank
   AND er.fields_shown_json IS NOT NULL
   AND EXISTS (SELECT 1 FROM json_each(er.fields_shown_json) j WHERE j.value = ef.field_path)
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

#### 5.2.5 Exactly one current run per capture — and who flips `is_current`

`extraction_runs.is_current` and `superseded_by` are load-bearing and nothing in §3.11 says who
writes them. Both the replay selection predicate and `ix_extraction_capture` filter on
`is_current = 1`, and `transactions.primary_extraction_id` is ambiguous if two runs claim it.

**Rule:** `is_current = 1` marks the run whose output is the app's current answer for that capture,
and there is exactly one. The writer inserting a new run clears the previous one **in the same
transaction**, setting the old row's `superseded_by` to the new run's id. This covers the
OCR→text→VLM ladder too: a stage run (OCR feeding a text LLM) is superseded the moment its consumer
is written, and an escalated VLM run supersedes the text run it escalated from — the same
`escalated_from_id` chain that makes the escalation auditable is what keeps the ladder to one
current answer.

Because that holds, the invariant is enforceable by the database rather than by convention, which
is worth a line of DDL:

```sql
-- Belongs in §3.11.1. Legal only because the ladder runs inside one transaction and every
-- insert clears its predecessor in the same statement batch.
CREATE UNIQUE INDEX ux_extraction_current
  ON extraction_runs(raw_capture_id) WHERE is_current = 1;
```

Verify this against the real escalation implementation before shipping it: if a text run and an
image run over one receipt photo are ever legitimately current at the same time, the index is
wrong and the guard has to become a sweep check instead. That single question — *does an escalated
run supersede its parent, or run alongside it?* — is the whole discriminator, and it is decided by
how the escalation is coded, not by the schema.

---

### 5.3 The chokepoint

Every value write in the application passes through **one function**. Extraction, replay, merge,
settlement arrival, FX re-derivation, statement import and the user's own edit all call it. There
is no second path.

```ts
type FieldWrite = {
  field: 'amount' | 'currency' | 'occurred_at' | 'account_id' | 'direction'
       | 'merchant_id' | 'merchant_label' | 'category_id' | 'note' | 'clearing_state' | …;
  valueJson: string;
  valueSource: 'user'|'template'|'llm'|'vlm'|'asr_llm'|'ocr'|'import'|'derived';
  evidenceAuthority: 'statement_line'|'bank_settlement'|'bank_auth'
                   | 'merchant_receipt'|'user_assertion'|'inference';
  pinRequested?: boolean;
};

commitFieldValues(db, {
  txnId, writes: FieldWrite[],
  actor: 'user' | 'system' | `replay:${string}`,
  runId?: string, observationId?: string,
  uiSurface?: 'confirm_sheet'|'later_edit'|'bulk_review'|'verify_carefully',
  dryRun?: boolean,
}): FieldDecision[]
```

#### 5.3.1 How it composes with `writeTransaction()`

§3.7.1 already names `writeTransaction()` as the repository chokepoint that owns the transaction
boundary and inserts the `transaction_seals` row as the **last statement before COMMIT**. There is
no second transaction boundary here: `commitFieldValues()` **never opens and never commits**. It
runs inside the `BEGIN IMMEDIATE` that `writeTransaction()` opened, and the seal insert still comes
last. Any write in the `MONEY_BEARING` set forces a leg rewrite, so the sequence is
`DELETE FROM transaction_seals` → mutate → `rewriteLegs()` → re-insert the seal, and the balance
verification runs exactly as it does for any other ledger mutation.

```text
MONEY_BEARING   = { amount, currency, direction, account_id }                 -- unseal/rewrite
NON_LEDGER      = { merchant_id, merchant_label, note, tags, clearing_state } -- seal untouched

category_id     = MONEY_BEARING **only when the transaction has at most one category leg.**
                  On a SPLIT transaction a category_id write is REJECTED with a distinct
                  decision code (REJECT_SPLIT), not applied — see below.
```

**`category_id` was in `MONEY_BEARING` and that was a silent data-loss path.** "Forces an entry
rebuild" previously meant `buildEntries(draft)` (§3.7), a pure function over the **flat façade**,
which has no representation for a multi-way split. So a €120 supermarket receipt the user split
€90 groceries / €30 household was silently un-split by the next settlement arrival or the next
money-bearing correction — and nothing caught it, because the rebuilt two-leg transaction still
sums to zero, so the seal passes and sweep check I1 reports the ledger clean. Three coordinated
changes fix it and all three are required:

1. **The rewrite is proportional, not a rebuild, whenever more than one category leg exists.**
   04-capture.md §4.9.1 specifies `rewriteLegs()`: keep every leg's `account_id`, `role` and
   `line_items` linkage, allocate the new total across the existing category legs by
   largest-remainder (rule 9). A full rebuild is the single-category path only, and a rewrite that
   *would* drop a user-created leg raises `needs_review` plus a `field_conflicts` row instead of
   proceeding.
2. **`category_id` on a split transaction is rejected here**, at the chokepoint, rather than
   triggering a rewrite. Re-categorising a split is a split-editor operation with its own UI, not a
   single-field write; letting it through the flat path is what makes the loss reachable from an
   ordinary confirm sheet.
3. **`line_items.entry_id` is `ON DELETE RESTRICT`** (§3.8), per rule 6 / D50. `SET NULL`
   turned the failure from a caught constraint error into 23 silently orphaned line items.

Sweep check **I10** (§3.21) is the backstop: for every active transaction, the destination-side
non-`is_auto_balance` legs in the header currency must sum to `effective_amount_minor`. Its absence
is exactly why this passed all nine existing sweeps.

#### 5.3.2 The algorithm, in order

1. **Precondition.** Assert an open transaction. Assert `runId` is present unless
   `actor === 'user'` and the edit is a pure `later_edit` on an already-confirmed row.
2. **Resolve ranks.** `authority_rank` from the frozen map in §5.2.3; `value_source_rank` from the
   formula in §5.2.2. Never accept these from the caller.
3. **Load current state.** One `SELECT … FROM transaction_fields WHERE txn_id = ? AND field IN (…)`.
4. **Decide, per field** — the §3.11.4 rule, implemented once:

   ```text
   if field = 'category_id' and the txn has >1 category leg  → REJECT_SPLIT   (§5.3.1)
   if field ∈ USER_AUTHORITATIVE and cur.pinned_by_user     → REJECT_PINNED
   if field ∈ BANK_AUTHORITATIVE and cur.pinned_by_user     → SUPERSEDE_PINNED iff
                                                               new.authority_rank > cur.pinned_at_authority
                                                              else REJECT_PINNED
   if divergence(cur, new) exceeds the class tolerance      → CONFLICT
   accept iff new.authority_rank > cur.authority_rank
          or  (new.authority_rank == cur.authority_rank
               and new.value_source_rank >= cur.value_source_rank
               and new.observed_at      >= cur.observed_at)
   ```

5. **Divergence test, before precedence — numeric AND non-numeric.** For **numeric**
   bank-authoritative fields: a ratio in `{10^±1, 10^±2, 10^±3}` (decimal-separator misparse), a
   sign flip, or — outside the tip classes — any ratio outside `[1.00, 1.25]` is a **conflict, not
   a precedence question**. Receipt says 27.50, SMS says 275.00: silently applying precedence is
   how a 1000× error becomes permanent.

   The test previously stopped there, which left the two fields users correct *most* — the merchant
   and the date — with no divergence path at all. **Extend it:** any write to `merchant_id`,
   `merchant_label`, `occurred_at`, `account_id` or `direction` that **reverses a value the user
   previously set** (`cur.value_source = 'user'`) is a `field_conflicts` row, never a precedence
   question, regardless of the incoming authority. A machine may *add* what a human never supplied;
   it may not *contradict* a human silently.

   A conflict writes a `field_conflicts` row, sets `needs_review = 1`, and **does not write the
   value**.
6. **Apply accepted writes, and auto-pin user writes.** `UPSERT` into `transaction_fields`,
   **dirty columns only** (rule #8, §3.0) — never a full-row `UPDATE`, because a full-row write is
   what forecloses per-field merge under any future sync engine.

   > **On every write where `actor === 'user'`, set `pinned_by_user = 1`; and when the field is
   > bank-authoritative, set `pinned_at_authority = cur.authority_rank` — the authority of the
   > value being DISPLACED, not the user's own 20.**
   >
   > This is the single most consequential line in the section, and its absence made all five of
   > §5.4's "independent locks" unreachable. Every one of them routes through `pinned_by_user`, and
   > nothing set it: `FieldWrite.pinRequested` is an *optional caller flag* and §3.11.4 defaults the
   > column to 0, so an ordinary confirm-sheet correction landed at `authority_rank = 20`,
   > unpinned, and was **silently reverted by any later machine write at 40/50/60 — including a
   > replay re-extraction of the very message the user was correcting.** The replay predicate
   > selects on `overall_confidence < 0.90` regardless of `confirm_state`, which at a 0.80-F1
   > operating point is the majority of the captures the user actually had to fix; the divergence
   > test did not fire (merchant and date were not covered — see step 5); `USER_VALUE_SUPERSEDED`
   > was not emitted (that branch requires the pin); `needs_review` was not raised; and the shadow
   > gate passed because the change rate for that `(sender, fingerprint)` is *low* precisely
   > because most rows were never corrected. The 7-day undo window then expired unnoticed.
   >
   > **This is not "pin everything".** Recording the displaced authority is what keeps the ladder
   > working: a re-parse of the same auth message arrives at 40 against a pin taken at 40, so
   > `40 > 40` is false and it hits `REJECT_PINNED`; a settlement (50) and a statement line (60)
   > still supersede, emit `USER_VALUE_SUPERSEDED`, set `needs_review = 1` and surface as *"settled
   > at 27.50 — you entered 25.00."* That is exactly the behaviour §3.11.4 and D79 describe and
   > never wired up. For **user-authoritative** fields `pinned_at_authority` stays NULL and the pin
   > is absolute, as before.
   >
   > `pinRequested` survives only as an *explicit* pin the user can set on a field they were not
   > editing ("always keep this category for this merchant"); it is no longer the mechanism by
   > which an edit is protected.

   Consequently the **replay selection predicate** (§3.11.5) must widen its `NOT EXISTS` from the
   four listed fields to *any* `transaction_fields` row on that transaction with
   `pinned_by_user = 1`. Under the auto-pin the old four-field list would still hand every
   corrected-merchant transaction to the replay, and rely on the decision function alone to save
   it — a second line of defence doing the job of the first.

   > **`observed_at` contract, because two rules depend on it and the column name is ambiguous:**
   > `observed_at = observations.event_at_utc` when the value came from an observation
   > (evidence-observation time — the notification `postTime`, the SMS `date`, the receipt's printed
   > time), and `observed_at = now` when `value_source = 'user'`. Without the second half a user
   > correcting from a three-day-old receipt writes a row with an `observed_at` older than the
   > machine value it just replaced, which makes both the equal-authority branch in step 4 and the
   > undo guard in §5.4.1 no-ops that read as safeguards.
7. **Mirror to the denormalized header.** `transaction_fields` is the arbiter; `transactions` is
   the projection the hot queries read. One field→column map, applied here and nowhere else:
   `amount → amount_minor (+ amount_text_raw)`, `currency → currency_code + currency_exponent`,
   `occurred_at → booked_at_utc + booked_tz + booked_local_date`, `category_id → the category leg's
   entries.account_id`. Drift between the two is sweep check I17 (§5.7.3).
8. **Append `transaction_events`.** `FIELD_REVISED` per accepted field with
   `payload_json = {field, prev, next, run_id, authority_rank}`; `AMOUNT_ASSERTED` when the field is
   `amount`; `USER_VALUE_SUPERSEDED` on the pinned-bank-override branch, which must also surface in
   the UI — *"settled at 27.50; you had entered 25.00."* `actor` is passed straight through.
9. **Append `oplog`** with `origin` derived from `actor` (`user` | `extraction` | `replay` |
   `fx_rederive` | `import` | `system`).
10. **Write `corrections` — if and only if `actor === 'user'`.** See rule C1 below.
11. **Recompute** `needs_review` and `confirm_state`, then return the decision list.

`dryRun: true` executes steps 1–5 and returns the decisions **without writing anything**. That is
how the replay shadow pass works, and it matters that it is the same code: a shadow diff computed
by a parallel implementation is a shadow diff that will eventually disagree with the apply path.

#### 5.3.3 Rule C1 — the corpus purity rule

> **A `corrections` row is written if and only if `actor === 'user'`.**

FX re-derivation writes `fx_rederivations`. Replay writes `FIELD_REVISED` with
`actor = 'replay:<run_id>'`. Merge and settlement write `USER_VALUE_SUPERSEDED`. None of them
touches `corrections`. If any machine-originated change leaked into `corrections`, the next
fine-tune would train on the previous model's output — a self-reinforcing feedback loop that is
invisible in every metric the app computes, because the model would be scored against labels it
generated itself. This is the single most important rule in this section and it is not enforceable
by the database; it is enforced by the chokepoint being the only writer plus the module-boundary
test in §5.7.1.

#### 5.3.4 Rule C2 — which run a correction is attributed to

`corrections.run_id` is **the run the user was looking at**, i.e.
`transactions.primary_extraction_id` at the moment of the edit — not the newest run for the
capture. If a replay later supersedes that run, the correction's `run_id` still points at the run
whose output the human actually rejected. That is what makes the error-distribution analysis
meaningful. (It is also why the training *label* must not be reconstructed from that run — see
§5.6.1.)

#### 5.3.5 What is written on confirm

One `corrections` row per changed field, plus **exactly one** row with
`correction_kind = 'accept_all'` and `field_path = ''`.

> **Contract:** `field_path = ''` is the RFC 6901 whole-document pointer. `corrections.field_path`
> and `extracted_fields.field_path` share one namespace and `''` means "the entire payload". Do not
> use `'*'` or `'/'`.

The `accept_all` row carries the final accepted payload in `new_value_json`. Accepted-unchanged
fields are as valuable a training label as corrected ones, and this is the cheapest way to record
them — every other field is derivable as "the model was right" by the absence of an `edit` row.

A correction of a correction is a new row; `corrections` is append-only in practice, and the export
takes the **latest** `corrected_at` per `(raw_capture_id, field_path)`.

Worked example — a BBVA MX SMS, extracted at 0.71 confidence on merchant, corrected on two fields:

| `field_path` | `old_value_json` | `new_value_json` | `old_confidence` | `correction_kind` | `ui_surface` |
| --- | --- | --- | --- | --- | --- |
| `/merchant` | `"OXXO GAS 4471"` | `"OXXO Gas"` | 0.71 | `edit` | `confirm_sheet` |
| `/category` | `null` | `"transport.fuel"` | `null` | `fill_missing` | `confirm_sheet` |
| `` (empty) | `null` | `{full payload}` | `null` | `accept_all` | `confirm_sheet` |

`corrections` grouped by `field_path` is also the live product metric. If `/currency` is corrected
30% of the time, the currency-disambiguation ladder is the thing to fix — and you know that from
the schema rather than from a guess.

---

### 5.4 Re-parse can never silently overwrite a user correction

A model upgrade, a prompt edit, or a template promotion creates a `replay_runs` row and re-extracts
history. This is the operation the chokepoint exists to make safe. **Five independent locks**, each
of which alone would be insufficient:

1. **`pinned_by_user`, set automatically on every user edit** (§5.3.2 step 6 — without that, all
   five of these locks are unreachable, because every one of them routes through this flag). A
   pinned user-authoritative field is rejected unconditionally. A pinned bank-authoritative field
   is accepted only by strictly higher authority than `pinned_at_authority` — the authority the
   user's edit displaced — and that acceptance is surfaced, never silent.
2. **Authority ordering.** A re-read merchant receipt (30) can never clobber a bank settlement
   (50), no matter how much better the new model is.
3. **The replay selection predicate** (§3.11.5) excludes any transaction carrying **any** pinned
   field — not the four-field list it previously named — and excludes purged captures.
4. **`match_vetoes` (gate G7) is consulted during replay.** A user who said "these are two
   different coffees" is never asked again, and a smarter model is not permitted to overrule them.
5. **Shadow-first application.** Every replay chunk runs `commitFieldValues(dryRun: true)` first.
   The chunk is applied only if, for the affected `(sender, fingerprint)`, the change rate is below
   threshold **and** no previously-populated required field becomes null. A new model that is worse
   on one bank's format regresses nothing.

Replay runs on charger + Wi-Fi + screen-off, chunked, resumable via `replay_runs.last_capture_id`,
and cancellable.

#### 5.4.1 Undo, and the trap inside it

`replay_runs.undo_deadline = started_at + 7 days`. Undo walks `transaction_events` where
`actor = 'replay:<run_id>' AND kind = 'FIELD_REVISED'` in reverse `seq` order and calls
`commitFieldValues` with each payload's `prev` value, `actor = 'system'`, emitting `REPLAY_UNDONE`.

The trap: **skip any field the user has touched since the replay.** If
`transaction_fields.observed_at` for that field is newer than the replay event's `occurred_at`, the
undo would restore a stale value over a human edit — precisely the failure the chokepoint exists to
prevent, arriving through the recovery path. Undo is a best-effort restoration, not a transaction
rollback, and the UI says so.

#### 5.4.2 Feeding a fine-tuned model back in

A fine-tuned FunctionGemma-270M is just a new registry entry: new `pipeline_rank`, new
`replay_runs` row, same shadow gate. The evaluation must not be run against the same corrections
that trained it — see the holdout split in §5.6.4. The metric that matters is computable locally
with no telemetry:

```sql
-- Correction rate per field per pipeline. This is the only "is the new model better" number
-- the app can honestly produce, and it needs no server.
SELECT er.pipeline_rank, c.field_path,
       COUNT(DISTINCT er.id)                                                   AS runs,
       SUM(CASE WHEN c.correction_kind <> 'accept_all' THEN 1 ELSE 0 END)      AS corrections
  FROM extraction_runs er
  LEFT JOIN corrections c ON c.run_id = er.id
 WHERE er.status = 'ok'
 GROUP BY 1, 2;
```

---

### 5.5 Consent

**Four** separate opt-ins. Collapsing them is the common mistake, and it produces an app that cannot
debug its own wrong numbers because the audit data was gated behind a training toggle.

| # | Purpose | Default | Granularity | Gate |
| --- | --- | --- | --- | --- |
| 1 | **Capture and store, with provenance** | implied by using the app | — | none |
| 2 | **Retain corrections for training** (`retain_for_training`) | **OFF** | per `source_channel` | `consent_grants` |
| 3 | **Export the corpus off-device** (`export_corpus`) | never a setting | per export | explicit action + summary screen |
| 4 | **Transmit anything off-device** (`transmit_offdevice`) | **OFF** | per destination host | `consent_grants` + the host typed explicitly |

**(1) is not a training consent.** The provenance and correction records are an *accuracy and
audit* mechanism — the answer to "why does this transaction say €47.20?" — and they must exist
regardless. Say this in the privacy copy. The alternative is an app that, when a user disputes a
number, has no record of where it came from.

**(2) is per-channel because sensitivity is per-channel.** A user may reasonably accept receipt
photos as training data and refuse bank SMS bodies. Default all OFF.

**(3) is never a background path.** The corpus export hands off through
`UIActivityViewController` / SAF and nothing else; the module-boundary rule in §5.7.1 makes
`src/export/` structurally incapable of importing an HTTP client.

**(4) exists because the absolute version of that sentence is no longer true, and pretending
otherwise is worse than admitting it.** This section previously said *"there must never be code in
this app that could become a background upload path"* while two v1 features are exactly that:

- **§6.4's WebDAV `PUT`**, fired **opportunistically on app foreground** when the last backup is
  stale, carrying a `.mmbak` whose `ledger.db` contains the whole `raw_captures` table — every
  retained bank SMS body. Note that §6.9's include toggles, which default raw bodies to **off**,
  govern CSV/JSONL export only; the `.mmbak` is complete by definition and carries them
  unconditionally. A user who deliberately turned that toggle off has been shipping the bodies to
  their NAS on every foreground for months.
- **Tier C hard-receipt escalation** to a user-configured OpenAI-compatible endpoint.

Both ship **before** sync, so §6.11's open question 7 — *"does pushing SMS-derived content to a
user-configured endpoint need explicit disclosure in the SMS permission declaration?"* — cannot be
answered "confirm before shipping sync". It must be answered before v1. R22's declaration argument
("no third-party recipient by construction") is a strong one and an *inaccurate* declaration is a
materially worse position than a disclosed flow. Four requirements follow:

1. `transmit_offdevice` gates both features, defaults off, and requires the destination host to be
   typed explicitly. The consent screen names what the artifact contains.
2. The automatic variant of the WebDAV push is **opt-in**; per-invocation is the default.
3. TLS required, redirects disabled, **no plaintext-HTTP fallback**.
4. `source_channel IN ('android_sms','android_notification_sms')` is **excluded from Tier C
   submission** unless separately enabled — the receipt-escalation use case that justifies Tier C
   never needs SMS text.

§5.7.1's grep test extends to `src/backup/` and `src/inference/remote/`, where it asserts the HTTP
client is reachable only through the module that reads the `transmit_offdevice` grant.

#### 5.5.1 `consent_grants` — append-only, so a consent claim is provable

```sql
-- NEW TABLE. Belongs in §3.11. Append-only: a revocation is a new row with granted = 0, never
-- an UPDATE. An UPDATE-in-place settings row cannot answer "the user says they never turned
-- this on" — and that is the only question this table exists to answer.
CREATE TABLE consent_grants (
  id            TEXT PRIMARY KEY,
  -- Pre-listed rather than minimal: this is a closed CHECK on an append-only table, and rule 7
  -- forbids the table rebuild that adding a value later would require.
  purpose       TEXT NOT NULL CHECK (purpose IN
                  ('retain_for_training','export_corpus','diagnostics_capture',
                   'transmit_offdevice','remote_inference')),
  -- a raw_captures.source_channel value, a destination host for transmit_offdevice,
  -- or '*' for all channels
  scope         TEXT NOT NULL,
  granted       INTEGER NOT NULL CHECK (granted IN (0,1)),
  -- WHICH CONSENT COPY THE USER ACTUALLY SAW. This is the column that makes the grant
  -- defensible; without it "the user agreed" is an unfalsifiable claim about a screen that
  -- has since been rewritten.
  ui_version    TEXT NOT NULL,
  device_locale TEXT,
  granted_at    INTEGER NOT NULL,
  -- diagnostics_capture is time-boxed (24 h) and self-expiring; NULL for the other purposes.
  -- capture_senders.diagnostics_until (§3.10.1) is the AUTHORITATIVE gate the producer reads
  -- before spooling; this column is the audit record of the grant that set it, and the two are
  -- written in one transaction.
  expires_at    INTEGER
) STRICT;

CREATE INDEX ix_consent_current ON consent_grants(purpose, scope, granted_at DESC);

CREATE TRIGGER trg_consent_grants_no_update
BEFORE UPDATE ON consent_grants
BEGIN SELECT RAISE(ROLLBACK, 'consent_grants is append-only: insert a new row'); END;

CREATE TRIGGER trg_consent_grants_no_delete
BEFORE DELETE ON consent_grants
WHEN (SELECT value FROM meta WHERE key = 'allow_hard_delete') IS NOT 'yes'
BEGIN SELECT RAISE(ROLLBACK, 'consent_grants is append-only'); END;
```

Current state is the latest row per `(purpose, scope)`; `'*'` is overridden by an explicit channel
row of the same or later `granted_at`.

#### 5.5.2 The snapshot rule — a floor and a ceiling, not one stamp

Two earlier statements of this rule contradicted each other and each permitted a real leak.
04-capture.md §4.4.1 had the producer write a capture-time `training_opt_in` into the spool
manifest; this section had it *"stamped at drain time from the then-current grant"*. The spool can
sit for days (§2.8.3 explicitly contemplates "spool written, app never opened"), so the two are not
the same fact:

- **Drain-time only** loses a revocation. Forty bank SMS spool over a weekend; on Monday the user
  opens the app, the drain runs before render (§2.14 step 9), and *then* they revoke. §5.5.3's
  re-arm covers that ordering — but the reverse does not self-heal: the user revokes, the drain
  runs seconds later, and forty captures are stamped `training_opt_in = 1` with
  `purge_after = NULL` **after** the user said no. `consent_grants` then faithfully records that
  they refused, which makes it evidence against the app rather than for it.
- **Capture-time only** loses the other direction. Consent is OFF on Saturday, the user enables it
  Monday for an unrelated channel or reason, and the Monday drain stamps the weekend's captures as
  opted in — retroactively relicensing exactly what this rule's own justification forbids.

**The normative rule takes both bounds:**

```text
raw_captures.training_opt_in = manifest.consent_snapshot AND current_grant_at_drain
```

`AND`, never `OR`. **The drain may only ever downgrade.** The capture-time snapshot — read by the
producer from `mirror/consent.v1.json` (04-capture §4.4.0), which is derived state and never the
authority — is a **ceiling** on what the capture may become; the grant in force at drain is a
second ceiling. The resulting value is stamped once and **never recomputed**, so a later toggle
still cannot relicense it in either direction, and turning training **on** still does not make
yesterday's captures eligible. The consent copy must say that plainly.

The manifest field is therefore an *input to a bound*, not the authority — which is what removes
the contradiction rather than merely picking a winner. `consent_grants` (§5.5.1) remains the sole
authority; the mirror exists only because the producer runs in a process that cannot open the
database, and it is rewritten by the drain on every app start (§4.4.0) so a restored phone cannot
capture under a stale grant.

Add the case to the §5.7.1 property test: spool N captures under consent, revoke, drain, and assert
every resulting row has `training_opt_in = 0` and a non-NULL `purge_after`; then spool N captures
under revocation, grant, drain, and assert the same.

#### 5.5.3 Revocation, stated exactly

Revoking `retain_for_training` for scope S is a transaction that does five things and deliberately
does not do a sixth:

```sql
BEGIN IMMEDIATE;
-- 1. record the revocation
INSERT INTO consent_grants (id, purpose, scope, granted, ui_version, granted_at)
  VALUES (:id, 'retain_for_training', :scope, 0, :ui_version, :now);

-- 2. the accumulated labels for that scope are DELETED, not merely stopped. "We will stop
--    collecting" is not what the user asked for.
DELETE FROM corrections
 WHERE raw_capture_id IN (SELECT id FROM raw_captures WHERE source_channel = :scope);

-- 3. re-arm retention on the captures that were purge-exempt because of the grant
UPDATE raw_captures
   SET training_opt_in = 0,
       purge_after = received_at + (:ttl_days * 86400000)
 WHERE source_channel = :scope AND training_opt_in = 1 AND purged_at IS NULL;

COMMIT;

-- 4. AFTER the commit, rewrite mirror/consent.v1.json (04-capture §4.4.0) so the NEXT capture is
--    stamped 0 at source rather than only being clamped at drain. write-tmp-then-rename, then
--    fsync the directory. This is outside the transaction because it is a filesystem write and
--    must not be able to roll the database back.
```

**No separate revocation watermark is needed, and one was considered and dropped.** Statement 1
inserts the `consent_grants` row inside this transaction, so `currentGrant(scope)` — which reads
the latest row per `(purpose, scope)` — already returns 0 for every subsequent reader, including a
drain that starts milliseconds later. §5.5.2's `AND` rule then clamps all forty spooled captures to
0 with no extra state. A `meta` watermark would be a second copy of a fact `consent_grants` already
holds, and the append-only table is the one that has to be authoritative because it is the one that
has to be *provable*. Statement 3 remains necessary for the opposite reason: it reaches rows that
already exist, which the `AND` rule at insert cannot.

**Not deleted:** `transaction_fields`, `transaction_events`, `extraction_runs` metadata,
`extracted_fields`, the ledger. Those are audit, not training. A user revoking training consent has
not asked to lose the ability to see why a number is what it is.

`corrections` is the one table the purge path normally preserves (it is tiny and it is the whole v2
dataset) — revocation is the single exception, and it is a hard `DELETE` rather than
`training_eligible = 0` because the user asked for removal, not for suppression.

The settings screen shows a live counter — *"1,284 corrections retained for improving extraction —
Delete all"* — because a consent toggle with no visible consequence is not informed consent.

---

### 5.6 Exporting the corpus, with no cloud service

#### 5.6.1 The label is the confirmed projection, not the diff

The obvious construction — take `extraction_runs.raw_output`, apply the `corrections` for that
run, emit the result — is **wrong**, and wrong in a way that produces silently corrupt labels.
`corrections.run_id` points at a specific run (rule C2). After a replay the capture has a *new*
current run with different output, and reducing an old run's diffs onto a new run's `raw_output`
produces a payload that was never a real value.

The correct construction:

```text
input  = raw_captures.payload_text                     (verbatim, never normalized)
label  = toFunctionCallPayload(txn)                    (the CONFIRMED state of the transaction)
weights, error analysis = corrections                  (never the label)
```

`old_value_json` is used **only** for error-distribution weighting and calibration. It is never the
label and never part of the emitted pair.

#### 5.6.2 `toFunctionCallPayload(txnId, schemaVersion, taxonomyVersion)`

A versioned pure function, checked in alongside the function-call schema. `transaction_fields` is
flat and internal (`amount`, `merchant_id`, `category_id`); the model's output space is the
function-call shape. The de-resolution rules are load-bearing:

| Internal | Emitted | Why |
| --- | --- | --- |
| `category_id` | `categories.canonical_key` | §3.4.2: the model **never** sees the display name. Names are localized and user-renamed; keys are stable tokens and are the constrained-decoding alternation. Emitting the name would train the model to produce a string it can never legally emit. |
| `merchant_id` | `merchants.canonical_name` | The model emits free text for merchant; the confirmed canonical name is the gold. |
| `amount_minor` + `currency_exponent` | decimal string, e.g. `"12.50"` | **Frozen contract:** the model emits a *decimal string* plus a separate ISO 4217 code, parsed to minor units by one validated function. A float in the grammar would reintroduce the representation bug at the model boundary. This must be fixed before v1 because the fine-tune is trained against it. |
| `booked_local_date` | `"YYYY-MM-DD"` | Local wall-clock date, matching what the receipt says. |
| `line_items` | array with `line_type` | Including `tax` / `tip` / `discount` rows — otherwise the model learns to sum `SUBTOTAL` as an item. |

The function asserts every emitted `canonical_key` exists in `taxonomy_keys` at the export's
`taxonomy_version`, and refuses to emit the row otherwise. A key that was retired between capture
and export is a mislabeled example, not a free one.

#### 5.6.3 The export query

**Join through `observations`, not through `transactions.primary_capture_id`.** Under merge a
transaction carries several observations and only one capture is `primary_capture_id`; joining on
it drops the SMS that confirmed a notification, and the receipt shared an hour later, even though
both have a perfectly good confirmed label. In an Android market with notification/SMS overlap that
is a large fraction of the corpus — and the *most* valuable fraction, because several different
message formats mapping to one confirmed transaction is exactly what SFT needs to see. One emitted
pair per `(capture, transaction)`:

```sql
SELECT rc.id AS capture_id, rc.payload_text, rc.source_channel, rc.source_app,
       er.model_id, er.prompt_version, er.schema_version, er.taxonomy_version,
       er.pipeline_rank, er.fields_shown_json,
       t.id  AS txn_id
  FROM observations    o
  JOIN raw_captures    rc ON rc.id = o.raw_capture_id
  JOIN transactions    t  ON t.id  = o.txn_id
  JOIN extraction_runs er ON er.id = o.extraction_id
 WHERE o.txn_id        IS NOT NULL
   AND o.extraction_id IS NOT NULL
   AND rc.training_opt_in = 1
   -- Diagnostics mode DISABLES the OTP/2FA negative lexicon for a sender for 24 h (§3.10.1), so
   -- its captures are the one population guaranteed to contain authentication codes. They are
   -- excluded by construction, not by the incidental absence of a corrections row. §5.8.2.
   AND rc.captured_under_diagnostics = 0
   AND rc.process_state NOT IN ('purged','ignored')
   AND rc.payload_text IS NOT NULL
   AND t.confirm_state IN ('confirmed','reconciled')
   AND t.disposition = 'active'
   AND t.deleted_at IS NULL
   -- VERSION GATE. Corrections harvested under a prompt you later rewrote are mislabeled for
   -- the new prompt. Ship the compatible set as data, not as a hardcoded literal.
   AND er.schema_version   =  :current_schema
   AND er.taxonomy_version =  :current_taxonomy
   AND er.prompt_version   IN (:compatible_prompt_versions)
   -- the training_eligible gate: every confirm writes an accept_all row, so this is exactly
   -- "went through the confirm sheet and its labels have not been invalidated by a purge"
   AND EXISTS (SELECT 1 FROM corrections c
                WHERE c.raw_capture_id = rc.id AND c.training_eligible = 1)
 ORDER BY t.id, rc.id;
```

#### 5.6.4 The emitted line, weighting, and the holdout split

One JSONL line per eligible capture — the shape the FunctionGemma Cookbook and Unsloth notebooks
already consume, so there is no conversion step:

```json
{"messages":[{"role":"user","content":"<payload_text>"},
             {"role":"assistant","content":"<toFunctionCallPayload(txn)>"}],
 "meta":{"capture_id":"018f…","txn_id":"018f…","source_channel":"android_sms","source_app":"BBVA",
         "prompt_version":"receipt.v7","schema_version":"expense.v3",
         "taxonomy_version":"cat:2026-08-01","model_id":"gemma-4-E2B-it","pipeline_rank":3,
         "corrected_fields":["/merchant","/category"],
         "unverified_fields":["/tax","/payment_method"],
         "was_fully_accepted":false,"label_weight":1.0,"split":"train"}}
```

`unverified_fields` = canonical set minus `fields_shown_json`. It is emitted rather than filtered
because the training script, not the app, should decide whether to mask them from the loss — but a
consumer that ignores it is training on labels no human ever looked at.

`label_weight` from `ui_surface` on the capture's `accept_all` row: `verify_carefully` 1.25,
`confirm_sheet` 1.0, `bulk_review` 0.6, `later_edit` 0.4. A later edit is a weaker signal than a
confirm-sheet edit because the user was reviewing a ledger, not an extraction.

**Holdout split keys on `txn_id`, not `capture_id`.** `split = 'holdout'` when `sha256(txn_id)`
mod 10 == 0. It must be the transaction because a merged transaction emits several captures with
**the same label** — key on the capture and the notification version lands in train while the SMS
version lands in holdout, which is a leak that makes the holdout score meaningless. Deterministic
so a transaction never migrates between splits across exports, which is what makes two fine-tunes
comparable. Emit `source_app` as well so the trainer can additionally hold out an entire bank and
measure generalization to an unseen message format — that is the number that actually predicts
field behaviour.

#### 5.6.5 The second file: hard negatives

The most valuable examples are the ones normally thrown away. `negatives.jsonl`:

- **Captures the model failed on.** `extraction_runs.status IN ('json_invalid','schema_invalid',
  'refused','partial')` whose capture nonetheless produced a confirmed transaction. Input plus the
  correct output, for the exact cases the current model cannot handle.
- **Genuine non-transactions from financial senders.** `raw_captures.process_state = 'ignored'`
  with a **retained** body (§3.10.1's exception for financial senders that fail the amount pattern),
  where the user confirmed it was not a transaction. This requires the function-call schema to have
  an explicit `not_financial` output branch: refusal must be a **trainable output**, not the absence
  of one. Freeze that branch before v1 along with the amount contract.

#### 5.6.6 Balance, pseudonymization, transport

**Class balance.** Cap per `(source_app, bank_templates.fingerprint)` at 200 (configurable),
sampling with preference for corrected over accepted, escalated/VLM runs over first-pass, and
distinct fingerprints over repeats. One chatty bank posting daily balance alerts will otherwise be
60% of the corpus.

**Pseudonymize format-preservingly, per export, with a fresh 32-byte salt held in memory only and
written nowhere.** Card tails → a different consistent tail, account numbers → same-length digit
strings, personal names → same-length plausible names, phone numbers → same-format numbers. Keep
merchant names, amounts, currency symbols and codes, date formats and the bank's template wording
**verbatim** — that *is* the signal. Replacing a card tail with `[REDACTED]` teaches the model a
token that never occurs at inference.

**Transport.** Build `corpus.jsonl` + `negatives.jsonl` + `manifest.json` in a temp directory
inside the app container; zip; encrypt with a passphrase the **user types** — never the database
DEK, which must not leave the Keychain/Keystore; hand off via `UIActivityViewController` (iOS) or
`ACTION_CREATE_DOCUMENT` (Android SAF); delete the temp directory. The user's own
Syncthing/Nextcloud/USB cable is the transport. Write the `training_exports` row on successful
handoff.

**The archive's KDF is the backup KDF, not a second invented one.** "Argon2id-derived" with no
parameters was the only statement here, while §6.1 owns a fully specified KDF and wrap format for
the same job. Reuse it verbatim — same `kdf_id`, same `m_kib` / `t` / `p`, same self-describing
header — and write the parameters into `manifest.json` so the archive is openable without this
app. Do **not** define a second parameter set: two KDFs for two user-typed passphrases is two
things to get wrong, and the training archive is the one that leaves the device most often.

**Because the passphrase is user-chosen here, an entropy floor is mandatory, not advisory.** Refuse
below zxcvbn score 4 / ≈70 bits estimated rather than warning; the archive's KDF parameters are
published in its manifest by necessity (the reader needs them), so the work factor is known to an
attacker and the attack is embarrassingly parallel on rented GPUs.

**Do not export below ~500 eligible pairs.** The export screen shows the count, the per-field
correction breakdown and the per-bank distribution, so the user is exporting a dataset rather than
a file — **and it states, in the same list, what is deliberately NOT pseudonymised**: merchant
names, amounts, currencies and symbols, dates and date formats, and the bank's exact template
wording. That verbatim signal is the whole reason format-preserving pseudonymisation was chosen
over redaction, and a user who sends the archive to a friend with a GPU has handed over every
merchant they have visited and every amount they have spent, in readable JSONL. Saying "the count,
the per-field correction breakdown and the per-bank distribution" and stopping there implies a
protection the archive does not provide.

**Reproducibility.** `training_exports` rows are the record that the archive existed;
`capture_ids_json` and `jsonl_sha256_hex` make a later differential export possible after captures
have been purged. Exports are **immutable snapshots stored outside the app**, and the fine-tune
concatenates snapshots rather than re-querying the device — otherwise a re-export after a purge
silently produces a smaller, differently-distributed dataset and the fine-tune is non-reproducible.

---

### 5.7 Enforcement — five layers, because none of this is a database constraint

#### 5.7.1 Architecture and tests

1. **Module boundary.** `src/repository/ledger/` exports `writeTransaction` and
   `commitFieldValues` and nothing else. The Drizzle schema module is not re-exported outside it.
2. **A test that greps.** Fails the build on
   `/UPDATE\s+(transactions|transaction_fields|entries)\s+SET/` anywhere outside
   `src/repository/ledger/`, and on any `import` of the HTTP client from `src/export/`,
   `src/capture/`, `src/extraction/` or `src/repository/` — the export path must be structurally
   incapable of growing into an upload path. `src/backup/` and `src/inference/remote/` are the two
   **named exceptions** (§5.5): there the client is reachable only through the module that reads
   the `transmit_offdevice` grant, and the test asserts that shape rather than absence.
3. **A dirty-column test.** Fails on any `UPDATE` touching more columns than were marked dirty
   (rule #8, §3.0).
4. **A property test.** Generate random orderings of (extract → correct → replay → merge →
   settlement → FX re-derive) and assert: a pinned user value is never lost, a `corrections` row is
   never written with `actor ≠ 'user'`, a split transaction's leg set is never reduced, and the
   consent floor of §5.5.2 holds under both spool orderings.
5. **A logging and crash-reporting policy, with a scrubber test.** No section of this design
   previously stated one, while §2.11.2 and §6.2.3 **interpolate the raw 67-character SQLCipher key
   into a SQL string by design** (`ATTACH … KEY "x'<64 hex>'"`), the programme commits to
   self-hosted GlitchTip, D18 justifies UUIDv7 partly because ids are *"readable in logs"*, and the
   extraction path holds bank SMS bodies, merchant names and amounts in memory throughout.
   `assertRawKey()` carries a `// NEVER log k` comment, which shows the authors were thinking about
   it in exactly one place. The rule:

   - a structured logger with a **field allowlist** (ids, enum states, counts, durations) and an
     explicit **denylist**: `payload_text`, `payload_meta_json`, `raw_output`, `merchant_raw`,
     `value_json`, `new_value_json`, `old_value_json`, any `*_amount_minor`, `rate_text`, media
     paths, and any string matching `/x'[0-9a-fA-F]{64}'/`;
   - one **scrubber**, applied at both the logger and the crash reporter's `beforeSend`, keyed on
     that hex pattern among others; `sendDefaultPii: false`; DB and network breadcrumbs disabled;
   - the `ATTACH` call sites wrapped so the raw statement can never reach an error path — catch,
     replace the key span, rethrow. **The migration-path `ATTACH` keys the snapshot with the DEK
     itself** (§6.8.2 step 5), so one unhandled failure there ships the live database key to the
     crash reporter, where it is stored, indexed and searchable next to the install id;
   - a CI gate grepping for `console.log` / raw logger calls in `src/capture/`, `src/extraction/`
     and `src/repository/`, plus a unit test asserting the scrubber redacts a key-bearing string.

#### 5.7.2 The one database backstop

Scoped deliberately narrowly, to the case that is *never* legal. The full replacement rule has an
equal-authority branch and a `pinned_at_authority` branch; encoding those in a trigger would mean
one false positive `RAISE(ROLLBACK)` aborting an entire replay chunk instead of skipping one row.
Ordering stays in JS where the shadow diff can log it.

```sql
-- NEW TRIGGER. Belongs in §3.19 group 2.
CREATE TRIGGER trg_transaction_fields_pin_guard
BEFORE UPDATE ON transaction_fields
WHEN OLD.pinned_by_user = 1
 AND NEW.value_source <> 'user'
 AND OLD.field IN ('category_id','merchant_label','note','tags',
                   'budget_id','exclude_from_reports','is_business')
BEGIN
  SELECT RAISE(ROLLBACK,
    'provenance: a pinned user-authoritative field may not be overwritten by a machine write');
END;
```

#### 5.7.3 Two additions to the startup integrity sweep (§3.21)

> **Numbering note.** These were originally proposed as I10 and I11. §3.21 has since allocated
> I10–I16 to seven other checks (header/leg tie, reporting allocation, oplog allowlist, aged
> unmatched transfer, stuck `clearing_state`, budget currency drift, `allow_hard_delete` left on),
> so these two are **I17 and I18**. §3.21 is authoritative for `check_id` allocation, and
> `integrity_findings.check_id` correctly no longer carries a closed `CHECK` — three reviewers
> independently proposed "add I12" for three different checks, which is precisely the collision a
> closed list turns into a table rebuild.

```sql
-- I17. Header/provenance drift. transaction_fields is the arbiter and transactions is the
--      projection; a disagreement means something wrote the header without going through
--      commitFieldValues().
SELECT t.id AS txn_id, 'amount' AS field
  FROM transactions t
  JOIN transaction_fields tf ON tf.txn_id = t.id AND tf.field = 'amount'
 WHERE t.deleted_at IS NULL
   AND CAST(json_extract(tf.value_json, '$') AS INTEGER) <> t.amount_minor
UNION ALL
SELECT t.id, 'currency'
  FROM transactions t
  JOIN transaction_fields tf ON tf.txn_id = t.id AND tf.field = 'currency'
 WHERE t.deleted_at IS NULL
   AND json_extract(tf.value_json, '$') <> t.currency_code;

-- I18. A field value with no event behind it. Every accepted write appends a transaction_events
--      row, so a transaction_fields row on a transaction with no value-bearing event at all is
--      a write that bypassed the chokepoint entirely.
SELECT tf.txn_id, tf.field
  FROM transaction_fields tf
 WHERE NOT EXISTS (
   SELECT 1 FROM transaction_events te
    WHERE te.txn_id = tf.txn_id
      AND te.kind IN ('CREATED','FIELD_REVISED','AMOUNT_ASSERTED',
                      'USER_VALUE_SUPERSEDED','REPLAY_APPLIED'));
```

Sweep check **I7** (§3.21) already covers the other half — training labels whose input was purged —
and it should always return zero rows. Non-empty means the purge path skipped a statement.

---

### 5.8 Retention and purge

#### 5.8.1 What actually costs anything

Text captures are 150–300 bytes. Thirty a day for ten years is ~33 MB — **keep them forever, no
policy needed.** The corpus that trains v2 is essentially free. Images and audio are the entire
storage question: a 12 MP HEIC receipt is 2–4 MB, downscaled at drain time to 1600 px long edge at
JPEG q0.7 it is ~200–350 KB. That ~10× reduction dwarfs any storage-layout decision, and it happens
in the **main app**, never in the iOS Share Extension (~120 MB ceiling; decoding a portrait photo
there is what kills it).

#### 5.8.2 `retention_policies`

```sql
-- NEW TABLE. Belongs in §3.11. User-visible and user-adjustable — retention on the sole system
-- of record is a product decision, not a constant.
CREATE TABLE retention_policies (
  scope      TEXT PRIMARY KEY CHECK (scope IN (
               'notification_text','sms_text','receipt_image','screenshot',
               'voice_audio','voice_transcript','statement_pdf','ocr_text',
               'model_raw_output','oplog','match_decisions',
               'diagnostics_capture',    -- §5.8.2: OTP-bearing by construction, own TTL
               'spool_quarantine')),     -- §4.4.1: unopenable sealed records are not evidence
  ttl_days   INTEGER CHECK (ttl_days IS NULL OR ttl_days >= 0),   -- NULL = keep forever
  max_bytes  INTEGER,                                             -- oldest-first eviction above this
  max_rows   INTEGER,
  user_set   INTEGER NOT NULL DEFAULT 0 CHECK (user_set IN (0,1)),
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
```

Defaults, each with the reason it is what it is:

| Scope | Default | Reason |
| --- | --- | --- |
| `notification_text`, `sms_text` | 30 days | Highest volume **and** highest sensitivity. Overridden to "forever" by `training_opt_in = 1`. **Never applies to a capture that has not yet been acted on** — see the eligibility predicate in §5.8.3. |
| `diagnostics_capture` | **`diagnostics_until`, full stop** — the 24 h window's own end | Diagnostics mode is the switch that turns the OTP/2FA negative lexicon **off** for a sender (§3.10.1), so its captures are the one population guaranteed to contain login OTPs and 3-D Secure codes. Nothing in the earlier design gave them a shorter TTL, a distinct tag, or export exclusion: with `retain_for_training` on for `android_sms` — plausible for a user who wants better extraction from their bank — D104 set `purge_after = NULL` and the OTP bodies became **exempt from retention forever**, shipped in every `.mmbak` and pushed to the WebDAV endpoint on every foreground. So: a capture spooled while `diagnostics_until > now` is force-stamped `training_opt_in = 0` **overriding any grant**, `captured_under_diagnostics = 1`, and `purge_after = diagnostics_until`; a sweep purges lapsed diagnostics captures on the first foreground after the window. The diagnostics consent screen must state that it disables the OTP filter for that sender. |
| `receipt_image` | **until `confirm_state IN ('confirmed','reconciled')` plus `grace_days` (30)**, then 180 days **or** 1 GB oldest-first, whichever bites first | Reconciles the flat 180-day TTL stated here with D106's *"kept until confirmed plus a grace window"* — they were two different policies and the flat one deletes the original of a receipt whose capture is still unextracted, which is the same bug as the notification case from the other direction. The size cap is the honest control for the confirmed population; a pure TTL surprises heavy users. |
| `spool_quarantine` | 90 days or 200 files | §4.4.1: a sealed record that will not open is a permanent loss recorded as a `capture_gaps` row, not evidence to keep forever. Retaining it indefinitely both grows without bound and makes the retention promise false, because the file is a full verbatim manifest the §5.8.3 purge never reaches. |
| `screenshot` | 30 days | Transient by nature; the OCR text is the durable artifact. |
| `voice_audio` | deleted immediately after transcription (7 days if `training_opt_in`) | The transcript is the useful part; raw voice is the most sensitive thing the app ever holds. |
| `voice_transcript`, `ocr_text` | follows the parent media | They are the same content in another form. Purging one and not the other is theatre. |
| `statement_pdf` | 365 days | Reconciliation needs it across a fiscal year. |
| `model_raw_output` | follows the capture | It is a verbatim echo of the capture. See §5.8.3. |
| `oplog` | 90 days or 200k rows, whichever is larger | Fastest-growing table; three uses with different natural retentions, so the policy is explicit rather than emergent. |
| `match_decisions` | 365 days | The local dataset for tuning dedupe thresholds; useless once `algo_version` has moved on twice. |
| `corrections`, `transaction_fields`, `transaction_events`, `extraction_runs` metadata, `fx_rates`, the ledger | **never purged** | Audit and the v2 dataset. Tiny relative to media. |

#### 5.8.3 The purge, in full — eligibility, then the transaction

> **Schema reconciliation note —** §3.10 presents the purge as "exactly" two statements
> (`payload_text = NULL` + `training_eligible = 0`). That is incomplete in **five** ways and two of
> them mean the purge does not purge. Three are database columns it never touches:
> `raw_captures.payload_meta_json` holds the notification extras keyed by their `android.*` names —
> `android.text`, `android.bigText`, `android.textLines` — i.e. **the message body**;
> `extraction_runs.raw_output` is the model's verbatim echo of that body; and
> `extracted_fields.span_start/span_end` become offsets into a string that no longer exists. The
> fourth is `oplog`, a different table entirely, holding a per-column before/after of the very
> insert that created the capture. The fifth is not in the database at all: the sealed spool
> record, which §4.4.2 now unlinks at drain so it cannot outlive the row. And **it has no
> eligibility precondition**, which is worse than any of them — see §5.8.3a.
>
> The version below is the one to implement, and §3.10 should be reconciled to it. It uses
> `media_assets.original_deleted_at` rather than `missing_since` (which means "the file vanished
> and we don't know why" and is what sweep check I6 alarms on — a deliberate purge must not fire
> it), and it keeps `raw_captures.media_asset_id` populated, because the whole point of
> redact-in-place is that the audit chain survives.

#### 5.8.3a Eligibility — the precondition the purge did not have

The purge was keyed on `:capture_id` alone, selected by
`ix_raw_captures_purge ON raw_captures(purge_after) WHERE purged_at IS NULL`. **`purge_after`
elapsing is not sufficient**, because `deferred_no_model` is explicitly a normal, indefinitely
parked state (§4.4.3: the model may not be downloaded on first run, may have been deleted to free
space, or may have OOMed on a 4 GB device). A user who declines the 3.66 GB download on mobile data
accumulates 20 bank alerts a day as `deferred_no_model`; they show correctly in `v_review_inbox` as
*"600 alerts we couldn't read yet"*; and on day 31 the purge NULLs all 600 bodies and sets
`process_state = 'purged'` — which is **not** in the inbox's capture branch, so the backlog the
user was waiting for Wi-Fi to process **drops from 600 to 0 overnight and reads as success**. The
notification-sourced majority has no retroactive source (§7.1.1) and is gone permanently, with no
`capture_gaps` row because the listener never went down.

```sql
-- A capture is purge-eligible ONLY when the user has had the chance to act on it.
SELECT rc.id
  FROM raw_captures rc
 WHERE rc.purged_at IS NULL
   AND rc.purge_after IS NOT NULL AND rc.purge_after < :now
   -- (a) it reached a terminal, acted-upon state. 'deferred_no_model', 'queued', 'in_flight'
   --     and 'unparseable' are all "we have not managed to read this yet".
   AND rc.process_state IN ('parsed','ignored','redacted')
   -- (b) nothing downstream is still waiting on it
   AND NOT EXISTS (SELECT 1 FROM observations o JOIN transactions t ON t.id = o.txn_id
                    WHERE o.raw_capture_id = rc.id
                      AND t.confirm_state IN ('extracted','needs_review'))
   AND NOT EXISTS (SELECT 1 FROM field_conflicts fc JOIN observations o2 ON o2.txn_id = fc.txn_id
                    WHERE o2.raw_capture_id = rc.id AND fc.status = 'open')
   AND NOT EXISTS (SELECT 1 FROM balance_breaks bb
                    WHERE bb.status = 'open'
                      AND (bb.from_obs_id IN (SELECT id FROM observations WHERE raw_capture_id = rc.id)
                        OR bb.to_obs_id   IN (SELECT id FROM observations WHERE raw_capture_id = rc.id)))
 ORDER BY rc.purge_after
 LIMIT 200;
```

Two consequences, both required so the fix cannot fail silently in the other direction:

- **`v_review_inbox` gains a `'purged'` branch** (§3.20; reconciled in 04-capture §4.17) with the distinct reason
  `purged_before_extraction`, so an item can never leave the inbox merely by expiring.
- **A hard cap replaces the silence.** If the eligible set is empty but `purge_after` has elapsed
  on N captures, surface *"N captures are past their retention window but have not been
  processed"* — neither purging them nor saying nothing. That is the honest statement of a
  retention policy that cannot run because the app cannot read the data.

The identical predicate applies to `receipt_image` (§5.8.2): deleting the original of a receipt
whose capture is still unextracted is the same bug.

#### 5.8.3b The transaction

```sql
BEGIN IMMEDIATE;

-- 1. the capture body, BOTH halves. NULLing payload_text alone purges nothing.
UPDATE raw_captures
   SET payload_text      = NULL,
       payload_meta_json = json_object(              -- keep only non-content metadata
         'template',   json_extract(payload_meta_json, '$.template'),
         'sim_sub_id', json_extract(payload_meta_json, '$.sim_sub_id'),
         'sender_kind',json_extract(payload_meta_json, '$.sender_kind')),
       process_state     = 'purged',
       purged_at         = :now
 WHERE id = :capture_id;

-- 2. the model's verbatim echo of that body
UPDATE extraction_runs
   SET raw_output = NULL
 WHERE raw_capture_id = :capture_id;

-- 3. extracted values and their now-dangling spans. Confidence, field_path and the run identity
--    survive: those are calibration data and contain no content.
UPDATE extracted_fields
   SET value_json = NULL, span_start = NULL, span_end = NULL
 WHERE run_id IN (SELECT id FROM extraction_runs WHERE raw_capture_id = :capture_id);

-- 4. THE STATEMENT EVERYONE FORGETS. A corrections row is only a training example if its INPUT
--    still exists. Purge the text, keep the label, and the dataset silently rots — the export
--    then emits an orphaned label and the fine-tune is trained on a prompt that is gone.
UPDATE corrections
   SET training_eligible = 0
 WHERE raw_capture_id = :capture_id;

-- 5. media: a DELIBERATE deletion, distinct from a missing file.
UPDATE media_assets
   SET original_deleted_at = :now
 WHERE id = (SELECT media_asset_id FROM raw_captures WHERE id = :capture_id)
   AND original_deleted_at IS NULL;

-- 6. THE OTHER STATEMENT EVERYONE FORGETS: oplog. The drain inserts raw_captures through the
--    §3.18 repository chokepoint, which writes ONE OPLOG ROW PER COLUMN — so oplog holds
--      ('raw_captures', <id>, 'payload_text', NULL, '"Compra por MXN 480.00 en LA DOCENA…"')
--    for every capture ever ingested. Statements 1-5 redact the columns and leave that intact
--    for 90 days OR 200k rows, WHICHEVER IS LARGER (D118) — for a light iOS user, years. It is
--    copied into every .mmbak, and §6.7.1 designates oplog as THE SYNC PAYLOAD, so under the
--    v1.5 relay every purged message body is transmitted to the sync server. §5.9's stated guard
--    ("the amount-regex over every purged ROW's remaining columns") structurally cannot see it.
DELETE FROM oplog
 WHERE table_name = 'raw_captures'    AND row_id = :capture_id;
DELETE FROM oplog
 WHERE table_name = 'extraction_runs'
   AND row_id IN (SELECT id FROM extraction_runs WHERE raw_capture_id = :capture_id);

COMMIT;

-- 7. only now, outside the transaction, unlink the media file AND any retained spool copy.
--    DB first, deliberately: a row pointing at a deleted file is benign and self-heals via the
--    weekly reconciliation; a committed deletion with the file still on disk would leave the
--    exact bytes the purge existed to remove.
--    §4.4.2 unlinks the spool record at drain, so in the normal path there is nothing here; this
--    step exists so that any future "keep processed records for debugging" option cannot
--    reintroduce a filesystem copy the purge does not reach.
```

**`oplog` needs a column allowlist, not just this DELETE.** Content columns must never enter it in
the first place: `oplog` records ledger and provenance mutations only, and **never**
`raw_captures.payload_text`, `raw_captures.payload_meta_json`, `extraction_runs.raw_output`,
`extracted_fields.value_json` or `media_assets.rel_path`. `raw_captures` and `extraction_runs` are
already append-only with their own audit story, so oplog adds nothing for them — the cleanest form
of the rule is to exclude both tables entirely and keep the DELETEs above as a belt for rows
written before the allowlist landed. Sweep check **I12** (§3.21) flags any `oplog` row
whose `(table_name, column_name)` falls outside the allowlist, and gate **G-20** extends to run the
amount/message regex over `oplog` after a purge and assert zero matches.

`training_opt_in = 1` sets `purge_after = NULL` — **except for a capture with
`captured_under_diagnostics = 1`, where the grant is overridden and `purge_after = diagnostics_until`
regardless** (§5.8.2). The consent copy must literally say *"these stay on your device until you
turn this off"* for the ordinary case, and the diagnostics screen must say the opposite for its
own: *"anything captured in the next 24 hours is deleted when the window closes, and is never used
for training."*

#### 5.8.4 Scheduling

The purge job runs on app foreground when the §5.8.3a eligibility query returns rows, batched at
200 captures per pass so it never blocks a cold start, followed by `PRAGMA incremental_vacuum(N)`
with N capped. It is deliberately **not** scheduled on `BGTaskScheduler` alone: iOS background
tasks are best-effort and a retention promise the user believes is running but isn't is worse than
an honest "runs when you open the app".

Two passes run alongside it on the same trigger:

- **Lapsed diagnostics.** Any capture with `captured_under_diagnostics = 1` and
  `purge_after < now` is purged on the **first foreground after the window closes**, ahead of the
  ordinary batch. These are the only captures the app holds that are known to contain
  authentication codes; they do not queue behind 200 bank alerts.
- **Spool quarantine.** Enforce `CFG.spool.quarantineMaxItems` / `quarantineMaxAgeMs` (§4.4.1),
  oldest-first. The corresponding `capture_gaps` rows are **not** deleted with the files — the loss
  record outlives the unopenable bytes.

The Retention screen shows the last successful pass, the count pending, **and the count that is
past its window but ineligible** (§5.8.3a) — a retention policy that cannot run must say so rather
than reporting zero.

---

### 5.9 Failure modes and the guard for each

| Failure | Guard |
| --- | --- |
| A replay silently overwrites a user's corrected amount | `commitFieldValues` decision function + `pinned_by_user` + `trg_transaction_fields_pin_guard` + sweep I18 |
| A replay of **the very message the user was correcting** reverts the correction, because an ordinary confirm-sheet edit was written unpinned at authority 20 and any later machine write at 40/50/60 outranks it | **§5.3.2 step 6 auto-pins every user write** and records `pinned_at_authority = cur.authority_rank`, so a re-parse at equal authority hits `REJECT_PINNED` while a settlement or statement still supersedes loudly; §3.11.5's predicate widened to exclude **any** pinned field |
| A machine silently reverses a user's merchant or date — the two fields users correct most, and the two the divergence test did not cover | §5.3.2 step 5 extended to non-numeric bank-authoritative fields: reversing a prior `value_source = 'user'` value is a `field_conflicts` row, never a precedence question |
| Two incompatible `value_source_rank` formulas in two sections, both plausible-looking integers, giving opposite answers on the case that matters | One composite formula in §5.2.2; 04-capture §4.5.1 contributes only the channel-precedence table. Shipped **together with** the step-6 auto-pin, without which the formula makes §4.5.1's failure mode unconditional |
| A settlement or a money-bearing edit silently un-splits a receipt the user split across categories, and every sweep still passes | `rewriteLegs()` re-scales rather than rebuilds (§4.9.1); `category_id` on a split is `REJECT_SPLIT` (§5.3.1); `line_items.entry_id` → `ON DELETE RESTRICT`; sweep I10 compares the leg sum to `effective_amount_minor` |
| The corpus is poisoned by machine-written "corrections", so the next fine-tune trains on the previous model's output | **Rule C1**: a `corrections` row iff `actor === 'user'`; property test asserts it |
| "Accepted" labels the user never actually saw | `fields_shown_json`; `unverified_fields` in the export meta; the `fields_shown` filter in the calibration query |
| Purge leaves the message body in `payload_meta_json` | The full purge transaction (§5.8.3b) plus a test that runs the amount-regex over every purged row's remaining columns and asserts zero matches |
| Purge leaves the verbatim body in **`oplog`** — a different table, so the "purged row's remaining columns" test cannot see it — for 90 days *or* 200k rows *whichever is larger*, inside every `.mmbak`, and (§6.7.1) as the v1.5 sync payload | §5.8.3b statement 6 + the `oplog` column allowlist + sweep I12 + G-20 extended to run the regex over `oplog` |
| Purge leaves the verbatim body in **`spool/processed/`**, which no purge statement and no database test can reach | §4.4.2 unlinks the spool record after commit instead of archiving it; §5.8.3b step 7 is the belt; §5.9's verification test gains a filesystem arm over `spool/` |
| The purge nulls captures the user was **still waiting to read** — 600 `deferred_no_model` alerts vanish from the inbox overnight and read as success | §5.8.3a's eligibility predicate (`process_state IN ('parsed','ignored','redacted')` and nothing downstream open) + the `'purged'` branch in `v_review_inbox` + the "N past their window, unprocessed" surface |
| Diagnostics mode disables the OTP lexicon and its captures are then retained **forever** under a training grant, shipped in every backup | §5.8.2: force `training_opt_in = 0`, `captured_under_diagnostics = 1`, `purge_after = diagnostics_until`; excluded from §5.6.3 by construction; G-19 extended to the diagnostics path |
| A revocation issued seconds before the drain is undone by it | §5.5.3 statement 4's `meta` watermark + §5.5.2's `AND` rule: the drain may only downgrade |
| The 67-character SQLCipher key reaches the crash reporter through an `ATTACH` failure — and on the migration path that key is the **DEK** | §5.7.1 rule 5: field allowlist, `beforeSend` scrubber keyed on `/x'[0-9a-fA-F]{64}'/`, breadcrumbs off, `ATTACH` call sites wrapped |
| The app transmits SMS-derived content to a user-typed URL unattended, while the Play declaration says there is no third-party recipient by construction | §5.5 opt-in 4 `transmit_offdevice`: per-host grant, per-invocation by default, TLS-only, SMS channels excluded from Tier C; §6.11 question 7 promoted to a v1 blocker |
| Training label reconstructed from a stale run's `raw_output` + diffs | Label = `toFunctionCallPayload(txn)` from the confirmed projection; `corrections` used only for weighting |
| Label emits a category display name instead of the canonical key | `toFunctionCallPayload` de-resolves `category_id → canonical_key` and asserts membership in `taxonomy_keys` at the export's `taxonomy_version` |
| Amount emitted as a float in the function-call grammar | Frozen contract: decimal string + ISO code, one validated parser. Fixed **before** v1, because the fine-tune is trained against it |
| Re-export after a purge produces a different, smaller dataset | `training_exports` immutable snapshots + `capture_ids_json`; the fine-tune concatenates snapshots |
| A consent claim cannot be substantiated | `consent_grants` append-only with `ui_version`; revocation is a row, not an `UPDATE` |
| Turning training on retroactively relicenses old captures, **or** a revocation is undone by the very next drain | `raw_captures.training_opt_in = capture-time hint AND drain-time grant`, stamped once and never recomputed (§5.5.2) |
| The model file was silently swapped or partially downloaded | `extraction_runs.model_sha256_hex` |
| Confidence shown to the user as a percentage, implying calibration that does not exist | Confidence is routing-only by rule; the calibration query is the only thing permitted to turn it into a claim |
| The export path grows a network client | Module-boundary test forbidding an HTTP-client import from `src/export/`, `src/capture/`, `src/extraction/` and `src/repository/`; `src/backup/` and `src/inference/remote/` are named exceptions gated on `transmit_offdevice` |
| One chatty bank dominates the corpus | Per-`(source_app, fingerprint)` cap at export time |
| Merged captures silently dropped from the corpus, losing exactly the multi-format examples SFT most needs | Export joins through `observations`, not `transactions.primary_capture_id` |
| Holdout leak: the notification and the SMS for one merged transaction land on opposite sides of the split with the same label | Split keys on `sha256(txn_id) mod 10`, never on `capture_id` |
| Evaluating a fine-tune on the corrections that trained it | Deterministic `sha256(txn_id) mod 10` holdout, stable across exports; plus leave-one-bank-out via `source_app` |
| Two `extraction_runs` both claiming `is_current = 1` for a capture, making `primary_extraction_id` and the replay predicate ambiguous | The writer clears its predecessor in the same transaction; `ux_extraction_current` partial unique index (§5.2.5) |

---

### 5.10 Schema reconciliation with §3

The tables introduced by this section (`consent_grants`, `retention_policies`) carry their DDL
inline above and belong in §3.11 as written. What follows is what §5 needs **changed** in §3.
Several items have since landed there; this is the reconciliation, disjoint from 04-capture §4.17's
table.

**Already landed in §3 — no action, recorded so it cannot re-diverge:**

- `integrity_findings.check_id` has **no closed `CHECK`** (§3.21). §5.7.3's checks are therefore
  **I17** and **I18**, since §3.21 allocated I10–I16 to other checks.
- `transaction_fields.authority_rank` has no closed `CHECK` (§3.11.4), so a new authority tier no
  longer needs a table rebuild.
- `raw_captures.training_opt_in` is documented in §3.10 as `hint AND grant`, matching §5.5.2.
- Sweep **I12** (§3.21) already checks the `oplog` content allowlist.

**Still outstanding:**

```sql
-- ── §3.11.4 transaction_fields: value_source_rank now carries a CHANNEL term (§5.2.2). The type
--    is unchanged, the MEANING is not — a value written under either of the two old formulas is
--    not comparable with one written under the composite, and a migration cannot recompute it
--    (the channel lives on the observation, which may be NULL). Record the composition in the
--    column comment so a reader cannot infer the old formula from the name:
--      value_source_rank = channel_precedence * 100000 + ENGINE_BASE * 100 + min(pipeline_rank,99)
--    Pre-v1 there are no stored rows, so no backfill question arises; after v1 there would be,
--    which is why this must land before the first release rather than after.

-- ── §3.11.1 extraction_runs: exactly one current run per capture (§5.2.5).
CREATE UNIQUE INDEX ux_extraction_current
  ON extraction_runs(raw_capture_id) WHERE is_current = 1;
--    Legal only because the OCR->text->VLM ladder runs inside one transaction and every insert
--    clears its predecessor in the same statement batch. VERIFY against the real escalation
--    implementation first: if a text run and an image run over one receipt photo are ever
--    legitimately current at the same time, this index is wrong and the guard must become a
--    sweep check instead. That single question is the whole discriminator.

-- ── §3.18 oplog: the COLUMN ALLOWLIST itself, not just I12 which detects violations of it.
--    Enforced in the repository chokepoint: oplog records ledger and provenance mutations only,
--    and never raw_captures or extraction_runs at all — both are already append-only with their
--    own audit story, so oplog adds nothing for them and adds a years-long verbatim copy of every
--    bank message that outlives the retention purge, ships in every .mmbak, and is designated the
--    v1.5 sync payload. Also never extracted_fields.value_json or media_assets.rel_path. §5.8.3b.

-- ── §3.19 group 2: the pin guard (§5.7.2) as written, plus a coherence guard for the balance
--    triple §3.10.2 now carries. (§3.19 already validates balance_exponent against currencies;
--    this is the presence half.)
CREATE TRIGGER trg_observations_balance_currency
BEFORE INSERT ON observations
WHEN NEW.balance_after_minor IS NOT NULL AND NEW.balance_currency_code IS NULL
BEGIN
  SELECT RAISE(ROLLBACK,
    'observations: balance_after_minor requires balance_currency_code (§4.13.4)');
END;

-- ── §3.11.5 replay selection predicate: widen the pin exclusion from four named fields to ANY
--    pinned field, per §5.3.2 step 6's auto-pin. With the auto-pin in place the four-field list
--    would hand every corrected-merchant transaction back to the replay and rely on the decision
--    function alone to save it — a second line of defence doing the job of the first.
   AND NOT EXISTS (SELECT 1 FROM transaction_fields tf
                    WHERE tf.txn_id = t.id AND tf.pinned_by_user = 1)
```

> **The closed-`CHECK` problem is systemic, not local to any one list.** Every closed
> `CHECK … IN (…)` on an append-only or diagnostic table is a future table rebuild that D109
> forbids, executed against an encrypted multi-hundred-megabyte file on a phone — and, because the
> drain and the purge run inside `BEGIN IMMEDIATE` under D40's `RAISE(ROLLBACK)` convention, a
> constraint failure aborts the whole batch rather than one row. `integrity_findings.check_id`,
> `transaction_fields.authority_rank`, `capture_gaps.cause`, `raw_captures.process_state` and
> `capture_senders.channel` are settled. The two remaining in this section are
> `consent_grants.purpose` and `retention_policies.scope`, both pre-listed above with headroom
> rather than dropped, because unlike the others they are small closed vocabularies the product
> owns rather than open diagnostic taxonomies. Add a schema-lint gate
> alongside G-2…G-6 that fails the build on any **new** closed `CHECK … IN` list on such a table.
