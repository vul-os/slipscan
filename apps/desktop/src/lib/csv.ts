/**
 * Tiny CSV builder + download helper — reports are computed locally and the
 * export never touches the network (it is a Blob object-URL download).
 */

function escapeCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) lines.push(row.map(escapeCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Minor units → `842.35` (plain decimal, spreadsheet-friendly). */
export function csvMoney(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
