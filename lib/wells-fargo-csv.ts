import { createHash } from "node:crypto";
import type { BankTransactionImport } from "./bank-reconciliation";

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index++) {
    const char = csv[index]!;
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (quoted) throw new Error("Unterminated quoted field in Wells Fargo CSV");
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!match) throw new Error(`Invalid Wells Fargo posted date: ${value}`);
  return `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

function normalizeAmount(value: string): number {
  const trimmed = value.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  const numeric = Number(trimmed.replace(/[,$()\s]/g, ""));
  if (!Number.isFinite(numeric)) throw new Error(`Invalid Wells Fargo amount: ${value}`);
  return Math.round((negative ? -numeric : numeric) * 100) / 100;
}

function stableId(parts: string[]): string {
  return `wf_${createHash("sha256").update(parts.join("\u001f")).digest("hex")}`;
}

/** Parse Wells Fargo's headered or standard five-column CSV export. */
export function parseWellsFargoCsv(
  csv: string,
  sourceAccount: string | null = null,
): BankTransactionImport[] {
  const rows = parseCsvRows(csv);
  if (rows.length === 0) return [];
  const first = rows[0]!;
  const headered = !/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(first[0]?.trim() ?? "");
  const headers = headered ? first.map(normalizeHeader) : [];
  const dataRows = headered ? rows.slice(1) : rows;
  const indexOf = (...names: string[]) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
  const dateIndex = headered ? indexOf("posted_date", "date", "transaction_date") : 0;
  const amountIndex = headered ? indexOf("amount", "transaction_amount") : 1;
  const descriptionIndex = headered ? indexOf("description", "memo", "transaction_description") : 4;
  const idIndex = headered ? indexOf("transaction_id", "reference_number", "reference", "check_number") : 3;
  if (dateIndex < 0 || amountIndex < 0 || descriptionIndex < 0) {
    throw new Error("Wells Fargo CSV must include posted date, amount, and description columns");
  }

  return dataRows.map((cells, rowIndex) => {
    const postedDate = normalizeDate(cells[dateIndex] ?? "");
    const amount = normalizeAmount(cells[amountIndex] ?? "");
    const description = (cells[descriptionIndex] ?? "").trim();
    const rawReference = idIndex >= 0 ? (cells[idIndex] ?? "").trim() : "";
    const externalTransactionId = rawReference || stableId([
      "wells_fargo_csv",
      sourceAccount ?? "",
      postedDate,
      amount.toFixed(2),
      description.replace(/\s+/g, " ").trim(),
    ]);
    const rawMetadata = headered
      ? Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, cells[index] ?? ""]))
      : { row: rowIndex + 1, columns: cells };
    return {
      source: "wells_fargo_csv",
      externalTransactionId,
      postedDate,
      amount,
      description,
      sourceAccount,
      rawMetadata,
    };
  });
}
