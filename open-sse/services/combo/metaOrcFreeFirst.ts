/**
 * Meta-Orc free-first availability contract.
 *
 * Unlike STRICT_ZERO_COST, this policy NEVER removes paid rescue capacity.
 * It only partitions the final attempt deck so economically-free targets and
 * free accounts are attempted before billable rescue targets.
 */
import { getSyncedAvailableModelsByConnection } from "@/lib/db/models";
import { classifyTier, resolveExplicitTierOverride } from "../tierResolver.ts";
import type { ResolvedComboTarget } from "./types.ts";

function targetModelId(target: ResolvedComboTarget): string {
  const provider = String(target.provider || target.providerId || "").trim();
  const model = String(target.modelStr || "").trim();
  const prefix = provider ? `${provider}/` : "";
  return prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function targetConnectionIds(target: ResolvedComboTarget): string[] {
  if (target.connectionId) return [target.connectionId];
  if (!Array.isArray(target.allowedConnectionIds)) return [];
  return Array.from(
    new Set(
      target.allowedConnectionIds.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      )
    )
  );
}

type SyncedByProvider = Awaited<ReturnType<typeof getSyncedAvailableModelsByConnection>>;

async function loadSyncedByProvider(
  provider: string,
  cache: Map<string, Promise<SyncedByProvider>>
): Promise<SyncedByProvider> {
  let pending = cache.get(provider);
  if (!pending) {
    pending = getSyncedAvailableModelsByConnection(provider).catch(() => ({}));
    cache.set(provider, pending);
  }
  return pending;
}
function operatorFreeDecision(
  provider: string,
  model: string
): "free" | "forced-paid" | "unspecified" {
  try {
    const override = resolveExplicitTierOverride(provider, model);
    if (override !== undefined) return override === "free" ? "free" : "forced-paid";
  } catch {
    // No operator verdict; continue through discovery/static evidence.
  }
  return "unspecified";
}

function staticModelIsFree(provider: string, model: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  // OpenCode's public Zen catalog encodes the economic contract in the model id.
  // The concrete free lineup rotates, so a hardcoded catalog inevitably goes stale;
  // current/future `*-free` variants remain zero-cost candidates while unavailable
  // variants simply fall through to the next Meta-Orc target on model-scoped 400s.
  if (
    (normalizedProvider === "opencode" || normalizedProvider === "opencode-zen") &&
    normalizedModel.endsWith("-free")
  ) {
    return true;
  }
  try {
    return classifyTier(provider, model).tier === "free";
  } catch {
    return false;
  }
}

function scopedTarget(
  target: ResolvedComboTarget,
  connectionIds: string[],
  scope: "free" | "rescue"
): ResolvedComboTarget {
  return {
    ...target,
    connectionId: null,
    allowedConnectionIds: connectionIds,
    executionKey: `${target.executionKey}|meta-orc-${scope}`,
  };
}

export function splitMetaOrcTargetByFreeConnections(
  target: ResolvedComboTarget,
  freeConnectionIds: readonly string[]
): { free: ResolvedComboTarget[]; rescue: ResolvedComboTarget[] } {
  const connectionIds = targetConnectionIds(target);
  const freeSet = new Set(freeConnectionIds);
  const freeIds = connectionIds.filter((id) => freeSet.has(id));
  if (freeIds.length === 0) return { free: [], rescue: [target] };
  if (freeIds.length === connectionIds.length) return { free: [target], rescue: [] };
  if (target.connectionId) {
    return freeSet.has(target.connectionId)
      ? { free: [target], rescue: [] }
      : { free: [], rescue: [target] };
  }
  const rescueIds = connectionIds.filter((id) => !freeSet.has(id));
  return {
    free: [scopedTarget(target, freeIds, "free")],
    rescue: rescueIds.length ? [scopedTarget(target, rescueIds, "rescue")] : [],
  };
}

/**
 * Stable free-first partition applied AFTER every normal OmniRoute ranking stage.
 * Mixed-account targets are split so a paid sibling account cannot be selected
 * until the same provider/model's proven-free account scope has been attempted.
 */
export async function enforceMetaOrcFreeFirstOrder(
  targets: ResolvedComboTarget[]
): Promise<ResolvedComboTarget[]> {
  if (targets.length < 2 && targets.every((target) => target.connectionId !== null)) return targets;

  const free: ResolvedComboTarget[] = [];
  const rescue: ResolvedComboTarget[] = [];
  const syncedCache = new Map<string, Promise<SyncedByProvider>>();
  for (const target of targets) {
    const provider = String(target.provider || target.providerId || "").trim();
    const model = targetModelId(target);
    const connectionIds = targetConnectionIds(target);
    const operatorDecision = operatorFreeDecision(provider, model);

    if (operatorDecision === "free") {
      free.push(target);
      continue;
    }
    if (operatorDecision === "forced-paid") {
      rescue.push(target);
      continue;
    }
    if (!provider || !model || connectionIds.length === 0) {
      (staticModelIsFree(provider, model) ? free : rescue).push(target);
      continue;
    }

    // Live/synced discovery outranks the static catalog. This matters for Nous:
    // the Portal can move a model between free and paid recommendations while
    // the shipped catalog still carries older free metadata.
    const synced = await loadSyncedByProvider(provider, syncedCache);
    const discoveredIds = connectionIds.filter((connectionId) =>
      (synced[connectionId] || []).some((entry) => entry.id === model)
    );
    const freeIds = connectionIds.filter((connectionId) =>
      (synced[connectionId] || []).some((entry) => entry.id === model && entry.isFree === true)
    );

    if (discoveredIds.length > 0) {
      const split = splitMetaOrcTargetByFreeConnections(target, freeIds);
      free.push(...split.free);
      rescue.push(...split.rescue);
      continue;
    }

    // No discovery verdict: static evidence is a preference only. Paid rescue
    // remains in the deck for every target not classified free here.
    (staticModelIsFree(provider, model) ? free : rescue).push(target);
  }

  return [...free, ...rescue];
}
