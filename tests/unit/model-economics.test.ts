import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveKnownModelPricing } from "../../open-sse/services/providerCostData.ts";
import { resolveModelEconomics } from "../../open-sse/services/autoCombo/modelEconomics.ts";

test("known pricing resolver does not promote unknown models to fallback pricing", () => {
  assert.equal(resolveKnownModelPricing("unknown-provider", "unknown-model"), null);
  assert.equal(resolveModelEconomics("unknown-provider", "unknown-model").priceClass, "unknown");
  assert.equal(resolveModelEconomics("unknown-provider", "unknown-model").authoritative, false);
});

test("explicit synced/custom economics remain authoritative and preserve absent fields", () => {
  const free = resolveModelEconomics("provider", "model", {
    isFree: true,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    economicMetadataSource: "synced_model_metadata",
  });
  assert.equal(free.priceClass, "free");
  assert.equal(free.authoritative, true);
  const paid = resolveModelEconomics("provider", "model", {
    isFree: false,
    economicMetadataSource: "custom_model_metadata",
  });
  assert.equal(paid.priceClass, "paid");
  assert.equal(paid.source, "custom_model_metadata");
});
