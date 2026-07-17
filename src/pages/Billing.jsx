/**
 * Billing page — plan picker + usage overview + extraction model picker.
 * Plan picker at the top shows Free/Team/Business with ZAR prices and
 * triggers Paystack checkout for paid plans. Usage stats and model picker
 * are preserved below, unchanged.
 */
import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Cpu, Database, DollarSign, FileText,
  CheckCircle2, AlertCircle, Zap, Check,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useOrgStore } from "@/stores/org";
import {
  useBillingUsage,
  useExtractionModels,
  useSetExtractionModel,
  usePlans,
  useSubscription,
  useSubscribePlan,
  useVerifySubscription,
} from "@/lib/queries";
import { cn } from "@/lib/cn";

// ── Constants ─────────────────────────────────────────────────────────────────
const ZAR_USD = 18.50; // TODO: fetch live rate from fixer/exchangerate-api

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, decimals = 0) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-ZA", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtUSD(n, decimals = 4) {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  if (v === 0) return "$0.00";
  if (v < 0.001) return `$${v.toFixed(6)}`;
  if (v < 0.01)  return `$${v.toFixed(4)}`;
  return `$${v.toFixed(decimals > 2 ? 2 : decimals)}`;
}

function fmtZAR(usd) {
  if (usd === null || usd === undefined) return null;
  return `R${(Number(usd) * ZAR_USD).toFixed(2)}`;
}

// ── Subscription status badge ─────────────────────────────────────────────────

const STATUS_TONE = {
  active:   "success",
  past_due: "warning",
  cancelled: "neutral",
  paused:    "neutral",
  inactive:  "neutral",
};

function StatusBadge({ status }) {
  if (!status || status === "inactive") return null;
  const label = status.replace("_", " ");
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{label}</Badge>;
}

// ── Plan picker ───────────────────────────────────────────────────────────────

function PlanPicker({ orgId }) {
  const { data: plans = [], isLoading: plansLoading } = usePlans(orgId);
  const { data: sub, isLoading: subLoading } = useSubscription(orgId);
  const { mutate: subscribe, isPending: subscribing } = useSubscribePlan(orgId);
  const [activeRef, setActiveRef] = useState(null);

  const currentPlan = sub?.plan ?? "free";
  const subStatus   = sub?.subscription_status ?? "inactive";
  const renewsAt    = sub?.renews_at ?? null;

  const loading = plansLoading || subLoading;

  const handleUpgrade = (plan) => {
    if (plan.code === "free") {
      // Downgrade — no Paystack flow.
      subscribe(
        { plan_code: "free" },
        {
          onSuccess: () => toast.success("Downgraded to Free plan"),
          onError: (e) => toast.error(e?.message ?? "Could not downgrade"),
        },
      );
      return;
    }

    subscribe(
      { plan_code: plan.code },
      {
        onSuccess: (data) => {
          if (data?.authorization_url) {
            window.location.href = data.authorization_url;
          }
        },
        onError: (e) => toast.error(e?.message ?? "Could not initiate payment"),
      },
    );
  };

  return (
    <section className="mb-10">
      <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Plan</h2>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {plans.map((plan) => {
              const isCurrent = plan.code === currentPlan;
              const isUpgrade = plan.price_zar > (plans.find((p) => p.code === currentPlan)?.price_zar ?? 0);
              const isDowngrade = plan.price_zar < (plans.find((p) => p.code === currentPlan)?.price_zar ?? 0);

              return (
                <div
                  key={plan.code}
                  className={cn(
                    "bg-ink-0 rounded-xl border p-6 flex flex-col transition-colors",
                    isCurrent
                      ? "border-ink-900 ring-1 ring-ink-900 ring-offset-1 shadow-sm"
                      : "border-ink-200 hover:border-ink-300",
                  )}
                >
                  {/* Name */}
                  <p className="text-[12px] font-medium text-ink-500 uppercase tracking-[0.06em]">
                    {plan.name}
                  </p>

                  {/* Price */}
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-[32px] font-medium tracking-tight text-ink-900 tnum leading-none">
                      R{plan.price_zar}
                    </span>
                    <span className="text-sm text-ink-400">/ mo</span>
                  </div>

                  {/* Current plan badge + status */}
                  <div className="mt-2 flex items-center gap-2 flex-wrap min-h-[22px]">
                    {isCurrent && <Badge tone="accent">Current plan</Badge>}
                    {isCurrent && <StatusBadge status={subStatus} />}
                  </div>

                  {/* Features */}
                  <ul className="mt-4 space-y-2 flex-1">
                    {(plan.features ?? []).map((feat) => (
                      <li key={feat} className="flex items-start gap-2">
                        <Check size={13} className="text-accent-ring mt-0.5 shrink-0" />
                        <span className="text-[12px] text-ink-600 leading-snug">{feat}</span>
                      </li>
                    ))}
                  </ul>

                  {/* CTA */}
                  <div className="mt-5">
                    {isCurrent ? (
                      <div className="text-[12px] text-ink-400 text-center py-2">
                        {subStatus === "active" && renewsAt
                          ? `Renews ${new Date(renewsAt).toLocaleDateString("en-ZA")}`
                          : "Your current plan"}
                      </div>
                    ) : plan.code === "free" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="w-full"
                        onClick={() => handleUpgrade(plan)}
                        disabled={subscribing}
                        loading={subscribing && activeRef === "free"}
                      >
                        Downgrade to Free
                      </Button>
                    ) : plan.configured ? (
                      <Button
                        variant={isUpgrade ? "accent" : "secondary"}
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          setActiveRef(plan.code);
                          handleUpgrade(plan);
                        }}
                        disabled={subscribing}
                        loading={subscribing && activeRef === plan.code}
                      >
                        {isDowngrade ? `Downgrade to ${plan.name}` : `Upgrade to ${plan.name}`}
                      </Button>
                    ) : (
                      <div className="text-[11px] text-ink-400 text-center py-2">
                        Coming soon — billing setup in progress
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {subStatus === "past_due" && (
            <p className="mt-3 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              Your last payment failed. Please update your payment method to avoid service interruption.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, iconClass, label, value, sub, loading }) {
  return (
    <Card className="px-5 py-4 flex items-start gap-3">
      <div className={cn("h-8 w-8 rounded flex items-center justify-center shrink-0 mt-0.5", iconClass)}>
        <Icon size={15} />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.07em] text-ink-400 mb-0.5">{label}</div>
        {loading ? (
          <Skeleton className="h-5 w-24 mt-1" />
        ) : (
          <>
            <div className="text-xl font-semibold tnum text-ink-900 leading-tight">{value}</div>
            {sub && <div className="text-[11px] text-ink-400 mt-0.5 tnum">{sub}</div>}
          </>
        )}
      </div>
    </Card>
  );
}

// ── Sparkline bar chart (pure divs) ───────────────────────────────────────────

function SparkBar({ days }) {
  if (!days || days.length === 0) return null;

  const max = Math.max(...days.map((d) => d.calls), 1);

  return (
    <div className="flex items-end gap-1 h-14">
      {days.map((d) => {
        const heightPct = Math.max((d.calls / max) * 100, d.calls > 0 ? 8 : 0);
        const hasFailed = d.failed > 0;
        return (
          <div key={d.date} className="flex-1 flex flex-col items-center gap-0.5 group relative">
            <div
              className={cn(
                "w-full rounded-sm transition-colors",
                hasFailed
                  ? "bg-red-300 group-hover:bg-red-400"
                  : "bg-ink-200 group-hover:bg-ink-400",
              )}
              style={{ height: `${heightPct}%` }}
            />
            {/* Tooltip on hover */}
            <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-ink-900 text-ink-0 text-[10px] rounded px-1.5 py-1 whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-10">
              {d.date.slice(5)}: {d.calls} {d.failed > 0 ? `(${d.failed} failed)` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model card ────────────────────────────────────────────────────────────────

const SPEED_TONE = {
  fastest:  "success",
  fast:     "accent",
  standard: "neutral",
  slow:     "warning",
};

const QUALITY_TONE = {
  best:   "accent",
  great:  "accent",
  good:   "neutral",
  basic:  "neutral",
};

function ModelCard({ model, selected, onSelect }) {
  const speedTone   = SPEED_TONE[model.speed]   ?? "neutral";
  const qualityTone = QUALITY_TONE[model.quality] ?? "neutral";
  const usdPerReceipt = model.cost_per_receipt ?? 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(model.id)}
      className={cn(
        "w-full text-left rounded-lg border px-4 py-3.5 transition-colors",
        selected
          ? "border-ink-900 bg-ink-50 shadow-sm"
          : "border-ink-200 bg-white hover:border-ink-400",
      )}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {selected ? (
            <CheckCircle2 size={15} className="text-ink-900 shrink-0" />
          ) : (
            <div className="h-4 w-4 rounded-full border border-ink-300 shrink-0" />
          )}
          <span className="text-sm font-medium text-ink-900 tracking-tight">
            {model.display_name}
          </span>
          {model.is_active_for_org && !selected && (
            <Badge tone="neutral" className="text-[10px]">Current</Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge tone={speedTone}>{model.speed}</Badge>
          <Badge tone={qualityTone}>{model.quality}</Badge>
        </div>
      </div>
      {model.description && (
        <p className="mt-1.5 ml-6 text-[12px] text-ink-500">{model.description}</p>
      )}
      <div className="mt-2 ml-6 flex items-baseline gap-3 flex-wrap">
        <span className="text-[12px] text-ink-500">
          ~{fmtUSD(usdPerReceipt, 5)}/receipt
        </span>
        <span className="text-[11px] text-ink-400">
          (input {fmtUSD(model.cost_per_1k_input, 6)}/k · output {fmtUSD(model.cost_per_1k_output, 6)}/k)
        </span>
      </div>
    </button>
  );
}

// ── Model picker section ───────────────────────────────────────────────────────

function ModelPicker({ orgId }) {
  const { data: modelsData, isLoading } = useExtractionModels(orgId);
  const { mutate: setModel, isPending } = useSetExtractionModel(orgId);

  const models = modelsData?.models ?? [];
  const initialActive = models.find((m) => m.is_active_for_org)?.id ?? null;

  const [selectedId, setSelectedId] = useState(null);

  // Sync selected ID when models load.
  useEffect(() => {
    if (initialActive && selectedId === null) {
      setSelectedId(initialActive);
    }
  }, [initialActive, selectedId]);

  const isDirty = selectedId !== null && selectedId !== initialActive;

  const onSave = () => {
    if (!selectedId) return;
    const found = models.find((m) => m.id === selectedId);
    setModel(selectedId, {
      onSuccess: () => {
        toast.success(
          `Default model updated. New extractions will use ${found?.display_name ?? selectedId}.`,
        );
      },
      onError: (e) => toast.error(e?.message ?? "Could not save model preference"),
    });
  };

  return (
    <section>
      <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Extraction model</h2>
      <Card>
        <div className="px-5 py-4">
          <p className="text-[12px] text-ink-500 mb-4">
            Choose which Gemini model processes your receipts. This affects accuracy, speed, and
            cost. Changes apply to new extractions only.
          </p>

          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20 rounded-lg" />
              ))}
            </div>
          ) : models.length === 0 ? (
            <div className="flex items-center gap-2 text-[13px] text-ink-400 py-4">
              <AlertCircle size={14} />
              No extraction models available. Run the billing migration and retry.
            </div>
          ) : (
            <div className="space-y-2.5">
              {models.map((m) => (
                <ModelCard
                  key={m.id}
                  model={m}
                  selected={selectedId === m.id}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          )}

          {models.length > 0 && (
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-ink-100 pt-4">
              <p className="text-[11px] text-ink-400">
                Admin role required to change the model.
              </p>
              <Button
                size="sm"
                disabled={!isDirty || isPending}
                loading={isPending}
                onClick={onSave}
              >
                Save
              </Button>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}

// ── Paystack callback handler ─────────────────────────────────────────────────

function PaystackCallbackHandler({ orgId }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const reference = searchParams.get("reference");
  const { mutate: verify } = useVerifySubscription();
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    if (!reference || verified) return;
    setVerified(true); // prevent double-fire

    verify(
      { reference },
      {
        onSuccess: () => {
          toast.success("Payment confirmed. Your plan has been upgraded.");
          // Remove ?reference= from URL without reload.
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete("reference");
            return next;
          });
        },
        onError: (e) => {
          toast.error(e?.message ?? "Could not verify payment. Contact support if you were charged.");
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete("reference");
            return next;
          });
        },
      },
    );
  }, [reference, verified, verify, setSearchParams]);

  return null;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { activeOrgId } = useOrgStore();
  const { data: usage, isLoading } = useBillingUsage(activeOrgId);

  const thisMonth   = usage?.extractions?.this_month ?? 0;
  const totalExtr   = usage?.extractions?.total ?? 0;
  const failedMonth = usage?.extractions?.failed_this_month ?? 0;
  const tokenCount  =
    (usage?.ai_tokens?.input_this_month ?? 0) +
    (usage?.ai_tokens?.output_this_month ?? 0);
  const storageMb    = usage?.storage_mb ?? 0;
  const costUsd      = usage?.estimated_cost_usd ?? 0;
  const days         = usage?.calls_last_7_days ?? [];

  const zarApprox = fmtZAR(costUsd);

  return (
    <div className="page-shell max-w-[820px]">
      {/* Handle Paystack redirect with ?reference= */}
      {activeOrgId && <PaystackCallbackHandler orgId={activeOrgId} />}

      <PageHeader
        eyebrow="Account"
        title="Billing & usage"
        description="Manage your plan, view AI usage this month, storage, and estimated cost."
      />

      {/* Plan picker */}
      {activeOrgId && <PlanPicker orgId={activeOrgId} />}

      {/* Usage stat cards */}
      <section className="mb-10">
        <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">
          Usage — {new Date().toLocaleDateString("en-ZA", { month: "long", year: "numeric" })}
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            icon={FileText}
            iconClass="bg-sky-50 text-sky-600"
            label="Extractions"
            value={isLoading ? null : `${fmt(thisMonth)}`}
            sub={isLoading ? null : `${fmt(totalExtr)} total · ${fmt(failedMonth)} failed`}
            loading={isLoading}
          />
          <StatCard
            icon={Cpu}
            iconClass="bg-violet-50 text-violet-600"
            label="AI tokens"
            value={isLoading ? null : fmt(tokenCount)}
            sub={isLoading ? null : `${fmt(usage?.ai_tokens?.input_this_month)} in · ${fmt(usage?.ai_tokens?.output_this_month)} out`}
            loading={isLoading}
          />
          <StatCard
            icon={Database}
            iconClass="bg-emerald-50 text-emerald-600"
            label="Storage"
            value={isLoading ? null : `${fmt(storageMb, 1)} MB`}
            loading={isLoading}
          />
          <StatCard
            icon={DollarSign}
            iconClass="bg-amber-50 text-amber-600"
            label="Est. cost"
            value={isLoading ? null : fmtUSD(costUsd, 4)}
            sub={isLoading ? null : zarApprox ? `~${zarApprox} (est. @ R18.50/$)` : "passed through from Gemini"}
            loading={isLoading}
          />
        </div>
      </section>

      {/* 7-day sparkline */}
      {!isLoading && days.length > 0 && (
        <section className="mb-10">
          <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">
            Extractions — last 7 days
          </h2>
          <Card className="px-5 py-4">
            <SparkBar days={days} />
            <div className="flex justify-between mt-2">
              {days.map((d) => (
                <span key={d.date} className="text-[10px] text-ink-400 flex-1 text-center">
                  {d.date.slice(5)}
                </span>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-ink-400">
              Red bars indicate days with at least one failed extraction.
            </p>
          </Card>
        </section>
      )}

      {/* Model picker */}
      {activeOrgId && <ModelPicker orgId={activeOrgId} />}

      {/* Cost transparency note */}
      <p className="mt-8 text-[11px] text-ink-400 max-w-lg">
        Costs are billed directly by Google. SlipScan does not mark up AI inference.
        The ZAR approximation uses a hardcoded R18.50/USD ratio and is for reference only.
        {/* TODO: replace hardcoded ZAR rate with a live exchange rate API */}
      </p>
    </div>
  );
}
