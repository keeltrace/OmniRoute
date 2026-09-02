import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// The fixture runner is shadow-only.  Keep imports that initialize shared DB
// modules pointed at disposable state, never the operator's live data dir.
process.env.DATA_DIR ??= mkdtempSync(`${tmpdir()}/omniroute-rank-lab-`);
const { analyzeRequestProfile, buildModelUtilityProfile, rankRequestCandidates } = await import("../open-sse/services/autoCombo/requestAwareRankLab.ts");

const file = process.argv[2];
if (!file) throw new Error("usage: node --import tsx scripts/rank-lab.ts <fixture.json>");
const fixture = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
const profile = analyzeRequestProfile(fixture);
const candidates = Array.isArray(fixture.candidates) ? fixture.candidates : [];
const result = rankRequestCandidates(profile, candidates.map((candidate) => buildModelUtilityProfile(candidate as never, profile)));
if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
else {
  console.log("REQUEST PROFILE"); console.log(JSON.stringify(profile, null, 2));
  console.log("TOP CURRENT"); console.log(result.topCurrent ? `${result.topCurrent.provider}/${result.topCurrent.model}` : "none");
  console.log("TOP AWARE"); console.log(result.topAware ? `${result.topAware.provider}/${result.topAware.model}` : "none");
  console.log("BIGGEST RISERS"); console.log(result.rankingDiff.filter((r) => (r.rankDelta ?? 0) > 0).sort((a, b) => (b.rankDelta ?? 0) - (a.rankDelta ?? 0)).slice(0, 10).map((r) => `${r.provider}/${r.model}: +${r.rankDelta}`).join("\n"));
  console.log("BIGGEST FALLERS"); console.log(result.rankingDiff.filter((r) => (r.rankDelta ?? 0) < 0).sort((a, b) => (a.rankDelta ?? 0) - (b.rankDelta ?? 0)).slice(0, 10).map((r) => `${r.provider}/${r.model}: ${r.rankDelta}`).join("\n"));
  console.log("WHY CURRENT #1\n" + result.whyCurrentWinner); console.log("WHY AWARE #1\n" + result.whyAwareWinner);
}
