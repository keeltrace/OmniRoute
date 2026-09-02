import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.DATA_DIR ??= mkdtempSync(`${tmpdir()}/omniroute-rank-lab-workforce-`);
const { analyzeRequestProfile, buildModelUtilityProfile, rankRequestCandidates } = await import("../open-sse/services/autoCombo/requestAwareRankLab.ts");

const fixture = JSON.parse(await readFile(new URL("../fixtures/rank-lab-workforce.json", import.meta.url), "utf8")) as Record<string, unknown>;
const prompts = [
  ["01 trivial rename", "Rename this variable."], ["02 formatting", "Format this document."],
  ["03 extraction/classification", "Extract and classify these fields."], ["04 simple implementation", "Implement this small helper."],
  ["05 normal implementation", "Implement the requested API endpoint."], ["06 debugging", "Debug the failing request and fix the bug."],
  ["07 difficult coding", "Implement the complex concurrent scheduler."], ["08 review", "Review this change for correctness and security."],
  ["09 architecture/planning", "Design the architecture and explain the trade-offs."], ["10 difficult reasoning", "Prove whether this distributed design is correct."],
  ["11 tool-heavy agent work", "Inspect the repository with tools and implement the change."], ["12 long-context analysis", "Analyze this long specification and identify every dependency."],
] as const;
const candidates = Array.isArray(fixture.candidates) ? fixture.candidates : [];
for (const [name, content] of prompts) {
  const request = analyzeRequestProfile({ messages: [{ role: "user", content }], tools: name.includes("tool") ? [{ type: "function" }] : undefined, max_tokens: 4096 });
  const result = rankRequestCandidates(request, candidates.map((candidate) => buildModelUtilityProfile(candidate as never, request)));
  const top = result.awareRanking.slice(0, 5).map((row) => `${row.provider}/${row.model}`);
  const mix = result.awareRanking.slice(0, 20).reduce((out, row) => { out[row.economicClass] = (out[row.economicClass] ?? 0) + 1; return out; }, {} as Record<string, number>);
  console.log(JSON.stringify({ name, role: request.role, minimumExpectedUtility: request.minimumExpectedUtility, top5: top, top20EconomicMix: mix }));
}
