/**
 * Numeric invoice number generation.
 *
 * Rules:
 *  1. If `existing` is a non-empty, purely numeric string, reuse it unchanged.
 *  2. Otherwise, scan all known invoice numbers, keep only purely-numeric ones,
 *     find the max, and return max + 1.
 *  3. If no numeric invoice numbers exist yet, start at 1001.
 *
 * LA job numbers are separate references and are never merged into the invoice number.
 *
 * Pure functions — no I/O, fully testable.
 */

const STARTING_NUMBER = 1001;

/** Returns true when the string is a non-empty sequence of digits only. */
export function isNumericInvoiceNumber(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0 && /^\d+$/.test(s.trim());
}

/**
 * Resolve or generate the next invoice number.
 *
 * @param existing        The invoice_number already stored for this job (if any).
 * @param allExistingNums All invoice_number values from the database.
 *                        Non-numeric entries (e.g. old "JU-XXXXXXXX" values) are ignored.
 * @returns A numeric string, e.g. "1001".
 */
export function resolveInvoiceNumber(
  existing: string | null | undefined,
  allExistingNums: string[],
): string {
  // Reuse if already a valid numeric invoice number.
  if (isNumericInvoiceNumber(existing)) return existing!.trim();

  // Find the highest numeric invoice number across all jobs.
  let max = STARTING_NUMBER - 1;
  for (const n of allExistingNums) {
    if (isNumericInvoiceNumber(n)) {
      const num = parseInt(n.trim(), 10);
      if (num > max) max = num;
    }
  }

  return String(max + 1);
}
