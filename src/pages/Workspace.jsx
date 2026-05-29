import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Briefcase, Building2, User, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useWorkspace } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";

// Attention metrics, in display order, with the tone used when non-zero.
const METRICS = [
  { key: "unverified_transactions", label: "Unverified", tone: "danger" },
  { key: "unmatched_lines", label: "Unmatched", tone: "warning" },
  { key: "pending_documents", label: "Pending docs", tone: "warning" },
  { key: "suggested_matches", label: "To review", tone: "neutral" },
];

const num = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

function attentionTotal(org) {
  return METRICS.reduce((sum, m) => sum + num(org?.attention?.[m.key]), 0);
}

const roleTone = (role) =>
  role === "owner" || role === "admin" ? "success" : "neutral";

export default function WorkspacePage() {
  const navigate = useNavigate();
  const activeOrgId = useOrgStore((s) => s.activeOrgId);
  const setActiveOrg = useOrgStore((s) => s.setActiveOrg);
  const { data: orgs = [], isLoading } = useWorkspace();

  // Cross-client totals for the summary strip.
  const totals = useMemo(() => {
    const t = {};
    for (const m of METRICS) t[m.key] = orgs.reduce((s, o) => s + num(o?.attention?.[m.key]), 0);
    return t;
  }, [orgs]);

  // Most-needs-attention first.
  const sorted = useMemo(
    () => [...orgs].sort((a, b) => attentionTotal(b) - attentionTotal(a)),
    [orgs],
  );

  function openClient(org) {
    setActiveOrg(org.id);
    navigate("/dashboard");
  }

  return (
    <div className="page-shell max-w-[1280px]">
      <PageHeader
        eyebrow="Practice"
        title="Workspace"
        description="Every client you manage, with what needs attention."
      />

      {/* Summary strip — cross-client totals */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
        {METRICS.map((m) => {
          const v = totals[m.key] ?? 0;
          return (
            <Card key={m.key}>
              <CardBody>
                <div className={`text-2xl font-semibold ${v === 0 ? "text-zinc-400" : ""}`}>{v}</div>
                <div className="text-xs text-zinc-500 mt-1">
                  {m.label} · {orgs.length} client{orgs.length === 1 ? "" : "s"}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-6">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : orgs.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={Briefcase}
            title="No workspaces yet"
            description="Organizations you belong to will appear here."
          />
        </div>
      ) : (
        <>
          {orgs.length === 1 && (
            <p className="mt-6 text-sm text-zinc-500 rounded-lg bg-blue-50 border border-blue-100 px-4 py-3">
              The workspace is most useful once you manage several clients — ask a client to invite you as an
              <span className="font-medium"> accountant</span> and their org will show up here.
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-6">
            {sorted.map((org) => {
              const total = attentionTotal(org);
              const isActive = org.id === activeOrgId;
              const KindIcon = org.kind === "business" ? Building2 : User;
              return (
                <button
                  key={org.id}
                  onClick={() => openClient(org)}
                  className={`text-left rounded-xl border bg-white p-4 transition hover:shadow-sm ${
                    isActive ? "border-zinc-900 ring-1 ring-zinc-900" : "border-zinc-200 hover:border-zinc-300"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <KindIcon className="h-4 w-4 text-zinc-500" />
                    <span className="font-medium tracking-tight flex-1 truncate">{org.name}</span>
                    {isActive && <Badge tone="neutral">Active</Badge>}
                  </div>
                  <div className="flex items-center gap-1.5 mt-2">
                    <Badge tone="neutral">{org.kind}</Badge>
                    <Badge tone={roleTone(org.role)}>{org.role}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-3 min-h-[1.5rem]">
                    {total === 0 ? (
                      <span className="text-xs text-emerald-600">All clear</span>
                    ) : (
                      METRICS.map((m) => {
                        const v = num(org?.attention?.[m.key]);
                        if (v === 0) return null;
                        return (
                          <Badge key={m.key} tone={m.tone} dot>
                            {v} {m.label.toLowerCase()}
                          </Badge>
                        );
                      })
                    )}
                  </div>
                  {total > 0 && (
                    <div className="flex items-center gap-1 mt-3 text-xs text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {total} item{total === 1 ? "" : "s"} need attention
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
