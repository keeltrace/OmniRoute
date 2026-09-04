const PROVIDER_ALIAS_GROUPS: Record<string, readonly string[]> = {
  "nous-research": ["nous", "nousresearch", "nous_research", "nous-research"],
  wandb: ["wandb", "weights-and-biases", "weights_biases", "wandb-inference"],
  groq: ["groq"],
  openrouter: ["openrouter", "open-router"],
  xai: ["xai", "x-ai", "x.ai"],
  "grok-cli": ["grok-cli", "grok_cli"],
};

function normalizeAliasToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-");
}

const PROVIDER_ALIAS_LOOKUP = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(PROVIDER_ALIAS_GROUPS)) {
  PROVIDER_ALIAS_LOOKUP.set(normalizeAliasToken(canonical), canonical);
  for (const alias of aliases) PROVIDER_ALIAS_LOOKUP.set(normalizeAliasToken(alias), canonical);
}

/**
 * Canonicalize provider identity without collapsing distinct provider offerings.
 * For example, xAI and grok-cli remain separate because the same Grok model can
 * have different entitlement/cost semantics depending on the serving provider.
 */
export function normalizeProviderId(providerId: string): string {
  const token = normalizeAliasToken(providerId);
  return PROVIDER_ALIAS_LOOKUP.get(token) ?? token;
}

/** Model normalization intentionally stays conservative. Provider adapters may
 * register aliases, but model identity is never globally collapsed by family. */
export function normalizeModelId(modelId: string): string {
  return modelId.trim();
}

export function providerAliasesFor(providerId: string): string[] {
  const canonical = normalizeProviderId(providerId);
  const aliases = PROVIDER_ALIAS_GROUPS[canonical] ?? [canonical];
  return Array.from(new Set([canonical, ...aliases].map(normalizeAliasToken)));
}

export function providerIdsEqual(a: string, b: string): boolean {
  return normalizeProviderId(a) === normalizeProviderId(b);
}
