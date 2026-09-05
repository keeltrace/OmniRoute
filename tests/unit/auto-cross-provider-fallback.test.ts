import { after, test } from "node:test";
import assert from "node:assert/strict";

import { resolveAutoStrategyOrder } from "@omniroute/open-sse/services/combo/resolveAutoStrategy.ts";
import { resetDbInstance } from "@/lib/db/core.ts";

type ResolveDeps = Parameters<typeof resolveAutoStrategyOrder>[0];
type Target = ResolveDeps["orderedTargets"][number];

after(() => {
  resetDbInstance();
});

const noopLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as ResolveDeps["log"];

function target(provider: string, modelStr: string): Target {
  return {
    kind: "model",
    stepId: `${provider}>${modelStr}`,
    executionKey: `${provider}>${modelStr}`,
    modelStr,
    provider,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  } as Target;
}

function depsFor(buildAutoCandidates: ResolveDeps["buildAutoCandidates"]): ResolveDeps {
  return {
    orderedTargets: [target("openai", "gpt-4o")],
    body: { messages: [{ role: "user", content: "hello" }] },
    combo: { id: "pure-auto", name: "pure-auto", config: {} },
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as ResolveDeps["resilienceSettings"],
    log: noopLog,
    buildAutoCandidates,
  };
}

test("pure auto expands before tool compatibility filtering", async () => {
  let seenModels: string[] = [];
  const deps = depsFor(async (targets) => {
    seenModels = targets.map((entry) => entry.modelStr);
    return [];
  });
  deps.orderedTargets = [target("openai", "text-embedding-3-small")];
  deps.body = {
    messages: [{ role: "user", content: "call a tool" }],
    tools: [
      {
        type: "function",
        function: { name: "ping", parameters: { type: "object", properties: {} } },
      },
    ],
  };
  deps.expandAutoCandidatePool = async (targets) => [...targets, target("openai", "gpt-4o")];

  const result = await resolveAutoStrategyOrder(deps);

  assert.ok(
    !("earlyResponse" in result),
    "a tool-capable target added by pure-auto expansion must prevent a false capability mismatch"
  );
  assert.deepEqual(
    seenModels,
    ["gpt-4o"],
    "tool filtering must run after expansion and retain the expanded tool-capable target"
  );
});

test("pure auto expands even when the request has zero estimated input tokens", async () => {
  let expansionCalls = 0;
  let seenProviders: string[] = [];
  const deps = depsFor(async (targets) => {
    seenProviders = targets.map((entry) => entry.provider);
    return [];
  });
  deps.body = { messages: [] };
  deps.expandAutoCandidatePool = async (targets) => {
    expansionCalls += 1;
    return [...targets, target("anthropic", "claude-3")];
  };

  const result = await resolveAutoStrategyOrder(deps);

  assert.ok(!("earlyResponse" in result));
  assert.equal(expansionCalls, 1);
  assert.deepEqual(seenProviders, ["openai", "anthropic"]);
});
