import { createHash } from "node:crypto";

import { getCachedProviderConnections } from "../../../src/lib/db/readCache";
import { classifyConnectionBilling } from "./connectionBilling.ts";
import { resolveModelEconomics } from "./modelEconomics.ts";
import {
  analyzeRequestProfile,
  buildModelUtilityProfile,
  rankRequestCandidates,
  type RankLabRow,
} from "./requestAwareRankLab.ts";
import { supportsToolCalling } from "../modelCapabilities.ts";
import { getModelContextLimitForModelString } from "../combo/comboStructure.ts";
import { getComboTrace } from "../combo/decisionTrace.ts";
import type { AutoProviderCandidate, ResolvedComboTarget } from "../combo/types.ts";
type ShadowPlan = {
  orderedTargets: ResolvedComboTarget[];
  scoringFactors?: Array<{ executionKey: string; score: number; factors: Record<string, unknown> }>;
  sourceCandidates?: AutoProviderCandidate[];
};

const MAX_RECEIPTS = 500;
const pending = new Map<string, Promise<ShadowReceiptDraft | null>>();
const receipts: ShadowReceipt[] = [];

/** Explicit opt-in keeps the observer dark by default and bounds production overhead. */
export function isRankLabShadowEnabled(): boolean {
  return process.env.OMNIROUTE_RANK_LAB_SHADOW === "true";
}

export interface ShadowReceipt {
  requestId: string;
  timestamp: string;
  requestFingerprint: string;
  factoryRole: string | null;
  requestProfile: {
    role: string;
    tasks: string[];
    complexity: number;
    reasoningNeed: number;
    toolReliabilityNeed: number;
    minimumExpectedUtility: number;
    confidence: number;
  };
  production: {
    selectedTarget: string | null;
    attemptedTargets: string[];
    currentRank: number | null;
    autoScore: number | null;
    rankSource: "auto_score" | "fallback_tail" | null;
    fallbackCount: number;
  };
  aware: {
    suggestedTarget: string | null;
    awareScore: number | null;
    top10: Array<{ target: string; score: number; rank: number | null }>;
    productionTargetAwareRank: number | null;
    suggestedTargetCurrentRank: number | null;
    rankDelta: number | null;
  };
  economics: {
    productionClass: string | null;
    awareClass: string | null;
    confidence: string | null;
    source: string | null;
  };
  outcome: {
    status: number | null;
    success: boolean | null;
    toolSuccess: boolean | null;
    latencyMs: number | null;
    retries: number | null;
    providerError: boolean | null;
  };
}

interface ShadowReceiptDraft {
  receipt: ShadowReceipt;
  ranking: RankLabRow[];
  finalTargets: ResolvedComboTarget[];
}

function sanitizedConnection(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return `conn:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function targetLabel(target: { provider?: string | null; modelStr?: string | null }): string {
  return String(target.modelStr || target.provider || "unknown");
}

function fingerprint(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const shape = {
    messageCount: messages.length,
    messageRoles: messages.map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).role : null)),
    messageLengths: messages.map((m) => (m && typeof m === "object" ? String((m as Record<string, unknown>).content ?? "").length : String(m ?? "").length)),
    toolNames: tools.map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      const fn = (tool as Record<string, unknown>).function;
      return fn && typeof fn === "object" ? ((fn as Record<string, unknown>).name ?? null) : null;
    }),
    maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

function makeCandidate(target: ResolvedComboTarget, source?: AutoProviderCandidate): AutoProviderCandidate {
  if (source) return source;
  return {
    stepId: target.stepId,
    executionKey: target.executionKey,
    modelStr: target.modelStr,
    provider: target.provider || target.modelStr.split("/")[0] || "unknown",
    model: target.modelStr.split("/").slice(1).join("/") || target.modelStr,
    connectionId: target.connectionId ?? undefined,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: 1000,
    latencyStdDev: 100,
    errorRate: 0.05,
    accountTier: "standard",
    quotaResetIntervalSecs: 86400,
    contextAffinity: 0.5,
    sessionAvailability: 1,
    resetWindowAffinity: 0.5,
    connectionPoolSize: 1,
  } as unknown as AutoProviderCandidate;
}

async function buildDraft(
  requestId: string,
  body: Record<string, unknown>,
  plan: ShadowPlan
): Promise<ShadowReceiptDraft | null> {
  const finalTargets = plan.orderedTargets;
  if (!finalTargets.length) return null;
  const profile = analyzeRequestProfile(body);
  const sourceByKey = new Map((plan.sourceCandidates ?? []).map((candidate) => [candidate.executionKey, candidate]));
  const scoreByKey = new Map((plan.scoringFactors ?? []).map((entry) => [entry.executionKey, entry]));
  const connectionRows = await getCachedProviderConnections({ isActive: true });
  const connectionById = new Map(connectionRows.map((row) => [String((row as Record<string, unknown>).id ?? ""), row as Record<string, unknown>]));
  const candidates = finalTargets.map((target, index) => {
    const candidate = makeCandidate(target, sourceByKey.get(target.executionKey));
    const score = scoreByKey.get(target.executionKey);
    const connectionId = candidate.connectionId ?? target.connectionId ?? undefined;
    const economic = resolveModelEconomics(candidate.provider, candidate.model, candidate as never);
    const connection = connectionId ? connectionById.get(connectionId) : undefined;
    const billing = classifyConnectionBilling({
      provider: typeof connection?.provider === "string" ? connection.provider : candidate.provider,
      connectionId: connectionId ?? null,
      authType: typeof connection?.authType === "string" ? connection.authType : null,
    });
    const modelPriceClass = economic.priceClass;
    const effectiveEconomicClass = modelPriceClass === "free"
      ? "free"
      : billing.billing === "subscription"
        ? "subscription"
        : billing.billing === "metered"
          ? "paid"
        : "unknown";
    return {
      ...candidate,
      currentAutoScore: score?.score ?? null,
      currentFactors: score?.factors ?? null,
      currentRankSource: score ? "auto_score" : "fallback_tail",
      fallbackTailIndex: score ? undefined : index + 1,
      toolCalling: supportsToolCalling(candidate.modelStr),
      contextLimit: getModelContextLimitForModelString(candidate.modelStr),
      economicClass: effectiveEconomicClass,
      economicClassSource: `${economic.source}: ${economic.reason}; connection billing=${billing.billing}`,
      modelPriceClass,
      connectionBillingClass: billing.billing,
      variantClass: modelPriceClass === "free" ? "free" : "unknown",
      economicMetadataAuthoritative: economic.authoritative,
      economicMetadataSource: economic.source,
      economicConfidence: economic.authoritative ? "known" : "unknown",
    } as unknown as AutoProviderCandidate;
  });
  const profiles = candidates.map((candidate) => buildModelUtilityProfile(candidate, profile));
  const ranked = rankRequestCandidates(profile, profiles, false);
  const currentByKey = new Map(ranked.currentRanking.map((row) => [row.executionKey, row]));
  const awareByKey = new Map(ranked.awareRanking.map((row) => [row.executionKey, row]));
  const currentFirst = ranked.currentRanking[0];
  const awareFirst = ranked.awareRanking[0];
  const productionTarget = finalTargets.find((target) => target.executionKey === currentFirst?.executionKey) ?? finalTargets[0];
  const productionRow = currentByKey.get(productionTarget.executionKey);
  const awareSuggested = awareFirst ? finalTargets.find((target) => target.executionKey === awareFirst.executionKey) : undefined;
  return {
    finalTargets,
    ranking: ranked.currentRanking,
    receipt: {
      requestId,
      timestamp: new Date().toISOString(),
      requestFingerprint: fingerprint(body),
      factoryRole: typeof body.factoryRole === "string" ? body.factoryRole : null,
      requestProfile: {
        role: profile.role,
        tasks: profile.tasks,
        complexity: profile.complexity,
        reasoningNeed: profile.reasoningNeed,
        toolReliabilityNeed: profile.toolReliabilityNeed,
        minimumExpectedUtility: profile.minimumExpectedUtility,
        confidence: profile.confidence,
      },
      production: {
        selectedTarget: null,
        attemptedTargets: [],
        currentRank: productionRow?.currentRank ?? null,
        autoScore: productionRow?.currentAutoScore ?? null,
        rankSource: productionRow?.currentRankSource ?? null,
        fallbackCount: 0,
      },
      aware: {
        suggestedTarget: awareSuggested ? targetLabel(awareSuggested) : null,
        awareScore: awareFirst?.awareScore ?? null,
        top10: ranked.awareRanking.slice(0, 10).map((row) => ({ target: `${row.provider}/${row.model}`, score: row.awareScore, rank: row.awareRank })),
        productionTargetAwareRank: productionRow?.awareRank ?? null,
        suggestedTargetCurrentRank: awareFirst?.currentRank ?? null,
        rankDelta: productionRow?.rankDelta ?? null,
      },
      economics: {
        productionClass: productionRow?.economicClass ?? null,
        awareClass: awareFirst?.economicClass ?? null,
        confidence: typeof (productionRow as unknown as Record<string, unknown> | undefined)?.economicConfidence === "string"
          ? String((productionRow as unknown as Record<string, unknown>).economicConfidence)
          : null,
        source: productionRow?.economicClassSource ?? null,
      },
      outcome: { status: null, success: null, toolSuccess: null, latencyMs: null, retries: null, providerError: null },
    },
  };
}

export function startShadowObservation(
  requestId: string,
  body: Record<string, unknown>,
  plan: ShadowPlan
): void {
  if (!isRankLabShadowEnabled()) return;
  if (pending.has(requestId)) return;
  const work = buildDraft(requestId, body, plan).catch(() => null);
  pending.set(requestId, work);
  void work.then((draft) => {
    if (!draft) return;
    if (receipts.length >= MAX_RECEIPTS) receipts.shift();
    receipts.push(draft.receipt);
  });
}

export async function finishShadowObservation(requestId: string, status: number | null): Promise<void> {
  const work = pending.get(requestId);
  if (!work) return;
  pending.delete(requestId);
  const draft = await work;
  if (!draft) return;
  const trace = getComboTrace(requestId);
  const dispatched = trace?.decisions.filter((entry) => entry.decision === "dispatched") ?? [];
  const selected = dispatched[dispatched.length - 1]?.step ?? null;
  const receipt = receipts.find((entry) => entry.requestId === requestId);
  if (!receipt) return;
  receipt.production.selectedTarget = selected;
  receipt.production.attemptedTargets = dispatched.map((entry) => entry.step);
  receipt.production.fallbackCount = Math.max(0, dispatched.length - 1);
  const selectedRow = draft.ranking.find((row) => row.executionKey === selected);
  receipt.production.currentRank = selectedRow?.currentRank ?? receipt.production.currentRank;
  receipt.production.autoScore = selectedRow?.currentAutoScore ?? receipt.production.autoScore;
  receipt.production.rankSource = selectedRow?.currentRankSource ?? receipt.production.rankSource;
  receipt.outcome.status = status;
  receipt.outcome.success = status !== null ? status >= 200 && status < 400 : null;
  receipt.outcome.retries = receipt.production.fallbackCount;
  receipt.outcome.providerError = status !== null ? status >= 400 : null;
}

export function getShadowObservations(): ShadowReceipt[] {
  return receipts.map((receipt) => ({ ...receipt, production: { ...receipt.production, attemptedTargets: [...receipt.production.attemptedTargets] }, aware: { ...receipt.aware, top10: [...receipt.aware.top10] } }));
}

export function resetShadowObservations(): void {
  pending.clear();
  receipts.length = 0;
}
