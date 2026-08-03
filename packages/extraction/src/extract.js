/**
 * The deterministic extraction path: bank text -> a structured, confidence-scored transaction.
 *
 * This is fallback rung 3 as a working pipeline, and it is also what front-runs the model when
 * a template matches. It composes the pieces gate V0 forced into existence:
 *
 *   templates.js  -> which bank, what kind of event, amount_text verbatim
 *   currency.js   -> which currency, and how sure
 *   money.js      -> amount_text + exponent -> integer minor units
 *   dates.js      -> transaction date, never the capture time
 *
 * The output shape is the same whether a template or the model produced it, so downstream code
 * never branches on provenance — it branches on confidence.
 */

import { matchTemplate, SEED_TEMPLATES } from './templates.js';
import { resolveCurrency, CONFIRM_BELOW } from './currency.js';
import { toMinorUnits } from './money.js';
import { resolveDate, DATE_CONFIRM_BELOW } from './dates.js';

/**
 * @param {object} input
 * @param {string} input.text
 * @param {Date|number|string} input.capturedAt
 * @param {string} [input.deviceRegion]
 * @param {string} [input.accountCurrency]
 * @param {Array}  [input.templates]
 */
export function extractDeterministic(input = {}) {
  const {
    text = '', capturedAt, deviceRegion, accountCurrency, templates = SEED_TEMPLATES,
  } = input;

  const t = matchTemplate(text, templates);
  if (!t.matched) {
    return {
      ok: false,
      source: 'deterministic',
      reason: t.reason ?? 'no template matched',
      quarantine: t.quarantine,
      // Not a failure of the app — just this path declining, so the model path takes it.
      escalateToModel: true,
    };
  }

  // A template's country is a far better currency signal than the device region, because it is
  // a property of the issuer rather than of wherever the phone happens to be configured.
  const currency = resolveCurrency({
    text,
    merchantCountry: t.country ?? undefined,
    deviceRegion,
    accountCurrency,
    modelGuess: t.currencyHint ?? undefined,
  });

  if (!currency.currency) {
    return {
      ok: false, source: 'deterministic', templateId: t.templateId,
      reason: `template matched but currency is unresolved: ${currency.reason}`,
      escalateToModel: false,   // the model cannot resolve this either; it needs the user
      needsUser: true,
      partial: { amountText: t.fields.amountText, merchant: t.fields.merchant },
    };
  }

  const money = toMinorUnits(t.fields.amountText, currency.currency);
  if (money.kind !== 'ok') {
    return {
      ok: false, source: 'deterministic', templateId: t.templateId,
      reason: `amount not normalisable: ${money.reason ?? money.kind}`,
      needsUser: true,
      ambiguousCandidates: money.kind === 'ambiguous' ? money.candidates : undefined,
      partial: { amountText: t.fields.amountText, currency: currency.currency },
    };
  }

  const date = resolveDate({
    text: t.fields.dateText ?? text,
    capturedAt,
    region: t.country ?? deviceRegion,
  });

  // A refund is the same event shape with the opposite sign. Modelling it as a negative amount
  // rather than a separate type keeps running balances correct by construction.
  const signed = t.kind === 'refund' ? -money.minorUnits : money.minorUnits;

  // The weakest link governs. An extraction is only as trustworthy as its least certain field,
  // and averaging would let a confident amount hide an unresolved currency.
  const confidence = Math.min(
    currency.confidence,
    date.date ? date.confidence : 1,   // an absent date is honest, not low-confidence
  );

  return {
    ok: true,
    source: 'deterministic',
    templateId: t.templateId,
    institution: t.institution,
    kind: t.kind,
    amountMinor: signed,
    currency: currency.currency,
    currencyConfidence: currency.confidence,
    currencyReason: currency.reason,
    currencyAlternatives: currency.alternatives,
    merchant: t.fields.merchant,
    last4: t.fields.last4 ?? null,
    date: date.date,
    dateConfidence: date.date ? date.confidence : null,
    dateReason: date.reason,
    dateAlternatives: date.alternatives,
    confidence,
    // Confirmation is the normal path, not an error path: extraction runs at ~0.80 F1 and the
    // user is the correctness mechanism, so anything short of certain surfaces for one tap.
    needsConfirmation:
      confidence < CONFIRM_BELOW ||
      (date.date != null && date.confidence < DATE_CONFIRM_BELOW) ||
      date.date == null,
  };
}
