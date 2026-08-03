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

GPU confirmed by **measurement, not inference** — `GL_RENDERER` read from a live EGL context inside an installed APK on 2026-08-03, not derived from the model number:

```json
{ "soc_model": "Exynos 2100", "device": "SM-G996B", "android_sdk": 35,
  "gl_renderer": "Mali-G78",
  "gl_version": "OpenGL ES 3.2 v1.r38p0-01eac0-mbs2v41_0.4ef6e1c9ba431853d05b271234c3d1c5",
  "page_size": 4096 }
```

**The harness is validated end to end on hardware.** Both APKs install, instrumentation runs, EGL context creation succeeds inside an instrumented test, provenance is captured, `gate-results.json` is written and pullable, and model absence is correctly detected (`model_present: false`) rather than silently passing. Nothing about the plumbing is unknown any more — only the model is missing.
| Galaxy Tab S8 Ultra | Snapdragon 8 Gen 1 | Adreno 730 | 8–16 GB | — | B *(not yet verified over adb)* |
| Galaxy Z Fold 7 | Snapdragon (8 Elite class) | Adreno | 12–16 GB | — | B *(not yet verified over adb)* |

**V29 is runnable today — as a proxy, and that word is load-bearing.** Issue #2421 reports `CL_INVALID_COMMAND_QUEUE` on **Mali-G715 / Tensor G4 / Dimensity** (app-layers §3.4, register V29). The S21+ carries **Mali-G78**: same vendor and driver stack, but 2nd-generation Valhall on the r38 line versus G715's 4th-generation on a newer line.

**Consequence for how results may be read.** A green V29 on this device licenses a **G78-class allowlist entry**. It does *not* license "GPU everywhere", and it does not close V29 — the reported failure is on a GPU generation this device does not have. A **red** result here is far more informative than a green one: failure on an older, simpler Valhall part would suggest something broader than a G715 driver bug.

Closing V29 properly still requires a G715-class or Dimensity device. This raises the cheap Dimensity handset from "highest-value purchase" to **the thing that actually closes the gate**.

Three facts from the pull that change what this device can and cannot tell us:

1. **Page size is 4096 (4 KB), so this device cannot runtime-validate V26.** Android 15+ permits 16 KB pages, but this build does not use them. V26 therefore stays a **static, device-independent `objdump` check** on the shipped `.so` files — it cannot be discharged by "it ran fine on the S21+". Do not let a green run here be read as V26 passing.
2. **Android 15 / SDK 35 cannot exercise SDK 36 runtime behaviour.** Play requires targetSdk 36 by 2026-08-31. An app targeting 36 installs and runs here, but any behaviour gated on the *device* API level stays dormant, so foreground-service and notification changes introduced in Android 16 are untestable on this device.
3. **7.03 GiB usable is comfortable for E4B but not representative.** E4B peaks around 3.4 GB on the GPU backend; that fits here with room to spare. It says nothing about the 4–6 GB tier.

**Remaining gap — slot C and the target market.** All three devices are premium Samsung flagships. The LATAM market runs entry and mid-tier Dimensity at 4–6 GB. This set will run E4B comfortably and cannot tell us whether fallback rung 2 (E2B on CPU) is viable, which is precisely the tier Mali-class devices land on if V29 fails. **One cheap Dimensity handset remains the highest-value purchase in the project** — it covers the low-RAM tier, a second Mali implementation, and the actual market profile at once.

This gap does not block anything now. It becomes blocking before the fallback ladder can be validated or the release can claim device coverage.

---

### Model artifact under test

Every gate result is pinned to this exact artifact (invariant R-ENG-1). "We tested Gemma 4 E4B" is not a result.

| | |
| --- | --- |
| Source | `litert-community/gemma-4-E4B-it-litert-lm` on Hugging Face |
| File | `gemma-4-E4B-it.litertlm` |
| Size | **3,659,530,240** bytes |
| SHA-256 | `0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0` |
| Repo status | **Not gated** (`gated: false`, `private: false`) — publicly downloadable, no account or terms acceptance needed to fetch it |

The Gemma **Terms of Use still apply to distribution** — see [`../policy/gemma-licensing.md`](../policy/gemma-licensing.md). Ungated download and unrestricted redistribution are different things: we are still a distributor the moment we ship these weights in an app.

A second artifact exists in the same repo, `gemma-4-E4B-it-web.litertlm` (2,969,059,328 bytes, sha256 `3904d826…`). It is the web-optimised build. **Do not test against it by accident** — a size mismatch is the quickest way to notice.

## 1. V29 — Mali multi-turn GPU stability **(the gate that decides the product)**

**Question.** Does the GPU backend survive sustained multi-turn generation on Mali, or does it die after 1–3 turns as reported upstream in #2421?

**Run on:** slot A, then slot B as control.

**Method.**
1. Load Gemma 4 E4B `.litertlm`, GPU backend.
2. Run 20 sequential extractions, each a fresh conversation, each on a real bank-notification string.
3. Then 20 more as **multi-turn** within one conversation — this is the reported failure shape, and it differs from 20 independent calls.
4. Record after every turn: success/failure, tokens/sec decode, peak RSS, GPU driver messages from `logcat`.
5. Repeat the whole run three times from a cold start.

**Pass:** all **120** turns complete (3 cold starts × [20 fresh + 20 multi-turn]) with no driver fault and no monotonic RSS growth across turns.
**Fail:** any driver-level GPU fault — `CL_INVALID_COMMAND_QUEUE` specifically — hang, or process death.

**Every run must be attributable and transferable, or the result is not usable later:**

- Pin the exact LiteRT-LM **revision** and record the artifact **hash** (invariant R-ENG-1). "We tested LiteRT-LM" is not a result; "we tested revision `abc123`, sha256 `…`" is.
- Log per run: `{revision, artifact_hash, backend, SoC, GL_RENDERER, driver version, model file + quant, ambient temp / thermal state}`. `GL_RENDERER` on this device reads `Mali-G78` with driver `r38p0`.
- **Before declaring V29 green, reproduce at least one green run from inside an installed APK, not only the adb-shell CLI.** SELinux domain, app memory limits, and GPU driver context all differ in-app. Upstream benchmarks do run via `adb shell`, and a result that does not transfer to app context is worse than no result — it licenses building on a false green.

**Stop-loss — no debate, no meeting:** if slot A has no green run by **end of week 2**, adopt fallback rung 1 (GPU allowlist; Mali-class devices go CPU) immediately.

### Result: **BLOCKED BY MEMORY, not by the driver bug** — 2026-08-03

V29 cannot run as specified on this device with E4B. Establishing that is itself a result.

Running V0 on the **GPU** backend kills the process:

```
I/Zygote: Process 29156 exited due to signal 9 (Killed)
W/ActivityManager: Rescheduling restart of crashed service ... for mem-pressure-event
MemAvailable: 3,091,188 kB          # ~3.0 GB free
```

**This is SIGKILL under memory pressure, NOT `CL_INVALID_COMMAND_QUEUE`.** It is not the #2421
signature and must not be recorded as a V29 result. The same fixtures pass on CPU on the same
device, so the model and the harness are fine — the GPU backend needs its own copy of the weights
and ~3.4 GB peak does not fit in ~3.0 GB available.

**What this means for the plan, which assumed GPU + E4B on Android:**

- **E4B on GPU is not viable on an 8 GB device.** The S21+ has 7.03 GiB total. The LATAM target tier
  is 4–6 GB, so if it does not fit here it certainly does not fit there.
- **E4B on CPU works** but costs ~21 s per extraction. That is a background queue, not an
  interactive feature — the UX assumption in the plan needs revisiting either way.
- **The Mali driver question is still open.** OOM masked it. Whether this GPU hits #2421 is
  unknown, and a device with more RAM or a smaller model is needed to find out.

**Next step, in progress:** test with **E2B** (`gemma-4-E2B-it.litertlm`, 2,588,147,712 bytes,
ungated). It separates the two failure modes — if GPU works with E2B, the problem is memory and
fallback rung 2 is validated; if GPU still faults with `CL_INVALID_COMMAND_QUEUE`, that is a real
#2421-class hit on Mali-G78 and the GPU allowlist becomes the plan.

Incidental confirmation from the load log: `signature=per_layer_embedder` — **LiteRT-LM does
execute Gemma 4's Per-Layer Embeddings**, which is exactly what llama.cpp issue #22243 reports
missing there. That strengthens the LiteRT-LM-over-llama.rn decision on evidence rather than
assumption.

---

## 2. V26 — 16 KB page-size alignment

**Question.** Are Google's prebuilt LiteRT-LM `.so` files 16 KB-aligned?

**Why it is week 1 and not later.** The requirement is real and already in force: since **2025-11-01**, new apps and updates targeting Android 15+ must support 16 KB page sizes, and this app must target API 36 by 2026-08-31 regardless. Failure blocks **every Play upload**, and the remedy is a multi-day source build. It needs no special hardware — run it on day 1.

**Method.** `objdump -p <lib>.so | grep LOAD` and confirm **alignment ≥ `2**14`** on **every shipped `.so`**, not just `liblitert*` — SQLCipher/op-sqlite, Hermes, and every transitive native dependency. Build with **NDK r28+**, where 16 KB ELF alignment is the linker *default*; r27 supports it only as an opt-in flag, so a build on the currently-installed r27 can produce 4 KB-aligned output and fail this gate for a reason that is ours, not upstream's.

**Pass:** every segment ≥ `2**14`. Note `2**16` also passes and is common — do not test for equality with `2**14`.
**Fail:** schedule the source build immediately; it is on the critical path from that moment.

**On runtime validation.** The connected S21+ reports `PAGE_SIZE` 4096 and cannot exercise 16 KB behaviour, but that does not mean runtime validation is impossible — Android emulator 16 KB system images exist, and Pixel 8+ has a developer option to boot a 16 KB kernel. The static check remains the CI gate because it is cheap, deterministic, and covers every library; treat runtime validation as a useful supplement, not as unavailable.

### Result: **PASS** — 2026-08-03

`litertlm-android:0.15.0`, arm64-v8a, `liblitertlm_jni.so` (21,199,264 bytes), extracted from a debug APK built with NDK 28.2.13676358. All three `LOAD` segments at `align 2**14`:

```
LOAD off 0x0000000000000000  align 2**14   filesz 0x1372e00  flags r-x
LOAD off 0x0000000001374000  align 2**14   filesz 0x00b80f8  flags rw-
LOAD off 0x000000000142c0f8  align 2**14   filesz 0x000abb0  flags rw-
```

Google's prebuilt is correctly aligned. **The multi-day source build is not on the critical path.**

**Two caveats on how far this result goes:**

1. **It covers one library.** The spike APK contains only `liblitertlm_jni.so`. The real app adds SQLCipher/op-sqlite, Hermes, and every other native dependency. Re-run against the actual release APK — this retires the LiteRT-LM risk specifically, not the gate.
2. **The checker produced a false PASS before it produced a true one.** The first version split on the literal `"**"`, which awk parses as a regex; awk aborted, the result was empty, and empty read as "no misaligned segments". A gate whose parse failure is indistinguishable from success is worse than no gate. It now fails closed when no `LOAD` line parses, and the raw objdump output above is recorded rather than only the script's verdict.

---

## 3. V0 — digit fidelity across revisions

**Question.** Which LiteRT-LM revision produces correct digits, and at what speed?

**Why digits specifically.** Amount and date are the two fields a finance app cannot get wrong, and they are exactly what the reported corruption bugs attack. General "does it produce plausible JSON" testing will pass while the product is broken.

**Method.** For each candidate revision × {CPU, GPU} × {E2B, E4B}: run a fixed set of 50 bank-notification strings and 20 receipt OCR texts with known-correct expected values. Score **exact match on amount and date**, not F1 over all fields. Record decode tok/s, time-to-first-token, peak RSS.

**Pin by `revision:`, never by version** (`app-layers.md` §3.1).

**Pass:** ≥1 revision with 100% digit exactness on the fixture set and acceptable latency.
**Note:** anything below 100% means silent corruption in production. This gate is pass/fail, not a score to optimise.

### Result: **PASS on CPU, 10/10** — 2026-08-03 · and the first run is the interesting part

**First run: FAIL, 9/10.** The prompt asked the model for `amount_minor`, an integer. On
`Bancolombia: Compra por $1.250.000,00 en ALMACEN EXITO.` Gemma 4 E4B returned:

```json
{"amount_minor": 1250000, "currency": "COP"}
```

Expected `125000000`. The model read the digits correctly and then **failed the major-to-minor
conversion** — a **100× under-report**, recording a 1,250,000 COP purchase as 12,500.00 COP. It
got the other 2-decimal cases right because their decimals were non-zero and the conversion was
visible; a trailing `,00` let it return the integer unchanged.

**This is the currency `app-layers.md` §4.3 had already singled out**, in a section titled *"never
let the model emit a number"*, which also states *"the COP exponent must be settled before the
first row is written"*. The design was right, and the naive contract was mine, not the product's.

**Second run: PASS, 10/10.** Same model, same fixtures, same device. The only change is who does
the arithmetic:

| | First run | Second run |
| --- | --- | --- |
| Model emits | `amount_minor` (integer) | `amount_text` verbatim + `currency_guess` |
| Conversion done by | the model | deterministic `MoneyNormaliser` |
| Result | 9/10 — a silent 100× error | **10/10** |

**What this changes.** §4.3 stops being a precaution and becomes a measured requirement with a
reproduction. The normaliser resolves separators by rule (rightmost of `.`/`,` wins; a repeated
separator is grouping; exponent-0 currencies never have a decimal separator) and **returns an
ambiguity flag rather than guessing** on the genuinely undecidable case §4.3 names — a single
separator with three trailing digits on a 2-decimal currency, where `1.299` is either 1299 or
1.299 and nothing in the string decides it.

**Caveat on scope:** 10 fixtures, one backend, one model revision. This shows the contract is
sound, not that extraction is solved. The real eval corpus is still to be built.

**Result:** CPU **PASS 10/10** (207 s for 10 extractions, ~21 s each). GPU **CANNOT RUN — out of memory, see §1**.

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

## 6. V32 — PAD split and mmap-ability **(split: half here, half in weeks 3–4)**

The register schedules V32 for weeks 3–4 and its method requires uploading a real 3-pack split to the Play internal track — which is not runnable as a pre-repo spike. The gate splits cleanly:

**V32a — fd/mmap, runnable now.** Can a PAD-delivered `.litertlm` be mmap'd via `litert_lm_engine_settings_create_from_raw_file_descriptor` without copying 3.66 GB? Spike this locally with `bundletool` local-testing, which produces the same on-device asset-pack layout without a Play upload.

**V32b — Play-reported compressed sizes, weeks 3–4.** Verify Play reports each pack ≤1.5 GB compressed. Requires a real internal-track upload and therefore a signed build and a Play listing; it cannot move earlier.

**Why it matters.** If PAD assets cannot be loaded from an fd, the model must be copied out of the asset pack into app storage — doubling both storage use and first-run time, and reopening the self-hosted-download question that `app-layers.md` R4 closed.

**Result:** V32a _not yet run_ · V32b _blocked until a signed build exists_

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
| V29 green on the S21+ (G78) | **Licenses a G78-class allowlist entry only.** Not "GPU everywhere" — the reported failure is on G715/Tensor G4, which this device is not. V29 stays open until a G715-class device runs it. |
| V29 red on the S21+ (G78) | More informative than green. Failure on an older, simpler Valhall part suggests something broader than a G715 driver bug — go straight to fallback rung 1 and treat GPU as opt-in per chipset. |
| V29 red on G715/Dimensity, green on Adreno | Fallback rung 1: GPU allowlist. Mali-class devices go CPU + E2B (rung 2). Confirms the fault is Mali-specific, as #2421 reports. |
| V29 red on both | Fallback rung 2 or 3 globally. CPU-only at 17.7 tok/s decode is a background queue, not interactive — the product's UX assumptions change and the plan needs rewriting, not adjusting. |
| V0 finds no clean revision | The engine decision itself reopens. `llama.rn` + GBNF becomes the live contingency, and the Gemma 4 PLE question from the first research pass becomes blocking again. |
| V26 fails | Source build on the critical path from day 1. |
| V32 fails | Model delivery is redesigned before the vertical slice, not after. |

The honest summary: **V29 and V0 together decide whether this product is the one that was designed.** Everything downstream assumes an engine that produces correct digits at interactive speed on the hardware the market owns. Neither has been demonstrated yet.
