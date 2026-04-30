import { Link } from "react-router-dom";
import { Check, Plus, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useAuthStore } from "@/stores/auth";
import { useOrgStore } from "@/stores/org";
import { useOrgs } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const { activeOrgId, setActiveOrg } = useOrgStore();
  const { data: orgs, isLoading } = useOrgs();
  const list = orgs?.organizations ?? [];

  const onSwitch = (id, name) => {
    if (id === activeOrgId) return;
    setActiveOrg(id);
    toast.success(`Switched to ${name}`);
  };

  return (
    <div className="page-shell max-w-[820px]">
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Profile, workspaces, and preferences."
      />

      <section className="mb-10">
        <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Your profile</h2>
        <Card>
          <div className="flex items-center gap-4 p-5">
            <Avatar name={user?.full_name || user?.email} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium tracking-tight text-ink-900">
                {user?.full_name || "Unnamed user"}
              </div>
              <div className="text-[13px] text-ink-500 truncate">{user?.email}</div>
              {user?.created_at && (
                <div className="text-[11px] text-ink-400 mt-0.5">
                  Joined {formatDate(user.created_at)}
                </div>
              )}
            </div>
          </div>
        </Card>
      </section>

      <section className="mb-10">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-medium tracking-tight text-ink-900">Workspaces</h2>
          <span className="text-[12px] text-ink-500 tnum">
            {!isLoading && `${list.length} ${list.length === 1 ? "workspace" : "workspaces"}`}
          </span>
        </div>
        <Card className="overflow-hidden">
          <ul className="divide-y divide-ink-100">
            {list.map((o) => {
              const isActive = o.id === activeOrgId;
              return (
                <li key={o.id}>
                  <button
                    onClick={() => onSwitch(o.id, o.name)}
                    disabled={isActive}
                    className={cn(
                      "w-full flex items-center gap-4 px-5 py-4 text-left transition-colors",
                      isActive ? "cursor-default bg-ink-50/50" : "hover:bg-ink-50",
                    )}
                  >
                    <Avatar name={o.name} size="md" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium tracking-tight text-ink-900 truncate">
                        {o.name}
                      </div>
                      <div className="text-[12px] text-ink-500 font-mono truncate">/{o.slug}</div>
                    </div>
                    {o.role === "admin" && <Badge tone="neutral">Admin</Badge>}
                    {isActive ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-900 tracking-tight">
                        <Check size={13} /> Active
                      </span>
                    ) : (
                      <span className="text-[12px] text-ink-500 tracking-tight">
                        Switch to →
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-ink-100 px-5 py-3 bg-ink-50/40 flex items-center justify-between">
            <p className="text-[12px] text-ink-500">Need a separate space for another team?</p>
            <Button variant="secondary" size="sm" asChild>
              <Link to="/onboarding">
                <Plus size={13} /> New workspace
              </Link>
            </Button>
          </div>
        </Card>
      </section>

      <section className="mb-10">
        <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Members & invitations</h2>
        <Card>
          <div className="flex items-center justify-between gap-4 p-5">
            <div>
              <div className="text-sm font-medium tracking-tight text-ink-900">Manage your team</div>
              <p className="text-[13px] text-ink-500 mt-0.5">
                Invite teammates, change roles, and revoke access.
              </p>
            </div>
            <Button variant="secondary" asChild>
              <Link to="/members">
                Open <ArrowUpRight size={13} />
              </Link>
            </Button>
          </div>
        </Card>
      </section>

      <section>
        <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Coming soon</h2>
        <Card>
          <ul className="divide-y divide-ink-100 text-sm">
            {[
              "Change password",
              "Two-factor authentication",
              "Default currency per workspace",
              "Webhooks for new receipts",
              "API tokens",
            ].map((item) => (
              <li key={item} className="flex items-center justify-between px-5 py-3">
                <span className="text-ink-700">{item}</span>
                <span className="text-[11px] text-ink-400 uppercase tracking-[0.08em]">Soon</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}
