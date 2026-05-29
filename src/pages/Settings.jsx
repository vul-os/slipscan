import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check, Plus, ArrowUpRight, Copy, CopyCheck, ExternalLink,
  Mail, Building2, User, Zap, AlertTriangle, Upload,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAuthStore } from "@/stores/auth";
import { useOrgStore } from "@/stores/org";
import { useOrgs, useXeroStatus, useUpdateProfile, useUploadAvatar, useUploadOrgAvatar, useUpdateOrgAvatar } from "@/lib/queries";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

const RX_DOMAIN = import.meta.env.VITE_RX_DOMAIN || "";

// ── Org info card ─────────────────────────────────────────────────────────────

function OrgInfoCard({ org }) {
  return (
    <Card>
      <div className="px-5 py-4 flex items-center gap-4">
        <div className="h-10 w-10 rounded-md bg-ink-100 flex items-center justify-center text-ink-500 shrink-0">
          <Building2 size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium tracking-tight text-ink-900">{org.name}</span>
            <Badge tone={org.role === "admin" ? "accent" : "neutral"} className="capitalize">
              {org.role}
            </Badge>
            <Badge tone="neutral" className="capitalize">{org.kind}</Badge>
          </div>
          <div className="text-[12px] text-ink-500 font-mono mt-0.5">/{org.slug}</div>
        </div>
      </div>
      <div className="border-t border-ink-100 px-5 py-3 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-[12px] text-ink-600">
        <Field label="Currency" value={(org.currency || "—").toUpperCase()} />
        <Field label="Kind" value={org.kind === "business" ? "Business" : "Personal"} />
        <Field label="Role" value={org.role === "admin" ? "Admin" : "Member"} className="col-span-2 sm:col-span-1" />
      </div>
    </Card>
  );
}

// ── Org avatar card (admins only) ─────────────────────────────────────────────

function OrgAvatarCard({ org }) {
  const [avatarUrl, setAvatarUrl] = useState(org?.avatar_url ?? "");
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef(null);
  const { mutate: uploadOrgAvatar, isPending: isUploading } = useUploadOrgAvatar(org?.id);
  const { mutate: updateOrgAvatar, isPending: isSaving } = useUpdateOrgAvatar(org?.id);

  // Sync local state when org changes (e.g. after save/switch)
  const orgAvatarRef = useRef(org?.avatar_url);
  if (org?.avatar_url !== orgAvatarRef.current) {
    orgAvatarRef.current = org?.avatar_url;
    setAvatarUrl(org?.avatar_url ?? "");
    setDirty(false);
  }

  const onSave = () => {
    updateOrgAvatar(
      { avatar_url: avatarUrl || null },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success("Workspace avatar saved");
        },
        onError: (e) => toast.error(e?.message || "Could not save avatar"),
      },
    );
  };

  const onPickFile = (file) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Use a JPG, PNG, or WebP image");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be 2 MB or smaller");
      return;
    }
    uploadOrgAvatar(file, {
      onSuccess: (data) => {
        const url = data?.url;
        if (!url) return toast.error("Upload succeeded but no URL returned");
        setAvatarUrl(url);
        setDirty(true);
        toast.success("Image uploaded — click Save to apply");
      },
      onError: (e) => toast.error(e?.message || "Upload failed"),
    });
  };

  return (
    <Card>
      <div className="flex items-center gap-4 px-5 py-4 border-b border-ink-100">
        <Avatar name={org?.name} src={avatarUrl || org?.avatar_url} size="lg" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium tracking-tight text-ink-900">{org?.name}</div>
          <div className="text-[13px] text-ink-500 font-mono">/{org?.slug}</div>
        </div>
        <Badge tone="accent">
          <Building2 size={11} /> Admin
        </Badge>
      </div>

      <div className="px-5 py-4 space-y-4">
        <div>
          <label className="block text-[11px] uppercase tracking-[0.07em] text-ink-400 mb-1" htmlFor="org-avatar">
            Workspace avatar
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => onPickFile(e.target.files?.[0])}
          />
          <div className="flex gap-2">
            <input
              id="org-avatar"
              type="url"
              value={avatarUrl}
              placeholder="https://… or upload an image →"
              onChange={(e) => { setAvatarUrl(e.target.value); setDirty(true); }}
              className="flex-1 rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-ink-900/20"
            />
            <Button
              variant="secondary"
              size="md"
              loading={isUploading}
              onClick={() => fileRef.current?.click()}
              type="button"
            >
              <Upload size={14} /> Upload
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-ink-400">
            Paste a URL or upload a JPG/PNG/WebP (≤ 2 MB) — stored on our R2 bucket.
            {!avatarUrl && " Leave blank to fall back to a default avatar."}
          </p>
        </div>

        {dirty && (
          <div className="flex justify-end">
            <Button size="sm" loading={isSaving} onClick={onSave}>
              Save avatar
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Field({ label, value, className }) {
  return (
    <div className={className}>
      <div className="text-[11px] uppercase tracking-[0.07em] text-ink-400 mb-0.5">{label}</div>
      <div className="font-medium text-ink-800">{value}</div>
    </div>
  );
}

// ── Inbound email card ────────────────────────────────────────────────────────

function InboundEmailCard({ org }) {
  const [copied, setCopied] = useState(false);
  const addr = org.rx_local_part
    ? RX_DOMAIN
      ? `${org.rx_local_part}@${RX_DOMAIN}`
      : `${org.rx_local_part}@…`
    : null;

  const onCopy = () => {
    if (!addr) return;
    navigator.clipboard.writeText(addr).then(() => {
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Card>
      <div className="px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 rounded bg-emerald-50 flex items-center justify-center text-emerald-600 shrink-0 mt-0.5">
            <Mail size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium tracking-tight text-ink-900">Inbound document email</div>
            <p className="text-[12px] text-ink-500 mt-0.5">
              Forward receipts and invoices to this address — they'll be captured automatically.
            </p>
          </div>
        </div>

        {addr ? (
          <div className="mt-4 flex items-center gap-2">
            <div className="flex-1 min-w-0 bg-ink-50 border border-ink-200 rounded px-3 py-2 font-mono text-[13px] text-ink-800 truncate select-all">
              {addr}
            </div>
            <Button variant="secondary" size="sm" onClick={onCopy} aria-label="Copy email">
              {copied ? <CopyCheck size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-2 text-[12px] text-ink-400">
            <Mail size={14} />
            Inbound email not configured for this workspace.
          </div>
        )}

        <p className="mt-3 text-[11px] text-ink-400">
          Tip: add this as a contact in your email client named "SlipScan" so forwarding is one tap.
        </p>
      </div>
    </Card>
  );
}

// ── Xero integration card (business only) ─────────────────────────────────────

function XeroCard({ org }) {
  const { data: status, isLoading, error } = useXeroStatus(org.id);
  const [pushing, setPushing] = useState(false);

  // 503 = not configured server-side; show disabled state
  const notConfigured = error?.status === 503 || error?.status === 404;
  const isConnected = status?.connected === true;

  const onPush = async () => {
    setPushing(true);
    try {
      await api.xeroPush(org.id);
      toast.success("Pushed to Xero successfully");
    } catch (e) {
      toast.error(e?.message || "Xero push failed");
    } finally {
      setPushing(false);
    }
  };

  return (
    <Card>
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="h-8 w-8 rounded bg-sky-50 flex items-center justify-center text-sky-600 shrink-0 mt-0.5">
              <Zap size={16} />
            </div>
            <div>
              <div className="text-sm font-medium tracking-tight text-ink-900">Xero integration</div>
              <p className="text-[12px] text-ink-500 mt-0.5">
                Push verified transactions and invoices directly to your Xero ledger.
              </p>
            </div>
          </div>

          {isLoading ? (
            <Skeleton className="h-5 w-20 rounded-full" />
          ) : notConfigured ? (
            <Badge tone="neutral">Not available</Badge>
          ) : isConnected ? (
            <Badge tone="success">Connected</Badge>
          ) : (
            <Badge tone="neutral">Disconnected</Badge>
          )}
        </div>

        {notConfigured && (
          <div className="mt-4 flex items-start gap-2 rounded-md bg-ink-50 border border-ink-200 px-3 py-2.5">
            <AlertTriangle size={14} className="text-ink-400 mt-0.5 shrink-0" />
            <p className="text-[12px] text-ink-500">
              Xero integration is not configured on this server. Contact your administrator to enable it.
            </p>
          </div>
        )}

        {!notConfigured && !isLoading && (
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            {!isConnected && (
              <Button
                variant="secondary"
                size="sm"
                asChild
              >
                <a href={api.xeroConnectURL(org.id)} rel="noopener noreferrer">
                  Connect Xero <ExternalLink size={12} />
                </a>
              </Button>
            )}
            {isConnected && (
              <Button
                variant="secondary"
                size="sm"
                loading={pushing}
                onClick={onPush}
              >
                <Zap size={13} />
                Push to Xero
              </Button>
            )}
            {status?.last_synced_at && (
              <span className="text-[12px] text-ink-400">
                Last synced {formatDate(status.last_synced_at)}
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── User account card (with avatar URL editing) ───────────────────────────────

function UserCard({ user }) {
  const setUser = useAuthStore((s) => s.setUser);
  const { mutate: updateProfile, isPending } = useUpdateProfile();
  const { mutate: uploadAvatar, isPending: isUploading } = useUploadAvatar();
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url ?? "");
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef(null);

  const onSave = () => {
    updateProfile(
      { avatar_url: avatarUrl || null, full_name: fullName },
      {
        onSuccess: (data) => {
          if (data) setUser(data);
          setDirty(false);
          toast.success("Profile saved");
        },
        onError: (e) => toast.error(e?.message || "Could not save profile"),
      },
    );
  };

  const onPickFile = (file) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Use a JPG, PNG, or WebP image");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be 2 MB or smaller");
      return;
    }
    uploadAvatar(file, {
      onSuccess: (data) => {
        const url = data?.url;
        if (!url) return toast.error("Upload succeeded but no URL returned");
        setAvatarUrl(url);
        setDirty(true);
        toast.success("Image uploaded — click Save to apply");
      },
      onError: (e) => toast.error(e?.message || "Upload failed"),
    });
  };

  return (
    <Card>
      <div className="flex items-center gap-4 px-5 py-4 border-b border-ink-100">
        <Avatar name={fullName || user?.email} src={avatarUrl || user?.avatar_url} size="lg" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium tracking-tight text-ink-900">
            {fullName || user?.full_name || "Unnamed user"}
          </div>
          <div className="text-[13px] text-ink-500 truncate">{user?.email}</div>
          {user?.created_at && (
            <div className="text-[11px] text-ink-400 mt-0.5">
              Member since {formatDate(user.created_at)}
            </div>
          )}
        </div>
        <div>
          <Badge tone="neutral">
            <User size={11} /> Account
          </Badge>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        <div>
          <label className="block text-[11px] uppercase tracking-[0.07em] text-ink-400 mb-1" htmlFor="profile-name">
            Display name
          </label>
          <input
            id="profile-name"
            type="text"
            value={fullName}
            placeholder="Your name"
            onChange={(e) => { setFullName(e.target.value); setDirty(true); }}
            className="w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-ink-900/20"
          />
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-[0.07em] text-ink-400 mb-1" htmlFor="profile-avatar">
            Avatar
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => onPickFile(e.target.files?.[0])}
          />
          <div className="flex gap-2">
            <input
              id="profile-avatar"
              type="url"
              value={avatarUrl}
              placeholder="https://… or upload an image →"
              onChange={(e) => { setAvatarUrl(e.target.value); setDirty(true); }}
              className="flex-1 rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-ink-900/20"
            />
            <Button
              variant="secondary"
              size="md"
              loading={isUploading}
              onClick={() => fileRef.current?.click()}
              type="button"
            >
              <Upload size={14} /> Upload
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-ink-400">
            Paste a URL or upload a JPG/PNG/WebP (≤ 2 MB) — stored on our R2 bucket.
            {!avatarUrl && " Leave blank to fall back to a default avatar."}
          </p>
        </div>

        {dirty && (
          <div className="flex justify-end">
            <Button size="sm" loading={isPending} onClick={onSave}>
              Save profile
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Workspace switcher ────────────────────────────────────────────────────────

function WorkspaceSection({ list, activeOrgId, isLoading, onSwitch }) {
  return (
    <section className="mb-10">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-medium tracking-tight text-ink-900">Workspaces</h2>
        {!isLoading && (
          <span className="text-[12px] text-ink-500 tnum">
            {list.length} {list.length === 1 ? "workspace" : "workspaces"}
          </span>
        )}
      </div>
      <Card className="overflow-hidden">
        {isLoading ? (
          <ul className="divide-y divide-ink-100">
            {Array.from({ length: 2 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-4">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1">
                  <Skeleton className="h-3 w-32 mb-2" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </li>
            ))}
          </ul>
        ) : (
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
                    <Avatar name={o.name} src={o.avatar_url} size="md" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium tracking-tight text-ink-900 truncate">
                        {o.name}
                      </div>
                      <div className="text-[12px] text-ink-500 font-mono truncate">/{o.slug}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {o.role === "admin" && <Badge tone="neutral">Admin</Badge>}
                      {o.kind === "business" && <Badge tone="neutral">Business</Badge>}
                      {isActive ? (
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-900 tracking-tight">
                          <Check size={13} /> Active
                        </span>
                      ) : (
                        <span className="text-[12px] text-ink-500 tracking-tight">Switch →</span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
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
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const { activeOrgId, setActiveOrg } = useOrgStore();
  const { data: orgs, isLoading } = useOrgs();
  const list = orgs?.organizations ?? [];
  const activeOrg = list.find((o) => o.id === activeOrgId);

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
        description="Org details, inbound email, integrations, and account."
      />

      {/* Active org info */}
      {activeOrg && (
        <section className="mb-10">
          <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Active workspace</h2>
          <OrgInfoCard org={activeOrg} />
        </section>
      )}

      {/* Org avatar — admins only */}
      {activeOrg && (activeOrg.role === "owner" || activeOrg.role === "admin") && (
        <section className="mb-10">
          <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Workspace avatar</h2>
          <OrgAvatarCard org={activeOrg} />
        </section>
      )}

      {/* Inbound document email */}
      {activeOrg && (
        <section className="mb-10">
          <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Inbound document email</h2>
          <InboundEmailCard org={activeOrg} />
        </section>
      )}

      {/* Xero — business orgs only */}
      {activeOrg?.kind === "business" && (
        <section className="mb-10">
          <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Xero integration</h2>
          <XeroCard org={activeOrg} />
        </section>
      )}

      {/* Workspace switcher */}
      <WorkspaceSection
        list={list}
        activeOrgId={activeOrgId}
        isLoading={isLoading}
        onSwitch={onSwitch}
      />

      {/* Members shortcut */}
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

      {/* User account */}
      <section>
        <h2 className="text-base font-medium tracking-tight text-ink-900 mb-3">Your account</h2>
        <UserCard user={user} />
      </section>
    </div>
  );
}
