import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchRouterRequest,
  normalizeRouterPath,
  type RouterOnlyDependencies,
} from "../../scripts/router-only-server.ts";

function deps(calls: string[]): RouterOnlyDependencies {
  return {
    loadChatRoute: async () => ({
      POST: async (request) => {
        calls.push(`chat:${request.method}`);
        return Response.json({ route: "chat" });
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    }),
    loadResponsesRoute: async () => ({
      POST: async () => {
        calls.push("responses");
        return Response.json({ route: "responses" });
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    }),
    loadModelsCatalog: async () => ({
      getUnifiedModelsResponse: async (request) => {
        calls.push(`models:${new URL(request.url).pathname}`);
        return Response.json({ data: [{ id: "auto/best-free" }] });
      },
    }),
    loadCandidatesRoute: async () => ({
      GET: async (_request, context) => {
        const { channel } = await context.params;
        calls.push(`candidates:${channel}`);
        return Response.json({ channel });
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    }),
  };
}

test("normalizes API bridge aliases to the canonical v1 surface", () => {
  assert.equal(normalizeRouterPath("/api/v1/models"), "/v1/models");
  assert.equal(normalizeRouterPath("/chat/completions"), "/v1/chat/completions");
  assert.equal(normalizeRouterPath("/models"), "/v1/models");
  assert.equal(normalizeRouterPath("/responses"), "/v1/responses");
});

test("dispatches chat without loading unrelated route families", async () => {
  const calls: string[] = [];
  const response = await dispatchRouterRequest(
    new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto/best-free", messages: [] }),
    }),
    deps(calls)
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["chat:POST"]);
});

test("models uses the direct catalog builder and HEAD stays zero-cost", async () => {
  const calls: string[] = [];
  const d = deps(calls);
  const head = await dispatchRouterRequest(
    new Request("http://127.0.0.1/v1/models", { method: "HEAD" }),
    d
  );
  assert.equal(head.status, 200);
  assert.deepEqual(calls, []);

  const get = await dispatchRouterRequest(new Request("http://127.0.0.1/api/v1/models"), d);
  assert.equal(get.status, 200);
  assert.deepEqual(calls, ["models:/api/v1/models"]);
});

test("responses and auto-candidate inspection preserve existing handler contracts", async () => {
  const calls: string[] = [];
  const d = deps(calls);
  const responses = await dispatchRouterRequest(
    new Request("http://127.0.0.1/v1/responses", { method: "POST", body: "{}" }),
    d
  );
  assert.equal(responses.status, 200);

  const candidates = await dispatchRouterRequest(
    new Request("http://127.0.0.1/v1/auto-combo/coding%3Afree/candidates"),
    d
  );
  assert.equal(candidates.status, 200);
  assert.deepEqual(calls, ["responses", "candidates:coding:free"]);
});

test("health and unknown routes stay native and do not import OmniRoute route graphs", async () => {
  const calls: string[] = [];
  const d = deps(calls);
  const health = await dispatchRouterRequest(new Request("http://127.0.0.1/health"), d);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, "router-only");

  const missing = await dispatchRouterRequest(new Request("http://127.0.0.1/api/admin/foo"), d);
  assert.equal(missing.status, 404);
  assert.deepEqual(calls, []);
});

test("unsupported methods fail locally before loading a handler", async () => {
  const calls: string[] = [];
  const response = await dispatchRouterRequest(
    new Request("http://127.0.0.1/v1/models", { method: "DELETE" }),
    deps(calls)
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.deepEqual(calls, []);
});
