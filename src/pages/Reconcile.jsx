// Reconciliation review page — Phase 3 FE-B.
// Auto-matched + confirmed: read-only list. Suggested: confirm/reject per row.
// Unmatched: counts of orphaned receipts and bank lines.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, XCircle, AlertCircle, ArrowLeftRight, RefreshCw,
  Receipt, Landmark,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useReconcile, useOrgMutation, qk } from "@/lib/queries";
import { api } from "@/lib/api";
import { useOrgStore } from "@/stores/org";
import { formatMoney, formatConfidence, confidenceLevel } from "@/lib/format";

// ── Helpers ───────────────────────────────────────────────────────────────────

function confidenceTone(value) {
  const level = confidenceLevel(value);
  if (level === "high") return "success";
  if (level === "medium") return "warning";
  if (level === "low") return "danger";
  return "neutral";
}

// Display a signed amount delta: "+R 1.50", "-R 0.20", or "—"
function DeltaAmount({ delta }) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) {
    return <span className="text-ink-400">—</span>;
  }
  const abs = Math.abs(delta);
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const formatted = formatMoney(abs);
  const colorClass = abs === 0
    ? "text-ink-500"
    : abs < 1
    ? "text-emerald-700"
    : "text-amber-700";
  return (
    <span className={colorClass}>
      {sign}{formatted}
    </span>
  );
}

// Display date delta in days: "+2d", "-1d", "exact", "—"
function DeltaDays({ days }) {
  if (days === null || days === undefined || Number.isNaN(days)) {
    return <span className="text-ink-400">—</span>;
  }
  if (days === 0) return <span className="text-emerald-700">exact</span>;
  const abs = Math.abs(days);
  const sign = days > 0 ? "+" : "-";
  const colorClass = abs <= 1 ? "text-emerald-700" : abs <= 3 ? "text-amber-700" : "text-red-700";
  return <span className={colorClass}>{sign}{abs}d</span>;
}

// Merchant score pill: 0–1 float as a compact badge
function MerchantScore({ score }) {
  if (score === null || score === undefined) return null;
  const tone = confidenceTone(score);
  return (
    <Badge tone={tone} className="text-[10px] tnum">
      M {formatConfidence(score)}
    </Badge>
  );
}

// Compact ID display — first 8 chars if it looks like a UUID
function shortId(id) {
  if (!id) return "—";
  return String(id).slice(0, 8);
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, title, count, tone }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {Icon && <Icon size={16} className="text-ink-500 shrink-0" />}
      <h2 className="text-base font-medium tracking-tight text-ink-900">{title}</h2>
      {count !== undefined && (
        <Badge tone={tone ?? "neutral"} className="ml-1">
          {count}
        </Badge>
      )}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-5 py-3.5 border-b border-ink-100 last:border-0">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-5 w-12 ml-auto" />
    </div>
  );
}

function SectionSkeleton({ rows = 3 }) {
  return (
    <Card className="overflow-hidden">
      <div className="divide-y divide-ink-100">
        {Array.from({ length: rows }).map((_, i) => (
          <RowSkeleton key={i} />
        ))}
      </div>
    </Card>
  );
}

// ── Matched row (read-only) ───────────────────────────────────────────────────

function MatchedRow({ record }) {
  const level = confidenceLevel(record.confidence);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 border-b border-ink-100 last:border-0 hover:bg-ink-50/50 transition-colors">
      {/* IDs */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[12px] font-mono text-ink-600">
          <Receipt size={11} className="shrink-0 text-ink-400" />
          <span className="truncate">{shortId(record.transaction_id ?? record.id)}</span>
          <ArrowLeftRight size={10} className="text-ink-300 shrink-0" />
          <Landmark size={11} className="shrink-0 text-ink-400" />
          <span className="truncate">{shortId(record.statement_line_id ?? record.id)}</span>
        </div>
        {record.state && (
          <span className="text-[11px] text-ink-400 capitalize">{record.state}</span>
        )}
      </div>

      {/* Confidence */}
      <div className="flex items-center gap-2 shrink-0">
        {record.confidence !== undefined && record.confidence !== null && (
          <Badge tone={confidenceTone(record.confidence)} dot>
            {formatConfidence(record.confidence)}
          </Badge>
        )}
        {record.merchant_score !== undefined && (
          <MerchantScore score={record.merchant_score} />
        )}
      </div>

      {/* Deltas */}
      <div className="flex items-center gap-3 ml-auto text-[12px] tnum shrink-0">
        {record.amount_delta !== undefined && (
          <div className="flex items-center gap-1 text-ink-500">
            <span className="text-[11px] text-ink-400">Δ</span>
            <DeltaAmount delta={record.amount_delta} />
          </div>
        )}
        {record.date_delta_days !== undefined && (
          <div className="flex items-center gap-1 text-ink-500">
            <span className="text-[11px] text-ink-400">date</span>
            <DeltaDays days={record.date_delta_days} />
          </div>
        )}
        {/* State icon */}
        {level === "high" ? (
          <CheckCircle2 size={14} className="text-emerald-500" />
        ) : level === "medium" ? (
          <AlertCircle size={14} className="text-amber-500" />
        ) : null}
      </div>
    </div>
  );
}

// ── Suggested row (confirm / reject) ─────────────────────────────────────────

function SuggestedRow({ record, onConfirm, onReject, pendingId }) {
  const busy = pendingId === record.id;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 border-b border-ink-100 last:border-0 hover:bg-ink-50/50 transition-colors">
      {/* Pairing */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px] font-mono text-ink-700">
          <Receipt size={11} className="shrink-0 text-ink-400" />
          <span className="truncate">{shortId(record.transaction_id ?? record.id)}</span>
          <ArrowLeftRight size={10} className="text-ink-300 shrink-0" />
          <Landmark size={11} className="shrink-0 text-ink-400" />
          <span className="truncate">{shortId(record.statement_line_id ?? record.id)}</span>
        </div>

        {/* Confidence + scores row */}
        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          {record.confidence !== undefined && record.confidence !== null && (
            <Badge tone={confidenceTone(record.confidence)} dot>
              {formatConfidence(record.confidence)} confidence
            </Badge>
          )}
          {record.merchant_score !== undefined && (
            <MerchantScore score={record.merchant_score} />
          )}
          {record.amount_delta !== undefined && (
            <span className="text-[12px] text-ink-500 tnum flex items-center gap-1">
              <span className="text-ink-400">Δ amt</span>
              <DeltaAmount delta={record.amount_delta} />
            </span>
          )}
          {record.date_delta_days !== undefined && (
            <span className="text-[12px] text-ink-500 tnum flex items-center gap-1">
              <span className="text-ink-400">Δ date</span>
              <DeltaDays days={record.date_delta_days} />
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => onConfirm(record.id)}
          className="text-emerald-700 border-emerald-200 hover:bg-emerald-50"
        >
          <CheckCircle2 size={13} />
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onReject(record.id)}
          className="text-red-600 hover:bg-red-50"
        >
          <XCircle size={13} />
          Reject
        </Button>
      </div>
    </div>
  );
}

// ── Unmatched bucket ──────────────────────────────────────────────────────────

function UnmatchedSection({ unmatched }) {
  if (!unmatched) return null;

  const txIds = unmatched.transaction_ids ?? [];
  const lineIds = unmatched.statement_line_ids ?? [];
  const txCount = txIds.length;
  const lineCount = lineIds.length;
  const total = txCount + lineCount;

  return (
    <>
      <SectionHeader
        icon={AlertCircle}
        title="Unmatched"
        count={total}
        tone={total > 0 ? "warning" : "neutral"}
      />
      <Card className="overflow-hidden">
        {total === 0 ? (
          <EmptyState
            icon={<CheckCircle2 size={18} />}
            title="All items matched"
            description="No receipts or bank lines are without a counterpart."
          />
        ) : (
          <div className="divide-y divide-ink-100">
            {/* Receipts without a bank line */}
            <div className="flex items-start gap-4 px-5 py-4">
              <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                <Receipt size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink-900">
                  {txCount} receipt{txCount !== 1 ? "s" : ""} without a bank line
                </div>
                {txCount > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {txIds.slice(0, 8).map((id) => (
                      <span
                        key={id}
                        className="text-[11px] font-mono bg-ink-100 text-ink-600 rounded px-1.5 py-0.5"
                      >
                        {shortId(id)}
                      </span>
                    ))}
                    {txIds.length > 8 && (
                      <span className="text-[11px] text-ink-400 self-center">
                        +{txIds.length - 8} more
                      </span>
                    )}
                  </div>
                )}
              </div>
              {txCount > 0 && (
                <Badge tone="warning" className="shrink-0 self-start mt-0.5">
                  {txCount}
                </Badge>
              )}
            </div>

            {/* Bank lines without a receipt */}
            <div className="flex items-start gap-4 px-5 py-4">
              <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <Landmark size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink-900">
                  {lineCount} bank line{lineCount !== 1 ? "s" : ""} without a receipt
                </div>
                {lineCount > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {lineIds.slice(0, 8).map((id) => (
                      <span
                        key={id}
                        className="text-[11px] font-mono bg-ink-100 text-ink-600 rounded px-1.5 py-0.5"
                      >
                        {shortId(id)}
                      </span>
                    ))}
                    {lineIds.length > 8 && (
                      <span className="text-[11px] text-ink-400 self-center">
                        +{lineIds.length - 8} more
                      </span>
                    )}
                  </div>
                )}
              </div>
              {lineCount > 0 && (
                <Badge tone="neutral" className="shrink-0 self-start mt-0.5">
                  {lineCount}
                </Badge>
              )}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReconcilePage() {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const qc = useQueryClient();
  const { data, isLoading } = useReconcile(orgId);

  // Optimistic pending tracking for confirm/reject buttons
  const [pendingId, setPendingId] = useState(null);

  // Mutations — both invalidate the reconcile cache on success
  const confirmMutation = useOrgMutation(
    orgId,
    (oid, matchId) => api.confirmMatch(oid, matchId),
    [qk.reconcile(orgId)],
  );

  const rejectMutation = useOrgMutation(
    orgId,
    (oid, matchId) => api.rejectMatch(oid, matchId),
    [qk.reconcile(orgId)],
  );

  // Run reconciliation — fires the POST then invalidates the GET cache
  const [running, setRunning] = useState(false);

  async function handleRunReconcile() {
    if (!orgId) return;
    setRunning(true);
    try {
      const result = await api.runReconcile(orgId);
      const auto = result?.auto_matched ?? 0;
      const suggested = result?.suggested ?? 0;
      const skipped = result?.skipped ?? 0;
      toast.success("Reconciliation complete", {
        description: `${auto} auto-matched, ${suggested} to review, ${skipped} skipped`,
      });
      qc.invalidateQueries({ queryKey: qk.reconcile(orgId) });
    } catch (err) {
      toast.error("Reconciliation failed", { description: err?.message });
    } finally {
      setRunning(false);
    }
  }

  async function handleConfirm(matchId) {
    setPendingId(matchId);
    try {
      await confirmMutation.mutateAsync(matchId);
      toast.success("Match confirmed");
    } catch (err) {
      toast.error("Failed to confirm match", { description: err?.message });
    } finally {
      setPendingId(null);
    }
  }

  async function handleReject(matchId) {
    setPendingId(matchId);
    try {
      await rejectMutation.mutateAsync(matchId);
      toast.success("Match rejected");
    } catch (err) {
      toast.error("Failed to reject match", { description: err?.message });
    } finally {
      setPendingId(null);
    }
  }

  const matched = data?.matched ?? [];
  const suggested = data?.suggested ?? [];
  const unmatched = data?.unmatched;

  const hasData = matched.length > 0 || suggested.length > 0 ||
    (unmatched && ((unmatched.transaction_ids?.length ?? 0) + (unmatched.statement_line_ids?.length ?? 0)) > 0);

  return (
    <div className="page-shell max-w-[900px]">
      <PageHeader
        eyebrow="Bank feeds"
        title="Reconciliation"
        description="Match receipts to bank transactions. Review suggested pairings and resolve unmatched items."
        actions={
          <Button
            variant="primary"
            size="md"
            loading={running}
            disabled={!orgId || running}
            onClick={handleRunReconcile}
          >
            <RefreshCw size={14} />
            Run reconciliation
          </Button>
        }
      />

      {/* ── Loading state ── */}
      {isLoading && (
        <div className="space-y-8">
          <div>
            <Skeleton className="h-4 w-32 mb-3" />
            <SectionSkeleton rows={3} />
          </div>
          <div>
            <Skeleton className="h-4 w-40 mb-3" />
            <SectionSkeleton rows={2} />
          </div>
          <div>
            <Skeleton className="h-4 w-28 mb-3" />
            <SectionSkeleton rows={2} />
          </div>
        </div>
      )}

      {/* ── Empty state: no data yet ── */}
      {!isLoading && !hasData && (
        <Card>
          <EmptyState
            icon={<ArrowLeftRight size={20} />}
            title="No reconciliation data"
            description="Run reconciliation to automatically match receipts with bank transactions."
            action={
              <Button
                variant="primary"
                loading={running}
                disabled={!orgId || running}
                onClick={handleRunReconcile}
              >
                <RefreshCw size={14} />
                Run reconciliation
              </Button>
            }
          />
        </Card>
      )}

      {/* ── Three buckets ── */}
      {!isLoading && hasData && (
        <div className="space-y-10">

          {/* 1. Matched (auto + confirmed) — read-only */}
          <section>
            <SectionHeader
              icon={CheckCircle2}
              title="Matched"
              count={matched.length}
              tone={matched.length > 0 ? "success" : "neutral"}
            />
            {matched.length === 0 ? (
              <Card>
                <EmptyState
                  title="No matched items"
                  description="Auto-matched and confirmed pairings will appear here."
                />
              </Card>
            ) : (
              <Card className="overflow-hidden">
                {matched.map((record, i) => (
                  <MatchedRow key={record.id ?? i} record={record} />
                ))}
              </Card>
            )}
          </section>

          {/* 2. Suggested — confirm / reject */}
          <section>
            <SectionHeader
              icon={AlertCircle}
              title="Needs review"
              count={suggested.length}
              tone={suggested.length > 0 ? "warning" : "neutral"}
            />
            {suggested.length === 0 ? (
              <Card>
                <EmptyState
                  title="Nothing to review"
                  description="Suggested pairings that need your approval will appear here."
                />
              </Card>
            ) : (
              <Card className="overflow-hidden">
                {suggested.map((record, i) => (
                  <SuggestedRow
                    key={record.id ?? i}
                    record={record}
                    onConfirm={handleConfirm}
                    onReject={handleReject}
                    pendingId={pendingId}
                  />
                ))}
              </Card>
            )}
          </section>

          {/* 3. Unmatched */}
          <section>
            <UnmatchedSection unmatched={unmatched} />
          </section>
        </div>
      )}
    </div>
  );
}
