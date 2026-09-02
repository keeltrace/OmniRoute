import { resolveKnownModelPricing } from "../providerCostData.ts";

export type ModelEconomicPriceClass = "free" | "paid" | "unknown";
export type ModelEconomicSource = "synced_model_metadata" | "custom_model_metadata" | "known_model_pricing" | "unknown";

export interface ModelEconomicResolution {
  priceClass: ModelEconomicPriceClass;
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  freeQuotaLimit: number | null;
  authoritative: boolean;
  source: ModelEconomicSource;
  reason: string;
}

export interface ModelEconomicMetadata {
  isFree?: boolean;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  freeQuotaLimit?: number;
  economicMetadataSource?: ModelEconomicSource;
}

export function resolveModelEconomics(
  provider: string,
  model: string,
  metadata?: ModelEconomicMetadata | null
): ModelEconomicResolution {
  const source = metadata?.economicMetadataSource === "custom_model_metadata"
    ? "custom_model_metadata"
    : "synced_model_metadata";
  const hasExplicitMetadata = metadata && (
    typeof metadata.isFree === "boolean" ||
    typeof metadata.inputCostPer1M === "number" ||
    typeof metadata.outputCostPer1M === "number"
  );
  if (hasExplicitMetadata) {
    const input = typeof metadata.inputCostPer1M === "number" ? metadata.inputCostPer1M : null;
    const output = typeof metadata.outputCostPer1M === "number" ? metadata.outputCostPer1M : null;
    const free = metadata.isFree === true || (metadata.isFree === undefined && input === 0 && output === 0);
    return {
      priceClass: free ? "free" : "paid",
      inputCostPer1M: input,
      outputCostPer1M: output,
      freeQuotaLimit: typeof metadata.freeQuotaLimit === "number" ? metadata.freeQuotaLimit : null,
      authoritative: true,
      source,
      reason: `explicit ${source} fields`,
    };
  }
  const known = resolveKnownModelPricing(provider, model);
  if (known) return {
    priceClass: known.isFree ? "free" : "paid",
    inputCostPer1M: known.inputCostPer1M,
    outputCostPer1M: known.outputCostPer1M,
    freeQuotaLimit: known.freeQuotaLimit ?? null,
    authoritative: true,
    source: "known_model_pricing",
    reason: "curated exact provider/model pricing entry",
  };
  return {
    priceClass: "unknown", inputCostPer1M: null, outputCostPer1M: null,
    freeQuotaLimit: null, authoritative: false, source: "unknown",
    reason: "no explicit synced/custom metadata or curated exact pricing entry",
  };
}
