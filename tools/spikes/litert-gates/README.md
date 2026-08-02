# LiteRT-LM gate spike

Throwaway harness for the weeks 1-2 gates. See
[`../../../docs/plan/2026-08-03-weeks-1-2-gate-runbook.md`](../../../docs/plan/2026-08-03-weeks-1-2-gate-runbook.md).

**This is deliberately unmaintained.** It is deleted once the gates are recorded. Do not build
app code on it and do not import from it.

## Gates covered

| Gate | Test | Needs device | Needs model |
| --- | --- | --- | --- |
| V26 | `v26-alignment-check.sh` | No | No |
| _(device profile — not a gate)_ | `GateTests.deviceProfile` | Yes | **No** |
| V34 false-ready smoke | `GateTests.v34_knownAnswerSmoke` | Yes | Yes |
| V13 clone independence | `GateTests.v13_cloneIndependence` | Yes | Yes |
| V0 digit fidelity | `GateTests.v0_digitFidelity_{cpu,gpu}` | Yes | Yes |
| V29 Mali multi-turn GPU | `GateTests.v29_maliMultiTurnGpu` | Yes, Mali | Yes |

**Run `deviceProfile` first on any new device.** It needs no model, so it works the moment a
phone is plugged in, and it proves the provenance path (EGL / `GL_RENDERER`, page size, SoC)
actually executes. Every other test skips without the model, so without it none of that code
has ever run — and discovering a blank provenance field after pushing 3.66 GB wastes the
session. It also answers slot A vs slot B from `GL_RENDERER` rather than from the model number.

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
