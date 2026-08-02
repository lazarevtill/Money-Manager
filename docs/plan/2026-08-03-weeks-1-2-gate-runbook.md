# Weeks 1–2 gate runbook

Date: 2026-08-03 · Scope: Android only · Plan: [`2026-08-03-android-v1.md`](2026-08-03-android-v1.md) §5–6

These gates run **before any app code**, as throwaway Kotlin CLIs in `tools/spikes`. No React Native, no Nitro, no repo layout. The point is to learn whether the engine works on real target hardware before anything is built on top of it.

Record every result in this file as it lands. A gate with no recorded number is not passed.

---

## 0. Device matrix

The matrix is a requirement, not a preference — several gates are chipset-specific and cannot be substituted.

| Slot | Requirement | Why it cannot be substituted | Have it? |
| --- | --- | --- | --- |
| **A — Mali** | MediaTek Dimensity, Mali-era Exynos, or Google Tensor | **V29 is Mali-specific.** Adreno cannot test it. A green run on Snapdragon would license building the GPU path on evidence that does not apply to the market's dominant chipset family | ☐ |
| **B — Adreno** | Any Snapdragon | The other half of the market; also the control that isolates whether a V29 failure is Mali-specific or general | ☐ |
| **C — low RAM** | 4–6 GB device | Decides whether E2B-on-CPU (fallback rung 2) is real. E4B is ~3.66 GB and will not fit here | ☐ |

Slot A is the one that gates the product's shape. If it is missing, buy one sub-$500 Dimensity handset before starting.

### Devices available

**Slot A is covered.** Verified over adb on 2026-08-03:

| Device | Chipset | GPU | RAM | OS | Slot |
| --- | --- | --- | --- | --- | --- |
| **Galaxy S21+ 5G** (`SM-G996B`) | **Exynos 2100** (`universal2100_r`) | **Mali-G78**, OpenGL ES 3.2, driver `r38p0` | 7.03 GiB usable (8 GB) | Android 15, SDK 35 | **A ✅** |
| Galaxy Tab S8 Ultra | Snapdragon 8 Gen 1 | Adreno 730 | 8–16 GB | — | B *(not yet verified over adb)* |
| Galaxy Z Fold 7 | Snapdragon (8 Elite class) | Adreno | 12–16 GB | — | B *(not yet verified over adb)* |

**V29 is runnable today.** The Mali-G78 on the Exynos 2100 is the exact GPU family that issue #2421 reports failing, so the gate that decides the product's shape can be exercised on hardware already in hand.

Three facts from the pull that change what this device can and cannot tell us:

1. **Page size is 4096 (4 KB), so this device cannot runtime-validate V26.** Android 15+ permits 16 KB pages, but this build does not use them. V26 therefore stays a **static, device-independent `objdump` check** on the shipped `.so` files — it cannot be discharged by "it ran fine on the S21+". Do not let a green run here be read as V26 passing.
2. **Android 15 / SDK 35 cannot exercise SDK 36 runtime behaviour.** Play requires targetSdk 36 by 2026-08-31. An app targeting 36 installs and runs here, but any behaviour gated on the *device* API level stays dormant, so foreground-service and notification changes introduced in Android 16 are untestable on this device.
3. **7.03 GiB usable is comfortable for E4B but not representative.** E4B peaks around 3.4 GB on the GPU backend; that fits here with room to spare. It says nothing about the 4–6 GB tier.

**Remaining gap — slot C and the target market.** All three devices are premium Samsung flagships. The LATAM market runs entry and mid-tier Dimensity at 4–6 GB. This set will run E4B comfortably and cannot tell us whether fallback rung 2 (E2B on CPU) is viable, which is precisely the tier Mali-class devices land on if V29 fails. **One cheap Dimensity handset remains the highest-value purchase in the project** — it covers the low-RAM tier, a second Mali implementation, and the actual market profile at once.

This gap does not block anything now. It becomes blocking before the fallback ladder can be validated or the release can claim device coverage.

---

## 1. V29 — Mali multi-turn GPU stability **(the gate that decides the product)**

**Question.** Does the GPU backend survive sustained multi-turn generation on Mali, or does it die after 1–3 turns as reported upstream in #2421?

**Run on:** slot A, then slot B as control.

**Method.**
1. Load Gemma 4 E4B `.litertlm`, GPU backend.
2. Run 20 sequential extractions, each a fresh conversation, each on a real bank-notification string.
3. Then 20 more as **multi-turn** within one conversation — this is the reported failure shape, and it differs from 20 independent calls.
4. Record after every turn: success/failure, tokens/sec decode, peak RSS, GPU driver messages from `logcat`.
5. Repeat the whole run three times from a cold start.

**Pass:** 60/60 turns complete on slot A with no driver fault and no monotonic RSS growth across turns.
**Fail:** any driver-level GPU fault, hang, or process death.

**Stop-loss — no debate, no meeting:** if slot A has no green run by **end of week 2**, adopt fallback rung 1 (GPU allowlist; Mali-class devices go CPU) immediately.

**Result:** _not yet run_

---

## 2. V26 — 16 KB page-size alignment

**Question.** Are Google's prebuilt LiteRT-LM `.so` files 16 KB-aligned?

**Why it is week 1 and not later.** Failure blocks **every Play upload**, and the remedy is a multi-day source build. Discovering this in week 10 costs the release date. It needs no special hardware — run it on day 1 regardless of the device situation.

**Method.** `objdump -p liblitert*.so | grep LOAD` and confirm alignment is `2**14`, on every shipped `.so` including transitive dependencies. NDK r28+.

**Pass:** all segments 16 KB-aligned.
**Fail:** schedule the source build immediately; it is on the critical path from that moment.

**Result:** _not yet run_

---

## 3. V0 — digit fidelity across revisions

**Question.** Which LiteRT-LM revision produces correct digits, and at what speed?

**Why digits specifically.** Amount and date are the two fields a finance app cannot get wrong, and they are exactly what the reported corruption bugs attack. General "does it produce plausible JSON" testing will pass while the product is broken.

**Method.** For each candidate revision × {CPU, GPU} × {E2B, E4B}: run a fixed set of 50 bank-notification strings and 20 receipt OCR texts with known-correct expected values. Score **exact match on amount and date**, not F1 over all fields. Record decode tok/s, time-to-first-token, peak RSS.

**Pin by `revision:`, never by version** (`app-layers.md` §3.1).

**Pass:** ≥1 revision with 100% digit exactness on the fixture set and acceptable latency.
**Note:** anything below 100% on a 70-item fixture set means silent corruption in production. This gate is pass/fail, not a score to optimise.

**Result:** _not yet run_

---

## 4. V13 — clone independence

**Question.** Do two concurrent conversation clones share mutable state?

**Method.** Create two clones from one engine, run different prompts concurrently, assert outputs are independent and neither corrupts the other. Repeat under memory pressure.

**Result:** _not yet run_

---

## 5. V34 — false-ready smoke

**Question.** Does the engine ever report ready while producing garbage?

**Method.** A known-answer inference run at startup — fixed prompt, fixed seed, assert exact expected output. This becomes a permanent runtime check, not just a spike: it is the guard that turns a silently broken model load into a caught error.

**Result:** _not yet run_

---

## 6. V32 — PAD split and mmap-ability

**Question.** Can a Play Asset Delivery-delivered `.litertlm` be mmap'd via `litert_lm_engine_settings_create_from_raw_file_descriptor`, without copying 3.66 GB?

**Why it matters.** If PAD assets cannot be loaded from an fd, the model must be copied out of the asset pack into app storage — doubling both storage use and first-run time, and reopening the self-hosted-download question that `app-layers.md` R4 closed.

**Result:** _not yet run_

---

## 7. Zero-engineering, in parallel — no hardware needed

| Item | Status |
| --- | --- |
| Play policy memo — why notification access is not spyware | ✅ [`../policy/why-this-is-not-spyware.md`](../policy/why-this-is-not-spyware.md) |
| Gemma licensing notice + EULA clause (`app-layers.md` §11.7) | ☐ |
| Repo layout / nitrogen autolinking (V23) | ☐ |
| Play listing and seller-name decisions, to product | ☐ |

---

## 8. What each outcome means

| Outcome | Consequence |
| --- | --- |
| V29 green on Mali | Plan proceeds as written. GPU everywhere, E4B on Android. |
| V29 red on Mali, green on Adreno | Fallback rung 1: GPU allowlist. Mali-class devices go CPU + E2B (rung 2). Confirms the fault is Mali-specific. |
| V29 red on both | Fallback rung 2 or 3 globally. CPU-only at 17.7 tok/s decode is a background queue, not interactive — the product's UX assumptions change and the plan needs rewriting, not adjusting. |
| V0 finds no clean revision | The engine decision itself reopens. `llama.rn` + GBNF becomes the live contingency, and the Gemma 4 PLE question from the first research pass becomes blocking again. |
| V26 fails | Source build on the critical path from day 1. |
| V32 fails | Model delivery is redesigned before the vertical slice, not after. |

The honest summary: **V29 and V0 together decide whether this product is the one that was designed.** Everything downstream assumes an engine that produces correct digits at interactive speed on the hardware the market owns. Neither has been demonstrated yet.
