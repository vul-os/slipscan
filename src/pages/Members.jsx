import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, MoreHorizontal, Mail, MailCheck, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField } from "@/components/ui/FormField";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogBody, DialogFooter,
} from "@/components/ui/Dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/DropdownMenu";
import {
  useCreateInvitation, useInvitations, useMembers, useOrgs,
  useResendInvitation, useRevokeInvitation,
} from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { formatDate, formatRelative } from "@/lib/format";

export default function MembersPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const { data: orgsData } = useOrgs();
  const activeOrg = orgsData?.organizations.find((o) => o.id === orgId);
  const isAdmin = activeOrg?.role === "admin";

  const { data: members, isLoading: membersLoading } = useMembers(orgId);
  const { data: invitations, isLoading: invitesLoading } = useInvitations(isAdmin ? orgId : null);
  const [inviteOpen, setInviteOpen] = useState(false);

  return (
    <div className="page-shell max-w-[1080px]">
      <PageHeader
        eyebrow="Workspace"
        title="Members"
        description="People who can upload, view, and verify receipts in this organization."
        actions={isAdmin && (
          <Button variant="accent" onClick={() => setInviteOpen(true)}>
            <Plus size={14} /> Invite member
          </Button>
        )}
      />

      <section className="mb-10">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-medium tracking-tight text-ink-900">Active members</h2>
          {!membersLoading && (
            <span className="text-[12px] text-ink-500 tnum">
              {members?.members.length ?? 0} {(members?.members.length ?? 0) === 1 ? "member" : "members"}
            </span>
          )}
        </div>
        <Card className="overflow-hidden">
          {membersLoading ? <ListSkel /> : (
            <ul className="divide-y divide-ink-100">
              {members?.members.map((m) => (
                <li key={m.user_id} className="flex items-center gap-3 px-5 py-3.5">
                  <Avatar name={m.full_name || m.email} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium tracking-tight text-ink-900 truncate">
                      {m.full_name || m.email}
                    </div>
                    {m.full_name && <div className="text-[12px] text-ink-500 truncate">{m.email}</div>}
                  </div>
                  <Badge tone={m.role === "admin" ? "accent" : "neutral"}>
                    {m.role === "admin" ? "Admin" : "Member"}
                  </Badge>
                  <span className="text-[12px] text-ink-500 hidden sm:inline w-32 text-right">
                    Joined {formatRelative(m.joined_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {isAdmin && (
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-base font-medium tracking-tight text-ink-900">Pending invitations</h2>
            {!invitesLoading && (
              <span className="text-[12px] text-ink-500 tnum">
                {invitations?.invitations.length ?? 0} pending
              </span>
            )}
          </div>
          <Card className="overflow-hidden">
            {invitesLoading ? <ListSkel /> : invitations && invitations.invitations.length > 0 ? (
              <ul className="divide-y divide-ink-100">
                {invitations.invitations.map((inv) => (
                  <PendingRow key={inv.id} inv={inv} orgId={orgId} />
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<Mail size={20} />}
                title="No pending invitations"
                description="Invite a teammate to give them access to your receipts."
                action={
                  <Button variant="accent" onClick={() => setInviteOpen(true)}>
                    <Plus size={14} /> Invite member
                  </Button>
                }
              />
            )}
          </Card>
        </section>
      )}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}

function PendingRow({ inv, orgId }) {
  const revoke = useRevokeInvitation(orgId);
  const resend = useResendInvitation(orgId);
  return (
    <li className="flex items-center gap-3 px-5 py-3.5">
      <div className="h-8 w-8 rounded-full bg-ink-100 flex items-center justify-center text-ink-400 shrink-0">
        <Mail size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium tracking-tight text-ink-900 truncate">{inv.email}</div>
        <div className="text-[12px] text-ink-500">Expires {formatDate(inv.expires_at)}</div>
      </div>
      <Badge tone="neutral">{inv.role === "admin" ? "Admin" : "Member"}</Badge>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More">
            <MoreHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={resend.isPending}
            onClick={() => {
              resend.mutate(inv.id, {
                onSuccess: () => toast.success(`Invitation re-sent to ${inv.email}`),
                onError: (e) => toast.error(e.message),
              });
            }}
          >
            <Mail size={14} /> Resend
          </DropdownMenuItem>
          <DropdownMenuItem
            destructive
            onClick={() => {
              revoke.mutate(inv.id, {
                onSuccess: () => toast.success("Invitation revoked"),
                onError: (e) => toast.error(e.message),
              });
            }}
          >
            <X size={14} /> Revoke
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email"),
  role: z.enum(["admin", "member"]),
});

function InviteDialog({ open, onOpenChange }) {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const create = useCreateInvitation(orgId);
  const [sentTo, setSentTo] = useState(null);
  const { register, handleSubmit, formState: { errors }, reset, watch, setValue } = useForm({
    resolver: zodResolver(inviteSchema),
    defaultValues: { role: "member" },
  });
  const role = watch("role");

  const close = (o) => {
    onOpenChange(o);
    if (!o) {
      setSentTo(null);
      reset();
    }
  };

  const onSubmit = (data) => {
    create.mutate(data, {
      onSuccess: (inv) => setSentTo(inv.email),
      onError: (e) => toast.error(e.message),
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>They'll get access to all receipts in this workspace.</DialogDescription>
        </DialogHeader>

        {sentTo ? (
          <>
            <DialogBody>
              <div className="flex flex-col items-center text-center px-4 py-8">
                <div className="h-12 w-12 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600 mb-4">
                  <MailCheck size={22} />
                </div>
                <h3 className="text-base font-medium tracking-tight text-ink-900">Invitation sent</h3>
                <p className="mt-1.5 text-sm text-ink-500 max-w-sm">
                  We emailed an invitation to{" "}
                  <span className="font-medium text-ink-700 break-all">{sentTo}</span>.
                  The link expires in 7 days.
                </p>
                <p className="mt-3 text-[12px] text-ink-400 max-w-sm">
                  Tell them to check their spam folder if it doesn't arrive within a few minutes.
                </p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>Done</Button>
              <Button variant="primary" onClick={() => { setSentTo(null); reset(); }}>
                Invite another
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)}>
            <DialogBody className="space-y-5">
              <FormField label="Email" error={errors.email?.message} required>
                {(id) => (
                  <Input id={id} type="email" autoFocus placeholder="teammate@company.com" invalid={!!errors.email} {...register("email")} />
                )}
              </FormField>
              <FormField label="Role">
                {() => (
                  <div className="grid grid-cols-2 gap-2">
                    <RoleOption checked={role === "member"} onClick={() => setValue("role", "member")} title="Member" hint="Upload and view receipts" />
                    <RoleOption checked={role === "admin"} onClick={() => setValue("role", "admin")} title="Admin" hint="Manage members + receipts" />
                  </div>
                )}
              </FormField>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={() => close(false)}>Cancel</Button>
              <Button variant="primary" type="submit" loading={create.isPending}>Send invite</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RoleOption({ checked, onClick, title, hint }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-md border px-3 py-2.5 transition-all ${
        checked
          ? "border-ink-900 bg-ink-50 ring-2 ring-ink-900/10"
          : "border-ink-200 hover:border-ink-300"
      }`}
    >
      <div className="text-sm font-medium tracking-tight text-ink-900">{title}</div>
      <div className="text-[11px] text-ink-500 mt-0.5">{hint}</div>
    </button>
  );
}

function ListSkel() {
  return (
    <ul className="divide-y divide-ink-100">
      {Array.from({ length: 3 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-5 py-3.5">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-3 w-40 mb-2" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-4 w-14 rounded-full" />
        </li>
      ))}
    </ul>
  );
}
