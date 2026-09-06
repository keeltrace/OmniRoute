import test from "node:test";
import assert from "node:assert/strict";
import { hasUsableOAuthToken } from "../../open-sse/services/autoCombo/virtualFactory.ts";

const expired = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 60_000).toISOString();

function conn(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    provider: "claude",
    accessToken: "expired-access",
    refreshToken: "refresh-me",
    tokenExpiresAt: expired,
    expiresAt: expired,
    ...overrides,
  } as any;
}

test("regular auto rejects expired OAuth access token", () => {
  assert.equal(hasUsableOAuthToken(conn()), false);
});

test("Meta-Orc rescue admits expired OAuth when a refresh token exists", () => {
  assert.equal(hasUsableOAuthToken(conn(), true), true);
});

test("Meta-Orc does not invent rescue for expired OAuth without refresh token", () => {
  assert.equal(hasUsableOAuthToken(conn({ refreshToken: "" }), true), false);
});

test("unexpired OAuth remains usable in either mode", () => {
  const live = conn({ tokenExpiresAt: future, expiresAt: future, refreshToken: "" });
  assert.equal(hasUsableOAuthToken(live), true);
  assert.equal(hasUsableOAuthToken(live, true), true);
});
import {
  buildConnectionResilienceMap,
  filterResilienceBlockedCandidates,
} from "../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";

const candidate = {
  provider: "nous-research",
  connectionId: null,
  allowedConnectionIds: ["nous-refreshable"],
  model: "upstage/solar-pro4:free",
};

test("Meta-Orc resilience keeps refreshable expired OAuth instead of dropping it later", () => {
  const byId = buildConnectionResilienceMap([
    {
      id: "nous-refreshable",
      testStatus: "expired",
      authType: "oauth",
      refreshToken: "refresh-me",
    },
  ]);
  assert.deepEqual(filterResilienceBlockedCandidates([candidate], byId), []);
  assert.deepEqual(filterResilienceBlockedCandidates([candidate], byId, false, true), [candidate]);
});

test("Meta-Orc resilience still blocks terminal OAuth without a refresh path", () => {
  const noRefresh = buildConnectionResilienceMap([
    { id: "nous-refreshable", testStatus: "expired", authType: "oauth", refreshToken: "" },
  ]);
  const banned = buildConnectionResilienceMap([
    {
      id: "nous-refreshable",
      testStatus: "banned",
      authType: "oauth",
      refreshToken: "refresh-me",
    },
  ]);
  assert.deepEqual(filterResilienceBlockedCandidates([candidate], noRefresh, false, true), []);
  assert.deepEqual(filterResilienceBlockedCandidates([candidate], banned, false, true), []);
});
