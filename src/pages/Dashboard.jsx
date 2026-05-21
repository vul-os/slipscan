import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight, TrendingUp, TrendingDown, Minus,
  BarChart3, Receipt, BookOpen, FileText, Plus, Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardBody, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusPill } from "@/components/StatusPill";
import { useOrgs, useNetWorth, useSpending, useTransactions } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { useUIStore } from "@/stores/ui";
import { useAuthStore } from "@/stores/auth";
import { formatMoney, formatDate } from "@/lib/format";

// ── Palette for spending category colours (cycles if more categories) ────────
const CAT_COLOURS = [
  "#C8FF00", // accent
  "#60A5FA", // blue-400
  "#F472B6", // pink-400
  "#FB923C", // orange-400
  "#34D399", // emerald-400
  "#A78BFA", // violet-400
  "#FACC15", // yellow-400
  "#2DD4BF", // teal-400
];

// ── Month helpers ─────────────────────────────────────────────────────────────
function currentMonthRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

function monthLabel() {
  return new Date().toLocaleDateString("en-ZA", { month: "long", year: "numeric" });
}

// ── Greeting ──────────────────────────────────────────────────────────────────
function timeGreeting() {
  const h = new Date().getHours();
  if (h < 5)  return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Working late";
}

// ── Net-worth delta display ───────────────────────────────────────────────────
function DeltaPill({ delta, currency }) {
  if (delta === null || delta === undefined) return null;
  const positive = delta >= 0;
  const Icon = delta === 0 ? Minus : positive ? TrendingUp : TrendingDown;
  return (
    <span
      className={[
        "inline-flex items-center gap-1 text-sm font-medium tnum",
        positive ? "text-[#16A34A]" : "text-[#DC2626]",
      ].join(" ")}
    >
      <Icon size={14} />
      {delta === 0 ? "No change" : `${positive ? "+" : ""}${formatMoney(delta, currency)}`}
    </span>
  );
}

// ── SVG Donut for spending ────────────────────────────────────────────────────
// A pure-SVG donut that renders up to 8 segments without any library.
function SpendingDonut({ categories, size = 120 }) {
  const total = categories.reduce((s, c) => s + (c.total ?? 0), 0);
  if (!total) return null;

  const cx = size / 2;
  const r = size / 2 - 8;
  const innerR = r * 0.6;
  const circumference = 2 * Math.PI * r;

  // Build arc paths from cumulative angles
  let cumulative = 0;
  const segments = categories.slice(0, 8).map((cat, i) => {
    const share = (cat.total ?? 0) / total;
    const start = cumulative;
    cumulative += share;
    return { ...cat, share, start, colour: CAT_COLOURS[i % CAT_COLOURS.length] };
  });

  function polarToXY(fraction, radius) {
    const angle = fraction * 2 * Math.PI - Math.PI / 2;
    return {
      x: cx + radius * Math.cos(angle),
      y: cx + radius * Math.sin(angle),
    };
  }

  function arcPath(startFraction, endFraction) {
    if (Math.abs(endFraction - startFraction) >= 0.9999) {
      // Full circle — draw two half-arcs to avoid degenerate path
      const midFraction = startFraction + 0.5;
      const s = polarToXY(startFraction, r);
      const m = polarToXY(midFraction, r);
      const e = polarToXY(endFraction, r);
      const si = polarToXY(startFraction, innerR);
      const mi = polarToXY(midFraction, innerR);
      const ei = polarToXY(endFraction, innerR);
      return [
        `M ${s.x} ${s.y}`,
        `A ${r} ${r} 0 0 1 ${m.x} ${m.y}`,
        `A ${r} ${r} 0 0 1 ${e.x} ${e.y}`,
        `L ${ei.x} ${ei.y}`,
        `A ${innerR} ${innerR} 0 0 0 ${mi.x} ${mi.y}`,
        `A ${innerR} ${innerR} 0 0 0 ${si.x} ${si.y}`,
        "Z",
      ].join(" ");
    }
    const s = polarToXY(startFraction, r);
    const e = polarToXY(endFraction, r);
    const si = polarToXY(startFraction, innerR);
    const ei = polarToXY(endFraction, innerR);
    const large = endFraction - startFraction > 0.5 ? 1 : 0;
    return [
      `M ${s.x} ${s.y}`,
      `A ${r} ${r} 0 0 1 ${e.x} ${e.y}`,
      `L ${ei.x} ${ei.y}`,
      `A ${innerR} ${innerR} 0 0 0 ${si.x} ${si.y}`,
      "Z",
    ].join(" ");
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      {segments.map((seg, i) => (
        <path
          key={i}
          d={arcPath(seg.start, seg.start + seg.share)}
          fill={seg.colour}
          stroke="#FAFAFA"
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}

// ── Horizontal bar row for a spending category ────────────────────────────────
function CategoryBar({ name, total, share, colour, currency }) {
  const pct = Math.max(0, Math.min(100, (share ?? 0) * 100));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
            style={{ background: colour }}
          />
          <span className="text-sm text-ink-700 truncate">{name}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[12px] text-ink-500 tnum">{pct.toFixed(0)}%</span>
          <span className="text-sm font-medium text-ink-900 tnum w-24 text-right">
            {formatMoney(total, currency)}
          </span>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: colour }}
        />
      </div>
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────────
function TxRow({ tx }) {
  const amount = tx.amount ?? tx.total;
  const currency = tx.currency;
  const merchant = tx.merchant || tx.description || tx.merchant_name;
  const date = tx.date || tx.created_at;

  return (
    <div className="flex items-center gap-3 px-5 py-3 hover:bg-ink-50 transition-colors">
      <div className="h-8 w-8 rounded bg-ink-100 flex items-center justify-center text-ink-400 shrink-0">
        <Receipt size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-ink-900 truncate tracking-tight">
          {merchant || <span className="text-ink-400 italic">Unknown merchant</span>}
        </div>
        <div className="text-[12px] text-ink-500 truncate">
          {tx.category_name && <span className="mr-2">{tx.category_name}</span>}
          {date && <span>{formatDate(date)}</span>}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-medium text-ink-900 tnum">
          {amount != null ? formatMoney(amount, currency) : "—"}
        </div>
        {tx.status && <div className="mt-0.5"><StatusPill status={tx.status} /></div>}
      </div>
    </div>
  );
}

// ── Business summary (kind === "business") ────────────────────────────────────
function BusinessSummary({ orgName }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
        <Card className="p-5 flex items-center gap-4">
          <div className="h-10 w-10 rounded-lg bg-ink-100 flex items-center justify-center text-ink-500 shrink-0">
            <BookOpen size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-900 tracking-tight">General Ledger</p>
            <p className="text-[12px] text-ink-500 mt-0.5">
              Chart of accounts, journals & trial balance
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild className="ml-auto shrink-0">
            <Link to="/ledger">
              Open <ArrowUpRight size={13} />
            </Link>
          </Button>
        </Card>

        <Card className="p-5 flex items-center gap-4">
          <div className="h-10 w-10 rounded-lg bg-ink-100 flex items-center justify-center text-ink-500 shrink-0">
            <BarChart3 size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-900 tracking-tight">Reports</p>
            <p className="text-[12px] text-ink-500 mt-0.5">
              P&amp;L, balance sheet, VAT summary &amp; more
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild className="ml-auto shrink-0">
            <Link to="/reports">
              Open <ArrowUpRight size={13} />
            </Link>
          </Button>
        </Card>
      </div>

      <Card>
        <CardBody>
          <EmptyState
            icon={<FileText size={20} />}
            title="Business workspace"
            description={`${orgName || "This workspace"} is set up as a business. Use the Ledger for double-entry accounting, and Reports for financial statements.`}
            action={
              <div className="flex gap-2 justify-center">
                <Button variant="secondary" asChild>
                  <Link to="/ledger">Go to Ledger</Link>
                </Button>
                <Button variant="secondary" asChild>
                  <Link to="/reports">Go to Reports</Link>
                </Button>
              </div>
            }
          />
        </CardBody>
      </Card>
    </div>
  );
}

// ── Loading skeleton for the personal view ────────────────────────────────────
function PersonalSkeleton() {
  return (
    <div className="space-y-6">
      {/* Net worth card skeleton */}
      <Card className="p-6">
        <Skeleton className="h-4 w-24 mb-3" />
        <Skeleton className="h-10 w-52 mb-2" />
        <Skeleton className="h-4 w-32" />
      </Card>

      {/* Two column grid skeleton */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
        <Card>
          <CardHeader><Skeleton className="h-5 w-36" /></CardHeader>
          <CardBody className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <div className="flex justify-between">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-20" />
                </div>
                <Skeleton className="h-1.5 w-full" />
              </div>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader><Skeleton className="h-5 w-36" /></CardHeader>
          <div className="divide-y divide-ink-100">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3">
                <Skeleton className="h-8 w-8 rounded" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-36" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Personal dashboard ────────────────────────────────────────────────────────
function PersonalDashboard({ orgId }) {
  const range = useMemo(currentMonthRange, []);

  const { data: nwData, isLoading: nwLoading } = useNetWorth(orgId);
  const { data: spendData, isLoading: spendLoading } = useSpending(orgId, range);
  const { data: txData, isLoading: txLoading } = useTransactions(orgId);

  const isLoading = nwLoading || spendLoading || txLoading;

  // Normalise net-worth fields — code defensively per the contract
  const netWorth = nwData?.net_worth ?? nwData?.total ?? nwData?.value ?? null;
  const nwCurrency = nwData?.currency ?? null;
  const nwDelta = nwData?.delta ?? nwData?.change ?? null;

  // Normalise spending — the endpoint returns { categories: [...] } with totals + share %
  const rawCategories = spendData?.categories ?? spendData?.breakdown ?? [];
  const spendTotal = spendData?.total ?? spendData?.total_amount ?? null;
  const spendCurrency = spendData?.currency ?? nwCurrency ?? null;

  // Sort categories by total descending, take top 8
  const categories = useMemo(
    () =>
      [...rawCategories]
        .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
        .slice(0, 8)
        .map((c, i) => ({ ...c, colour: CAT_COLOURS[i % CAT_COLOURS.length] })),
    [rawCategories],
  );

  // Recent transactions — latest 10
  const transactions = useMemo(() => {
    const list = Array.isArray(txData) ? txData : txData?.transactions ?? [];
    return [...list]
      .sort((a, b) => {
        const da = new Date(a.date || a.created_at || 0).getTime();
        const db = new Date(b.date || b.created_at || 0).getTime();
        return db - da;
      })
      .slice(0, 10);
  }, [txData]);

  if (isLoading) return <PersonalSkeleton />;

  return (
    <div className="space-y-6">
      {/* ── Net-worth headline ──────────────────────────────────────────────── */}
      <Card className="p-6">
        <p className="label-eyebrow mb-3">Net worth</p>
        <div className="flex flex-wrap items-end gap-4">
          <div className="text-display-lg tracking-tightest text-ink-900 tnum">
            {netWorth != null
              ? formatMoney(netWorth, nwCurrency ?? undefined)
              : <span className="text-ink-400 text-display">—</span>
            }
          </div>
          {nwDelta != null && (
            <div className="mb-1">
              <DeltaPill delta={nwDelta} currency={nwCurrency ?? undefined} />
              <p className="text-[11px] text-ink-500 mt-0.5">vs. last month</p>
            </div>
          )}
        </div>
        {nwData?.assets != null && (
          <div className="mt-4 flex flex-wrap gap-6">
            <div>
              <p className="label-eyebrow !text-ink-400">Assets</p>
              <p className="text-sm font-medium text-ink-900 tnum mt-0.5">
                {formatMoney(nwData.assets, nwCurrency ?? undefined)}
              </p>
            </div>
            <div>
              <p className="label-eyebrow !text-ink-400">Liabilities</p>
              <p className="text-sm font-medium text-ink-900 tnum mt-0.5">
                {formatMoney(nwData.liabilities ?? 0, nwCurrency ?? undefined)}
              </p>
            </div>
            {nwData.holdings != null && (
              <div>
                <p className="label-eyebrow !text-ink-400">Holdings</p>
                <p className="text-sm font-medium text-ink-900 tnum mt-0.5">
                  {formatMoney(nwData.holdings, nwCurrency ?? undefined)}
                </p>
              </div>
            )}
          </div>
        )}
        <div className="mt-4">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/net-worth">
              Full net-worth detail <ArrowUpRight size={13} />
            </Link>
          </Button>
        </div>
      </Card>

      {/* ── Two-column: spending + recent activity ─────────────────────────── */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
        {/* Spending breakdown */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Spending — {monthLabel()}</CardTitle>
            {spendTotal != null && (
              <span className="text-sm font-medium text-ink-700 tnum">
                {formatMoney(spendTotal, spendCurrency ?? undefined)}
              </span>
            )}
          </CardHeader>
          <CardBody>
            {categories.length === 0 ? (
              <EmptyState
                icon={<Wallet size={18} />}
                title="No spending this month"
                description="Transactions will appear here once receipts are processed."
                action={null}
              />
            ) : (
              <div className="flex gap-6">
                {/* Donut */}
                <div className="shrink-0 hidden sm:flex items-center justify-center">
                  <SpendingDonut categories={categories} size={112} />
                </div>
                {/* Bars */}
                <div className="flex-1 min-w-0 space-y-3">
                  {categories.map((cat) => (
                    <CategoryBar
                      key={cat.id ?? cat.name}
                      name={cat.name ?? cat.category_name ?? "Other"}
                      total={cat.total ?? 0}
                      share={cat.share ?? cat.percentage ?? 0}
                      colour={cat.colour}
                      currency={spendCurrency ?? undefined}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-ink-100">
              <Button variant="ghost" size="sm" asChild>
                <Link to="/budgets">
                  View budgets &amp; goals <ArrowUpRight size={13} />
                </Link>
              </Button>
            </div>
          </CardBody>
        </Card>

        {/* Recent activity */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recent activity</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/receipts">
                See all <ArrowUpRight size={13} />
              </Link>
            </Button>
          </CardHeader>
          {txLoading ? (
            <div className="divide-y divide-ink-100">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-3">
                  <Skeleton className="h-8 w-8 rounded" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-36" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          ) : transactions.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<Receipt size={18} />}
                title="No recent transactions"
                description="Upload a slip to get started."
                action={null}
              />
            </CardBody>
          ) : (
            <ul className="divide-y divide-ink-100">
              {transactions.map((tx) => (
                <li key={tx.id}>
                  <TxRow tx={tx} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const { data: orgs, isLoading: orgsLoading } = useOrgs();
  const setUploadOpen = useUIStore((s) => s.setUploadOpen);
  const user = useAuthStore((s) => s.user);

  const activeOrg = orgs?.organizations?.find((o) => o.id === orgId)
    ?? orgs?.organizations?.[0]
    ?? null;

  const orgKind = activeOrg?.kind ?? null;          // "personal" | "business" | null
  const isPersonal = orgKind !== "business";        // default to personal view if unknown

  const firstName = (user?.full_name || user?.email?.split("@")[0] || "")
    .trim()
    .split(/\s+/)[0];
  const greeting = `${timeGreeting()}${firstName ? `, ${firstName}` : ""}.`;

  return (
    <div className="page-shell max-w-[1280px]">
      <PageHeader
        eyebrow={activeOrg ? `${activeOrg.name} · ${orgKind ?? "personal"}` : "Overview"}
        title={greeting}
        description={
          orgsLoading
            ? "Loading your workspace…"
            : isPersonal
              ? "Your personal financial overview."
              : "Business workspace — use Ledger and Reports for accounting."
        }
        actions={
          isPersonal && (
            <Button variant="accent" onClick={() => setUploadOpen(true)}>
              <Plus size={14} /> Upload receipt
            </Button>
          )
        }
      />

      {orgsLoading ? (
        <PersonalSkeleton />
      ) : !orgId ? (
        <Card>
          <CardBody>
            <EmptyState
              icon={<Wallet size={20} />}
              title="No workspace selected"
              description="Select or create an organisation to get started."
            />
          </CardBody>
        </Card>
      ) : isPersonal ? (
        <PersonalDashboard orgId={orgId} />
      ) : (
        <BusinessSummary orgName={activeOrg?.name} />
      )}
    </div>
  );
}
