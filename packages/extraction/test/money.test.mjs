import test from 'node:test';
import assert from 'node:assert/strict';
import { toMinorUnits, formatMinorUnits, MAX_MINOR_UNITS } from '../src/money.js';

const okv = (text, cur) => {
  const r = toMinorUnits(text, cur);
  assert.equal(r.kind, 'ok', `expected ok for ${text} ${cur}, got ${r.kind}: ${r.reason ?? ''}`);
  return r.minorUnits;
};

// The exact V0 fixtures, so this file and the on-device gate cannot silently diverge.
test('V0 fixtures — the cases the device gate measures', () => {
  assert.equal(okv('1.234,56', 'MXN'), 123456n);        // LATAM: dot groups, comma decimal
  assert.equal(okv('89,90', 'BRL'), 8990n);
  assert.equal(okv('1.250.000,00', 'COP'), 125000000n); // the 100x error the model made
  assert.equal(okv('45.990', 'CLP'), 45990n);           // exponent 0 — NOT 4599000
  assert.equal(okv('1,234.56', 'USD'), 123456n);        // US: comma groups, dot decimal
  assert.equal(okv('99,00', 'MXN'), 9900n);
  assert.equal(okv('1.099,00', 'BRL'), 109900n);
  assert.equal(okv('7,50', 'BRL'), 750n);
  assert.equal(okv('0,99', 'MXN'), 99n);
  assert.equal(okv('12.500.000,00', 'COP'), 1250000000n);
});

test('the COP case that failed on-device is exact', () => {
  // Gemma 4 E4B returned 1250000 for this. Off by 100x.
  assert.equal(okv('1.250.000,00', 'COP'), 125000000n);
  assert.notEqual(okv('1.250.000,00', 'COP'), 1250000n);
});

test('exponent-0 currencies never treat a separator as decimal', () => {
  assert.equal(okv('45.990', 'CLP'), 45990n);
  assert.equal(okv('1.234.567', 'CLP'), 1234567n);
  assert.equal(okv('1,234,567', 'JPY'), 1234567n);
  // A trailing ",00" on CLP is grouping-shaped nonsense, not decimals -> must not become 4599000
  assert.notEqual(okv('45.990', 'CLP'), 4599000n);
});

test('3-decimal currencies', () => {
  assert.equal(okv('12.345,678', 'BHD'), 12345678n);   // both separators -> rightmost decides
});

test('a lone separator with 3 trailing digits on a 2-decimal currency is NOT ambiguous', () => {
  // Reading the dot as a decimal point would mean 1.299 pesos - fractional cents, which is
  // not representable. Grouping is the only arithmetically valid reading, so it is decidable.
  // app-layers 4.3 cited this as the ambiguous case; the arithmetic says otherwise.
  assert.equal(okv('1.299', 'MXN'), 129900n);
  assert.equal(okv('1,299', 'USD'), 129900n);
});

test('the genuinely ambiguous case is a 3-decimal currency', () => {
  // "1,500" KWD is 1500 KWD (grouped) or 1.500 KWD (decimal). Both are whole fils.
  // Nothing in the string decides it, so both candidates are offered and neither is chosen.
  const r = toMinorUnits('1,500', 'KWD');
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(r.candidates, [1500000n, 1500n]);
});

test('rightmost separator wins when both are present', () => {
  assert.equal(okv('1.234,56', 'EUR'), 123456n);
  assert.equal(okv('1,234.56', 'EUR'), 123456n);
  assert.equal(okv('1.234.567,89', 'EUR'), 123456789n);
});

test('symbols, codes and whitespace are stripped', () => {
  assert.equal(okv('$ 1.234,56', 'MXN'), 123456n);
  assert.equal(okv('R$ 89,90', 'BRL'), 8990n);
  assert.equal(okv('MXN 99,00', 'MXN'), 9900n);
  assert.equal(okv(' 1.234,56 ', 'MXN'), 123456n); // NBSP
});

test('negatives, including accounting parentheses', () => {
  assert.equal(okv('-1.234,56', 'MXN'), -123456n);
  assert.equal(okv('(1.234,56)', 'MXN'), -123456n);
});

test('invalid input is rejected rather than coerced', () => {
  assert.equal(toMinorUnits('', 'MXN').kind, 'invalid');
  assert.equal(toMinorUnits('abc', 'MXN').kind, 'invalid');
  assert.equal(toMinorUnits('1,2345', 'MXN').kind, 'invalid');     // 4 decimals on exp-2
  assert.equal(toMinorUnits('1.234,56', 'XYZ').kind, 'invalid');   // unknown currency
});

test('the 2^53 bound is enforced, because op-sqlite reads integers as doubles', () => {
  const atLimit = (MAX_MINOR_UNITS / 100n).toString(); // safely inside
  assert.equal(toMinorUnits(atLimit, 'CLP').kind, 'ok');
  assert.equal(toMinorUnits('99999999999999999', 'MXN').kind, 'invalid');
});

test('round-trips through formatMinorUnits', () => {
  for (const [text, cur, expected] of [
    ['1.234,56', 'MXN', '1234.56'],
    ['45.990', 'CLP', '45990'],
    ['0,99', 'MXN', '0.99'],
  ]) {
    assert.equal(formatMinorUnits(okv(text, cur), cur), expected);
  }
});

test('no floating point anywhere — results are BigInt', () => {
  const r = toMinorUnits('1.250.000,00', 'COP');
  assert.equal(typeof r.minorUnits, 'bigint');
});
