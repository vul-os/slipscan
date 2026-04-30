import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  Sparkles, Search, Receipt as ReceiptIcon, ArrowRight, AlertCircle, Clock,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useOrgStore } from "@/stores/org";
import { formatDate, formatMoney } from "@/lib/format";
import { cn } from "@/lib/cn";

const SUGGESTIONS = [
  "How much did I spend last month?",
  "Show me top 5 merchants by spend",
  "Total spend on meals this year",
  "Receipts over R500 in the last 30 days",
  "Spend by category this quarter",
];

export default function AskPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const [question, setQuestion] = useState("");

  const ask = useMutation({
    mutationFn: (q) => api.ask(orgId, q),
  });

  const submit = (q) => {
    const trimmed = (q ?? question).trim();
    if (!trimmed) return;
    setQuestion(trimmed);
    ask.mutate(trimmed);
  };

  const onSubmit = (e) => { e.preventDefault(); submit(); };

  return (
    <div className="page-shell max-w-[920px]">
      <PageHeader
        eyebrow="AI search"
        title="Ask your receipts"
        description="Plain-English questions across every receipt your workspace has uploaded."
      />

      <form onSubmit={onSubmit} className="mb-6">
        <div className="relative">
          <Sparkles size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-accent-ring pointer-events-none" />
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How much did I spend on Uber last month?"
            autoFocus
            className={cn(
              "w-full h-12 pl-10 pr-28 rounded-md border border-ink-200 bg-ink-0 text-sm text-ink-900",
              "placeholder:text-ink-400",
              "transition-colors duration-150",
              "hover:border-ink-300",
              "focus:border-ink-900 focus:outline-none focus-visible:shadow-focus",
            )}
            maxLength={500}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
            disabled={!question.trim() || ask.isPending}
            loading={ask.isPending}
          >
            Ask
          </Button>
        </div>
      </form>

      {!ask.data && !ask.isPending && !ask.error && (
        <div className="space-y-2">
          <p className="label-eyebrow !text-ink-500 mb-1">Try one of these</p>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              className="w-full text-left px-4 py-3 rounded-md border border-ink-200 bg-ink-0 hover:border-ink-300 hover:bg-ink-50 transition-colors flex items-center gap-3 group"
            >
              <Search size={14} className="text-ink-400 group-hover:text-ink-700 shrink-0" />
              <span className="flex-1 text-sm text-ink-700 group-hover:text-ink-900 tracking-tight">{s}</span>
              <ArrowRight size={13} className="text-ink-300 group-hover:text-ink-700 shrink-0" />
            </button>
          ))}
        </div>
      )}

      {ask.isPending && <ResultSkeleton />}

      {ask.error && (
        <Card className="p-5">
          {ask.error.isRateLimited ? (
            <div className="flex items-start gap-3 text-[14px]">
              <Clock size={16} className="mt-0.5 shrink-0 text-amber-600" />
              <div>
                <div className="font-medium tracking-tight text-ink-900">AI search is at its daily limit</div>
                <div className="mt-1 text-ink-700">
                  The free Gemini quota resets at midnight Pacific Time. Receipts list and other features still work — only natural-language search is paused.
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 text-[14px] text-danger">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-medium tracking-tight">Couldn't translate that question</div>
                <div className="mt-1 text-ink-700">{ask.error.message || "Try rephrasing — be specific about dates, merchants, or amounts."}</div>
              </div>
            </div>
          )}
        </Card>
      )}

      {ask.data && !ask.isPending && <ResultView data={ask.data} />}
    </div>
  );
}

function ResultView({ data }) {
  return (
    <div className="space-y-5">
      <Card className="p-5 bg-accent-muted/30 border-accent-ring/20">
        <p className="label-eyebrow !text-ink-700 mb-2 flex items-center gap-1.5">
          <Sparkles size={11} className="text-accent-ring" /> Answer
        </p>
        <p className="text-base text-ink-900 tracking-tight leading-relaxed">{data.summary}</p>
        <FilterChips filters={data.filters} intent={data.intent} />
      </Card>

      {data.totals && (data.intent === "sum") && (
        <Card className="p-5">
          <p className="label-eyebrow mb-2">Total</p>
          <div className="flex items-baseline gap-3">
            <span className="text-display tracking-tighter text-ink-900 tnum">
              {formatMoney(data.totals.amount ?? 0, data.totals.currency)}
            </span>
            <span className="text-sm text-ink-500 tnum">
              across {data.totals.count} {data.totals.count === 1 ? "receipt" : "receipts"}
            </span>
          </div>
        </Card>
      )}

      {data.totals && data.intent === "count" && (
        <Card className="p-5">
          <p className="label-eyebrow mb-2">Count</p>
          <div className="text-display tracking-tighter text-ink-900 tnum">{data.totals.count}</div>
        </Card>
      )}

      {data.groups?.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-5 py-4 border-b border-ink-100">
            <h3 className="text-sm font-medium tracking-tight text-ink-900">
              {data.intent === "top_merchants" && "Top merchants"}
              {data.intent === "by_category" && "By category"}
              {data.intent === "by_month" && "By month"}
            </h3>
          </div>
          <GroupTable groups={data.groups} />
        </Card>
      )}

      {data.documents?.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-5 py-4 border-b border-ink-100 flex items-baseline justify-between">
            <h3 className="text-sm font-medium tracking-tight text-ink-900">Matching receipts</h3>
            <span className="text-[12px] text-ink-500 tnum">{data.documents.length} shown</span>
          </div>
          <ul className="divide-y divide-ink-100">
            {data.documents.map((d) => (
              <li key={d.id}>
                <Link
                  to={`/receipts/${d.id}`}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-ink-50 transition-colors group"
                >
                  <div className="h-9 w-9 rounded bg-ink-100 flex items-center justify-center text-ink-400 shrink-0">
                    <ReceiptIcon size={15} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium tracking-tight text-ink-900 truncate group-hover:underline underline-offset-4 decoration-ink-300">
                      {d.merchant || <span className="italic text-ink-400">Awaiting extraction</span>}
                    </div>
                    <div className="text-[12px] text-ink-500 truncate">
                      {d.transaction_date ? formatDate(d.transaction_date) : "—"}
                      {d.category && <> · <span className="capitalize">{d.category}</span></>}
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
        </Card>
      )}

      {!data.documents?.length && !data.groups?.length && !data.totals && (
        <Card className="p-8 text-center">
          <p className="text-sm text-ink-500">No matching receipts.</p>
        </Card>
      )}
    </div>
  );
}

function GroupTable({ groups }) {
  const max = Math.max(1, ...groups.map((g) => g.total));
  return (
    <ul className="divide-y divide-ink-100">
      {groups.map((g) => (
        <li key={g.key} className="px-5 py-3">
          <div className="flex items-baseline justify-between gap-4 mb-1.5">
            <span className="text-sm font-medium tracking-tight text-ink-900 truncate capitalize">{g.key}</span>
            <span className="text-sm tnum text-ink-900 shrink-0">
              {formatMoney(g.total, "")}
              <span className="text-[12px] text-ink-500 ml-2">
                {g.count} {g.count === 1 ? "receipt" : "receipts"}
              </span>
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
            <div className="h-full bg-accent" style={{ width: `${(g.total / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function FilterChips({ filters, intent }) {
  const chips = [];
  if (filters.merchant_contains) chips.push(`merchant: ${filters.merchant_contains}`);
  if (filters.category) chips.push(`category: ${filters.category}`);
  if (filters.date_from && filters.date_to) chips.push(`${filters.date_from} → ${filters.date_to}`);
  else if (filters.date_from) chips.push(`from ${filters.date_from}`);
  else if (filters.date_to) chips.push(`up to ${filters.date_to}`);
  if (filters.amount_min != null) chips.push(`min ${filters.amount_min}`);
  if (filters.amount_max != null) chips.push(`max ${filters.amount_max}`);
  if (filters.currency) chips.push(filters.currency);
  if (filters.status) chips.push(filters.status);

  if (chips.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-ink-900 text-ink-0 text-[11px] font-medium tracking-tight">
        {intent.replace("_", " ")}
      </span>
      {chips.map((c) => (
        <span key={c} className="inline-flex items-center px-2 py-0.5 rounded-full bg-ink-0 border border-ink-200 text-[11px] font-medium tracking-tight text-ink-700">
          {c}
        </span>
      ))}
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <Skeleton className="h-3 w-16 mb-3" />
        <Skeleton className="h-4 w-3/4 mb-2" />
        <Skeleton className="h-4 w-1/2" />
      </Card>
      <Card className="p-5">
        <Skeleton className="h-3 w-12 mb-3" />
        <Skeleton className="h-9 w-40" />
      </Card>
    </div>
  );
}
