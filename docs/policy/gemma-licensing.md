# Gemma licensing obligations

Date: 2026-08-03 · Source: [Gemma Terms of Use](https://ai.google.dev/gemma/terms) §3.1, §3.2 — read 2026-08-03
Referenced by: [`../research/2026-08-02-app-layers.md`](../research/2026-08-02-app-layers.md) §11.7

> Not legal advice. This records what the Terms say and where each obligation is discharged in the app. Have counsel review the EULA clause in §5 before the first public release.

## 1. We are a distributor

The app ships Gemma 4 weights to end users through Play Asset Delivery. Play serves the bytes, but the app is what puts them on the user's device, so the distribution obligations in §3.1 of the Terms apply to us. This is not avoidable by delivery mechanism — it would apply equally to a self-hosted CDN.

It also applies to **any fine-tune we ship later**. The planned FunctionGemma work produces a Model Derivative, and derivatives carry the same obligations plus a modification notice.

## 2. What the Terms require of a distributor

Four obligations, all from §3.1:

| # | Obligation | Exact requirement |
| --- | --- | --- |
| 1 | **Notice** | Include the string in §3 below, verbatim |
| 2 | **Pass the Agreement through** | "provide all third party recipients of Gemma or Model Derivatives a copy of this Agreement" |
| 3 | **Pass the use restrictions through** | §3.2's restrictions must appear as **enforceable provisions** in our agreement with the user — a link is not sufficient, they must bind |
| 4 | **Mark modifications** | "All modified files carry prominent notices stating that you modified the files" — applies from the first fine-tune |

We may add our own terms on top, provided they do not conflict with the Agreement.

## 3. The required notice, verbatim

```
Gemma is provided under and subject to the Gemma Terms of Use found at
ai.google.dev/gemma/terms
```

Do not reword, abbreviate, or merge it into surrounding prose.

**Where it goes:** the in-app licenses screen, alongside the third-party open-source notices; the model-download screen, so it is seen before the weights land on the device; and the repo's `NOTICE` file.

## 4. Where each obligation is discharged

| Obligation | Surface | Status |
| --- | --- | --- |
| Verbatim notice | In-app licenses screen · model-download screen · repo `NOTICE` | ☐ |
| Full Agreement copy | Bundled in-app as text, **not** a link — a link fails if the user is offline or Google moves the URL, and the obligation is to *provide a copy* | ☐ |
| §3.2 restrictions bound in the EULA | EULA §N, draft in §5 below | ☐ |
| Modification notice | Not yet applicable. Becomes required the moment a fine-tuned model ships | n/a until v2 |

The "bundle, don't link" choice matters: an offline-first app whose license compliance depends on a network fetch is not compliant offline, which is most of the time by design.

## 5. Draft EULA clause

To be reviewed by counsel. It has to *bind* the user, not merely inform them, which is why it is drafted as an agreement term rather than a notice.

> **Third-party model terms.** This application includes and downloads Gemma, a machine-learning model provided by Google. Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms. A complete copy of those terms is available within the application under Settings → Legal.
>
> By using this application you agree that you will not use Gemma, or any output of Gemma obtained through this application, in any manner that violates the Gemma Prohibited Use Policy at ai.google.dev/gemma/prohibited_use_policy, or in violation of applicable law. You further agree that you will not redistribute the Gemma model files supplied with this application except as permitted by the Gemma Terms of Use.
>
> Google is not a party to this agreement and provides Gemma without warranty. Nothing in this agreement grants you rights in Gemma beyond those granted by the Gemma Terms of Use.

## 6. Two consequences worth flagging now

**Do not describe the app or its model as "open source" in the Play listing.** Gemma is open-weights under a licence with use restrictions, and it is not an OSI-approved open-source licence. `app-layers.md` §11.4 already requires the listing to be written to measured numbers; this is the same discipline applied to licensing. "Runs a local AI model on your device" is accurate and says the thing users care about anyway.

**The fine-tune has a licensing consequence, not just an engineering one.** A fine-tuned FunctionGemma or a LoRA merge is a Model Derivative: it inherits these obligations, needs the modification notice, and the training data provenance becomes relevant. Worth settling before the fine-tune starts rather than at the release that ships it.

## 7. Verify before release

- Re-read the Terms at release time. They are a living document and can change between now and shipping; this file records what they said on 2026-08-03.
- Confirm the Prohibited Use Policy URL and content are current.
- Confirm the bundled Agreement copy matches the then-current published version.
