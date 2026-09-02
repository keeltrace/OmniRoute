import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLazyAutoTargetPlan,
  type AutoTargetDescriptor,
} from "../../open-sse/services/combo/lazyAutoTargetPlan.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

const target = (index: number, provider = `provider-${index % 8}`): ResolvedComboTarget => ({
  kind: "model",
  stepId: `step-${index}`,
  executionKey: `${provider}>model-${index}`,
  modelStr: `${provider}/model-${index}`,
  provider,
  providerId: provider,
  connectionId: `connection-${index}`,
  allowedConnectionIds: [`connection-${index}`],
  weight: index + 1,
  label: null,
});

test("lazy plan keeps a complete 900-target descriptor universe and materializes only the frontier", () => {
  const plan = createLazyAutoTargetPlan(Array.from({ length: 896 }, (_, i) => target(i)));

  assert.equal(plan.length, 896);
  assert.equal(plan.materializedCount, 0);
  assert.equal(plan.peakMaterialized, 0);

  const first = plan.materialize(0);
  plan.markAttempt(0);
  plan.release(0);
  assert.equal(first.executionKey, "provider-0>model-0");
  assert.equal(plan.materializedCount, 1);
  assert.equal(plan.peakMaterialized, 1);

  const last = plan.materialize(895);
  plan.markAttempt(895);
  plan.release(895);
  assert.equal(last.executionKey, "provider-7>model-895");
  assert.equal(plan.length, 896);
  assert.equal(plan.attemptedCount, 2);
  assert.equal(plan.peakMaterialized, 1);
});

test("lazy plan preserves deterministic ordering and provider diversity through the tail", () => {
  const eager = Array.from({ length: 32 }, (_, i) => target(i, `provider-${i % 4}`));
  const plan = createLazyAutoTargetPlan(eager);

  assert.deepEqual(
    plan.descriptors.map((descriptor) => descriptor.executionKey),
    eager.map((candidate) => candidate.executionKey)
  );
  assert.deepEqual(
    new Set(plan.descriptors.map((descriptor) => descriptor.provider)),
    new Set(eager.map((candidate) => candidate.provider))
  );
  assert.deepEqual(plan.descriptorAt(31), eager[31]);
});

test("materialization preserves filters, scoring inputs, affinity and connection allowlists", () => {
  const original = target(3, "codex");
  original.failoverBeforeRetry = true;
  original.fallbackOnlyOnQuotaExhaustion = true;
  original.trafficType = "production";
  original.pinnedFingerprint = "fp-a";
  const plan = createLazyAutoTargetPlan([original]);
  const materialized = plan.materialize(0);

  assert.deepEqual(materialized, original);
  assert.notEqual(materialized.allowedConnectionIds, original.allowedConnectionIds);
  assert.equal((plan.descriptorAt(0) as AutoTargetDescriptor).provider, "codex");
});

test("materialized targets are not cached, so fallback attempts do not retain the route", () => {
  const plan = createLazyAutoTargetPlan([target(0), target(1), target(2)]);
  const first = plan.materialize(0);
  plan.release(0);
  const second = plan.materialize(0);
  plan.release(0);

  assert.notEqual(first, second);
  assert.equal(plan.materializedCount, 2);
  assert.equal(plan.peakMaterialized, 1);
});
