import type { FreeApiCandidate, FreeCandidateSnapshot } from "./types";

function cloneCandidates(candidates: readonly FreeApiCandidate[]): FreeApiCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    providerAliases: [...candidate.providerAliases],
    modelAliases: [...candidate.modelAliases],
    auth: { ...candidate.auth, envVars: [...candidate.auth.envVars] },
    capabilities: { ...candidate.capabilities },
    nominalPricing: { ...candidate.nominalPricing },
    freeEntitlement: { ...candidate.freeEntitlement },
    runtime: { ...candidate.runtime },
    performance: { ...candidate.performance },
    evidence: candidate.evidence.map((record) => ({
      ...record,
      ...(record.metadata ? { metadata: { ...record.metadata } } : {}),
    })),
  }));
}

/** Storage contract so SQLite/JSON persistence can be plugged in independently. */
export interface FreeCandidateStore {
  read(): FreeCandidateSnapshot;
  commitRefreshSuccess(candidates: readonly FreeApiCandidate[], at?: string): void;
  recordRefreshFailure(error: unknown, at?: string): void;
}

/**
 * Last-known-good semantics used by ingestion code. A failed refresh never
 * replaces a good catalog with an empty list; it marks the snapshot stale and
 * retains the last successful candidates until a later refresh succeeds.
 */
export class LastKnownGoodFreeCandidateStore implements FreeCandidateStore {
  private snapshot: FreeCandidateSnapshot = {
    candidates: [],
    refreshedAt: null,
    stale: true,
    lastRefreshAttemptAt: null,
    lastRefreshError: null,
  };

  read(): FreeCandidateSnapshot {
    return {
      ...this.snapshot,
      candidates: cloneCandidates(this.snapshot.candidates),
    };
  }

  commitRefreshSuccess(candidates: readonly FreeApiCandidate[], at = new Date().toISOString()): void {
    this.snapshot = {
      candidates: cloneCandidates(candidates),
      refreshedAt: at,
      stale: false,
      lastRefreshAttemptAt: at,
      lastRefreshError: null,
    };
  }

  recordRefreshFailure(error: unknown, at = new Date().toISOString()): void {
    const message = error instanceof Error ? error.message : String(error);
    this.snapshot = {
      ...this.snapshot,
      candidates: cloneCandidates(this.snapshot.candidates),
      stale: true,
      lastRefreshAttemptAt: at,
      lastRefreshError: message,
    };
  }
}
