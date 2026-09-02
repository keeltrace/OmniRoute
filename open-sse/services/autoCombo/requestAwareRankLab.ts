import { classifyPromptIntent } from "../intentClassifier.ts";
import { analyzeSpecificity } from "../specificityDetector.ts";
import { getTaskFitness } from "./taskFitness.ts";
import type { AutoProviderCandidate } from "../combo/types.ts";

export type WorkforceRole = "orchestrator" | "specialist" | "worker" | "micro";
export type RankLabTask =
  | "coding" | "debugging" | "review" | "planning" | "analysis" | "research"
  | "documentation" | "transformation" | "extraction" | "classification"
  | "tool-operation" | "general";
export type EconomicClass = "free" | "included" | "subscription" | "paid" | "unknown";

export interface RequestProfile {
  role: WorkforceRole;
  tasks: RankLabTask[];
  complexity: number;
  reasoningNeed: number;
  toolReliabilityNeed: number;
  instructionPrecision: number;
  factualityNeed: number;
  creativityNeed: number;
  latencySensitivity: number;
  risk: number;
  parallelizability: number;
  contextTokensRequired: number;
  outputTokensExpected: number;
  requiresTools: boolean;
  requiresVision: boolean;
  minimumExpectedUtility: number;
  confidence: number;
  signals: string[];
  roleSignals: string[];
  dimensionSignals: Record<string, string[]>;
  roleHint?: WorkforceRole;
}

export interface ModelUtilityProfile {
  executionKey: string;
  provider: string;
  model: string;
  connectionId?: string;
  taskFit: number;
  reasoningCapability: number | null;
  toolCapability: boolean | null;
  toolReliability: number | null;
  contextLimit: number | null;
  outputLimit: number | null;
  visionCapability: boolean | null;
  quality: number | null;
  reliability: number | null;
  health: number;
  quota: number;
  latencyFit: number;
  stability: number | null;
  economicClass: EconomicClass;
  economicClassSource: string;
  factorSources: Record<string, string>;
  normalizedMarginalCost: number;
  scarcityCost: number;
  currentAutoScore: number | null;
  observedCurrentRank?: number;
  currentFactors: Record<string, number | null>;
  hardEligible: boolean;
  exclusionReason?: string;
}

export interface RequestAwareScore {
  rawUtility: number;
  scarcityPenalty: number;
  moneyPenalty: number;
  awareScore: number;
  belowRequirement: boolean;
  factors: Record<string, number>;
  reasons: string[];
}

export interface RankLabRow extends ModelUtilityProfile, RequestAwareScore {
  currentRank: number | null;
  awareRank: number | null;
  rankDelta: number | null;
  whyThisRank: string;
  whyNotHigher: string;
  whyNotLower: string;
}

export interface RankLabResult {
  requestProfile: RequestProfile;
  candidateCount: number;
  candidateUniverseCount: number;
  hardEligibleCount: number;
  currentRanking: RankLabRow[];
  awareRanking: RankLabRow[];
  rankingDiff: RankLabRow[];
  allCandidates: RankLabRow[];
  biggestRisers: RankLabRow[];
  biggestFallers: RankLabRow[];
  economicSummary: Record<EconomicClass, { count: number; eligible: number; averageAwareScore: number }>;
  topCurrent: RankLabRow | null;
  topAware: RankLabRow | null;
  whyCurrentWinner: string;
  whyAwareWinner: string;
  diagnostics: { dispatches: number; mutation: boolean; durationMs: number };
}

const RAW_WEIGHTS = {
  taskFit: 0.22, reasoningFit: 0.12, toolFit: 0.14, instructionFit: 0.08,
  quality: 0.10, reliability: 0.10, contextFit: 0.08, health: 0.08,
  quota: 0.04, latencyFit: 0.04,
} as const;
const SCARCITY_WEIGHT: Record<WorkforceRole, number> = { micro: 0.30, worker: 0.18, specialist: 0.10, orchestrator: 0.03 };
const MONEY_WEIGHT: Record<WorkforceRole, number> = { micro: 0.22, worker: 0.14, specialist: 0.07, orchestrator: 0.02 };
const HEADROOM: Record<WorkforceRole, number> = { micro: 0.05, worker: 0.08, specialist: 0.10, orchestrator: 0.12 };

const clamp = (v: number, fallback = 0.5): number => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
const knownOr = (v: number | null | undefined, fallback: number): number => v == null ? fallback : clamp(v, fallback);
const textOf = (messages: unknown): string => Array.isArray(messages)
  ? messages.map((m) => typeof m === "object" && m !== null ? String((m as Record<string, unknown>).content ?? "") : String(m ?? "")).join("\n")
  : "";
const bool = (value: unknown): boolean => value === true;

function inferTasks(text: string, requiresTools: boolean): RankLabTask[] {
  const t = text.toLowerCase();
  const tasks: RankLabTask[] = [];
  if (/debug|bug|failure|error|broken|fix/.test(t)) tasks.push("debugging");
  if (/review|audit|critique/.test(t)) tasks.push("review");
  if (/architect|architecture|design|plan|orchestrat/.test(t)) tasks.push("planning");
  if (/research|compare|investigate|sources/.test(t)) tasks.push("research");
  if (/document|readme|explain/.test(t)) tasks.push("documentation");
  if (/extract|classif|categor/.test(t)) tasks.push(t.includes("classif") ? "classification" : "extraction");
  if (/format|rename|convert|transform|rewrite/.test(t)) tasks.push("transformation");
  if (classifyPromptIntent(text) === "code" || /implement|code|function|repository|api/.test(t)) tasks.push("coding");
  if (requiresTools) tasks.push("tool-operation");
  return [...new Set(tasks.length ? tasks : ["general"])] as RankLabTask[];
}

export function analyzeRequestProfile(body: Record<string, unknown>): RequestProfile {
  const text = textOf(body.messages);
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  const requiresVision = text.includes("image") || text.includes("vision") || Boolean(body.images);
  const specificity = analyzeSpecificity({ messages: Array.isArray(body.messages) ? body.messages as never[] : [], tools: Array.isArray(body.tools) ? body.tools as never[] : undefined });
  const complexity = clamp(specificity.score / 100);
  const tasks = inferTasks(text, tools);
  const roleHint = ["orchestrator", "specialist", "worker", "micro"].includes(String(body.roleHint)) ? String(body.roleHint) as WorkforceRole : undefined;
  const microSignal = /rename|format|extract|classif|boilerplate|single line|simple/.test(text.toLowerCase());
  const orchestrationSignal = /architect|architecture|orchestrat|system design|trade.?off|plan a/.test(text.toLowerCase());
  const role = roleHint ?? (orchestrationSignal || complexity >= 0.78 ? "orchestrator" : complexity >= 0.52 || tasks.some((t) => ["debugging", "review", "research"].includes(t)) ? "specialist" : microSignal && !tools ? "micro" : "worker");
  const roleSignals = roleHint
    ? ["operator role hint"]
    : orchestrationSignal || complexity >= 0.78
      ? [orchestrationSignal ? "architectural planning language" : "high inferred complexity"]
      : complexity >= 0.52 || tasks.some((t) => ["debugging", "review", "research"].includes(t))
        ? ["non-trivial specialist task signals"]
        : microSignal && !tools
          ? ["bounded micro-task language", "no tool operation"]
          : ["implementation-shaped request"];
  const dimensionSignals: Record<string, string[]> = {
    complexity: [specificity.score >= 52 ? "specificity/complexity score above worker baseline" : "short or bounded request"],
    reasoningNeed: tasks.includes("planning") ? ["planning task"] : ["no explicit deep-reasoning signal"],
    toolReliabilityNeed: tools ? ["tools supplied by caller"] : ["no tools supplied"],
    instructionPrecision: specificity.rulesTriggered.length ? specificity.rulesTriggered : ["default instruction precision baseline"],
    factualityNeed: tasks.some((t) => ["research", "review"].includes(t)) ? ["research/review task"] : ["general factuality baseline"],
    creativityNeed: /creative|story|idea|brainstorm/.test(text.toLowerCase()) ? ["creative language"] : ["no creative-language signal"],
    latencySensitivity: /quick|fast|immediately|latency/.test(text.toLowerCase()) ? ["explicit speed signal"] : ["no explicit speed signal"],
    risk: tasks.some((t) => ["planning", "review"].includes(t)) ? ["planning/review risk signal"] : ["bounded operational risk"],
    parallelizability: tools ? ["tool sequence is stateful"] : microSignal ? ["bounded transformation"] : ["default parallelism baseline"],
    minimumExpectedUtility: [tools ? "tool requirement raises minimum" : "complexity-derived minimum"],
  };
  const output = Number(body.max_tokens ?? body.max_completion_tokens ?? 1024);
  const contextTokensRequired = Math.max(1, specificity.inputTokens, Math.ceil(text.length / 4));
  const minimumExpectedUtility = clamp(0.45 + complexity * 0.45 + (tools ? 0.06 : 0));
  return {
    role, roleHint, tasks, complexity,
    reasoningNeed: clamp(complexity * 0.8 + (tasks.includes("planning") ? 0.2 : 0)),
    toolReliabilityNeed: tools ? 0.9 : 0.25,
    instructionPrecision: clamp(0.45 + specificity.score / 180),
    factualityNeed: clamp(0.45 + (tasks.includes("research") || tasks.includes("review") ? 0.3 : 0)),
    creativityNeed: clamp(/creative|story|idea|brainstorm/.test(text.toLowerCase()) ? 0.8 : 0.25),
    latencySensitivity: clamp(/quick|fast|immediately|latency/.test(text.toLowerCase()) ? 0.8 : role === "micro" ? 0.7 : 0.35),
    risk: clamp((tasks.includes("planning") ? 0.35 : 0) + (tasks.includes("review") ? 0.2 : 0) + complexity * 0.5),
    parallelizability: clamp(tools ? 0.25 : role === "micro" ? 0.85 : 0.5),
    contextTokensRequired, outputTokensExpected: Number.isFinite(output) && output > 0 ? Math.ceil(output) : 1024,
    requiresTools: tools, requiresVision,
    minimumExpectedUtility, confidence: clamp(0.35 + (specificity.confidence ?? 0) * 0.65),
    signals: [...specificity.rulesTriggered, ...tasks.map((t) => `task:${t}`)], roleSignals, dimensionSignals,
  };
}

function economicClass(provider: string, model: string, cost: number, explicit?: unknown): EconomicClass {
  if (explicit === "free" || explicit === "included" || explicit === "subscription" || explicit === "paid" || explicit === "unknown") return explicit;
  // Production callers provide an authoritative connection/model classification.
  // A zero catalog price is also authoritative; names are never used as a proxy.
  if (cost === 0) return "free";
  return "unknown";
}

export function buildModelUtilityProfile(candidate: AutoProviderCandidate, request: RequestProfile): ModelUtilityProfile {
  const cost = Number(candidate.costPer1MTokens);
  const tool = typeof (candidate as unknown as Record<string, unknown>).toolCalling === "boolean" ? Boolean((candidate as unknown as Record<string, unknown>).toolCalling) : null;
  const context = Number((candidate as unknown as Record<string, unknown>).contextLimit ?? (candidate as unknown as Record<string, unknown>).contextWindow);
  const output = Number((candidate as unknown as Record<string, unknown>).maxOutputTokens);
  const tier = economicClass(candidate.provider, candidate.model, Number.isFinite(cost) ? cost : 1, (candidate as unknown as Record<string, unknown>).economicClass);
  return {
    executionKey: candidate.executionKey, provider: candidate.provider, model: candidate.model,
    connectionId: candidate.connectionId, taskFit: clamp(getTaskFitness(candidate.model, request.tasks[0] ?? "general")),
    reasoningCapability: /reason|o[134]|thinking|opus|gpt-5|codex/i.test(candidate.model) ? 0.85 : null,
    toolCapability: tool, toolReliability: tool === true ? 0.7 : tool === false ? 0 : null,
    contextLimit: Number.isFinite(context) && context > 0 ? context : null,
    outputLimit: Number.isFinite(output) && output > 0 ? output : null,
    visionCapability: /vision|gemini|claude|gpt/i.test(candidate.model) ? true : null,
    quality: typeof candidate.quality === "number" ? candidate.quality : null,
    reliability: typeof candidate.failureRate === "number" ? clamp(1 - candidate.failureRate) : typeof candidate.errorRate === "number" ? clamp(1 - candidate.errorRate) : null,
    health: candidate.circuitBreakerState === "OPEN" ? 0 : candidate.circuitBreakerState === "HALF_OPEN" ? 0.5 : 1,
    quota: clamp(Number(candidate.quotaRemaining) / 100), latencyFit: clamp(1 - Number(candidate.p95LatencyMs ?? 1000) / 2000),
    stability: Number.isFinite(Number(candidate.latencyStdDev)) ? clamp(1 - Number(candidate.latencyStdDev) / 1000) : null,
    economicClass: tier, economicClassSource: String((candidate as unknown as Record<string, unknown>).economicClassSource ?? (tier === "unknown" ? "unknown" : "candidate pricing/tier metadata")),
    factorSources: { taskFit: "taskFitness/model metadata", reasoningCapability: "model metadata or neutral", toolCapability: "model capabilities", contextLimit: "model capabilities", quality: "routing telemetry or neutral", reliability: "failure telemetry or neutral", health: "breaker state", quota: "quota state", latencyFit: "latency telemetry or neutral" },
    normalizedMarginalCost: clamp((Number.isFinite(cost) ? cost : 1) / 10),
    scarcityCost: tier === "free" ? 0.05 : tier === "subscription" || tier === "included" ? 0.55 : tier === "paid" ? 0.75 : 0.4,
    currentAutoScore: typeof (candidate as unknown as Record<string, unknown>).currentAutoScore === "number"
      ? Number((candidate as unknown as Record<string, unknown>).currentAutoScore) : null,
    observedCurrentRank: typeof (candidate as unknown as Record<string, unknown>).observedCurrentRank === "number"
      ? Number((candidate as unknown as Record<string, unknown>).observedCurrentRank) : undefined,
    currentFactors: ((candidate as unknown as Record<string, unknown>).currentFactors as Record<string, number | null> | undefined) ?? {}, hardEligible: true,
  };
}

export function scoreRequestUtility(request: RequestProfile, model: ModelUtilityProfile): RequestAwareScore {
  const contextFit = model.contextLimit == null ? 0.5 : clamp(model.contextLimit >= request.contextTokensRequired ? 1 : model.contextLimit / request.contextTokensRequired);
  const outputFit = model.outputLimit == null ? 0.5 : clamp(model.outputLimit >= request.outputTokensExpected ? 1 : model.outputLimit / request.outputTokensExpected);
  const toolFit = request.requiresTools ? (model.toolCapability === true ? knownOr(model.toolReliability, 0.7) : 0) : 1;
  const reasoningFit = model.reasoningCapability == null ? 0.5 : model.reasoningCapability;
  const factors = { taskFit: model.taskFit, reasoningFit, toolFit, instructionFit: clamp(0.5 + model.taskFit * 0.5), quality: knownOr(model.quality, 0.5), reliability: knownOr(model.reliability, 1), contextFit: contextFit * outputFit, health: model.health, quota: model.quota, latencyFit: model.latencyFit };
  const rawUtility = Object.entries(RAW_WEIGHTS).reduce((sum, [key, weight]) => sum + factors[key as keyof typeof factors] * weight, 0);
  const surplus = Math.max(0, rawUtility - request.minimumExpectedUtility);
  const overqualification = Math.max(0, surplus - HEADROOM[request.role]);
  const scarcityPenalty = SCARCITY_WEIGHT[request.role] * model.scarcityCost * overqualification;
  const moneyPenalty = MONEY_WEIGHT[request.role] * model.normalizedMarginalCost;
  const awareScore = rawUtility - scarcityPenalty - moneyPenalty;
  const reasons = [`${request.role} request`, `raw utility ${rawUtility.toFixed(3)}`, model.economicClass, model.hardEligible ? "eligible" : model.exclusionReason ?? "excluded"];
  if (request.requiresTools && model.toolCapability !== true) reasons.push("tools unsupported");
  if (model.contextLimit != null && model.contextLimit < request.contextTokensRequired) reasons.push("insufficient context");
  if (overqualification > 0) reasons.push(`overqualification penalty ${scarcityPenalty.toFixed(3)}`);
  return { rawUtility, scarcityPenalty, moneyPenalty, awareScore, belowRequirement: rawUtility < request.minimumExpectedUtility, factors, reasons };
}

export function rankRequestCandidates(request: RequestProfile, candidates: ModelUtilityProfile[]): RankLabResult {
  const started = Date.now();
  const evaluated = candidates.map((candidate) => {
    const hardReason = request.requiresTools && candidate.toolCapability !== true ? "tools unsupported" : request.requiresVision && candidate.visionCapability !== true ? "vision unsupported" : candidate.contextLimit != null && candidate.contextLimit < request.contextTokensRequired ? "insufficient context" : undefined;
    const model = { ...candidate, hardEligible: !hardReason, exclusionReason: hardReason };
    const score = scoreRequestUtility(request, model);
    return { ...model, ...score, currentRank: null, awareRank: null, rankDelta: null, whyThisRank: "", whyNotHigher: "", whyNotLower: "" } as RankLabRow;
  });
  const current = [...evaluated].sort((a, b) => {
    if (a.currentAutoScore == null && b.currentAutoScore == null && a.observedCurrentRank != null && b.observedCurrentRank != null) {
      return a.observedCurrentRank - b.observedCurrentRank;
    }
    return (b.currentAutoScore ?? 0) - (a.currentAutoScore ?? 0) || a.executionKey.localeCompare(b.executionKey);
  });
  const aware = [...evaluated].sort((a, b) => Number(b.hardEligible) - Number(a.hardEligible) || Number(a.belowRequirement) - Number(b.belowRequirement) || b.awareScore - a.awareScore || a.executionKey.localeCompare(b.executionKey));
  current.forEach((row, i) => { row.currentRank = i + 1; });
  aware.forEach((row, i) => { row.awareRank = i + 1; });
  const byKey = new Map(aware.map((row) => [row.executionKey, row]));
  for (const row of current) {
    const target = byKey.get(row.executionKey)!;
    row.rankDelta = (row.currentRank ?? 0) - (target.awareRank ?? 0);
    row.whyThisRank = target.hardEligible ? `Ranked ${target.awareRank} for ${request.role}: ${target.reasons.join(", ")}.` : `Hard excluded: ${target.exclusionReason}.`;
    row.whyNotHigher = target.belowRequirement ? "Below the request utility threshold." : "A higher-ranked eligible candidate has better request utility after economic adjustment.";
    row.whyNotLower = target.hardEligible ? "Clears hard requirements and remains reachable." : "Hard requirements prevent selection.";
  }
  const topCurrent = current[0] ?? null;
  const topAware = aware[0] ?? null;
  const rankingDiff = [...current].sort((a, b) => Math.abs(b.rankDelta ?? 0) - Math.abs(a.rankDelta ?? 0) || a.executionKey.localeCompare(b.executionKey));
  const biggestRisers = rankingDiff.filter((row) => (row.rankDelta ?? 0) > 0).slice(0, 10);
  const biggestFallers = rankingDiff.filter((row) => (row.rankDelta ?? 0) < 0).slice(0, 10);
  const economicSummary = (Object.keys({ free: 0, included: 0, subscription: 0, paid: 0, unknown: 0 }) as EconomicClass[]).reduce((summary, economicClass) => {
    const rows = evaluated.filter((row) => row.economicClass === economicClass);
    summary[economicClass] = {
      count: rows.length,
      eligible: rows.filter((row) => row.hardEligible).length,
      averageAwareScore: rows.length ? rows.reduce((sum, row) => sum + row.awareScore, 0) / rows.length : 0,
    };
    return summary;
  }, {} as Record<EconomicClass, { count: number; eligible: number; averageAwareScore: number }>);
  return {
    requestProfile: request, candidateCount: candidates.length, candidateUniverseCount: candidates.length,
    hardEligibleCount: aware.filter((r) => r.hardEligible).length,
    currentRanking: current, awareRanking: aware, rankingDiff, allCandidates: evaluated,
    biggestRisers, biggestFallers, economicSummary, topCurrent, topAware,
    whyCurrentWinner: topCurrent ? `Current #1 is ${topCurrent.provider}/${topCurrent.model}; the production score is ${topCurrent.currentAutoScore ?? "unknown"}.` : "No current winner.",
    whyAwareWinner: topAware ? `Aware #1 is ${topAware.provider}/${topAware.model}; it clears the request requirements with utility ${topAware.awareScore.toFixed(3)}.` : "No aware winner.",
    diagnostics: { dispatches: 0, mutation: false, durationMs: Date.now() - started },
  };
}
