/**
 * Cross-channel observation matching — `data-layer/04-capture.md` §4.6.4–§4.6.5.
 *
 * One purchase arrives as a bank push, an SMS, a photographed receipt and later a statement
 * line. They must collapse into one transaction. Two identical coffees bought three minutes
 * apart must NOT collapse. Those two requirements pull in opposite directions, and no tolerance
 * value satisfies both — which is why the design leads with **structural gates** and only then
 * scores.
 *
 * Implemented here: G3 (strong-identifier), G5 (same-channel), the weighted score with
 * renormalisation, and the AUTO/SUGGEST/NEW decision. G6 slot capacity and G9 conservation live
 * in the database (unique index and a count invariant) and are deliberately not duplicated.
 */

import { descriptorSimilarity } from './descriptor.js';

export const W = Object.freeze({
  amount: 0.30, time: 0.20, merchant: 0.25, account: 0.15, ref: 0.10,
});

export const THRESHOLDS = Object.freeze({
  AUTO: 0.88,
  AUTO_MARGIN: 0.12,
  AUTO_MARGIN_DENSE: 0.25,
  SUGGEST: 0.55,
  STRONG_REF_BONUS: 0.25,
  DENSITY_PENALTY: 0.20,
});

/** Time constants by role pair, seconds. §4.6.3's table. */
export const TAU = Object.freeze({
  'bank_auth:bank_auth': 120,
  'bank_auth:receipt': 1800,
  'bank_auth:statement': 5 * 86400,
  default: 120,
});

export const DECISION = Object.freeze({ AUTO_MERGE: 'AUTO_MERGE', SUGGEST: 'SUGGEST', NEW: 'NEW' });

/** A reference like "auth:123456" — class before the colon. */
const refClass = (r) => String(r).split(':')[0];

/**
 * G3 — the strong-identifier gate.
 *
 * If both sides carry a reference of the SAME class and the values differ, merging is forbidden
 * regardless of score. Two coffees with different auth codes are definitively two purchases.
 * This is the rule that makes the whole thing safe: it is a proof of difference, not evidence.
 */
export function strongIdentifierConflict(refsA = [], refsB = []) {
  for (const a of refsA) {
    for (const b of refsB) {
      if (refClass(a) === refClass(b) && a !== b) {
        return { conflict: true, reason: `same-class refs differ: '${a}' vs '${b}'` };
      }
    }
  }
  return { conflict: false };
}

export function strongIdentifierMatch(refsA = [], refsB = []) {
  return refsA.some((a) => refsB.includes(a));
}

/** s_amount per §4.6.4. Returns null to DROP the component. */
export function amountSimilarity(a, b) {
  if (a.currency && b.currency && a.currency !== b.currency) {
    if (a.originalMinor != null && b.originalMinor != null) {
      return a.originalMinor === b.originalMinor ? 1 : 0;
    }
    return null;                       // cross-currency without originals: no signal
  }
  if (a.role === 'preauth' || b.role === 'preauth') return null;   // drop, renormalize

  const x = a.amountMinor, y = b.amountMinor;
  if (x === y) return 1;
  const diff = x > y ? x - y : y - x;
  if (diff <= 1n) return 0.95;

  // Tip tolerance: a settlement may exceed its authorization by up to 25%.
  if (a.tipClass || b.tipClass) {
    const settle = x > y ? x : y;
    const auth = x > y ? y : x;
    if (auth > 0n) {
      const r = Number(settle) / Number(auth);
      if (r >= 1 && r <= 1.25) return 1 - 0.6 * ((r - 1) / 0.25);
    }
  }
  return 0;
}

export function timeSimilarity(tA, tB, tau) {
  return Math.exp(-Math.abs(tA - tB) / 1000 / tau);
}

/** s_account: 1.0 same account or same card last4; 0.5 if exactly one side is unknown. */
export function accountSimilarity(a, b) {
  const known = (o) => o.accountId != null || o.last4 != null;
  if (!known(a) && !known(b)) return null;
  if (!known(a) || !known(b)) return 0.5;
  if (a.accountId && b.accountId) return a.accountId === b.accountId ? 1 : 0;
  if (a.last4 && b.last4) return a.last4 === b.last4 ? 1 : 0;
  return 0.5;
}

/**
 * Score a candidate pair. Components that return null are dropped and the weights renormalised
 * over what remains — never treated as zero, which would silently punish missing data.
 */
export function scorePair(a, b, { density = 0 } = {}) {
  const g5 = a.channel === b.channel && a.role === b.role;
  if (g5) {
    return {
      score: 0, decision: DECISION.NEW, blockedBy: 'G5',
      reason: 'same channel and role: a bank emits one message per event, so these are two events',
    };
  }
  const g3 = strongIdentifierConflict(a.refs, b.refs);
  if (g3.conflict) {
    return { score: 0, decision: DECISION.NEW, blockedBy: 'G3', reason: g3.reason };
  }

  const tau = TAU[`${a.role}:${b.role}`] ?? TAU[`${b.role}:${a.role}`] ?? TAU.default;
  const components = {
    amount: amountSimilarity(a, b),
    time: timeSimilarity(a.postTime, b.postTime, tau),
    merchant: descriptorSimilarity(a.descriptor, b.descriptor),
    account: accountSimilarity(a, b),
    // s_ref is 1 or absent, never 0: differing same-class refs already died at G3.
    ref: strongIdentifierMatch(a.refs, b.refs) ? 1 : null,
  };

  let weighted = 0;
  let included = 0;
  for (const [k, v] of Object.entries(components)) {
    if (v == null) continue;
    weighted += W[k] * v;
    included += W[k];
  }
  if (included === 0) {
    return { score: 0, decision: DECISION.NEW, reason: 'no comparable components', components };
  }

  let score = weighted / included;
  const strongRef = components.ref === 1;
  if (strongRef) score = Math.min(1, score + THRESHOLDS.STRONG_REF_BONUS);
  if (density >= 2) score -= THRESHOLDS.DENSITY_PENALTY;
  score = Math.max(0, score);

  return { score, components, includedWeight: included, strongRef, density };
}

/**
 * Decide across all candidates at once. §4.6.5 is explicit that this is an assignment problem,
 * not a series of independent pairwise yes/nos — the margin to the runner-up is what separates
 * a confident merge from a coin flip.
 */
export function decide(candidates, { density = 0 } = {}) {
  const scored = candidates
    .map((c) => ({ ...c, ...scorePair(c.incoming, c.existing, { density }) }))
    .sort((x, y) => y.score - x.score);

  if (scored.length === 0) return { decision: DECISION.NEW, reason: 'no candidates' };

  const best = scored[0];
  const second = scored[1]?.score ?? 0;
  const margin = best.score - second;

  if (best.blockedBy) {
    return { ...best, decision: DECISION.NEW, margin, runnerUp: second };
  }

  const marginNeeded = density >= 2 ? THRESHOLDS.AUTO_MARGIN_DENSE : THRESHOLDS.AUTO_MARGIN;
  const autoAllowed =
    best.score >= THRESHOLDS.AUTO &&
    margin >= marginNeeded &&
    (density < 2 || best.strongRef);

  let decision;
  if (autoAllowed) decision = DECISION.AUTO_MERGE;
  else if (best.score >= THRESHOLDS.SUGGEST) decision = DECISION.SUGGEST;
  else decision = DECISION.NEW;

  return {
    ...best,
    decision,
    margin,
    runnerUp: second,
    // At density >= 2 the design asks ONE group question rather than N independent ones,
    // because the ambiguity is between the candidates, not within any single pair.
    groupQuestion: density >= 2 && decision !== DECISION.AUTO_MERGE,
  };
}
