import { NavLink, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  LayoutDashboard, Receipt, Users, Settings, Plus, ChevronsUpDown,
  LogOut, Check, Search, Sparkles,
} from "lucide-react";
import { Wordmark } from "@/components/Wordmark";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/DropdownMenu";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { useAuthStore } from "@/stores/auth";
import { useOrgStore } from "@/stores/org";
import { useUIStore } from "@/stores/ui";
import { useOrgs } from "@/lib/queries";
import { cn } from "@/lib/cn";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, shortcut: "g d" },
  { to: "/receipts",  label: "Receipts",  icon: Receipt,         shortcut: "g r" },
  { to: "/ask",       label: "Ask",       icon: Sparkles,        shortcut: "g a" },
  { to: "/members",   label: "Members",   icon: Users,           shortcut: "g m" },
  { to: "/settings",  label: "Settings",  icon: Settings,        shortcut: "g s" },
];

export function Sidebar({ onNavigate } = {}) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const { activeOrgId, setActiveOrg } = useOrgStore();
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const setUploadOpen = useUIStore((s) => s.setUploadOpen);
  const { data: orgs } = useOrgs();

  const active = orgs?.organizations.find((o) => o.id === activeOrgId) ?? orgs?.organizations[0];
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

  const onLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <aside className="flex flex-col w-[252px] shrink-0 border-r border-ink-100 bg-ink-50/40 h-full">
      <div className="px-4 py-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="w-full inline-flex items-center gap-2.5 px-2 py-1.5 -mx-1 rounded hover:bg-ink-100 transition-colors group">
              <Wordmark size="sm" />
              <ChevronsUpDown size={14} className="ml-auto text-ink-400 group-hover:text-ink-700" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[240px]">
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {orgs?.organizations.map((o) => (
              <DropdownMenuItem
                key={o.id}
                onClick={() => {
                  if (o.id === active?.id) return;
                  setActiveOrg(o.id);
                  toast.success(`Switched to ${o.name}`, {
                    description: "Receipts and members for this workspace are now loading.",
                  });
                }}
                className="justify-between"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Avatar name={o.name} size="xs" />
                  <span className="truncate">{o.name}</span>
                </span>
                {o.id === active?.id && <Check size={14} className="text-ink-700" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { navigate("/onboarding"); onNavigate?.(); }}>
              <Plus size={14} /> New organization
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="px-3 mb-2">
        {active && (
          <div className="w-full flex items-center gap-2 px-2 py-1.5 rounded">
            <Avatar name={active.name} size="sm" />
            <span className="flex-1 min-w-0 text-left">
              <span className="block text-sm font-medium text-ink-900 truncate tracking-tight">{active.name}</span>
              <span className="block text-[11px] text-ink-500 truncate">/{active.slug}</span>
            </span>
            {active.role === "admin" && <Badge tone="accent">Admin</Badge>}
          </div>
        )}
      </div>

      <div className="px-3 mb-3">
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
        {nav.map((item) => (
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

      <div className="px-3 py-3 border-t border-ink-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-ink-100 transition-colors">
              <Avatar name={user?.full_name || user?.email} size="sm" />
              <span className="flex-1 min-w-0 text-left">
                <span className="block text-sm font-medium text-ink-900 truncate tracking-tight">
                  {user?.full_name || user?.email?.split("@")[0]}
                </span>
                <span className="block text-[11px] text-ink-500 truncate">{user?.email}</span>
              </span>
              <ChevronsUpDown size={14} className="text-ink-400" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="min-w-[200px]">
            <DropdownMenuLabel>Account</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => { navigate("/settings"); onNavigate?.(); }}>
              <Settings size={14} /> Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onClick={onLogout}>
              <LogOut size={14} /> Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
