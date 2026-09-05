import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auto-fallback-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { resolveAutoStrategyOrder } = await import(
  "../../open-sse/services/combo/resolveAutoStrategy.ts"
);

type ResolveDeps = Parameters<typeof resolveAutoStrategyOrder>[0];
type Target = ResolveDeps["orderedTargets"][number];
type BuildAutoCandidates = ResolveDeps["buildAutoCandidates"];

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => resetStorage());

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

const noopLog: ResolveDeps["log"] = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function target(provider: string, modelStr: string): Target {
  return {
    kind: "model",
    stepId: `${provider}>${modelStr}`,
    executionKey: `${provider}>${modelStr}`,
    modelStr,
    provider,
    providerId: provider,
    connectionId: null,
    weight: 1,
    label: null,
  };
}

function depsFor(
  orderedTargets: Target[],
  body: Record<string, unknown>,
  buildAutoCandidates: BuildAutoCandidates
): ResolveDeps {
  return {
    orderedTargets,
    body,
    combo: { id: "pure-auto", name: "pure-auto", models: [], config: {} },
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as ResolveDeps["resilienceSettings"],
    log: noopLog,
    buildAutoCandidates,
  };
}

async function addConnection(provider: string) {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider} fallback fixture`,
    apiKey: `sk-${provider}-auto-fallback-test`,
  });
}

test("pure auto expands before tool compatibility filtering", async () => {
  await addConnection("openai");
  const seedModel = "openai/text-embedding-3-small";
  let seenModels: string[] = [];
  const buildAutoCandidates: BuildAutoCandidates = async (targets) => {
    seenModels = targets.map((entry) => entry.modelStr);
    return [];
  };

  const result = await resolveAutoStrategyOrder(
    depsFor(
      [target("openai", seedModel)],
      {
        messages: [{ role: "user", content: "call a tool" }],
        tools: [
          {
            type: "function",
            function: { name: "ping", parameters: { type: "object", properties: {} } },
          },
        ],
      },
      buildAutoCandidates
    )
  );

  assert.equal("earlyResponse" in result, false);
  assert.ok(seenModels.length > 0, "expanded tool-capable models should reach candidate building");
  assert.equal(
    seenModels.includes(seedModel),
    false,
    "the incompatible seed should be filtered only after the full pool is expanded"
  );
});

test("pure auto expands when estimated input tokens are zero", async () => {
  await addConnection("openai");
  await addConnection("anthropic");
  let seenProviders: string[] = [];
  const buildAutoCandidates: BuildAutoCandidates = async (targets) => {
    seenProviders = targets.map((entry) => entry.provider);
    return [];
  };

  const result = await resolveAutoStrategyOrder(
    depsFor([target("openai", "openai/gpt-4o")], { messages: [] }, buildAutoCandidates)
  );

  assert.equal("earlyResponse" in result, false);
  assert.ok(seenProviders.includes("openai"));
  assert.ok(
    seenProviders.includes("anthropic"),
    "zero-token requests must still expand to other active providers"
  );
});
