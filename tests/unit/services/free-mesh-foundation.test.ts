import assert from "node:assert/strict";
import { test } from "vitest";

import {
  LastKnownGoodFreeCandidateStore,
  normalizeProviderId,
  resolveFreeCandidate,
  resolveFreeCandidates,
  type FreeApiCandidate,
} from "../../../open-sse/services/freeMesh/index.ts";

const NOW = "2026-09-04T20:00:00.000Z";

function makeCandidate(overrides: Partial<FreeApiCandidate> = {}): FreeApiCandidate {
  return {
    providerId: "example",
    providerAliases: [],
    modelId: "model-1",
    modelAliases: [],
    endpoint: "https://example.invalid/v1",
    apiStyle: "openai",
    auth: {
      type: "api-key",
      envVars: ["EXAMPLE_API_KEY"],
      credentialPresent: true,
      status: "ok",
    },
    capabilities: {
      text: true,
      vision: false,
      tools: true,
      reasoning: false,
      embeddings: false,
      audio: false,
    },
    nominalPricing: {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      otherPossibleCharges: false,
    },
    freeEntitlement: {
      type: "unknown",
      amount: null,
      unit: null,
      resetAt: null,
    },
    runtime: {
      availability: "available",
      lastSuccessfulRequest: NOW,
      lastProbeAt: NOW,
      remainingAllowance: null,
    },
    performance: {
      ttftP50: null,
      tokensPerSecondP50: null,
      latencyP50: null,
    },
    evidence: [],
    freeConfidence: 0,
    availabilityConfidence: 0,
    incrementalCostNow: null,
    ...overrides,
  };
}

test("provider aliases normalize without collapsing distinct Grok offerings", () => {
  assert.equal(normalizeProviderId("NOUS_RESEARCH"), "nous-research");
  assert.equal(normalizeProviderId("weights-and-biases"), "wandb");
  assert.equal(normalizeProviderId("x-ai"), "xai");
  assert.equal(normalizeProviderId("grok-cli"), "grok-cli");
});

test("Nous always-free policy admits configured Hermes models in strict mode without quota proof", () => {
  const nous = makeCandidate({
    providerId: "nous",
    modelId: "Hermes-4-405B",
    auth: {
      type: "api-key",
      envVars: ["NOUS_API_KEY"],
      credentialPresent: true,
      status: "unknown",
    },
    nominalPricing: {
      input: 1,
      output: 1,
      cacheRead: null,
      cacheWrite: null,
      otherPossibleCharges: false,
    },
    runtime: {
      availability: "unknown",
      lastSuccessfulRequest: null,
      lastProbeAt: null,
      remainingAllowance: 0,
    },
  });

  const resolved = resolveFreeCandidate(nous);
  assert.equal(resolved.providerId, "nous-research");
  assert.equal(resolved.costClassification, "free");
  assert.equal(resolved.incrementalCostNow, 0);
  assert.equal(resolved.strictZeroCostEligible, true);
  assert.ok(resolved.freeConfidence >= 0.9);
});

test("W&B account entitlement can override nonzero nominal pricing after live entitlement proof", () => {
  const wandb = makeCandidate({
    providerId: "wandb",
    modelId: "openai/gpt-oss-120b",
    nominalPricing: {
      input: 0.15,
      output: 0.6,
      cacheRead: null,
      cacheWrite: null,
      otherPossibleCharges: false,
    },
    freeEntitlement: {
      type: "account-entitlement",
      amount: 10,
      unit: "usd-credit",
      resetAt: null,
    },
    runtime: {
      availability: "available",
      lastSuccessfulRequest: NOW,
      lastProbeAt: NOW,
      remainingAllowance: 9.5,
    },
    evidence: [
      {
        source: "wandb-entitlement",
        kind: "provider-entitlement",
        claim: "current account has free inference credit",
        observedAt: NOW,
      },
      {
        source: "live-inference",
        kind: "live-zero-cost-inference",
        claim: "successful request under current free entitlement",
        observedAt: NOW,
      },
    ],
  });

  const resolved = resolveFreeCandidate(wandb);
  assert.equal(resolved.costClassification, "free");
  assert.equal(resolved.incrementalCostNow, 0);
  assert.equal(resolved.strictZeroCostEligible, true);
});

test("W&B free classification without live proof is retained but not strict-executable", () => {
  const wandb = makeCandidate({
    providerId: "wandb",
    freeEntitlement: {
      type: "account-entitlement",
      amount: null,
      unit: "credit",
      resetAt: null,
    },
    runtime: {
      availability: "unknown",
      lastSuccessfulRequest: null,
      lastProbeAt: null,
      remainingAllowance: null,
    },
    evidence: [
      {
        source: "free-llm-api-hub",
        kind: "verified-free-tier",
        claim: "W&B exposes free-plan inference entitlement",
        observedAt: NOW,
      },
    ],
  });

  const resolved = resolveFreeCandidate(wandb);
  assert.equal(resolved.costClassification, "free");
  assert.equal(resolved.strictZeroCostEligible, false);
});

test("429 changes availability, not free classification", () => {
  const candidate = makeCandidate({
    providerId: "wandb",
    freeEntitlement: {
      type: "account-entitlement",
      amount: 10,
      unit: "credit",
      resetAt: null,
    },
    runtime: {
      availability: "rate-limited",
      lastSuccessfulRequest: NOW,
      lastProbeAt: NOW,
      remainingAllowance: 9,
    },
    evidence: [
      {
        source: "wandb-entitlement",
        kind: "provider-entitlement",
        claim: "free entitlement active",
        observedAt: NOW,
      },
    ],
  });

  const resolved = resolveFreeCandidate(candidate);
  assert.equal(resolved.costClassification, "free");
  assert.equal(resolved.selectableNow, false);
  assert.equal(resolved.strictZeroCostEligible, false);
});

test("401 changes auth state, not free classification", () => {
  const candidate = makeCandidate({
    providerId: "nous-research",
    auth: {
      type: "api-key",
      envVars: ["NOUS_API_KEY"],
      credentialPresent: true,
      status: "failed",
    },
  });

  const resolved = resolveFreeCandidate(candidate);
  assert.equal(resolved.costClassification, "free");
  assert.equal(resolved.selectableNow, false);
  assert.equal(resolved.strictZeroCostEligible, false);
});

test("exhausted free quota remains free but unavailable", () => {
  const groq = makeCandidate({
    providerId: "groq",
    freeEntitlement: {
      type: "renewing-quota",
      amount: 1000,
      unit: "requests",
      resetAt: "2026-09-05T00:00:00.000Z",
    },
    runtime: {
      availability: "quota-exhausted",
      lastSuccessfulRequest: NOW,
      lastProbeAt: NOW,
      remainingAllowance: 0,
    },
    evidence: [
      {
        source: "free-llm-api-hub",
        kind: "verified-free-tier",
        claim: "Groq has a renewing free quota",
        observedAt: NOW,
      },
    ],
  });

  const resolved = resolveFreeCandidate(groq);
  assert.equal(resolved.costClassification, "free");
  assert.equal(resolved.selectableNow, false);
  assert.equal(resolved.strictZeroCostEligible, false);
});

test("unknown cost is visible to the mesh but excluded from strict zero-cost execution", () => {
  const unknown = makeCandidate({ providerId: "unknown-provider" });
  const resolved = resolveFreeCandidate(unknown);
  assert.equal(resolved.costClassification, "unknown");
  assert.equal(resolved.strictZeroCostEligible, false);
  assert.deepEqual(resolveFreeCandidates([unknown], { strictZeroCost: true }), []);
});

test("last-known-good store retains catalog after refresh failure", () => {
  const store = new LastKnownGoodFreeCandidateStore();
  const original = makeCandidate({ providerId: "nous-research", modelId: "Hermes-4-70B" });
  store.commitRefreshSuccess([original], NOW);
  store.recordRefreshFailure(new Error("temporary /models timeout"), "2026-09-04T20:05:00.000Z");

  const snapshot = store.read();
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.candidates.length, 1);
  assert.equal(snapshot.candidates[0]?.modelId, "Hermes-4-70B");
  assert.equal(snapshot.refreshedAt, NOW);
  assert.match(snapshot.lastRefreshError ?? "", /timeout/);
});
