import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../../src/app/api/usage/auto-route-lab/route.ts";

test("rank lab API is management-only and explicitly non-dispatching", async () => {
  const response = await POST(new Request("http://localhost/api/usage/auto-route-lab", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Rename this variable." }],
      candidates: [{ executionKey: "free/rename", provider: "free", model: "small", connectionId: "connection-test", economicClass: "free", toolCalling: true, contextLimit: 100000 }],
    }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.diagnostics.dispatches, 0);
  assert.equal(body.diagnostics.mutation, false);
  assert.equal(body.candidateCount, 1);
  assert.equal(body.allCandidates.length, 1);
  assert.deepEqual(body.economicSummary.free.count, 1);
  assert.equal(body.currentRanking[0].connectionId, undefined);
  assert.equal(body.currentRanking[0].connectionIdSanitized, "conn:5fd78f71de78");
});
