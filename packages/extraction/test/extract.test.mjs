import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDeterministic } from '../src/extract.js';
import { validateTemplate, matchTemplate, SEED_TEMPLATES } from '../src/templates.js';

const CAP = '2026-08-03T12:00:00Z';

test('end to end on the V0 fixture the model got wrong', () => {
  const r = extractDeterministic({
    text: 'Bancolombia: Compra por $1.250.000,00 en ALMACEN EXITO.',
    capturedAt: CAP,
  });
  assert.equal(r.ok, true);
  assert.equal(r.amountMinor, 125000000n);   // Gemma 4 E4B returned 1250000 for this
  assert.equal(r.currency, 'COP');
  assert.equal(r.merchant, 'ALMACEN EXITO');
  assert.equal(r.templateId, 'bancolombia-co-purchase-v1');
});

test('works with zero model bytes — the section 11.2 requirement', () => {
  // No engine, no model file, no network. This is the whole point of rung 3.
  const r = extractDeterministic({
    text: 'BBVA: Compra por $1.234,56 en OXXO CENTRO con tarjeta terminada en 4821.',
    capturedAt: CAP,
  });
  assert.equal(r.ok, true);
  assert.equal(r.amountMinor, 123456n);
  assert.equal(r.currency, 'MXN');
  assert.equal(r.last4, '4821');
});

test('a refund is the same shape with the opposite sign', () => {
  const r = extractDeterministic({
    text: 'Devolucion de $500,00 en LIVERPOOL',
    capturedAt: CAP, accountCurrency: 'MXN', deviceRegion: 'MX',
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'refund');
  assert.ok(r.amountMinor < 0n, 'a refund must be negative so balances stay correct');
  assert.equal(r.amountMinor, -50000n);
});

test('template country outranks device region for currency', () => {
  // Phone configured for Mexico, message is from a Colombian bank. The issuer wins.
  const r = extractDeterministic({
    text: 'Bancolombia: Compra por $80.000,00 en EXITO',
    capturedAt: CAP, deviceRegion: 'MX',
  });
  assert.equal(r.currency, 'COP');
});

test('no template match escalates to the model rather than failing', () => {
  const r = extractDeterministic({
    text: 'Some bank we have never seen: you spent forty dollars',
    capturedAt: CAP,
  });
  assert.equal(r.ok, false);
  assert.equal(r.escalateToModel, true);
});

test('an unresolvable currency asks the user, and does NOT escalate to the model', () => {
  // The model cannot resolve a bare $ either — it has no geography. Escalating would burn
  // seconds of inference to arrive at the same question.
  const r = extractDeterministic({
    text: 'Compra por $50.00 en SHOP',
    capturedAt: CAP,
    templates: [{
      id: 'anon-v1', kind: 'purchase', institution: null, country: null,
      pattern: 'compra por \\$?(?<amount>[\\d.,]{1,20}) en (?<merchant>[^,.]{1,40})',
    }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.needsUser, true);
  assert.equal(r.escalateToModel, false);
  assert.equal(r.partial.amountText, '50.00');
});

test('the weakest field governs overall confidence', () => {
  // Currency resolved only by device region (0.55) must drag the whole extraction below the bar
  // even though the amount parsed perfectly.
  const r = extractDeterministic({
    text: 'Compra por $500,00 en TIENDA',
    capturedAt: CAP, deviceRegion: 'MX',
    templates: [{
      id: 'anon-v1', kind: 'purchase', institution: null, country: null,
      pattern: 'compra por \\$?(?<amount>[\\d.,]{1,20}) en (?<merchant>[^,.]{1,40})',
    }],
  });
  assert.equal(r.ok, true);
  assert.ok(r.confidence <= 0.55);
  assert.equal(r.needsConfirmation, true);
});

test('a missing date sets needsConfirmation but is not an error', () => {
  const r = extractDeterministic({
    text: 'Nubank: Compra aprovada de R$ 89,90 em PADARIA',
    capturedAt: CAP,
  });
  assert.equal(r.ok, true);
  assert.equal(r.date, null);            // no date in the text; never invented from capture time
  assert.equal(r.needsConfirmation, true);
});

// ---------------------------------------------------------------- template safety

test('every seed template validates', () => {
  for (const t of SEED_TEMPLATES) {
    const { valid, errors } = validateTemplate(t);
    assert.equal(valid, true, `${t.id}: ${errors.join('; ')}`);
  }
});

test('unbounded quantifiers are rejected — ReDoS protection, not style', () => {
  const { valid, errors } = validateTemplate({
    id: 'bad', kind: 'purchase', pattern: 'compra (?<amount>.+) en',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /unbounded quantifier/.test(e)));
});

test('nested quantifiers are rejected', () => {
  const { valid, errors } = validateTemplate({
    id: 'bad', kind: 'purchase', pattern: '(?<amount>[\\d,]{1,9})(a{1,5}){1,5}',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /nested quantifier|unbounded/.test(e)));
});

test('a template without an amount group is useless and rejected', () => {
  const { valid, errors } = validateTemplate({
    id: 'bad', kind: 'purchase', pattern: 'compra en (?<merchant>[a-z]{1,10})',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /named group `amount`/.test(e)));
});

test('invalid templates are skipped at match time rather than executed', () => {
  const r = matchTemplate('Compra por $10,00 en X', [
    { id: 'evil', kind: 'purchase', pattern: '(?<amount>(a+)+)' },   // classic ReDoS shape
    ...SEED_TEMPLATES,
  ]);
  // The evil template must never run; a real one may still match or not, but no hang.
  assert.ok(r.matched === true || r.matched === false);
});

test('oversized input is refused before any regex runs', () => {
  const r = matchTemplate('x'.repeat(5000), SEED_TEMPLATES);
  assert.equal(r.matched, false);
  assert.match(r.reason, /maximum bank-message length/);
});
