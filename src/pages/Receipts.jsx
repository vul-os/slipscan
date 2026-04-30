import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Search, ArrowUpDown, Receipt as ReceiptIcon, AlertCircle, Download } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/StatusPill";
import { useDocuments } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { useUIStore } from "@/stores/ui";
import { formatDate, formatMoney, formatRelative } from "@/lib/format";
import { cn } from "@/lib/cn";
import { documentsToCSV, downloadCSV } from "@/lib/csv";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem,
} from "@/components/ui/DropdownMenu";

export default function ReceiptsPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const { data, isLoading } = useDocuments(orgId);
  const setUploadOpen = useUIStore((s) => s.setUploadOpen);
  const [q, setQ] = useState("");
  const [statuses, setStatuses] = useState(new Set());
  const [sort, setSort] = useState({ key: "date", dir: "desc" });

  const docs = data?.documents ?? [];
  const filtered = useMemo(() => filter(docs, q, statuses, sort), [docs, q, statuses, sort]);

  const onExport = () => {
    if (filtered.length === 0) return;
    const csv = documentsToCSV(filtered);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCSV(`slipscan-receipts-${stamp}.csv`, csv);
    toast.success("Exported", { description: `${filtered.length} ${filtered.length === 1 ? "receipt" : "receipts"} as CSV` });
  };

  const toggleStatus = (s) => {
    setStatuses((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  };

  const onSort = (key) => {
    setSort((prev) => prev.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: "desc" });
  };

  return (
    <div className="page-shell max-w-[1280px]">
      <PageHeader
        eyebrow="Workspace"
        title="Receipts"
        description="Every slip your team has uploaded. Search, filter, and click through to verify."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={onExport}
              disabled={filtered.length === 0}
              title="Export current view as CSV"
            >
              <Download size={14} /> Export
            </Button>
            <Button variant="accent" onClick={() => setUploadOpen(true)}>
              <Plus size={14} /> Upload receipt
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[260px] max-w-[420px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
          <Input
            placeholder="Search by merchant…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="md">
              <span>Status</span>
              {statuses.size > 0 && <Badge tone="neutral">{statuses.size}</Badge>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Filter by status</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {["pending", "verified", "rejected"].map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={statuses.has(s)}
                onCheckedChange={() => toggleStatus(s)}
              >
                <span className="capitalize">{s}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto text-[12px] text-ink-500 tnum">
          {!isLoading && (
            <>{filtered.length} {filtered.length === 1 ? "result" : "results"}{q || statuses.size > 0 ? ` of ${docs.length}` : ""}</>
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <ListSkeleton />
        ) : filtered.length === 0 && docs.length === 0 ? (
          <EmptyState
            icon={<ReceiptIcon size={20} />}
            title="No receipts yet"
            description="Upload your first slip to get started. We'll extract the details automatically."
            action={
              <Button variant="accent" onClick={() => setUploadOpen(true)}>
                <Plus size={14} /> Upload receipt
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            description="Try adjusting your search or filters."
            action={
              <Button variant="ghost" onClick={() => { setQ(""); setStatuses(new Set()); }}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 bg-ink-50/50">
                  <Th sortable active={sort.key === "merchant"} dir={sort.dir} onClick={() => onSort("merchant")}>Merchant</Th>
                  <Th sortable active={sort.key === "date"} dir={sort.dir} onClick={() => onSort("date")}>Date</Th>
                  <Th>Status</Th>
                  <Th>Uploaded</Th>
                  <Th sortable active={sort.key === "amount"} dir={sort.dir} onClick={() => onSort("amount")} align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => <Row key={d.id} doc={d} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ doc }) {
  return (
    <tr className="group border-b border-ink-100 last:border-0 hover:bg-ink-50/60 transition-colors">
      <td className="px-5 py-3">
        <Link to={`/receipts/${doc.id}`} className="block">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded bg-ink-100 flex items-center justify-center text-ink-400 shrink-0">
              <ReceiptIcon size={14} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium tracking-tight text-ink-900 truncate group-hover:underline underline-offset-4 decoration-ink-300">
                {doc.merchant || <span className="italic text-ink-400">Awaiting extraction</span>}
              </div>
              {doc.extraction_error && (
                <div className="flex items-center gap-1 text-[11px] text-amber-700 mt-0.5">
                  <AlertCircle size={10} /> Extraction failed — view to retry
                </div>
              )}
            </div>
          </div>
        </Link>
      </td>
      <td className="px-5 py-3 text-ink-700 tnum">{formatDate(doc.transaction_date)}</td>
      <td className="px-5 py-3"><StatusPill status={doc.status} /></td>
      <td className="px-5 py-3 text-ink-500">{formatRelative(doc.created_at)}</td>
      <td className="px-5 py-3 text-right font-medium text-ink-900 tnum">
        {formatMoney(doc.amount, doc.currency)}
      </td>
    </tr>
  );
}

function Th({ children, align, sortable, active, dir, onClick }) {
  const cls = cn(
    "px-5 py-2.5 label-eyebrow !text-ink-500 select-none",
    align === "right" ? "text-right" : "text-left",
    sortable && "cursor-pointer hover:text-ink-900",
  );
  return (
    <th onClick={onClick} className={cls}>
      <span className={cn("inline-flex items-center gap-1", align === "right" && "justify-end")}>
        {children}
        {sortable && (
          <ArrowUpDown
            size={11}
            className={cn(
              "transition-colors",
              active ? "text-ink-700" : "text-ink-300",
              active && dir === "asc" && "rotate-180",
            )}
          />
        )}
      </span>
    </th>
  );
}

function ListSkeleton() {
  return (
    <table className="w-full">
      <tbody>
        {Array.from({ length: 8 }).map((_, i) => (
          <tr key={i} className="border-b border-ink-100">
            <td className="px-5 py-3.5">
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded" />
                <Skeleton className="h-3 w-32" />
              </div>
            </td>
            <td className="px-5 py-3.5"><Skeleton className="h-3 w-16" /></td>
            <td className="px-5 py-3.5"><Skeleton className="h-4 w-16 rounded-full" /></td>
            <td className="px-5 py-3.5"><Skeleton className="h-3 w-20" /></td>
            <td className="px-5 py-3.5 text-right"><Skeleton className="h-3 w-16 ml-auto" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function filter(docs, q, statuses, sort) {
  const ql = q.trim().toLowerCase();
  let out = docs.filter((d) => {
    if (statuses.size > 0 && !statuses.has(d.status)) return false;
    if (!ql) return true;
    return (d.merchant || "").toLowerCase().includes(ql)
        || (d.notes || "").toLowerCase().includes(ql)
        || (d.payment_method || "").toLowerCase().includes(ql);
  });
  out = [...out].sort((a, b) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    if (sort.key === "amount") return ((a.amount ?? 0) - (b.amount ?? 0)) * dir;
    if (sort.key === "merchant") return (a.merchant || "").localeCompare(b.merchant || "") * dir;
    const av = a.transaction_date || a.created_at;
    const bv = b.transaction_date || b.created_at;
    return (new Date(av).getTime() - new Date(bv).getTime()) * dir;
  });
  return out;
}
