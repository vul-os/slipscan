// Minimal RFC-4180 escaping. Wraps a value in quotes if it contains a
// comma, quote, or newline; doubles internal quotes.
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const HEADERS = [
  "id",
  "merchant",
  "transaction_date",
  "amount",
  "currency",
  "tax",
  "payment_method",
  "category",
  "status",
  "notes",
  "uploaded_at",
];

export function documentsToCSV(docs) {
  const rows = [HEADERS.join(",")];
  for (const d of docs) {
    rows.push([
      d.id,
      d.merchant ?? "",
      d.transaction_date ?? "",
      d.amount ?? "",
      d.currency ?? "",
      d.tax ?? "",
      d.payment_method ?? "",
      d.category ?? "",
      d.status,
      d.notes ?? "",
      d.created_at,
    ].map(csvCell).join(","));
  }
  return rows.join("\n");
}

export function downloadCSV(filename, csv) {
  // BOM so Excel opens UTF-8 correctly without the user picking an encoding.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
