/**
 * Transaction date resolution — `app-layers.md` §4.3.
 *
 * Two rules from the design, both load-bearing:
 *
 *   "A receipt date and a capture timestamp are different facts. Persist both."
 *   "Never derive the transaction date from device time."
 *
 * So this NEVER returns the current date as a transaction date. If the text carries no date,
 * the answer is null and the capture timestamp is stored separately as what it actually is —
 * when we saw the message, not when the money moved. A notification delivered late, an SMS
 * withheld for hours by OTP privacy rules, or a receipt photographed next week would all be
 * silently misdated otherwise.
 *
 * The core ambiguity mirrors the decimal-separator one: `03/08/2026` is 3 August under
 * day-first conventions and 8 March under month-first. It is decidable only when one component
 * exceeds 12.
 *
 * The capture timestamp IS used for one narrow purpose: inferring a missing year, and bounding
 * the result so a receipt cannot be dated in the future.
 */

const MONTHS = {
  // English
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // Spanish
  ene: 1, abr: 4, ago: 8, dic: 12,
  // Portuguese
  fev: 2, mai: 5, set: 9, out: 10, dez: 12,
};

/** Day-first is the world default; these are the notable month-first holdouts. */
const MONTH_FIRST_REGIONS = new Set(['US', 'PH']);

export const DATE_CONFIDENCE = Object.freeze({
  ISO: 0.99,
  MONTH_NAME: 0.95,
  NUMERIC_DECIDABLE: 0.90,     // a component > 12 settles the order
  NUMERIC_BY_REGION: 0.60,     // both ≤ 12; region breaks the tie but could be wrong
  RELATIVE: 0.85,              // "hoy" / "ontem" — relative to capture, which we do trust for this
  NONE: 0,
});

export const DATE_CONFIRM_BELOW = 0.80;

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

const isValidYMD = (y, m, d) => {
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/**
 * @param {object} input
 * @param {string} input.text
 * @param {Date|number|string} input.capturedAt  when the message/receipt was captured. Required:
 *        it is needed to infer a missing year and to reject future dates. It is NEVER used as
 *        the transaction date itself.
 * @param {string} [input.region] ISO 3166-1 alpha-2, to break DD/MM vs MM/DD ties
 * @returns {{date: string|null, confidence: number, source: string, alternatives: string[],
 *            needsConfirmation: boolean, reason: string}}
 */
export function resolveDate(input = {}) {
  const { text = '', region } = input;
  const captured = input.capturedAt ? new Date(input.capturedAt) : null;

  const done = (date, confidence, source, reason, alternatives = []) => ({
    date,
    confidence,
    source,
    alternatives,
    needsConfirmation: confidence < DATE_CONFIRM_BELOW,
    reason,
  });

  if (!captured || Number.isNaN(captured.getTime())) {
    return done(null, DATE_CONFIDENCE.NONE, 'no_capture_timestamp',
      'capturedAt is required — a missing year cannot be inferred and future dates cannot be rejected');
  }
  const capY = captured.getUTCFullYear();

  // 1. ISO 8601. Unambiguous by construction.
  const isoM = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoM) {
    const [, y, m, d] = isoM.map(Number);
    if (isValidYMD(y, m, d)) {
      return done(iso(y, m, d), DATE_CONFIDENCE.ISO, 'iso_8601', 'ISO 8601 date in the text');
    }
  }

  // 2. Month names. "15 de agosto de 2026", "Aug 15", "15 ago 2026".
  const nameM = text.toLowerCase().match(
    /\b(\d{1,2})\s*(?:de\s+)?([a-zç]{3,})\.?(?:\s+(?:de\s+)?(\d{4}|\d{2}))?\b/,
  ) || text.toLowerCase().match(/\b([a-zç]{3,})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/);
  if (nameM) {
    // Either (day, monthWord, year?) or (monthWord, day, year?)
    const a = nameM[1], b = nameM[2];
    const dayFirst = /^\d/.test(a);
    const monthWord = (dayFirst ? b : a).slice(0, 3);
    const day = Number(dayFirst ? a : b);
    const month = MONTHS[monthWord];
    if (month) {
      const { year, inferred } = resolveYear(nameM[3], month, day, capY, captured);
      if (isValidYMD(year, month, day)) {
        return done(iso(year, month, day), DATE_CONFIDENCE.MONTH_NAME, 'month_name',
          inferred ? `month name; year inferred as ${year} from the capture timestamp`
                   : 'month name with an explicit year');
      }
    }
  }

  // 3. Relative words. These legitimately reference the capture moment.
  const lower = text.toLowerCase();
  if (/\b(hoy|hoje|today)\b/.test(lower)) {
    return done(iso(capY, captured.getUTCMonth() + 1, captured.getUTCDate()),
      DATE_CONFIDENCE.RELATIVE, 'relative_today', "'today' resolved against the capture timestamp");
  }
  if (/\b(ayer|ontem|yesterday)\b/.test(lower)) {
    const y = new Date(captured.getTime() - 86400000);
    return done(iso(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate()),
      DATE_CONFIDENCE.RELATIVE, 'relative_yesterday',
      "'yesterday' resolved against the capture timestamp");
  }

  // 4. Numeric D/M or M/D, with optional year.
  const numM = text.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{4}|\d{2}))?\b/);
  if (numM) {
    const p1 = Number(numM[1]);
    const p2 = Number(numM[2]);
    const rawYear = numM[3];

    const dayFirstPossible = p1 >= 1 && p1 <= 31 && p2 >= 1 && p2 <= 12;
    const monthFirstPossible = p2 >= 1 && p2 <= 31 && p1 >= 1 && p1 <= 12;

    // orderReason explains DD/MM vs MM/DD; the year note explains an inferred year.
    // Both matter, so they are composed rather than one replacing the other.
    const build = (day, month, why, conf, orderReason, alts = []) => {
      const { year, inferred } = resolveYear(rawYear, month, day, capY, captured);
      if (!isValidYMD(year, month, day)) return null;
      const yearNote = inferred ? `; year inferred as ${year} from the capture timestamp` : '';
      return done(iso(year, month, day), conf, why, `${orderReason}${yearNote}`, alts);
    };

    if (dayFirstPossible && !monthFirstPossible) {
      const r = build(p1, p2, 'numeric_day_first', DATE_CONFIDENCE.NUMERIC_DECIDABLE,
        `${p1} > 12, so the order must be day-first`);
      if (r) return r;
    }
    if (monthFirstPossible && !dayFirstPossible) {
      const r = build(p2, p1, 'numeric_month_first', DATE_CONFIDENCE.NUMERIC_DECIDABLE,
        `${p2} > 12, so the order must be month-first`);
      if (r) return r;
    }
    if (dayFirstPossible && monthFirstPossible) {
      // Both <= 12. Genuinely ambiguous; region breaks the tie but is not proof.
      const monthFirst = region && MONTH_FIRST_REGIONS.has(region.toUpperCase());
      const day = monthFirst ? p2 : p1;
      const month = monthFirst ? p1 : p2;
      const altDay = monthFirst ? p1 : p2;
      const altMonth = monthFirst ? p2 : p1;
      const other = resolveYear(rawYear, altMonth, altDay, capY, captured);
      const alts = isValidYMD(other.year, altMonth, altDay)
        ? [iso(other.year, altMonth, altDay)] : [];
      const r = build(day, month,
        monthFirst ? 'numeric_month_first' : 'numeric_day_first',
        DATE_CONFIDENCE.NUMERIC_BY_REGION,
        `both components are <= 12, so the order is ambiguous; region ${region ?? '(unset)'} ` +
        `implies ${monthFirst ? 'month' : 'day'}-first`,
        alts);
      if (r) return r;
    }
  }

  // No date in the text. This is NOT an error and must NOT become the capture date.
  return done(null, DATE_CONFIDENCE.NONE, 'absent',
    'no date in the source; store the capture timestamp separately and leave the transaction date unset');
}

/**
 * Infer a missing year, and never let a receipt be dated in the future.
 *
 * The subtle case: a receipt reading "31/12" captured on 2 January belongs to LAST year.
 * Naively taking the capture year puts it eleven months in the future.
 */
function resolveYear(rawYear, month, day, capY, captured) {
  if (rawYear) {
    const n = Number(rawYear);
    return { year: rawYear.length === 2 ? 2000 + n : n, inferred: false };
  }
  const candidate = Date.UTC(capY, month - 1, day);
  // Allow a day of slack for timezone skew between the receipt and the capture clock.
  if (candidate > captured.getTime() + 86400000) {
    return { year: capY - 1, inferred: true };
  }
  return { year: capY, inferred: true };
}
