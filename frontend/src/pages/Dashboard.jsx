import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Receipt, TrendingUp, Clock, CheckCircle2, Plus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useDocuments, useOrgs } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { useUIStore } from "@/stores/ui";
import { useAuthStore } from "@/stores/auth";
import { formatMoney, formatRelative } from "@/lib/format";
import { StatusPill } from "@/components/StatusPill";

export default function DashboardPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const { data, isLoading } = useDocuments(orgId);
  const { data: orgs } = useOrgs();
  const setUploadOpen = useUIStore((s) => s.setUploadOpen);
  const user = useAuthStore((s) => s.user);

  const docs = data?.documents ?? [];
  const stats = useMemo(() => computeStats(docs), [docs]);
  const activeOrg = orgs?.organizations.find((o) => o.id === orgId);
  const firstName = (user?.full_name || user?.email?.split("@")[0] || "").trim().split(/\s+/)[0];
  const greeting = `${timeGreeting()}${firstName ? `, ${firstName}` : ""}.`;

  return (
    <div className="page-shell max-w-[1280px]">
      <PageHeader
        eyebrow={activeOrg ? `Workspace · ${activeOrg.name}` : "Overview"}
        title={greeting}
        description={
          isLoading
            ? "Loading your latest activity…"
            : docs.length === 0
              ? "Your first receipt is one click away. Upload to get started."
              : `You have ${stats.recent} ${stats.recent === 1 ? "receipt" : "receipts"} from the past week, ${stats.pending} awaiting review.`
        }
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link to="/receipts">
                View all <ArrowUpRight size={14} />
              </Link>
            </Button>
            <Button variant="accent" onClick={() => setUploadOpen(true)}>
              <Plus size={14} /> Upload
            </Button>
          </>
        }
      />

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 mb-10">
        <StatCard
          icon={<Receipt size={14} />}
          label="Receipts"
          value={isLoading ? null : stats.count.toString()}
          sub={`${stats.recent} this week`}
        />
        <StatCard
          icon={<TrendingUp size={14} />}
          label="Total captured"
          value={isLoading ? null : formatMoney(stats.total, stats.currency)}
          sub={`Across ${stats.currencies} ${stats.currencies === 1 ? "currency" : "currencies"}`}
        />
        <StatCard
          icon={<Clock size={14} />}
          label="Pending review"
          value={isLoading ? null : stats.pending.toString()}
          sub="Awaiting verification"
        />
        <StatCard
          icon={<CheckCircle2 size={14} />}
          label="Verified"
          value={isLoading ? null : stats.verified.toString()}
          sub="Confirmed by your team"
        />
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-medium tracking-tight text-ink-900">Recent receipts</h2>
          <Link to="/receipts" className="text-sm text-ink-500 hover:text-ink-900 underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700">
            See all
          </Link>
        </div>
        <Card className="overflow-hidden">
          {isLoading ? (
            <div className="divide-y divide-ink-100">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-5 py-3">
                  <Skeleton className="h-9 w-9 rounded" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-3 w-20" />
                </div>
              ))}
            </div>
          ) : docs.length === 0 ? (
            <EmptyState
              icon={<Receipt size={20} />}
              title="No receipts yet"
              description="Upload your first slip — drag and drop, or click to browse."
              action={<Button variant="accent" onClick={() => setUploadOpen(true)}>Upload receipt</Button>}
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {docs.slice(0, 6).map((d) => (
                <li key={d.id}>
                  <Link
                    to={`/receipts/${d.id}`}
                    className="flex items-center gap-4 px-5 py-3 hover:bg-ink-50 transition-colors group"
                  >
                    <div className="h-9 w-9 rounded bg-ink-100 flex items-center justify-center text-ink-400 shrink-0">
                      <Receipt size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium tracking-tight text-ink-900 truncate">
                        {d.merchant || <span className="text-ink-400 italic">Awaiting extraction</span>}
                      </div>
                      <div className="text-[12px] text-ink-500 truncate">
                        {formatRelative(d.created_at)}
                      </div>
                    </div>
                    <div className="text-right tnum">
                      <div className="text-sm font-medium text-ink-900">{formatMoney(d.amount, d.currency)}</div>
                      <div className="mt-0.5"><StatusPill status={d.status} /></div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, sub }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-ink-500">
        <span className="text-ink-400">{icon}</span>
        <span className="label-eyebrow !text-ink-500">{label}</span>
      </div>
      <div className="mt-3 text-display tracking-tighter text-ink-900 tnum">
        {value ?? <Skeleton className="h-8 w-32" />}
      </div>
      <div className="mt-1 text-[12px] text-ink-500">{sub}</div>
    </Card>
  );
}

function timeGreeting() {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Working late";
}

function computeStats(docs) {
  let count = 0, pending = 0, verified = 0, total = 0, recent = 0;
  const currencies = new Set();
  let primaryCurrency;
  let primaryCurrencyCount = 0;
  const counts = new Map();
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  for (const d of docs) {
    count++;
    if (d.status === "pending") pending++;
    if (d.status === "verified") verified++;
    if (new Date(d.created_at).getTime() > weekAgo) recent++;
    if (d.currency) currencies.add(d.currency);
    if (d.currency && d.amount != null) {
      counts.set(d.currency, (counts.get(d.currency) || 0) + 1);
    }
  }
  for (const [c, n] of counts) {
    if (n > primaryCurrencyCount) { primaryCurrency = c; primaryCurrencyCount = n; }
  }
  for (const d of docs) {
    if (d.currency === primaryCurrency && d.amount != null) total += d.amount;
  }
  return { count, pending, verified, recent, total, currency: primaryCurrency, currencies: currencies.size };
}
