import { useMemo } from "react";
import { TrendingUp, TrendingDown, Minus, BarChart3, Wallet, CreditCard, Package } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardBody, CardTitle } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useNetWorth, useNetWorthHistory } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { formatMoney, formatDate } from "@/lib/format";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Safely coerce a value to a number, returning 0 for nullish/NaN.
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Extract a labelled amount list from the headline response.
// The API may return `{ items: [...] }` or a bare array or null.
const toItems = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (Array.isArray(val?.items)) return val.items;
  return [];
};

// Pull the history time series out regardless of envelope shape.
// Accepted shapes:
//   { entries: [...] }  |  { history: [...] }  |  bare array
const toHistory = (res) => {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.entries)) return res.entries;
  if (Array.isArray(res?.history)) return res.history;
  return [];
};

// Build polyline points from data, scaled to a viewport.
function buildPolyline(values, w, h, padding = 6) {
  if (values.length < 2) return { points: "", dots: [], area: "" };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const scaleX = (i) => padding + (i / (values.length - 1)) * (w - padding * 2);
  const scaleY = (v) => h - padding - ((v - min) / range) * (h - padding * 2);

  const coords = values.map((v, i) => [scaleX(i), scaleY(v)]);
  const points = coords.map(([x, y]) => `${x},${y}`).join(" ");
  const area = [
    `M ${coords[0][0]},${h}`,
    ...coords.map(([x, y]) => `L ${x},${y}`),
    `L ${coords[coords.length - 1][0]},${h}`,
    "Z",
  ].join(" ");

  return { points, dots: coords, area };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function HeadlineSkeleton() {
  return (
    <Card className="p-8">
      <Skeleton className="h-4 w-32 mb-3" />
      <Skeleton className="h-12 w-64 mb-2" />
      <Skeleton className="h-4 w-48" />
    </Card>
  );
}

function HeadlineCard({ assets, liabilities, holdings, currency }) {
  const assetsTotal = num(assets?.total ?? assets);
  const liabilitiesTotal = num(liabilities?.total ?? liabilities);
  const holdingsTotal = num(holdings?.total ?? holdings);
  const netWorth = assetsTotal - liabilitiesTotal + holdingsTotal;
  const isPositive = netWorth >= 0;

  return (
    <Card className="p-8">
      <p className="text-xs font-medium uppercase tracking-widest text-ink-500 mb-2">
        Net Worth
      </p>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-display-lg text-ink-900">
          {formatMoney(netWorth, currency)}
        </span>
        <span
          className={`inline-flex items-center gap-1 text-sm font-medium ${
            isPositive ? "text-success" : "text-danger"
          }`}
        >
          {isPositive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {isPositive ? "Positive" : "Negative"} balance
        </span>
      </div>
      <div className="mt-5 flex flex-wrap gap-6 text-sm text-ink-500">
        <span>
          <span className="text-ink-900 font-medium">{formatMoney(assetsTotal, currency)}</span>
          {" "}assets
        </span>
        <span className="text-ink-300">—</span>
        <span>
          <span className="text-ink-900 font-medium">{formatMoney(liabilitiesTotal, currency)}</span>
          {" "}liabilities
        </span>
        {holdingsTotal !== 0 && (
          <>
            <span className="text-ink-300">+</span>
            <span>
              <span className="text-ink-900 font-medium">{formatMoney(holdingsTotal, currency)}</span>
              {" "}holdings
            </span>
          </>
        )}
      </div>
    </Card>
  );
}

function TrendChart({ history }) {
  const points = useMemo(() => {
    return history
      .map((entry) => ({
        date: entry?.date ?? entry?.period ?? entry?.at ?? "",
        value: num(entry?.net_worth ?? entry?.value ?? entry?.total ?? entry?.amount),
      }))
      .filter((e) => e.date)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [history]);

  if (points.length < 2) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <EmptyState
          icon={<BarChart3 size={20} />}
          title="No history yet"
          description="Net worth snapshots will appear here once valuations are recorded."
        />
      </Card>
    );
  }

  const values = points.map((p) => p.value);
  const first = values[0];
  const last = values[values.length - 1];
  const change = last - first;
  const pct = first !== 0 ? ((change / Math.abs(first)) * 100).toFixed(1) : null;
  const isUp = change >= 0;
  const currency = undefined; // history entries don't carry per-row currency

  // SVG dimensions
  const W = 600;
  const H = 120;
  const { points: polyPoints, dots, area } = buildPolyline(values, W, H);

  // Show a subset of x-axis labels to avoid crowding
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const labelIndices = points
    .map((_, i) => i)
    .filter((i) => i === 0 || i === points.length - 1 || i % labelEvery === 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>History</CardTitle>
          <span
            className={`inline-flex items-center gap-1 text-sm font-medium ${
              isUp ? "text-success" : "text-danger"
            }`}
          >
            {isUp ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
            {pct !== null
              ? `${isUp ? "+" : ""}${pct}%`
              : formatMoney(change, currency)}
            {" "}
            <span className="text-ink-400 font-normal">all time</span>
          </span>
        </div>
      </CardHeader>
      <CardBody>
        {/* SVG area/line chart — no external dependency */}
        <div className="overflow-hidden rounded" style={{ aspectRatio: "5/1" }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="w-full h-full"
            aria-label="Net worth trend chart"
          >
            <defs>
              <linearGradient id="nw-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={isUp ? "#16A34A" : "#DC2626"} stopOpacity="0.18" />
                <stop offset="100%" stopColor={isUp ? "#16A34A" : "#DC2626"} stopOpacity="0.01" />
              </linearGradient>
            </defs>
            {/* Filled area */}
            <path d={area} fill="url(#nw-grad)" />
            {/* Line */}
            <polyline
              points={polyPoints}
              fill="none"
              stroke={isUp ? "#16A34A" : "#DC2626"}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {/* Dots at each data point */}
            {dots.map(([x, y], i) => (
              <circle
                key={i}
                cx={x}
                cy={y}
                r="2"
                fill={isUp ? "#16A34A" : "#DC2626"}
                opacity={i === 0 || i === dots.length - 1 ? 1 : 0.4}
              />
            ))}
          </svg>
        </div>

        {/* X-axis date labels */}
        <div className="relative mt-2 h-5 text-xs text-ink-400">
          {labelIndices.map((i) => {
            const xPct = (i / (points.length - 1)) * 100;
            return (
              <span
                key={i}
                className="absolute whitespace-nowrap"
                style={{
                  left: `${xPct}%`,
                  transform:
                    i === 0
                      ? "none"
                      : i === points.length - 1
                      ? "translateX(-100%)"
                      : "translateX(-50%)",
                }}
              >
                {formatDate(points[i].date)}
              </span>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

function ItemRow({ label, amount, currency, note }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-ink-100 last:border-0 gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-900 truncate">{label ?? "—"}</p>
        {note && <p className="text-xs text-ink-400 mt-0.5 truncate">{note}</p>}
      </div>
      <span className="text-sm font-mono text-ink-900 shrink-0 tabular-nums">
        {formatMoney(num(amount), currency)}
      </span>
    </div>
  );
}

function BreakdownCard({ icon, title, items, total, currency, emptyText }) {
  const normalised = useMemo(() => {
    if (!items || items.length === 0) return [];
    return items.map((item) => ({
      id: item?.id ?? item?.account_id ?? Math.random(),
      label: item?.name ?? item?.label ?? item?.account_name ?? item?.description ?? "Unknown",
      amount: num(item?.amount ?? item?.balance ?? item?.value),
      note: item?.note ?? item?.currency ?? item?.type ?? undefined,
      currency: item?.currency ?? currency,
    }));
  }, [items, currency]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded flex items-center justify-center bg-ink-100 text-ink-500">
              {icon}
            </div>
            <CardTitle>{title}</CardTitle>
          </div>
          <span className="text-sm font-mono tabular-nums font-medium text-ink-900">
            {formatMoney(num(total), currency)}
          </span>
        </div>
      </CardHeader>
      <CardBody>
        {normalised.length === 0 ? (
          <p className="text-sm text-ink-400 text-center py-4">{emptyText}</p>
        ) : (
          <div>
            {normalised.map((item) => (
              <ItemRow
                key={item.id}
                label={item.label}
                amount={item.amount}
                currency={item.currency ?? currency}
                note={item.note}
              />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NetWorthPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);

  const { data: headline, isLoading: headlineLoading, error: headlineError } = useNetWorth(orgId);
  const { data: historyData, isLoading: historyLoading } = useNetWorthHistory(orgId);

  // The backend contract: GET /net-worth → headline (assets/liabilities/holdings, FX-normalised)
  // Shape: { assets: { total, items[] }, liabilities: { total, items[] }, holdings: { total, items[] }, currency: "ZAR" }
  // Code defensively: also accept flat { assets_total, liabilities_total, ... } or plain number fields.
  const assets = headline?.assets ?? null;
  const liabilities = headline?.liabilities ?? null;
  const holdings = headline?.holdings ?? null;
  const currency = headline?.currency ?? "ZAR";

  const assetsItems = toItems(assets);
  const liabilitiesItems = toItems(liabilities);
  const holdingsItems = toItems(holdings);

  const assetsTotal = num(assets?.total ?? assets);
  const liabilitiesTotal = num(liabilities?.total ?? liabilities);
  const holdingsTotal = num(holdings?.total ?? holdings);

  const history = useMemo(() => toHistory(historyData), [historyData]);

  const hasValuations = headline && (assetsTotal > 0 || liabilitiesTotal > 0 || holdingsTotal > 0);

  return (
    <div className="page-shell max-w-[1280px]">
      <PageHeader
        eyebrow="Personal finance"
        title="Net Worth"
        description="A snapshot of everything you own minus everything you owe."
      />

      {/* Headline */}
      {headlineLoading ? (
        <HeadlineSkeleton />
      ) : headlineError ? (
        <Card className="p-8">
          <div className="flex items-center gap-2 text-danger text-sm">
            <Minus size={14} />
            <span>Could not load net worth data. Please try again.</span>
          </div>
        </Card>
      ) : !headline || !hasValuations ? (
        <Card>
          <EmptyState
            icon={<TrendingUp size={20} />}
            title="No valuations yet"
            description="Connect your accounts or add assets and liabilities to see your net worth."
          />
        </Card>
      ) : (
        <HeadlineCard
          assets={assets}
          liabilities={liabilities}
          holdings={holdings}
          currency={currency}
        />
      )}

      {/* Trend chart */}
      <div className="mt-6">
        {historyLoading ? (
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-24" />
            </CardHeader>
            <CardBody>
              <Skeleton className="h-28 w-full" />
            </CardBody>
          </Card>
        ) : (
          <TrendChart history={history} />
        )}
      </div>

      {/* Breakdown grid — assets / liabilities / holdings */}
      {(headlineLoading || hasValuations) && (
        <div className="mt-6 grid gap-5 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {headlineLoading ? (
            <>
              {[0, 1, 2].map((i) => (
                <Card key={i}>
                  <CardHeader>
                    <Skeleton className="h-5 w-32" />
                  </CardHeader>
                  <CardBody className="space-y-3">
                    {[0, 1, 2].map((j) => (
                      <Skeleton key={j} className="h-4 w-full" />
                    ))}
                  </CardBody>
                </Card>
              ))}
            </>
          ) : (
            <>
              <BreakdownCard
                icon={<Wallet size={14} />}
                title="Assets"
                items={assetsItems}
                total={assetsTotal}
                currency={currency}
                emptyText="No assets recorded."
              />
              <BreakdownCard
                icon={<CreditCard size={14} />}
                title="Liabilities"
                items={liabilitiesItems}
                total={liabilitiesTotal}
                currency={currency}
                emptyText="No liabilities recorded."
              />
              <BreakdownCard
                icon={<Package size={14} />}
                title="Holdings"
                items={holdingsItems}
                total={holdingsTotal}
                currency={currency}
                emptyText="No holdings recorded."
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
