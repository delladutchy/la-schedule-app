export const INVOICE_LINE_ITEM_KEYS = [
  "day_rate",
  "ot",
  "per_diem",
  "bag_fees",
  "parking",
  "uber",
  "tolls",
  "hotel",
  "other",
] as const;

export type InvoiceLineItemKey = (typeof INVOICE_LINE_ITEM_KEYS)[number];

export interface InvoiceLineItemOverride {
  qty?: number;
  rate?: number;
  amount?: number;
}

export type InvoiceLineItemOverrides = Partial<Record<InvoiceLineItemKey, InvoiceLineItemOverride>>;

const INVOICE_LINE_ITEM_KEY_SET = new Set<string>(INVOICE_LINE_ITEM_KEYS);

export function isInvoiceLineItemKey(value: string): value is InvoiceLineItemKey {
  return INVOICE_LINE_ITEM_KEY_SET.has(value);
}

function coerceNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100) / 100;
}

export function sanitizeInvoiceLineItemOverrides(value: unknown): InvoiceLineItemOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const overrides: InvoiceLineItemOverrides = {};
  for (const [rawKey, rawLine] of Object.entries(value as Record<string, unknown>)) {
    if (!isInvoiceLineItemKey(rawKey)) continue;
    if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) continue;

    const line = rawLine as Record<string, unknown>;
    const sanitizedLine: InvoiceLineItemOverride = {};
    const qty = coerceNonNegativeNumber(line.qty);
    const rate = coerceNonNegativeNumber(line.rate);
    const amount = coerceNonNegativeNumber(line.amount);

    if (qty != null) sanitizedLine.qty = qty;
    if (rate != null) sanitizedLine.rate = rate;
    if (amount != null) sanitizedLine.amount = amount;

    if (Object.keys(sanitizedLine).length > 0) {
      overrides[rawKey] = sanitizedLine;
    }
  }

  return overrides;
}

export function hasInvoiceLineItemOverride(
  overrides: InvoiceLineItemOverrides | null | undefined,
  key: InvoiceLineItemKey,
): boolean {
  const line = overrides?.[key];
  return !!line && (
    line.qty != null
    || line.rate != null
    || line.amount != null
  );
}

export function countInvoiceLineItemOverrides(overrides: InvoiceLineItemOverrides | null | undefined): number {
  if (!overrides) return 0;
  return INVOICE_LINE_ITEM_KEYS.filter((key) => hasInvoiceLineItemOverride(overrides, key)).length;
}

export function removeInvoiceLineItemOverride(
  overrides: InvoiceLineItemOverrides,
  key: InvoiceLineItemKey,
): InvoiceLineItemOverrides {
  const next = { ...overrides };
  delete next[key];
  return next;
}
