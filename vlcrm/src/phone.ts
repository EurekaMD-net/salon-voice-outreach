/**
 * Minimal phone normalization for use as a dedup key. We do NOT guess a country
 * code — callers should pass E.164 ("+52155…"). This only strips formatting
 * (spaces, dashes, parens) and collapses to `+` plus digits, so the same number
 * typed two ways maps to one account_key.
 */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits === "") return null;
  return hasPlus ? `+${digits}` : digits;
}
