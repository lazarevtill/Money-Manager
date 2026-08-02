# LiteRT-LM gate spike

Throwaway harness for the weeks 1-2 gates. See
[`../../../docs/plan/2026-08-03-weeks-1-2-gate-runbook.md`](../../../docs/plan/2026-08-03-weeks-1-2-gate-runbook.md).

**This is deliberately unmaintained.** It is deleted once the gates are recorded. Do not build
app code on it and do not import from it.

## Gates covered

| Gate | Test | Needs device |
| --- | --- | --- |
| V26 | `v26-alignment-check.sh` | No |
| V34 false-ready smoke | `GateTests.v34_knownAnswerSmoke` | Yes |
| V13 clone independence | `GateTests.v13_cloneIndependence` | Yes |
| V0 digit fidelity | `GateTests.v0_digitFidelity_{cpu,gpu}` | Yes |
| V29 Mali multi-turn GPU | `GateTests.v29_maliMultiTurnGpu` | Yes, Mali |

## Why instrumented tests rather than an adb-shell CLI

SELinux domain, app memory limits and GPU driver context differ between a shell binary and an
installed APK. The runbook requires at least one green V29 reproduced from an installed APK,
because a result that does not transfer to app context is worse than no result — it licenses
building on a false green.

## Running

The model is not bundled: 3.66 GB, and Gemma weights are licence-gated. Obtain
`gemma-4-E4B-it` in `.litertlm` form, accept the Gemma terms, then:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb push gemma-4-E4B-it.litertlm   /sdcard/Android/data/dev.moneymanager.gates/files/model.litertlm

# one gate at a time - V29 takes a while
adb shell am instrument -w -e class dev.moneymanager.gates.GateTests#v34_knownAnswerSmoke   dev.moneymanager.gates/androidx.test.runner.AndroidJUnitRunner

adb pull /sdcard/Android/data/dev.moneymanager.gates/files/gate-results.json
```

Tests self-skip with a clear message when the model is absent, so a run without it is a skip,
not a false pass.

## Reading a V29 result

Issue #2421 reports `CL_INVALID_COMMAND_QUEUE` on **Mali-G715 / Tensor G4**. The S21+ carries
**Mali-G78**. A green here licenses a G78-class allowlist entry and nothing more — it does not
close V29 and does not license "GPU everywhere". A red here is more informative than a green.

Every result records `{litertlm_version, model_sha256_prefix, backend, soc_model, gl_renderer,
gl_version, page_size}` so it stays attributable and comparable across revisions.
