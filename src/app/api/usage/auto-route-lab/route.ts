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
import { planAutoRequest } from "@omniroute/open-sse/services/combo/resolveAutoStrategy.ts";
import { parseAutoConfig } from "@omniroute/open-sse/services/combo/autoConfig.ts";
import { resolveComboTargets, getModelContextLimitForModelString } from "@omniroute/open-sse/services/combo/comboStructure.ts";
import { supportsToolCalling } from "@omniroute/open-sse/services/modelCapabilities.ts";
import { DEFAULT_WEIGHTS } from "@omniroute/open-sse/services/autoCombo/scoring.ts";
import { classifyTier } from "@omniroute/open-sse/services/tierResolver.ts";
import { classifyConnectionBilling } from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";
import { getCachedProviderConnections } from "@/lib/db/readCache";

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
    const combo = combos.find((entry) => entry.name === (parsed.data.comboName ?? "auto"))
      ?? combos.find((entry) => entry.strategy === "auto");
    if (!combo) return NextResponse.json({ error: "No auto combo is configured" }, { status: 404 });
    const targets = resolveComboTargets(combo, combos);
    const { resetWindowConfig } = parseAutoConfig(combo, targets);
    const evaluation = await planAutoRequest({
      targets, comboName: combo.name, body, taskType: "coding", weights: DEFAULT_WEIGHTS,
      resetWindowConfig, buildAutoCandidates,
    });
    const scores = new Map(evaluation.scoringFactors.map((entry) => [entry.executionKey, entry]));
    const targetByKey = new Map(targets.map((target) => [target.executionKey, target]));
    const connectionRows = await getCachedProviderConnections({ isActive: true });
    const connectionById = new Map(connectionRows.map((row) => {
      const value = row as Record<string, unknown>;
      return [String(value.id ?? ""), value] as const;
    }));
    candidates = evaluation.sourceCandidates.map((candidate) => {
      const target = targetByKey.get(candidate.executionKey);
      const connection = candidate.connectionId ? connectionById.get(candidate.connectionId) : undefined;
      const billing = classifyConnectionBilling({
        provider: candidate.provider,
        connectionId: candidate.connectionId,
        authType: typeof connection?.authType === "string" ? connection.authType : null,
      });
      const tier = classifyTier(candidate.provider, candidate.model);
      const authoritativeEconomicClass = billing.billing === "subscription"
        ? "subscription"
        : billing.billing === "keyless"
          ? "free"
          : billing.billing === "unknown"
            ? "unknown"
            : tier.tier === "free" ? "free" : "paid";
      return {
        ...candidate,
        currentAutoScore: scores.get(candidate.executionKey)?.score,
        currentFactors: scores.get(candidate.executionKey)?.factors,
        toolCalling: target ? supportsToolCalling(target.modelStr) : undefined,
        contextLimit: target ? getModelContextLimitForModelString(target.modelStr) : undefined,
        economicClass: authoritativeEconomicClass,
        economicClassSource: billing.billing === "unknown" ? "unknown connection billing" : `connection billing: ${billing.billing}; model tier: ${tier.tier}`,
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
