# @mm/extraction

Deterministic post-processing for model output. **The model never emits a number.**

`money.js` is a direct port of the Kotlin `MoneyNormaliser` proven by gate V0. Keep the two in
step: the Kotlin copy lives in `tools/spikes/litert-gates` and is what the on-device gate
measures, this copy is what ships.

## Why this exists

V0's first run asked Gemma 4 E4B for an integer amount. On `$1.250.000,00` (COP) it returned
`1250000` instead of `125000000` — a silent **100x under-report**. Moving the arithmetic out of
the model took the same fixtures from 9/10 to 10/10.

See `docs/research/2026-08-02-app-layers.md` §4.3 and
`docs/plan/2026-08-03-weeks-1-2-gate-runbook.md` §3.
