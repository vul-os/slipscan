import { Link, useParams } from "react-router-dom";
import { ArrowLeft, AlertCircle, ImageOff, ExternalLink, Copy, Check, Download, Printer, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/StatusPill";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/DropdownMenu";
import { useDocument } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { formatDateLong, formatMoney, formatNumber, formatRelative } from "@/lib/format";
import { cn } from "@/lib/cn";

export default function ReceiptDetailPage() {
  const { id } = useParams();
  const orgId = useOrgStore((s) => s.activeOrgId);
  const { data: doc, isLoading } = useDocument(orgId, id ?? null);

  return (
    <div className="page-shell max-w-[1480px]">
      <div className="mb-6">
        <Link to="/receipts" className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900 transition-colors">
          <ArrowLeft size={14} />
          All receipts
        </Link>
      </div>

      {isLoading || !doc ? (
        <DetailSkeleton />
      ) : (
        <DetailView doc={doc} />
      )}
    </div>
  );
}

function DetailView({ doc }) {
  const [copied, setCopied] = useState(false);

  const copyId = async () => {
    await navigator.clipboard.writeText(doc.id);
    setCopied(true);
    toast.success("ID copied", { description: doc.id });
    setTimeout(() => setCopied(false), 1200);
  };

  const print = () => window.print();

  return (
    <>
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
        <div className="flex items-center gap-2 shrink-0 print:hidden">
          {doc.image_url && (
            <Button variant="secondary" asChild>
              <a href={doc.image_url} download target="_blank" rel="noreferrer">
                <Download size={14} /> Download
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
              <DropdownMenuItem onClick={print}>
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

      {doc.extraction_error && (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2.5">
          <AlertCircle size={16} className="text-amber-600 mt-0.5 shrink-0" />
          <div className="text-sm">
            <div className="font-medium tracking-tight text-amber-900">Extraction couldn't complete</div>
            <div className="text-amber-700 mt-0.5">{doc.extraction_error}</div>
          </div>
        </div>
      )}

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-[1fr_420px]">
        <ImagePane doc={doc} />
        <div className="space-y-6">
          <SummaryCard doc={doc} />
          {doc.raw_extraction?.line_items && doc.raw_extraction.line_items.length > 0 && (
            <LineItemsCard doc={doc} />
          )}
          <RawCard doc={doc} />
        </div>
      </div>
    </>
  );
}

function ImagePane({ doc }) {
  const isPdf = doc.object_key.toLowerCase().endsWith(".pdf");
  return (
    <Card className="p-3 lg:p-4 bg-ink-50/60">
      <div className="aspect-[3/4] lg:aspect-auto lg:min-h-[600px] flex items-center justify-center rounded bg-ink-100 overflow-hidden relative">
        {!doc.image_url ? (
          <div className="flex flex-col items-center text-ink-400">
            <ImageOff size={28} />
            <span className="mt-2 text-sm">No preview available</span>
          </div>
        ) : isPdf ? (
          <iframe src={doc.image_url} className="w-full h-full min-h-[600px] bg-white" title="Receipt" />
        ) : (
          <img
            src={doc.image_url}
            alt={doc.merchant || "Receipt"}
            className="max-w-full max-h-full object-contain"
          />
        )}
        {doc.image_url && (
          <a
            href={doc.image_url}
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
  const fields = [
    { label: "Merchant",       value: doc.merchant || <Empty />, mono: false },
    { label: "Date",           value: doc.transaction_date ? formatDateLong(doc.transaction_date) : <Empty /> },
    { label: "Amount",         value: <span className="font-mono text-ink-900">{formatMoney(doc.amount, doc.currency)}</span>, mono: true },
    { label: "Tax",            value: doc.tax != null ? <span className="font-mono">{formatMoney(doc.tax, doc.currency)}</span> : <Empty /> },
    { label: "Currency",       value: doc.currency || <Empty /> },
    { label: "Payment method", value: doc.payment_method ? <span className="capitalize">{doc.payment_method}</span> : <Empty /> },
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
            <dd className={cn("text-ink-900 break-words", f.mono && "tnum")}>{f.value}</dd>
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
  const items = doc.raw_extraction?.line_items ?? [];
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
              <td className="px-5 py-2.5 text-ink-900 truncate max-w-[180px]">{it.description || "—"}</td>
              <td className="px-2 py-2.5 text-ink-500 text-right whitespace-nowrap">
                {it.qty != null ? formatNumber(it.qty) : "—"}
                <span className="text-ink-300 mx-1">×</span>
                <span className="font-mono">{it.unit_price != null ? formatMoney(it.unit_price, doc.currency) : "—"}</span>
              </td>
              <td className="px-5 py-2.5 text-right font-mono text-ink-900">
                {it.total != null ? formatMoney(it.total, doc.currency) : "—"}
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
  const json = doc.raw_extraction ? JSON.stringify(doc.raw_extraction, null, 2) : null;

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

function Empty() {
  return <span className="text-ink-400">—</span>;
}

function DetailSkeleton() {
  return (
    <>
      <div className="pb-8">
        <Skeleton className="h-3 w-24 mb-3" />
        <Skeleton className="h-9 w-72 mb-4" />
        <Skeleton className="h-4 w-44" />
      </div>
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-[1fr_420px]">
        <Skeleton className="h-[600px]" />
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      </div>
    </>
  );
}
