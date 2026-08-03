/**
 * Merchant descriptor normalisation — `data-layer/04-capture.md` §4.6.4.
 *
 * Strips acquirer noise so "SQ *BLUE BOTTLE 1234 OAKLAND CA" and "Blue Bottle Coffee" compare
 * as the same merchant.
 *
 * **This is ONE versioned function.** Changing it invalidates every stored
 * `merchant_patterns.normalized` value, so the version is recorded alongside the output and a
 * change must trigger a recomputation pass. Bumping VERSION without running that pass silently
 * splits one merchant into two and breaks dedupe for every historical row.
 */

export const DESCRIPTOR_VERSION = 1;

/** Acquirer and payment-processor prefixes. Order matters: longest first. */
const ACQUIRER_PREFIXES = [
  'SQ *', 'SQ*', 'SUMUP *', 'SUMUP*', 'PAYPAL *', 'PAYPAL*', 'PP*',
  'IZ *', 'IZ*', 'MP*', 'MERPAGO*', 'TPV*', 'POS ', 'COMPRA ',
];

/** Trailing noise: store numbers, city/state, country codes. */
const TRAILING_NOISE = [
  /\b\d{3,6}\b\s*$/,                 // store number
  /\b[A-Z]{2}\s*$/,                  // trailing state/country code
  /\b(?:CIUDAD DE MEXICO|CDMX|SAO PAULO|BOGOTA|SANTIAGO|LIMA|MEXICO|BRASIL)\b\s*$/i,
];

const DATE_LIKE = /\b\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?\b/g;

/** Latin-1 accent folding, so "CAFÉ" and "CAFE" are one merchant. */
const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

export function normalizeDescriptor(raw) {
  if (raw == null) return { normalized: '', version: DESCRIPTOR_VERSION };

  let s = stripAccents(String(raw)).toUpperCase();

  for (const p of ACQUIRER_PREFIXES) {
    const up = p.toUpperCase();
    if (s.startsWith(up)) { s = s.slice(up.length); break; }
  }

  s = s.replace(DATE_LIKE, ' ');
  s = s.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Standalone 3-6 digit tokens are store/branch numbers wherever they appear, not just at the
  // end. Keeping them splits one merchant across branches: "BLUE BOTTLE 1234 OAKLAND" vs
  // "BLUE BOTTLE 5678 OAKLAND" would score 0.6 on Jaccard instead of 1.0.
  // Short numbers survive, because they are usually part of the name ("7 ELEVEN").
  s = s.replace(/\b\d{3,6}\b/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Trailing noise is stripped repeatedly: "BLUE BOTTLE 1234 OAKLAND CA" sheds CA, then
  // OAKLAND is left as a token (harmless for Jaccard), then 1234.
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of TRAILING_NOISE) {
      const next = s.replace(re, '').trim();
      if (next !== s) { s = next; changed = true; }
    }
  }
  return { normalized: s, version: DESCRIPTOR_VERSION };
}

/** Jaccard over the token sets. */
export function tokenSetJaccard(a, b) {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Dice coefficient over character trigrams — catches spelling drift Jaccard misses. */
export function trigramDice(a, b) {
  const grams = (s) => {
    const p = `  ${s} `;
    const out = new Set();
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
    return out;
  };
  const A = grams(a), B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** §4.6.4: `max(tokenSetJaccard, trigramDice)` over normalised descriptors. */
export function descriptorSimilarity(rawA, rawB) {
  const a = normalizeDescriptor(rawA).normalized;
  const b = normalizeDescriptor(rawB).normalized;
  if (!a || !b) return null;            // null means DROP the component, not score 0
  if (a === b) return 1;
  return Math.max(tokenSetJaccard(a, b), trigramDice(a, b));
}
