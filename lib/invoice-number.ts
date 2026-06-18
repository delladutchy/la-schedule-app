/**
 * Stable invoice number generation.
 *
 * Rules:
 *  1. If the invoice already has an invoice_number, always reuse it — never
 *     generate a new one for the same job.
 *  2. Prefer: JU-{LA#} when a LA job number is known.
 *  3. Fallback: JU-{YYYYMMDD} using the first work date (or today).
 *
 * "JU" = Jeff Ulsh. Format is recognizable, collision-resistant within a
 * single-user system, and matches how LA job numbers are referenced on sheets.
 *
 * Pure functions — no I/O, fully testable.
 */

/** Sanitize a raw LA number for use in an invoice number. */
function sanitizeLaNumber(raw: string): string {
  // Remove characters that are unsafe in URLs/filenames; preserve alphanumeric, hyphens, dots.
  return raw.trim().replace(/[^a-zA-Z0-9.\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Format a YYYY-MM-DD date string as YYYYMMDD for the fallback format. */
function dateToCompact(isoDate: string): string {
  return isoDate.replace(/-/g, "").slice(0, 8);
}

/**
 * Generate (or preserve) a stable invoice number.
 *
 * @param existing  The invoice_number already stored in the database (if any).
 * @param laNumber  The LA job number from the invoice data (if any).
 * @param workDates Array of YYYY-MM-DD work dates for this job.
 */
export function resolveInvoiceNumber(
  existing: string | null | undefined,
  laNumber: string | null | undefined,
  workDates: string[],
): string {
  // Never regenerate if one already exists.
  if (existing?.trim()) return existing.trim();

  if (laNumber?.trim()) {
    const safe = sanitizeLaNumber(laNumber);
    if (safe) return `JU-${safe}`;
  }

  // Fallback: use first work date.
  const firstDate = workDates.find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (firstDate) return `JU-${dateToCompact(firstDate)}`;

  // Last resort: today.
  return `JU-${dateToCompact(new Date().toISOString().slice(0, 10))}`;
}
