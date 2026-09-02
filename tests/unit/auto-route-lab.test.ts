import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeRequestProfile,
  buildModelUtilityProfile,
  rankRequestCandidates,
  scoreRequestUtility,
  type ModelUtilityProfile,
} from "../../open-sse/services/autoCombo/requestAwareRankLab.ts";
import { planAutoRequest } from "../../open-sse/services/combo/resolveAutoStrategy.ts";
import {
  planAutoRequestWithPipeline,
  resolveComboTargetPipeline,
} from "../../open-sse/services/combo/targetResolution.ts";
import { resolveComboSetupConfig } from "../../open-sse/services/comboConfig.ts";
import { resolveResilienceSettings } from "../../src/lib/resilience/settings.ts";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    executionKey: String(overrides.executionKey ?? `${overrides.provider ?? "free"}/${overrides.model ?? "small"}`),
    provider: String(overrides.provider ?? "free"), model: String(overrides.model ?? "small"),
    connectionId: "connection-test", quotaRemaining: 100, quotaTotal: 100,
    circuitBreakerState: "CLOSED", costPer1MTokens: 0, p95LatencyMs: 100,
    latencyStdDev: 10, errorRate: 0, accountTier: "standard", quotaResetIntervalSecs: 86400,
    contextAffinity: 0.5, sessionAvailability: 1, resetWindowAffinity: 0.5,
    connectionPoolSize: 1, ...overrides,
  } as never;
}

function profile(overrides: Partial<ModelUtilityProfile> = {}): ModelUtilityProfile {
  return {
    executionKey: "x", provider: "free", model: "small", taskFit: 0.8,
    reasoningCapability: 0.5, toolCapability: true, toolReliability: 0.8,
    contextLimit: 200_000, outputLimit: 100_000, visionCapability: true,
    quality: 0.5, reliability: 1, health: 1, quota: 1, latencyFit: 0.8,
    stability: 0.8, economicClass: "free", normalizedMarginalCost: 0,
    scarcityCost: 0.05, currentAutoScore: 0.5, currentFactors: {}, hardEligible: true,
    ...overrides,
  };
}

test("request profile distinguishes micro and architecture work", () => {
  const micro = analyzeRequestProfile({ messages: [{ role: "user", content: "Rename x to y." }] });
  const architecture = analyzeRequestProfile({ messages: [{ role: "user", content: "Design an architecture and explain the trade-offs for a distributed system." }] });
  assert.equal(micro.role, "micro");
  assert.equal(architecture.role, "orchestrator");
  assert.ok(architecture.reasoningNeed > micro.reasoningNeed);
});

test("role hint is optional and deterministic", () => {
  const body = { messages: [{ role: "user", content: "Implement a function." }], roleHint: "specialist" };
  assert.deepEqual(analyzeRequestProfile(body), analyzeRequestProfile(body));
  assert.equal(analyzeRequestProfile(body).role, "specialist");
});

test("tools and context are hard eligibility gates", () => {
  const request = analyzeRequestProfile({ messages: [{ content: "Use a tool to inspect the repository." }], tools: [{ type: "function" }], max_tokens: 1000 });
  const noTools = profile({ executionKey: "no-tools", toolCapability: false });
  const shortContext = profile({ executionKey: "short", contextLimit: 10 });
  const result = rankRequestCandidates({ ...request, contextTokensRequired: 100 }, [noTools, shortContext]);
  assert.equal(result.hardEligibleCount, 0);
  assert.match(result.currentRanking[0].exclusionReason ?? "", /tools|context/);
});

test("unknown observations are neutral rather than zero", () => {
  const request = analyzeRequestProfile({ messages: [{ content: "Implement a helper." }] });
  const unknown = scoreRequestUtility(request, profile({ quality: null, reliability: null, stability: null }));
  const neutral = scoreRequestUtility(request, profile({ quality: 0.5, reliability: 1, stability: null }));
  assert.equal(unknown.factors.quality, neutral.factors.quality);
  assert.equal(unknown.factors.reliability, neutral.factors.reliability);
});

test("micro work penalizes unnecessary scarce intelligence more than orchestration", () => {
  const micro = analyzeRequestProfile({ messages: [{ content: "Format this text." }] });
  const orchestration = { ...micro, role: "orchestrator" as const, minimumExpectedUtility: 0.5 };
  const scarce = profile({ economicClass: "subscription", scarcityCost: 1, normalizedMarginalCost: 0.5, taskFit: 1, quality: 1, reasoningCapability: 1 });
  const microScore = scoreRequestUtility(micro, scarce);
  const orchestrationScore = scoreRequestUtility(orchestration, scarce);
  assert.ok(microScore.awareScore < orchestrationScore.awareScore);
});

test("hard orchestrator requirements can lift a frontier candidate", () => {
  const request = { ...analyzeRequestProfile({ messages: [{ content: "Prove the architecture is correct." }] }), role: "orchestrator" as const, minimumExpectedUtility: 0.94 };
  const free = profile({ executionKey: "free", taskFit: 0.25, reasoningCapability: 0.2, quality: 0.3, reliability: 0.6, latencyFit: 0.4 });
  const frontier = profile({ executionKey: "frontier", provider: "paid", model: "reasoning-frontier", taskFit: 1, reasoningCapability: 1, quality: 1, economicClass: "paid", normalizedMarginalCost: 0.2, scarcityCost: 0.8 });
  const result = rankRequestCandidates(request, [free, frontier]);
  assert.equal(result.topAware?.executionKey, "frontier");
});

test("full candidate universe and deterministic ties are preserved", () => {
  const request = analyzeRequestProfile({ messages: [{ content: "Extract values." }] });
  const candidates = Array.from({ length: 900 }, (_, i) => profile({ executionKey: `candidate-${String(i).padStart(4, "0")}`, model: `model-${i}` }));
  const a = rankRequestCandidates(request, candidates);
  const b = rankRequestCandidates(request, candidates);
  assert.equal(a.candidateUniverseCount, 900);
  assert.equal(a.awareRanking.length, 900);
  assert.deepEqual(a.awareRanking.map((r) => r.executionKey), b.awareRanking.map((r) => r.executionKey));
});

test("candidate adapter reuses current score and exposes no credential fields", () => {
  const request = analyzeRequestProfile({ messages: [{ content: "Implement code." }] });
  const result = buildModelUtilityProfile(candidate({ currentAutoScore: 0.77, apiKey: "must-not-appear" }), request);
  assert.equal(result.currentAutoScore, 0.77);
  assert.equal("apiKey" in result, false);
  assert.equal(result.provider, "free");
});

test("rank diff reports both directions", () => {
  const request = analyzeRequestProfile({ messages: [{ content: "Implement code." }] });
  const result = rankRequestCandidates(request, [
    profile({ executionKey: "current", currentAutoScore: 0.9, taskFit: 0.5 }),
    profile({ executionKey: "aware", currentAutoScore: 0.1, taskFit: 1, economicClass: "free" }),
  ]);
  assert.equal(result.currentRanking.length, 2);
  assert.ok(result.rankingDiff.some((r) => r.rankDelta !== 0));
});

test("workforce roles preserve economic/scarcity properties without named winners", () => {
  const cases = [
    ["micro", "Rename a variable in this file.", 0.7],
    ["worker", "Implement the requested API endpoint.", 0.7],
    ["specialist", "Review this security-sensitive change.", 0.8],
    ["orchestrator", "Design the architecture and explain the trade-offs.", 0.95],
  ] as const;
  for (const [role, prompt, minimum] of cases) {
    const request = analyzeRequestProfile({ messages: [{ content: prompt }], roleHint: role });
    const free = profile({ executionKey: `${role}-free`, economicClass: "free", taskFit: 0.86, quality: 0.8, reasoningCapability: 0.72 });
    const frontier = profile({ executionKey: `${role}-frontier`, economicClass: "paid", taskFit: 0.98, quality: 0.98, reasoningCapability: 0.99, scarcityCost: 0.9, normalizedMarginalCost: 0.8 });
    const result = rankRequestCandidates({ ...request, minimumExpectedUtility: minimum }, [free, frontier]);
    assert.equal(result.candidateCount, 2);
    assert.equal(result.diagnostics.dispatches, 0);
    if (role === "micro") assert.equal(result.topAware?.executionKey, "micro-free");
    if (role === "orchestrator") assert.equal(result.topAware?.executionKey, "orchestrator-frontier");
  }
});

test("rank lab keeps the complete route and reports current versus aware rankings", () => {
  const request = analyzeRequestProfile({ messages: [{ content: "Implement a normal feature." }] });
  const result = rankRequestCandidates(request, Array.from({ length: 896 }, (_, i) => profile({
    executionKey: `provider-${String(i).padStart(4, "0")}/model`, provider: `provider-${i % 8}`,
  })));
  assert.equal(result.allCandidates.length, 896);
  assert.equal(result.currentRanking.length, 896);
  assert.equal(result.awareRanking.length, 896);
  assert.equal(result.economicSummary.free.count, 896);
  assert.equal(result.diagnostics.mutation, false);
});

test("read-only production planning seam preserves scorer order and cannot dispatch", async () => {
  const target = (key: string) => ({ stepId: key, executionKey: key, modelStr: "free/small", provider: "free", connectionId: "fixture" });
  const targets = [target("a"), target("b")];
  const built = [candidate({ executionKey: "a" }), candidate({ executionKey: "b", costPer1MTokens: 1 })];
  let dispatchCalls = 0;
  const plan = await planAutoRequest({
    targets: targets as never, comboName: "fixture", body: { messages: [] }, taskType: "coding",
    weights: {} as never, buildAutoCandidates: async () => {
      dispatchCalls++;
      return built as never;
    },
  });
  assert.deepEqual(plan.orderedTargets.map((entry) => entry.executionKey), plan.scoredTargets.map((entry) => entry.target.executionKey));
  assert.equal(plan.diagnostics.dispatches, 0);
  // The injected builder is candidate preparation, not an executor; the seam
  // has no executor callback and therefore cannot dispatch upstream.
  assert.equal(dispatchCalls, 1);
});

test("Rank Lab shares the exact production pre-dispatch order", async () => {
  const combo = {
    id: "parity-auto",
    name: "parity-auto",
    strategy: "auto",
    models: ["free/small", "free/large"],
    config: {},
  };
  const targets = [
    { kind: "model", stepId: "a", executionKey: "free/small", modelStr: "free/small", provider: "free", connectionId: null },
    { kind: "model", stepId: "b", executionKey: "free/large", modelStr: "free/large", provider: "free", connectionId: null },
  ] as never;
  const built = [
    candidate({ executionKey: "parity-auto-model-1-free-small", model: "small" }),
    candidate({ executionKey: "parity-auto-model-2-free-large", model: "large", costPer1MTokens: 1 }),
  ];
  let dispatchCalls = 0;
  const deps = {
    body: { messages: [{ role: "user", content: "implement a small change" }] }, combo,
    strategy: "auto", config: resolveComboSetupConfig(combo, null), settings: null,
    allCombos: [combo], apiKeyAllowedConnections: null,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    resilienceSettings: resolveResilienceSettings(null), buildAutoCandidates: async () => built as never,
    handleSingleModelWithTimeout: async () => { dispatchCalls++; throw new Error("RANK_LAB_DISPATCH_BUG"); },
  } as never;
  const production = await resolveComboTargetPipeline({ ...deps, readOnlyPlan: true, orderedTargets: targets });
  const lab = await planAutoRequestWithPipeline({ ...deps, orderedTargets: targets });
  assert.ok(!("earlyResponse" in production));
  assert.ok(!("earlyResponse" in lab));
  if ("earlyResponse" in production || "earlyResponse" in lab) return;
  assert.deepEqual(lab.orderedTargets.map((target) => target.executionKey), production.orderedTargets.map((target) => target.executionKey));
  assert.equal(lab.scoringFactors.length, 2, JSON.stringify({ prod: production, lab }));
  assert.equal(dispatchCalls, 0);
});

test("the workforce fixture covers all twelve request archetypes", () => {
  const prompts = [
    "Rename this variable.", "Format this document.", "Extract and classify these fields.",
    "Implement this small helper.", "Implement the requested API endpoint.", "Debug the failing request and fix the bug.",
    "Implement the complex concurrent scheduler.", "Review this change for correctness and security.",
    "Design the architecture and explain the trade-offs.", "Prove whether this distributed design is correct.",
    "Inspect the repository with tools and implement the change.", "Analyze this long specification and identify every dependency.",
  ];
  assert.equal(prompts.length, 12);
  const roles = prompts.map((content) => analyzeRequestProfile({ messages: [{ content }] }).role);
  assert.ok(roles.includes("micro"));
  assert.ok(roles.includes("specialist"));
  assert.ok(roles.includes("orchestrator"));
});
