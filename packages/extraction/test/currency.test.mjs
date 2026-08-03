import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrency, CONFIRM_BELOW } from '../src/currency.js';
import { toMinorUnits } from '../src/money.js';

test('an explicit ISO code beats everything, including the model', () => {
  const r = resolveCurrency({
    text: 'Compra por MXN 1.234,56 en OXXO',
    modelGuess: 'USD',              // model is wrong; text is authoritative
    deviceRegion: 'US',
  });
  assert.equal(r.currency, 'MXN');
  assert.equal(r.source, 'explicit_iso');
  assert.equal(r.needsConfirmation, false);
});

test('unambiguous symbols resolve without geography', () => {
  for (const [text, expected] of [
    ['Compra aprovada de R$ 89,90', 'BRL'],
    ['Pago de € 45,00', 'EUR'],
    ['Charged £12.50', 'GBP'],
    ['Compra por S/ 150,00', 'PEN'],
  ]) {
    const r = resolveCurrency({ text });
    assert.equal(r.currency, expected, text);
    assert.equal(r.source, 'unambiguous_symbol');
    assert.equal(r.needsConfirmation, false);
  }
});

test('prefixed dollar symbols beat the bare one', () => {
  assert.equal(resolveCurrency({ text: 'US$ 100.00' }).currency, 'USD');
  assert.equal(resolveCurrency({ text: 'MX$ 100,00' }).currency, 'MXN');
  assert.equal(resolveCurrency({ text: 'R$ 100,00' }).currency, 'BRL');
});

test('a bare $ is narrowed by merchant country, and alternatives stay visible', () => {
  const r = resolveCurrency({
    text: 'Compra por $1.250.000,00 en ALMACEN EXITO',
    merchantCountry: 'CO',
  });
  assert.equal(r.currency, 'COP');
  assert.equal(r.source, 'symbol_plus_merchant_country');
  assert.ok(r.alternatives.includes('USD'));
  assert.ok(r.alternatives.includes('MXN'));
});

test('device region is used only when merchant country is unknown, and is flagged low', () => {
  const r = resolveCurrency({ text: 'Compra por $500,00', deviceRegion: 'MX' });
  assert.equal(r.currency, 'MXN');
  assert.equal(r.source, 'symbol_plus_device_region');
  // A traveller's device region is exactly the case this gets wrong.
  assert.ok(r.confidence < CONFIRM_BELOW, 'device-region resolution must require confirmation');
  assert.match(r.reason, /travelling/);
});

test('merchant country wins over device region — the traveller case', () => {
  const r = resolveCurrency({
    text: 'Compra por $500,00',
    merchantCountry: 'CL',   // user is in Chile
    deviceRegion: 'MX',      // phone still set to Mexico
  });
  assert.equal(r.currency, 'CLP');
  assert.equal(r.source, 'symbol_plus_merchant_country');
});

test('an unnarrowable $ resolves to nothing rather than guessing', () => {
  const r = resolveCurrency({ text: 'Charged $50.00' });
  assert.equal(r.currency, null);
  assert.equal(r.source, 'ambiguous_symbol_unresolved');
  assert.equal(r.needsConfirmation, true);
  assert.deepEqual(r.alternatives.slice(0, 2), ['USD', 'MXN']);
});

test('the model guess ranks below every deterministic signal', () => {
  // No symbol, no code: only then does the model get a say.
  const r = resolveCurrency({ text: 'Compra por 500,00', modelGuess: 'BRL' });
  assert.equal(r.currency, 'BRL');
  assert.equal(r.source, 'model_guess');
  assert.ok(r.confidence < CONFIRM_BELOW, 'a model guess must never auto-commit');
});

test('account currency is the last resort and is flagged as such', () => {
  const r = resolveCurrency({ text: 'Compra por 500,00', accountCurrency: 'MXN' });
  assert.equal(r.currency, 'MXN');
  assert.equal(r.source, 'account_default');
  assert.equal(r.needsConfirmation, true);
});

test('nothing at all resolves to null, not to a default', () => {
  const r = resolveCurrency({ text: 'Payment received' });
  assert.equal(r.currency, null);
  assert.equal(r.confidence, 0);
});

test('the exponent-0 trap: CLP vs MXN on the same symbol', () => {
  // Identical text, different merchant country. The exponent differs, so a wrong currency
  // misplaces the decimal point by 100x — this is the failure the ladder exists to prevent.
  const text = 'Compra por $45.990';

  const cl = resolveCurrency({ text, merchantCountry: 'CL' });
  const mx = resolveCurrency({ text, merchantCountry: 'MX' });
  assert.equal(cl.currency, 'CLP');
  assert.equal(mx.currency, 'MXN');

  // CLP exponent 0 -> 45990 minor units (45,990 pesos)
  assert.equal(toMinorUnits('45.990', cl.currency).minorUnits, 45990n);
  // MXN exponent 2 -> 4599000 minor units (45,990.00 pesos) - a 100x difference
  assert.equal(toMinorUnits('45.990', mx.currency).minorUnits, 4599000n);
});

test('resolution feeds the normaliser end to end', () => {
  const text = 'Bancolombia: Compra por $1.250.000,00 en ALMACEN EXITO.';
  const r = resolveCurrency({ text, merchantCountry: 'CO' });
  const m = toMinorUnits('1.250.000,00', r.currency);
  assert.equal(m.kind, 'ok');
  assert.equal(m.minorUnits, 125000000n);   // the value the model itself got wrong in V0
});
