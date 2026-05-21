// Receipt Detail + Correction Page — FE-2
// Two-pane layout:
//   LEFT  — document image preview + extracted fields + line items
//   RIGHT — transactions for this document, each with a category picker,
//           confidence indicator, source badge, and apply-to-merchant option.
//
// Only this file is owned by FE-2. Shared layer imports only.

import { useState, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import * as SelectPrimitive from "@radix-ui/react-select";
import {
  ArrowLeft, AlertCircle, ImageOff, ExternalLink,
  Copy, Check, Download, Printer, MoreHorizontal,
  RefreshCw, Zap, ChevronDown, CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { Badge } from "@/components/ui/Badge";
import { StatusPill } from "@/components/StatusPill";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/DropdownMenu";

import {
  useDocument,
  useTransactions,
  useCategories,
  usePatchClassification,
  useClassifyDocument,
  useTriggerExtract,
} from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import {
  formatDateLong, formatMoney, formatNumber, formatRelative,
  formatConfidence, confidenceLevel,
} from "@/lib/format";
import { cn } from "@/lib/cn";

// ── Page shell ───────────────────────────────────────────────────────────────

export default function ReceiptDetailPage() {
  const { id } = useParams();
  const orgId = useOrgStore((s) => s.activeOrgId);
  const { data: doc, isLoading, isError } = useDocument(orgId, id ?? null);

  return (
    <div className="page-shell max-w-[1480px]">
      <div className="mb-6">
        <Link
          to="/receipts"
          className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900 transition-colors"
        >
          <ArrowLeft size={14} />
          All receipts
        </Link>
      </div>

      {isLoading ? (
        <DetailSkeleton />
      ) : isError || !doc ? (
        <ErrorBanner message={isError ? "Could not load receipt." : "Receipt not found."} />
      ) : (
        <DetailView doc={doc} orgId={orgId} docId={id} />
      )}
    </div>
  );
}

// ── Main detail view ─────────────────────────────────────────────────────────

function DetailView({ doc, orgId, docId }) {
  const [copied, setCopied] = useState(false);

  const extractMutation = useTriggerExtract(orgId);
  const classifyMutation = useClassifyDocument(orgId);

  const copyId = async () => {
    await navigator.clipboard.writeText(doc.id);
    setCopied(true);
    toast.success("ID copied", { description: doc.id });
    setTimeout(() => setCopied(false), 1200);
  };

  const onReExtract = () => {
    extractMutation.mutate(docId, {
      onSuccess: () => toast.success("Re-extraction started", { description: "Fields will refresh shortly." }),
      onError: (e) => toast.error("Re-extraction failed", { description: e.message }),
    });
  };

  const onReClassify = () => {
    classifyMutation.mutate(docId, {
      onSuccess: () => toast.success("Re-classification done", { description: "Transaction categories updated." }),
      onError: (e) => toast.error("Re-classification failed", { description: e.message }),
    });
  };

  return (
    <>
      {/* ── Header ── */}
      <header className="flex flex-wrap items-end justify-between gap-6 pb-8">
        <div className="min-w-0">
          <p className="label-eyebrow mb-2 flex items-center gap-1.5 group">
            Receipt
            <span className="text-ink-300">·</span>
            <button
              onClick={copyId}
              title="Copy full ID"
              className="font-mono normal-case tracking-normal text-ink-500 hover:text-ink-900 inline-flex items-center gap-1"
            >
              {doc.id.slice(0, 8)}
              {copied
                ? <Check size={11} />
                : <Copy size={11} className="opacity-0 group-hover:opacity-100 transition-opacity" />}
            </button>
          </p>
          <h1 className="text-display-lg text-ink-900 truncate">
            {doc.merchant || <span className="text-ink-400 italic">Awaiting extraction</span>}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-ink-500">
            <StatusPill status={doc.status} />
            <span className="text-ink-300">·</span>
            <span>Uploaded {formatRelative(doc.created_at)}</span>
            {doc.transaction_date && (
              <>
                <span className="text-ink-300">·</span>
                <span>Dated {formatDateLong(doc.transaction_date)}</span>
              </>
            )}
          </div>
        </div>

        {/* ── Action bar ── */}
        <div className="flex items-center gap-2 shrink-0 print:hidden">
          <Button
            variant="secondary"
            size="sm"
            onClick={onReExtract}
            loading={extractMutation.isPending}
            title="Re-run the extraction pipeline on this document"
          >
            <RefreshCw size={13} />
            Re-extract
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onReClassify}
            loading={classifyMutation.isPending}
            title="Re-run the classification cascade for this document"
          >
            <Zap size={13} />
            Re-classify
          </Button>

          {doc.image_url && (
            <Button variant="secondary" size="sm" asChild>
              <a href={doc.image_url} download target="_blank" rel="noreferrer">
                <Download size={13} /> Download
              </a>
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" aria-label="More actions">
                <MoreHorizontal size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <DropdownMenuLabel>Receipt actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={copyId}>
                <Copy size={14} /> Copy receipt ID
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.print()}>
                <Printer size={14} /> Print
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {doc.image_url && (
                <DropdownMenuItem asChild>
                  <a href={doc.image_url} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} /> Open original
                  </a>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* ── Extraction error banner ── */}
      {doc.extraction_error && (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2.5">
          <AlertCircle size={16} className="text-amber-600 mt-0.5 shrink-0" />
          <div className="text-sm">
            <div className="font-medium tracking-tight text-amber-900">Extraction couldn't complete</div>
            <div className="text-amber-700 mt-0.5">{doc.extraction_error}</div>
          </div>
        </div>
      )}

      {/* ── Two-pane body ── */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-[1fr_480px] xl:grid-cols-[1fr_520px]">
        {/* LEFT: image + extracted data */}
        <div className="space-y-6 min-w-0">
          <ImagePane doc={doc} />
          <SummaryCard doc={doc} />
          {doc.raw_extraction?.line_items?.length > 0 && <LineItemsCard doc={doc} />}
          <RawCard doc={doc} />
        </div>

        {/* RIGHT: transactions + correction UI */}
        <div className="min-w-0">
          <TransactionsPanel orgId={orgId} docId={doc.id} doc={doc} />
        </div>
      </div>
    </>
  );
}

// ── LEFT pane ─────────────────────────────────────────────────────────────────

function ImagePane({ doc }) {
  const url = doc.image_url ?? doc.file_url ?? doc.storage_url;
  const isPdf = (doc.object_key ?? "").toLowerCase().endsWith(".pdf");

  return (
    <Card className="p-3 lg:p-4 bg-ink-50/60">
      <div className="aspect-[3/4] lg:aspect-auto lg:min-h-[600px] flex items-center justify-center rounded bg-ink-100 overflow-hidden relative">
        {!url ? (
          <div className="flex flex-col items-center text-ink-400">
            <ImageOff size={28} />
            <span className="mt-2 text-sm">No preview available</span>
          </div>
        ) : isPdf ? (
          <iframe src={url} className="w-full h-full min-h-[600px] bg-white" title="Receipt" />
        ) : (
          <img
            src={url}
            alt={doc.merchant || "Receipt"}
            className="max-w-full max-h-full object-contain"
          />
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="absolute top-3 right-3 inline-flex items-center gap-1 px-2 py-1 rounded bg-ink-950/80 text-ink-0 text-[11px] font-medium hover:bg-ink-950 transition-colors"
          >
            <ExternalLink size={11} /> Open original
          </a>
        )}
      </div>
    </Card>
  );
}

function SummaryCard({ doc }) {
  // Prefer top-level fields; fall back to extraction blob
  const ext = doc.raw_extraction ?? doc.extraction ?? {};
  const fields = [
    { label: "Merchant",       value: doc.merchant ?? ext.merchant ?? <Empty /> },
    { label: "Date",           value: (doc.transaction_date ?? ext.date) ? formatDateLong(doc.transaction_date ?? ext.date) : <Empty /> },
    { label: "Total",          value: <span className="font-mono text-ink-900">{formatMoney(doc.amount ?? ext.total, doc.currency ?? ext.currency)}</span> },
    { label: "Tax",            value: (doc.tax ?? ext.tax) != null ? <span className="font-mono">{formatMoney(doc.tax ?? ext.tax, doc.currency ?? ext.currency)}</span> : <Empty /> },
    { label: "Currency",       value: doc.currency ?? ext.currency ?? <Empty /> },
    { label: "Payment method", value: (doc.payment_method ?? ext.payment_method) ? <span className="capitalize">{doc.payment_method ?? ext.payment_method}</span> : <Empty /> },
    { label: "Confidence",     value: ext.confidence != null ? <ConfidencePill value={ext.confidence} /> : <Empty /> },
  ];

  return (
    <Card>
      <div className="px-5 py-4 border-b border-ink-100">
        <h3 className="text-sm font-medium tracking-tight text-ink-900">Extracted details</h3>
      </div>
      <dl className="divide-y divide-ink-100">
        {fields.map((f) => (
          <div key={f.label} className="grid grid-cols-[140px_1fr] gap-4 px-5 py-3 text-sm">
            <dt className="text-ink-500">{f.label}</dt>
            <dd className="text-ink-900 break-words">{f.value}</dd>
          </div>
        ))}
        {doc.notes && (
          <div className="grid grid-cols-[140px_1fr] gap-4 px-5 py-3 text-sm">
            <dt className="text-ink-500">Notes</dt>
            <dd className="text-ink-700 leading-relaxed">{doc.notes}</dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

function LineItemsCard({ doc }) {
  const ext = doc.raw_extraction ?? doc.extraction ?? {};
  const items = ext.line_items ?? [];
  const currency = doc.currency ?? ext.currency;

  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-4 border-b border-ink-100 flex items-baseline justify-between">
        <h3 className="text-sm font-medium tracking-tight text-ink-900">Line items</h3>
        <span className="text-[11px] text-ink-500 tnum">{items.length}</span>
      </div>
      <table className="w-full text-sm tnum">
        <tbody>
          {items.map((it, i) => (
            <tr key={i} className="border-t border-ink-100 first:border-0">
              <td className="px-5 py-2.5 text-ink-900 truncate max-w-[200px]">{it.description || "—"}</td>
              <td className="px-2 py-2.5 text-ink-500 text-right whitespace-nowrap">
                {it.qty != null ? formatNumber(it.qty) : "—"}
                <span className="text-ink-300 mx-1">×</span>
                <span className="font-mono">{it.unit_price != null ? formatMoney(it.unit_price, currency) : "—"}</span>
              </td>
              <td className="px-5 py-2.5 text-right font-mono text-ink-900">
                {it.total != null ? formatMoney(it.total, currency) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function RawCard({ doc }) {
  const [copied, setCopied] = useState(false);
  const raw = doc.raw_extraction ?? doc.extraction;
  const json = raw ? JSON.stringify(raw, null, 2) : null;

  const onCopy = async () => {
    if (!json) return;
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <details className="group">
      <summary className="cursor-pointer list-none flex items-center justify-between gap-2 px-5 py-3 rounded-md bg-ink-50 hover:bg-ink-100 transition-colors">
        <div>
          <div className="text-[12px] font-medium tracking-tight text-ink-700">Raw extraction</div>
          <div className="text-[11px] text-ink-500">JSON returned by the model</div>
        </div>
        <span className="text-[11px] text-ink-400 group-open:rotate-180 transition-transform">▾</span>
      </summary>
      {json ? (
        <Card className="mt-2 overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-100 flex items-center justify-between">
            <span className="text-[11px] tracking-tight text-ink-500 font-mono">{doc.id.slice(0, 8)}.json</span>
            <button
              onClick={onCopy}
              className="inline-flex items-center gap-1 text-[11px] text-ink-500 hover:text-ink-900"
            >
              {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
            </button>
          </div>
          <pre className="text-[12px] leading-relaxed font-mono text-ink-700 p-4 max-h-[320px] overflow-auto">{json}</pre>
        </Card>
      ) : (
        <Card className="mt-2 p-4 text-[12px] text-ink-500">No raw extraction yet.</Card>
      )}
    </details>
  );
}

// ── RIGHT pane: transactions panel ───────────────────────────────────────────

function TransactionsPanel({ orgId, docId, doc }) {
  const { data: allTxs = [], isLoading, isError } = useTransactions(orgId);
  const { data: categories = [], isLoading: catsLoading } = useCategories(orgId);
  const patchMutation = usePatchClassification(orgId);

  // Filter client-side by document_id
  const txs = allTxs.filter((t) => t.document_id === docId);

  const handleCategoryChange = useCallback(
    (tx, categoryId, applyToExisting) => {
      const cat = categories.find((c) => c.id === categoryId);
      patchMutation.mutate(
        { txId: tx.id, categoryId, categoryName: cat?.name, applyToExisting },
        {
          onSuccess: (res) => {
            const merchant = tx.merchant ?? doc.merchant ?? "this merchant";
            if (applyToExisting && res?.backfill) {
              toast.success("Category applied to all", {
                description: `Updated all past transactions from ${merchant}.`,
              });
            } else {
              toast.success("Category updated", {
                description: cat?.name ? `Set to "${cat.name}".` : "Classification saved.",
              });
            }
          },
          onError: (e) => toast.error("Failed to update category", { description: e.message }),
        },
      );
    },
    [patchMutation, categories, doc.merchant],
  );

  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-4 border-b border-ink-100 flex items-baseline justify-between">
        <h3 className="text-sm font-medium tracking-tight text-ink-900">Transactions</h3>
        {!isLoading && (
          <span className="text-[11px] text-ink-500 tnum">
            {txs.length === 0 ? "none" : txs.length}
          </span>
        )}
      </div>

      {isLoading || catsLoading ? (
        <div className="p-5 space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : isError ? (
        <div className="p-5">
          <ErrorBanner message="Could not load transactions." />
        </div>
      ) : txs.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center px-6 py-12 text-ink-500">
          <CheckCircle2 size={28} className="mb-3 text-ink-300" />
          <p className="text-sm font-medium text-ink-700">No transactions yet</p>
          <p className="text-[12px] mt-1">Run "Re-classify" to generate transactions from this receipt.</p>
        </div>
      ) : (
        <div className="divide-y divide-ink-100">
          {txs.map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              categories={categories}
              isPending={patchMutation.isPending && patchMutation.variables?.txId === tx.id}
              onCategoryChange={handleCategoryChange}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Transaction row ──────────────────────────────────────────────────────────

function TransactionRow({ tx, categories, isPending, onCategoryChange }) {
  const [applyToAll, setApplyToAll] = useState(false);

  const handleSelect = (categoryId) => {
    onCategoryChange(tx, categoryId, applyToAll);
  };

  return (
    <div className={cn("px-5 py-4 space-y-3", isPending && "opacity-60 pointer-events-none")}>
      {/* Row header: merchant + amount */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900 truncate">
            {tx.merchant ?? tx.description ?? "—"}
          </div>
          {tx.posted_date && (
            <div className="text-[11px] text-ink-500 mt-0.5">{formatDateLong(tx.posted_date)}</div>
          )}
        </div>
        <div className="text-sm font-mono text-ink-900 shrink-0">
          {tx.direction === "credit" ? "+" : ""}
          {formatMoney(tx.amount, tx.currency)}
        </div>
      </div>

      {/* Classification meta: confidence + source */}
      <div className="flex flex-wrap items-center gap-2">
        <ConfidencePill value={tx.classification_confidence} />
        <SourceBadge source={tx.classification_source} />
      </div>

      {/* Category picker */}
      <div className="space-y-2">
        <CategorySelect
          categories={categories}
          value={tx.category_id ?? ""}
          disabled={isPending}
          onValueChange={handleSelect}
        />

        {/* Apply-to-merchant toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none group">
          <span
            role="checkbox"
            aria-checked={applyToAll}
            tabIndex={0}
            onClick={() => setApplyToAll((v) => !v)}
            onKeyDown={(e) => (e.key === " " || e.key === "Enter") && setApplyToAll((v) => !v)}
            className={cn(
              "h-4 w-4 rounded border flex items-center justify-center transition-colors",
              applyToAll
                ? "bg-ink-950 border-ink-950 text-ink-0"
                : "border-ink-300 bg-ink-0 group-hover:border-ink-500",
            )}
          >
            {applyToAll && <Check size={10} strokeWidth={3} />}
          </span>
          <span className="text-[12px] text-ink-600 group-hover:text-ink-900 leading-tight">
            Apply to all existing transactions from{" "}
            <span className="font-medium">{tx.merchant_normalized ?? tx.merchant ?? "this merchant"}</span>
          </span>
        </label>
      </div>
    </div>
  );
}

// ── Category Select (Radix primitive) ────────────────────────────────────────

function CategorySelect({ categories, value, onValueChange, disabled }) {
  // Group by parent: parents first, then orphaned leaves
  const parents = categories.filter((c) => !c.parent_id);
  const children = categories.filter((c) => c.parent_id);
  const grouped = parents.map((p) => ({
    ...p,
    items: children.filter((c) => c.parent_id === p.id),
  }));
  // Leaves without a matching parent
  const orphans = children.filter((c) => !parents.find((p) => p.id === c.parent_id));
  const flat = grouped.length === 0 && orphans.length > 0;

  const selectedCat = categories.find((c) => c.id === value);

  return (
    <SelectPrimitive.Root value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={cn(
          "w-full flex items-center justify-between gap-2 h-9 px-3 rounded-md border text-sm",
          "bg-ink-0 border-ink-200 text-ink-900",
          "hover:border-ink-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900/20",
          "disabled:opacity-50 disabled:pointer-events-none",
          "transition-colors",
        )}
        aria-label="Category"
      >
        <SelectPrimitive.Value placeholder="Uncategorised">
          {selectedCat ? (
            <span className="flex items-center gap-1.5">
              {selectedCat.icon && <span>{selectedCat.icon}</span>}
              <span className="truncate">{selectedCat.name}</span>
            </span>
          ) : (
            <span className="text-ink-400">Uncategorised</span>
          )}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon>
          <ChevronDown size={14} className="text-ink-400 shrink-0" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "z-50 w-[var(--radix-select-trigger-width)] max-h-72 overflow-y-auto",
            "rounded-md border border-ink-200 bg-ink-0 shadow-popover py-1",
            "animate-slide-up",
          )}
        >
          <SelectPrimitive.Viewport>
            {/* Unset option */}
            <SelectItem value="__none__" label="Uncategorised" />

            {flat ? (
              // No parents — flat list
              categories.map((c) => (
                <SelectItem key={c.id} value={c.id} label={c.name} icon={c.icon} />
              ))
            ) : (
              <>
                {grouped.map((parent) => (
                  <SelectPrimitive.Group key={parent.id}>
                    <SelectPrimitive.Label className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-ink-400 select-none">
                      {parent.icon && <span className="mr-1">{parent.icon}</span>}
                      {parent.name}
                    </SelectPrimitive.Label>
                    {parent.items.length > 0 ? (
                      parent.items.map((c) => (
                        <SelectItem key={c.id} value={c.id} label={c.name} icon={c.icon} indent />
                      ))
                    ) : (
                      // Parent itself is selectable when it has no children
                      <SelectItem key={parent.id} value={parent.id} label={parent.name} icon={parent.icon} />
                    )}
                  </SelectPrimitive.Group>
                ))}
                {orphans.map((c) => (
                  <SelectItem key={c.id} value={c.id} label={c.name} icon={c.icon} />
                ))}
              </>
            )}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function SelectItem({ value, label, icon, indent }) {
  return (
    <SelectPrimitive.Item
      value={value}
      className={cn(
        "relative flex items-center gap-2 px-3 py-2 text-sm text-ink-900",
        "cursor-default select-none rounded outline-none",
        "data-[highlighted]:bg-ink-100 data-[highlighted]:text-ink-900",
        "data-[state=checked]:font-medium",
        indent && "pl-6",
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="ml-auto">
        <Check size={12} className="text-ink-700" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

// ── Shared micro-components ──────────────────────────────────────────────────

// Confidence pill — coloured by level (high/medium/low/unknown)
function ConfidencePill({ value }) {
  const level = confidenceLevel(value);
  const label = formatConfidence(value);
  const tone =
    level === "high" ? "success"
    : level === "medium" ? "warning"
    : level === "low" ? "danger"
    : "neutral";
  return <Badge tone={tone}>{label}</Badge>;
}

// Source badge — one of user / rule / signal / llm
const SOURCE_LABELS = {
  user:   { label: "User",   tone: "accent" },
  rule:   { label: "Rule",   tone: "neutral" },
  signal: { label: "Signal", tone: "neutral" },
  llm:    { label: "AI",     tone: "neutral" },
};

function SourceBadge({ source }) {
  const { label, tone } = SOURCE_LABELS[source] ?? { label: source ?? "Unknown", tone: "neutral" };
  return <Badge tone={tone}>{label}</Badge>;
}

function Empty() {
  return <span className="text-ink-400">—</span>;
}

function ErrorBanner({ message }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-2.5">
      <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
      <span className="text-sm text-red-700">{message}</span>
    </div>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function DetailSkeleton() {
  return (
    <>
      <div className="pb-8">
        <Skeleton className="h-3 w-24 mb-3" />
        <Skeleton className="h-9 w-72 mb-4" />
        <Skeleton className="h-4 w-44" />
      </div>
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-[1fr_480px]">
        <div className="space-y-6">
          <Skeleton className="h-[500px]" />
          <Skeleton className="h-36" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-8" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </div>
    </>
  );
}
