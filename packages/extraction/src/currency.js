/**
 * Currency resolution ladder — `app-layers.md` §4.3.
 *
 * The model emits a `currency_guess`; this decides what to actually record, and how much to
 * trust it. Order, strongest first:
 *
 *   1. explicit ISO 4217 code in the source text
 *   2. an unambiguous symbol (R$, €, £, S/)
 *   3. an ambiguous symbol plus the merchant's country
 *   4. an ambiguous symbol plus the device region
 *   5. the user's default account currency
 *
 * Why this is not a lookup table: **`$` is MXN, USD, ARS, CLP, COP, UYU, CAD and AUD.** Getting
 * it wrong is not a cosmetic error — CLP has exponent 0 and MXN has exponent 2, so confusing
 * them misplaces the decimal point by 100x on every transaction from that merchant.
 *
 * Confidence is returned, never hidden. The confirmation screen shows the currency and the
 * reason, so a wrong resolution is one tap to fix instead of a silent corruption.
 */

import { exponentFor } from './money.js';

/** Symbols that identify exactly one currency. */
const UNAMBIGUOUS_SYMBOLS = Object.freeze({
  'R$': 'BRL',
  '€': 'EUR',
  '£': 'GBP',
  'S/': 'PEN',
  '₲': 'PYG',
  '₩': 'KRW',
  '₫': 'VND',
  'US$': 'USD',
  'MX$': 'MXN',
  'CL$': 'CLP',
  'AR$': 'ARS',
});

/** Symbols shared by several currencies. Order matters only for reporting alternatives. */
const AMBIGUOUS_SYMBOLS = Object.freeze({
  '$': ['USD', 'MXN', 'ARS', 'CLP', 'COP', 'UYU'],
  '¥': ['JPY'],
});

/** ISO 3166-1 alpha-2 -> default currency, for the countries in scope. */
const COUNTRY_CURRENCY = Object.freeze({
  MX: 'MXN', BR: 'BRL', CO: 'COP', CL: 'CLP', AR: 'ARS', PE: 'PEN', UY: 'UYU',
  PY: 'PYG', US: 'USD', GB: 'GBP', JP: 'JPY', KR: 'KRW', VN: 'VND',
  ES: 'EUR', DE: 'EUR', FR: 'EUR',
});

export const CONFIDENCE = Object.freeze({
  EXPLICIT_ISO: 0.99,
  UNAMBIGUOUS_SYMBOL: 0.90,
  SYMBOL_PLUS_MERCHANT_COUNTRY: 0.75,
  SYMBOL_PLUS_DEVICE_REGION: 0.55,
  ACCOUNT_DEFAULT: 0.30,
  NONE: 0,
});

/** Below this, the UI must require confirmation rather than accept silently. */
export const CONFIRM_BELOW = 0.80;

const ISO_RE = /\b([A-Z]{3})\b/g;

/**
 * @param {object} input
 * @param {string} input.text            source text (notification body, OCR, utterance)
 * @param {string} [input.modelGuess]    the model's currency_guess, treated as a hint only
 * @param {string} [input.merchantCountry] ISO 3166-1 alpha-2
 * @param {string} [input.deviceRegion]  ISO 3166-1 alpha-2
 * @param {string} [input.accountCurrency] the account's own currency
 * @returns {{currency: string|null, confidence: number, source: string,
 *            alternatives: string[], needsConfirmation: boolean, reason: string}}
 */
export function resolveCurrency(input = {}) {
  const { text = '', modelGuess, merchantCountry, deviceRegion, accountCurrency } = input;
  const upper = String(text).toUpperCase();

  const done = (currency, confidence, source, reason, alternatives = []) => ({
    currency,
    confidence,
    source,
    alternatives,
    needsConfirmation: confidence < CONFIRM_BELOW,
    reason,
  });

  // 1. An explicit ISO code in the text beats everything, including the model.
  for (const m of upper.matchAll(ISO_RE)) {
    const code = m[1];
    if (exponentFor(code) !== undefined) {
      return done(code, CONFIDENCE.EXPLICIT_ISO, 'explicit_iso',
        `'${code}' appears literally in the source text`);
    }
  }

  // 2. Unambiguous symbols. Longest first so "R$" and "US$" beat "$".
  const symbols = Object.keys(UNAMBIGUOUS_SYMBOLS).sort((a, b) => b.length - a.length);
  for (const sym of symbols) {
    if (text.includes(sym)) {
      const cur = UNAMBIGUOUS_SYMBOLS[sym];
      return done(cur, CONFIDENCE.UNAMBIGUOUS_SYMBOL, 'unambiguous_symbol',
        `'${sym}' identifies ${cur} uniquely`);
    }
  }

  // 3-4. Ambiguous symbol: narrow it with geography, and keep the alternatives visible.
  for (const [sym, candidates] of Object.entries(AMBIGUOUS_SYMBOLS)) {
    if (!text.includes(sym)) continue;

    if (candidates.length === 1) {
      return done(candidates[0], CONFIDENCE.UNAMBIGUOUS_SYMBOL, 'unambiguous_symbol',
        `'${sym}' maps to a single in-scope currency`);
    }
    const fromMerchant = merchantCountry && COUNTRY_CURRENCY[merchantCountry.toUpperCase()];
    if (fromMerchant && candidates.includes(fromMerchant)) {
      return done(fromMerchant, CONFIDENCE.SYMBOL_PLUS_MERCHANT_COUNTRY,
        'symbol_plus_merchant_country',
        `'${sym}' is ambiguous; merchant country ${merchantCountry} selects ${fromMerchant}`,
        candidates.filter((c) => c !== fromMerchant));
    }
    const fromDevice = deviceRegion && COUNTRY_CURRENCY[deviceRegion.toUpperCase()];
    if (fromDevice && candidates.includes(fromDevice)) {
      return done(fromDevice, CONFIDENCE.SYMBOL_PLUS_DEVICE_REGION,
        'symbol_plus_device_region',
        `'${sym}' is ambiguous; device region ${deviceRegion} selects ${fromDevice} — ` +
        `wrong whenever the user is travelling`,
        candidates.filter((c) => c !== fromDevice));
    }
    // A symbol we cannot narrow is worse than no symbol: it looks decided but is not.
    if (accountCurrency && candidates.includes(accountCurrency)) {
      return done(accountCurrency, CONFIDENCE.ACCOUNT_DEFAULT, 'account_default',
        `'${sym}' is ambiguous and no geography is known; falling back to the account currency`,
        candidates.filter((c) => c !== accountCurrency));
    }
    return done(null, CONFIDENCE.NONE, 'ambiguous_symbol_unresolved',
      `'${sym}' is ambiguous and nothing narrows it`, candidates);
  }

  // The model's guess ranks below every deterministic signal, deliberately: it is the component
  // measured at ~0.80 F1, and it has no access to geography.
  if (modelGuess && exponentFor(modelGuess.toUpperCase()) !== undefined) {
    return done(modelGuess.toUpperCase(), CONFIDENCE.SYMBOL_PLUS_DEVICE_REGION, 'model_guess',
      `no symbol or code found; using the model's guess '${modelGuess}'`);
  }
  if (accountCurrency && exponentFor(accountCurrency.toUpperCase()) !== undefined) {
    return done(accountCurrency.toUpperCase(), CONFIDENCE.ACCOUNT_DEFAULT, 'account_default',
      'no currency signal in the text; falling back to the account currency');
  }
  return done(null, CONFIDENCE.NONE, 'unresolved', 'no currency signal available');
}
