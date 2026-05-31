import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Target, Wallet, ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardBody, CardTitle, CardSubtitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogBody, DialogFooter,
} from "@/components/ui/Dialog";
import { useBudgets, useGoals, useCategories, useOrgMutation, useOrgs } from "@/lib/queries";
import { qk } from "@/lib/queries";
import { api } from "@/lib/api";
import { useOrgStore } from "@/stores/org";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/cn";

// ── helpers ─────────────────────────────────────────────────────────────────

// Safely coerce value to a positive number, returning 0 on failure.
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Clamp a ratio between 0 and 1.
function clamp(v) {
  return Math.max(0, Math.min(1, v));
}

// Bar colour based on spend ratio.
function barColor(ratio) {
  if (ratio >= 1) return "bg-danger";
  if (ratio >= 0.8) return "bg-amber-400";
  return "bg-accent";
}

// Start of current month as YYYY-MM-DD.
function startOfCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// Allowed budget period enum values (matches backend VALID_PERIODS).
const PERIOD_OPTIONS = [
  { value: "monthly",   label: "Monthly" },
  { value: "weekly",    label: "Weekly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly",    label: "Yearly" },
];

// Format a budget period label for display.
function periodLabel(period) {
  if (!period) return "";
  const match = PERIOD_OPTIONS.find((o) => o.value === period);
  return match ? match.label : period;
}

// ── Budget progress sub-component ────────────────────────────────────────────
// Fetches /budgets/{id}/progress individually so each budget is independent.

function BudgetProgressBar({ orgId, budgetId, budgetedTotal, currency }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["budget-progress", orgId, budgetId],
    queryFn: () => api.getBudgetProgress(orgId, budgetId),
    enabled: !!orgId && !!budgetId,
    staleTime: 60_000,
  });

  if (isLoading) return <Skeleton className="h-4 w-full rounded-full mt-2" />;
  if (isError) return <p className="text-[12px] text-ink-400 mt-2">Progress unavailable</p>;

  // Backend returns BudgetOut: { id, name, period, start_date, currency, is_active,
  //   lines: [{ id, amount, rollover, actual, remaining, category_id? }] }
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const budgeted = lines.length > 0
    ? lines.reduce((s, l) => s + toNum(l.amount ?? 0), 0)
    : toNum(budgetedTotal ?? 0);
  const actual = lines.reduce((s, l) => s + toNum(l.actual ?? 0), 0);
  const ratio = budgeted > 0 ? actual / budgeted : 0;
  const pct = Math.round(clamp(ratio) * 100);

  // Use lines for per-category breakdown (lines carry category_id, not category_name — show id short or "Uncategorized")
  const items = lines;

  return (
    <div className="mt-3 space-y-2">
      {/* Headline bar */}
      <div className="flex items-center justify-between text-[12px] text-ink-500 tnum">
        <span>{formatMoney(actual, currency)} spent</span>
        <span className={ratio >= 1 ? "text-danger font-medium" : ""}>{pct}% of {formatMoney(budgeted, currency)}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-ink-100 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", barColor(ratio))}
          style={{ width: `${clamp(ratio) * 100}%` }}
        />
      </div>

      {/* Per-category breakdown */}
      {items.length > 1 && (
        <div className="mt-3 space-y-1.5">
          {items.map((item) => {
            const a = toNum(item.actual ?? 0);
            const b = toNum(item.amount ?? 0);
            const r = b > 0 ? a / b : 0;
            const label = item.category_id
              ? item.category_id.slice(0, 8) + "…"
              : "Uncategorized";
            return (
              <div key={item.id ?? item.category_id ?? Math.random()} className="space-y-0.5">
                <div className="flex items-center justify-between text-[11px] text-ink-500 tnum">
                  <span className="truncate max-w-[60%]">{label}</span>
                  <span>{formatMoney(a, currency)} / {formatMoney(b, currency)}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-ink-100 overflow-hidden">
                  <div
                    className={cn("h-full rounded-full", barColor(r))}
                    style={{ width: `${clamp(r) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Create Budget Dialog ──────────────────────────────────────────────────────

function CreateBudgetDialog({ open, onClose, orgId, categories, defaultCurrency }) {
  const [name, setName] = useState("");
  const [period, setPeriod] = useState("monthly");
  const [startDate, setStartDate] = useState(startOfCurrentMonth);
  const [currency, setCurrency] = useState(() => defaultCurrency || "ZAR");
  // lineAmounts: { [categoryId]: amount string }
  const [lineAmounts, setLineAmounts] = useState({});
  const [expanded, setExpanded] = useState(true);

  const createBudget = useOrgMutation(orgId, api.createBudget, [qk.budgets(orgId)]);

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Budget name is required");
      return;
    }
    if (!startDate) {
      toast.error("Start date is required");
      return;
    }
    if (!currency.trim()) {
      toast.error("Currency is required");
      return;
    }

    const lines = Object.entries(lineAmounts)
      .filter(([, v]) => v !== "" && !Number.isNaN(Number(v)) && Number(v) > 0)
      .map(([category_id, amount]) => ({
        category_id,
        amount: Number(amount),
        rollover: false,
      }));

    if (lines.length === 0) {
      toast.error("Add at least one category with an amount.");
      return;
    }

    try {
      await createBudget.mutateAsync({
        name: name.trim(),
        period,
        start_date: startDate,
        currency: currency.trim().toUpperCase(),
        lines,
      });
      toast.success("Budget created");
      setName("");
      setPeriod("monthly");
      setStartDate(startOfCurrentMonth());
      setCurrency(defaultCurrency || "ZAR");
      setLineAmounts({});
      onClose();
    } catch (err) {
      toast.error(err?.message ?? "Failed to create budget");
    }
  }, [name, period, startDate, currency, lineAmounts, createBudget, defaultCurrency, onClose]);

  const setLineAmount = (catId, val) =>
    setLineAmounts((prev) => ({ ...prev, [catId]: val }));

  // Total of all lines
  const total = Object.values(lineAmounts).reduce((sum, v) => {
    const n = Number(v);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(96vw,600px)] max-h-[90vh]">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Create budget</DialogTitle>
            <DialogDescription>
              Set a name, period, and per-category spending limits.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-5">
            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="budget-name">Name</Label>
              <Input
                id="budget-name"
                placeholder="e.g. Monthly household"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            {/* Period + Start date row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="budget-period">Period</Label>
                <select
                  id="budget-period"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  required
                  className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {PERIOD_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="budget-start-date">Start date</Label>
                <Input
                  id="budget-start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Currency */}
            <div className="space-y-1.5">
              <Label htmlFor="budget-currency">Currency</Label>
              <Input
                id="budget-currency"
                placeholder="e.g. ZAR"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                required
                className="uppercase"
                maxLength={3}
              />
            </div>

            {/* Category lines */}
            <div>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex w-full items-center justify-between mb-2 text-sm font-medium text-ink-700 hover:text-ink-900"
              >
                <span>Category amounts</span>
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {expanded && (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {categories.length === 0 ? (
                    <p className="text-sm text-ink-400">No categories available.</p>
                  ) : (
                    categories.map((cat) => (
                      <div key={cat.id} className="flex items-center gap-2">
                        <span className="flex-1 text-sm text-ink-700 truncate" title={cat.name}>
                          {cat.name}
                        </span>
                        <Input
                          className="w-32 text-right"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={lineAmounts[cat.id] ?? ""}
                          onChange={(e) => setLineAmount(cat.id, e.target.value)}
                        />
                      </div>
                    ))
                  )}
                </div>
              )}

              {total > 0 && (
                <div className="mt-3 flex items-center justify-between text-sm font-medium text-ink-900 tnum border-t border-ink-100 pt-2">
                  <span className="text-ink-500">Total budget</span>
                  <span>{formatMoney(total, currency || undefined)}</span>
                </div>
              )}
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="accent"
              loading={createBudget.isPending}
            >
              Create budget
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Budget Card ───────────────────────────────────────────────────────────────

function BudgetCard({ budget, orgId, onDelete }) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!window.confirm("Delete this budget?")) return;
    setDeleting(true);
    try {
      await onDelete(budget.id);
      toast.success("Budget deleted");
    } catch (err) {
      toast.error(err?.message ?? "Failed to delete budget");
      setDeleting(false);
    }
  }, [budget.id, onDelete]);

  // Derive a total budgeted amount from lines if available.
  const lines = Array.isArray(budget.lines) ? budget.lines : [];
  const budgetedTotal = lines.reduce((s, l) => s + toNum(l.amount ?? 0), 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{budget.name ?? periodLabel(budget.period) ?? "Budget"}</CardTitle>
            <CardSubtitle>
              {periodLabel(budget.period)}
              {budgetedTotal > 0 && ` · ${formatMoney(budgetedTotal, budget.currency)} budgeted`}
            </CardSubtitle>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-ink-400 hover:text-danger"
            onClick={handleDelete}
            loading={deleting}
            aria-label="Delete budget"
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        <BudgetProgressBar
          orgId={orgId}
          budgetId={budget.id}
          budgetedTotal={budgetedTotal || undefined}
          currency={budget.currency}
        />
      </CardBody>
    </Card>
  );
}

// ── Goals section ─────────────────────────────────────────────────────────────

function GoalProgressBar({ goal }) {
  const current = toNum(goal.current_amount ?? goal.current ?? goal.saved ?? 0);
  const target = toNum(goal.target_amount ?? goal.target ?? goal.amount ?? 0);
  const ratio = target > 0 ? current / target : 0;
  const pct = Math.round(clamp(ratio) * 100);
  const currency = goal.currency;

  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex items-center justify-between text-[12px] text-ink-500 tnum">
        <span>{formatMoney(current, currency)} saved</span>
        <span className={ratio >= 1 ? "text-green-600 font-medium" : ""}>{pct}% of {formatMoney(target, currency)}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-ink-100 overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            ratio >= 1 ? "bg-green-500" : "bg-accent",
          )}
          style={{ width: `${clamp(ratio) * 100}%` }}
        />
      </div>
      {goal.deadline && (
        <p className="text-[11px] text-ink-400">Deadline: {goal.deadline}</p>
      )}
    </div>
  );
}

function EditGoalAmountDialog({ open, onClose, goal, orgId }) {
  const [amount, setAmount] = useState(() => String(
    toNum(goal?.current_amount ?? goal?.current ?? goal?.saved ?? 0)
  ));

  const patchGoal = useOrgMutation(
    orgId,
    (id, body) => api.patchGoal(id, body),
    [qk.goals(orgId)],
  );

  // We need patchGoal to accept (orgId, vars) where vars = { goalId, body }.
  const patchGoalFixed = useOrgMutation(orgId, (_, vars) => api.patchGoal(orgId, vars.goalId, vars.body), [qk.goals(orgId)]);

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Enter a valid amount");
      return;
    }
    try {
      await patchGoalFixed.mutateAsync({ goalId: goal.id, body: { current_amount: n } });
      toast.success("Goal updated");
      onClose();
    } catch (err) {
      toast.error(err?.message ?? "Failed to update goal");
    }
  }, [amount, goal?.id, patchGoalFixed, onClose]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Update progress</DialogTitle>
            <DialogDescription>
              {goal?.name ?? "Goal"} — update how much you have saved.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-1.5">
              <Label htmlFor="goal-current">Current amount saved</Label>
              <Input
                id="goal-current"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="accent" loading={patchGoalFixed.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateGoalDialog({ open, onClose, orgId }) {
  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [currentAmount, setCurrentAmount] = useState("");
  const [deadline, setDeadline] = useState("");

  const createGoal = useOrgMutation(orgId, api.createGoal, [qk.goals(orgId)]);

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    const target = Number(targetAmount);
    if (!name.trim()) { toast.error("Goal name is required"); return; }
    if (!Number.isFinite(target) || target <= 0) { toast.error("Enter a valid target amount"); return; }

    const body = {
      name: name.trim(),
      target_amount: target,
      current_amount: Number(currentAmount) || 0,
    };
    if (deadline) body.deadline = deadline;

    try {
      await createGoal.mutateAsync(body);
      toast.success("Goal created");
      setName("");
      setTargetAmount("");
      setCurrentAmount("");
      setDeadline("");
      onClose();
    } catch (err) {
      toast.error(err?.message ?? "Failed to create goal");
    }
  }, [name, targetAmount, currentAmount, deadline, createGoal, onClose]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Create goal</DialogTitle>
            <DialogDescription>Set a savings target to work towards.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="goal-name">Name</Label>
              <Input
                id="goal-name"
                placeholder="e.g. Emergency fund"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="goal-target">Target amount</Label>
                <Input
                  id="goal-target"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={targetAmount}
                  onChange={(e) => setTargetAmount(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="goal-current2">Already saved (optional)</Label>
                <Input
                  id="goal-current2"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={currentAmount}
                  onChange={(e) => setCurrentAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-deadline">Deadline (optional)</Label>
              <Input
                id="goal-deadline"
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="accent" loading={createGoal.isPending}>
              Create goal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GoalCard({ goal, orgId, onDelete }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!window.confirm("Delete this goal?")) return;
    setDeleting(true);
    try {
      await onDelete(goal.id);
      toast.success("Goal deleted");
    } catch (err) {
      toast.error(err?.message ?? "Failed to delete goal");
      setDeleting(false);
    }
  }, [goal.id, onDelete]);

  const target = toNum(goal.target_amount ?? goal.target ?? goal.amount ?? 0);

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle>{goal.name ?? "Unnamed goal"}</CardTitle>
              {target > 0 && (
                <CardSubtitle>Target: {formatMoney(target, goal.currency)}</CardSubtitle>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-ink-400 hover:text-ink-700"
                onClick={() => setEditOpen(true)}
                aria-label="Update progress"
              >
                <Pencil size={13} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-ink-400 hover:text-danger"
                onClick={handleDelete}
                loading={deleting}
                aria-label="Delete goal"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <GoalProgressBar goal={goal} />
        </CardBody>
      </Card>

      {editOpen && (
        <EditGoalAmountDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          goal={goal}
          orgId={orgId}
        />
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BudgetsPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);

  const { data: orgsData } = useOrgs();
  const orgList = Array.isArray(orgsData)
    ? orgsData
    : (orgsData?.organizations ?? []);
  const activeOrg = orgList.find((o) => o.id === orgId);
  const defaultCurrency = activeOrg?.currency?.toUpperCase() || "ZAR";

  const { data: budgets, isLoading: budgetsLoading, isError: budgetsError } = useBudgets(orgId);
  const { data: goals, isLoading: goalsLoading, isError: goalsError } = useGoals(orgId);
  const { data: categories } = useCategories(orgId);

  const [createBudgetOpen, setCreateBudgetOpen] = useState(false);
  const [createGoalOpen, setCreateGoalOpen] = useState(false);

  // Delete mutations
  const deleteBudget = useOrgMutation(orgId, (_, budgetId) => api.deleteBudget(orgId, budgetId), [qk.budgets(orgId)]);
  const deleteGoal = useOrgMutation(orgId, (_, goalId) => api.deleteGoal(orgId, goalId), [qk.goals(orgId)]);

  const handleDeleteBudget = useCallback((budgetId) => deleteBudget.mutateAsync(budgetId), [deleteBudget]);
  const handleDeleteGoal = useCallback((goalId) => deleteGoal.mutateAsync(goalId), [deleteGoal]);

  // Normalize categories to array (shape: { categories: [...] } or bare [])
  const catList = Array.isArray(categories) ? categories : [];

  // useBudgets/useGoals already normalize via arr() helper in queries.js
  const budgetList = Array.isArray(budgets) ? budgets : [];
  const goalList = Array.isArray(goals) ? goals : [];

  return (
    <div className="page-shell max-w-[1080px]">
      <PageHeader
        eyebrow="Personal finance"
        title="Budgets & Goals"
        description="Track your spending against budgets and make progress on savings goals."
        actions={
          <>
            <Button variant="secondary" onClick={() => setCreateGoalOpen(true)}>
              <Target size={14} /> New goal
            </Button>
            <Button variant="accent" onClick={() => setCreateBudgetOpen(true)}>
              <Plus size={14} /> New budget
            </Button>
          </>
        }
      />

      {/* ── Budgets section ────────────────────────────────────────────── */}
      <section className="mb-12">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-medium tracking-tight text-ink-900 flex items-center gap-2">
            <Wallet size={15} className="text-ink-400" />
            Budgets
          </h2>
          {!budgetsLoading && (
            <span className="text-[12px] text-ink-500 tnum">
              {budgetList.length} {budgetList.length === 1 ? "budget" : "budgets"}
            </span>
          )}
        </div>

        {budgetsLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="p-5 space-y-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2 w-full rounded-full mt-4" />
              </Card>
            ))}
          </div>
        ) : budgetsError ? (
          <Card>
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-ink-500">Failed to load budgets.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => window.location.reload()}>
                Retry
              </Button>
            </div>
          </Card>
        ) : budgetList.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Wallet size={20} />}
              title="No budgets yet"
              description="Create a budget to track spending per category over a period."
              action={
                <Button variant="accent" onClick={() => setCreateBudgetOpen(true)}>
                  <Plus size={14} /> Create budget
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {budgetList.map((b) => (
              <BudgetCard
                key={b.id}
                budget={b}
                orgId={orgId}
                onDelete={handleDeleteBudget}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Goals section ──────────────────────────────────────────────── */}
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-medium tracking-tight text-ink-900 flex items-center gap-2">
            <Target size={15} className="text-ink-400" />
            Goals
          </h2>
          {!goalsLoading && (
            <span className="text-[12px] text-ink-500 tnum">
              {goalList.length} {goalList.length === 1 ? "goal" : "goals"}
            </span>
          )}
        </div>

        {goalsLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2].map((i) => (
              <Card key={i} className="p-5 space-y-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-2 w-full rounded-full mt-4" />
              </Card>
            ))}
          </div>
        ) : goalsError ? (
          <Card>
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-ink-500">Failed to load goals.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => window.location.reload()}>
                Retry
              </Button>
            </div>
          </Card>
        ) : goalList.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Target size={20} />}
              title="No goals yet"
              description="Create a savings goal to track your progress towards a target."
              action={
                <Button variant="accent" onClick={() => setCreateGoalOpen(true)}>
                  <Target size={14} /> Create goal
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {goalList.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                orgId={orgId}
                onDelete={handleDeleteGoal}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Dialogs ────────────────────────────────────────────────────── */}
      <CreateBudgetDialog
        open={createBudgetOpen}
        onClose={() => setCreateBudgetOpen(false)}
        orgId={orgId}
        categories={catList}
        defaultCurrency={defaultCurrency}
      />
      <CreateGoalDialog
        open={createGoalOpen}
        onClose={() => setCreateGoalOpen(false)}
        orgId={orgId}
      />
    </div>
  );
}
