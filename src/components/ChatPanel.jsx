import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { X, Sparkles, Search, Receipt as ReceiptIcon, ArrowRight, AlertCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useOrgStore } from "@/stores/org";
import { useUIStore } from "@/stores/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { cn } from "@/lib/cn";

const SUGGESTIONS = [
  "How much did I spend last month?",
  "Show me top 5 merchants by spend",
  "Total spend on meals this year",
  "Receipts over R500 in the last 30 days",
  "Spend by category this quarter",
];

export function ChatPanel() {
  const chatOpen = useUIStore((s) => s.chatOpen);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
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
    <>
      {/* Backdrop — mobile only */}
      <div
        className={cn(
          "lg:hidden fixed inset-0 z-40 bg-ink-950/40 transition-opacity duration-150",
          chatOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={() => setChatOpen(false)}
        aria-hidden="true"
      />

      {/* Panel */}
      <aside
        className={cn(
          "fixed top-0 right-0 bottom-0 z-50 w-full max-w-[400px]",
          "bg-ink-0 border-l border-ink-100 flex flex-col",
          "transition-transform duration-200 ease-out-cubic",
          chatOpen ? "translate-x-0" : "translate-x-full",
        )}
        aria-label="AI chat panel"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 h-[52px] border-b border-ink-100 shrink-0">
          <Sparkles size={15} className="text-accent-ring" />
          <span className="flex-1 text-sm font-medium tracking-tight text-ink-900">Ask your receipts</span>
          <button
            onClick={() => setChatOpen(false)}
            className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-ink-100 text-ink-500"
            aria-label="Close chat panel"
          >
            <X size={15} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <form onSubmit={onSubmit}>
            <div className="relative">
              <Sparkles size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-accent-ring pointer-events-none" />
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. How much on Uber last month?"
                className={cn(
                  "w-full h-10 pl-9 pr-16 rounded-md border border-ink-200 bg-ink-0 text-sm text-ink-900",
                  "placeholder:text-ink-400 transition-colors duration-150",
                  "hover:border-ink-300 focus:border-ink-900 focus:outline-none focus-visible:shadow-focus",
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
            <div className="space-y-1.5">
              <p className="label-eyebrow !text-ink-500">Try one of these</p>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  className="w-full text-left px-3 py-2.5 rounded-md border border-ink-200 bg-ink-0 hover:border-ink-300 hover:bg-ink-50 transition-colors flex items-center gap-2.5 group"
                >
                  <Search size={13} className="text-ink-400 group-hover:text-ink-700 shrink-0" />
                  <span className="flex-1 text-[13px] text-ink-700 group-hover:text-ink-900 tracking-tight">{s}</span>
                  <ArrowRight size={12} className="text-ink-300 group-hover:text-ink-700 shrink-0" />
                </button>
              ))}
            </div>
          )}

          {ask.isPending && <ChatSkeleton />}

          {ask.error && (
            <Card className="p-4">
              {ask.error.isRateLimited ? (
                <div className="flex items-start gap-2.5 text-[13px]">
                  <Clock size={15} className="mt-0.5 shrink-0 text-amber-600" />
                  <div>
                    <div className="font-medium tracking-tight text-ink-900">AI search at daily limit</div>
                    <div className="mt-1 text-ink-700 text-[12px]">
                      The free Gemini quota resets at midnight Pacific Time.
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2.5 text-[13px] text-danger">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium tracking-tight">Couldn't translate that question</div>
                    <div className="mt-1 text-ink-700">{ask.error.message || "Try rephrasing."}</div>
                  </div>
                </div>
              )}
            </Card>
          )}

          {ask.data && !ask.isPending && <ChatResult data={ask.data} />}
        </div>
      </aside>
    </>
  );
}

function ChatResult({ data }) {
  return (
    <div className="space-y-4">
      <Card className="p-4 bg-accent-muted/30 border-accent-ring/20">
        <p className="label-eyebrow !text-ink-700 mb-1.5 flex items-center gap-1.5">
          <Sparkles size={11} className="text-accent-ring" /> Answer
        </p>
        <p className="text-[13px] text-ink-900 tracking-tight leading-relaxed">{data.summary}</p>
      </Card>

      {data.totals && data.intent === "sum" && (
        <Card className="p-4">
          <p className="label-eyebrow mb-1.5">Total</p>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold tracking-tight text-ink-900 tnum">
              {formatMoney(data.totals.amount ?? 0, data.totals.currency)}
            </span>
            <span className="text-[12px] text-ink-500 tnum">
              {data.totals.count} {data.totals.count === 1 ? "receipt" : "receipts"}
            </span>
          </div>
        </Card>
      )}

      {data.documents?.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b border-ink-100 flex items-baseline justify-between">
            <h3 className="text-[13px] font-medium tracking-tight text-ink-900">Matching receipts</h3>
            <span className="text-[11px] text-ink-500 tnum">{data.documents.length} shown</span>
          </div>
          <ul className="divide-y divide-ink-100">
            {data.documents.map((d) => (
              <li key={d.id}>
                <Link
                  to={`/receipts/${d.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50 transition-colors group"
                >
                  <div className="h-8 w-8 rounded bg-ink-100 flex items-center justify-center text-ink-400 shrink-0">
                    <ReceiptIcon size={13} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium tracking-tight text-ink-900 truncate group-hover:underline underline-offset-4 decoration-ink-300">
                      {d.merchant || <span className="italic text-ink-400">Awaiting extraction</span>}
                    </div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {d.transaction_date ? formatDate(d.transaction_date) : "—"}
                    </div>
                  </div>
                  <div className="text-right tnum shrink-0">
                    <div className="text-[13px] font-medium text-ink-900">{formatMoney(d.amount, d.currency)}</div>
                    <div className="mt-0.5"><StatusPill status={d.status} /></div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!data.documents?.length && !data.groups?.length && !data.totals && (
        <Card className="p-6 text-center">
          <p className="text-sm text-ink-500">No matching receipts.</p>
        </Card>
      )}
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <Skeleton className="h-3 w-16 mb-2.5" />
        <Skeleton className="h-4 w-3/4 mb-1.5" />
        <Skeleton className="h-4 w-1/2" />
      </Card>
    </div>
  );
}
