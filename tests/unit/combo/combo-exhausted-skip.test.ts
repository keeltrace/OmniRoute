// tests/unit/combo/combo-exhausted-skip.test.ts
// Characterization of getExhaustedTargetSkipReason — the de-duplicated #1731/#1731v2
// pre-dispatch skip predicate shared by both combo dispatchers (handleComboChat +
// handleRoundRobinCombo). Locks the exact skip conditions + message strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advancePastExhaustedTargets,
  getExhaustedTargetSkipReason,
} from "../../../open-sse/services/combo/comboPredicates.ts";

function target(overrides: Record<string, unknown> = {}) {
  return {
    kind: "model",
    executionKey: "ek",
    modelStr: "openai/gpt-4o",
    provider: "openai",
    providerId: null,
    connectionId: "conn-1",
    ...overrides,
  } as Parameters<typeof getExhaustedTargetSkipReason>[0];
}

test("returns null when nothing is exhausted", () => {
  assert.equal(getExhaustedTargetSkipReason(target(), new Set(), new Set()), null);
});

test("#1731v2: skips when the provider:connection pair is in exhaustedConnections", () => {
  const reason = getExhaustedTargetSkipReason(target(), new Set(), new Set(["openai:conn-1"]));
  assert.equal(
    reason,
    "Skipping openai/gpt-4o — connection conn-1 for provider openai had connection error (#1731v2)"
  );
});

test("#1731: skips when the provider is in exhaustedProviders", () => {
  const reason = getExhaustedTargetSkipReason(target(), new Set(["openai"]), new Set());
  assert.equal(
    reason,
    "Skipping openai/gpt-4o — provider openai marked exhausted this request (#1731)"
  );
});

test("connection exhaustion takes precedence over provider exhaustion", () => {
  const reason = getExhaustedTargetSkipReason(
    target(),
    new Set(["openai"]),
    new Set(["openai:conn-1"])
  );
  assert.ok(reason?.includes("(#1731v2)"));
});

test("a different connection of an exhausted pair is NOT skipped on the connection check", () => {
  const reason = getExhaustedTargetSkipReason(
    target({ connectionId: "conn-2" }),
    new Set(),
    new Set(["openai:conn-1"])
  );
  assert.equal(reason, null);
});

test("no connectionId: only the provider-level check applies", () => {
  assert.equal(getExhaustedTargetSkipReason(target({ connectionId: null }), new Set(), new Set()), null);
  assert.ok(
    getExhaustedTargetSkipReason(target({ connectionId: null }), new Set(["openai"]), new Set())?.includes(
      "(#1731)"
    )
  );
});

test("empty provider string is treated as falsy (no skip)", () => {
  assert.equal(
    getExhaustedTargetSkipReason(target({ provider: "" }), new Set([""]), new Set([":conn-1"])),
    null
  );
});

test("advances over a large exhausted-connection run without removing the route tail", () => {
  const targets = [
    ...Array.from({ length: 500 }, (_, index) =>
      target({ executionKey: `a-${index}`, connectionId: "conn-a" })
    ),
    target({ executionKey: "b-0", connectionId: "conn-b" }),
  ];

  const result = advancePastExhaustedTargets(targets, 0, new Set(), new Set(["openai:conn-a"]));

  assert.equal(result.skippedCount, 500);
  assert.equal(result.nextIndex, 500);
  assert.equal(targets[result.nextIndex].connectionId, "conn-b");
  assert.equal(targets.length, 501);
});

test("does not suppress an independent connection for the same provider", () => {
  const targets = [
    target({ executionKey: "a-0", connectionId: "conn-a" }),
    target({ executionKey: "b-0", connectionId: "conn-b" }),
  ];

  const result = advancePastExhaustedTargets(targets, 0, new Set(), new Set(["openai:conn-a"]));

  assert.equal(result.nextIndex, 1);
  assert.equal(targets[result.nextIndex].connectionId, "conn-b");
  assert.equal(getExhaustedTargetSkipReason(targets[result.nextIndex], new Set(), new Set(["openai:conn-a"])), null);
});
