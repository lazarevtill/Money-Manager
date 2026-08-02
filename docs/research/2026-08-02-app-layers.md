# On-device AI expense manager — final layered architecture

Date: 2026-08-02 · Supersedes: nothing (first architecture doc) · Companion research: `docs/research/2026-08-02-on-device-ai-stack.md`

**Status legend.** **[VERIFIED]** = read from the primary artifact (vendor doc, source file, registry) by this pass or a named prior pass. **[VERIFIED symbol / UNVERIFIED behaviour]** = the API exists in the shipped public header; nothing is known about what it does at runtime. **[REPORTED]** = secondary source or an open third-party bug report, not reproduced. **[INFERRED]** = reasoning from the above, no direct source.

**Section numbers in this document are local.** Where a finding cites "§9c", it means the research doc, not this one.

**Note on today's verification budget.** This pass read `google-ai-edge/LiteRT-LM` release metadata and the full public C header `c/engine.h` directly, plus the npm registry for the runtime pins. Web *search* budget was exhausted before this pass began, so store-policy and Apple/Google documentation claims are carried at the evidence level assigned by the reviewers who read them. Every one of those is re-verification-gated in §13b before it can block a release.

---

## 0. Executive summary

Nine things a reader needs before anything else.

1. **The plan as reviewed is roughly two to three times what 2–4 people can deliver.** This is not a framing problem; it is a headcount problem. §16 cuts it. The headline cut: **v1 ships Android-first with the full locked engine; iOS v1 ships extraction on Apple Foundation Models plus OCR plus manual entry plus the share-sheet path, and does not carry LiteRT-LM.**

2. **That iOS recommendation is a real change to the locked engine decision on one platform, and it needs a decision-owner's yes or no — it is not a schedule tweak.** The reason is in §3: the iOS Swift binding is ten weeks old, three open upstream issues form a trilemma with no known-good pin, and digit corruption on the Metal backend attacks precisely the two fields (amount, date) that a finance app cannot get wrong. The honest cost of the contingency, which the reviewers glossed: **Apple Foundation Models has an A17 Pro floor — iPhone 15 Pro and newer.** In LATAM that is a small share of iOS, which is itself the minority platform. So the iOS contingency is **partial coverage, not equivalent coverage**: below A17 Pro, iOS v1 is document-scanner + Vision OCR + deterministic parsing + manual entry, with no LLM extraction at all.

3. **The engine contract is schema-constrained JSON, not tool calling.** Tool calling is reported broken on both platforms in exactly the versions we target, and it is the newest feature in the newest release. The C header we bind exposes `litert_lm_conversation_config_set_enable_constrained_decoding`, `..._set_constraint_provider` and `litert_lm_conversation_optional_args_set_constraint` **[VERIFIED symbol / UNVERIFIED behaviour — `c/engine.h`, read 2026-08-02]**, so constrained decoding is a first-class path in the same API, not a downgrade. Apple `@Generable` and llama.cpp GBNF both produce the same validated object. Tool calling becomes an optional transport that some adapters may use.

4. **The 3.66 GB model is a third independently-versioned artifact** alongside native code and the JS bundle, and it ships through **iOS On-Demand Resources and Play Asset Delivery**, not a self-hosted CDN. Both readings of the no-cloud constraint converge on this (§10). One consequence chain worth stating twice: **PAD → Play downloads in its own process → no foreground service → no FGS type declaration → no Play demo video.** One decision deletes three obligations.

5. **Everything captured is attacker-supplied.** Bank SMS and push bodies reach the model without the user opening the app. Untrusted-content delimiting, hard per-field caps, output sanitisation, and an unknown-sender trust tier are §4/§5 requirements, not hardening.

6. **The app's code matches Play's spyware signature unless it is shaped to prove otherwise.** Filter before persistence, never forward captured message text to a user endpoint, never execute a remote-returned tool call, and write the "why this is not spyware" memo in week one (§5, §11).

7. **Nothing in the plan can see the field.** No accuracy counters, no support diagnostics, no remediation channel. §9 adds a local metrics ledger, a user-initiated diagnostic bundle, a local circuit breaker, and a signed remediation manifest. The circuit breaker is the highest-value item in this document per line of code.

8. **Tier C (user-owned self-hosted endpoint) is deferred out of v1.** That deletes an App Store 5.1.2(i) consent surface, both stores' "data collected" declarations, the Local Network prompt work, the ATS question, and the strongest single input to a spyware/backdoor reading. Its only unique value — hard-receipt escalation — is partly covered by the on-device VLM path.

9. **Self-hosted OTA is deleted from v1.** The app's risk surface is native; OTA ships only JS. The one legitimate OTA use case, bank-template rot, is served far more cheaply by a signed static JSON data channel (§9.4) that also carries the remediation manifest.

---

## 1. Layer map

```text
┌── L0  CAPTURE ─────────────────────────────────────────────────────────────┐
│ Android: NotificationListenerService (allowlist-first) → [v1.4] READ_SMS   │
│ iOS:     Share Sheet · Shortcuts/App Intents · screenshot OCR · camera     │
│ Both:    document scanner · voice · typed text · "Try a sample" fixtures   │
│ Guards:  trust tier · capture-health monitor · idempotency key             │
└───────────────────────────────┬────────────────────────────────────────────┘
┌── L1  NORMALISE ──────────────▼────────────────────────────────────────────┐
│ untrusted-content envelope · length caps · deterministic bank templates    │
│ (signed data pack) · OCR (Vision / ML Kit) · per-source exemplars          │
└───────────────────────────────┬────────────────────────────────────────────┘
┌── L2  EXTRACT ────────────────▼────────────────────────────────────────────┐
│ ExtractionEngine interface → schema-constrained JSON (Zod-validated)       │
│ adapters: LiteRT-LM(Gemma 4) · AppleFoundationModels · llama.rn(contingency)│
│ per-call: stack_id · confidence proxies · digit-exactness invariants       │
└───────────────────────────────┬────────────────────────────────────────────┘
┌── L3  RECONCILE ──────────────▼────────────────────────────────────────────┐
│ money normaliser (locale grammar → ISO-4217 minor units) · currency        │
│ resolution ladder · date resolution · sanitiser · ALWAYS-editable confirm  │
└───────────────────────────────┬────────────────────────────────────────────┘
┌── L4  PERSIST  (owned by the data-layer workstream — interface only, §2.5) │
└───────────────────────────────┬────────────────────────────────────────────┘
┌── L5  CROSS-CUTTING ──────────▼────────────────────────────────────────────┐
│ model asset lifecycle (§7) · metrics ledger + diagnostics (§9) ·           │
│ circuit breaker + remediation manifest (§9) · entitlement seam (§12)       │
└────────────────────────────────────────────────────────────────────────────┘
```

Two invariants across the whole stack:

- **I1 — no layer above L2 ever trusts a model-emitted string as anything but display text.** No markdown, no linkification, no URL, no execution.
- **I2 — every artifact that reaches L4 carries a `stack_id`** (§8.3). It cannot be backfilled.

---

## 2. Layer: app foundation

### 2.1 Runtime pins

| Component | Pin | Evidence |
| --- | --- | --- |
| React Native | **0.86.2** | [VERIFIED — npm registry, 2026-08-02] |
| Expo SDK | **57** (`expo@57.0.9`), prebuild / bare workflow — **Expo Go is impossible from day one** (custom native module) | [VERIFIED — npm] |
| Nitro Modules | **react-native-nitro-modules@0.36.5** (devDep pins RN 0.85.3; RN 0.86.2 compatibility is a week-one check, V23) | [VERIFIED — npm] |
| `@react-native-ai/apple` | **0.12.0**, peer `react-native >= 0.76.0` | [VERIFIED — npm] |
| `llama.rn` (contingency only) | **0.12.8** | [VERIFIED — npm] |
| `whisper.rn` (voice fallback) | **0.7.2** | [VERIFIED — npm] |
| LiteRT-LM | **pin by `revision:`, never by version** — see §3.1 | [VERIFIED — release list + issue metadata] |
| Android NDK | **r28+** (16 KB page size default) | [REPORTED → gate V26] |

New Architecture / bridgeless is mandatory (Nitro requires it; `@react-native-ai/apple` requires it).

### 2.2 Native module toolchain

One Nitro module, `NitroLlm`, owning: engine lifecycle, backend selection, model file resolution, prefill/decode, constrained decoding, image input, audio input, cancellation, and a known-answer smoke inference. **No image or audio bytes ever cross the JS bridge** — the JS side passes a file path or a native handle, and the module reads the file. Passing a base64 receipt through JSI is the classic way a team discovers a 200 MB transient allocation in month 4.

### 2.3 Repo layout

```
/apps/mobile                 Expo prebuild app
/packages/nitro-llm          Nitro module (Swift + Kotlin + ObjC++ shim + vendored C header)
/packages/extraction         ExtractionEngine interface, adapters, Zod schemas, sanitiser, normaliser
/packages/capture            NLS bridge, envelope types, trust tiers, capture-health
/packages/eval               eval sets, harness, digit-exactness gate, fixture receipts
/packages/policy             signed data channel: bank templates, remediation manifest, allowlists
/tools/spikes                throwaway Swift + Kotlin CLIs (V0) — no RN, deliberately unmaintained
/docs
```

Nitrogen output resolves under `expo.autolinking.searchPaths` pointing at `packages/` — **V23**, five minutes, answer inline in the register before the folder structure is frozen.

### 2.4 What this foundation makes possible or impossible for the data layer

This is the one out-of-scope area where the dependency runs *toward* us, so it is stated rather than designed.

**Available** (all require New Architecture + prebuild, which we have):
- `op-sqlite` — Nitro-based, same toolchain as our native module, SQLCipher and libsql build variants. The natural fit.
- `expo-sqlite` — first-party, already in the SDK 57 dependency graph.
- WatermelonDB with a JSI adapter; Drizzle/Kysely as query layers over any of the above.

**Impossible or legacy:**
- Anything requiring Expo Go.
- Old-architecture bridge modules (`react-native-sqlite-storage`) work only through the interop layer — a legacy path, not a choice.
- `react-native-quick-sqlite` is superseded by `op-sqlite`; do not start there.

**Two constraints we hand back, both submission-blocking (§11.6, §10.3):**
1. If the binding links **its own crypto library** (SQLCipher over OpenSSL/BoringSSL, or any bundled AES), Apple's encryption-exemption list does not cover it → `ITSAppUsesNonExemptEncryption=YES`, ERN/CCATS, annual self-classification, French declaration. Weeks of paperwork discovered on submission day.
2. Any bundled `.so` must pass the **16 KB page-size alignment** gate (V26). A crypto `.so` built with NDK ≤ r27 blocks the Play upload.

### 2.5 Interface asks to the data-layer and pipeline workstreams

Not designed here; required from there. Each is un-backfillable or expensive to retrofit.

| # | Ask | Why now |
| --- | --- | --- |
| 1 | `stack_id TEXT` column on every extraction row **and** every correction row, plus a `stack_registry` table mapping id → readable components | Cannot be backfilled; without it the v2 fine-tuning corpus is unusable (§8.3) |
| 2 | Per-source exemplar store keyed `(source_kind, sender_id, template_hash)` holding confirmed input→output pairs | Changes the extraction call signature (`source_profile` argument), so it must be decided before the interface freezes |
| 3 | `fx_rate` + `rate_date` **per transaction date and per pair**, plus a bulk-recompute path; home currency is **effective-dated**, not scalar; `converted_amount` is derived, never authoritative | §6; a year of history cannot be re-derived otherwise |
| 4 | Stable **idempotency key** on every capture envelope | Rebind + backfill (V15) replays notifications |
| 5 | Trust-tier flag on capture rows (`confirmed_sender` / `unknown_sender`) | Unknown-sender captures must never auto-accept or contribute exemplars (§4.4) |
| 6 | Append-only **metrics ledger** store (§9.1) and its retention rule | Month-1 baseline is unrecoverable if it starts in month 7 |
| 7 | Test-only DB reset/seed hook | Every device test and the reviewer demo path needs it |
| 8 | An **erasure enumeration contract**: one ordered, resumable operation with a verifiable end state across DB, WAL, image dir, model files, exemplars, corrections, ledger, settings, keychain/keystore | §12; LGPD/GDPR expect an exercisable path even with no accounts |
| 9 | A migrate / rebuild / discard classification per store (§12.3) | The backup-export workstream cannot infer it |
| 10 | Answer to: **does the chosen binding link its own crypto library, and which one** | §2.4 constraints 1 and 2 |
| 11 | Retention policy for receipt images and OCR text attached to corrections | Image blobs pass the model in size within a year for a heavy user (§7.5) |

---

## 3. Layer: engine

### 3.1 Pinning — the trilemma, and the rule that survives it

Three open upstream issues [all REPORTED, open and awaiting Google as of 2026-08-02]:

- **Buildability** — #3003 (v0.14.0 checksum mismatch), #2780 (v0.14.0 Swift wrapper does not compile under Xcode 26.6), #2815 (`.unsafeFlags(["-Xlinker","-all_load"])` forbids version-resolved SwiftPM pins under SE-0238; v0.13.0 / v0.13.1 / v0.14.0-alpha.0 point at the *previous* release's artifact whose checksum matches, so **resolution succeeds while linking a different release's binary than the tag requested**). Only v0.12.0 is self-consistent.
- **Numeric correctness** — #2814: iOS Metal backend systematically corrupts digit sequences (`2033-01-10` → `20333-01010`) while prose is unaffected; reproduces at temperature 0.2 *and* at greedy `max_top_k: 1`; CPU/XNNPACK is correct on byte-identical prompts. Fix #2805 (commit `840fe9ed`) merged 2026-07-10, **after** v0.14.0 (published 2026-07-08 [VERIFIED — release metadata]).
- **Memory** — #2966: v0.14.0 and the 0.15 nightly use ~2× the memory of ≤0.13.1. And #2545: when a ~1.28 GB model section cannot get a contiguous `mmap`, the section is skipped, the engine still reports **ready**, then NULL-derefs in `EmbeddingLookupManager::LookupPrefill`.

**Rules, not hopes:**

- **R-ENG-1 — pin by `revision:` with a vendored checksum**, and add a CI assertion that the resolved artifact hash equals the expected one. A version pin can link a binary you did not ask for.
- **R-ENG-2 — `engine reports ready` is untrusted.** After every engine init, run a known-answer smoke inference and fail closed (V36).
- **R-ENG-3 — digit exactness is a separate gate from F1** (§8.1). F1 over `{merchant, category, currency, date, total}` passes at 0.80 while `total` and `date` are silently wrong, because merchant and category carry the score.
- **R-ENG-4 — the revision matrix (V0) runs in week one, before the native module exists.** Deliverable is one table: revision × backend × {compiles, digit-exact %, peak RSS}. If no cell is green by end of week 2, the iOS contingency activates automatically (§16).

### 3.2 API surface actually available — read today

From `c/engine.h` on `main` **[VERIFIED symbol / UNVERIFIED behaviour — read 2026-08-02]**. Symbol presence answers *reachability*, never *correctness*; each carries a behavioural register entry.

| Capability | Symbol | Consequence | Register |
| --- | --- | --- | --- |
| **Constrained decoding** | `litert_lm_conversation_config_set_enable_constrained_decoding`, `..._set_constraint_provider`, `litert_lm_conversation_optional_args_set_constraint` | The JSON-schema contract (§4.1) is native to the API we bind, not a workaround. **Unknown: whether a JSON-Schema→grammar path is wired in the shipped binary, and whether the Swift wrapper reaches it — #2686 reports Swift cannot resolve the adjacent `litert_lm_sampler_params_*` family.** | **V27** |
| **LoRA at runtime** | `litert_lm_session_config_set_lora_path`, `..._set_audio_lora_path`, `litert_lm_engine_settings_set_lora_rank`, `..._set_supported_lora_ranks` | A v2 fine-tune can ship as a **megabyte-scale adapter on the same 3.66 GB base**, not a second model download or a second runtime. Materially changes the v2 cost model and the §9a "FunctionGemma format decision" — as an option to measure, not a reversal of the locked v2 plan. | **V37** |
| **Visual token budget** | `litert_lm_conversation_optional_args_set_visual_token_budget` | V16 is a config sweep, confirmed reachable. | V16 |
| **Per-token scores** | `litert_lm_session_run_text_scoring`, `litert_lm_responses_get_token_scores_at`, `..._has_score_at` | **V12 is ANSWERED: yes, reachable from the C API.** Consumption deferred to v2 (§8.4). | V12 |
| **Self-consistency** | `litert_lm_responses_get_num_candidates` exists; **no `num_output_candidates` setter exists in the C API** | **V14 is ANSWERED: the cheap knob does not exist.** `litert_lm_sampler_params_set_seed` exists, so N sequential seeded runs are possible at N× cost — the expensive form, with no v1 consumer. **V14 is deleted as a feature.** | V14 |
| **Load from fd** | `litert_lm_engine_settings_create_from_raw_file_descriptor` | Load ODR/PAD-delivered assets without copying 3.66 GB (§7.2). | V35 |
| **Memory / mmap knobs** | `set_parallel_file_section_loading`, `set_prefill_chunk_size`, `set_cache_dir`, `set_max_num_images`, `set_max_num_tokens` | The tuning surface for the 8 GB iOS floor and #2545/#2799. | V10 |
| **Conversation clone** | `litert_lm_conversation_clone` | Exists. **This is exactly why V13-as-written is worthless** — see §3.4. | V13 |
| **Thinking budget** | `litert_lm_thinking_config_*` | Latency control; disable for extraction. | — |

### 3.3 Adapter interface and the contingency ladder

`packages/extraction` exports one interface with **two implementations from day one**, behind a runtime feature flag:

```ts
interface ExtractionEngine {
  readonly id: string;              // contributes to stack_id
  available(): Promise<Availability>;
  extract(input: ExtractionInput, profile?: SourceProfile): Promise<ExtractionResult>;
}
```

`ExtractionResult` is a **Zod-validated object**, identical across adapters. Cost of the second adapter: about one engineer-week. It converts a four-to-six-week rewrite into a config change. Do not accept "we will add the fallback if the spike fails" — by the time these failures surface, the spike has already passed.

| Platform | Primary | Contingency | Coverage of the contingency |
| --- | --- | --- | --- |
| Android | LiteRT-LM + Gemma 4 **E4B**, GPU where allowlisted | LiteRT-LM CPU/XNNPACK with E2B; then Gemini Nano where present; then OCR + deterministic + manual | Broad; slow but universal |
| iOS ≥ A17 Pro | LiteRT-LM + Gemma 4 **E2B** *(target)* | **Apple Foundation Models via `@react-native-ai/apple@0.12.0`, `@Generable` schema-constrained** — no download, no memory entitlement, no Metal digit bug | iPhone 15 Pro and newer only |
| iOS < A17 Pro | LiteRT-LM + E2B *(target)* | **Gemma 4 E2B GGUF via `llama.rn@0.12.8` with GBNF** — re-run the llama.cpp PLE benchmark (#22243) now as cheap insurance; if it fails, **OCR + deterministic parsing + manual entry, no LLM** | Degraded or none |

**Say the quiet part plainly:** the iOS contingency does not reproduce the locked architecture on iOS. It reproduces it on recent Pro hardware and degrades below that. That is the trade being offered, and it is why the recommendation in §16 is Android-first rather than "both platforms, slightly later".

### 3.4 Runtime behaviours the plan must assume are broken until measured

- **Clone independence** — #2991 reports clones from one source are not independent. `litert_lm_conversation_clone` *exists*, so the original V13 ("one spike call") passes and teaches nothing. **Rewritten pass criterion:** clone twice from one prefilled conversation, send a different receipt to each, then ask clone A about content only ever given to clone B, and assert A cannot see it. Thirty minutes. Until it passes on both platforms, **one fresh conversation per receipt** — at ~1,189 tok/s prefill that is well under a second, and it is not worth a correctness risk in a finance app.
- **Memory ratchet** — #2699: on the Android OpenCL delegate, per-conversation memory is not reclaimed across create→send→delete; RSS climbs to OOM. V10 currently measures tok/s, thermals and battery — **not RSS**, which is the failure it should be designed to catch. Batch size is a config value set at the knee of the RSS curve, never a constant.
- **Tool-call continuation** — #2977: native SIGSEGV in `liblitertlm_jni.so` after a *successful* tool capture, on CPU, on two devices and two chipsets, on both 0.13.1 and 0.14.0. Also #1539 (five months open), #1027 (empty `<tool_response>`), #1859 (FunctionGemma 270M SIGSEGV). This is why §4.1 does not build the contract on tool calling.
- **Mali / Dimensity** — #2421: Gemma 4 E2B GPU decode dies with `CL_INVALID_COMMAND_QUEUE` after 1–3 turns on Mali-G715 / Tensor G4, still reproducing on v0.12.0. Mali ships in the MediaTek Dimensity parts that dominate mid-tier Android in Mexico and Brazil — the stated primary market. For this app, "dies after 1–3 turns" means **the second receipt of a session fails**.
- **iOS image input** — #2979 / #2370: `XNNPack delegate failed to reshape runtime / Node number 1480 ... failed to prepare`, `sendMessage()` returns nil, on a physical iPhone17,2. #2979's reporter notes Google's own AI Edge Gallery runs the same model with the same image on the same device — so the capability exists and the **public binding lags the internal path**. Recoverable, but on Google's cadence, not ours.

### 3.5 Backend policy is shipped configuration

A runtime policy object, delivered through the signed data channel (§9.4), keyed on `Build.SOC_MODEL` / `Build.MODEL` / `GL_RENDERER` / OS build, returning `{backend, model_variant, disable_tier_b}`. GPU is allowlisted, not assumed. This is the same object the remediation manifest carries, so it costs one mechanism, not two.

---

## 4. Layer: extraction and confirmation

### 4.1 The contract is schema-constrained JSON

The research doc calls the function-call schema "the one interface that must be right from day one". It is right about the *importance* and wrong about the *form*: tool calling is the newest, most-broken thing in the stack, and none of the contingency adapters use it (`@Generable` and GBNF are both schema-constrained JSON).

- **Contract:** the extraction module's output type is a Zod-validated `ExtractionResult`. Each adapter produces one however it can — LiteRT-LM constrained decoding (V27), Apple `@Generable`, llama.cpp GBNF.
- **Tool calling is an optional transport.** If `litert_lm_conversation_config_set_tools` works, fine; the module still returns `ExtractionResult`.
- **Fallback within the contract** (needed if V27 shows constrained decoding is unreachable from Swift): prompt-described schema + parse + validate + one bounded repair retry. llama.cpp's documented gotcha applies to every constrained path — **the schema constrains sampling but is not injected into the prompt**; the structure must also be described in the prompt or the model does not know what it is filling in [VERIFIED — llama.cpp grammars README].
- **To the capture→transaction workstream:** the answer to "does this module emit `{name, id, arguments}` objects or schema-validated JSON" is **JSON; the tool-call form is an implementation detail we may not use.**

### 4.2 The untrusted-content boundary

Every notification body, SMS body, OCR text block and receipt image is attacker-supplied and reaches the model without the user opening the app.

- All captured content enters the prompt inside an **explicitly delimited untrusted block** with a standing instruction that its contents are data, never instructions. Assert the model's output does not contain the delimiter.
- **Hard per-field caps before the model sees it and again after:** merchant ≤ 64, notes ≤ 256, any single captured body truncated at a fixed budget with the truncation recorded.
- **Sanitise every model-emitted string at the boundary:** strip URLs, phone numbers, control characters, bidi overrides, homoglyphs. Never render as markdown or HTML. Never linkify. (Invariant I1.)
- **Adversarial eval slice** (§8.1): injection strings, oversized bodies, bidi overrides, receipts with printed instruction text. Cheap now, impossible to retrofit into a released trust model.

### 4.3 The money normaliser — never let the model emit a number

A model that emits a JSON `number` for money is a bug generator: `1.299,00` (MX/BR/CO thousands-dot) versus `1,299.00`, and COP where the displayed convention has no decimals while ISO 4217 assigns an exponent of 2.

- The schema field is `amount_text: string` plus `currency_guess: string`, never a float.
- A **deterministic normaliser** converts to integer minor units using the locale grammar and the ISO 4217 exponent, and returns an ambiguity flag when the grammar is undecidable (`1.299` in a MX receipt is genuinely ambiguous).
- **Currency resolution ladder**, in order: explicit ISO code in text → merchant country/locale → device region → user's default account currency. Store the detected currency with a confidence value and surface it on the confirmation screen.
- **Dates:** a receipt date and a capture timestamp are different facts. Persist both. Never derive the transaction date from device time.
- The COP exponent must be settled **before the first row is written** (§13c).

### 4.4 Per-source learning, and its abuse case

After the user corrects the same `(source_kind, sender_id, template_hash)` consistently N times (start at N=3), persist the confirmed input→output pair and inject 1–3 as few-shot exemplars for that source only. The third correction becomes a permanent fix on that device: no network, no consent boundary, and it is exactly the data the v2 fine-tune wants.

**Guard:** captures from senders the user has not confirmed get a distinct trust tier — never auto-accept regardless of confidence, and **never contribute exemplars or training pairs**. Otherwise repetition lets an attacker poison per-source learning by blasting spoofed-sender SMS.

### 4.5 The confirmation screen

Always editable, always shown, never bypassed in v1. Extraction is ~0.80 F1 and correction is the normal path. The confirmation screen is also the **delivery surface** for any injected content, so §4.2's sanitisation applies to everything it renders.

---

## 5. Layer: capture

### 5.1 Platform asymmetry (unchanged from research §1)

iOS has no passive capture — no SMS read, no third-party notification access. iOS ingestion is Share Sheet, Shortcuts/App Intents, screenshot OCR (the highest-leverage iOS feature: one pipeline, two inputs) and camera. Android has NotificationListenerService now and READ_SMS at v1.4.

### 5.2 Shaping the code so it does not read as spyware

A `NotificationListenerService` receives every notification from every installed app. Play's definitions are explicit: spyware collects "user or device data that is not related to policy compliant functionality"; a backdoor allows "unwanted, potentially harmful, remote-controlled operations" [VERIFIED — Play PHA categories]. Five requirements, all code-shaped and demonstrable:

1. **Filter on the first line of `onNotificationPosted`** — `if (sbn.packageName !in bankAllowlist) return` — before any persistence, any logging, any breadcrumb. No wildcard match, no regex over package names, no "learn new senders" mode. Mirror it for SMS: match sender/shortcode **before** the body is copied out of the callback. *(The allowlist is signed shipped configuration, not a compile-time constant — see §14, correction C2.)*
2. **Never auto-forward captured notification or SMS text off-device.** With Tier C deferred (§0.8) this is trivially satisfied in v1; when Tier C returns, restrict it to receipt images and user-typed text, require a per-item explicit tap, and keep a user-visible outbound log.
3. **The app never executes a tool call returned by a remote endpoint.** A hard security invariant, not a layering preference. Remote responses parse as data into the confirmation screen and nothing else.
4. **Visible at all times:** unique launcher icon, app name always shown, no activity-alias icon hiding, an in-app capture indicator, and an ongoing status notification while capture is enabled.
5. **The memo.** One page, week one, in the repo: why this is not spyware. The same text serves as the Play appeal, the Data Safety rationale, and the permissions-declaration justification.

### 5.3 READ_SMS: the exception is conditional, and shipping NLS first creates the counter-evidence

The exceptions table's preamble reads: a temporary exception may be provided when "use of the permission enables the core app functionality listed in the following table **and there's currently no alternative method to provide the core functionality**" [VERIFIED — Play Console Help 10208820]. "SMS-based money management" is genuinely in the table, so eligibility holds — but at declaration time we will be a shipping app that already delivers transaction capture without READ_SMS. The same page carries a change notice narrowing the table (READ_CALL_LOG account verification removed effective 2027-01-27), so it is actively shrinking.

**Therefore the declaration must be coverage-based and quantitative, and the evidence collection starts in v1:**
- Local, consented, aggregated counters of captured bank events **by channel** (no message content) — from the metrics ledger (§9.1).
- A reason code on manual entry: "my bank doesn't send a notification".
- The declaration then reads: notification access covers N of M banks in MX/BR; these K banks send transaction alerts by SMS only; here is the per-bank table and the share of user transactions it represents.
- **Operationally:** READ_SMS lives behind a build flavour so the permission is not in the merged manifest until the declaration is approved (asserted by V21). Never ship a permissions declaration in a release with a date attached. Budget 2–6 weeks and at least one rejection round-trip.

### 5.4 Capture health monitor — permission decay is the normal case

V15 tests service liveness (`am kill` → rebind + backfill). That is not capture liveness. On Xiaomi/MIUI, Motorola and Transsion — the devices that dominate the target market — autostart and battery managers restrict background services as routine behaviour, and the failure is silent: no crash, no error, just a month that looks like the user spent nothing.

Required surface:
- Persist `last_capture_seen_at` **per source**.
- On every foreground: check `NotificationManagerCompat.getEnabledListenerPackages()` and `isIgnoringBatteryOptimizations()`.
- If access is granted but nothing has arrived in N days — **N derived from that user's historical rate, not a constant** — show a persistent "capture may be paused" card with a one-tap deep link to `ACTION_NOTIFICATION_LISTENER_SETTINGS`, plus OEM autostart/battery screens (MIUI/ColorOS/EMUI intents, each wrapped in try/catch — they are undocumented and vanish between OS versions — with a screenshot walkthrough as fallback).
- **`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is a Play restricted permission and is on the CI denylist (§10.3).** Deep link to settings instead.
- **Every runtime permission has an explicit denial path.** Track an "asked before" flag; after denial, route to `Linking.openSettings()` with an explanation. Never re-call an API that will silently no-op (iOS `requestRecordPermission` after a denial shows no dialog, ever).
- **Late grants:** on grant in month 3, backfill from `getActiveNotifications()` and state plainly that history before the grant does not exist.

### 5.5 Bank templates are data that rots on the bank's schedule

Deterministic per-bank templates resolve a large share of captures with no model at all — and that share sets the entire background battery budget (§13c). They are also the fastest-rotting artifact in the system: a Banorte wording change in October poisons every Banorte capture and every correction harvested from those users until a store release ships.

**Therefore templates ship as a versioned data pack over the signed static channel (§9.4), not as code.** Plus an in-app "this source is always wrong" action that assembles the redacted sample from §9.2 for the user to review and send.

---

## 6. Layer: currency and FX

Unchanged from research §6 except where the reviewers found the architecture cannot support a real user action.

- **Home currency is effective-dated, not a scalar.** A user who onboards in Bogotá with COP and switches to MXN in month 9 needs every historical report converted at each transaction's own date. A daily-refresh cache with a 12–24 h TTL is a point-in-time snapshot; applying today's rate to a year of history is a silently wrong number inside a finance app. The far more common case is the user who picked the wrong currency in week one — without this path, support's only answer is "delete everything".
- **Resumable background backfill job** over Frankfurter's range endpoint — `https://api.frankfurter.dev/v2/rates?from=YYYY-MM-DD&to=YYYY-MM-DD`, NDJSON for long ranges [VERIFIED — frankfurter.dev, per reviewer]. Progress UI, offline queueing, never blocks the UI.
- **Missing-rate rule, defined and surfaced before the first row is written:** reference rates are business-day only. Carry forward the last published rate and **mark affected rows approximate**.
- **Verify per-currency coverage before promising anything** (V48): Frankfurter v2 advertises 84 central banks / 201 currencies, broader than the research doc's ECB-only assumption, but confirm COP, CLP, PEN, ARS and RUB specifically.
- **For product:** where a parallel or unofficial market exists, an official reference rate can be far from the user's real purchasing power. Decide whether to disclose that or allow a per-transaction rate override.
- Rate endpoint stays configurable (self-hostable Frankfurter container) — rates are public reference data, no user data leaves.
- Ship a seed rate table in the bundle so a fresh install works offline on day one.

---

## 7. Layer: model asset lifecycle

### 7.1 Delivery: store mechanisms, under both readings

| | iOS | Android |
| --- | --- | --- |
| Mechanism | **On-Demand Resources** (iOS 18+: up to 8 GB per thinned pack) | **Play Asset Delivery**, `AssetPackManager`, on-demand |
| Pack split | one pack fits | **individual asset pack cap is 1.5 GB compressed → 3.66 GB must be ≥3 packs** [VERIFIED — Play answer 9859372]; all modules + install-time packs ≤ 4 GB; on-demand cumulative ≤ 30 GB; sizes are **compressed as Play computes them at upload**, not on-disk |
| Foreground service | n/a | **none needed** — Play downloads in its own process |

The chain worth restating: **PAD → no foreground service → no `dataSync` FGS type → no ~6-hour-per-24h cap → no Play FGS declaration → no FGS demo video.** Self-hosting the Android download reverses all four and buys zero privacy, because the pack contains model weights and no user data.

Self-hosting also costs the **Guideline 2.5.2 defence** on iOS (§11.2). Both readings of the no-cloud constraint converge here: **store mechanisms for weights, self-host everything that touches user data.**

Budget the consequence: ODR packs are built and uploaded with the Xcode build, so the macOS build host uploads multiple GB to App Store Connect on every release.

### 7.2 Where the file lives — resolving A10 against B4 explicitly

The two reviewer fixes conflict. A10 says pin the model in `Library/Application Support/models/` with `NSURLIsExcludedFromBackupKey` set **at creation**, because `Library/Caches` gets purged and `Documents` lands 3.66 GB in the user's iCloud backup. B4 says use ODR, which puts the file in an OS-managed location you do not control and which the OS may evict.

**Resolution: store delivery wins, and eviction becomes a designed state rather than a bug.**
- Do **not** copy the pack contents into app storage — that transiently doubles peak disk to ~7.3 GB on a device the user chose because it was cheap.
- iOS: hold an `NSBundleResourceRequest` across the inference session (`beginAccessingResources` / `endAccessingResources`); **re-resolve the path at every launch**; treat eviction between sessions as normal.
- Android: resolve `AssetPackLocation.assetsPath()` at every launch.
- Feed the resolved path — or better, a file descriptor via `litert_lm_engine_settings_create_from_raw_file_descriptor` **[VERIFIED symbol]** — into the engine.
- **Unverified and load-bearing (V34):** whether a PAD-delivered `.litertlm` is stored uncompressed and `mmap`-able. LiteRT-LM `mmap`s model sections, and #2545 shows the failure mode is a false "ready" followed by a NULL deref, not a clean error.
- **Consequence the reviewers did not state, and it cuts both ways (V49):** store-delivered packs version with the app bundle. That *shrinks* the JS↔model skew problem in §7.3 — but it removes any independent model hotfix. Verify the coupling on both stores rather than assuming it.

### 7.3 The model is a third versioned artifact

Native code versions through the stores; JS versions through the bundle; **the model has its own version and its own update latency of days-to-never.** Expo's `runtimeVersion` fingerprint covers native code, not a runtime-resolved asset. Prompt templates, chat template, tokenizer and the function/JSON format are all coupled to a specific `.litertlm` build.

- Each JS bundle declares `supportedModelVersions` (a semver range).
- Each model asset ships a manifest carrying `chatTemplateId`, `toolFormatId`, `tokenizerHash`, `modelAssetSha256`.
- The native module **refuses to pair an out-of-range bundle with the on-disk model** and enters a visible "update required" state that falls back to OCR + manual — never a silent quality degradation.
- Keep N and N−1 resolvable; never delete the old asset until the new one verifies.
- **A second multi-GB download in month 6 is a product event, not a background detail.** It gets the same Wi-Fi gating, progress and deferral treatment as first run, and the app stays useful throughout.
- **Model artifacts are platform-scoped.** #2341 reports the v0.12.0 Kotlin SDK rejecting `.litertlm` files the v0.12.0 Swift xcframework loads. Version the manifest by `(platform, binding_revision, variant)`, each with its own checksum (V38).

### 7.4 Integrity, failure, and never re-downloading 3.66 GB by mistake

- **Startup integrity check:** presence, exact size, and a hash of the first and last blocks. A full 3.66 GB hash per launch is too slow.
- On failure: enter a clean **"AI features unavailable; manual entry and OCR still work"** state and offer re-download. Never fault inside native code.
- Where the app owns the transfer at all: download to a temp path, atomically rename only after full SHA-256 verification, require `size × 1.15` free before starting so a failure at 92% never happens.
- **Distinguish "download corrupt, retry" from "model incompatible with this binding, do not retry."** A post-download known-answer inference makes that distinction. Without it, a rejected artifact triggers a 3.66 GB re-download over the user's mobile data — a support incident with a real cost in the target market.

### 7.5 Storage the user can see

A Storage settings screen breaking usage into **model / receipt images / database** with per-bucket deletion. Without it, the user's only tool is the OS-level nuke (Settings → Apps → Storage), which the app never learns about. Receipt-image retention — originals vs downscaled, JPEG quality, whether the original survives a confirmed extraction — is decided now, because image blobs pass the model in size within a year for a heavy user.

---

## 8. Layer: evaluation, provenance and quality gates

### 8.1 The eval set and its gates

Three gates, not one score:

| Gate | Metric | Why separate |
| --- | --- | --- |
| **Field F1** | F1 over `{merchant, category, currency, tax, line_items}` | The general quality number |
| **Digit exactness** | **exact string match** on `total`, `date`, `card_last4` | An expense manager's error budget on amounts is not the same number as its error budget on merchant names. #2814 corrupts digits while prose stays perfect — F1 passes, the app is broken |
| **Adversarial** | 0 injections executed, 0 delimiter leaks, 0 unsanitised renders, all length caps enforced | §4.2 |

Slices: per market (MX/BR/CO), per language (es/pt/ru/en), per source kind (receipt photo / notification / SMS / voice / typed), per path (OCR-text vs VLM), and a gated negative slice if the transaction/not-transaction filter turns out to be LLM-based.

### 8.2 Digit-fidelity canary (V0), the week-one artifact

200 prompts that echo currency amounts, ISO dates and card last-4, scored on exact string match of the digits. Run across `revision × backend`, recording peak RSS per cell. This is both the go/no-go for §3.3 and a permanent CI fixture.

### 8.3 `stack_id` — the un-backfillable one

One opaque id stamped on every extraction result **and** every correction:

```
stack_id = hash(model_asset_sha256, engine_revision, prompt_template_id,
                prompt_template_hash, output_schema_version,
                ocr_engine + version, path[ocr_text|vlm], backend[gpu|cpu],
                tier[A|B|C], locale)
```

**Deliberately excluded: the app build number** (see §14, correction C1). A local `stack_registry` maps `stack_id` → readable components so old ids stay interpretable after the code is gone; the app build is a *separate column* on the row.

**CI gate:** any diff under `packages/extraction/prompts/` or `packages/extraction/schema/` that does not change the computed template hash fails the build.

Without this, month 12's 60k correction pairs are a mixture of two prompt wordings, two schema versions, two OCR versions and two extraction paths, inseparable — and the locked v2 FunctionGemma plan trains on a retired output format or discards a year of harvesting.

### 8.4 Confidence in v1: free proxies only

The calibration apparatus is simultaneously unreachable (no `num_output_candidates` in the C API; `litert_lm_sampler_params_*` reportedly unreachable from Swift, #2686) and unconsumed (nothing is auto-accepted in v1, and product has not set an auto-accept target or an error ceiling). V14 is deleted; V12 is deferred to v2.

v1 uses proxies that need no engine support and no product decision:
1. OCR per-word confidence from Vision / ML Kit.
2. Required-field presence.
3. **Total vs sum-of-line-items arithmetic check** — deterministic, and worth more on receipts than any token score.
4. Currency-detection ambiguity (§4.3) and money-grammar ambiguity.

Log all four alongside every correction. The calibration dataset then accumulates for free from day one, and when product sets the two numbers there is real labelled data to calibrate against.

### 8.5 What VLM escalation is gated on

Escalate to image input when: OCR word confidence below threshold, or a required field missing, or the arithmetic check fails. **V16** measures 280 vs 1120 visual tokens on 50 real dense thermal receipts (skip 560 — the midpoint interpolates) for F1, prefill latency and peak memory.

**Additional precondition — aspect ratio (added during reconciliation, see `2026-08-02-image-preprocessing.md` §9).** The trigger above is necessary but not sufficient. A VLM sees a fixed visual token budget spread over whatever image it is handed, so escalating a long till roll *unsegmented* can score **worse** than the OCR path it escalated from — the same budget stretched over a 1:8 strip leaves too few tokens per character, and digits fail first. The gate becomes:

```
escalate  ⟺  (low_confidence ∨ missing_field ∨ arithmetic_mismatch)
             ∧ (aspect ≤ ASPECT_SPLIT_THRESHOLD ∨ segmentation_succeeded)
```

If segmentation is unavailable or fails on a long receipt, **do not escalate** — keep the OCR result and route to user confirmation instead. A known-mediocre answer the user can correct beats a confidently wrong total.

**V16 must therefore be run on segmented input**, and its receipt sample must include long till rolls, not only dense A5-sized thermal receipts, or it will measure the easy case and set the threshold too low.

---

## 9. Layer: field observability, support and remediation

Entirely new. Nothing in the reviewed plan could see the field, and every gate in §8 is parameterised by a number that only exists there.

### 9.1 Local metrics ledger

Append-only counters written by the extraction and capture layers, keyed `(stack_id, tier, source_kind, sender_hash, currency, day)`:

captures attempted / completed / abandoned · per-field correction counts · VLM escalations · inference failures · OOM kills · engine-init failures · backend downgrades · p50/p95 latency · capture events by channel (feeds the READ_SMS declaration, §5.3).

Pure local state. It also powers an in-app "your accuracy" screen, which is a feature, not instrumentation.

### 9.2 Diagnostic bundle

Ring-buffered structured logs with **monetary values and merchant strings redacted at the log call site**, not filtered afterwards — plus device model, SoC, `GL_RENDERER`, OS build, backend, `stack_id`, permission state, free space, last 50 inference timings. Rendered in-app for the user to read **before** they choose to share. This is also the assembly step behind the "this source is always wrong" action (§5.5).

### 9.3 Local circuit breaker — the highest-value item per line of code

Persist an "entering native inference" marker; clear it on success.
- Two consecutive unclean starts → auto-downgrade GPU → CPU.
- A third → disable Tier B, fall back to OCR/manual, show a visible explanation.

Zero network. This is what stands between the team and an OEM GPU-driver update that hard-crashes 4% of installs on first prefill, invisibly, with a 1–3 day store review as the only lever.

### 9.4 Signed remediation and data channel

One static, signed JSON endpoint carrying:
- `backend_policy` (§3.5) — keyed on `(SOC_MODEL, MODEL, GL_RENDERER, os_build, app_version, model_version)`, returning backend override, model-variant override, `disable_tier_b`, `min_supported_build`.
- `bank_templates` pack (§5.5) and the notification/SMS `sender_allowlist` (§5.2).
- Long TTL, last-good fallback, signature-verified.

**Served from a different hostname and path than the model assets**, so a delivery outage does not also block the fix. Strict reading: any CDN or object store. Maximal: the same self-hosted origin family, which makes that origin availability-critical for remediation and needs an uptime target.

This is a **static signed file, not the `expo-updates` protocol** (§14, correction C3). It gets the template-rot and remediation value at a fraction of the OTA-server cost.

### 9.5 Staged rollout

Play staged rollout with halt. Note that Apple's phased release **cannot be targeted at a device class** — only paused — and is bypassed by anyone who taps Update manually.

### 9.6 What replaces telemetry

Under **both** readings, no user-derived accuracy counters leave the device (§14, rejection R1). The substitute is a **recruited beta cohort of roughly 50–200 per market under explicit research consent**, whose diagnostic bundles are shared deliberately. **Budget that recruitment cost explicitly — it is the line item that stands in for telemetry, and it is the thing teams discover they never funded.**

---

## 10. Layer: build, CI and release infrastructure

**One discrepancy, stated once.** This workflow's brief says the build/dev-infrastructure boundary is unresolved and being decided in parallel. The on-disk research doc's §9c already locks constraint 6 as **maximal — everything self-hosted**. The doc is ahead of its own brief. The table below is built so that most rows **converge**, which means the parallel decision only has to resolve four rows.

### 10.1 Strict vs maximal — the fork is smaller than it looks

| Concern | Both readings converge on | Forks only if it forks |
| --- | --- | --- |
| Model weight delivery | **ODR + PAD.** Store infrastructure is already unavoidable; weights contain no user data; self-hosting costs the 2.5.2 defence and the FGS chain | — |
| User data egress | **None, ever.** Only a user-owned endpoint, and that is deferred out of v1 | — |
| Accuracy telemetry | **None off-device** (§9.6). Local ledger + user-initiated bundle | — |
| Crash reporting | **User-initiated per report** through the diagnostic-bundle UI, preserving the zero-collection claim (§11.5) | Vendor only: strict → Sentry SaaS; maximal → GlitchTip. Disclosure analysis is identical, and slightly *worse* with a third-party processor |
| OTA | **Deleted from v1.** Keep `expo-updates` configured embedded-only so adding a server later is configuration, not migration | — |
| Remediation/config channel | **Signed static JSON**, separate hostname from assets | Origin only: any CDN vs self-hosted object store |
| Store consoles | **Unavoidable.** App Store Connect, Play Console, Apple notarisation, Play app signing | — |
| **CI compute** | — | **Strict: hosted CI. Maximal: self-hosted runners.** Real fork |
| **macOS build host** | — | **Strict: hosted macOS (or EAS Build). Maximal: real Apple hardware, kept patched on a current Xcode, uploading multi-GB ODR packs each release.** Real fork |
| **iOS device testing** | Simulator is a compile check only (§10.4) | **Strict: buy a hosted real-device farm — the single highest-ROI purchase available. Maximal: written manual smoke script, two physical devices, results logged in the repo.** Real fork |
| **Dependency mirror / artifact + eval-set storage** | — | **Strict: public registries + LFS. Maximal: internal mirror, resolvable pins, self-hosted artifact store.** Real fork |
| Android device testing | **Local `adb` on real devices** — free under both readings | — |
| Signing key custody | Manual custody with a documented recovery path either way | — |

**Recommendation.** Under **strict**, buy exactly three things and nothing else: hosted CI, a hosted macOS builder, and a hosted iOS device farm. Under **maximal**, accept in writing that iOS device testing is manual in v1, and **do not build a self-hosted iOS device farm** — USB-tethered iOS automation with an unattended macOS host is a project in its own right and will consume an engineer indefinitely. Under both, delete self-hosted OTA; that deletion is what pays for self-hosted CI.

### 10.2 The 16 KB page-size gate — an upload-time block on the locked engine

Since 2025-11-01, all new apps and updates targeting Android 15 (API 35)+ must support 16 KB page sizes on 64-bit devices; every LOAD segment in every shipped `.so` must be aligned to 2\*\*14 [VERIFIED — developer.android.com/guide/practices/page-sizes]. We ship Google's prebuilt `prebuilt/android_arm64/*.so`, and we do not control how Google built them.

- **V26, week one, before the native module is written:** `$NDK/toolchains/llvm/prebuilt/*/bin/llvm-objdump -p libLiteRT*.so | grep LOAD` — every LOAD line must read `align 2**14`.
- **Permanent CI gate:** alignment verification on every build (`zipalign -v -c -P 16 4` for APK artifacts; the `objdump`/`check_elf_alignment` form for the AAB's bundled `.so` set, which is what actually gets uploaded). Fail the build on anything but success.
- Build our own native code with **NDK r28+**; anything older needs `-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384`.
- The same check applies to `whisper.rn`, any SQLite binding with a bundled crypto `.so`, and every transitive native dependency.
- **If Google's prebuilts fail:** the week-one decision is source-build vs vendored patched build, made with the schedule cost visible — not in launch week when the alternative is Bazel, C++, XNNPACK, the GPU delegate, and full GPU re-validation.

### 10.3 The manifest/plist gate (V21), as allowlist **and** denylist

Allowlist as before. Add explicit **denylist assertions by name**, each failing with a message naming the policy and the answer-page URL, because the person adding one is debugging an OEM issue under pressure and will not go read policy:

`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` · `BIND_ACCESSIBILITY_SERVICE` · `QUERY_ALL_PACKAGES` · `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` · `USE_EXACT_ALARM` · `com.google.android.gms.permission.AD_ID` (arrives transitively and forces an Advertising-ID entry in Data Safety that contradicts the entire privacy story) · `READ_SMS` until its declaration is approved.

Sanctioned alternatives, in the failure message: battery/autostart → the §5.4 deep-link path; accessibility → never; package enumeration → an explicit `<queries><package .../>` list built from the same bank allowlist; gallery → `ACTION_PICK_IMAGES` / photo-picker mode (full Play Photo & Video Permissions compliance has been mandatory since 2025-05-28 [VERIFIED]); exact alarms → WorkManager inexact.

Also asserted by the same gate: the iOS `Info.plist` expected key set (`ITSAppUsesNonExemptEncryption`, `NSLocalNetworkUsageDescription` when Tier C returns, required-reason API declarations), a **negative** assertion that `NSAllowsArbitraryLoads` is absent, absence of app-wide `usesCleartextTraffic`, and agreement between the privacy manifest, the Play Data Safety answers, the App Store nutrition label and the actual outbound hostnames.

### 10.4 Testing

- **Android:** `adb` drives real devices locally at zero cost. Maestro stays here. `react-native-harness` scoped to Android native-module unit tests only until it proves itself — it is a 324-star project created 2025-06-17 and must not be load-bearing for iOS.
- **iOS:** the simulator cannot run LiteRT-LM at all (#2504: CPU fails INTERNAL at `llm_litert_compiled_model_executor.cc:755`; GPU "Failed to create engine"), cannot test Local Network privacy, cannot test jetsam at the 8 GB floor, cannot test ODR. Maestro's iOS support is Simulator-only locally, with physical devices routed to Maestro Cloud [VERIFIED — docs.maestro.dev]. **Delete Maestro from the iOS plan.** Then §10.1's fork applies: buy a device farm, or write the 20-step manual smoke script (install, model download, first extraction, digit-exactness spot check, background-and-return, memory-warning behaviour) and run it on every release candidate on an iPhone 15 Pro plus one current model, logging results in the repo.
- **Device lab, week one, under $500:** a Motorola G-series and a Redmi Note in the Dimensity / Mali-G715 class. This is the primary market's hardware and it is currently untested against a locked engine choice.

### 10.5 What is deleted from the infrastructure plan

**V22 / self-hosted OTA (xprem).** Reasons, both readings: the app's entire risk surface is native and OTA ships only JS; Expo's own reference server carries a "not guaranteed to be complete, stable, or performant enough" disclaimer and no support for custom servers [VERIFIED]; operating it means a permanent public HTTPS endpoint, object storage, a CDN, an update signing key, and a failure mode where a bad manifest bricks the JS bundle for every install at once with recovery depending on a `rollBackToEmbedded` path rehearsed once. Store review turnaround is routinely well under a day. Keep `expo-updates` in the tree, embedded-only. Revisit when a measured count of JS-only hotfixes justifies it.

---

## 11. Layer: store review, policy and legal

### 11.1 The reviewer cannot exercise this product, and the obvious workaround is itself a rejection

Apple's reviewer cannot receive a Mexican bank SMS or produce a Spanish thermal receipt. Play's reviewer grants notification access and sees an empty list. Apple 2.3.1(a) forbids "hidden, dormant, or undocumented features" and requires specificity in Notes for Review [VERIFIED verbatim], so a tap-seven-times reviewer mode is its own rejection with a nastier tone.

**Build the demo path in v1 as shipping features in the main navigation:**
- **"Test your setup"** — a permanent onboarding step that posts a realistic sample bank notification from **our own** notification channel and shows the listener catching, parsing and presenting it end to end.
- **"Try it with a sample"** — bundled sample receipt images and a sample voice clip, with a recorded-output stub so the demo works **before any model exists on disk**. This doubles as the empty state and as §8's fixture set and as support's reproduction path.
- Record the Play declaration videos and the App Review screen recording from that same flow, in one sitting.
- Paste the exact tap path into Notes for Review and Play's App access instructions.

### 11.2 The 3.66 GB download produces two independent Apple rejections

**2.1 App Completeness** — a reviewer on a shared network sees "Downloading AI model 4%" and rejects. **2.5.2** — "Apps should be self-contained in their bundles... nor may they download, install, or execute code which introduces or changes features or functionality of the app" [VERIFIED verbatim]. Weights are data, not code, but a multi-gigabyte artifact that grants receipt reading, voice and function calling is a defensible reviewer reading.

- **The app is complete and genuinely useful with zero model bytes.** Manual entry, camera capture, Vision/ML Kit OCR, deterministic bank parsing, sample data. The model is an opt-in **"Enable AI extraction"** toggle in settings that states the download size. It is never on the first-run path.
- **ODR** is Apple's sanctioned mechanism for exactly this and materially strengthens the 2.5.2 position — though not, honestly, "outright" removing it (§14, correction C4). Be ready to answer the question in writing anyway.
- Notes for Review state plainly: the download is data, not executable code; it is user-consented and Wi-Fi-gated; here is how to exercise every capture path in under two minutes.

### 11.3 Guideline 3.2.1(viii) and the seller name

"Apps used for financial trading, investing, or money management should be submitted by the financial institution performing such services and must have necessary licensing and permissions in the locations where you make them available" [VERIFIED verbatim]. The discriminating inputs are the three things a reviewer sees before opening the app: **seller name, subtitle, first two lines of the description.** "Platacard" reads as a card issuer. Add "manage your money" and "connects to your bank" and the reviewer is at 3.2.1(viii) before launch — a rejection resolvable only by a legal letter for three jurisdictions, a seller-name change (new ASC entity, re-provisioned certificates; on Play a new package name or a developer-account transfer), or a listing rewrite. All measured in weeks, all triggered by metadata written last.

**Decide before the listing copy exists.** Frame as a personal expense tracker/organiser. Never use "money management", "banking", "accounts", "balance" as a headline noun, or "connects to your bank". Notes for Review line: *"This app does not provide financial services. It does not connect to any financial institution, does not initiate or process payments, and holds no funds. It records the user's own spending, locally on the device."* No bank names or logos anywhere — metadata, keywords, screenshots, or the in-app institution picker (Apple 5.2.1, Play Misrepresentation); use text-only user-typed labels or a generic glyph. Never render a figure that reads as an account balance next to an institution name.

### 11.4 The listing must be written to the measured numbers

~0.80 F1, allowlisted banks only, push-enabled users only, and Android OTP redaction may silently swallow alerts from exactly the LATAM banks that matter (V46, unresolved). This is the finding teams discover from 1-star "doesn't work" reviews, not from a rejection.

**Allowed:** "Snap a receipt, say it out loud, or let bank alerts fill it in — then confirm in one tap." **Not allowed:** "automatic", "no manual entry", "never type again", any accuracy percentage, "connects to your bank", any bank name. Ship an in-app supported-institutions list with an explicit "coverage varies by bank and by your notification settings" note, reachable from onboarding — before the permission grant, not after. Re-check the listing against §8 eval results before every release. All screenshots are real captures from the demo flow.

### 11.5 Privacy declarations, and why crash reporting is "collection"

Apple defines collect as "transmitting data off the device... for a period longer than what is necessary to service the transmitted request in real time" — **our own server counts** [VERIFIED]. The optional-disclosure exception requires all four of: not used for tracking; not used for advertising; infrequent and not part of primary functionality; **and user-initiated with affirmative choice each time.** Automatic GlitchTip upload fails criteria 3 and 4. Play is the same shape: "'Collect' means transmitting data from your app off a user's device"; a user-owned server is still off-device; enforcement follows any discrepancy [VERIFIED].

**Decision: every crash/diagnostic upload is user-initiated per report** through the §9.2 bundle UI. That preserves "no data collected" on both stores, satisfies criterion 4, and costs automatic crash volume that the maximal reading was already forfeiting. Redact at the log call site. The V21 gate asserts that manifest, Data Safety answers, nutrition label and actual outbound hostnames all agree.

**Tier C, when it returns:** declare Financial info, Photos and videos, and Messages as collected, flagged optional/user-initiated; do not claim the ephemeral-processing exemption (we do not control what the user's Ollama box retains); put an explicit consent sheet naming the data types and the destination host in front of the first request and record a timestamped acceptance — that is what Apple 5.1.2(i)'s "explicit permission" means in practice [VERIFIED verbatim]. Deferring Tier C out of v1 removes all of this, plus `NSLocalNetworkUsageDescription`, plus the ATS question, plus V18.

### 11.6 Encryption export compliance

Set `ITSAppUsesNonExemptEncryption` explicitly in `Info.plist` so the question never appears interactively at submission, and add it (plus `ITSEncryptionExportComplianceCode` if applicable) to the V21 expected-key-set assertion. The value depends entirely on §2.5 ask #10. Either pick a key path using only Apple-provided crypto so the exemption holds, or start the ERN/CCATS paperwork in week one in parallel with development. Discovering this on submission day moves the launch date for a reason unrelated to the product.

### 11.7 Gemma licensing — serving the weights makes us a distributor

[VERIFIED — ai.google.dev/gemma/terms] §3.1.2 requires providing every recipient a copy of the Agreement. §3.1.4 requires a text file with the exact string *"Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms"* for non-hosted distribution. §3.1.1 requires including the §3.2 use restrictions **as an enforceable provision in our own agreement with users**, and notifying them. §3.1.3 requires prominent "modified" notices on changed files — which covers our own `.litertlm` conversion or quantisation and any future fine-tune or LoRA adapter (a Model Derivative inherits all of it). This applies to our own origin, to iOS ODR, and to PAD alike.

**Actions:** ship the notice file alongside the model asset; surface it in an in-app "Model and open-source licenses" screen; mark any converted, quantised or LoRA-adapted artifact as modified; **add the Gemma Prohibited Use Policy pass-through clause to the app EULA before the first public build** — retrofitting a EULA onto an installed base is far harder than writing it now.

---

## 12. Layer: device lifecycle

### 12.1 Erasure

One ordered, resumable operation with a verifiable end state across: DB, WAL/journal, receipt image directory, model files/packs, exemplar store, correction store, metrics ledger, settings, keychain/keystore entries. Publish what erasure covers in the privacy policy — LGPD and GDPR expect an exercisable path even with no accounts, and both stores' data-safety forms ask about deletion.

### 12.2 Reinstall reconciliation

iOS Keychain items survive app deletion. A user who uninstalls to free space and reinstalls finds a DB key with no database; after a device restore, a restored database and a keychain entry from a different install. The app is neither empty nor working. **First-launch reconciliation detects orphaned key material and offers a clean reset instead of an ambiguous state.**

### 12.3 Migration classification (handed to the backup/export workstream as a requirement they cannot infer)

| Store | Class | Why |
| --- | --- | --- |
| Model files / packs | **DISCARD** | Re-acquire from the store; must never appear in any backup |
| Per-source exemplars | **MIGRATE** | This is the user's accumulated accuracy and it is irreplaceable |
| Correction corpus | **MIGRATE** | Same, plus it is the v2 training data |
| Metrics ledger | **MIGRATE** | The only accuracy baseline that exists |
| Calibration thresholds | **REBUILD** whenever `stack_id` changes | They are stack-specific by construction |
| Tier C endpoint config | MIGRATE (when Tier C exists) | Otherwise the app silently regresses on a phone the user believes is "the same one" |

### 12.4 Entitlement seam (cheap now, expensive later)

A single `Entitlements` interface with a locally signed cache, with every gateable feature routed through it **while it always returns unlocked**. StoreKit 2 verifies transactions locally via JWS (`Transaction.currentEntitlements`); Play Billing's local `Purchase` signature verification is the analogue — so a serverless paid tier is feasible, **but only if no feature gate ever requires cross-platform identity.** Decide now that entitlement is per-store-account and state it in the listing. One interface file; no pricing decision required (§14, correction C5).

---

## 13. Consolidated gap register

**Reading notes.** V1–V9 are carried forward unchanged from the prior table and are not reproduced here — the head of that draft was not supplied to this pass, and their absence is a known hole in this artifact, not a deletion. V10–V25 keep their original IDs with revised pass criteria, because §13c and the review findings reference them by number. V0 and V26+ are new.

**Kinds:** `SPIKE` = device or code experiment · `GATE` = permanent CI or release check · `DESIGN` = a decision this document owes · `EXTERNAL` = owned outside engineering · `ANSWERED` = settled by this pass, with the answer inline.

### 13a. Decisions log (additions to research §9a)

| # | Decision | Choice |
| --- | --- | --- |
| 8 | Extraction contract | **Schema-constrained JSON** (Zod-validated `ExtractionResult`); tool calling is an optional transport |
| 9 | Model delivery | **iOS ODR + Play Asset Delivery**, no self-hosted CDN; no copy-out; resolve path or fd per launch |
| 10 | OTA | **Deleted from v1**; `expo-updates` embedded-only; signed static JSON channel for templates + remediation |
| 11 | Tier C | **Deferred out of v1** |
| 12 | Crash/diagnostics | **User-initiated per report**; zero-collection declaration preserved |
| 13 | iOS v1 engine | **Recommend Apple Foundation Models + OCR + manual; LiteRT-LM on iOS deferred to v1.1 behind V0.** *Requires a decision-owner's explicit yes/no — this changes a locked decision on one platform* |
| 14 | Ship order | **Android first** |

### 13b. Verification and gap table

| ID | Kind | Question / risk | Pass criterion or action | Owner | When | Blocks |
| --- | --- | --- | --- | --- | --- | --- |
| **V0** | SPIKE | Is there any LiteRT-LM revision that is simultaneously buildable, digit-correct and memory-viable on iOS? | 200-prompt digit canary on a physical iPhone 15 Pro across `{v0.12.0, HEAD after 840fe9ed, newest tag} × {Metal, XNNPACK}`; deliverable is one table of {compiles, digit-exact %, peak RSS}. **Throwaway Swift CLI — no RN, no Nitro, no repo layout** | iOS eng | **Week 1** | Everything on iOS; the §16 stop-loss |
| **V0-A** | SPIKE | Same on Android | Kotlin CLI, same canary, on Pixel/Galaxy **and** a Dimensity/Mali-G715 device | Android eng | Week 1 | Everything on Android |
| **V10** | SPIKE | 50-receipt soak | **Rewritten:** record tok/s, thermal state, battery delta **and peak + steady-state RSS per iteration**; assert **RSS monotonic non-growth** and digit-exactness spot checks. One manual run per platform when the engine is stable — **not a nightly harness** | Android eng | After V0 green | Batch size config value |
| **V11** | SPIKE | Does `litert_lm.adb` ship in the `litert-lm` PyPI wheel? | `pip install litert-lm==0.14.0 && python -c "import litert_lm.adb"`. Low priority; documented fallback exists (`adb push litert_lm_main` + `prebuilt/android_arm64/*.so`, `LD_LIBRARY_PATH`, `taskset f0`) | Android eng | Opportunistic | Convenience only |
| **V12** | **ANSWERED** | Is `RunTextScoring` reachable from the bindings? | **Yes.** `litert_lm_session_run_text_scoring`, `litert_lm_responses_get_token_scores_at`, `..._has_score_at` are exported from `c/engine.h` [VERIFIED symbol, 2026-08-02]. Consumption **deferred to v2** (§8.4) | — | Done | — |
| **V13** | SPIKE | Are cloned conversations independent? | **Rewritten from "does the call work" (the symbol exists, so as written it passes and teaches nothing).** Clone twice from one prefilled conversation, send a different receipt to each, ask clone A about content only given to clone B, assert A cannot see it. 30 min | iOS eng | Week 2 | Prefill-once/clone-per-receipt batching |
| **V14** | **ANSWERED / DELETED** | Does `--num_output_candidates > 1` diversify the seed? | **No setter exists in the C API** [VERIFIED, 2026-08-02]. `litert_lm_sampler_params_set_seed` allows N sequential seeded runs at N× cost — the expensive form, with no v1 consumer. **Feature deleted.** Recorded here so nobody re-opens it as a quick win | — | Done | — |
| **V15** | SPIKE | Does NLS alone keep the process alive without a foreground service? | Grant access, `am kill <pkg>`, post from the companion APK, assert rebind + backfill — **and repeat on a Xiaomi/MIUI and a Motorola device with autostart restrictions active** (the OEM case is the real question) | Android eng | Week 3 | Whether the FGS declaration path disappears |
| **V16** | SPIKE | Do visual token budgets change F1 on dense thermal receipts? | Sweep **280 vs 1120 only** (skip 560) on 50 real receipts for F1, prefill latency, peak memory. Reachable via `litert_lm_conversation_optional_args_set_visual_token_budget` [VERIFIED symbol] | ML eng | After V32 | VLM escalation budget |
| **V17** | **DEFERRED to v1.1** | Does BGProcessingTask escape the Metal background prohibition? | Working assumption: **refused**. Plan iOS as foreground-only and stop spending on it. If revisited: `BGProcessingTaskRequest` with `requiresExternalPower=true`, one trivial Metal compute buffer, check for `kIOGPUCommandBufferCallbackErrorBackgroundExecutionNotPermitted` | — | v1.1 | iOS background inference (assumed absent) |
| **V18** | **DEFERRED with Tier C** | Local Network prompt under Tailscale, per configuration | Physical device only — the simulator cannot test local network privacy at all | — | When Tier C returns | — |
| **V19** | GATE | Does `CLiteRTLM.xcframework` ship a signed `PrivacyInfo.xcprivacy`? | `unzip -l` and inspect | iOS eng | Before first ASC upload | App-level privacy manifest aggregation |
| **V20** | GATE | Which required-reason API codes cover disk-space and file-timestamp calls? | Read Apple's **current** required-reason API table at build time — do not use recall. `NSPrivacyAccessedAPICategoryDiskSpace` is the one the RN template does not cover | iOS eng | Before first ASC upload | First ASC upload passing |
| **V21** | GATE | Manifest / plist / declaration drift | **Extended:** allowlist **plus** named denylist (§10.3) **plus** `ITSAppUsesNonExemptEncryption` presence **plus** negative assertion on `NSAllowsArbitraryLoads` and app-wide `usesCleartextTraffic` **plus** agreement between privacy manifest, Data Safety answers, nutrition label and actual outbound hostnames. Downgrade to a pre-submission checklist until CI exists | Release owner | From first build (or first submission if CI is deferred) | Every submission |
| **V22** | **DELETED** | `expo-updates` against a self-hosted xprem server | Deleted under both readings (§10.5). `expo-updates` stays embedded-only | — | — | — |
| **V23** | SPIKE | Is a Nitro-generated package reachable under `expo.autolinking.searchPaths`, or does nitrogen need `packages/` specifically? | Five minutes, before the folder structure is frozen. Also confirm `react-native-nitro-modules@0.36.5` on RN **0.86.2** (its devDep pins 0.85.3) | Any eng | **Week 1** | §2.3 repo layout |
| **V24** | **ANSWERED / RESTRUCTURED** | Does Maestro 2.8.0 drive real iOS devices? | **No — Simulator-only locally; physical devices route to Maestro Cloud** [VERIFIED — docs.maestro.dev]. **Delete Maestro from the iOS plan**; keep it on Android. `react-native-harness@1.3.0` scoped to Android native-module unit tests only | QA owner | Done | §10.4 |
| **V25** | **DEFERRED to v2** | HF-checkpoint vs converted-`.litertlm` eval parity | It is a v2 attribution harness for a fine-tune that has not started. Build it when the fine-tune starts | — | v2 | Fine-tune accuracy attribution |
| **V26** | GATE | Are Google's prebuilt `libLiteRT*.so` 16 KB aligned? | `llvm-objdump -p libLiteRT*.so \| grep LOAD` — every LOAD must read `align 2**14`. Then permanent CI alignment gate over every bundled `.so` incl. whisper.rn and any crypto `.so` | Android eng | **Week 1** | **Any Play upload at all** |
| **V27** | SPIKE | Does constrained decoding actually emit schema-valid JSON, on both backends, **and is it reachable from the Swift wrapper?** | Symbols exist [VERIFIED]; behaviour unknown. #2686 reports Swift cannot resolve the adjacent `sampler_params` family. 200 extractions, assert 100% schema-valid parse. **If Swift cannot reach it, §4.1's fallback (prompt + validate + bounded repair retry) becomes the iOS path** | ML eng | Week 2 | §4.1 contract |
| **V28** | SPIKE | Does the tool-call / multi-turn continuation crash natively? | 200 consecutive single-turn extract-and-continue cycles on one physical Android device; assert no native crash. This is the shape #2977 reports | Android eng | Week 2 | Whether tool calling is used at all |
| **V29** | SPIKE | Does GPU decode survive multi-turn on Mali-G715 / Dimensity? | 20 consecutive multi-turn extractions on GPU; assert no `CL_INVALID_COMMAND_QUEUE` (#2421). Plus E4B vs E2B peak RSS on a ~6 GB device, plus install-and-load of the full artifact at realistic free space | Android eng | **Week 1–2** | The E4B-on-Android choice; the GPU allowlist |
| **V30** | SPIKE | Does image input work on physical iOS and Android hardware? | Assert non-nil result on a physical device; #2979/#2370 report `Node number 1480 ... failed to prepare` | ML eng | Week 2 | Decision 3 (VLM escalation) |
| **V31** | SPIKE | Does Gemma 4 native audio input work, and can audio + constrained output be used in one pass? | Pass/fail bar set before running: WER on accented multi-currency utterances, latency at the E2B floor. Fallback `whisper.rn@0.7.2` q8_0, ~57 MB | ML eng | Week 3 | Decision 4 |
| **V32** | SPIKE | Is a PAD-delivered `.litertlm` stored **uncompressed and mmap-able**, and what compressed sizes does Play report? | Upload a real 3-pack split to the internal track; verify Play's reported **compressed** sizes are each ≤1.5 GB; verify the engine can mmap the delivered file | Android eng | Week 3–4 | Android model delivery |
| **V33** | SPIKE | ODR: does a held `NSBundleResourceRequest` survive an inference session, and how does eviction present? | Verify path re-resolution per launch; verify `create_from_raw_file_descriptor` accepts the ODR fd | iOS eng | v1.1 (with iOS engine) | iOS model delivery |
| **V34** | GATE | Does the engine report **ready** when a model section failed to mmap? | Known-answer smoke inference after every engine init; fail closed (#2545) | Native eng | Week 2 | Invariant R-ENG-2 |
| **V35** | DESIGN | Store-delivered packs version with the app bundle — is independent model update possible at all? | Verify on both stores. Shrinks the JS↔model skew problem; removes independent model hotfix | Release owner | Week 4 | §7.3 versioning design |
| **V36** | SPIKE | Does a LoRA adapter load at runtime, and does it change output? | `set_lora_path` + `set_supported_lora_ranks` exist [VERIFIED symbol]. If yes, a v2 fine-tune ships as MBs on the same base — feeds the v2 FunctionGemma-vs-LoRA comparison without reopening the locked v2 plan | ML eng | v1.1 | v2 cost model |
| **V37** | SPIKE | Does the same `.litertlm` load on both the Kotlin and Swift bindings at the same version? | #2341 reports the v0.12.0 Kotlin SDK rejecting files the v0.12.0 Swift xcframework loads. Version the download manifest by `(platform, binding_revision, variant)` | Native eng | Week 3 | §7.3 manifest shape |
| **V38** | GATE | Money-grammar and locale normalisation | Eval slice of MX/BR/CO/RU number formats; assert exact minor-unit equality; assert the model never emits a JSON number for money | ML eng | Week 4 | §4.3 |
| **V39** | GATE | Adversarial slice | Injection strings, oversized bodies, bidi overrides, receipts with printed instructions; assert zero delimiter leaks and zero cap violations | ML eng | Week 4 | §4.2 |
| **V40** | DESIGN | Gemma distribution artifacts | Notice file shipped with the asset; in-app licenses screen; "modified" notices on converted/quantised/LoRA artifacts; **Prohibited Use Policy pass-through clause in the EULA before the first public build** | Product + legal | **Week 1** | First public build |
| **V41** | EXTERNAL | Does the chosen SQLite binding link its own crypto library, and which one? | Determines `ITSAppUsesNonExemptEncryption`, ERN/CCATS need, and a 16 KB alignment target | Data-layer workstream | **Week 1** | First ASC submission |
| **V42** | SPIKE | Does Android OTP redaction swallow transaction alerts from Nubank, BBVA México, Banorte, Itaú, Mercado Pago? | Real devices, real accounts or a faithful companion-APK reproduction | Android eng | Week 3 | §11.4 listing claims; capture coverage |
| **V43** | EXTERNAL | Top LATAM bank SMS/push templates, and what share a deterministic parser resolves without the LLM | **This number sets the entire background battery budget** and the READ_SMS declaration | Product + Android eng | Weeks 2–6 | §5.5, §5.3, battery budget |
| **V44** | EXTERNAL | armeabi-v7a / 32-bit share and the dominant Motorola/Xiaomi models in MX and BR | If non-trivial: a manual-entry-only tier plus a Play device-targeting rule, both affecting the listing | Product | Week 2 | Device floor; store listing |
| **V45** | GATE | Frankfurter coverage for COP, CLP, PEN, ARS, RUB; range endpoint + NDJSON behaviour | Confirm before promising multi-currency reporting for those markets | Any eng | Week 4 | §6 |
| **V46** | GATE | Notification allowlist filter runs **before** any persistence or logging | Static assertion in review + a unit test that a non-allowlisted package produces zero writes and zero log lines | Android eng | From first build | §5.2 / Play spyware exposure |
| **V47** | DESIGN | The "why this is not spyware" memo | One page in the repo; serves as Play appeal, Data Safety rationale and permissions justification | Android eng | **Week 1** | Play declarations |
| **V48** | DESIGN | Erasure enumeration + first-launch orphan-key reconciliation | Ordered, resumable, verifiable end state; reconciliation offers a clean reset | Data-layer + app eng | Week 6 | §12.1, §12.2 |
| **V49** | GATE | Circuit-breaker behaviour | Force two unclean native starts; assert GPU→CPU downgrade; force a third; assert Tier B disabled with a visible explanation | Native eng | Week 5 | §9.3 |
| **V50** | DESIGN | Reviewer demo path exists as a shipping feature | "Test your setup" + "Try it with a sample" in main navigation, working with zero model bytes | App eng | Week 5 | Both store submissions |

### 13c. Open questions owned by other people

**Data-layer workstream:** all of §2.5 · the single SQLite binding choice · the DB-key-in-JS resolution · DB in app container vs App Group · **whether the binding links its own crypto library and which one (V41 — submission-blocking, not just architectural)** · whether the backup/export format is passphrase-derived (if so, unify with the biometric-invalidation recovery passphrase) · the Android Keystore auth-timeout shape.

**Capture→transaction pipeline workstream:** a stable idempotency key on every capture envelope · a test-only DB reset/seed hook · **this module emits schema-validated JSON, not tool-call objects, and never executes tools itself** (§4.1 — this is now an answer, not a question) · whether the transaction/not-transaction filter is LLM-based (then it is evaluated in §8 and needs a gated negative slice) or rule-based (then it is theirs and we need only the interface).

**Product, with a name and a date against each:**
- **The two numbers that parameterise every gate in §8:** target auto-accept coverage, and the maximum acceptable error rate among auto-accepted extractions. Neither can be chosen by engineering. Until they exist, §8.4 ships proxies and logs them.
- **Decision 13** (iOS v1 without LiteRT-LM) — yes or no.
- Whether the category taxonomy exists and its inter-annotator agreement.
- **Whether Colombian pesos ship at launch — the COP exponent must be settled before the first row is written.**
- Whether Russian receipt capture ships in v1 or the app is UI-translation only there.
- How many real receipts can be collected per market and by when — this sets the smallest regression §8 can detect.
- Retention policy for OCR text and receipt images attached to corrections.
- **Submission entity: whether the app is submitted under the platacard.net corporate account, and the 3.2.1(viii) reading that creates** (§11.3) — decide **before** listing copy is written.
- **Budget for the recruited beta cohort** (§9.6) — the line item that substitutes for telemetry.
- Whether a per-transaction FX override is offered in markets with a parallel rate.

---

## 14. Accepted with correction

These reviewer findings are implemented in a **stronger** form, not declined. The correction is named.

- **C1 — `stack_id` composition.** Accepted; **app build number removed from the hash.** Including it changes `stack_id` on every release, explodes the registry, and invalidates every calibration threshold on every build even when nothing affecting model output changed. The app build is a separate column on the row.
- **C2 — bank/notification allowlist.** Accepted that filtering must happen on the first line of `onNotificationPosted`, before persistence. **Rejected: "a compile-time constant list."** It conflicts with the template-rot finding (a bank list is exactly the artifact that rots on someone else's schedule), it forces a store release for a data change, and it violates the project's own no-hardcoding rule. Replaced with **signed shipped configuration** (§9.4) evaluated at the first line of the callback — still no wildcard, still no regex over package names, still no "learn new senders" mode, and the signature makes it as demonstrable to a reviewer as a constant.
- **C3 — bank template pack transport.** Accepted as a versioned data artifact. **Rejected: shipping it over the `expo-updates` OTA channel.** That reintroduces the self-hosted OTA server that the same review round deleted for negative ROI. A signed static JSON file gets the same fix latency at a small fraction of the operational surface, and it carries the remediation manifest and the backend policy on the same mechanism.
- **C4 — ODR and Guideline 2.5.2.** Accepted that ODR is the right mechanism and materially strengthens the position. **Softened: it does not remove the 2.5.2 argument "outright."** 2.5.2 speaks to downloading code that introduces features; weights are data under either delivery mechanism, and a reviewer may still ask. Keep the written answer in Notes for Review regardless.
- **C5 — entitlement/monetisation.** Accepted: build the `Entitlements` interface seam now, one file, always returning unlocked; decide that entitlement is per-store-account. **Declined as v1 scope:** the pricing, LATAM payment-rail and conversion analysis. The one part that must survive is the egress argument, and it has already done its work — it is part of why §7.1 chose ODR/PAD.
- **C6 — self-consistency confidence.** Accepted that V14 is deleted. **Corrected: it is not strictly unreachable** — `litert_lm_sampler_params_set_seed` supports N sequential seeded runs. It is unreachable *cheaply*, and it has no v1 consumer. Recording the distinction so nobody re-opens it believing they found a loophole.
- **C7 — V10 scope.** Two reviewers disagreed: one said downgrade the nightly soak to a manual run, the other said it must assert RSS monotonicity. Both accepted: **manual run, but RSS monotonicity becomes its primary assertion**, ahead of tok/s.
- **C8 — the iOS contingency's coverage.** Accepted that a named iOS fallback must exist and the seam must be built now. **Corrected: the fallback is not equivalent.** Apple Foundation Models has an A17 Pro floor, so it covers iPhone 15 Pro and newer only — a small LATAM share. The reviewer's "40% of the engineering for 85% of the value" framing holds for the *Android-first* half of the argument and overstates the iOS half. Below A17 Pro, iOS v1 is OCR + deterministic + manual, and the listing must not promise otherwise.

---

## 15. Rejected findings

- **R1 — "Under the strict reading, ship an opt-in aggregate accuracy-counter upload; it is the only way you will ever know your per-market correction rate."** Rejected. This conflates the *unresolved* boundary (build and developer infrastructure) with the *settled* one (user data). The strict reading licenses hosted CI, a hosted macOS builder and a hosted crash vendor; it does not license shipping user-derived accuracy counters off-device, however aggregated, salted or day-granular. Per-field correction rates keyed by sender hash and currency are derived from the user's financial activity. **The gap is real and is accepted** — it lands as the local metrics ledger (§9.1), the user-initiated diagnostic bundle (§9.2), and the funded beta cohort (§9.6). Only the remedy is rejected.
- **R2 — "Front-load a nightly thermal-soak harness, a CI manifest gate from the first build, and a conversion-parity gate in v1."** Rejected as sequencing for a 2–4 person team. Each is individually reasonable and collectively they build measurement scaffolding for a product before establishing that its engine works. V10 becomes manual, V21 becomes a pre-submission checklist until CI exists, V25 moves to v2. The one exception, kept as a week-one CI gate, is **V26 (16 KB alignment)** — because it is the only gate whose failure blocks all uploads and whose remedy is a multi-day source build.
- **R3 — "Build the remediation manifest so it can disable a device class, and serve it from the self-hosted model origin."** The manifest is accepted; the origin coupling is rejected. Serving remediation from the same origin as a 3.66 GB asset means a delivery outage also blocks the fix. Different hostname, different path, long TTL, last-good fallback (§9.4). With ODR/PAD the model does not come from our origin at all, so the coupling would have been to an origin that no longer exists.
- **R4 — "Reconsider ODR/PAD explicitly rather than by default" (implying self-hosting might still win on Android).** Rejected as a live option for v1. Self-hosting the Android model download reintroduces a foreground service, the `dataSync` ~6-hour cap, an FGS type declaration, an FGS demo video, our own resumability and integrity code, and the egress bill — in exchange for zero privacy gain on a file containing no user data. It stays rejected unless V32 shows a PAD-delivered `.litertlm` cannot be mmap'd, which would be a genuine forcing function.
- **R5 — "Add a persistent ongoing status notification while capture is enabled" as an unconditional requirement.** Accepted in substance, rejected as unconditional. If V15 shows NLS survives without a foreground service, the ongoing notification is a **visibility** choice (which we still make, for the spyware-signature reason in §5.2) rather than an FGS obligation. The distinction matters because it changes whether the Play FGS declaration and its demo video are required, and a plan that treats them as mandatory pays for both unnecessarily.

---

## 16. Build sequence and what to defer

### 16.1 The scope statement, plainly

The reviewed plan demands, at minimum: Kotlin plus adb/`taskset`/`LD_LIBRARY_PATH` device plumbing; Swift, ObjC++ and Apple platform law (privacy manifests, required-reason APIs, BGProcessingTask, Metal background rules, Local Network privacy); C and C++ against a hand-bound C API; React Native plus Nitro/nitrogen; PyTorch, PEFT-merge, torch-export and quantisation; and self-hosted server operations. That is six disciplines. Research §9c then adds a standing ops estate — self-hosted CI with a patched macOS runner, an OTA server, crash reporting, a device lab, and key custody with no hosted secret manager — that does not shrink after launch. §13c hands work to a "data-layer workstream", a "pipeline workstream" and "product", which at 2–4 people are the same people.

**This is roughly two to three times deliverable capacity.** The cuts below are written as deletions, not as "consider deferring".

**Staffing reality check:** if you cannot name the individual who owns the macOS build host **and** the individual who owns the C++ binding, and they are different people, the plan does not have the headcount it assumes.

### 16.2 Deleted from v1

| Deleted | Recovered capacity | Where it goes |
| --- | --- | --- |
| Self-hosted OTA server (V22, xprem, code-signing rehearsal) | ~3 engineer-weeks + permanent on-call | Signed static JSON channel (§9.4) |
| Tier C self-hosted endpoint | ~2 weeks + V18 + ATS/Local Network work + both stores' "data collected" declarations + the strongest backdoor-reading input | v1.1, behind an explicit consent sheet |
| Confidence calibration apparatus (V12 consumption, V14) | ~2 weeks, and they are the two weeks V0 needs | v2, once product sets the two numbers |
| Conversion-parity harness (V25) | ~1 week | When the fine-tune starts |
| iOS background inference (V17) | ~1 week of spikes on an assumption already believed false | v1.1 |
| Nightly soak automation, CI manifest gate infrastructure | ~1.5 weeks of harness maintenance | Manual soak; pre-submission checklist |
| Self-hosted iOS device farm | unbounded | Never. Buy it (strict) or do it manually (maximal) |
| Maestro on iOS | ~1 week of dead-end work | Deleted; Maestro stays on Android |
| **LiteRT-LM on iOS in v1** *(pending decision 13)* | ~4–6 weeks and the largest single risk | v1.1, gated on V0 |

### 16.3 The order of work

**Weeks 1–2 — prove the engine before building anything around it.** No RN, no Nitro, no repo layout, no CI. Throwaway CLIs in `tools/spikes`.
- V0 / V0-A digit-fidelity revision matrix, iOS and Android, both backends, RSS recorded.
- V26 16 KB alignment on Google's prebuilts — this can block every Play upload and its remedy is measured in days.
- V29 Mali/Dimensity multi-turn GPU, on phones bought this week for under $500.
- V13 clone independence, V34 false-ready smoke, V28 tool-call continuation stress, V27 constrained decoding + Swift reachability, V30 image input.
- In parallel, zero-engineering: V47 spyware memo, V40 Gemma notice + EULA clause, V41 asked of the data-layer workstream, V23 repo layout, and the §11.3 seller-name/listing decision put in front of product.

**Weeks 3–4 — the thinnest possible vertical slice.** RN screen → Nitro module → model acquisition → one real receipt → one extracted amount rendered on screen, on a physical device of each platform in scope. This exercises every integration boundary at once and is where the surprises live. **It must exist before month two.** V32 PAD split and mmap-ability lands here, because it constrains the slice.

**Weeks 5–8 — the layers, in dependency order.** Capture (NLS + allowlist + health monitor + V15) → normalisation and money grammar (V38) → confirmation UI → metrics ledger and circuit breaker (V49) → demo/reviewer path (V50) → adversarial slice (V39) → erasure and reconciliation (V48).

**Weeks 9–12 — the release surface.** Store listing written to measured numbers, declarations and manifests reconciled (V21), FX backfill, storage screen, staged rollout, Play internal-track upload with real compressed pack sizes, permissions-declaration evidence collection started for the v1.4 READ_SMS ask.

**Everything else comes after the slice is green.** The soak, the parity gate, calibration, the fine-tune.

### 16.4 The single riskiest item, and its fallback

**Riskiest: Gemma 4 via LiteRT-LM producing correct digits at acceptable speed on the hardware the target market actually owns.** It is a single point of failure by construction — locked decisions 2, 3 and 4 route text extraction, hard-receipt vision and voice through one binding, so unwinding one unwinds all three. It has two independent failure modes already reported in the field: Metal digit corruption on iOS (#2814) and Mali GPU death after 1–3 turns on Android (#2421), the second of which is the primary market's dominant chipset family.

**Fallback, by platform, with a dated trigger:**

- **Written stop-loss: if the V0 matrix has no green cell for iOS by end of week 2, the iOS contingency activates automatically — no debate, no meeting.** iOS v1 ships extraction on **Apple Foundation Models via `@react-native-ai/apple@0.12.0`** for A17 Pro and newer, and **document scanner + Vision OCR + deterministic bank parsing + manual entry** below that floor, with `llama.rn@0.12.8` + GBNF evaluated as an optional middle rung. Coverage is partial, and the listing says so.
- **If V29 fails on Mali:** GPU moves to an allowlist in shipped configuration (§3.5), Mali-class devices run CPU with E2B rather than E4B, and if that is still unacceptable the device class falls to OCR + deterministic + manual with a visible explanation. The circuit breaker (§9.3) makes this automatic in the field rather than a store release.
- **If both fail:** the product is an OCR-and-notification expense tracker with manual confirmation, which is still shippable and still useful — and that is precisely why §11.2's "complete and useful with zero model bytes" requirement is not a store-review concession but the actual safety net for the whole programme.