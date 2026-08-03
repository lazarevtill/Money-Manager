/**
 * amount_text -> integer minor units, deterministically.
 *
 * Port of the Kotlin MoneyNormaliser proven by gate V0. The model emits the amount VERBATIM as
 * a string; this produces the number. That split is not stylistic — V0 measured a silent 100x
 * error when the model was asked to do the conversion itself.
 *
 * Returns a tagged result rather than throwing, because "ambiguous" is a real outcome the UI
 * must surface, not an error to swallow.
 *
 * Values are BigInt end to end. A JS number loses precision above 2^53, and the schema's money
 * CHECK exists precisely because op-sqlite reads every integer through a double.
 */

/** ISO 4217 exponents. Deliberately not exhaustive — an unknown currency is an error, not a guess. */
export const EXPONENTS = Object.freeze({
  MXN: 2, BRL: 2, COP: 2, USD: 2, EUR: 2, ARS: 2, PEN: 2, UYU: 2, GBP: 2,
  CLP: 0, PYG: 0, JPY: 0, VND: 0, KRW: 0,
  BHD: 3, KWD: 3, TND: 3, JOD: 3,
});

/** Number.MAX_SAFE_INTEGER. Above this, op-sqlite's double read truncates silently. */
export const MAX_MINOR_UNITS = 9007199254740991n;

export const exponentFor = (currency) => EXPONENTS[String(currency ?? '').toUpperCase()];

const ok = (minorUnits, exponent) => ({ kind: 'ok', minorUnits, exponent });
const ambiguous = (reason, candidates) => ({ kind: 'ambiguous', reason, candidates });
const invalid = (reason) => ({ kind: 'invalid', reason });

const pow10 = (n) => 10n ** BigInt(n);

/**
 * @param {string} amountText amount exactly as written, e.g. "1.250.000,00"
 * @param {string} currency ISO 4217 code
 */
export function toMinorUnits(amountText, currency) {
  const exp = exponentFor(currency);
  if (exp === undefined) return invalid(`unknown currency exponent for '${currency}'`);

  const raw = String(amountText ?? '').trim();
  const negative = raw.startsWith('-') || /^\(.*\)$/.test(raw); // (1.234,56) is negative too
  const cleaned = raw.replace(/[^\d.,]/g, '');
  if (cleaned === '') return invalid(`no digits in '${amountText}'`);

  const dots = (cleaned.match(/\./g) || []).length;
  const commas = (cleaned.match(/,/g) || []).length;

  let decimalSep = null;
  if (dots > 0 && commas > 0) {
    // Both present: the RIGHTMOST is the decimal separator. Unambiguous.
    decimalSep = cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',') ? '.' : ',';
  } else if (dots > 0 || commas > 0) {
    const sep = dots > 0 ? '.' : ',';
    const count = dots > 0 ? dots : commas;
    const tail = cleaned.slice(cleaned.lastIndexOf(sep) + 1);

    // A lone separator is either a decimal point or a thousands group. Decide by arithmetic
    // validity, not by convention — and only call it ambiguous when BOTH readings are valid.
    const couldBeDecimal = tail.length === exp;   // 89,90 on exp 2
    const couldBeGrouping = tail.length === 3;    // 45.990

    if (count > 1) {
      decimalSep = null;               // repeated separator can only be grouping: 1.250.000
    } else if (exp === 0) {
      decimalSep = null;               // a 0-decimal currency has no decimal separator at all
    } else if (couldBeDecimal && couldBeGrouping) {
      // Only reachable when exp === 3. "1,500" KWD is 1500 KWD (grouped) or 1.500 KWD
      // (decimal) — both are whole numbers of fils, so nothing in the string decides it.
      // This, not the 2-decimal case, is the genuinely undecidable one.
      const grouped = BigInt(cleaned.replace(sep, '')) * pow10(exp);
      const asDecimal =
        BigInt(cleaned.slice(0, cleaned.lastIndexOf(sep))) * pow10(exp) + BigInt(tail);
      return ambiguous(
        `single '${sep}' with ${tail.length} trailing digits on a ${exp}-decimal currency`,
        [grouped, asDecimal],
      );
    } else if (couldBeDecimal) {
      decimalSep = sep;
    } else if (couldBeGrouping) {
      // e.g. "1.299" on a 2-decimal currency. NOT ambiguous: reading the separator as a
      // decimal point would mean 1.299 pesos — fractional cents, not representable. Grouping
      // is the only arithmetically valid reading, so take it.
      decimalSep = null;
    } else {
      return invalid(
        `cannot classify separator '${sep}' with ${tail.length} trailing digits in '${amountText}'`,
      );
    }
  }

  let intPart, fracPart;
  if (decimalSep === null) {
    intPart = cleaned.replace(/[.,]/g, '');
    fracPart = '';
  } else {
    const i = cleaned.lastIndexOf(decimalSep);
    intPart = cleaned.slice(0, i).replace(/[.,]/g, '');
    fracPart = cleaned.slice(i + 1).replace(/[.,]/g, '');
  }
  if (fracPart.length > exp) {
    return invalid(`'${fracPart}' has more than ${exp} decimal places for ${currency}`);
  }

  const major = BigInt(intPart === '' ? '0' : intPart);
  const minor = BigInt(fracPart.padEnd(exp, '0') || '0');
  const total = major * pow10(exp) + minor;

  if (total > MAX_MINOR_UNITS) return invalid('exceeds 2^53-1');
  return ok(negative ? -total : total, exp);
}

/** Render minor units back for display. Round-trip safety, and useful in tests. */
export function formatMinorUnits(minorUnits, currency) {
  const exp = exponentFor(currency);
  if (exp === undefined) return null;
  const neg = minorUnits < 0n;
  const abs = neg ? -minorUnits : minorUnits;
  const s = abs.toString().padStart(exp + 1, '0');
  const whole = s.slice(0, s.length - exp) || '0';
  const frac = exp === 0 ? '' : '.' + s.slice(s.length - exp);
  return `${neg ? '-' : ''}${whole}${frac}`;
}
