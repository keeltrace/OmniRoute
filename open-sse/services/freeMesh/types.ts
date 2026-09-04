export type FreeMeshApiStyle = "openai" | "anthropic" | "google" | "custom" | "unknown";
export type FreeMeshAuthType = "api-key" | "oauth" | "none" | "unknown";
export type FreeMeshAuthStatus = "ok" | "failed" | "unknown";
export type FreeMeshAvailability =
  | "available"
  | "rate-limited"
  | "quota-exhausted"
  | "provider-down"
  | "unknown";

export type FreeEntitlementType =
  | "always-free"
  | "perpetual"
  | "renewing-quota"
  | "recurring-credit"
  | "trial-credit"
  | "account-entitlement"
  | "unknown";

export type FreeEvidenceKind =
  | "live-zero-cost-inference"
  | "provider-entitlement"
  | "operator-policy"
  | "verified-free-tier"
  | "pricing-zero-consensus"
  | "pricing-zero-single"
  | "discovery"
  | "runtime-observation"
  | "source-disagreement";

export interface EvidenceRecord {
  source: string;
  kind: FreeEvidenceKind;
  claim: string;
  observedAt: string;
  verifiedAt?: string | null;
  stale?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FreeApiCandidate {
  providerId: string;
  providerAliases: string[];
  modelId: string;
  modelAliases: string[];
  endpoint: string | null;
  apiStyle: FreeMeshApiStyle;

  auth: {
    type: FreeMeshAuthType;
    envVars: string[];
    credentialPresent: boolean;
    status: FreeMeshAuthStatus;
  };

  capabilities: {
    text: boolean;
    vision: boolean;
    tools: boolean;
    reasoning: boolean;
    embeddings: boolean;
    audio: boolean;
  };

  nominalPricing: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    otherPossibleCharges: boolean;
  };

  freeEntitlement: {
    type: FreeEntitlementType;
    amount: number | null;
    unit: string | null;
    resetAt: string | null;
  };

  runtime: {
    availability: FreeMeshAvailability;
    lastSuccessfulRequest: string | null;
    lastProbeAt: string | null;
    remainingAllowance: number | null;
  };

  performance: {
    ttftP50: number | null;
    tokensPerSecondP50: number | null;
    latencyP50: number | null;
  };

  evidence: EvidenceRecord[];
  freeConfidence: number;
  availabilityConfidence: number;
  incrementalCostNow: number | null;
}

export type FreeCostClassification = "free" | "paid" | "unknown";

export interface ResolvedFreeCandidate extends FreeApiCandidate {
  costClassification: FreeCostClassification;
  strictZeroCostEligible: boolean;
  selectableNow: boolean;
  resolutionReasons: string[];
}

export interface FreeCandidateSnapshot {
  candidates: FreeApiCandidate[];
  refreshedAt: string | null;
  stale: boolean;
  lastRefreshAttemptAt: string | null;
  lastRefreshError: string | null;
}
