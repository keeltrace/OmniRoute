import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cleanupPath = fileURLToPath(new URL("../../../src/lib/db/cleanup.ts", import.meta.url));
const source = readFileSync(cleanupPath, "utf8");
const schedulerMarker = "// ──────────────── Background Cleanup Scheduler ────────────────";

test("retention scheduler does not run proxy cleanup twice", () => {
  assert.match(
    source,
    /proxyLogs:\s*await cleanupProxyLogs\(\)/,
    "runAutoCleanup must remain the single owner of proxy-log retention cleanup"
  );

  const markerIndex = source.indexOf(schedulerMarker);
  assert.ok(markerIndex >= 0, "background cleanup scheduler marker must exist");
  const schedulerSource = source.slice(markerIndex);

  assert.doesNotMatch(
    schedulerSource,
    /await cleanupProxyLogs\(\)/,
    "scheduler must not repeat proxy cleanup after runAutoCleanup already performed it"
  );
});
