import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDate, DATE_CONFIRM_BELOW } from '../src/dates.js';

const CAP = '2026-08-03T12:00:00Z';   // capture timestamp used throughout

test('never returns the capture date as the transaction date', () => {
  // The single most important property. A notification can arrive hours or days late;
  // Android 17 withholds OTP-bearing SMS for up to three hours by policy.
  const r = resolveDate({ text: 'Compra aprovada em PADARIA', capturedAt: CAP });
  assert.equal(r.date, null);
  assert.equal(r.source, 'absent');
  assert.match(r.reason, /capture timestamp separately/);
});

test('ISO 8601 is taken as-is', () => {
  const r = resolveDate({ text: 'Fecha: 2026-07-15', capturedAt: CAP });
  assert.equal(r.date, '2026-07-15');
  assert.equal(r.needsConfirmation, false);
});

test('a component over 12 settles day-first vs month-first', () => {
  const dayFirst = resolveDate({ text: 'Compra el 15/07/2026', capturedAt: CAP });
  assert.equal(dayFirst.date, '2026-07-15');
  assert.match(dayFirst.reason, /15 > 12/);
  assert.equal(dayFirst.needsConfirmation, false);

  const monthFirst = resolveDate({ text: 'Purchase on 07/15/2026', capturedAt: CAP });
  assert.equal(monthFirst.date, '2026-07-15');
  assert.match(monthFirst.reason, /15 > 12/);
});

test('both components under 12 is genuinely ambiguous, and says so', () => {
  // 03/08/2026 is 3 August in LATAM and 8 March in the US. Nothing in the string decides.
  const latam = resolveDate({ text: 'Compra el 03/08/2026', capturedAt: CAP, region: 'MX' });
  assert.equal(latam.date, '2026-08-03');
  assert.ok(latam.confidence < DATE_CONFIRM_BELOW, 'ambiguous dates must require confirmation');
  assert.deepEqual(latam.alternatives, ['2026-03-08']);

  const us = resolveDate({ text: 'Purchase on 03/08/2026', capturedAt: CAP, region: 'US' });
  assert.equal(us.date, '2026-03-08');
  assert.deepEqual(us.alternatives, ['2026-08-03']);
});

test('day-first is the default when no region is known', () => {
  const r = resolveDate({ text: '03/08/2026', capturedAt: CAP });
  assert.equal(r.date, '2026-08-03');   // day-first is the world default
  assert.ok(r.needsConfirmation);
});

test('month names in Spanish, Portuguese and English', () => {
  for (const [text, expected] of [
    ['15 de agosto de 2026', '2026-08-15'],
    ['15 de dezembro de 2025', '2025-12-15'],
    ['Aug 15, 2026', '2026-08-15'],
    ['15 ene 2026', '2026-01-15'],
  ]) {
    const r = resolveDate({ text, capturedAt: CAP });
    assert.equal(r.date, expected, text);
    assert.equal(r.needsConfirmation, false, text);
  }
});

test('relative words resolve against the capture timestamp', () => {
  assert.equal(resolveDate({ text: 'Compra hoy en OXXO', capturedAt: CAP }).date, '2026-08-03');
  assert.equal(resolveDate({ text: 'Compra ayer en OXXO', capturedAt: CAP }).date, '2026-08-02');
  assert.equal(resolveDate({ text: 'Compra ontem', capturedAt: CAP }).date, '2026-08-02');
});

test('a missing year is inferred from the capture timestamp', () => {
  const r = resolveDate({ text: 'Compra el 15/07', capturedAt: CAP });
  assert.equal(r.date, '2026-07-15');
  assert.match(r.reason, /inferred as 2026/);
});

test('the year-boundary trap: 31/12 captured on 2 January belongs to last year', () => {
  // Naively taking the capture year would date this eleven months in the future.
  const r = resolveDate({ text: 'Compra el 31/12', capturedAt: '2027-01-02T09:00:00Z' });
  assert.equal(r.date, '2026-12-31');
  assert.match(r.reason, /inferred as 2026/);
});

test('a receipt is never dated in the future', () => {
  const r = resolveDate({ text: 'Compra el 25/12', capturedAt: CAP }); // 25 Dec, captured 3 Aug
  assert.equal(r.date, '2025-12-25');
  assert.ok(r.date < '2026-08-03');
});

test('two-digit years expand to the 2000s', () => {
  assert.equal(resolveDate({ text: '15/07/26', capturedAt: CAP }).date, '2026-07-15');
});

test('impossible dates are rejected rather than clamped', () => {
  // 31 February must not silently become 3 March.
  const r = resolveDate({ text: '31/02/2026', capturedAt: CAP });
  assert.equal(r.date, null);
});

test('capturedAt is required, and its absence is reported not defaulted', () => {
  const r = resolveDate({ text: '15/07/2026' });
  assert.equal(r.date, null);
  assert.equal(r.source, 'no_capture_timestamp');
});

test('real bank notification strings', () => {
  for (const [text, region, expected] of [
    ['BBVA: Compra por $1.234,56 en OXXO el 15/07/2026', 'MX', '2026-07-15'],
    ['Nubank: Compra aprovada em 03/08/2026', 'BR', '2026-08-03'],
    ['Chase: purchase on 07/15/2026 at WHOLE FOODS', 'US', '2026-07-15'],
  ]) {
    assert.equal(resolveDate({ text, capturedAt: CAP, region }).date, expected, text);
  }
});
