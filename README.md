# Money Manager

An expense manager for Android that runs its AI **entirely on the device**. Capture comes from bank
notifications, receipt photos, voice, and typed text; extraction runs locally on Gemma 4 via
LiteRT-LM. No public cloud is used for inference or user data, and there is no backend the app
sends anything to.

**Status: pre-implementation.** The weeks 1–2 engineering gates all pass on real hardware. The
deterministic extraction layer is built and tested. The app itself is not started — see
[the open decision](#the-open-decision).

---

## Start here

| If you want to… | Read |
| --- | --- |
| Understand scope and sequence | [`docs/plan/2026-08-03-android-v1.md`](docs/plan/2026-08-03-android-v1.md) |
| See what was measured on-device | [`docs/plan/2026-08-03-weeks-1-2-gate-runbook.md`](docs/plan/2026-08-03-weeks-1-2-gate-runbook.md) |
| Understand the architecture | [`docs/research/2026-08-02-app-layers.md`](docs/research/2026-08-02-app-layers.md) |
| Understand the data model | [`docs/research/data-layer/`](docs/research/data-layer/) |
| Know why on-device at all | [`docs/research/2026-08-02-on-device-ai-stack.md`](docs/research/2026-08-02-on-device-ai-stack.md) |

15 documents, ~13,000 lines. They were produced by parallel research passes with adversarial
review, and every claim carries an evidence marker — `[VERIFIED]` means read from a primary
source, `[REPORTED]` means secondary and unconfirmed. Treat the distinction as load-bearing.

---

## Gate results (measured, not projected)

All on a **Galaxy S21+ (SM-G996B), Exynos 2100, Mali-G78, Android 15**.

| Gate | Result |
| --- | --- |
| V26 — 16 KB page alignment | **PASS** — all `LOAD` segments at `2**14` |
| V34 — false-ready smoke | **PASS** |
| V13 — clone independence | **PASS** — no state leak between conversations |
| V0 — digit fidelity | **PASS 10/10** on CPU *and* GPU |
| V29 — Mali multi-turn GPU | **PASS 120/120**, twice, RSS *shrank* both runs |

Three findings that changed the plan:

**E4B does not fit.** Gemma 4 E4B on the GPU backend is SIGKILLed on a 7 GiB device — it needs
~3.4 GB against ~3.0 GB available. **E2B on GPU works** at ~5.8 s per extraction, against ~21 s
for E4B on CPU.

**The model cannot do arithmetic on money.** Asked for an integer amount, E4B returned `1250000`
for `$1.250.000,00` COP instead of `125000000` — a silent 100× under-report. Moving the conversion
out of the model took the same fixtures from 9/10 to 10/10. The model now emits `amount_text`
verbatim and deterministic code produces the number.

**Disk footprint is ~2× the model.** The GPU and CPU backends each write their own weight cache,
so a 2.6 GB model occupies ~5 GB once both have run.

---

## What is built

```
packages/extraction   money normaliser · currency ladder · date resolution ·
                      bank templates · deterministic pipeline
packages/capture      cross-channel dedupe · merchant descriptor normalisation
tools/spikes          throwaway on-device gate harness (delete after week 2)
```

69 tests, no dependencies, no install required:

```bash
node --test packages/*/test/*.test.mjs
```

Everything above is **model-agnostic by design** — it works identically whether v1 ships E2B or
E4B, and it works with **zero model bytes**, which `app-layers.md` §11.2 requires.

`apps/mobile`, `packages/nitro-llm`, `packages/eval` and `packages/policy` are empty. That is the
next work, and it is blocked.

---

## The open decision

**The plan specifies Gemma 4 E4B. The measurements say E2B.**

| Configuration | Result |
| --- | --- |
| E4B + GPU | SIGKILL, out of memory |
| E4B + CPU | works, ~21 s per extraction |
| **E2B + GPU** | **~5.8 s, passes every gate** |

E2B is the only configuration that passes everything, but it is a smaller model than the plan
budgeted for, so the accuracy ceiling is lower. Every remaining step binds to one or the other:
the native module loads a specific file, and the VLM escalation policy depends on which tier's
accuracy it is escalating away from.

**This is a product decision about model capability, not an engineering one.** It is tracked as
task #12 and is the reason implementation has not started.

Two things are also still outstanding regardless: a **Mali-G715 or Dimensity device** is what
actually closes upstream issue #2421 (a green on G78 licenses a G78 allowlist entry and nothing
wider), and the **4–6 GB device tier** has never been tested.

---

## Constraints that shape everything

- **No public cloud, ever** — not for inference, not for user data, not for analytics. The only
  off-device path for user data is an endpoint the user self-hosts, and that is deferred out of v1.
- **The on-device database is the sole system of record.** There is no backup to recover from,
  which is why the data-layer design is as paranoid as it is.
- **Extraction runs at roughly 0.80 F1.** User correction is the normal path, not an error path.
- **iOS is paused, not cancelled** — see the plan §3 for what must stay portable.

## Licence

Code: see [`LICENSE`](LICENSE). The Gemma model weights are **not** covered by it and carry their
own terms — see [`docs/policy/gemma-licensing.md`](docs/policy/gemma-licensing.md). Shipping the
weights in an app makes the publisher a distributor with obligations attached.
