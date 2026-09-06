/**
 * Route-scoped 403 classification for Meta-Orc.
 *
 * A generic 403 is not enough evidence to poison a credential: aggregators use
 * it for per-model entitlement, Cloudflare uses it for fingerprint rejection,
 * and quota gateways use it for allowance exhaustion. Meta-Orc is explicitly
 * availability-first, so only strong credential text may take the auth path.
 */
export type MetaOrc403Scope = "credential" | "quota" | "transport" | "model";

const CREDENTIAL_PATTERNS = [
  /\b(?:invalid|incorrect|expired|missing|revoked)\s+(?:api[\s_-]?key|token|credentials?|bearer)\b/i,
  /\b(?:api[\s_-]?key|token|credentials?|bearer)\s+(?:is\s+)?(?:invalid|incorrect|expired|missing|revoked|not\s+valid)\b/i,
  /\bauthentication[\s_-]+(?:failed|error|required)\b/i,
  /\bunauthorized\b/i,
  /\bnot\s+authenticated\b/i,
];

const QUOTA_PATTERNS = [
  /\b(?:quota|credits?)\s+(?:is\s+)?(?:exhausted|depleted|used\s*up|exceeded)\b/i,
  /\binsufficient\s+(?:balance|credits?|funds|quota)\b/i,
  /\bout\s+of\s+(?:credits?|quota)\b/i,
  /\bbilling\s+(?:limit|cycle|quota)\b/i,
];

const TRANSPORT_PATTERNS = [
  /\b(?:error[_\s-]*code|errorCode)\s*[:=]?\s*1010\b/i,
  /\bcloudflare\b[\s\S]{0,180}\b1010\b/i,
  /\/error-1010\//i,
  /\bbrowser_signature_banned\b/i,
  /\bfingerprint_rejection\b/i,
];

export function classifyMetaOrc403(
  status: number,
  errorText = "",
  structuredError?: { code?: string; type?: string; message?: string } | null
): MetaOrc403Scope | null {
  if (status !== 403) return null;
  const joined = [errorText, structuredError?.code, structuredError?.type, structuredError?.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  if (TRANSPORT_PATTERNS.some((pattern) => pattern.test(joined))) return "transport";
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(joined))) return "credential";
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(joined))) return "quota";
  return "model";
}

/** Meta-Orc never spends three refresh attempts on an ambiguous 403. */
export function shouldAttemptCredentialRefresh(status: number, comboName?: string | null): boolean {
  if (status === 401) return true;
  if (status === 403) return comboName !== "auto/meta-orc";
  return false;
}
