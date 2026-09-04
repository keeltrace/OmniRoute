import type { TierAssignment, TierConfig, ProviderTier } from "./tierTypes";
import { PROVIDER_TIER } from "./tierTypes";
import { getModelPricing } from "./providerCostData";
import { isExplicitlyFree } from "./providerCostData";
import { mergeTierConfig, DEFAULT_TIER_CONFIG } from "./tierConfig";
import { isFreeModel } from "@/shared/utils/freeModels";

let dbPersistenceChecked = false;

const tierCache = new Map<string, TierAssignment>();
let currentConfig: TierConfig = DEFAULT_TIER_CONFIG;

function cacheKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function matchGlob(pattern: string, text: string): boolean {
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`, "i").test(text);
}

/**
 * Whether the operator explicitly declared this provider/model free through
 * the persisted tier-override surface. This intentionally does NOT include
 * default/legacy free-provider classification or price-derived free status:
 * callers use it as an administrative assertion that must remain distinct
 * from OmniRoute's automatic economic inference.
 *
 * Precedence mirrors classifyTier(): provider override first, then model
 * override. A provider-wide non-free override therefore cannot be silently
 * undone by a model-level free override.
 */
export function isExplicitFreeTierOverride(provider: string, model: string): boolean {
  const providerOverride = currentConfig.providerOverrides.find(
    (o) => o.provider.toLowerCase() === provider.toLowerCase()
  );
  if (providerOverride) return providerOverride.tier === PROVIDER_TIER.FREE;

  const modelOverride = currentConfig.modelOverrides.find(
    (o) => o.provider.toLowerCase() === provider.toLowerCase() && matchGlob(o.modelPattern, model)
  );
  return modelOverride?.tier === PROVIDER_TIER.FREE;
}

export function classifyTier(provider: string, model: string): TierAssignment {
  const key = cacheKey(provider, model);

  if (tierCache.has(key)) {
    return tierCache.get(key)!;
  }

  if (isExplicitlyFree(provider, currentConfig)) {
    const assignment: TierAssignment = {
      provider,
      model,
      tier: PROVIDER_TIER.FREE,
      reason: `Provider '${provider}' is in explicit free providers list`,
      costPer1MInput: 0,
      costPer1MOutput: 0,
      hasFreeTier: true,
    };
    tierCache.set(key, assignment);
    return assignment;
  }

  const providerOverride = currentConfig.providerOverrides.find(
    (o) => o.provider.toLowerCase() === provider.toLowerCase()
  );
  if (providerOverride) {
    const pricing = getModelPricing(provider, model);
    const assignment: TierAssignment = {
      provider,
      model,
      tier: providerOverride.tier,
      reason: `Provider-level override: '${provider}' → ${providerOverride.tier}`,
      costPer1MInput: pricing.inputCostPer1M,
      costPer1MOutput: pricing.outputCostPer1M,
      hasFreeTier: pricing.isFree,
      freeQuotaLimit: pricing.freeQuotaLimit,
    };
    tierCache.set(key, assignment);
    return assignment;
  }

  const modelOverride = currentConfig.modelOverrides.find(
    (o) => o.provider.toLowerCase() === provider.toLowerCase() && matchGlob(o.modelPattern, model)
  );
  if (modelOverride) {
    const pricing = getModelPricing(provider, model);
    const assignment: TierAssignment = {
      provider,
      model,
      tier: modelOverride.tier,
      reason: `Model-level override: '${provider}/${model}' matches '${modelOverride.modelPattern}' → ${modelOverride.tier}`,
      costPer1MInput: pricing.inputCostPer1M,
      costPer1MOutput: pricing.outputCostPer1M,
      hasFreeTier: pricing.isFree,
      freeQuotaLimit: pricing.freeQuotaLimit,
    };
    tierCache.set(key, assignment);
    return assignment;
  }

  // Model-level free identity is stronger than the sparse static pricing
  // table. Rotating provider catalogs commonly publish explicit `:free` model
  // ids (Nous Portal does this today). The shared predicate also understands
  // zero-priced discovery metadata and curated free-catalog entries, so the
  // `auto/*:free` selector and the model-listing code now use the same truth.
  if (isFreeModel(provider, { id: model })) {
    const assignment: TierAssignment = {
      provider,
      model,
      tier: PROVIDER_TIER.FREE,
      reason: "Model is explicitly identified as free by the shared free-model classifier",
      costPer1MInput: 0,
      costPer1MOutput: 0,
      hasFreeTier: true,
    };
    tierCache.set(key, assignment);
    return assignment;
  }

  const pricing = getModelPricing(provider, model);
  let tier: ProviderTier;
  let reason: string;

  if (pricing.isFree || pricing.inputCostPer1M <= currentConfig.defaults.freeThreshold) {
    tier = PROVIDER_TIER.FREE;
    reason = `Cost-based: $${pricing.inputCostPer1M}/M input ≤ free threshold ($${currentConfig.defaults.freeThreshold}/M)`;
  } else if (pricing.inputCostPer1M <= currentConfig.defaults.cheapThreshold) {
    tier = PROVIDER_TIER.CHEAP;
    reason = `Cost-based: $${pricing.inputCostPer1M}/M input ≤ cheap threshold ($${currentConfig.defaults.cheapThreshold}/M)`;
  } else {
    tier = PROVIDER_TIER.PREMIUM;
    reason = `Cost-based: $${pricing.inputCostPer1M}/M input > cheap threshold ($${currentConfig.defaults.cheapThreshold}/M)`;
  }

  const assignment: TierAssignment = {
    provider,
    model,
    tier,
    reason,
    costPer1MInput: pricing.inputCostPer1M,
    costPer1MOutput: pricing.outputCostPer1M,
    hasFreeTier: pricing.isFree,
    freeQuotaLimit: pricing.freeQuotaLimit,
  };

  tierCache.set(key, assignment);
  return assignment;
}

export function setTierConfig(config?: Partial<TierConfig> | null): void {
  if (config === null || config === undefined) {
    try {
      const { loadTierConfig } = require("../../src/lib/db/tierConfig");
      currentConfig = loadTierConfig();
    } catch {
      currentConfig = DEFAULT_TIER_CONFIG;
    }
  } else {
    currentConfig = mergeTierConfig(config);
  }
  tierCache.clear();
}

export function getTierConfig(): TierConfig {
  return { ...currentConfig };
}

export function clearTierCache(): void {
  tierCache.clear();
}

export function classifyTiers(
  targets: Array<{ provider: string; model: string }>
): TierAssignment[] {
  return targets.map((t) => classifyTier(t.provider, t.model));
}

export function getTierStats(): Record<ProviderTier, number> {
  const stats: Record<ProviderTier, number> = { free: 0, cheap: 0, premium: 0 };
  for (const assignment of tierCache.values()) {
    stats[assignment.tier]++;
  }
  return stats;
}
