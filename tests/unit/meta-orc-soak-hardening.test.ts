import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyMetaOrc403,
  shouldAttemptCredentialRefresh,
} from "../../open-sse/services/metaOrc403.ts";
import {
  compactMetaOrcEffectivePool,
  type VirtualAutoComboCandidate,
} from "../../open-sse/services/autoCombo/virtualFactory.ts";
import {
  applyComboTargetExhaustion,
  type ComboExhaustionSets,
} from "../../open-sse/services/combo/targetExhaustion.ts";

function candidate(
  provider: string,
  model: string,
  free = false,
  index = 0
): VirtualAutoComboCandidate {
  return {
    provider,
    connectionId: null,
    allowedConnectionIds: [`${provider}-conn`],
    ...(free ? { freeConnectionIds: [`${provider}-conn`] } : {}),
    model,
    modelStr: `${provider}/${model}`,
    costPer1MTokens: 0,
    resolvedReasoning: index % 2 === 0,
  };
}

function exhaustionSets(): ComboExhaustionSets {
  return {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
  };
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function target(provider = "groq") {
  return {
    kind: "model",
    executionKey: `${provider}-step`,
    modelStr: `${provider}/model-a`,
    provider,
    providerId: provider,
    connectionId: `${provider}-conn`,
  } as Parameters<typeof applyComboTargetExhaustion>[0];
}

test("Meta-Orc 403 classifier distinguishes credential, quota, transport, and model scope", () => {
  assert.equal(classifyMetaOrc403(403, "invalid API key"), "credential");
  assert.equal(classifyMetaOrc403(403, "quota exhausted for this account"), "quota");
  assert.equal(
    classifyMetaOrc403(
      403,
      "<title>Access denied | Cloudflare</title> errorCode: 1010 /error-1010/"
    ),
    "transport"
  );
  assert.equal(classifyMetaOrc403(403, "this model is not available for your account"), "model");
  assert.equal(classifyMetaOrc403(401, "invalid token"), null);
});

test("Meta-Orc refreshes 401 but never burns refresh attempts on an ambiguous 403", () => {
  assert.equal(shouldAttemptCredentialRefresh(401, "auto/meta-orc"), true);
  assert.equal(shouldAttemptCredentialRefresh(403, "auto/meta-orc"), false);
  assert.equal(shouldAttemptCredentialRefresh(403, "some-other-combo"), true);
  assert.equal(shouldAttemptCredentialRefresh(500, "auto/meta-orc"), false);
});

test("Meta-Orc bounds the model deck while preserving free-first provider diversity and rescue", () => {
  const input: VirtualAutoComboCandidate[] = [];
  const scores = new Map<string, number>();
  for (const provider of ["alpha", "beta", "gamma"]) {
    for (let i = 0; i < 5; i++) {
      const free = candidate(provider, `free-${i}`, true, i);
      input.push(free);
      scores.set(free.modelStr, 1 - i / 100);
    }
    for (let i = 0; i < 5; i++) {
      const paid = candidate(provider, `paid-${i}`, false, i);
      input.push(paid);
      scores.set(paid.modelStr, 0.5 - i / 100);
    }
  }

  const compacted = compactMetaOrcEffectivePool(input, scores, {
    maxFreePerProvider: 2,
    maxRescuePerProvider: 1,
    maxTotal: 9,
  });

  assert.equal(compacted.length, 9);
  assert.deepEqual(
    compacted.slice(0, 6).map((entry) => entry.provider),
    ["alpha", "beta", "gamma", "alpha", "beta", "gamma"]
  );
  assert.ok(compacted.slice(0, 6).every((entry) => entry.freeConnectionIds?.length === 1));
  assert.deepEqual(
    compacted.slice(6).map((entry) => entry.provider),
    ["alpha", "beta", "gamma"]
  );
});

test("Meta-Orc ambiguous 403 keeps sibling models eligible", () => {
  const sets = exhaustionSets();
  const exhausted = applyComboTargetExhaustion(target("groq"), {
    result: { status: 403 },
    fallbackResult: { shouldFallback: true },
    errorText: "model not available for this account",
    rawModel: "model-a",
    isTokenLimitBreach: false,
    allAccountsRateLimited: false,
    requestScopedFailure: false,
    sets,
    log: silentLog,
    tag: "COMBO",
    exhaustedLogLevel: "info",
    metaOrc403: true,
  });
  assert.equal(exhausted, false);
  assert.equal(sets.exhaustedProviders.size, 0);
  assert.equal(sets.exhaustedConnections.size, 0);
});

test("Meta-Orc explicit credential 403 still blocks the failing connection", () => {
  const sets = exhaustionSets();
  const exhausted = applyComboTargetExhaustion(target("groq"), {
    result: { status: 403 },
    fallbackResult: { shouldFallback: true },
    errorText: "invalid API key",
    rawModel: "model-a",
    isTokenLimitBreach: false,
    allAccountsRateLimited: false,
    requestScopedFailure: false,
    sets,
    log: silentLog,
    tag: "COMBO",
    exhaustedLogLevel: "info",
    metaOrc403: true,
  });
  assert.equal(exhausted, true);
  assert.ok(sets.exhaustedConnections.has("groq:groq-conn"));
});

test("Meta-Orc Cloudflare 1010 skips this connection for the request without calling it auth", () => {
  const sets = exhaustionSets();
  const exhausted = applyComboTargetExhaustion(target("nous-research"), {
    result: { status: 403 },
    fallbackResult: { shouldFallback: true },
    errorText: "Access denied by Cloudflare errorCode: 1010 /error-1010/",
    rawModel: "upstage/solar-pro4:free",
    isTokenLimitBreach: false,
    allAccountsRateLimited: false,
    requestScopedFailure: false,
    sets,
    log: silentLog,
    tag: "COMBO",
    exhaustedLogLevel: "info",
    metaOrc403: true,
  });
  assert.equal(exhausted, false);
  assert.ok(sets.exhaustedConnections.has("nous-research:nous-research-conn"));
  assert.equal(sets.exhaustedProviders.size, 0);
});
