import { normalizeProviderId } from "./aliases";

export type ProviderFreePolicyKind =
  | "always-free"
  | "account-entitlement"
  | "model-specific"
  | "quota-based"
  | "unknown";

export interface ProviderFreePolicy {
  freePolicy: ProviderFreePolicyKind;
  source: "operator-policy" | "default-policy";
  requireLiveValidation: boolean;
  requireQuotaProof: boolean;
}

export type ProviderPolicyOverrides = Record<string, Partial<ProviderFreePolicy>>;

/**
 * Conservative built-in policy defaults. These describe entitlement semantics,
 * not runtime health. A provider can remain free while temporarily unavailable.
 */
export const DEFAULT_PROVIDER_POLICIES: Readonly<Record<string, ProviderFreePolicy>> = {
  "nous-research": {
    freePolicy: "always-free",
    source: "operator-policy",
    requireLiveValidation: false,
    requireQuotaProof: false,
  },
  wandb: {
    freePolicy: "account-entitlement",
    source: "default-policy",
    requireLiveValidation: true,
    requireQuotaProof: false,
  },
  openrouter: {
    freePolicy: "model-specific",
    source: "default-policy",
    requireLiveValidation: false,
    requireQuotaProof: false,
  },
  groq: {
    freePolicy: "quota-based",
    source: "default-policy",
    requireLiveValidation: true,
    requireQuotaProof: true,
  },
};

export function resolveProviderFreePolicy(
  providerId: string,
  overrides: ProviderPolicyOverrides = {}
): ProviderFreePolicy | undefined {
  const canonical = normalizeProviderId(providerId);
  const base = DEFAULT_PROVIDER_POLICIES[canonical];
  const overrideEntry = Object.entries(overrides).find(
    ([provider]) => normalizeProviderId(provider) === canonical
  )?.[1];

  if (!base && !overrideEntry) return undefined;

  return {
    freePolicy: overrideEntry?.freePolicy ?? base?.freePolicy ?? "unknown",
    source: overrideEntry ? "operator-policy" : (base?.source ?? "default-policy"),
    requireLiveValidation:
      overrideEntry?.requireLiveValidation ?? base?.requireLiveValidation ?? true,
    requireQuotaProof: overrideEntry?.requireQuotaProof ?? base?.requireQuotaProof ?? true,
  };
}

export function isProviderAlwaysFree(
  providerId: string,
  overrides: ProviderPolicyOverrides = {}
): boolean {
  return resolveProviderFreePolicy(providerId, overrides)?.freePolicy === "always-free";
}
