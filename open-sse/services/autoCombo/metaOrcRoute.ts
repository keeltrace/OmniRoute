/** Meta-Orc's resilient free-first route identifiers. Dependency-free by design. */
export const META_ORC_AUTO_ID = "auto/meta-orc";
export const META_ORC_CHAT_FREE_ALIAS = "chat:free";
export const META_ORC_AUTO_CHAT_FREE_ALIAS = "auto/chat:free";

export function normalizeMetaOrcAlias(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized === META_ORC_CHAT_FREE_ALIAS || normalized === META_ORC_AUTO_CHAT_FREE_ALIAS
    ? META_ORC_AUTO_ID
    : model;
}

export function isMetaOrcCombo(value: unknown): boolean {
  if (typeof value === "string") return normalizeMetaOrcAlias(value) === META_ORC_AUTO_ID;
  if (!value || typeof value !== "object") return false;
  const record = value as { id?: unknown; name?: unknown };
  return [record.id, record.name].some(
    (entry) => typeof entry === "string" && normalizeMetaOrcAlias(entry) === META_ORC_AUTO_ID
  );
}
