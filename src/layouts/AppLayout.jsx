import { useEffect, useState } from "react";
import { Navigate, Outlet, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Menu, X, Plus, MessageSquare, Check, Settings, LogOut } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { ChatPanel } from "@/components/ChatPanel";
import { Wordmark } from "@/components/Wordmark";
import { CommandPalette } from "@/components/CommandPalette";
import { UploadDialog } from "@/components/UploadDialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/DropdownMenu";
import { Avatar } from "@/components/ui/Avatar";
import { useAuthStore } from "@/stores/auth";
import { useOrgStore } from "@/stores/org";
import { useUIStore } from "@/stores/ui";
import { useMe, useOrgs } from "@/lib/queries";
import { InvitationPrompt } from "@/components/InvitationPrompt";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";

// Keyboard navigation: vim-style "g X" leaders for routes, plus ⌘K /
// Ctrl+K to open the command palette anywhere in the app, and "u" to
// trigger an upload from any non-input context.
function useGlobalShortcuts() {
  const navigate = useNavigate();
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const setUploadOpen = useUIStore((s) => s.setUploadOpen);
  const setChatOpen = useUIStore((s) => s.setChatOpen);

  useEffect(() => {
    let pendingG = 0;
    const handler = (e) => {
      const t = e.target;
      const inField = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (inField) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "u") {
        e.preventDefault();
        setUploadOpen(true);
        return;
      }

      const now = Date.now();
      if (e.key === "g") {
        pendingG = now;
        return;
      }
      if (now - pendingG < 1500) {
        if (e.key === "d") { navigate("/dashboard"); pendingG = 0; }
        else if (e.key === "r") { navigate("/receipts"); pendingG = 0; }
        else if (e.key === "a") { setChatOpen(true); pendingG = 0; }
        else if (e.key === "m") { navigate("/members"); pendingG = 0; }
        else if (e.key === "s") { navigate("/settings"); pendingG = 0; }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, setPaletteOpen, setUploadOpen, setChatOpen]);
}

export default function AppLayout() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const setUser = useAuthStore((s) => s.setUser);
  const storedUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { activeOrgId, setActiveOrg } = useOrgStore();
  const { data: orgs, isLoading, isFetching } = useOrgs();
  const { data: me } = useMe();
  const paletteOpen = useUIStore((s) => s.paletteOpen);
  const uploadOpen = useUIStore((s) => s.uploadOpen);
  const chatOpen = useUIStore((s) => s.chatOpen);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const setUploadOpen = useUIStore((s) => s.setUploadOpen);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const user = storedUser ?? me;
  const activeOrg = orgs?.organizations.find((o) => o.id === activeOrgId) ?? orgs?.organizations?.[0];

  const onLogout = () => {
    logout();
    navigate("/login");
  };

  const onSwitchOrg = (id, name) => {
    if (id === activeOrg?.id) return;
    setActiveOrg(id);
    toast.success(`Switched to ${name}`, {
      description: "Receipts and members for this workspace are now loading.",
    });
  };

  useGlobalShortcuts();

  useEffect(() => {
    if (!orgs) return;
    const list = orgs.organizations;
    if (list.length === 0) return;
    if (!activeOrgId || !list.find((o) => o.id === activeOrgId)) {
      setActiveOrg(list[0].id);
    }
  }, [orgs, activeOrgId, setActiveOrg]);

  // Hydrate the stored user from /auth/me on boot — keeps the sidebar
  // and dashboard in sync if the user updated their profile elsewhere,
  // and surfaces stale-token errors before the user clicks anything.
  useEffect(() => {
    if (!me) return;
    const same =
      storedUser?.id === me.id &&
      storedUser?.email === me.email &&
      storedUser?.full_name === me.full_name;
    if (!same) setUser(me);
  }, [me, storedUser, setUser]);

  if (!accessToken) return <Navigate to="/login" replace />;

  if (isLoading) {
    return (
      <div className="min-h-screen flex">
        <aside className="hidden lg:block w-[252px] border-r border-ink-100 p-4">
          <Skeleton className="h-7 w-32 mb-6" />
          <Skeleton className="h-9 mb-3" />
          <Skeleton className="h-7 mb-1" />
          <Skeleton className="h-7 mb-1" />
          <Skeleton className="h-7" />
        </aside>
        <main className="flex-1 p-10">
          <Skeleton className="h-9 w-64 mb-3" />
          <Skeleton className="h-4 w-96 mb-10" />
          <Skeleton className="h-64" />
        </main>
      </div>
    );
  }

  // Wait for any in-flight refetch to land before declaring "no orgs" —
  // otherwise a freshly-created org's invalidation would bounce the user
  // back to onboarding while the refetch is on the wire.
  if (orgs && orgs.organizations.length === 0 && !isFetching) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-ink-0">
      {/* ── Desktop top bar ────────────────────────────────────────────────── */}
      <header className="hidden lg:flex fixed top-0 inset-x-0 z-30 h-[52px] items-center gap-2 px-4 border-b border-ink-100 bg-ink-0/95 backdrop-blur">
        {/* Left spacer — aligns with sidebar width */}
        <div className="w-[252px] shrink-0" />

        {/* Right-hand actions */}
        <div className="ml-auto flex items-center gap-1.5">
          {/* Chat panel toggle */}
          <button
            onClick={() => setChatOpen(!chatOpen)}
            className={cn(
              "h-8 w-8 inline-flex items-center justify-center rounded transition-colors",
              chatOpen
                ? "bg-ink-900 text-ink-0"
                : "text-ink-500 hover:bg-ink-100 hover:text-ink-900",
            )}
            aria-label={chatOpen ? "Close AI chat" : "Open AI chat"}
            title="Ask your receipts (g a)"
          >
            <MessageSquare size={16} />
          </button>

          {/* Profile / org dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="h-8 w-8 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 ml-1"
                aria-label="Profile and organizations"
              >
                <Avatar
                  name={user?.full_name || user?.email}
                  src={user?.avatar_url}
                  size="sm"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[260px]">
              <DropdownMenuLabel>
                <div className="font-medium text-ink-900 truncate">
                  {user?.full_name || user?.email?.split("@")[0]}
                </div>
                <div className="text-[11px] font-normal text-ink-500 truncate">{user?.email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />

              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {orgs?.organizations.map((o) => (
                <DropdownMenuItem
                  key={o.id}
                  onClick={() => onSwitchOrg(o.id, o.name)}
                  className="justify-between"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Avatar name={o.name} size="xs" />
                    <span className="truncate">{o.name}</span>
                  </span>
                  {o.id === activeOrg?.id && <Check size={14} className="text-ink-700" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={() => navigate("/onboarding")}>
                <Plus size={14} /> New organization
              </DropdownMenuItem>

              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate("/settings")}>
                <Settings size={14} /> Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onClick={onLogout}>
                <LogOut size={14} /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* ── Mobile top bar ─────────────────────────────────────────────────── */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-30 h-14 px-4 flex items-center gap-2 border-b border-ink-100 bg-ink-0/90 backdrop-blur">
        <button
          onClick={() => setDrawerOpen(true)}
          className="h-9 w-9 inline-flex items-center justify-center rounded hover:bg-ink-100 text-ink-700"
          aria-label="Open menu"
        >
          <Menu size={18} />
        </button>
        <Wordmark size="sm" />
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setChatOpen(!chatOpen)}
            className={cn(
              "h-9 w-9 inline-flex items-center justify-center rounded transition-colors",
              chatOpen ? "bg-ink-900 text-ink-0" : "text-ink-500 hover:bg-ink-100 hover:text-ink-900",
            )}
            aria-label={chatOpen ? "Close AI chat" : "Open AI chat"}
          >
            <MessageSquare size={16} />
          </button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="h-9 w-9 inline-flex items-center justify-center rounded border border-ink-200 text-ink-500 hover:text-ink-900"
            aria-label="Open command palette"
          >
            <span className="font-mono text-[11px]">⌘K</span>
          </button>
          <button
            onClick={() => setUploadOpen(true)}
            className="h-9 px-3 inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-fg text-[13px] font-medium tracking-tight hover:bg-[#D9FF40] active:bg-[#B8EE00] transition-colors shadow-card"
            aria-label="Upload receipt"
          >
            <Plus size={14} /> Upload
          </button>
        </div>
      </div>

      {/* ── Body row (sidebar + content) ───────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 pt-14 lg:pt-[52px]">
        {/* Desktop sidebar */}
        <div className="hidden lg:block shrink-0">
          <Sidebar />
        </div>

        {/* Mobile sidebar drawer */}
        <div
          className={cn(
            "lg:hidden fixed inset-0 z-40 transition-opacity duration-150",
            drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
          )}
          onClick={() => setDrawerOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div className="absolute inset-0 bg-ink-950/40" />
          <aside
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute top-0 left-0 bottom-0 w-[280px] bg-ink-0 border-r border-ink-100 transition-transform duration-200 ease-out-cubic",
              drawerOpen ? "translate-x-0" : "-translate-x-full",
            )}
          >
            <button
              onClick={() => setDrawerOpen(false)}
              className="absolute top-3 right-3 h-8 w-8 inline-flex items-center justify-center rounded hover:bg-ink-100 text-ink-500 z-10"
              aria-label="Close menu"
            >
              <X size={16} />
            </button>
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>

        <main className="flex-1 min-w-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      {/* ── Chat panel (slide-in right drawer) ─────────────────────────────── */}
      <ChatPanel />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onUploadOpen={() => setUploadOpen(true)}
      />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <InvitationPrompt />
    </div>
  );
}
