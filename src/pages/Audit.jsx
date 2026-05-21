import { useState } from "react";
import { ShieldAlert, Filter, ChevronDown, ChevronUp } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem,
} from "@/components/ui/DropdownMenu";
import { useAudit } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { formatDate, formatRelative } from "@/lib/format";

// ── Constants ─────────────────────────────────────────────────────────────────

const ENTITY_TYPES = [
  "document", "transaction", "category", "member", "invitation",
  "account", "journal", "contact", "budget", "goal",
];

const ACTIONS = [
  "create", "update", "delete", "upload", "classify",
  "verify", "reject", "invite", "revoke", "push",
];

const ACTION_TONE = {
  create:   "success",
  upload:   "success",
  invite:   "success",
  verify:   "success",
  update:   "neutral",
  classify: "neutral",
  push:     "neutral",
  delete:   "danger",
  reject:   "danger",
  revoke:   "danger",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function actionTone(action) {
  return ACTION_TONE[action?.toLowerCase()] ?? "neutral";
}

function summarise(before, after) {
  if (!before && !after) return null;
  try {
    const b = typeof before === "string" ? JSON.parse(before) : before;
    const a = typeof after === "string" ? JSON.parse(after) : after;
    const keys = new Set([...Object.keys(b || {}), ...Object.keys(a || {})]);
    const diffs = [];
    for (const k of keys) {
      const bv = b?.[k];
      const av = a?.[k];
      if (bv !== av) diffs.push(k);
    }
    if (diffs.length === 0) return null;
    return diffs.slice(0, 3).join(", ") + (diffs.length > 3 ? ` +${diffs.length - 3} more` : "");
  } catch {
    return null;
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FilterDropdown({ label, options, selected, onChange }) {
  const count = selected.size;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm">
          <Filter size={13} />
          {label}
          {count > 0 && <Badge tone="neutral">{count}</Badge>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt}
            checked={selected.has(opt)}
            onCheckedChange={() => {
              const next = new Set(selected);
              next.has(opt) ? next.delete(opt) : next.add(opt);
              onChange(next);
            }}
          >
            <span className="capitalize">{opt}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TableSkeleton() {
  return (
    <table className="w-full">
      <tbody>
        {Array.from({ length: 8 }).map((_, i) => (
          <tr key={i} className="border-b border-ink-100">
            <td className="px-5 py-3.5"><Skeleton className="h-3 w-20" /></td>
            <td className="px-5 py-3.5"><Skeleton className="h-3 w-24" /></td>
            <td className="px-5 py-3.5"><Skeleton className="h-3 w-28" /></td>
            <td className="px-5 py-3.5 hidden md:table-cell"><Skeleton className="h-3 w-40" /></td>
            <td className="px-5 py-3.5 text-right"><Skeleton className="h-3 w-16 ml-auto" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuditRow({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const diff = summarise(entry.before, entry.after);
  const actorLabel = entry.actor_name || entry.actor_email || entry.actor_id || "System";

  return (
    <>
      <tr className="border-b border-ink-100 last:border-0 hover:bg-ink-50/60 transition-colors">
        <td className="px-5 py-3">
          <Badge tone={actionTone(entry.action)}>
            <span className="capitalize">{entry.action || "—"}</span>
          </Badge>
        </td>
        <td className="px-5 py-3 text-sm text-ink-700 capitalize">
          {entry.entity_type || "—"}
        </td>
        <td className="px-5 py-3">
          <div className="text-sm font-medium tracking-tight text-ink-900 truncate max-w-[140px]">
            {actorLabel}
          </div>
          {entry.actor_email && entry.actor_name && (
            <div className="text-[11px] text-ink-400 truncate max-w-[140px]">{entry.actor_email}</div>
          )}
        </td>
        <td className="px-5 py-3 hidden md:table-cell">
          {diff ? (
            <span className="text-[12px] text-ink-500 font-mono">{diff}</span>
          ) : entry.entity_id ? (
            <span className="text-[12px] text-ink-400 font-mono truncate block max-w-[200px]">
              {entry.entity_id}
            </span>
          ) : (
            <span className="text-[12px] text-ink-300">—</span>
          )}
        </td>
        <td className="px-5 py-3 text-right">
          <div className="flex items-center justify-end gap-2">
            <span className="text-[12px] text-ink-400 tnum" title={entry.created_at}>
              {formatRelative(entry.created_at)}
            </span>
            {(entry.before || entry.after) && (
              <button
                onClick={() => setExpanded((p) => !p)}
                className="text-ink-400 hover:text-ink-700 transition-colors"
                aria-label={expanded ? "Collapse details" : "Expand details"}
              >
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (entry.before || entry.after) && (
        <tr className="border-b border-ink-100 bg-ink-50/40">
          <td colSpan={5} className="px-5 py-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px] font-mono">
              {entry.before && (
                <div>
                  <div className="text-[11px] uppercase tracking-[0.07em] text-ink-400 mb-1">Before</div>
                  <pre className="bg-white border border-ink-200 rounded p-2 text-ink-700 overflow-x-auto whitespace-pre-wrap break-all">
                    {typeof entry.before === "string"
                      ? entry.before
                      : JSON.stringify(entry.before, null, 2)}
                  </pre>
                </div>
              )}
              {entry.after && (
                <div>
                  <div className="text-[11px] uppercase tracking-[0.07em] text-ink-400 mb-1">After</div>
                  <pre className="bg-white border border-ink-200 rounded p-2 text-ink-700 overflow-x-auto whitespace-pre-wrap break-all">
                    {typeof entry.after === "string"
                      ? entry.after
                      : JSON.stringify(entry.after, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);

  const [entityTypes, setEntityTypes] = useState(new Set());
  const [actions, setActions] = useState(new Set());

  // Build filter for the query — send single value if exactly one selected;
  // the hook will pass undefined (= no filter) when nothing is chosen.
  const entityTypeFilter = entityTypes.size === 1 ? [...entityTypes][0] : undefined;
  const actionFilter = actions.size === 1 ? [...actions][0] : undefined;

  const { data: entries, isLoading, error } = useAudit(
    orgId,
    { entity_type: entityTypeFilter, action: actionFilter },
  );

  // 403 = not admin
  const isForbidden = error?.status === 403;

  // Client-side filter when multiple types/actions selected (API only takes one)
  const filtered = (entries ?? []).filter((e) => {
    if (entityTypes.size > 1 && !entityTypes.has(e.entity_type)) return false;
    if (actions.size > 1 && !actions.has(e.action)) return false;
    return true;
  });

  const clearFilters = () => {
    setEntityTypes(new Set());
    setActions(new Set());
  };

  const hasFilters = entityTypes.size > 0 || actions.size > 0;

  return (
    <div className="page-shell max-w-[1100px]">
      <PageHeader
        eyebrow="Admin"
        title="Audit log"
        description="Every action taken in this workspace, recorded for compliance and troubleshooting."
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <FilterDropdown
          label="Entity"
          options={ENTITY_TYPES}
          selected={entityTypes}
          onChange={setEntityTypes}
        />
        <FilterDropdown
          label="Action"
          options={ACTIONS}
          selected={actions}
          onChange={setActions}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
        <div className="ml-auto text-[12px] text-ink-500 tnum">
          {!isLoading && !isForbidden && (
            <>
              {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
              {hasFilters && entries?.length ? ` of ${entries.length}` : ""}
            </>
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton />
        ) : isForbidden ? (
          <EmptyState
            icon={<ShieldAlert size={20} />}
            title="Admin access required"
            description="Only organisation admins can view the audit log."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert size={20} />}
            title="No audit entries"
            description={
              hasFilters
                ? "No entries match the current filters. Try clearing them."
                : "Actions taken in this workspace will appear here."
            }
            action={
              hasFilters ? (
                <Button variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 bg-ink-50/50">
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Actor</Th>
                  <Th className="hidden md:table-cell">Changes</Th>
                  <Th align="right">When</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry, i) => (
                  <AuditRow key={entry.id ?? i} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Th({ children, align, className }) {
  return (
    <th
      className={
        "px-5 py-2.5 label-eyebrow !text-ink-500 select-none " +
        (align === "right" ? "text-right " : "text-left ") +
        (className || "")
      }
    >
      {children}
    </th>
  );
}
