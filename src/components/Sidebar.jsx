import { NavLink } from "react-router-dom";
import {
  LayoutDashboard, Receipt, Users, Settings, Plus, Search,
  Target, TrendingUp, BookOpen, BarChart3, ShieldCheck,
  Landmark, GitCompareArrows, Briefcase, Brain, CreditCard,
} from "lucide-react";
import { useOrgStore } from "@/stores/org";
import { useUIStore } from "@/stores/ui";
import { useOrgs } from "@/lib/queries";
import { cn } from "@/lib/cn";

// Items shown only for team/business orgs (hidden for personal kind)
const TEAM_ONLY_ROUTES = new Set([
  "/ledger", "/reports", "/bank-feeds", "/reconcile", "/audit", "/members",
]);

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, shortcut: "g d" },
  { to: "/receipts",  label: "Receipts",  icon: Receipt,         shortcut: "g r" },
  { to: "/budgets",   label: "Budgets",   icon: Target,          shortcut: "g b" },
  { to: "/net-worth", label: "Net worth", icon: TrendingUp,      shortcut: "g n" },
  { to: "/ledger",    label: "Ledger",    icon: BookOpen,        shortcut: "g l" },
  { to: "/reports",   label: "Reports",   icon: BarChart3,       shortcut: "g p" },
  { to: "/bank-feeds",label: "Bank feeds",icon: Landmark,        shortcut: "g f" },
  { to: "/reconcile", label: "Reconcile", icon: GitCompareArrows,shortcut: "g c" },
  { to: "/insights",  label: "Insights",  icon: Brain,           shortcut: "g i" },
  { to: "/workspace", label: "Workspace", icon: Briefcase,       shortcut: "g w" },
  { to: "/audit",     label: "Audit",     icon: ShieldCheck,     shortcut: "g u" },
  { to: "/members",   label: "Members",   icon: Users,           shortcut: "g m" },
  { to: "/settings",  label: "Settings",  icon: Settings,        shortcut: "g s" },
  { to: "/billing",   label: "Billing",   icon: CreditCard,      shortcut: "g x" },
];

export function Sidebar({ onNavigate } = {}) {
  const { activeOrgId } = useOrgStore();
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const setUploadOpen = useUIStore((s) => s.setUploadOpen);
  const { data: orgs } = useOrgs();

  const active = orgs?.organizations.find((o) => o.id === activeOrgId) ?? orgs?.organizations[0];
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

  // Hide team-only items when the active org is personal
  const isPersonal = active?.kind !== "business";
  const visibleNav = nav.filter((item) => !isPersonal || !TEAM_ONLY_ROUTES.has(item.to));

  return (
    <aside className="flex flex-col w-[252px] shrink-0 border-r border-ink-100 bg-ink-50/40 sticky top-[52px] h-[calc(100vh-52px)] overflow-y-auto">
      {/* Brand now lives in the top bar, aligned on the same row as the account toggle */}
      <div className="px-3 mt-4 mb-3">
        <button
          onClick={() => setPaletteOpen(true)}
          className="w-full flex items-center gap-2 px-2 h-8 rounded border border-ink-200 bg-ink-0 text-[12px] text-ink-500 hover:text-ink-900 hover:border-ink-300 transition-colors"
          aria-label="Open command palette"
        >
          <Search size={13} className="text-ink-400" />
          <span className="flex-1 text-left tracking-tight">Search…</span>
          <kbd className="font-mono text-[10px] text-ink-400 border border-ink-200 rounded px-1 py-0.5">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
      </div>

      <nav className="px-3 flex-1 space-y-0.5">
        {visibleNav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={() => onNavigate?.()}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-2.5 px-2 py-1.5 rounded text-sm transition-colors",
                isActive
                  ? "bg-ink-900 text-ink-0"
                  : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon size={15} className={isActive ? "" : "text-ink-400 group-hover:text-ink-700"} />
                <span className="flex-1 tracking-tight">{item.label}</span>
                <kbd className={cn(
                  "hidden group-hover:inline text-[10px] font-mono",
                  isActive ? "text-ink-400" : "text-ink-300",
                )}>{item.shortcut}</kbd>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 pb-3">
        <button
          onClick={() => { setUploadOpen(true); onNavigate?.(); }}
          className="w-full inline-flex items-center justify-center gap-2 h-9 rounded-md bg-accent text-accent-fg text-sm font-medium tracking-tight hover:bg-[#D9FF40] transition-colors shadow-card"
        >
          <Plus size={14} /> Upload receipt
          <kbd className="hidden sm:inline ml-1 font-mono text-[10px] text-accent-fg/60">U</kbd>
        </button>
      </div>
    </aside>
  );
}
