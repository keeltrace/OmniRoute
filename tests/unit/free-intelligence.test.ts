import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRuntimeStatus,
  evaluateStrictZeroCostCandidate,
  filterStrictZeroCostCandidates,
  type FreeIntelligenceCandidate,
} from "../../src/domain/freeIntelligence.ts";

function candidate(overrides: Partial<FreeIntelligenceCandidate> = {}): FreeIntelligenceCandidate {
  return {
    provider: "nous-research",
    model: "Hermes-4-405B",
    freeClassification: "free",
    incrementalCostNow: 0,
    freeConfidence: 0.99,
    authStatus: "ok",
    availability: "available",
    ...overrides,
  };
}

test("strict free accepts established zero-cost candidate", () => {
  assert.deepEqual(evaluateStrictZeroCostCandidate(candidate()), {
    eligible: true,
    reason: null,
  });
});

test("nominally paid offering is allowed when current entitlement resolves cost to zero", () => {
  const wandb = candidate({
    provider: "wandb",
    model: "Qwen/Qwen3.6-27B",
    freeClassification: "free",
    incrementalCostNow: 0,
    freeConfidence: 0.97,
  });
  assert.equal(evaluateStrictZeroCostCandidate(wandb).eligible, true);
});

test("paid and unknown incremental cost never execute in strict free mode", () => {
  assert.equal(
    evaluateStrictZeroCostCandidate(
      candidate({ freeClassification: "paid", incrementalCostNow: 0.5 })
    ).reason,
    "incremental-cost-proven"
  );
  assert.equal(
    evaluateStrictZeroCostCandidate(
      candidate({ freeClassification: "unknown", incrementalCostNow: null })
    ).reason,
    "incremental-cost-unknown"
  );
});

test("exhaustion and rate limiting suppress availability without changing free truth", () => {
  const exhausted = candidate({ availability: "quota-exhausted" });
  assert.equal(evaluateStrictZeroCostCandidate(exhausted).reason, "quota-exhausted");
  assert.equal(exhausted.freeClassification, "free");

  const limited = applyRuntimeStatus(candidate(), 429);
  assert.equal(limited.availability, "rate-limited");
  assert.equal(limited.freeClassification, "free");
  assert.equal(limited.incrementalCostNow, 0);
});

test("401 changes auth only and does not reclassify free candidate as paid", () => {
  const failed = applyRuntimeStatus(candidate(), 401);
  assert.equal(failed.authStatus, "failed");
  assert.equal(failed.freeClassification, "free");
  assert.equal(evaluateStrictZeroCostCandidate(failed).reason, "auth-failed");
});

test("5xx changes runtime health only", () => {
  const down = applyRuntimeStatus(candidate(), 503);
  assert.equal(down.availability, "provider-down");
  assert.equal(down.freeClassification, "free");
  assert.equal(evaluateStrictZeroCostCandidate(down).reason, "provider-down");
});

test("low-confidence free evidence stays out of strict free routing", () => {
  assert.equal(
    evaluateStrictZeroCostCandidate(candidate({ freeConfidence: 0.5 })).reason,
    "free-confidence-too-low"
  );
});

test("filter preserves input order so OmniRoute retains ownership of ranking", () => {
  const first = candidate({ provider: "provider-a", model: "a" });
  const blocked = candidate({ provider: "provider-b", model: "b", availability: "rate-limited" });
  const third = candidate({ provider: "provider-c", model: "c" });

  assert.deepEqual(
    filterStrictZeroCostCandidates([first, blocked, third]).map((item) => item.model),
    ["a", "c"]
  );
});
