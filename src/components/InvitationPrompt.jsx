/**
 * InvitationPrompt — auto-detects pending invitations for the signed-in user
 * and presents an accept/decline modal. Mounted inside AppLayout so it fires
 * on every authenticated page load without requiring the user to visit a
 * special URL.
 *
 * Flow:
 *  1. Query GET /invitations/pending on mount (gated on accessToken).
 *  2. If any pending invites exist, open a Dialog listing them.
 *  3. User clicks Accept → POST /invitations/accept with the invite id acting
 *     as lookup (server matches by caller email, no public token needed here —
 *     but AcceptByEmail helper below just passes the invite id as a special
 *     path; see note below). Actually we re-use the existing token-based
 *     accept path: the server returns an accept_url/token only for org admins,
 *     so here we accept by *invite id* via a new accept-by-id endpoint…
 *
 *  Actually: the existing POST /invitations/accept requires a *token*.
 *  The pending list endpoint we added returns invite rows without exposing the
 *  token hash. We therefore add a second mutation path:
 *    POST /invitations/:id/accept-by-user
 *  …but that would require another backend change.
 *
 *  Simpler approach (zero new backend): pass the invite *id* as a synthetic
 *  "token" — but the server hashes the token, so a raw UUID won't match.
 *
 *  Correct minimal approach: add POST /invitations/:id/accept (auth-gated,
 *  matches by id + caller email). We already added GET /invitations/pending;
 *  we add this companion endpoint now.
 *
 *  See worker/src/modules/orgs/routes.ts — inviteAcceptRouter.post("/:id/accept-by-id", …)
 *  is registered below.
 *
 *  NOTE: This file calls api.acceptInvitationById(id).
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useAuthStore } from "@/stores/auth";
import { useOrgStore } from "@/stores/org";
import { usePendingInvitations } from "@/lib/queries";
import { qk } from "@/lib/queries";
import { api } from "@/lib/api";

export function InvitationPrompt() {
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);
  const setActiveOrg = useOrgStore((s) => s.setActiveOrg);
  const qc = useQueryClient();

  const { data: pending = [], isSuccess } = usePendingInvitations(accessToken);

  // Track which invites have been decided so we can remove them from the list.
  const [decided, setDecided] = useState({}); // { [inviteId]: "accepted" | "declined" }
  const [open, setOpen] = useState(false);

  // Open the dialog once we know there are pending invites (only on initial load).
  useEffect(() => {
    if (isSuccess && pending.length > 0) {
      setOpen(true);
    }
  }, [isSuccess, pending.length]);

  const acceptMutation = useMutation({
    mutationFn: (inviteId) => api.acceptInvitationById(inviteId),
    onSuccess: (res, inviteId) => {
      const newOrg = res?.organization;
      if (newOrg) {
        qc.setQueryData(qk.orgs, (prev) => {
          const existing = prev?.organizations ?? [];
          if (existing.some((o) => o.id === newOrg.id)) return prev;
          return { organizations: [...existing, newOrg] };
        });
        setActiveOrg(newOrg.id);
      }
      setDecided((d) => ({ ...d, [inviteId]: "accepted" }));
      toast.success(`Joined ${res?.organization?.name ?? "organization"}`);
    },
    onError: (e, inviteId) => {
      toast.error(e.message || "Could not accept invitation");
      // Mark as declined so UI moves on.
      setDecided((d) => ({ ...d, [inviteId]: "declined" }));
    },
  });

  const handleDecline = (inviteId) => {
    setDecided((d) => ({ ...d, [inviteId]: "declined" }));
  };

  const undecided = pending.filter((inv) => !decided[inv.id]);
  const acceptedCount = Object.values(decided).filter((v) => v === "accepted").length;

  // When all invites have been decided, close the dialog.
  useEffect(() => {
    if (!open) return;
    if (pending.length > 0 && undecided.length === 0) {
      // Short delay so the user sees the last decision animate.
      const t = setTimeout(() => {
        setOpen(false);
        // Invalidate so AppLayout gets fresh org list and pending invite list.
        qc.invalidateQueries({ queryKey: qk.orgs });
        qc.invalidateQueries({ queryKey: qk.pendingInvitations });

        // If no org was joined, send to onboarding.
        if (acceptedCount === 0) {
          const orgs = qc.getQueryData(qk.orgs);
          const orgList = orgs?.organizations ?? [];
          if (orgList.length === 0) {
            navigate("/onboarding", { replace: true });
          }
        }
      }, 300);
      return () => clearTimeout(t);
    }
  }, [undecided.length, open, pending.length, acceptedCount, navigate, qc]);

  if (!open || pending.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={() => { /* prevent close on overlay click while mutations in flight */ }}>
      <DialogContent hideClose>
        <DialogHeader>
          <DialogTitle>You have been invited</DialogTitle>
          <DialogDescription>
            {pending.length === 1
              ? "You have a pending invitation to join an organization."
              : `You have ${pending.length} pending invitations. Review each one below.`}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-2 space-y-3">
          {pending.map((inv) => {
            const state = decided[inv.id];
            return (
              <InviteRow
                key={inv.id}
                invite={inv}
                state={state}
                isLoading={acceptMutation.isPending && acceptMutation.variables === inv.id}
                onAccept={() => acceptMutation.mutate(inv.id)}
                onDecline={() => handleDecline(inv.id)}
              />
            );
          })}
        </div>

        <DialogFooter>
          <p className="text-xs text-ink-400 mr-auto">
            Declining all invites will take you to create your own organization.
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteRow({ invite, state, isLoading, onAccept, onDecline }) {
  const roleLabel = invite.role.charAt(0).toUpperCase() + invite.role.slice(1);

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-ink-200 bg-ink-50">
      <span className="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-ink-200 text-ink-700">
        <Building2 size={16} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium tracking-tight text-ink-900 truncate">
          {invite.org_name}
        </p>
        <p className="text-[12px] text-ink-500">
          Role: <span className="text-ink-700">{roleLabel}</span>
        </p>
      </div>
      {state === "accepted" && (
        <span className="flex items-center gap-1 text-xs text-green-700 font-medium">
          <Check size={13} /> Joined
        </span>
      )}
      {state === "declined" && (
        <span className="text-xs text-ink-400">Declined</span>
      )}
      {!state && (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onDecline}
            disabled={isLoading}
          >
            <X size={13} />
            Decline
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={isLoading}
            onClick={onAccept}
          >
            <Check size={13} />
            Accept
          </Button>
        </div>
      )}
    </div>
  );
}
