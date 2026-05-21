// Business Ledger page — Chart of Accounts, Manual Journal Entry,
// Trial Balance, and per-account ledger drill-down.
// Owned by FE-D (Phase 2). Edit only this file.
import { useState, useMemo } from "react";
import { Building2, Plus, ChevronLeft, AlertCircle, BookOpen, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogBody, DialogFooter,
} from "@/components/ui/Dialog";
import {
  useAccounts, useTrialBalance, useJournals, useOrgs, useOrgMutation,
  qk,
} from "@/lib/queries";
import { api } from "@/lib/api";
import { useOrgStore } from "@/stores/org";
import { formatMoney, formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useQuery } from "@tanstack/react-query";

// ── Account type ordering ─────────────────────────────────────────────────────
const TYPE_ORDER = ["asset", "liability", "equity", "revenue", "expense"];
const TYPE_LABELS = {
  asset:     "Assets",
  liability: "Liabilities",
  equity:    "Equity",
  revenue:   "Revenue",
  expense:   "Expenses",
};

// ── Tab IDs ───────────────────────────────────────────────────────────────────
const TABS = [
  { id: "accounts",      label: "Chart of Accounts" },
  { id: "journal",       label: "Journal Entry" },
  { id: "trial-balance", label: "Trial Balance" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function roundTwo(n) {
  return Math.round(n * 100) / 100;
}

// ── Page root ─────────────────────────────────────────────────────────────────
export default function LedgerPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const { data: orgsData, isLoading: orgsLoading } = useOrgs();
  const activeOrg = orgsData?.organizations?.find((o) => o.id === orgId);

  const [tab, setTab] = useState("accounts");

  // If not a business org, show a friendly gate
  if (!orgsLoading && activeOrg && activeOrg.kind !== "business") {
    return (
      <div className="page-shell max-w-[900px]">
        <PageHeader
          eyebrow="Ledger"
          title="Business Ledger"
          description="Double-entry accounting, journals, and reports for business organisations."
        />
        <Card className="p-10 flex flex-col items-center text-center gap-4">
          <div className="h-12 w-12 rounded-lg bg-ink-100 flex items-center justify-center text-ink-400">
            <Building2 size={22} />
          </div>
          <div>
            <p className="text-base font-medium tracking-tight text-ink-900">
              This is a personal workspace
            </p>
            <p className="text-sm text-ink-500 mt-1 max-w-sm">
              The Business Ledger is only available for business organisations.
              Switch to a business workspace from the sidebar, or create one in Settings.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-shell max-w-[1100px]">
      <PageHeader
        eyebrow={activeOrg ? `${activeOrg.name} · Ledger` : "Ledger"}
        title="Business Ledger"
        description="Chart of accounts, journal entries, and trial balance for your business."
      />

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b border-ink-100 -mx-1 px-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "px-4 py-2 text-sm font-medium tracking-tight transition-colors duration-150 relative",
              tab === t.id
                ? "text-ink-900 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-ink-900"
                : "text-ink-500 hover:text-ink-800",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "accounts"      && <AccountsTab      orgId={orgId} />}
      {tab === "journal"       && <JournalTab        orgId={orgId} />}
      {tab === "trial-balance" && <TrialBalanceTab   orgId={orgId} />}
    </div>
  );
}

// ── 1. Chart of Accounts ──────────────────────────────────────────────────────
function AccountsTab({ orgId }) {
  const { data: accounts, isLoading, error } = useAccounts(orgId);
  const [drillAccount, setDrillAccount] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  const grouped = useMemo(() => {
    if (!accounts) return {};
    return accounts.reduce((acc, a) => {
      const key = (a.type || "other").toLowerCase();
      if (!acc[key]) acc[key] = [];
      acc[key].push(a);
      return acc;
    }, {});
  }, [accounts]);

  if (drillAccount) {
    return (
      <AccountDrilldown
        orgId={orgId}
        account={drillAccount}
        onBack={() => setDrillAccount(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="accent" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={13} /> Add Account
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded" />
          ))}
        </div>
      )}

      {error && <ErrorBanner message={error.message} />}

      {!isLoading && !error && accounts?.length === 0 && (
        <EmptyState
          icon={<BookOpen size={20} />}
          title="No accounts yet"
          description="Add your first account to start building your chart of accounts."
          action={
            <Button variant="accent" onClick={() => setCreateOpen(true)}>
              <Plus size={13} /> Add Account
            </Button>
          }
        />
      )}

      {!isLoading && !error && accounts?.length > 0 && (
        TYPE_ORDER.filter((t) => grouped[t]?.length > 0).map((type) => (
          <div key={type}>
            <h2 className="text-[11px] uppercase tracking-[0.07em] font-medium text-ink-400 mb-2 px-1">
              {TYPE_LABELS[type] ?? type}
            </h2>
            <Card>
              <ul className="divide-y divide-ink-100">
                {grouped[type].map((acct) => (
                  <AccountRow
                    key={acct.id}
                    account={acct}
                    onClick={() => setDrillAccount(acct)}
                  />
                ))}
              </ul>
            </Card>
          </div>
        ))
      )}

      <CreateAccountDialog
        orgId={orgId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}

function AccountRow({ account, onClick }) {
  const isSystem = account.is_system ?? false;
  return (
    <li>
      <button
        onClick={onClick}
        className="w-full flex items-center gap-4 px-5 py-3 text-left hover:bg-ink-50 transition-colors group"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium tracking-tight text-ink-900 truncate">
              {account.name}
            </span>
            {account.code && (
              <span className="text-[11px] font-mono text-ink-400">{account.code}</span>
            )}
            {isSystem && (
              <Badge tone="neutral" className="text-[10px] px-1.5 py-0">system</Badge>
            )}
          </div>
          {account.description && (
            <div className="text-[12px] text-ink-400 truncate">{account.description}</div>
          )}
        </div>
        <div className="shrink-0 text-[12px] text-ink-400 group-hover:text-ink-600">
          View ledger →
        </div>
      </button>
    </li>
  );
}

function CreateAccountDialog({ orgId, open, onClose }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState("asset");
  const [description, setDescription] = useState("");

  const createMutation = useOrgMutation(
    orgId,
    (oid, vars) => api.createAccount(oid, vars),
    [qk.accounts(orgId)],
  );

  function reset() {
    setName(""); setCode(""); setType("asset"); setDescription("");
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await createMutation.mutateAsync({
        name: name.trim(),
        code: code.trim() || undefined,
        type,
        description: description.trim() || undefined,
      });
      toast.success(`Account "${name.trim()}" created`);
      handleClose();
    } catch (err) {
      toast.error(err.message ?? "Failed to create account");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Account</DialogTitle>
          <DialogDescription>Create a new account in your chart of accounts.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <LabeledInput
              label="Account Name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cash at Bank"
            />
            <LabeledInput
              label="Account Code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. 1010"
            />
            <div className="space-y-1.5">
              <label className="block text-[13px] font-medium text-ink-700">
                Account Type <span className="text-danger">*</span>
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="flex h-10 w-full px-3 py-2 rounded-md bg-ink-0 border border-ink-200 text-sm text-ink-900 focus:border-ink-900 focus:outline-none"
              >
                {TYPE_ORDER.map((t) => (
                  <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
                ))}
              </select>
            </div>
            <LabeledInput
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="accent"
              size="sm"
              loading={createMutation.isPending}
              disabled={!name.trim()}
            >
              Create Account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── 2. Account Drill-down ─────────────────────────────────────────────────────
function AccountDrilldown({ orgId, account, onBack }) {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo]     = useState(isoToday());

  const { data, isLoading, error } = useQuery({
    queryKey: ["account-ledger", orgId, account.id, from, to],
    queryFn:  () => api.getAccountLedger(orgId, account.id, { from, to }),
    enabled:  !!orgId && !!account.id,
  });

  const entries = useMemo(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.entries ?? data.ledger ?? [];
  }, [data]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-900 transition-colors"
        >
          <ChevronLeft size={15} /> Back
        </button>
        <span className="text-ink-300">/</span>
        <span className="text-sm font-medium text-ink-900">{account.name}</span>
        {account.code && (
          <span className="text-[11px] font-mono text-ink-400">({account.code})</span>
        )}
      </div>

      {/* Date range filter */}
      <Card className="p-4 flex flex-wrap gap-4 items-end">
        <LabeledInput
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-36"
        />
        <LabeledInput
          label="To"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-36"
        />
      </Card>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      )}

      {error && <ErrorBanner message={error.message} />}

      {!isLoading && !error && entries.length === 0 && (
        <EmptyState
          icon={<BookOpen size={20} />}
          title="No ledger entries"
          description="No transactions recorded for this account in the selected date range."
        />
      )}

      {!isLoading && !error && entries.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-[11px] uppercase tracking-[0.07em] text-ink-400">
                <th className="px-5 py-3 text-left font-medium">Date</th>
                <th className="px-5 py-3 text-left font-medium">Description</th>
                <th className="px-5 py-3 text-right font-medium tnum">Debit</th>
                <th className="px-5 py-3 text-right font-medium tnum">Credit</th>
                <th className="px-5 py-3 text-right font-medium tnum">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {entries.map((e, i) => (
                <tr key={e.id ?? i} className="hover:bg-ink-50 transition-colors">
                  <td className="px-5 py-2.5 text-ink-500 whitespace-nowrap">{formatDate(e.date)}</td>
                  <td className="px-5 py-2.5 text-ink-900 max-w-xs truncate">{e.description || e.memo || "—"}</td>
                  <td className="px-5 py-2.5 text-right tnum">{e.debit  ? formatMoney(e.debit)  : "—"}</td>
                  <td className="px-5 py-2.5 text-right tnum">{e.credit ? formatMoney(e.credit) : "—"}</td>
                  <td className="px-5 py-2.5 text-right font-medium tnum">{formatMoney(e.balance ?? e.running_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ── 3. Manual Journal Entry ───────────────────────────────────────────────────
function emptyLine() {
  return { accountId: "", description: "", debit: "", credit: "" };
}

function JournalTab({ orgId }) {
  const { data: accounts } = useAccounts(orgId);
  const { data: journals, isLoading: journalsLoading, error: journalsError } = useJournals(orgId);

  const [date, setDate]           = useState(isoToday());
  const [memo, setMemo]           = useState("");
  const [lines, setLines]         = useState([emptyLine(), emptyLine()]);
  const [submitting, setSubmitting] = useState(false);

  const createJournal = useOrgMutation(
    orgId,
    (oid, vars) => api.createJournal(oid, vars),
    [qk.journals(orgId), qk.accounts(orgId), qk.trialBalance(orgId, {})],
  );

  // Compute totals client-side — this is the gate for the submit button.
  const totalDebit  = useMemo(() => roundTwo(lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0)), [lines]);
  const totalCredit = useMemo(() => roundTwo(lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)), [lines]);
  const isBalanced  = totalDebit > 0 && totalCredit > 0 && totalDebit === totalCredit;
  const canSubmit   = isBalanced && lines.every((l) => l.accountId && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0));

  function updateLine(idx, field, value) {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      // A line is either debit or credit — clear the other side when a value is typed.
      if (field === "debit"  && value) next[idx].credit = "";
      if (field === "credit" && value) next[idx].debit  = "";
      return next;
    });
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(idx) {
    if (lines.length <= 2) return;
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const payload = {
        date,
        memo: memo.trim() || undefined,
        lines: lines
          .filter((l) => l.accountId && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0))
          .map((l) => ({
            account_id:  l.accountId,
            description: l.description.trim() || undefined,
            debit:       parseFloat(l.debit)  || undefined,
            credit:      parseFloat(l.credit) || undefined,
          })),
      };
      await createJournal.mutateAsync(payload);
      toast.success("Journal entry posted");
      setDate(isoToday());
      setMemo("");
      setLines([emptyLine(), emptyLine()]);
    } catch (err) {
      toast.error(err.message ?? "Failed to post journal entry");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Entry form */}
      <Card>
        <CardHeader>
          <CardTitle>New Journal Entry</CardTitle>
        </CardHeader>
        <CardBody>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="flex flex-wrap gap-4">
              <LabeledInput
                label="Date"
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-40"
              />
              <div className="flex-1 min-w-48">
                <LabeledInput
                  label="Memo"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="Optional description for this entry"
                />
              </div>
            </div>

            {/* Lines table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[0.07em] text-ink-400 border-b border-ink-100">
                    <th className="py-2 pr-3 text-left font-medium w-[35%]">Account</th>
                    <th className="py-2 pr-3 text-left font-medium">Description</th>
                    <th className="py-2 pr-3 text-right font-medium w-28">Debit</th>
                    <th className="py-2 pr-3 text-right font-medium w-28">Credit</th>
                    <th className="py-2 w-7" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <JournalLineRow
                      key={idx}
                      line={line}
                      accounts={accounts ?? []}
                      onUpdate={(field, value) => updateLine(idx, field, value)}
                      onRemove={() => removeLine(idx)}
                      canRemove={lines.length > 2}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-ink-200">
                    <td colSpan={2} className="pt-3 pr-3">
                      <Button type="button" variant="ghost" size="sm" onClick={addLine}>
                        <Plus size={12} /> Add line
                      </Button>
                    </td>
                    <td className="pt-3 pr-3 text-right tnum font-semibold text-ink-900">
                      {formatMoney(totalDebit)}
                    </td>
                    <td className="pt-3 pr-3 text-right tnum font-semibold text-ink-900">
                      {formatMoney(totalCredit)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Balance status indicator */}
            <div className={cn(
              "flex items-center gap-2 text-[13px] px-3 py-2 rounded-md",
              isBalanced
                ? "bg-emerald-50 text-emerald-700"
                : totalDebit > 0 || totalCredit > 0
                  ? "bg-amber-50 text-amber-700"
                  : "bg-ink-50 text-ink-500",
            )}>
              {isBalanced ? (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                  Entry is balanced — debits equal credits.
                </>
              ) : totalDebit > 0 || totalCredit > 0 ? (
                <>
                  <AlertCircle size={13} className="shrink-0" />
                  {`Out of balance by ${formatMoney(Math.abs(roundTwo(totalDebit - totalCredit)))}. Debits must equal credits before posting.`}
                </>
              ) : (
                "Enter debit and credit amounts to balance the entry."
              )}
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                variant="accent"
                size="sm"
                loading={submitting}
                disabled={!canSubmit}
              >
                Post Journal Entry
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {/* Recent journals */}
      <div>
        <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Recent Entries</h2>
        <JournalList
          orgId={orgId}
          journals={journals}
          isLoading={journalsLoading}
          error={journalsError}
        />
      </div>
    </div>
  );
}

function JournalLineRow({ line, accounts, onUpdate, onRemove, canRemove }) {
  return (
    <tr className="border-b border-ink-50">
      <td className="py-1.5 pr-3">
        <select
          value={line.accountId}
          onChange={(e) => onUpdate("accountId", e.target.value)}
          required
          className="w-full h-9 px-2 rounded-md bg-ink-0 border border-ink-200 text-sm text-ink-900 focus:border-ink-900 focus:outline-none"
        >
          <option value="">— Select account —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code ? `${a.code} · ` : ""}{a.name}
            </option>
          ))}
        </select>
      </td>
      <td className="py-1.5 pr-3">
        <Input
          value={line.description}
          onChange={(e) => onUpdate("description", e.target.value)}
          placeholder="Note"
          className="h-9 text-sm"
        />
      </td>
      <td className="py-1.5 pr-3">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={line.debit}
          onChange={(e) => onUpdate("debit", e.target.value)}
          placeholder="0.00"
          className="h-9 text-right text-sm w-full"
        />
      </td>
      <td className="py-1.5 pr-3">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={line.credit}
          onChange={(e) => onUpdate("credit", e.target.value)}
          placeholder="0.00"
          className="h-9 text-right text-sm w-full"
        />
      </td>
      <td className="py-1.5">
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-ink-300 hover:text-danger hover:bg-red-50 transition-colors"
            aria-label="Remove line"
          >
            <X size={13} />
          </button>
        )}
      </td>
    </tr>
  );
}

function JournalList({ orgId, journals, isLoading, error }) {
  const deleteJournal = useOrgMutation(
    orgId,
    (oid, journalId) => api.deleteJournal(oid, journalId),
    [qk.journals(orgId)],
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }

  if (error) return <ErrorBanner message={error.message} />;

  if (!journals?.length) {
    return (
      <EmptyState
        icon={<BookOpen size={18} />}
        title="No journal entries yet"
        description="Post your first journal entry using the form above."
      />
    );
  }

  async function handleDelete(journal) {
    try {
      await deleteJournal.mutateAsync(journal.id);
      toast.success("Journal entry deleted");
    } catch (err) {
      toast.error(err.message ?? "Failed to delete entry");
    }
  }

  return (
    <Card>
      <ul className="divide-y divide-ink-100">
        {journals.map((j) => (
          <li key={j.id} className="flex items-start gap-4 px-5 py-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-ink-900">{formatDate(j.date)}</span>
                {j.memo && <span className="text-sm text-ink-500 truncate">{j.memo}</span>}
              </div>
              {j.lines?.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {j.lines.map((l, i) => (
                    <div key={i} className="text-[12px] text-ink-500 flex gap-4">
                      <span className="min-w-[120px] truncate">{l.account_name ?? l.account_id}</span>
                      {l.debit  && <span className="tnum text-ink-700">Dr {formatMoney(l.debit)}</span>}
                      {l.credit && <span className="tnum text-ink-700">Cr {formatMoney(l.credit)}</span>}
                      {l.description && <span className="truncate text-ink-400">{l.description}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => handleDelete(j)}
              className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded text-ink-300 hover:text-danger hover:bg-red-50 transition-colors mt-0.5"
              aria-label="Delete journal entry"
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── 4. Trial Balance ──────────────────────────────────────────────────────────
function TrialBalanceTab({ orgId }) {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo]     = useState(isoToday());

  const { data, isLoading, error } = useTrialBalance(orgId, { from, to });

  const rows = useMemo(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.accounts ?? data.rows ?? [];
  }, [data]);

  const totals = useMemo(() => {
    const dr = roundTwo(rows.reduce((s, r) => s + (r.debit  ?? 0), 0));
    const cr = roundTwo(rows.reduce((s, r) => s + (r.credit ?? 0), 0));
    return { debit: dr, credit: cr, balanced: dr === cr };
  }, [rows]);

  return (
    <div className="space-y-5">
      <Card className="p-4 flex flex-wrap gap-4 items-end">
        <LabeledInput
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-36"
        />
        <LabeledInput
          label="To"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-36"
        />
      </Card>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      )}

      {error && <ErrorBanner message={error.message} />}

      {!isLoading && !error && rows.length === 0 && (
        <EmptyState
          icon={<BookOpen size={20} />}
          title="No trial balance data"
          description="No journal entries have been posted in the selected period."
        />
      )}

      {!isLoading && !error && rows.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-[11px] uppercase tracking-[0.07em] text-ink-400">
                <th className="px-5 py-3 text-left font-medium">Account</th>
                <th className="px-5 py-3 text-left font-medium hidden sm:table-cell">Type</th>
                <th className="px-5 py-3 text-right font-medium tnum">Debit</th>
                <th className="px-5 py-3 text-right font-medium tnum">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((row, i) => (
                <tr key={row.account_id ?? row.id ?? i} className="hover:bg-ink-50 transition-colors">
                  <td className="px-5 py-2.5">
                    <span className="font-medium text-ink-900">{row.account_name ?? row.name}</span>
                    {row.account_code && (
                      <span className="ml-2 text-[11px] font-mono text-ink-400">{row.account_code}</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-ink-500 capitalize hidden sm:table-cell">
                    {row.account_type ?? row.type ?? "—"}
                  </td>
                  <td className="px-5 py-2.5 text-right tnum">{row.debit  ? formatMoney(row.debit)  : "—"}</td>
                  <td className="px-5 py-2.5 text-right tnum">{row.credit ? formatMoney(row.credit) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink-200 font-semibold">
                <td className="px-5 py-3 text-ink-900">Total</td>
                <td className="hidden sm:table-cell" />
                <td className="px-5 py-3 text-right tnum text-ink-900">{formatMoney(totals.debit)}</td>
                <td className="px-5 py-3 text-right tnum text-ink-900">{formatMoney(totals.credit)}</td>
              </tr>
              {!totals.balanced && (
                <tr>
                  <td colSpan={4} className="px-5 py-2">
                    <div className="flex items-center gap-2 text-[12px] text-amber-700 bg-amber-50 rounded px-3 py-1.5">
                      <AlertCircle size={12} className="shrink-0" />
                      Totals do not balance — the ledger may have unposted entries.
                    </div>
                  </td>
                </tr>
              )}
              {totals.balanced && totals.debit > 0 && (
                <tr>
                  <td colSpan={4} className="px-5 pb-3">
                    <div className="flex items-center gap-2 text-[12px] text-emerald-700 bg-emerald-50 rounded px-3 py-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                      Balanced — debits equal credits.
                    </div>
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </Card>
      )}
    </div>
  );
}

// ── Shared primitives ─────────────────────────────────────────────────────────
function LabeledInput({ label, required, className, ...inputProps }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <label className="block text-[13px] font-medium text-ink-700">
          {label}
          {required && <span className="text-danger ml-0.5">*</span>}
        </label>
      )}
      <Input {...inputProps} />
    </div>
  );
}

function ErrorBanner({ message }) {
  return (
    <div className="flex items-start gap-3 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
      <AlertCircle size={15} className="mt-0.5 shrink-0" />
      <span>{message ?? "An unexpected error occurred."}</span>
    </div>
  );
}
