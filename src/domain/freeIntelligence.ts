/**
 * Free Intelligence — HermesX candidate-truth consumer.
 *
 * This module does not discover providers and does not rank or dispatch models.
 * It consumes normalized free-candidate facts supplied by HermesX and answers
 * whether a candidate may participate in strict zero-cost routing.
 *
 * Keep these dimensions independent:
 *   - free classification / incremental cost
 *   - authentication
 *   - runtime availability
 *   - quota state
 *
 * A 401, 429, quota exhaustion, or provider outage must never rewrite the
 * underlying free classification. Conversely, unknown cost is not safe-free.
 */

export type FreeClassification = "free" | "paid" | "unknown";
export type AuthStatus = "ok" | "failed" | "unknown";
export type RuntimeAvailability =
  | "available"
  | "rate-limited"
  | "quota-exhausted"
  | "provider-down"
  | "unknown";

export interface FreeIntelligenceCandidate {
  provider: string;
  model: string;
  freeClassification: FreeClassification;
  /** 0 when current account/provider entitlement establishes zero incremental spend. */
  incrementalCostNow: number | null;
  freeConfidence: number;
  authStatus: AuthStatus;
  availability: RuntimeAvailability;
  remainingQuota?: number | null;
  resetAt?: string | null;
  contextWindow?: number | null;
  capabilities?: readonly string[];
  latencyMs?: number | null;
  ttftMs?: number | null;
  tokensPerSecond?: number | null;
  recentFailureScore?: number | null;
  /** True when inventory is retained from a last-known-good snapshot. */
  discoveryStale?: boolean;
}

export type FreeIntelligenceExclusionReason =
  | "auth-failed"
  | "rate-limited"
  | "quota-exhausted"
  | "provider-down"
  | "runtime-unknown"
  | "incremental-cost-proven"
  | "incremental-cost-unknown"
  | "free-confidence-too-low";

export interface FreeIntelligenceDecision {
  eligible: boolean;
  reason: FreeIntelligenceExclusionReason | null;
}

export interface StrictZeroCostOptions {
  minFreeConfidence?: number;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Pure eligibility gate for strict zero-cost routing.
 *
 * This is intentionally not a scoring function. Eligible candidates continue
 * into OmniRoute's existing ranking/fallback pipeline with their existing
 * quality, speed, quota, and session-affinity semantics intact.
 */
export function evaluateStrictZeroCostCandidate(
  candidate: FreeIntelligenceCandidate,
  options: StrictZeroCostOptions = {}
): FreeIntelligenceDecision {
  const minFreeConfidence = clampConfidence(options.minFreeConfidence ?? 0.8);

  if (candidate.authStatus === "failed") {
    return { eligible: false, reason: "auth-failed" };
  }
  if (candidate.availability === "rate-limited") {
    return { eligible: false, reason: "rate-limited" };
  }
  if (candidate.availability === "quota-exhausted") {
    return { eligible: false, reason: "quota-exhausted" };
  }
  if (candidate.availability === "provider-down") {
    return { eligible: false, reason: "provider-down" };
  }
  if (candidate.availability !== "available") {
    return { eligible: false, reason: "runtime-unknown" };
  }

  if (candidate.freeClassification === "paid") {
    return { eligible: false, reason: "incremental-cost-proven" };
  }
  if (candidate.freeClassification === "unknown" || candidate.incrementalCostNow === null) {
    return { eligible: false, reason: "incremental-cost-unknown" };
  }
  if (candidate.incrementalCostNow !== 0) {
    return { eligible: false, reason: "incremental-cost-proven" };
  }
  if (clampConfidence(candidate.freeConfidence) < minFreeConfidence) {
    return { eligible: false, reason: "free-confidence-too-low" };
  }

  return { eligible: true, reason: null };
}

/**
 * Filter only. Do not reorder: OmniRoute's established router owns ranking.
 */
export function filterStrictZeroCostCandidates(
  candidates: readonly FreeIntelligenceCandidate[],
  options: StrictZeroCostOptions = {}
): FreeIntelligenceCandidate[] {
  return candidates.filter((candidate) => evaluateStrictZeroCostCandidate(candidate, options).eligible);
}

/**
 * Apply request outcomes without corrupting entitlement truth.
 *
 * The returned object preserves `freeClassification`, `incrementalCostNow`, and
 * `freeConfidence`; only runtime/auth state is updated.
 */
export function applyRuntimeStatus(
  candidate: FreeIntelligenceCandidate,
  statusCode: number
): FreeIntelligenceCandidate {
  if (statusCode === 401) {
    return { ...candidate, authStatus: "failed" };
  }
  if (statusCode === 429) {
    return { ...candidate, availability: "rate-limited" };
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return { ...candidate, availability: "provider-down" };
  }
  if (statusCode >= 200 && statusCode <= 299) {
    return { ...candidate, authStatus: "ok", availability: "available" };
  }
  return candidate;
}
