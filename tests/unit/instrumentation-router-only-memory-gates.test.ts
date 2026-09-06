import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/instrumentation-node.ts", "utf8");

function gatedBlockContains(needle: string): boolean {
  const blockStart = source.indexOf("if (!backgroundServicesDisabled)");
  if (blockStart < 0) return false;
  const index = source.indexOf(needle);
  return index > blockStart;
}

test("router-only mode gates model-catalog warmup and diagnostic registry scans", () => {
  assert.match(source, /const backgroundServicesDisabled = isBackgroundServicesDisabled\(\)/);
  const scanCall = source.indexOf("await scanComboModelNameCollisionsAtBoot()");
  const scanGate = source.lastIndexOf("if (!backgroundServicesDisabled)", scanCall);
  assert.ok(scanGate >= 0 && scanGate < scanCall);
  const warmCall = source.indexOf("void warmModelCatalogCache()");
  const warmGate = source.lastIndexOf("if (!backgroundServicesDisabled)", warmCall);
  assert.ok(warmGate >= 0 && warmGate < warmCall);
});

test("router-only mode does not eagerly import maintenance scheduler graphs", () => {
  for (const moduleId of [
    '@/lib/proxyHealth/scheduler',
    '@/lib/freeProxyProviders/scheduler',
    '@/lib/credentialHealth/scheduler',
    '@/lib/config/hotReload',
    '@/lib/db/cleanup',
    '@/lib/db/vacuumScheduler',
    '@/domain/quotaCache',
    '@/lib/initCloudSync',
    '@/shared/services/providerLimitsSyncScheduler',
  ]) {
    assert.ok(gatedBlockContains(`import("${moduleId}")`), `${moduleId} must stay behind background gate`);
  }
});


test("router-only mode suppresses migration cloud sync", () => {
  assert.match(
    source,
    /settings\.cloudEnabled === true && !backgroundServicesDisabled/
  );
});
