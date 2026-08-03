import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePair, decide, strongIdentifierConflict, DECISION } from '../src/dedupe.js';
import { normalizeDescriptor, descriptorSimilarity } from '../src/descriptor.js';

const T0 = 1_754_222_000_000;
const obs = (o) => ({
  channel: 'android_notification', role: 'bank_auth', postTime: T0,
  amountMinor: 48000n, currency: 'MXN', descriptor: 'BLUE BOTTLE', accountId: 'acct-1',
  refs: [], ...o,
});

// ---------------------------------------------------------------- worked examples from §4.6.6
// These numbers are the specification. If the implementation drifts, these fail.

test('§4.6.6 row 1 — push vs SMS, 38s apart, exact ref: capped at 1.0', () => {
  const a = obs({ channel: 'android_notification', refs: ['auth:998877'] });
  const b = obs({ channel: 'android_sms', role: 'bank_sms', postTime: T0 + 38_000,
    refs: ['auth:998877'] });
  const r = scorePair(a, b);
  // 0.30 + 0.20·0.73 + 0.25 + 0.15 + 0.10 = 0.946, +0.25 strong-ref bonus -> capped
  assert.equal(r.strongRef, true);
  assert.equal(r.score, 1);
  assert.ok(Math.abs(r.components.time - 0.729) < 0.01, `s_time ${r.components.time}`);
});

test('§4.6.6 row 3 — receipt vs auth 48 min apart, no ref: ≈0.74 SUGGEST', () => {
  const a = obs({ role: 'bank_auth' });
  const b = obs({ channel: 'share_sheet', role: 'receipt', postTime: T0 + 2_880_000,
    accountId: null, last4: null });
  const r = scorePair(a, b);
  // (0.30 + 0.20·0.202 + 0.25 + 0.15·0.5) / 0.90 ≈ 0.74
  assert.ok(Math.abs(r.score - 0.739) < 0.01, `expected ≈0.739, got ${r.score}`);
  assert.equal(r.components.ref, null, 'ref must be dropped, never scored 0');
  assert.equal(r.includedWeight, 0.90);
  const d = decide([{ incoming: a, existing: b }]);
  assert.equal(d.decision, DECISION.SUGGEST);
});

test('§4.6.6 statement row — 3 days later, τ=5d: ≈0.90 AUTO_MERGE', () => {
  const a = obs({ role: 'bank_auth' });
  const b = obs({ channel: 'statement', role: 'statement', postTime: T0 + 3 * 86400_000 });
  const r = scorePair(a, b);
  // (0.30 + 0.20·0.549 + 0.25 + 0.15) / 0.90 ≈ 0.90
  assert.ok(Math.abs(r.score - 0.9) < 0.015, `expected ≈0.90, got ${r.score}`);
  const d = decide([{ incoming: a, existing: b }]);
  assert.equal(d.decision, DECISION.AUTO_MERGE);
});

// ---------------------------------------------------------------- the two-coffees case

test('G5 — two pushes from the same channel are never fuzzy-compared', () => {
  const a = obs({ postTime: T0, refs: ['auth:111'] });
  const b = obs({ postTime: T0 + 180_000, refs: ['auth:222'] });
  const r = scorePair(a, b);
  assert.equal(r.blockedBy, 'G5');
  assert.equal(r.decision, DECISION.NEW);
  assert.match(r.reason, /one message per event/);
});

test('G3 — differing same-class refs forbid merging regardless of score', () => {
  // Identical in every other respect: same amount, same merchant, same second.
  const a = obs({ channel: 'android_notification', refs: ['auth:111'] });
  const b = obs({ channel: 'android_sms', role: 'bank_sms', refs: ['auth:222'] });
  const r = scorePair(a, b);
  assert.equal(r.blockedBy, 'G3');
  assert.equal(r.score, 0);
  assert.match(r.reason, /same-class refs differ/);
});

test('G3 does not fire across different ref classes', () => {
  const a = obs({ refs: ['auth:111'] });
  const b = obs({ channel: 'android_sms', role: 'bank_sms', refs: ['folio:222'] });
  assert.equal(strongIdentifierConflict(a.refs, b.refs).conflict, false);
});

test('density ≥ 2 blocks auto-merge and asks one group question', () => {
  const a = obs({ channel: 'android_sms', role: 'bank_sms', postTime: T0 + 1000 });
  const b = obs({ postTime: T0 });
  const d = decide([{ incoming: a, existing: b }], { density: 2 });
  assert.notEqual(d.decision, DECISION.AUTO_MERGE);
  assert.equal(d.groupQuestion, true);
});

test('a thin margin blocks auto-merge even at a high score', () => {
  const inc = obs({ channel: 'android_sms', role: 'bank_sms', postTime: T0 + 1000 });
  const d = decide([
    { incoming: inc, existing: obs({ postTime: T0 }) },
    { incoming: inc, existing: obs({ postTime: T0 + 2000 }) },   // near-identical runner-up
  ]);
  assert.ok(d.margin < 0.12, `margin ${d.margin}`);
  assert.equal(d.decision, DECISION.SUGGEST);
});

// ---------------------------------------------------------------- component behaviour

test('missing components are dropped and weights renormalised, never scored zero', () => {
  const a = obs({ descriptor: null, accountId: null, last4: null });
  const b = obs({ channel: 'android_sms', role: 'bank_sms', descriptor: null,
    accountId: null, last4: null });
  const r = scorePair(a, b);
  assert.equal(r.components.merchant, null);
  assert.equal(r.components.account, null);
  assert.equal(r.includedWeight, 0.50);   // amount + time only
  assert.ok(r.score > 0.9, 'dropping components must not depress the score');
});

test('a settlement above its authorization is tolerated up to 25% for tip classes', () => {
  const auth = obs({ amountMinor: 40000n, tipClass: true });
  const settle = obs({ channel: 'statement', role: 'statement', amountMinor: 48000n,
    tipClass: true });
  const r = scorePair(auth, settle);
  // r = 1.20 -> 1 - 0.6·(0.20/0.25) = 0.52
  assert.ok(Math.abs(r.components.amount - 0.52) < 0.001, `${r.components.amount}`);
});

test('a one-minor-unit rounding difference still scores 0.95', () => {
  const a = obs();
  const b = obs({ channel: 'android_sms', role: 'bank_sms', amountMinor: 48001n });
  assert.equal(scorePair(a, b).components.amount, 0.95);
});

// ---------------------------------------------------------------- descriptor normalisation

test('acquirer prefixes and trailing noise are stripped', () => {
  assert.equal(normalizeDescriptor('SQ *BLUE BOTTLE 1234 OAKLAND CA').normalized,
    'BLUE BOTTLE OAKLAND');
  assert.equal(normalizeDescriptor('MP*STARBUCKS CDMX').normalized, 'STARBUCKS');
  assert.equal(normalizeDescriptor('PAYPAL *NETFLIX').normalized, 'NETFLIX');
});

test('accents fold, so CAFÉ and CAFE are one merchant', () => {
  assert.equal(normalizeDescriptor('CAFÉ AZUL').normalized, 'CAFE AZUL');
  assert.equal(descriptorSimilarity('CAFÉ AZUL', 'Cafe Azul'), 1);
});

test('a missing descriptor drops the component rather than scoring zero', () => {
  assert.equal(descriptorSimilarity('BLUE BOTTLE', null), null);
  assert.equal(descriptorSimilarity(null, null), null);
});

test('the descriptor version is recorded, because changing it invalidates stored values', () => {
  const r = normalizeDescriptor('SQ *X');
  assert.equal(typeof r.version, 'number');
});

test('branch numbers are stripped so one merchant does not split across stores', () => {
  assert.equal(descriptorSimilarity('BLUE BOTTLE 1234 OAKLAND', 'BLUE BOTTLE 5678 OAKLAND'), 1);
  // Short digits survive: they are usually part of the name.
  assert.equal(normalizeDescriptor('7 ELEVEN').normalized, '7 ELEVEN');
});
