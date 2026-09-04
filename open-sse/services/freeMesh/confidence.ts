import type { EvidenceRecord, FreeApiCandidate } from "./types";

const FREE_EVIDENCE_POINTS: Record<EvidenceRecord["kind"], number> = {
  "live-zero-cost-inference": 100,
  "provider-entitlement": 90,
  "operator-policy": 90,
  "verified-free-tier": 80,
  "pricing-zero-consensus": 60,
  "pricing-zero-single": 40,
  discovery: 0,
  "runtime-observation": 0,
  "source-disagreement": -25,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Economic confidence deliberately ignores rate limiting/provider health. */
export function computeFreeConfidence(evidence: readonly EvidenceRecord[]): number {
  let score = 0;
  for (const record of evidence) {
    score += FREE_EVIDENCE_POINTS[record.kind];
    if (record.stale) score -= 20;
  }
  return clamp01(score / 100);
}

export function computeAvailabilityConfidence(
  candidate: Pick<FreeApiCandidate, "auth" | "runtime">,
  now: number = Date.now(),
  staleAfterMs: number = 15 * 60 * 1000
): number {
  if (candidate.auth.status === "failed") return 1;

  const { availability, lastSuccessfulRequest, lastProbeAt } = candidate.runtime;
  if (availability === "unknown" && !lastSuccessfulRequest && !lastProbeAt) return 0.2;

  const freshest = [lastSuccessfulRequest, lastProbeAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];

  const freshness = freshest === undefined ? 0.45 : now - freshest <= staleAfterMs ? 1 : 0.55;
  const stateStrength = availability === "unknown" ? 0.55 : 0.95;
  return clamp01(freshness * stateStrength);
}
