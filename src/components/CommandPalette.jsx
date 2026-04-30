import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  LayoutDashboard, Receipt, Users, Settings, Plus, Building2,
  LogOut, Search, ArrowRight, FileText, Sparkles, ArrowRightLeft,
} from "lucide-react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useDocuments, useOrgs } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { useAuthStore } from "@/stores/auth";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/cn";

// ⌘K palette. Keyboard-first navigation across the app — routes, recent
// receipts, and the most-used actions. Ranked by simple substring match
// over `label + keywords` so it stays predictable.
export function CommandPalette({ open, onOpenChange, onUploadOpen }) {
  const navigate = useNavigate();
  const orgId = useOrgStore((s) => s.activeOrgId);
  const setActiveOrg = useOrgStore((s) => s.setActiveOrg);
  const { data: orgsData } = useOrgs();
  const { data } = useDocuments(orgId);
  const logout = useAuthStore((s) => s.logout);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  // Reset query and selection each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const close = () => onOpenChange(false);
  const go = (path) => { navigate(path); close(); };

  const recent = (data?.documents ?? []).slice(0, 6);

  const commands = useMemo(() => {
    const base = [
      { id: "nav-dashboard", group: "Navigate", icon: LayoutDashboard, label: "Go to dashboard",
        hint: "Overview", shortcut: "g d", keywords: "home overview",
        run: () => go("/dashboard") },
      { id: "nav-receipts", group: "Navigate", icon: Receipt, label: "Go to receipts",
        hint: "All slips", shortcut: "g r", keywords: "list documents",
        run: () => go("/receipts") },
      { id: "nav-ask", group: "Navigate", icon: Sparkles, label: "Ask your receipts",
        hint: "Natural-language search", shortcut: "g a", keywords: "search ai gemini question query",
        run: () => go("/ask") },
      { id: "nav-members", group: "Navigate", icon: Users, label: "Go to members",
        hint: "Team", shortcut: "g m", keywords: "team people users",
        run: () => go("/members") },
      { id: "nav-settings", group: "Navigate", icon: Settings, label: "Go to settings",
        hint: "Profile and workspace", shortcut: "g s", keywords: "preferences profile",
        run: () => go("/settings") },

      { id: "act-upload", group: "Actions", icon: Plus, label: "Upload receipt",
        hint: "Open the upload dialog", keywords: "new add scan slip",
        run: () => { close(); setTimeout(onUploadOpen, 120); } },
      { id: "act-new-org", group: "Actions", icon: Building2, label: "Create a new organization",
        hint: "Workspace", keywords: "company team add",
        run: () => go("/onboarding") },

      { id: "acct-logout", group: "Account", icon: LogOut, label: "Log out",
        keywords: "sign out exit",
        run: () => { logout(); close(); navigate("/login"); } },
    ];

    const receiptCmds = recent.map((d) => ({
      id: `r-${d.id}`,
      group: "Receipts",
      icon: FileText,
      label: d.merchant || "Awaiting extraction",
      hint: formatRelative(d.created_at),
      keywords: `${d.merchant ?? ""} ${d.notes ?? ""} ${d.payment_method ?? ""} ${d.id}`,
      run: () => go(`/receipts/${d.id}`),
    }));

    // Workspace switcher — only show non-active orgs so the list stays
    // useful as soon as the user has more than one workspace.
    const orgList = orgsData?.organizations ?? [];
    const orgCmds = orgList
      .filter((o) => o.id !== orgId)
      .map((o) => ({
        id: `org-${o.id}`,
        group: "Switch workspace",
        icon: ArrowRightLeft,
        label: `Switch to ${o.name}`,
        hint: `/${o.slug}`,
        keywords: `workspace org organization ${o.name} ${o.slug}`,
        run: () => {
          setActiveOrg(o.id);
          close();
          toast.success(`Switched to ${o.name}`, {
            description: "Receipts and members for this workspace are now loading.",
          });
        },
      }));

    return [...base, ...orgCmds, ...receiptCmds];
  }, [recent, orgsData, orgId, navigate, logout, setActiveOrg, onUploadOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      (c.label + " " + (c.keywords ?? "") + " " + (c.hint ?? "")).toLowerCase().includes(q),
    );
  }, [commands, query]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const c of filtered) {
      if (!map.has(c.group)) map.set(c.group, []);
      map.get(c.group).push(c);
    }
    return [...map.entries()];
  }, [filtered]);

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % Math.max(filtered.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + filtered.length) % Math.max(filtered.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[active]?.run();
    }
  };

  let counter = 0;

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-ink-950/40 backdrop-blur-[2px] animate-fade-in" />
        <RadixDialog.Content
          className={cn(
            "fixed z-50 left-1/2 top-[18vh] -translate-x-1/2",
            "w-[min(92vw,640px)] max-h-[64vh] overflow-hidden",
            "rounded-lg bg-ink-0 shadow-popover animate-slide-up flex flex-col",
            "focus:outline-none",
          )}
          onKeyDown={onKey}
          aria-label="Command palette"
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">Search and run commands</RadixDialog.Description>
          <div className="flex items-center gap-2 px-4 h-12 border-b border-ink-100">
            <Search size={15} className="text-ink-400 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search commands, receipts, or pages…"
              className="flex-1 bg-transparent outline-none text-sm placeholder:text-ink-400"
              spellCheck={false}
              autoComplete="off"
            />
            <kbd className="text-[10px] font-mono text-ink-400 border border-ink-200 rounded px-1.5 py-0.5">ESC</kbd>
          </div>

          <div className="overflow-y-auto py-1.5">
            {filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-ink-500">
                No matches for <span className="font-mono text-ink-700">{query}</span>
              </div>
            ) : (
              grouped.map(([group, items]) => (
                <div key={group} className="py-1">
                  <div className="px-4 pt-2 pb-1 label-eyebrow !text-[10px] !text-ink-400">
                    {group}
                  </div>
                  <ul>
                    {items.map((cmd) => {
                      const idx = counter++;
                      const isActive = idx === active;
                      return (
                        <li key={cmd.id}>
                          <button
                            type="button"
                            onMouseEnter={() => setActive(idx)}
                            onClick={cmd.run}
                            className={cn(
                              "w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors",
                              isActive ? "bg-ink-100" : "hover:bg-ink-50",
                            )}
                          >
                            <cmd.icon size={15} className="text-ink-500 shrink-0" />
                            <span className="flex-1 min-w-0 truncate text-ink-900 tracking-tight">
                              {cmd.label}
                            </span>
                            {cmd.hint && (
                              <span className="text-[12px] text-ink-500 truncate max-w-[160px]">
                                {cmd.hint}
                              </span>
                            )}
                            {cmd.shortcut && (
                              <kbd className="hidden sm:inline text-[10px] font-mono text-ink-400 border border-ink-200 rounded px-1.5 py-0.5">
                                {cmd.shortcut}
                              </kbd>
                            )}
                            {isActive && <ArrowRight size={12} className="text-ink-500 shrink-0" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-ink-100 px-4 h-9 flex items-center justify-between text-[11px] text-ink-500 bg-ink-50/60">
            <span className="flex items-center gap-3">
              <span><kbd className="font-mono text-[10px] text-ink-500">↑↓</kbd> Navigate</span>
              <span><kbd className="font-mono text-[10px] text-ink-500">↵</kbd> Select</span>
            </span>
            <span>{filtered.length} {filtered.length === 1 ? "result" : "results"}</span>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
