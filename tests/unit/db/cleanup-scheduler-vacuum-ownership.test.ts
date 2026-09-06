import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cleanupPath = fileURLToPath(new URL("../../../src/lib/db/cleanup.ts", import.meta.url));
const vacuumSchedulerPath = fileURLToPath(
  new URL("../../../src/lib/db/vacuumScheduler.ts", import.meta.url)
);
const cleanupSource = readFileSync(cleanupPath, "utf8");
const vacuumSchedulerSource = readFileSync(vacuumSchedulerPath, "utf8");
const schedulerMarker = "// ──────────────── Background Cleanup Scheduler ────────────────";

test("retention cleanup leaves full VACUUM to the Storage scheduler", () => {
  const markerIndex = cleanupSource.indexOf(schedulerMarker);
  assert.ok(markerIndex >= 0, "background cleanup scheduler marker must exist");
  const schedulerSource = cleanupSource.slice(markerIndex);

  assert.doesNotMatch(
    schedulerSource,
    /db\.exec\("VACUUM"\)/,
    "retention cleanup must not bypass the Storage scheduledVacuum setting"
  );
  assert.match(
    vacuumSchedulerSource,
    /db\.exec\("VACUUM"\)/,
    "vacuumScheduler must remain the owner of full VACUUM"
  );
  assert.match(
    vacuumSchedulerSource,
    /frequency === "never"\) return null/,
    "vacuumScheduler must continue honoring scheduledVacuum=never"
  );
});
