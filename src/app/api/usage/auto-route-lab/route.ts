import { NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getCombos } from "@/lib/db/combos";
import {
  analyzeRequestProfile,
  buildModelUtilityProfile,
  rankRequestCandidates,
  type WorkforceRole,
} from "@omniroute/open-sse/services/autoCombo/requestAwareRankLab.ts";
import type { AutoProviderCandidate } from "@omniroute/open-sse/services/combo/types.ts";
import { buildAutoCandidates } from "@omniroute/open-sse/services/combo.ts";
import { planAutoRequestWithPipeline } from "@omniroute/open-sse/services/combo/targetResolution.ts";
import { resolveComboSetupConfig } from "@omniroute/open-sse/services/comboConfig.ts";
import { resolveResilienceSettings } from "@/lib/resilience/settings";
import { resolveComboTargets, getModelContextLimitForModelString } from "@omniroute/open-sse/services/combo/comboStructure.ts";
import { supportsToolCalling } from "@omniroute/open-sse/services/modelCapabilities.ts";
import { parseModel } from "@omniroute/open-sse/services/model.ts";
import { classifyTier } from "@omniroute/open-sse/services/tierResolver.ts";
import { classifyConnectionBilling } from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";
import { resolveModelEconomics } from "@omniroute/open-sse/services/autoCombo/modelEconomics.ts";
import { getCachedProviderConnections } from "@/lib/db/readCache";
import { createVirtualAutoCombo } from "@omniroute/open-sse/services/autoCombo/virtualFactory.ts";
import { getShadowObservations } from "@omniroute/open-sse/services/autoCombo/shadowObservation.ts";

const candidateSchema = z.object({
  executionKey: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  connectionId: z.string().optional(), currentAutoScore: z.number().finite().optional(),
  costPer1MTokens: z.number().finite().nonnegative().optional(),
  quotaRemaining: z.number().finite().optional(), p95LatencyMs: z.number().finite().optional(),
  latencyStdDev: z.number().finite().optional(), errorRate: z.number().finite().optional(),
  failureRate: z.number().finite().optional(), quality: z.number().finite().optional(),
  circuitBreakerState: z.enum(["CLOSED", "OPEN", "HALF_OPEN"]).optional(),
  toolCalling: z.boolean().optional(), contextLimit: z.number().finite().positive().optional(),
  maxOutputTokens: z.number().finite().positive().optional(), economicClass: z.enum(["free", "included", "subscription", "paid", "unknown"]).optional(), economicClassSource: z.string().max(160).optional(),
});

const schema = z.object({
  messages: z.array(z.unknown()).default([]), tools: z.array(z.unknown()).optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  roleHint: z.enum(["orchestrator", "specialist", "worker", "micro"]).optional(),
  candidates: z.array(candidateSchema).min(1).max(5000).optional(),
  comboName: z.string().trim().min(1).max(128).optional(),
});

function sanitizeConnectionId(value: string | undefined): string | undefined {
  return value ? `conn:${createHash("sha256").update(value).digest("hex").slice(0, 12)}` : undefined;
}

function toCandidate(input: z.infer<typeof candidateSchema>): AutoProviderCandidate {
  return {
    stepId: input.executionKey, executionKey: input.executionKey, modelStr: `${input.provider}/${input.model}`,
    provider: input.provider, model: input.model, connectionId: input.connectionId,
    quotaRemaining: input.quotaRemaining ?? 100, quotaTotal: 100,
    circuitBreakerState: input.circuitBreakerState ?? "CLOSED", costPer1MTokens: input.costPer1MTokens ?? 1,
    p95LatencyMs: input.p95LatencyMs ?? 500, latencyStdDev: input.latencyStdDev ?? 50,
    errorRate: input.errorRate ?? 0.05, accountTier: "standard", quotaResetIntervalSecs: 86400,
    contextAffinity: 0.5, sessionAvailability: 1, resetWindowAffinity: 0.5,
    connectionPoolSize: 1, quality: input.quality, failureRate: input.failureRate,
    ...(input.currentAutoScore === undefined ? {} : { currentAutoScore: input.currentAutoScore }),
    ...(input.toolCalling === undefined ? {} : { toolCalling: input.toolCalling }),
    ...(input.contextLimit === undefined ? {} : { contextLimit: input.contextLimit }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    ...(input.economicClass === undefined ? {} : { economicClass: input.economicClass }),
    ...(input.economicClassSource === undefined ? {} : { economicClassSource: input.economicClassSource }),
  } as unknown as AutoProviderCandidate;
}

export async function POST(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid rank-lab request" }, { status: 400 });
  const started = Date.now();
  const body = parsed.data as Record<string, unknown>;
  const profile = analyzeRequestProfile(body);
  let candidates: AutoProviderCandidate[];
  if (parsed.data.candidates) {
    candidates = parsed.data.candidates.map(toCandidate);
  } else {
    const combos = await getCombos();
    const requestedCombo = parsed.data.comboName ?? "auto";
    const persistedCombo = combos.find((entry) => entry.name === requestedCombo)
      ?? combos.find((entry) => entry.strategy === "auto");
    const builtinName = requestedCombo.replace(/^auto\//, "");
    const combo = persistedCombo ?? (requestedCombo === "auto" || requestedCombo.startsWith("auto/")
      ? await createVirtualAutoCombo((builtinName === "auto" ? undefined : builtinName) as never)
      : undefined);
    if (!combo) return NextResponse.json({ error: "No auto combo is configured" }, { status: 404 });
    const targets = resolveComboTargets(combo, combos);
    const config = resolveComboSetupConfig(combo, null);
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    const evaluation = await planAutoRequestWithPipeline({
      body,
      combo,
      strategy: "auto",
      config,
      settings: null,
      allCombos: combos,
      apiKeyAllowedConnections: null,
      log,
      resilienceSettings: resolveResilienceSettings(null),
      buildAutoCandidates,
      // Rank Lab is structurally planning-only; this callback is never reachable.
      handleSingleModelWithTimeout: async () => { throw new Error("RANK_LAB_DISPATCH_BUG"); },
      readOnlyPlan: true,
    });
    if ("earlyResponse" in evaluation) return evaluation.earlyResponse;
    const scores = new Map(evaluation.scoringFactors.map((entry) => [entry.executionKey, entry]));
    const connectionRows = await getCachedProviderConnections({ isActive: true });
    const connectionById = new Map(connectionRows.map((row) => {
      const value = row as Record<string, unknown>;
      return [String(value.id ?? ""), value] as const;
    }));
    const scoredKeys = new Set(evaluation.scoringFactors.map((entry) => entry.executionKey));
    const candidateByKey = new Map(evaluation.sourceCandidates.map((candidate) => [candidate.executionKey, candidate]));
    candidates = evaluation.orderedTargets.map((finalTarget, index) => {
      const parsedTarget = parseModel(finalTarget.modelStr);
      const existing = candidateByKey.get(finalTarget.executionKey);
      const candidate = existing ?? {
        stepId: finalTarget.stepId,
        executionKey: finalTarget.executionKey,
        modelStr: finalTarget.modelStr,
        provider: finalTarget.provider || parsedTarget.provider || "unknown",
        model: parsedTarget.model || finalTarget.modelStr,
        connectionId: finalTarget.connectionId ?? undefined,
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
      const connection = candidate.connectionId ? connectionById.get(candidate.connectionId) : undefined;
      const billing = classifyConnectionBilling({
        // The concrete connection row is authoritative. Provider aliases in a
        // virtual target must not prevent the billing join by stable ID.
        provider: typeof connection?.provider === "string" ? connection.provider : candidate.provider,
        connectionId: candidate.connectionId,
        authType: typeof connection?.authType === "string" ? connection.authType : null,
      });
      const tier = classifyTier(candidate.provider, candidate.model);
      const economic = resolveModelEconomics(candidate.provider, candidate.model, candidate as never);
      const modelPriceClass = economic.priceClass;
      const variantClass = economic.priceClass === "free" ? "free" : "unknown";
      const authoritativeEconomicClass = modelPriceClass === "free"
        ? "free"
        : billing.billing === "subscription"
          ? "subscription"
          : billing.billing === "included"
            ? "included"
            : billing.billing === "paid"
              ? "paid"
              : "unknown";
      return {
        ...candidate,
        currentAutoScore: scores.get(candidate.executionKey)?.score ?? null,
        currentFactors: scores.get(candidate.executionKey)?.factors ?? null,
        currentRankSource: scoredKeys.has(candidate.executionKey) ? "auto_score" : "fallback_tail",
        ...(scoredKeys.has(candidate.executionKey) ? {} : { fallbackTailIndex: index + 1 }),
        toolCalling: supportsToolCalling(finalTarget.modelStr),
        contextLimit: getModelContextLimitForModelString(finalTarget.modelStr),
        economicClass: authoritativeEconomicClass,
        economicClassSource: `${economic.source}: ${economic.reason}; connection billing=${billing.billing}; tier=${tier.tier}`,
        modelPriceClass,
        connectionBillingClass: billing.billing,
        variantClass,
        economicMetadataAuthoritative: economic.authoritative,
        economicMetadataSource: economic.source,
        economicConfidence: economic.authoritative ? "known" : "unknown",
      } as unknown as AutoProviderCandidate;
    });
  }
  const profiles = candidates.map((candidate) => buildModelUtilityProfile(candidate, profile));
  const result = rankRequestCandidates(profile, profiles);
  const sanitize = (row: (typeof result.currentRanking)[number]) => ({ ...row, connectionIdSanitized: sanitizeConnectionId(row.connectionId), connectionId: undefined });
  return NextResponse.json({
    ...result,
    requestProfile: { ...result.requestProfile, roleHint: parsed.data.roleHint as WorkforceRole | undefined },
    currentRanking: result.currentRanking.map(sanitize), awareRanking: result.awareRanking.map(sanitize), rankingDiff: result.rankingDiff.map(sanitize),
    allCandidates: result.allCandidates.map(sanitize), biggestRisers: result.biggestRisers.map(sanitize), biggestFallers: result.biggestFallers.map(sanitize),
    topCurrent: result.topCurrent ? sanitize(result.topCurrent) : null, topAware: result.topAware ? sanitize(result.topAware) : null,
    diagnostics: { ...result.diagnostics, dispatches: 0, mutation: false, durationMs: Date.now() - started },
  });
}

/** Read-only dark-launch receipts. No request body or credential material is stored here. */
export async function GET(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const observations = getShadowObservations();
  return NextResponse.json({ count: observations.length, observations });
}
