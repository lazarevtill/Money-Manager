/**
 * Deterministic bank-message templates — `app-layers.md` §5.5, fallback rung 3.
 *
 * Two jobs. First, the app must be complete and useful with **zero model bytes** (§11.2): before
 * the 2.6 GB download finishes, on a device where the engine cannot run, or when the circuit
 * breaker has tripped, templates are the extraction path. Second, when the model IS available
 * they front-run it — a matched template is faster, free, and more accurate than a 2B model.
 *
 * **Templates are data, not code** (§14 correction C2/C3). They ship over the signed static
 * channel and can be fixed without a store release, because bank wording rots on the bank's
 * schedule rather than ours. That is also why every pattern is validated before use: a template
 * is attacker-adjacent input, and a bad one must fail closed rather than hang the drain thread.
 *
 * A template never produces a number. It captures `amount_text` verbatim and hands it to the
 * money normaliser, exactly as the model path does — V0 proved that split is required.
 */

/** Hard limits. §8's learned-regex rules applied to authored templates too. */
export const PATTERN_LIMITS = Object.freeze({
  MAX_PATTERN_LENGTH: 400,
  MAX_INPUT_LENGTH: 2000,     // bank messages are short; anything longer is not one
  EXEC_BUDGET_MS: 10,         // §8: two timeouts quarantine a template
});

/** Constructs that make catastrophic backtracking possible. Rejected outright. */
// A group whose body already contains a quantifier, itself quantified. Catches the bounded
// form (a{1,5}){1,5} as well as the classic (a+)+ — the first is just as explosive.
const NESTED_QUANTIFIER = /\([^()]*[*+{][^()]*\)[*+{]/;
const UNBOUNDED_QUANTIFIER = /(?<!\\)[+*](?!\?)|\{\d+,\}/;

/**
 * Validate a template before it is ever executed.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateTemplate(t) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  need(t && typeof t === 'object', 'template must be an object');
  if (!t || typeof t !== 'object') return { valid: false, errors };

  need(typeof t.id === 'string' && t.id.length > 0, 'id is required');
  need(typeof t.pattern === 'string', 'pattern must be a string');
  need(['purchase', 'refund', 'transfer', 'withdrawal', 'payment'].includes(t.kind),
    `kind '${t.kind}' is not recognised`);

  // An institution-specific template MUST carry an anchor. Without one its pattern matches
  // other banks' messages too, and since matching is first-wins, whichever template happens to
  // be first silently supplies its own country -> its own currency. That is a 100x error
  // produced by list ordering, which is exactly the kind of bug nobody finds by reading.
  need(!(t.country || t.institution) || (typeof t.anchor === 'string' && t.anchor.length > 1),
    'a template with an institution or country must define an `anchor` substring that ' +
    'identifies the sender, or it will match messages from other banks');

  if (typeof t.pattern === 'string') {
    need(t.pattern.length <= PATTERN_LIMITS.MAX_PATTERN_LENGTH,
      `pattern exceeds ${PATTERN_LIMITS.MAX_PATTERN_LENGTH} characters`);
    need(!NESTED_QUANTIFIER.test(t.pattern),
      'pattern contains a nested quantifier, which permits catastrophic backtracking');
    need(!UNBOUNDED_QUANTIFIER.test(t.pattern),
      'pattern contains an unbounded quantifier; use a bounded form such as {1,60}');
    need(t.pattern.includes('(?<amount>'),
      'pattern must capture a named group `amount` — a template that cannot find the amount is useless');
    try {
      new RegExp(t.pattern, 'iu');
    } catch (e) {
      errors.push(`pattern does not compile: ${e.message}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Apply the first matching template.
 *
 * @param {string} text
 * @param {Array} templates
 * @returns {{matched: boolean, templateId?: string, kind?: string, fields?: object,
 *            reason?: string}}
 */
export function matchTemplate(text, templates) {
  const input = String(text ?? '');
  if (input.length > PATTERN_LIMITS.MAX_INPUT_LENGTH) {
    return { matched: false, reason: 'input exceeds the maximum bank-message length' };
  }

  // Anchored templates first, generic ones last. A generic pattern must never pre-empt a
  // bank-specific one that would have supplied a country.
  const ordered = [...templates].sort(
    (a, b) => (b.anchor ? 1 : 0) - (a.anchor ? 1 : 0),
  );

  for (const t of ordered) {
    const { valid } = validateTemplate(t);
    if (!valid) continue;                       // fail closed; never execute an invalid pattern

    // Cheap literal gate before any regex runs.
    if (t.anchor && !input.toLowerCase().includes(t.anchor.toLowerCase())) continue;

    const started = Date.now();
    let m = null;
    try {
      m = new RegExp(t.pattern, 'iu').exec(input);
    } catch {
      continue;
    }
    // Cannot pre-empt a runaway regex in JS, but we can refuse to trust one that took too long
    // and mark it for quarantine, which is what §8 asks for.
    const elapsed = Date.now() - started;
    if (elapsed > PATTERN_LIMITS.EXEC_BUDGET_MS) {
      return { matched: false, reason: `template ${t.id} exceeded the exec budget (${elapsed}ms)`,
        quarantine: t.id };
    }
    if (!m) continue;

    const g = m.groups ?? {};
    return {
      matched: true,
      templateId: t.id,
      kind: t.kind,
      institution: t.institution,
      country: t.country,
      currencyHint: t.currencyHint ?? null,
      fields: {
        amountText: g.amount ?? null,
        merchant: g.merchant?.trim() ?? null,
        last4: g.last4 ?? null,
        dateText: g.date ?? null,
      },
    };
  }
  return { matched: false, reason: 'no template matched' };
}

/**
 * Seed templates. In production these arrive over the signed channel; this set exists so the
 * app is useful on first run and so the parser has something to test against.
 *
 * Every quantifier is bounded. `{1,40}` rather than `+` is not stylistic — see §8.
 */
export const SEED_TEMPLATES = Object.freeze([
  {
    id: 'bbva-mx-purchase-v1',
    institution: 'BBVA', country: 'MX', channel: 'notification', kind: 'purchase',
    anchor: 'BBVA', currencyHint: 'MXN',
    // merchant is LAZY and the clause is terminated. A greedy merchant swallows
    // "con tarjeta terminada en 4821" and the card digits are silently lost.
    pattern: 'compra por \\$?(?<amount>[\\d.,]{1,20}) en (?<merchant>[^,.]{1,40}?)' +
             '(?: con tarjeta terminada en (?<last4>\\d{4}))?[,.]',
  },
  {
    id: 'nubank-br-purchase-v1',
    institution: 'Nubank', country: 'BR', channel: 'notification', kind: 'purchase',
    anchor: 'Nubank', currencyHint: 'BRL',
    pattern: 'compra aprovada de R\\$ ?(?<amount>[\\d.,]{1,20}) em (?<merchant>[^,.]{1,40})',
  },
  {
    id: 'bancolombia-co-purchase-v1',
    institution: 'Bancolombia', country: 'CO', channel: 'notification', kind: 'purchase',
    anchor: 'Bancolombia', currencyHint: 'COP',
    pattern: 'compra por \\$?(?<amount>[\\d.,]{1,20}) en (?<merchant>[^,.]{1,40})',
  },
  {
    id: 'generic-refund-v1',
    institution: null, country: null, channel: 'notification', kind: 'refund',
    currencyHint: null,
    pattern: '(?:devoluci[oó]n|reembolso|estorno|refund) (?:de |por |of )?' +
             '\\$?(?<amount>[\\d.,]{1,20})(?: (?:en|em|at) (?<merchant>[^,.]{1,40}))?',
  },
]);
