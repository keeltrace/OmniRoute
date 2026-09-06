import test from "node:test";
import assert from "node:assert/strict";

import {
  clearProxyFallbackCache,
  findWorkingProxy,
  __setProxyFallbackTestHooks,
} from "../../open-sse/utils/proxyFallback.ts";

test.afterEach(() => {
  __setProxyFallbackTestHooks(null);
  clearProxyFallbackCache();
});

test("proxy fallback negative cache is scoped by target URL, not only hostname", async () => {
  const proxyUrl = "http://127.0.0.1:18080";
  const probes: string[] = [];

  __setProxyFallbackTestHooks({
    getProxyCandidates: async () => [proxyUrl],
    testSingleProxy: async (_proxyUrl, targetUrl) => {
      probes.push(targetUrl);
      return {
        ok: targetUrl.endsWith("/v1/chat/completions"),
        latencyMs: targetUrl.endsWith("/v1/chat/completions") ? 12 : null,
      };
    },
  });

  assert.equal(
    await findWorkingProxy("api.example.test", "https://api.example.test/v1/models"),
    null
  );
  assert.equal(
    await findWorkingProxy("api.example.test", "https://api.example.test/v1/chat/completions"),
    proxyUrl
  );
  assert.deepEqual(probes, [
    "https://api.example.test/v1/models",
    "https://api.example.test/v1/chat/completions",
  ]);
});

test("proxy fallback cache stays bounded under high target cardinality", async () => {
  const proxyUrl = "http://127.0.0.1:18080";
  let probeCount = 0;

  __setProxyFallbackTestHooks({
    getProxyCandidates: async () => [proxyUrl],
    testSingleProxy: async () => {
      probeCount++;
      return { ok: false, latencyMs: null };
    },
  });

  for (let i = 0; i < 257; i++) {
    await findWorkingProxy("api.example.test", `https://api.example.test/v1/models?tenant=${i}`);
  }
  assert.equal(probeCount, 257);

  await findWorkingProxy("api.example.test", "https://api.example.test/v1/models?tenant=0");
  assert.equal(probeCount, 258, "oldest target should have been evicted at the cache cap");
});
