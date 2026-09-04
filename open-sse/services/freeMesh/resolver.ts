import { computeAvailabilityConfidence, computeFreeConfidence } from "./confidence";
import { normalizeProviderId } from "./aliases";
import {
  resolveProviderFreePolicy,
  type ProviderFreePolicy,
  type ProviderPolicyOverrides,
} from "./policy";
import type {
  FreeApiCandidate,
  FreeCostClassification,
  ResolvedFreeCandidate,
} from "./types";

function hasZeroNominalPricing(candidate: FreeApiCandidate): boolean {
  const pricing = candidate.nominalPricing;
  const dimensions = [pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite];
  const known = dimensions.filter((value): value is number => value !== null);
  return known.length > 0 && known.every((value) => value === 0) && !pricing.otherPossibleCharges;
}

function hasPositiveNominalPricing(candidate: FreeApiCandidate): boolean {
  const pricing = candidate.nominalPricing;
  return [pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite].some(
    (value) => typeof value === "number" && value > 0
  );
}

function hasEvidence(
  candidate: FreeApiCandidate,
  kind: FreeApiCandidate["evidence"][number]["kind"]
): boolean {
  return candidate.evidence.some((record) => record.kind === kind && !record.stale);
}

function isKnownFreeEntitlement(candidate: FreeApiCandidate): boolean {
  return candidate.freeEntitlement.type !== "unknown";
}

function resolveCostClassification(
  candidate: FreeApiCandidate,
  policy: ProviderFreePolicy | undefined
): { classification: FreeCostClassification; incrementalCostNow: number | null; reasons: string[] } {
  const reasons: string[] = [];

  if (policy?.freePolicy === "always-free") {
    reasons.push(`provider policy: ${normalizeProviderId(candidate.providerId)} is always-free`);
    return { classification: "free", incrementalCostNow: 0, reasons };
  }

  if (hasEvidence(candidate, "live-zero-cost-inference")) {
    reasons.push("successful live zero-cost inference evidence");
    return { classification: "free", incrementalCostNow: 0, reasons };
  }

  if (hasEvidence(candidate, "provider-entitlement")) {
    reasons.push("provider/account entitlement evidence establishes zero incremental cost");
    return { classification: "free", incrementalCostNow: 0, reasons };
  }

  if (isKnownFreeEntitlement(candidate)) {
    reasons.push(`free entitlement: ${candidate.freeEntitlement.type}`);
    return { classification: "free", incrementalCostNow: 0, reasons };
  }

  if (hasZeroNominalPricing(candidate)) {
    reasons.push("all known nominal cost dimensions are zero and no other charge dimension is flagged");
    return { classification: "free", incrementalCostNow: 0, reasons };
  }

  if (hasPositiveNominalPricing(candidate)) {
    reasons.push("positive nominal pricing with no established free entitlement");
    return { classification: "paid", incrementalCostNow: null, reasons };
  }

  reasons.push("incremental cost is not established");
  return { classification: "unknown", incrementalCostNow: null, reasons };
}

function isRuntimeSelectable(candidate: FreeApiCandidate): boolean {
  if (candidate.auth.status === "failed") return false;
  if (candidate.auth.type !== "none" && !candidate.auth.credentialPresent) return false;
  return !["rate-limited", "quota-exhausted", "provider-down"].includes(
    candidate.runtime.availability
  );
}

function hasStrictFreeProof(
  candidate: FreeApiCandidate,
  policy: ProviderFreePolicy | undefined,
  freeConfidence: number
): boolean {
  if (policy?.freePolicy === "always-free") return true;
  if (hasEvidence(candidate, "live-zero-cost-inference")) return true;
  if (hasEvidence(candidate, "provider-entitlement")) return true;

  if (policy?.freePolicy === "account-entitlement" && policy.requireLiveValidation) {
    return false;
  }

  if (policy?.freePolicy === "quota-based" && policy.requireQuotaProof) {
    return (
      candidate.runtime.remainingAllowance !== null && candidate.runtime.remainingAllowance > 0
    );
  }

  if (
    candidate.freeEntitlement.type === "always-free" ||
    candidate.freeEntitlement.type === "perpetual"
  ) {
    return freeConfidence >= 0.8;
  }

  if (isKnownFreeEntitlement(candidate)) {
    return (
      candidate.runtime.remainingAllowance !== null && candidate.runtime.remainingAllowance > 0
    );
  }

  return hasZeroNominalPricing(candidate) && freeConfidence >= 0.6;
}

/**
 * Resolve economic truth independently from runtime availability. This is the
 * boundary consumed by routing: the mesh says what is free/usable; OmniRoute
 * remains responsible for quality, latency, fallback, and dispatch ranking.
 */
export function resolveFreeCandidate(
  candidate: FreeApiCandidate,
  options: { providerPolicyOverrides?: ProviderPolicyOverrides } = {}
): ResolvedFreeCandidate {
  const overrides = options.providerPolicyOverrides ?? {};
  const policy = resolveProviderFreePolicy(candidate.providerId, overrides);
  const cost = resolveCostClassification(candidate, policy);
  const selectableNow = isRuntimeSelectable(candidate);
  let freeConfidence = computeFreeConfidence(candidate.evidence);
  if (policy?.freePolicy === "always-free") freeConfidence = Math.max(freeConfidence, 0.9);
  const availabilityConfidence = computeAvailabilityConfidence(candidate);
  const strictProofEstablished = hasStrictFreeProof(candidate, policy, freeConfidence);
  const reasons = [...cost.reasons];
  if (cost.classification === "free" && !strictProofEstablished) {
    reasons.push("free classification exists, but strict zero-cost proof is not established");
  }

  return {
    ...candidate,
    providerId: normalizeProviderId(candidate.providerId),
    incrementalCostNow: cost.incrementalCostNow,
    costClassification: cost.classification,
    strictZeroCostEligible:
      cost.classification === "free" && strictProofEstablished && selectableNow,
    selectableNow,
    resolutionReasons: reasons,
    freeConfidence,
    availabilityConfidence,
  };
}

export function resolveFreeCandidates(
  candidates: readonly FreeApiCandidate[],
  options: {
    providerPolicyOverrides?: ProviderPolicyOverrides;
    strictZeroCost?: boolean;
  } = {}
): ResolvedFreeCandidate[] {
  const resolved = candidates.map((candidate) => resolveFreeCandidate(candidate, options));
  if (!options.strictZeroCost) return resolved;
  return resolved.filter((candidate) => candidate.strictZeroCostEligible);
}
