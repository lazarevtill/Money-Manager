# On-device AI stack for a React Native expense manager — research

Date: 2026-08-02
Scope: iOS + Android, multi-currency. Inputs: receipt photo, voice, free text, SMS/push capture.
Assumption: "recipe" in the request = **receipt** (чек).

Status legend: **[VERIFIED]** = read from the primary/authoritative source. **[REPORTED]** = secondary source, confirm before it drives a decision.

---

## 0. Executive summary

**Hard constraint set by the product owner: no public cloud inference, ever.** Every AI path is on-device, with an optional user-owned self-hosted endpoint as the only fallback. This rules out OpenAI/Anthropic/Gemini/Textract entirely and makes Tier B (your own bundled model) load-bearing rather than optional.

1. **SMS/push capture is platform-asymmetric and this shapes the product.** Android can do passive capture; iOS cannot, at all. Budget for two different ingestion designs, not one.
2. **Play policy explicitly permits READ_SMS for budget-tracking apps** — verified from Google's own policy page. Notification listener and READ_SMS are **complementary** (different banks reach you different ways), not a safe-vs-risky choice. For a LATAM market especially, SMS coverage is not optional.
3. **Gemma 4 (April 2026) is the right on-device model family** — E4B is 3.66 GB with 25 tok/s decode on iPhone 17 Pro GPU. This is the model behind the AI Edge Gallery experience. **Recommend E4B on Android, E2B on iOS**: the published iOS figure is best-case hardware, and 3+ GB resident is at the edge of what iOS reliably allows at your 8 GB device floor.
4. **But there is no React Native binding for LiteRT-LM.** Swift support is early-preview; Kotlin is stable. Using Gemma 4 through LiteRT-LM means writing a native module — the single biggest build-cost item.
5. **One cheap spike can eliminate that cost.** llama.cpp's Per-Layer Embeddings gap for Gemma 4 E-series (issue #22243) is now closed with related PRs merged, but full parity is unconfirmed. Benchmark GGUF-via-llama.rn against `.litert-lm` on real receipts: if quality holds, you use the mature RN binding and skip the native module entirely.
6. **FunctionGemma-270M is the right long-term target** for the stated "simpler and much faster" goal, and expense entry is exactly its shape. Design the LLM layer as a function-call interface from day one so this is a model swap, not a rewrite.
7. **OCR and extraction are two separate problems.** Text recognition gives boxes of text; you still need a structured-extraction stage. A VLM can collapse both but costs far more memory.

---

## 1. Ingestion: SMS and push are NOT symmetric across platforms

### iOS — automatic capture is closed

| Capability | Verdict |
| --- | --- |
| Read SMS inbox | **Impossible.** No API; the sandbox has zero read access to the Messages store. [REPORTED, unanimous across sources] |
| `ILMessageFilterExtension` (IdentityLookup) | Sees **only unknown-sender messages**, at delivery, for spam classification. Cannot persist or export message content to the host app. Not a capture channel. [REPORTED] |
| Read other apps' notifications | **Impossible.** No `NotificationListenerService` equivalent. `UNNotificationServiceExtension` only mutates *your own* pushes. [REPORTED] |

**Consequence: the iOS ingestion tier must be user-initiated.** Design these as real features, not fallbacks:

- **Share Sheet extension** — user shares a bank SMS, a notification screenshot, or a receipt into the app.
- **Shortcuts / App Intents automation** — the user builds a personal automation ("when notification from Bank X arrives → run shortcut"). The closest legitimate thing to auto-capture; user-configured, not app-granted.
- **Screenshot OCR** — user screenshots the bank push; the app OCRs it. Reuses the receipt pipeline, so near-zero marginal cost. **This is the highest-leverage iOS feature** — one pipeline, two inputs.
- **Email receipts** — forwarded or connected mail as a parse source.

### Android — passive capture is available, two routes

**Route A — `READ_SMS`.** Play's SMS/Call Log policy requires the app to be the default SMS handler **or** match a listed exception. The exception list explicitly includes: [VERIFIED — Play Console Help 10208820]

- *SMS-based financial transactions* (UPI, transaction verification)
- ***SMS-based money management — "apps that track and manage budget"*** ← this app qualifies on its face
- anti-SMS-phishing, caller ID/spam, backup/restore, device automation, companion apps, cross-device sync, enterprise CRM, in-vehicle hands-free, system services

Caveats that still bite:
- Requires a Play Console permissions declaration and review; approval is not automatic.
- The **spyware policy separately forbids** personal-loan and budgeting apps from exfiltrating or sharing users' non-financial or personal SMS history. This app is compliant by construction: parsing is on-device, and the only off-device path is an endpoint the *user* owns and configures (§2 Tier C) — there is no third-party recipient at all. Make that argument explicitly in the declaration; it is a strong one. [REPORTED]
- SMS/Call Log data may never be used for advertising or any undeclared purpose.

**Route B — `NotificationListenerService` (`BIND_NOTIFICATION_LISTENER_SERVICE`).** The user grants access in system settings (not a runtime dialog). Needs a manifest service + intent filter and typically a foreground-service type. Shipping expense trackers use this specifically to avoid the SMS declaration. [REPORTED — a Flutter expense tracker documented doing exactly this, Apr 2026]

**Recommendation: the two routes are complementary, not alternatives — ship B first, then A.**

The honest reasoning, corrected: the *policy-safety* argument for preferring Route B does not survive the evidence. Route A's eligibility is **verified from Google's own policy page**, which names "apps that track and manage budget" outright; Route B's policy standing rests only on a secondary blog post, and no Play documentation surfaced confirming notification access is review-free for this category. Do not treat the unverified path as the safe one.

The argument that *does* survive is **coverage**, and it cuts both ways:

- **Route B catches what SMS cannot** — pushes from bank *apps*, which is where a growing share of transaction signal lives, plus SMS that surfaces as a notification. No Play declaration form, user grants it in system settings.
- **Route A catches what notifications cannot** — SMS-only banks, and users who have bank-app notifications muted or the app uninstalled.

**This matters more than usual for a LATAM-facing product** (noting the `@platacard.net` domain): Mexico and LATAM generally remain SMS-heavy for bank alerts, so dropping `READ_SMS` costs real, measurable coverage there rather than an edge case. If LATAM is the target market, plan for Route A rather than treating it as optional.

Sequencing rationale is engineering cost, not policy fear: Route B ships without a declaration round-trip, so it validates the parsing pipeline first. Add Route A once you have real coverage data showing which banks you're missing — that data also makes the declaration much easier to justify.

**Verify at build time:** the July 15 2026 Play policy announcement's exact effect on SMS use cases, and current declaration requirements for notification access.

---

## 2. On-device LLM: three tiers, all device-gated

No single engine covers the installed base. Build a capability ladder with a real fallback.

### Tier A — platform-provided models (no download, best battery, free)

**Apple Foundation Models (iOS 26+)**

- ~3B on-device model on the Neural Engine, the one behind Apple Intelligence. [REPORTED]
- **Device floor: A17 Pro or later → iPhone 15 *Pro* and newer.** Not iPhone 15 base, not iPhone 14. Macs M1+, iPads M-series. User must have Apple Intelligence enabled and be in a supported region. [REPORTED — confirm against Apple docs at build time]
- **Guided Generation / `@Generable` gives schema-constrained structured output** — exactly the receipt→JSON primitive you need, for free.
- RN access: **`@react-native-ai/apple`** (Callstack) — text generation, streaming, structured output, tool calling, Vercel AI SDK provider. Requires RN 0.80+ with New Architecture. Community alternative: `react-native-apple-llm`. [REPORTED]
- Always call the availability check; on unsupported devices session creation errors out.

**Gemini Nano via ML Kit GenAI / AICore (Android)**

- Narrow device support: Pixel 9/10 families, selected Samsung/Honor/Xiaomi flagships on Tensor, Snapdragon, and MediaTek Dimensity. Prompt API performs best on Pixel 10 (nano-v3). [REPORTED]
- APIs: Prompt API (custom prompts, alpha), Summarization, Proofreading, Rewriting, Image Description, Speech Recognition.
- **Covers a minority of the Android installed base — cannot be the only Android path.**

### Tier B — your own bundled/downloaded model (works everywhere; costs MB and RAM)

**LiteRT-LM + Gemma 4 — the AI Edge Gallery stack. Best quality/size on Android, and now viable on iOS.**

Gemma 4 shipped **2026-04-02** in five sizes; E2B and E4B are the on-device variants, using **Per-Layer Embeddings (PLE)** — each decoder layer gets its own small per-token embedding, so *effective* parameters stay far below total. [VERIFIED — ai.google.dev]

| Variant | Effective params | Context | Modalities |
| --- | --- | --- | --- |
| E2B | 2B | 128K | text, image, audio, video |
| **E4B** | **4B** | **128K** | **text, image, audio, video** |
| 12B | 12B | 256K | text, image, audio, video |
| 26B A4B (MoE) | 26B loaded / 4B active | 256K | all |
| 31B | 31B | 256K | all |

`litert-community/gemma-4-E4B-it-litert-lm` measured numbers: [VERIFIED — HF model card]

- **Size: 3.66 GB total** (2.24 GB weights + 0.67 GB embeddings). Web variant 2.97 GB.
- **Peak memory — iPhone 17 Pro: 961 MB CPU / 3,380 MB GPU. Galaxy S26 Ultra: 3,283 MB CPU / 710 MB GPU.** Far better than Gemma 3n E4B (~6.98 GB peak, effectively unusable on iOS) — but **do not read this as "fits comfortably on iOS."** That measurement is from an iPhone 17 Pro, the best case. Your actual iOS floor is the iPhone 15 Pro (8 GB, A17 Pro) inherited from the Tier A device gate, and a 3+ GB resident footprint is at the edge of what iOS reliably allows in one process. Expect to need `com.apple.developer.kernel.increased-memory-limit`, which itself raises background-termination risk. **Unverified at the 8 GB floor — benchmark before committing.**
- **Throughput — iPhone 17 Pro GPU: 1,189 tok/s prefill, 25.1 tok/s decode. S26 Ultra GPU: 1,293 tok/s prefill, 22.1 tok/s decode, 0.8 s time-to-first-token.** CPU decode is ~2x slower (9.7 / 17.7 tok/s) with 5.3 s TTFT on Android — **GPU backend is not optional for acceptable UX.**
- Runs on Android, iOS, Windows, Linux, macOS, IoT, Web; CPU / GPU / NPU backends.

**Recommendation the numbers point to: E4B on Android, E2B on iOS.** Gemma 4 E2B is 0.84 GB for mobile text-only per Google's memory table — a safe iOS default that leaves headroom at the 8 GB device floor and avoids depending on a memory entitlement. Android has both more RAM headroom on target devices and a stable Kotlin API, so it can carry E4B. Same prompt, same schema, two model files — the function-call interface in §3 makes this a config difference, not a code fork.

LiteRT-LM itself: [VERIFIED — google-ai-edge/LiteRT-LM]

- Python, Kotlin, C++ **stable**; **Swift = early preview** (iOS + macOS Swift package as of v0.13); JS early preview; Flutter community.
- **Has function-calling support for agentic workflows** built in.
- **No first-party React Native binding exists.** ← the main build cost.
- The older **MediaPipe LLM Inference API is maintenance-only**; Google directs new work to LiteRT-LM. Ignore MediaPipe-era tutorials.

**llama.rn (`mybigday/llama.rn`, v0.12.x) — broadest compatibility, mature RN binding.**

- React Native binding of llama.cpp; GGUF ecosystem, widest hardware support, largest community.
- **Multimodal**: `initMultimodal()` with an `mmproj` projector enables vision and audio; `getMultimodalSupport()` reports modalities; set `ctx_shift: false` for vision models. A VLM can read the receipt image directly.
- **Structured output**: llama.cpp converts a subset of JSON Schema (Draft 7) to GBNF grammar via `common/json-schema-to-grammar.cpp`, passed as `response_format: {type: "json_schema", ...}`. Supports string/number/integer/boolean/null/array/object with `minLength`/`pattern`/`minimum`/`minItems`/`oneOf`/`anyOf`/`allOf`. **Gotcha: the schema constrains sampling but is NOT injected into the prompt** — you must also describe the structure in the prompt or the model has no idea what it's filling in. [VERIFIED — llama.cpp grammars README]
- **⚠ Gemma 4 E2B/E4B GGUF quality is unconfirmed here — benchmark before relying on it.** llama.cpp issue **#22243** (opened 2026-04-22) reported that the GGUF loader reads PLE metadata and loads PLE weights, but the per-layer embeddings are **never executed in the forward graph**: models run without crashing and produce **silently degraded output**. The issue is now **closed**, and related PRs have merged (#21612 does per-layer projections in the first layer; #21421 added the Gemma 4 audio conformer encoder) — but I could not confirm from any source that full PLE parity with the reference implementation has landed. The issue text itself notes transformers, vLLM, MLX and TensorRT-LLM had full PLE support while llama.cpp was "loader only". [REPORTED — status genuinely ambiguous as of 2026-08-02]
  **Resolve this with a one-day experiment, not more searching:** run the same 50 receipt/utterance prompts through Gemma 4 E4B GGUF on llama.rn and through the `.litert-lm` build, and diff extraction accuracy. If GGUF holds up, you get the mature RN binding and skip the native-module cost entirely — which flips decision #2 below. This is the cheapest high-value spike in the whole project.

**react-native-executorch (Software Mansion) — the one-toolkit option.**

- Declarative RN API over Meta's ExecuTorch. Supports LLMs (Llama, Phi, others), **Whisper STT**, Kokoro TTS, **OCR (EasyOCR port) including experimental vertical OCR**, VLMs, embeddings, and CV models (YOLO, RF-DETR, MobileNet, SAM). iOS + Android.
- Structured output / tool calling not documented — verify before relying on it.
- Attractive because OCR + ASR + LLM come from one dependency with identical cross-platform behaviour.

### Tier C — optional user-owned self-hosted endpoint

**Hard product constraint: public cloud LLM/OCR services are never an option.** No OpenAI, Anthropic, Gemini API, Textract, or any third-party inference endpoint — not as a default, not as an opt-in.

The only fallback is an endpoint **the user owns and configures**: an Ollama / llama.cpp-server / vLLM / LM Studio instance on their own machine or home server, reached over LAN, Tailscale, or a self-hosted reverse proxy.

Design consequences:

- **Default is "no fallback configured".** The app must be fully functional on-device with Tiers A/B only. Tier C is a power-user setting, not a dependency.
- **Same JSON contract as Tiers A and B.** An OpenAI-compatible `/v1/chat/completions` shape is the pragmatic wire format — Ollama, llama.cpp server, vLLM, and LM Studio all speak it — so "self-hosted" is a base URL plus optional token, not a separate code path.
- **Where it actually earns its keep:** hard receipts (faded thermal paper, stains, bad lighting) where a 7–30B model on the user's desktop beats anything running on the phone, and bulk/backfill runs.
- **This removes the Play spyware risk entirely.** Nothing leaves the user's control, so SMS-derived data never crosses a third-party boundary. Say this explicitly in the privacy policy — it's also the strongest argument in a Play permissions declaration.
- Ship connection testing, a model-name picker populated from the endpoint, and explicit failure UX. Self-hosted endpoints are offline more often than cloud ones; never block capture on reachability — queue and retry.

---

## 3. FunctionGemma — the "simpler and much faster" path

Directly on target for the stated future plan.

- **`google/functiongemma-270m-it`**: Gemma 3 architecture, **270M parameters**, trained specifically to turn natural language into structured function calls. Runs comfortably on a phone. [REPORTED]
- Google's own framing: it **requires** task-specific fine-tuning to be reliable. On Google's "Mobile Actions" eval, fine-tuning moved accuracy **58% → 85%**. [REPORTED]
- Full tooling chain exists: HF model, a Gemma Cookbook fine-tuning notebook, an Unsloth tutorial, the public Mobile Actions dataset, and GGUF conversions (`unsloth/functiongemma-270m-it-GGUF`) — so a fine-tune can run through **llama.rn** on both platforms. Gemma 3 architecture means **no PLE problem**.
- Already independently fine-tuned and benchmarked on a Galaxy S23. [REPORTED]

**Scope limit — read this before planning around it.** FunctionGemma is 270M and **text-only**. It covers *utterance → function call*: voice and typed entry, and parsing already-extracted SMS/notification text. It **cannot read a receipt image**. The receipt path still needs OCR + extraction, or a VLM. So FunctionGemma is a small fast model that sits *alongside* the Gemma 4 / Apple path, not a replacement for it. "Simpler and much faster" applies to the conversational and message-parsing surface — which is most of the daily interactions, so the win is still real.

**Why it fits this app:** expense entry is a narrow, closed-schema action space — `add_expense`, `split_transaction`, `set_category`, `convert_currency`, `query_spend`. That is precisely FunctionGemma's shape, and 270M is ~15x smaller than Gemma 4 E4B with correspondingly lower latency and battery cost.

**Architecture implication — act on this in v1:** define the app's LLM layer as a **tool/function-call interface** with a fixed schema, even while v1 is served by Apple Foundation Models and Gemma 4. Then a fine-tuned FunctionGemma is a model swap behind a stable interface, not a rewrite. Also: log (locally, with consent) the utterance→function-call pairs your v1 produces — that becomes the fine-tuning dataset for free.

---

## 4. Receipt pipeline: three distinct stages

Do not conflate these. Most "OCR library" comparisons only answer stage 2.

### Stage 1 — capture (cheap, high ROI, do not skip)

Native document scanners give edge detection, perspective correction, and dewarping before OCR ever runs. This materially improves receipt accuracy for near-zero effort.

- iOS: `VNDocumentCameraViewController` (VisionKit). Android: ML Kit Document Scanner.
- RN wrappers exist that use exactly this pair: `@dariyd/react-native-document-scanner`, `react-native-document-scanner-plugin`, `@infinitered/react-native-mlkit-document-scanner`. Features: auto-detection, edge/perspective correction, multi-page, JPEG/PDF export. [REPORTED]
- **Use still-image capture, not a live frame processor.** Frame processors suit barcodes and live text; receipts want one well-framed, dewarped, high-resolution still.

### Stage 2 — text recognition

| Option | Notes |
| --- | --- |
| **Apple Vision `VNRecognizeTextRequest`** (iOS) + **ML Kit Text Recognition v2** (Android) | Best per-platform quality and speed, free, no model to ship. ML Kit v2 explicitly targets receipts/cards. Cost: two engines, two output shapes, per-platform tuning. |
| **react-native-executorch OCR** (EasyOCR port) | One engine, identical results on both platforms, no divergence to debug. Cost: ships a model, slower than native. |
| **VisionCamera frame-processor plugins** (`react-native-vision-camera-ocr-plus`, `@bear-block/vision-camera-ocr`, `react-native-vision-camera-mlkit`) | Live OCR per frame. Good for scanning UX, overkill for receipts. |

On accuracy: for clean printed text, on-device now matches server-side. The gap opens exactly where receipts live — **faded thermal paper, stains, poor lighting** — where larger models still win. Since public cloud is off the table, the answer for hard receipts is the user's own self-hosted endpoint (Tier C) plus a good manual-correction UI — not a third-party API. [REPORTED]

### Stage 3 — structured extraction (the actually hard part)

Turning text boxes into `{merchant, date, total, currency, tax, line_items[]}`.

- **Text-LLM route:** OCR text → LLM with a constrained JSON schema (Apple `@Generable`, llama.cpp GBNF, LiteRT-LM function calling). Cheaper, works with any OCR engine, loses spatial layout.
- **VLM route:** image → model → JSON, collapsing stages 2 and 3. Gemma 4 E2B/E4B accept image input natively, so this is free if you're already running one. Preserves layout information, which matters for line items and column alignment.
- Evidence on small VLMs for receipts specifically: a fine-tuned Qwen3-VL-8B reaches **0.7950 F1** on a real-world receipt-understanding benchmark, beating Gemini-3-Pro (0.7373) and GPT-5 (0.7076); compact **InternVL3-2B (SFT) reaches 0.6496 F1**. Two readings: (a) fine-tuning a small VLM on receipts beats giant general models, (b) **even the best numbers are ~0.80 F1 — always show the user an editable confirmation screen.** SmolVLM-256M is too weak for complex OCR. [REPORTED — arXiv 2605.22413]

**Recommendation:** native document scanner → native OCR (Vision / ML Kit) → LLM extraction with a hard JSON schema, with a VLM path as a later upgrade if the text-only route loses too much layout. Never auto-commit a parsed receipt; confirmation UI is a correctness requirement, not polish.

---

## 5. Voice input

| Option | Trade-off |
| --- | --- |
| **`@react-native-voice/voice`** (native `SFSpeechRecognizer` / Android `SpeechRecognizer`) | Nothing to bundle, tiny app. But Android behaviour varies by OEM and offline works only if the user happens to have the language pack. Unreliable for a multi-currency, multi-language audience. |
| **`whisper.rn`** (whisper.cpp binding) | Ships its own recognizer → identical on both platforms, guaranteed offline. tiny/base = 75 MB / 142 MB, quantized 31 MB / 57 MB; runtime ~273 MB for tiny. On Apple Silicon the encoder offloads to the Neural Engine via CoreML for a 2–3x speedup. `q8_0` halves memory with no perceptible accuracy loss. |
| **react-native-executorch Whisper** | Same model, bundled with the OCR/LLM toolkit you may already be using. |
| **Gemma 4 E2B/E4B native audio input** | E2B/E4B accept audio directly — no separate ASR stage at all. Speech → structured expense in one model pass. Highest-upside, least-proven option; worth a spike. |

**Recommendation:** whisper.rn `base.en`-class quantized for v1 (predictable, cross-platform, small). Keep the Gemma 4 direct-audio path on the list as a spike — if it works it deletes a whole subsystem.

---

## 6. Multi-currency

Two separate problems; the second one breaks the "fully offline" premise.

**Currency detection is ambiguous.** `$` is USD, CAD, AUD, MXN, SGD, and more. Symbol matching alone will silently mis-record. Use, in priority order: explicit ISO code in the receipt text → merchant country / locale → device region → user's default account currency. Store the detected currency **with a confidence value** and surface it on the confirmation screen.

**Historical FX rates require network.** Storing only a converted home-currency amount is a data-loss bug — always persist `(original_amount, original_currency, fx_rate, rate_date, converted_amount)` so a later rate correction can re-derive totals.

- **Frankfurter** (`frankfurter.dev`) — free, open source, no API key, no daily/monthly caps, ECB reference rates from 84 central banks, 201 currencies, current + historical, **self-hostable via Docker**. Weakness: ECB-derived, so no weekend data and thin coverage outside majors. [REPORTED]
- **Fits the no-public-cloud stance well.** Rates are public reference data, not user data — no expense information is ever sent to fetch them, so this is a very different privacy proposition from a cloud LLM. Still, make the rate endpoint **configurable** so a user who wants zero third-party calls can point it at their own Frankfurter container. Same pattern as the Tier C endpoint setting.
- Cache pattern: refresh once daily after the ~16:00 CET ECB publish, TTL 12–24 h, keep the last good response as fallback.
- Ship a **seed rate table in the bundle** so a fresh install works offline on day one.

**State this in the design:** the app is fully offline for *capture*; cross-currency *reporting* is accurate only as of the last rate sync.

---

## 7. Model delivery and app size

A 3.66 GB model cannot sit in the base binary.

- **iOS On-Demand Resources:** iOS 18+ allows **up to 8 GB per thinned asset pack**, max 1,000 packs, up to 70 GB hosted total. (Pre-iOS-18: 512 MB per tag, 20 GB total.) Apple explicitly recommends ODR for models over 500 MB. [VERIFIED — App Store Connect help]
- **Android Play Asset Delivery:** replaces legacy OBB expansion files for artifacts over 200 MB; single artifact published to Play. [REPORTED]
- **Alternative: download from your own CDN on first use.** Simpler, avoids store-specific plumbing, but you own the bandwidth bill, resumability, integrity checking, and the "user deleted it to free space" case.

**Consequences to design for now:** first-run model download on Wi-Fi with a progress UI; the app must be fully usable (manual entry, OCR) before the LLM is downloaded; a "free up space" affordance that deletes the model and degrades gracefully to Tier A, to a configured Tier C endpoint, or to manual entry.

**iOS memory:** jetsam kills on `resident_size`. `com.apple.developer.kernel.increased-memory-limit` and extended virtual addressing raise the ceiling — **but only on some device models, and they also raise the probability of background termination.** LLM inference engines `mmap()` sub-models as separate regions, which interacts badly with this. Assume the model is evicted whenever the app backgrounds, and make reload cheap. [REPORTED]

---

## 8. Recommended architecture

```text
                 ┌──────────── capture ────────────┐
  receipt photo ─┤ doc scanner (VisionKit/ML Kit)   │
  voice ─────────┤ whisper.rn                       ├─→ ┌─────────────────┐
  text ──────────┤ direct                           │   │  EXTRACTION     │
  Android push ──┤ NotificationListenerService      │   │  fixed JSON     │
  iOS share ─────┤ Share Sheet / Shortcuts / OCR    │   │  schema +       │
                 └──────────────────────────────────┘   │  tool interface │
                                                        └────────┬────────┘
                                        ┌────────────────────────┼────────────────────────┐
                                   Tier A                    Tier B                   Tier C
                        Apple Foundation Models       Gemma 4 E4B (LiteRT-LM)     user's SELF-HOSTED
                        (iOS 26+, A17 Pro+)           / FunctionGemma (llama.rn)  endpoint (opt-in)
                        Gemini Nano (few Androids)    downloaded on first use     NO public cloud
                                        └────────────────────────┼────────────────────────┘
                                                                 ↓
                                                   user confirmation screen  ← always
                                                                 ↓
                                                   encrypted local DB + FX table
```

**The one interface that must be right from day one:** a fixed function-call schema for expense operations. Every tier implements it; Apple via `@Generable`, llama.rn via GBNF, LiteRT-LM via built-in function calling, cloud via native tool calling. Get this stable and every model decision below it becomes reversible.

---

## 9a. Decisions taken (2026-08-02)

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Android capture | **Both — NotificationListenerService first, add READ_SMS after** |
| 2 | On-device LLM engine | **LiteRT-LM native module** (not the llama.rn shortcut) |
| 3 | Receipt extraction | **Both — OCR + text LLM by default, VLM escalation for hard receipts** |
| 4 | Voice | **Spike Gemma 4 native audio input first**, whisper.rn as the fallback if it disappoints |

**These four choices are more coherent together than separately.** Decisions 2, 3 and 4 all converge on one thing: **Gemma 4 via LiteRT-LM becomes the single multimodal engine** — text extraction, image input for hard receipts, and audio input for voice, all from one model with one runtime and built-in function calling. That justifies the native-module cost in a way that decision 2 alone would not: you are not writing a native module to run a chatbot, you are writing it once and getting three modalities. E2B and E4B both support audio and image natively, so the E2B-iOS / E4B-Android split survives intact.

Consequences to carry into planning:

- **The llama.cpp PLE benchmark (§2) drops off the critical path.** llama.rn is no longer the primary engine, so #22243 stops being a blocker. Keep the finding — it still matters for decision 5 below.
- **Native module scope is now the main engineering risk.** It must cover: model lifecycle (download, verify, delete), GPU backend selection, text generation with streaming, function calling, image input, audio input, and graceful failure when memory is tight. On iOS this rides the **early-preview Swift package** — the single largest unknown in the plan. Budget a spike to validate the Swift API surface *before* committing to the full module.
- **FunctionGemma needs a format decision.** It is Gemma 3 architecture and ships as GGUF, which is llama.rn territory. Running two runtimes side by side would undo the simplification. Before v2, check whether FunctionGemma can be converted to `.litert-lm` — if it can, the fine-tuned model slots into the same native module. If it cannot, weigh a second runtime against just fine-tuning Gemma 4 E2B instead.
- **Decision 3 means two extraction paths from day one.** Define the confidence signal that triggers VLM escalation early (OCR per-word confidence, missing required fields, or total-vs-line-items mismatch) — retrofitting a good escalation trigger is much harder than building it in.
- **Decision 4 is a spike, not a commitment.** Define the pass/fail bar before running it: word error rate on accented multi-currency utterances, latency at the E2B iOS floor, and whether audio-in and function-calling can be used in the same pass. If it fails, whisper.rn q8_0 is the fallback and costs ~57 MB.

## 9c. Programme constraints (2026-08-02)

| # | Constraint | Choice |
| --- | --- | --- |
| 6 | No-cloud scope | **Maximal — everything self-hosted, including build/CI, OTA, crash reporting, and a device lab** |
| 7 | Team size to plan against | **Small team (2–4)** |

**Constraint 6 extends the no-cloud rule well past user data.** It now rules out EAS Build, hosted CI, Expo's OTA service, and Sentry SaaS. What it cannot rule out: **App Store Connect and Google Play Console are unavoidable** — you cannot ship to either store without them. Also unavoidable in practice: Apple's notarisation service and Play's app-signing infrastructure. State this boundary explicitly rather than discovering it later.

Concrete obligations this creates, all of which need owners:

- Self-hosted CI with a **macOS runner** — iOS builds cannot be produced on Linux. This means real Apple hardware, kept patched and on a current Xcode.
- Self-hosted OTA update server speaking the `expo-updates` protocol — and note that OTA can only ship JS, never native, so a native-module-heavy app gets limited benefit from it either way.
- Self-hosted crash reporting (GlitchTip is materially lighter to operate than full Sentry).
- A physical device lab covering the E2B-iOS / E4B-Android split and the iPhone 15 Pro / 8 GB floor — emulators cannot test GPU inference or notification capture.
- Custody of signing keys and certificates without a hosted secret manager.

**Flagging the tension once, then proceeding as directed:** constraints 6 and 7 pull hard against each other. Maximal self-hosting is roughly a standing ops workload on top of an app that already demands Kotlin, Swift, C++, React Native, and ML fine-tuning skills — with 2–4 people. The `ops-reality` reviewer in the app-layers workflow was briefed to attack exactly this, so the plan will carry an evidence-based cost estimate rather than an assertion. If that estimate lands badly, the natural staging is: ship v1 on self-hosted CI + GlitchTip + a small real-device set, and defer self-hosted OTA (lowest value here anyway) plus lab automation. **That is a suggestion, not a change — constraint 6 stands as chosen unless you say otherwise.**

## 9b. Decisions this research forces

1. **Android capture route** — notification listener first then add READ_SMS (recommended; both are eligible, they cover different banks), vs notification-only, vs READ_SMS declaration up front. Weight LATAM SMS density heavily here.
2. **On-device LLM engine** — write a LiteRT-LM native module for first-class Gemma 4, vs stay on the mature llama.rn binding. **Gate this on the PLE benchmark in §2** — a one-day spike may make the expensive option unnecessary.
3. **Extraction shape** — OCR + text LLM (cheaper, layout-blind) vs VLM (heavier, layout-aware).
4. **Voice** — whisper.rn now vs spike Gemma 4 native audio input.
5. **Backup and export** *(flagged, not researched — outside the AI scope but forced by the no-cloud constraint)* — with no cloud sync, the on-device database is the **sole system of record** for the user's entire financial history. A lost or wiped phone means total data loss. Encryption at rest plus a user-driven export/backup path (encrypted file export, self-hosted sync target, or platform backup) is load-bearing here, not polish. Worth its own research pass before the data layer is designed.

## 10. Open items to verify at build time

- **Gemma 4 PLE parity in llama.cpp** — issue #22243 is closed and PRs merged, but parity is unconfirmed. Settle it with the benchmark in §2, not by reading more issues. Decides whether llama.rn can serve Gemma 4 at all.
- **Gemma 4 E2B/E4B peak memory at the iPhone 15 Pro floor** (8 GB), not just on an iPhone 17 Pro — and whether `increased-memory-limit` is required.
- LiteRT-LM Swift package maturity beyond "early preview" for production iOS.
- Apple Foundation Models device floor and regional availability, from Apple docs.
- Current Gemini Nano / ML Kit GenAI supported-device list, and what share of your target market it covers.
- Play declaration requirements for notification access; July 15 2026 policy effects on SMS.
- Whether `@react-native-ai/apple` or react-native-executorch has stabilised structured output / tool calling.

## Sources

**Ingestion & policy**
- [Use of SMS or Call Log permission groups — Play Console Help](https://support.google.com/googleplay/android-developer/answer/10208820?hl=en)
- [Policy announcement: July 15, 2026 — Play Console Help](https://support.google.com/googleplay/android-developer/answer/17134731?hl=en)
- [Permissions used only in default handlers — Android Developers](https://developer.android.com/guide/topics/permissions/default-handlers)
- [Privacy-First Auto-Expense Tracker without READ_SMS (Flutter, Apr 2026)](https://medium.com/@owinojumahjerome/how-i-built-a-privacy-first-auto-expense-tracker-in-flutter-without-the-read-sms-api-6c7c66d56af5)
- [Creating a Message Filter Extension (ILMessageFilterExtension)](https://medium.com/@lucianboboc/creating-a-message-filter-extension-580c9957633d)

**On-device LLM**
- [Gemma 4 model overview — ai.google.dev](https://ai.google.dev/gemma/docs/core)
- [litert-community/gemma-4-E4B-it-litert-lm — Hugging Face](https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm)
- [Gemma 4 announcement — Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)
- [LiteRT-LM — GitHub](https://github.com/google-ai-edge/LiteRT-LM)
- [Blazing fast on-device GenAI with LiteRT-LM — Google Developers Blog](https://developers.googleblog.com/blazing-fast-on-device-genai-with-litert-lm/)
- [LLM Inference guide — Google AI Edge](https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference)
- [llama.cpp issue #22243 — Gemma 4 PLE not implemented](https://github.com/ggml-org/llama.cpp/issues/22243)
- [llama.rn — GitHub](https://github.com/mybigday/llama.rn)
- [llama.cpp GBNF grammars README](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)
- [React Native ExecuTorch docs](https://executorch.swmansion.com/)
- [React Native AI (Callstack)](https://www.react-native-ai.dev/)
- [On-Device Apple LLM Support Comes to React Native — Callstack](https://www.callstack.com/blog/on-device-apple-llm-support-comes-to-react-native)
- [react-native-apple-llm — GitHub](https://github.com/deveix/react-native-apple-llm)
- [Acceptable use requirements for the Foundation Models framework — Apple](https://developer.apple.com/apple-intelligence/acceptable-use-requirements-for-the-foundation-models-framework/)
- [On-device GenAI APIs with Gemini Nano — Android Developers Blog](https://android-developers.googleblog.com/2025/05/on-device-gen-ai-apis-ml-kit-gemini-nano.html)
- [ML Kit Prompt API — Android Developers Blog](https://developer.android.com/blog/posts/ml-kit-s-prompt-api-unlock-custom-on-device-gemini-nano-experiences)
- [Overview of the ML Kit GenAI APIs](https://developers.google.com/ml-kit/genai)

**FunctionGemma**
- [FunctionGemma: bringing bespoke function calling to the edge — Google blog](https://blog.google/technology/developers/functiongemma/)
- [Fine-tune FunctionGemma 270M for Mobile Actions — ai.google.dev](https://ai.google.dev/gemma/docs/mobile-actions)
- [google/functiongemma-270m-it — Hugging Face](https://huggingface.co/google/functiongemma-270m-it)
- [FunctionGemma fine-tune tutorial — Unsloth](https://unsloth.ai/docs/models/tutorials/functiongemma)
- [Gemma Cookbook fine-tuning notebook](https://github.com/google-gemini/gemma-cookbook/blob/main/FunctionGemma/%5BFunctionGemma%5DFinetune_FunctionGemma_270M_for_Mobile_Actions_with_Hugging_Face.ipynb)
- [FunctionGemma fine-tuned and tested on an S23](https://medium.com/@meshuggah22/functiongemma-i-fine-tuned-googles-270m-edge-model-and-tested-it-on-my-s23-4105d7f45d39)

**OCR & receipts**
- [Text recognition v2 — ML Kit](https://developers.google.com/ml-kit/vision/text-recognition/v2)
- [VNRecognizeTextRequest — Apple Developer](https://developer.apple.com/documentation/vision/vnrecognizetextrequest)
- [VNDocumentCameraViewController — Apple Developer](https://developer.apple.com/documentation/visionkit/vndocumentcameraviewcontroller)
- [Comparing Apple's and Google's on-device OCR technologies](https://fritz.ai/comparing-apples-and-google-s-on-device-ocr-technologies/)
- [On-Device vs Cloud OCR: Privacy, Speed, and Accuracy](https://scanlens.io/blog/on-device-vs-cloud-ocr)
- [From Recognition to Reasoning: Benchmarking MLLMs on Real-World Receipt Document Understanding — arXiv](https://arxiv.org/html/2605.22413)
- [Bringing EasyOCR to React Native ExecuTorch — Software Mansion](https://blog.swmansion.com/bringing-easyocr-to-react-native-executorch-2401c09c2d0c)
- [@dariyd/react-native-document-scanner](https://www.npmjs.com/package/@dariyd/react-native-document-scanner)
- [react-native-document-scanner-plugin](https://react-native-document-scanner.js.org/)
- [react-native-vision-camera-ocr-plus](https://github.com/jamenamcinteer/react-native-vision-camera-ocr-plus)
- [Fine-Tuning SmolVLM for Receipt OCR](https://debuggercafe.com/fine-tuning-smolvlm-for-receipt-ocr/)

**Voice**
- [whisper.rn — GitHub](https://github.com/mybigday/whisper.rn)
- [Whisper model sizes explained](https://openwhispr.com/blog/whisper-model-sizes-explained)
- [Cross-platform speech-to-text in React Native — Joche Ojeda](https://www.jocheojeda.com/2026/07/04/cross-platform-speech-to-text-in-react-native/)

**Delivery, memory, currency**
- [On-demand resources size limits — App Store Connect Help](https://developer.apple.com/help/app-store-connect/reference/app-uploads/on-demand-resources-size-limits/)
- [Google Play Asset Delivery](https://developer.android.com/guide/playcore/asset-delivery)
- [Two entitlements to boost memory allocation for iOS apps](https://zenn.dev/mtfum/articles/ios_memory_entitlements?locale=en)
- [Frankfurter — free exchange rates API](https://frankfurter.dev/)
- [Best free historical exchange rate API (2026)](https://allratestoday.com/blog/best-free-historical-exchange-rate-api-2026/)
