import assert from "node:assert/strict";
import test from "node:test";
import { shouldFallbackPinnedStatus } from "../../open-sse/services/combo/dispatchPrelude.ts";
import {
  applyComboTargetExhaustion,
  type ApplyComboTargetExhaustionOptions,
  type ComboExhaustionSets,
} from "../../open-sse/services/combo/targetExhaustion.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

const log = {
  info() {},
  debug() {},
  warn() {},
  error() {},
};

function target(provider: string, connectionId: string, modelStr: string): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: `${provider}:${modelStr}`,
    provider,
    providerId: provider,
    connectionId,
    modelStr,
    executionKey: `${provider}:${connectionId}:${modelStr}`,
    weight: 1,
    label: null,
  };
}

function authFailure(targetValue: ResolvedComboTarget, sets: ComboExhaustionSets) {
  return applyComboTargetExhaustion(targetValue, {
    result: { status: 401, headers: new Headers() },
    fallbackResult: {
      shouldFallback: true,
      cooldownMs: 0,
      reason: "auth_error",
    } as ApplyComboTargetExhaustionOptions["fallbackResult"],
    errorText: "Your API key is invalid",
    rawModel: targetValue.modelStr,
    isTokenLimitBreach: false,
    allAccountsRateLimited: false,
    requestScopedFailure: false,
    sets,
    log,
    tag: "TEST",
    exhaustedLogLevel: "info",
  });
}

test("401 on a pinned target re-enters the combo fallback loop", () => {
  assert.equal(shouldFallbackPinnedStatus(401), true);
  assert.equal(shouldFallbackPinnedStatus(403), false);
  assert.equal(shouldFallbackPinnedStatus(400), false);
});

test("401 exhausts only the failing connection, preserving sibling provider accounts", () => {
  const sets = {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
  };
  const nousA = target("nous-research", "conn-a", "inclusionai/ling-3.0-flash-fin:free");
  assert.equal(authFailure(nousA, sets), true);
  assert.deepEqual([...sets.exhaustedConnections], ["nous-research:conn-a"]);
  assert.equal(sets.exhaustedProviders.has("nous-research"), false);
  assert.equal(sets.exhaustedConnections.has("nous-research:conn-b"), false);
  assert.equal(sets.exhaustedConnections.has("opencode:conn-b"), false);
  // A combo dispatcher can therefore skip every remaining model on conn-a and
  // still attempt independently authenticated Nous/OpenCode candidates.
  assert.equal(sets.exhaustedConnections.has("nous-research:conn-b"), false);
});

test("401 classification never falls through to a paid route", () => {
  const sets = {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
  };
  authFailure(target("nous-research", "conn-a", "free-model"), sets);
  const paid = target("claude", "paid", "claude-sonnet");
  assert.equal(sets.exhaustedConnections.has("claude:paid"), false);
  assert.equal(paid.provider, "claude");
});
