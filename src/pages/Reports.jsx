import { useState, useCallback } from "react";
import { Download, FileBarChart2, AlertTriangle, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardTitle, CardSubtitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useReport, useOrgs } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { api, ApiError } from "@/lib/api";
import { formatMoney, formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

// ── Report catalogue ─────────────────────────────────────────────────────────

const BUSINESS_REPORTS = [
  {
    name: "profit-and-loss",
    label: "Profit & Loss",
    description: "Revenue, expenses and net income over a period.",
  },
  {
    name: "balance-sheet",
    label: "Balance Sheet",
    description: "Assets, liabilities and equity at a point in time.",
  },
  {
    name: "vat-summary",
    label: "VAT Summary",
    description: "Input, output and net VAT for the period.",
  },
];

const PERSONAL_REPORTS = [
  {
    name: "cash-flow",
    label: "Cash Flow",
    description: "Money in, money out and net cash movement.",
  },
  {
    name: "spending-trend",
    label: "Spending Trend",
    description: "Category-level spending patterns over time.",
  },
  {
    name: "net-worth",
    label: "Net Worth",
    description: "Total assets minus total liabilities.",
  },
];

// ── Period helpers ────────────────────────────────────────────────────────────

function defaultPeriod() {
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

// ── Known-field renderers per report type ────────────────────────────────────

// Returns { sections, remainder } where sections are typed blocks and
// remainder holds unknown top-level keys for generic fallback rendering.
function parseReport(name, data) {
  if (!data || typeof data !== "object") return { sections: [], remainder: {} };

  const sections = [];
  const consumed = new Set();

  // ── profit-and-loss ──────────────────────────────────────────────────────
  if (name === "profit-and-loss") {
    if (data.revenue !== undefined) {
      consumed.add("revenue");
      sections.push({ type: "stat", label: "Revenue", value: fmtAmt(data.revenue, data.currency), positive: true });
    }
    if (data.expenses !== undefined) {
      consumed.add("expenses");
      sections.push({ type: "stat", label: "Expenses", value: fmtAmt(data.expenses, data.currency), positive: false });
    }
    if (data.gross_profit !== undefined) {
      consumed.add("gross_profit");
      sections.push({ type: "stat", label: "Gross Profit", value: fmtAmt(data.gross_profit, data.currency) });
    }
    if (data.net_income !== undefined || data.net_profit !== undefined) {
      const val = data.net_income ?? data.net_profit;
      consumed.add("net_income"); consumed.add("net_profit");
      const isPositive = typeof val === "number" ? val >= 0 : undefined;
      sections.push({ type: "stat", label: "Net Income", value: fmtAmt(val, data.currency), highlight: true, positive: isPositive });
    }
    if (Array.isArray(data.line_items)) {
      consumed.add("line_items");
      sections.push({ type: "table", label: "Line Items", rows: data.line_items });
    }
    if (Array.isArray(data.income_items)) {
      consumed.add("income_items");
      sections.push({ type: "table", label: "Income", rows: data.income_items });
    }
    if (Array.isArray(data.expense_items)) {
      consumed.add("expense_items");
      sections.push({ type: "table", label: "Expenses Detail", rows: data.expense_items });
    }
    consumed.add("currency"); consumed.add("from"); consumed.add("to");
  }

  // ── balance-sheet ────────────────────────────────────────────────────────
  if (name === "balance-sheet") {
    if (data.total_assets !== undefined) {
      consumed.add("total_assets");
      sections.push({ type: "stat", label: "Total Assets", value: fmtAmt(data.total_assets, data.currency) });
    }
    if (data.total_liabilities !== undefined) {
      consumed.add("total_liabilities");
      sections.push({ type: "stat", label: "Total Liabilities", value: fmtAmt(data.total_liabilities, data.currency), positive: false });
    }
    if (data.equity !== undefined) {
      consumed.add("equity");
      sections.push({ type: "stat", label: "Equity", value: fmtAmt(data.equity, data.currency), highlight: true });
    }
    if (data.balanced !== undefined) {
      consumed.add("balanced");
      sections.push({
        type: "badge",
        label: "Balanced",
        ok: !!data.balanced,
        text: data.balanced ? "Sheet balances" : "Sheet does NOT balance",
      });
    }
    if (Array.isArray(data.assets)) {
      consumed.add("assets");
      sections.push({ type: "table", label: "Assets", rows: data.assets });
    }
    if (Array.isArray(data.liabilities)) {
      consumed.add("liabilities");
      sections.push({ type: "table", label: "Liabilities", rows: data.liabilities });
    }
    consumed.add("currency"); consumed.add("as_of"); consumed.add("date");
  }

  // ── vat-summary ──────────────────────────────────────────────────────────
  if (name === "vat-summary") {
    if (data.output_vat !== undefined) {
      consumed.add("output_vat");
      sections.push({ type: "stat", label: "Output VAT (collected)", value: fmtAmt(data.output_vat, data.currency) });
    }
    if (data.input_vat !== undefined) {
      consumed.add("input_vat");
      sections.push({ type: "stat", label: "Input VAT (paid)", value: fmtAmt(data.input_vat, data.currency), positive: false });
    }
    if (data.net_vat !== undefined) {
      consumed.add("net_vat");
      const val = data.net_vat;
      sections.push({ type: "stat", label: "Net VAT Payable", value: fmtAmt(val, data.currency), highlight: true, positive: typeof val === "number" ? val <= 0 : undefined });
    }
    if (Array.isArray(data.transactions)) {
      consumed.add("transactions");
      sections.push({ type: "table", label: "VAT Transactions", rows: data.transactions });
    }
    consumed.add("currency"); consumed.add("from"); consumed.add("to");
  }

  // ── cash-flow ────────────────────────────────────────────────────────────
  if (name === "cash-flow") {
    if (data.inflows !== undefined) {
      consumed.add("inflows");
      sections.push({ type: "stat", label: "Total Inflows", value: fmtAmt(data.inflows, data.currency), positive: true });
    }
    if (data.outflows !== undefined) {
      consumed.add("outflows");
      sections.push({ type: "stat", label: "Total Outflows", value: fmtAmt(data.outflows, data.currency), positive: false });
    }
    if (data.net_flow !== undefined || data.net_cash_flow !== undefined) {
      const val = data.net_flow ?? data.net_cash_flow;
      consumed.add("net_flow"); consumed.add("net_cash_flow");
      sections.push({ type: "stat", label: "Net Cash Flow", value: fmtAmt(val, data.currency), highlight: true, positive: typeof val === "number" ? val >= 0 : undefined });
    }
    if (Array.isArray(data.items)) {
      consumed.add("items");
      sections.push({ type: "table", label: "Cash Flow Items", rows: data.items });
    }
    consumed.add("currency"); consumed.add("from"); consumed.add("to");
  }

  // ── spending-trend ───────────────────────────────────────────────────────
  if (name === "spending-trend") {
    if (data.total_spending !== undefined) {
      consumed.add("total_spending");
      sections.push({ type: "stat", label: "Total Spending", value: fmtAmt(data.total_spending, data.currency), positive: false });
    }
    if (Array.isArray(data.categories) || Array.isArray(data.breakdown)) {
      const rows = data.categories ?? data.breakdown;
      consumed.add("categories"); consumed.add("breakdown");
      sections.push({ type: "table", label: "By Category", rows });
    }
    if (Array.isArray(data.trend) || Array.isArray(data.periods)) {
      const rows = data.trend ?? data.periods;
      consumed.add("trend"); consumed.add("periods");
      sections.push({ type: "table", label: "Period Trend", rows });
    }
    consumed.add("currency"); consumed.add("from"); consumed.add("to");
  }

  // ── net-worth (personal) ─────────────────────────────────────────────────
  if (name === "net-worth") {
    if (data.total_assets !== undefined) {
      consumed.add("total_assets");
      sections.push({ type: "stat", label: "Total Assets", value: fmtAmt(data.total_assets, data.currency) });
    }
    if (data.total_liabilities !== undefined) {
      consumed.add("total_liabilities");
      sections.push({ type: "stat", label: "Total Liabilities", value: fmtAmt(data.total_liabilities, data.currency), positive: false });
    }
    if (data.net_worth !== undefined) {
      consumed.add("net_worth");
      const val = data.net_worth;
      sections.push({ type: "stat", label: "Net Worth", value: fmtAmt(val, data.currency), highlight: true, positive: typeof val === "number" ? val >= 0 : undefined });
    }
    if (Array.isArray(data.holdings)) {
      consumed.add("holdings");
      sections.push({ type: "table", label: "Holdings", rows: data.holdings });
    }
    consumed.add("currency"); consumed.add("as_of");
  }

  // Remainder = keys not consumed above → generic key/value fallback
  const remainder = Object.fromEntries(
    Object.entries(data).filter(([k]) => !consumed.has(k))
  );

  return { sections, remainder };
}

// Format a potentially-monetary value defensively
function fmtAmt(val, currency) {
  if (val === null || val === undefined) return "—";
  if (typeof val === "number") return formatMoney(val, currency);
  return String(val);
}

// Humanise a snake_case key
function humanKey(k) {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Render a table row's cell value intelligently
function cellValue(v, currency) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return formatMoney(v, currency);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  // ISO date strings
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return formatDate(v);
  return String(v);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ReportPickerCard({ reports, selected, onSelect }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {reports.map((r) => (
        <button
          key={r.name}
          onClick={() => onSelect(r.name)}
          className={cn(
            "text-left p-4 rounded-lg border transition-colors duration-150",
            selected === r.name
              ? "border-ink-900 bg-ink-50 shadow-sm"
              : "border-ink-200 bg-ink-0 hover:border-ink-400 hover:bg-ink-50",
          )}
        >
          <div className="flex items-center gap-2 mb-1">
            <FileBarChart2 size={14} className={selected === r.name ? "text-ink-900" : "text-ink-400"} />
            <span className={cn("text-sm font-medium tracking-tight", selected === r.name ? "text-ink-900" : "text-ink-700")}>
              {r.label}
            </span>
          </div>
          <p className="text-[12px] text-ink-500 leading-relaxed">{r.description}</p>
        </button>
      ))}
    </div>
  );
}

function PeriodSelector({ from, to, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <span className="label-eyebrow">From</span>
        <input
          type="date"
          value={from}
          max={to}
          onChange={(e) => onChange({ from: e.target.value, to })}
          className="h-9 px-3 text-sm rounded border border-ink-200 bg-ink-0 text-ink-900 focus:outline-none focus:ring-2 focus:ring-ink-900/20 focus:border-ink-400 transition-colors"
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <span className="label-eyebrow">To</span>
        <input
          type="date"
          value={to}
          min={from}
          onChange={(e) => onChange({ from, to: e.target.value })}
          className="h-9 px-3 text-sm rounded border border-ink-200 bg-ink-0 text-ink-900 focus:outline-none focus:ring-2 focus:ring-ink-900/20 focus:border-ink-400 transition-colors"
        />
      </label>
    </div>
  );
}

// Render a single stat block
function StatBlock({ label, value, highlight, positive }) {
  const valueClass = cn(
    "text-display tracking-tighter tnum",
    highlight ? "text-ink-900" : "text-ink-800",
    positive === true && "text-emerald-700",
    positive === false && "text-red-600",
  );
  return (
    <div className={cn("p-5 rounded-lg border", highlight ? "border-ink-300 bg-ink-50" : "border-ink-200 bg-ink-0")}>
      <p className="label-eyebrow mb-2 text-ink-500">{label}</p>
      <p className={valueClass}>{value}</p>
    </div>
  );
}

// Render a balanced/unbalanced badge
function BalanceBadge({ ok, text }) {
  return (
    <div className={cn(
      "inline-flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium",
      ok ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-red-50 text-red-800 border border-red-200",
    )}>
      {ok ? "✓" : "✗"} {text}
    </div>
  );
}

// Render an array of objects as a table. Derives columns from the first row.
function DataTable({ label, rows, currency }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      <div>
        {label && <h3 className="text-sm font-medium text-ink-900 mb-3">{label}</h3>}
        <p className="text-sm text-ink-500 italic">No data.</p>
      </div>
    );
  }

  // Collect column keys across all rows (first 200 rows max for perf)
  const colSet = new Set();
  rows.slice(0, 200).forEach((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      Object.keys(row).forEach((k) => colSet.add(k));
    }
  });
  const cols = Array.from(colSet);

  if (cols.length === 0) {
    // Scalar array fallback
    return (
      <div>
        {label && <h3 className="text-sm font-medium text-ink-900 mb-3">{label}</h3>}
        <ul className="text-sm text-ink-700 space-y-1 list-disc list-inside">
          {rows.map((v, i) => <li key={i}>{String(v)}</li>)}
        </ul>
      </div>
    );
  }

  return (
    <div>
      {label && <h3 className="text-sm font-medium text-ink-900 mb-3">{label}</h3>}
      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="min-w-full text-sm">
          <thead className="bg-ink-50 border-b border-ink-200">
            <tr>
              {cols.map((c) => (
                <th key={c} className="px-4 py-2.5 text-left label-eyebrow text-ink-500 whitespace-nowrap">
                  {humanKey(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-ink-50 transition-colors">
                {cols.map((c) => (
                  <td key={c} className="px-4 py-2.5 text-ink-800 tnum whitespace-nowrap">
                    {row && typeof row === "object" ? cellValue(row[c], currency) : "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && (
        <p className="text-[12px] text-ink-500 mt-2">Showing first 200 rows of {rows.length}.</p>
      )}
    </div>
  );
}

// Generic key/value fallback for unknown fields
function GenericFields({ data, currency }) {
  const entries = Object.entries(data).filter(([, v]) => !Array.isArray(v) && typeof v !== "object");
  const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v));
  const objects = Object.entries(data).filter(([, v]) => v !== null && typeof v === "object" && !Array.isArray(v));

  return (
    <div className="space-y-4">
      {entries.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
          {entries.map(([k, v]) => (
            <div key={k}>
              <dt className="label-eyebrow text-ink-500 mb-0.5">{humanKey(k)}</dt>
              <dd className="text-sm text-ink-900 tnum">{cellValue(v, currency)}</dd>
            </div>
          ))}
        </dl>
      )}
      {arrays.map(([k, rows]) => (
        <DataTable key={k} label={humanKey(k)} rows={rows} currency={currency} />
      ))}
      {objects.map(([k, obj]) => (
        <div key={k}>
          <h4 className="text-sm font-medium text-ink-900 mb-2">{humanKey(k)}</h4>
          <GenericFields data={obj} currency={currency} />
        </div>
      ))}
    </div>
  );
}

// Main report renderer
function ReportBody({ name, data, isLoading, error }) {
  if (isLoading) {
    return (
      <div className="space-y-3 mt-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error) {
    const status = error?.status;
    if (status === 403) {
      return (
        <div className="mt-4 p-4 rounded-lg border border-amber-200 bg-amber-50 flex items-start gap-3">
          <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-900">Report not available for this organisation type.</p>
            <p className="text-[12px] text-amber-700 mt-1">
              This report is only available for {name === "cash-flow" || name === "spending-trend" || name === "net-worth" ? "personal" : "business"} organisations.
            </p>
          </div>
        </div>
      );
    }
    if (status === 404) {
      return (
        <div className="mt-4 p-4 rounded-lg border border-ink-200 bg-ink-50 flex items-start gap-3">
          <AlertTriangle size={16} className="text-ink-400 shrink-0 mt-0.5" />
          <p className="text-sm text-ink-600">Report type not found.</p>
        </div>
      );
    }
    return (
      <div className="mt-4 p-4 rounded-lg border border-red-200 bg-red-50 flex items-start gap-3">
        <AlertTriangle size={16} className="text-red-600 shrink-0 mt-0.5" />
        <p className="text-sm text-red-800">{error?.message || "Failed to load report."}</p>
      </div>
    );
  }

  if (!data) return null;

  const currency = data?.currency;
  const { sections, remainder } = parseReport(name, data);

  // Stats: headline numbers shown in a grid
  const stats = sections.filter((s) => s.type === "stat");
  const badges = sections.filter((s) => s.type === "badge");
  const tables = sections.filter((s) => s.type === "table");
  const hasRemainder = Object.keys(remainder).length > 0;

  return (
    <div className="space-y-6 mt-4">
      {stats.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((s, i) => (
            <StatBlock key={i} label={s.label} value={s.value} highlight={s.highlight} positive={s.positive} />
          ))}
        </div>
      )}
      {badges.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {badges.map((b, i) => <BalanceBadge key={i} ok={b.ok} text={b.text} />)}
        </div>
      )}
      {tables.map((t, i) => (
        <DataTable key={i} label={t.label} rows={t.rows} currency={currency} />
      ))}
      {hasRemainder && (
        <div>
          <p className="label-eyebrow text-ink-500 mb-3">Additional Data</p>
          <GenericFields data={remainder} currency={currency} />
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const { data: orgsData } = useOrgs();

  const activeOrg = orgsData?.organizations?.find((o) => o.id === orgId);
  const kind = activeOrg?.kind; // "personal" | "business" | undefined

  const reports = kind === "business" ? BUSINESS_REPORTS : PERSONAL_REPORTS;

  const [selected, setSelected] = useState(null);
  const [period, setPeriod] = useState(defaultPeriod);
  const [downloading, setDownloading] = useState(false);

  // When kind loads, reset selection if it no longer belongs to this kind
  const allNames = reports.map((r) => r.name);
  const resolvedSelected = allNames.includes(selected) ? selected : null;

  const {
    data: reportData,
    isLoading,
    error,
    refetch,
  } = useReport(orgId, resolvedSelected, period);

  const selectedMeta = reports.find((r) => r.name === resolvedSelected);

  const handleDownloadCSV = useCallback(async () => {
    if (!orgId || !resolvedSelected) return;
    setDownloading(true);
    try {
      const csv = await api.getReport(orgId, resolvedSelected, { ...period, format: "csv" });
      // csv may be a raw string or a blob-like response. Handle both.
      const content = typeof csv === "string" ? csv : JSON.stringify(csv, null, 2);
      const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${resolvedSelected}_${period.from}_${period.to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      // Surface error in console; don't crash the page
      console.error("CSV download failed:", err);
    } finally {
      setDownloading(false);
    }
  }, [orgId, resolvedSelected, period]);

  return (
    <div className="page-shell max-w-[1280px]">
      <PageHeader
        eyebrow={activeOrg ? `${activeOrg.name} · Reports` : "Reports"}
        title="Reports"
        description={
          kind === "business"
            ? "Financial statements and tax summaries for your business."
            : "Personal finance reports — cash flow, spending and net worth."
        }
        actions={
          resolvedSelected && !isLoading && !error && reportData ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleDownloadCSV}
              loading={downloading}
              disabled={downloading}
            >
              <Download size={13} />
              Download CSV
            </Button>
          ) : null
        }
      />

      {/* Report picker */}
      <section className="mb-8">
        <p className="label-eyebrow text-ink-500 mb-3">
          {kind === "business" ? "Business reports" : kind === "personal" ? "Personal reports" : "Select a report"}
        </p>
        {!orgId ? (
          <EmptyState
            icon={<FileBarChart2 size={20} />}
            title="No organisation selected"
            description="Select or create an organisation to view reports."
          />
        ) : !kind ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
          </div>
        ) : (
          <ReportPickerCard
            reports={reports}
            selected={resolvedSelected}
            onSelect={(name) => setSelected(name === resolvedSelected ? null : name)}
          />
        )}
      </section>

      {/* Period selector + report body */}
      {resolvedSelected && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <CardTitle>{selectedMeta?.label ?? resolvedSelected}</CardTitle>
                {selectedMeta?.description && (
                  <CardSubtitle>{selectedMeta.description}</CardSubtitle>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <PeriodSelector from={period.from} to={period.to} onChange={setPeriod} />
                {!isLoading && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => refetch()}
                    title="Refresh report"
                  >
                    <RefreshCw size={13} />
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardBody>
            <ReportBody
              name={resolvedSelected}
              data={reportData}
              isLoading={isLoading}
              error={error}
            />
          </CardBody>
        </Card>
      )}

      {!resolvedSelected && orgId && kind && (
        <div className="mt-2 p-6 rounded-lg border border-dashed border-ink-200 flex flex-col items-center justify-center text-center gap-2">
          <FileBarChart2 size={24} className="text-ink-300" />
          <p className="text-sm font-medium text-ink-600">Select a report above to get started.</p>
          <p className="text-[12px] text-ink-400">Choose a period and download as CSV anytime.</p>
        </div>
      )}
    </div>
  );
}
