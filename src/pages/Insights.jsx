// P4-02 — Cross-org intelligence: forecasting, anomalies, tax-readiness.
// Owned by the P4-02 frontend agent. Do NOT edit src/lib/*, routing, Sidebar,
// package.json, or other pages.

import { useState, useMemo } from "react";
import {
  TrendingUp, TrendingDown, AlertTriangle, AlertCircle,
  CheckCircle2, Clock, Info, BarChart3, ShieldCheck, FileText,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardBody, CardTitle, CardSubtitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { useForecast, useAnomalies, useTaxReadiness } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { formatMoney, formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

// ── Horizon selector options ─────────────────────────────────────────────────
const HORIZONS = [
  { value: 3,  label: "3 mo" },
  { value: 6,  label: "6 mo" },
  { value: 12, label: "12 mo" },
];

// ── Colour helpers ────────────────────────────────────────────────────────────
function anomalyTone(severity) {
  if (severity === "high" || severity === "critical") return "danger";
  if (severity === "medium" || severity === "warning")  return "warning";
  return "neutral";
}

function statusTone(status) {
  if (status === "ok" || status === "complete" || status === "good") return "success";
  if (status === "warning" || status === "incomplete") return "warning";
  if (status === "error" || status === "missing")      return "danger";
  return "neutral";
}

function statusLabel(status) {
  if (!status) return "Unknown";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── SVG Bar/Line Chart — no npm chart lib ─────────────────────────────────────
//
// Renders a combined bar + line chart:
//   - Bars: projected_inflow (green) and projected_outflow (red) per month
//   - Line: projected_net or projected_balance (accent)
//
// All layout is computed in JS from viewBox coordinates — no D3, no recharts.

function ForecastChart({ points, currency, mode = "net" }) {
  const W = 640, H = 220, PAD = { top: 16, right: 16, bottom: 36, left: 64 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const safePoints = Array.isArray(points) ? points : [];
  if (safePoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-ink-400">
        No projection data available yet.
      </div>
    );
  }

  // Determine y-domain
  const allValues = safePoints.flatMap((p) => [
    p.projected_inflow ?? 0,
    p.projected_outflow ?? 0,
    mode === "balance" ? (p.projected_balance ?? 0) : (p.projected_net ?? 0),
  ]);
  const yMin = Math.min(0, ...allValues);
  const yMax = Math.max(0, ...allValues) || 1;
  const yRange = yMax - yMin || 1;

  // Scale helpers
  const xScale = (i) => PAD.left + (i + 0.5) * (chartW / safePoints.length);
  const yScale = (v) => PAD.top + chartH - ((v - yMin) / yRange) * chartH;
  const barW = Math.max(4, (chartW / safePoints.length) * 0.35);

  // Zero line y
  const zeroY = yScale(0);

  // Y-axis ticks
  const tickCount = 5;
  const yTicks = Array.from({ length: tickCount }, (_, i) => {
    const v = yMin + (yRange * i) / (tickCount - 1);
    return { v, y: yScale(v) };
  });

  // Line path for net/balance
  const lineKey = mode === "balance" ? "projected_balance" : "projected_net";
  const linePoints = safePoints
    .map((p, i) => `${xScale(i)},${yScale(p[lineKey] ?? 0)}`)
    .join(" ");

  // Month labels (truncate to 3-char month name)
  const monthLabel = (iso) => {
    if (!iso) return "";
    const d = new Date(iso + "-01");
    if (Number.isNaN(d.getTime())) return iso.slice(0, 7);
    return d.toLocaleString("en-ZA", { month: "short" });
  };

  // Format compact money for axis
  const fmtAxis = (v) => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000)     return `${(v / 1_000).toFixed(0)}k`;
    return `${v.toFixed(0)}`;
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto"
      aria-label="Cash-flow forecast chart"
      role="img"
    >
      {/* Grid lines */}
      {yTicks.map(({ y }, i) => (
        <line
          key={i}
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y}
          y2={y}
          stroke="#E4E4E7"
          strokeWidth="1"
        />
      ))}

      {/* Zero line (bold) */}
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={zeroY}
        y2={zeroY}
        stroke="#A1A1AA"
        strokeWidth="1.5"
      />

      {/* Y-axis labels */}
      {yTicks.map(({ v, y }, i) => (
        <text
          key={i}
          x={PAD.left - 6}
          y={y + 4}
          textAnchor="end"
          fontSize="10"
          fill="#71717A"
          fontFamily="inherit"
        >
          {fmtAxis(v)}
        </text>
      ))}

      {/* Inflow bars (green) */}
      {safePoints.map((p, i) => {
        const val = p.projected_inflow ?? 0;
        const bH = Math.abs(yScale(0) - yScale(val));
        const bY = val >= 0 ? yScale(val) : zeroY;
        return (
          <rect
            key={`in-${i}`}
            x={xScale(i) - barW - 1}
            y={bY}
            width={barW}
            height={Math.max(1, bH)}
            fill="#16A34A"
            opacity="0.7"
            rx="1"
          />
        );
      })}

      {/* Outflow bars (red) */}
      {safePoints.map((p, i) => {
        const val = -(Math.abs(p.projected_outflow ?? 0)); // always below zero
        const bH = Math.abs(yScale(0) - yScale(val));
        const bY = zeroY;
        return (
          <rect
            key={`out-${i}`}
            x={xScale(i) + 1}
            y={bY}
            width={barW}
            height={Math.max(1, bH)}
            fill="#DC2626"
            opacity="0.7"
            rx="1"
          />
        );
      })}

      {/* Net/balance polyline */}
      <polyline
        points={linePoints}
        fill="none"
        stroke="#C8FF00"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Dots on line */}
      {safePoints.map((p, i) => (
        <circle
          key={`dot-${i}`}
          cx={xScale(i)}
          cy={yScale(p[lineKey] ?? 0)}
          r="3"
          fill="#C8FF00"
          stroke="#0A0A0A"
          strokeWidth="1"
        />
      ))}

      {/* X-axis labels */}
      {safePoints.map((p, i) => (
        <text
          key={`xl-${i}`}
          x={xScale(i)}
          y={H - PAD.bottom + 16}
          textAnchor="middle"
          fontSize="10"
          fill="#71717A"
          fontFamily="inherit"
        >
          {monthLabel(p.month)}
        </text>
      ))}
    </svg>
  );
}

// ── Skeleton loaders ──────────────────────────────────────────────────────────

function ChartSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-48 w-full rounded-md" />
      <div className="flex gap-6">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}

function AnomalySkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((n) => (
        <div key={n} className="flex gap-3 items-start p-4 rounded-lg border border-ink-100">
          <Skeleton className="h-8 w-8 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}

function TaxSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-6 items-center">
        <Skeleton className="h-28 w-28 rounded-full shrink-0" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-36" />
        </div>
      </div>
      <div className="space-y-2">
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className="flex items-center gap-3">
            <Skeleton className="h-4 w-4 rounded-full shrink-0" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tax score ring (CSS/SVG) ───────────────────────────────────────────────────
//
// A pure-SVG circular gauge. `score` is 0–100.
// Stroke-dasharray trick: circumference * (score/100) = filled arc.

function ScoreRing({ score }) {
  const safeScore = typeof score === "number" && !Number.isNaN(score)
    ? Math.max(0, Math.min(100, score))
    : 0;
  const R = 44;
  const CX = 56, CY = 56;
  const circ = 2 * Math.PI * R;
  const filled = (safeScore / 100) * circ;
  const colour =
    safeScore >= 75 ? "#16A34A"
    : safeScore >= 50 ? "#D97706"
    : "#DC2626";

  return (
    <svg
      viewBox="0 0 112 112"
      className="w-28 h-28"
      role="img"
      aria-label={`Tax readiness score: ${safeScore}`}
    >
      {/* Track */}
      <circle
        cx={CX}
        cy={CY}
        r={R}
        fill="none"
        stroke="#E4E4E7"
        strokeWidth="10"
      />
      {/* Arc */}
      <circle
        cx={CX}
        cy={CY}
        r={R}
        fill="none"
        stroke={colour}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circ}`}
        strokeDashoffset={circ / 4} /* start at 12 o'clock */
        style={{ transition: "stroke-dasharray 0.5s ease" }}
      />
      {/* Score label */}
      <text
        x={CX}
        y={CY + 6}
        textAnchor="middle"
        fontSize="22"
        fontWeight="600"
        fill={colour}
        fontFamily="inherit"
      >
        {safeScore}
      </text>
    </svg>
  );
}

// ── Section: Cash-flow forecast ───────────────────────────────────────────────

function ForecastSection({ orgId }) {
  const [horizon, setHorizon] = useState(6);
  const [chartMode, setChartMode] = useState("net"); // "net" | "balance"

  const { data, isLoading, isError } = useForecast(orgId, horizon);
  const points     = data?.points      ?? [];
  const currency   = data?.currency    ?? "ZAR";
  const assumptions = Array.isArray(data?.assumptions) ? data.assumptions : [];

  // Summary stats
  const totalInflow  = points.reduce((s, p) => s + (p.projected_inflow  ?? 0), 0);
  const totalOutflow = points.reduce((s, p) => s + (p.projected_outflow ?? 0), 0);
  const totalNet     = points.reduce((s, p) => s + (p.projected_net     ?? 0), 0);
  const endBalance   = points.length ? (points[points.length - 1].projected_balance ?? 0) : null;

  return (
    <section aria-labelledby="forecast-heading">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle id="forecast-heading" className="flex items-center gap-2">
                <BarChart3 size={16} className="text-ink-400" />
                Cash-flow Forecast
              </CardTitle>
              <CardSubtitle>Projected inflow, outflow and net position</CardSubtitle>
            </div>

            {/* Horizon selector */}
            <div className="flex items-center gap-1 rounded-md bg-ink-100 p-0.5">
              {HORIZONS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setHorizon(value)}
                  className={cn(
                    "px-3 py-1 text-xs font-medium rounded transition-colors",
                    horizon === value
                      ? "bg-ink-0 text-ink-900 shadow-sm"
                      : "text-ink-500 hover:text-ink-700",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>

        <CardBody className="space-y-5">
          {isLoading ? (
            <ChartSkeleton />
          ) : isError ? (
            <div className="flex items-center gap-2 text-sm text-ink-500 py-8 justify-center">
              <AlertCircle size={16} className="text-danger" />
              Failed to load forecast.
            </div>
          ) : points.length === 0 ? (
            <div className="py-12 text-center">
              <BarChart3 size={28} className="mx-auto mb-3 text-ink-300" />
              <p className="text-sm font-medium text-ink-700">No forecast data yet</p>
              <p className="text-xs text-ink-400 mt-1 max-w-xs mx-auto">
                Start adding transactions to generate a cash-flow projection.
              </p>
            </div>
          ) : (
            <>
              {/* Summary stat pills */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatTile
                  label="Projected inflow"
                  value={formatMoney(totalInflow, currency)}
                  positive
                />
                <StatTile
                  label="Projected outflow"
                  value={formatMoney(totalOutflow, currency)}
                  positive={false}
                />
                <StatTile
                  label={`Net (${horizon}mo)`}
                  value={formatMoney(totalNet, currency)}
                  positive={totalNet >= 0}
                />
                {endBalance !== null && (
                  <StatTile
                    label="End balance"
                    value={formatMoney(endBalance, currency)}
                    positive={endBalance >= 0}
                  />
                )}
              </div>

              {/* Chart mode toggle */}
              <div className="flex items-center gap-1 text-xs">
                <span className="text-ink-400 mr-1">Show:</span>
                {["net", "balance"].map((m) => (
                  <button
                    key={m}
                    onClick={() => setChartMode(m)}
                    className={cn(
                      "px-2 py-0.5 rounded text-xs font-medium transition-colors",
                      chartMode === m
                        ? "bg-accent text-accent-fg"
                        : "text-ink-500 hover:text-ink-700",
                    )}
                  >
                    {m === "net" ? "Net" : "Balance"}
                  </button>
                ))}
              </div>

              {/* Legend */}
              <div className="flex flex-wrap gap-4 text-[11px] text-ink-500">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-sm bg-[#16A34A] opacity-70" />
                  Inflow
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-sm bg-[#DC2626] opacity-70" />
                  Outflow
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-6 h-0.5 bg-accent" />
                  {chartMode === "net" ? "Net" : "Balance"}
                </span>
              </div>

              {/* SVG chart */}
              <div className="overflow-x-auto -mx-1">
                <div className="min-w-[320px]">
                  <ForecastChart points={points} currency={currency} mode={chartMode} />
                </div>
              </div>

              {/* Assumptions */}
              {assumptions.length > 0 && (
                <details className="group">
                  <summary className="flex items-center gap-1.5 text-[11px] text-ink-400 cursor-pointer hover:text-ink-600 list-none">
                    <Info size={12} />
                    <span className="group-open:hidden">Show assumptions ({assumptions.length})</span>
                    <span className="hidden group-open:inline">Hide assumptions</span>
                  </summary>
                  <ul className="mt-2 space-y-1 pl-4">
                    {assumptions.map((a, i) => (
                      <li key={i} className="text-[11px] text-ink-500 flex items-start gap-1.5">
                        <span className="mt-1.5 h-1 w-1 rounded-full bg-ink-300 shrink-0" />
                        {typeof a === "string" ? a : JSON.stringify(a)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

// ── Small stat tile ───────────────────────────────────────────────────────────

function StatTile({ label, value, positive }) {
  const colour = positive === undefined
    ? "text-ink-900"
    : positive
    ? "text-[#16A34A]"
    : "text-[#DC2626]";

  return (
    <div className="rounded-md bg-ink-50 border border-ink-100 px-3 py-2.5">
      <p className="text-[10px] text-ink-400 uppercase tracking-wider mb-0.5">{label}</p>
      <p className={cn("text-sm font-semibold font-mono tabular-nums", colour)}>{value}</p>
    </div>
  );
}

// ── Section: Anomalies feed ───────────────────────────────────────────────────

function AnomalyIcon({ severity }) {
  if (severity === "high" || severity === "critical") {
    return <AlertTriangle size={16} className="text-danger" />;
  }
  if (severity === "medium" || severity === "warning") {
    return <AlertCircle size={16} className="text-warning" />;
  }
  return <Info size={16} className="text-ink-400" />;
}

function AnomalyCard({ anomaly }) {
  const {
    type, severity, title, description,
    amount, currency, detected_at,
  } = anomaly ?? {};

  const tone   = anomalyTone(severity);
  const border =
    tone === "danger"  ? "border-red-200  bg-red-50/50"
    : tone === "warning" ? "border-amber-200 bg-amber-50/50"
    : "border-ink-200 bg-ink-50/30";

  return (
    <div className={cn("rounded-lg border px-4 py-3.5 flex gap-3", border)}>
      {/* Icon */}
      <div className="mt-0.5 shrink-0">
        <AnomalyIcon severity={severity} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <p className="text-sm font-medium text-ink-900 truncate">
            {title ?? type ?? "Unknown anomaly"}
          </p>
          {severity && (
            <Badge tone={tone} dot>
              {statusLabel(severity)}
            </Badge>
          )}
          {type && (
            <Badge tone="neutral">
              {type.replace(/_/g, " ")}
            </Badge>
          )}
        </div>
        {description && (
          <p className="text-xs text-ink-600 leading-relaxed">{description}</p>
        )}
        <div className="flex flex-wrap items-center gap-3 mt-2">
          {amount !== undefined && amount !== null && (
            <span className="text-xs font-medium font-mono tabular-nums text-ink-700">
              {formatMoney(amount, currency)}
            </span>
          )}
          {detected_at && (
            <span className="flex items-center gap-1 text-[10px] text-ink-400">
              <Clock size={10} />
              {formatDate(detected_at)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AnomaliesSection({ orgId }) {
  const { data, isLoading, isError } = useAnomalies(orgId);
  const anomalies = Array.isArray(data) ? data : [];

  // Sort: critical → high → medium → low
  const severityOrder = { critical: 0, high: 1, medium: 2, warning: 3, low: 4 };
  const sorted = useMemo(
    () =>
      [...anomalies].sort(
        (a, b) =>
          (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99),
      ),
    [anomalies],
  );

  // Group by severity bucket for headings
  const high   = sorted.filter((a) => a.severity === "critical" || a.severity === "high");
  const medium = sorted.filter((a) => a.severity === "medium"   || a.severity === "warning");
  const low    = sorted.filter(
    (a) => a.severity !== "critical" && a.severity !== "high"
            && a.severity !== "medium" && a.severity !== "warning",
  );

  return (
    <section aria-labelledby="anomalies-heading">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle id="anomalies-heading" className="flex items-center gap-2">
                <AlertTriangle size={16} className="text-ink-400" />
                Anomalies
              </CardTitle>
              <CardSubtitle>Unusual spend, duplicates, and missing receipts</CardSubtitle>
            </div>
            {!isLoading && !isError && anomalies.length > 0 && (
              <Badge tone={high.length > 0 ? "danger" : "warning"} dot>
                {anomalies.length} detected
              </Badge>
            )}
          </div>
        </CardHeader>

        <CardBody className="space-y-4">
          {isLoading ? (
            <AnomalySkeleton />
          ) : isError ? (
            <div className="flex items-center gap-2 text-sm text-ink-500 py-8 justify-center">
              <AlertCircle size={16} className="text-danger" />
              Failed to load anomalies.
            </div>
          ) : anomalies.length === 0 ? (
            <div className="py-12 text-center">
              <CheckCircle2 size={28} className="mx-auto mb-3 text-[#16A34A]" />
              <p className="text-sm font-medium text-ink-700">No anomalies detected</p>
              <p className="text-xs text-ink-400 mt-1">
                Your transactions look clean — no unusual patterns found.
              </p>
            </div>
          ) : (
            <>
              {high.length > 0 && (
                <div className="space-y-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-danger">
                    High severity
                  </p>
                  {high.map((a) => (
                    <AnomalyCard key={a.id ?? Math.random()} anomaly={a} />
                  ))}
                </div>
              )}
              {medium.length > 0 && (
                <div className="space-y-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-warning">
                    Medium severity
                  </p>
                  {medium.map((a) => (
                    <AnomalyCard key={a.id ?? Math.random()} anomaly={a} />
                  ))}
                </div>
              )}
              {low.length > 0 && (
                <div className="space-y-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-400">
                    Low / info
                  </p>
                  {low.map((a) => (
                    <AnomalyCard key={a.id ?? Math.random()} anomaly={a} />
                  ))}
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

// ── Section: Tax readiness ────────────────────────────────────────────────────

function ComponentRow({ component }) {
  const { label, status, detail } = component ?? {};
  const tone = statusTone(status);
  const IconEl =
    tone === "success" ? CheckCircle2
    : tone === "warning" ? AlertCircle
    : tone === "danger"  ? AlertTriangle
    : Info;
  const iconColour =
    tone === "success" ? "text-[#16A34A]"
    : tone === "warning" ? "text-warning"
    : tone === "danger"  ? "text-danger"
    : "text-ink-400";

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-ink-100 last:border-0">
      <IconEl size={15} className={cn("mt-0.5 shrink-0", iconColour)} />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-800">{label ?? "—"}</span>
          {status && (
            <Badge tone={tone}>
              {statusLabel(status)}
            </Badge>
          )}
        </div>
        {detail && (
          <p className="text-xs text-ink-500 mt-0.5">{detail}</p>
        )}
      </div>
    </div>
  );
}

function TaxReadinessSection({ orgId }) {
  const { data, isLoading, isError } = useTaxReadiness(orgId);

  const score               = data?.score                   ?? 0;
  const vatPosition         = data?.vat_position;
  const documentedExpPct    = data?.documented_expense_pct  ?? 0;
  const unreconciledCount   = data?.unreconciled_count      ?? 0;
  const components          = Array.isArray(data?.components) ? data.components : [];

  const scoreColour =
    score >= 75 ? "text-[#16A34A]"
    : score >= 50 ? "text-warning"
    : "text-danger";

  return (
    <section aria-labelledby="tax-heading">
      <Card>
        <CardHeader>
          <CardTitle id="tax-heading" className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-ink-400" />
            Tax Readiness
          </CardTitle>
          <CardSubtitle>VAT position, documentation, and compliance status</CardSubtitle>
        </CardHeader>

        <CardBody className="space-y-6">
          {isLoading ? (
            <TaxSkeleton />
          ) : isError ? (
            <div className="flex items-center gap-2 text-sm text-ink-500 py-8 justify-center">
              <AlertCircle size={16} className="text-danger" />
              Failed to load tax readiness.
            </div>
          ) : !data ? (
            <div className="py-12 text-center">
              <FileText size={28} className="mx-auto mb-3 text-ink-300" />
              <p className="text-sm font-medium text-ink-700">No tax data yet</p>
              <p className="text-xs text-ink-400 mt-1 max-w-xs mx-auto">
                Upload receipts and reconcile transactions to build your tax readiness score.
              </p>
            </div>
          ) : (
            <>
              {/* Score row */}
              <div className="flex flex-wrap items-center gap-6">
                {/* Ring gauge */}
                <div className="shrink-0">
                  <ScoreRing score={score} />
                </div>

                {/* Score details */}
                <div className="flex-1 min-w-0 space-y-3">
                  <div>
                    <p className="text-xs text-ink-400 uppercase tracking-wider mb-0.5">
                      Readiness score
                    </p>
                    <p className={cn("text-3xl font-semibold tabular-nums font-mono", scoreColour)}>
                      {score}<span className="text-base font-normal text-ink-400">/100</span>
                    </p>
                  </div>

                  {/* Quick stats */}
                  <div className="grid grid-cols-2 gap-2 max-w-xs">
                    <StatTile
                      label="Documented expenses"
                      value={`${Math.round(documentedExpPct ?? 0)}%`}
                      positive={(documentedExpPct ?? 0) >= 80}
                    />
                    <StatTile
                      label="Unreconciled"
                      value={String(unreconciledCount ?? 0)}
                      positive={(unreconciledCount ?? 0) === 0}
                    />
                  </div>
                </div>
              </div>

              {/* VAT position callout */}
              {vatPosition !== undefined && vatPosition !== null && (
                <div className="rounded-md border border-ink-200 bg-ink-50 px-4 py-3 flex items-center gap-3">
                  <TrendingUp size={15} className="text-ink-500 shrink-0" />
                  <div>
                    <p className="text-xs text-ink-400">VAT position</p>
                    <p className="text-sm font-semibold font-mono tabular-nums text-ink-900">
                      {typeof vatPosition === "number"
                        ? formatMoney(vatPosition)
                        : String(vatPosition)}
                    </p>
                  </div>
                </div>
              )}

              {/* Components checklist */}
              {components.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-ink-400 mb-2">
                    Compliance checklist
                  </p>
                  <div className="rounded-md border border-ink-100">
                    {components.map((c, i) => (
                      <div key={i} className="px-4">
                        <ComponentRow component={c} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

// ── Empty state for no active org ─────────────────────────────────────────────

function NoOrgState() {
  return (
    <Card>
      <CardBody className="py-16 text-center">
        <BarChart3 size={32} className="mx-auto mb-4 text-ink-300" />
        <p className="text-base font-medium text-ink-700">No workspace selected</p>
        <p className="text-sm text-ink-400 mt-1.5 max-w-xs mx-auto">
          Select or create a workspace to view insights, forecasts, and tax readiness.
        </p>
      </CardBody>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InsightsPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);

  return (
    <div className="page-shell max-w-[860px]">
      <PageHeader
        eyebrow="Intelligence"
        title="Insights"
        description="Cash-flow forecasting, anomaly detection, and tax readiness for your workspace."
      />

      {!orgId ? (
        <NoOrgState />
      ) : (
        <div className="space-y-8">
          <ForecastSection orgId={orgId} />
          <AnomaliesSection orgId={orgId} />
          <TaxReadinessSection orgId={orgId} />
        </div>
      )}
    </div>
  );
}
