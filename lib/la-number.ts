/**
 * Canonical normalization for LA job numbers stored in invoice_data.la_number.
 * Accepts "72813", "LA#72813", "LA #72813", etc. and always stores bare
 * digits/alnum with no "LA#" prefix, so downstream formatters (which add
 * their own "LA #" / "LA#" prefix) never end up duplicating it.
 */
export function normalizeLaNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const clean = raw.trim().replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
  return clean || null;
}
