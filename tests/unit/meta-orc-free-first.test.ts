import test from "node:test";
import assert from "node:assert/strict";

import { resolveAutoRoutingState } from "../../src/sse/handlers/autoRouting.ts";
import { splitMetaOrcTargetByFreeConnections } from "../../open-sse/services/combo/metaOrcFreeFirst.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

test("chat:free aliases to the resilient Meta-Orc route", async () => {
  const state = await resolveAutoRoutingState("chat:free");
  assert.equal(state.model, "auto/meta-orc");
  assert.equal(state.isAutoRouting, true);
  assert.equal(state.recognizedBuiltInAuto, true);
  assert.equal(state.variant, "cheap");
  assert.equal(state.response, null);
});

test("auto/chat:free aliases to Meta-Orc instead of the fail-closed free tier", async () => {
  const state = await resolveAutoRoutingState("auto/chat:free");
  assert.equal(state.model, "auto/meta-orc");
  assert.equal(state.isAutoRouting, true);
  assert.equal(state.recognizedBuiltInAuto, true);
  assert.equal(state.variant, "cheap");
  assert.equal(state.spec?.tier, undefined);
});

test("auto/meta-orc remains a built-in route", async () => {
  const state = await resolveAutoRoutingState("auto/meta-orc");
  assert.equal(state.model, "auto/meta-orc");
  assert.equal(state.recognizedBuiltInAuto, true);
  assert.equal(state.variant, "cheap");
});
function target(allowedConnectionIds: string[]): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: "step-1",
    executionKey: "step-1",
    modelStr: "example/model-a",
    provider: "example",
    providerId: "example",
    connectionId: null,
    allowedConnectionIds,
    weight: 1,
    label: "example",
  };
}

test("mixed free/paid accounts become separate ordered attempts", () => {
  const split = splitMetaOrcTargetByFreeConnections(target(["paid-account", "free-account"]), [
    "free-account",
  ]);

  assert.equal(split.free.length, 1);
  assert.equal(split.rescue.length, 1);
  assert.deepEqual(split.free[0]?.allowedConnectionIds, ["free-account"]);
  assert.deepEqual(split.rescue[0]?.allowedConnectionIds, ["paid-account"]);
  assert.match(split.free[0]?.executionKey || "", /meta-orc-free$/);
  assert.match(split.rescue[0]?.executionKey || "", /meta-orc-rescue$/);
});

test("all-free account scope has no paid rescue duplicate", () => {
  const original = target(["free-a", "free-b"]);
  const split = splitMetaOrcTargetByFreeConnections(original, ["free-a", "free-b"]);
  assert.deepEqual(split.free, [original]);
  assert.deepEqual(split.rescue, []);
});

test("Meta-Orc moves static-free Nous ahead of an earlier paid candidate", async () => {
  const { enforceMetaOrcFreeFirstOrder } =
    await import("../../open-sse/services/combo/metaOrcFreeFirst.ts");
  const paid = {
    ...target(["paid-1"]),
    executionKey: "paid-step",
    stepId: "paid-step",
    provider: "openai",
    providerId: "openai",
    modelStr: "openai/gpt-5",
  };
  const nous = {
    ...target(["nous-1"]),
    executionKey: "nous-step",
    stepId: "nous-step",
    provider: "nous-research",
    providerId: "nous-research",
    modelStr: "nous-research/Hermes-4-405B",
  };

  const ordered = await enforceMetaOrcFreeFirstOrder([paid, nous]);
  assert.equal(ordered[0]?.provider, "nous-research");
  assert.equal(ordered[0]?.modelStr, "nous-research/Hermes-4-405B");
  assert.equal(ordered.at(-1)?.provider, "openai");
});

test("Meta-Orc treats rotating OpenCode *-free ids as free before paid rescue", async () => {
  const { enforceMetaOrcFreeFirstOrder } =
    await import("../../open-sse/services/combo/metaOrcFreeFirst.ts");
  const paid = {
    ...target(["paid-1"]),
    executionKey: "paid-opus",
    provider: "claude",
    providerId: "claude",
    modelStr: "claude/claude-opus-5",
  };
  const opencode = {
    ...target([]),
    executionKey: "oc-free",
    provider: "opencode",
    providerId: "opencode",
    modelStr: "opencode/mimo-v2.5-free",
    connectionId: "noauth",
    allowedConnectionIds: undefined,
  };
  const ordered = await enforceMetaOrcFreeFirstOrder([paid, opencode]);
  assert.equal(ordered[0]?.provider, "opencode");
  assert.equal(ordered[0]?.modelStr, "opencode/mimo-v2.5-free");
  assert.equal(ordered.at(-1)?.provider, "claude");
});
