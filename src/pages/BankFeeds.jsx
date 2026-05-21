import { useState } from "react";
import {
  Link2, RefreshCw, Trash2, AlertTriangle, Wifi, WifiOff,
  Clock, Building2, Plus, RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, CardBody, CardTitle, CardSubtitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useBankConnections, useOrgMutation } from "@/lib/queries";
import { qk } from "@/lib/queries";
import { api } from "@/lib/api";
import { useOrgStore } from "@/stores/org";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/cn";

// ── Status helpers ────────────────────────────────────────────────────────────

/**
 * Map a connection status to a Badge tone + label.
 * status ∈ pending | connected | reauth_required | error | disconnected
 */
function statusConfig(status) {
  switch (status) {
    case "connected":
      return { tone: "success", label: "Connected", Icon: Wifi };
    case "pending":
      return { tone: "warning", label: "Pending", Icon: Clock };
    case "reauth_required":
      return { tone: "danger", label: "Re-auth required", Icon: AlertTriangle };
    case "error":
      return { tone: "danger", label: "Error", Icon: AlertTriangle };
    case "disconnected":
      return { tone: "neutral", label: "Disconnected", Icon: WifiOff };
    default:
      return { tone: "neutral", label: status ?? "Unknown", Icon: WifiOff };
  }
}

function needsReconnect(status) {
  return status === "reauth_required" || status === "error";
}

// ── Connect button (shared) ───────────────────────────────────────────────────

/**
 * Calls bankfeedConnect, navigates to link_url on success.
 * On 503 it sets a flag so the caller can show a "not configured" note.
 */
function useConnectFlow(orgId, { onNotConfigured } = {}) {
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    if (!orgId) {
      toast.error("No active workspace selected.");
      return;
    }
    setConnecting(true);
    try {
      const result = await api.bankfeedConnect(orgId);
      const url = result?.link_url;
      if (!url) {
        toast.error("Bank connection did not return a link. Please try again.");
        return;
      }
      window.location.href = url;
    } catch (err) {
      if (err?.status === 503) {
        onNotConfigured?.();
      } else {
        toast.error(err?.message ?? "Failed to start bank connection.");
      }
    } finally {
      setConnecting(false);
    }
  };

  return { connect, connecting };
}

// ── Connection card ───────────────────────────────────────────────────────────

function ConnectionCard({ connection, orgId }) {
  const { id, institution_name, mask, status, last_synced_at, error_message } = connection ?? {};
  const cfg = statusConfig(status);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Sync mutation — invalidates the connections list on success
  const syncMutation = useOrgMutation(
    orgId,
    (_, connId) => api.triggerBankSync(orgId, connId),
    [qk.bankConnections(orgId)],
  );

  // Disconnect mutation
  const disconnectMutation = useOrgMutation(
    orgId,
    (_, connId) => api.disconnectBank(orgId, connId),
    [qk.bankConnections(orgId)],
  );

  // Reconnect flow (reauth_required / error)
  const { connect: reconnect, connecting: reconnecting } = useConnectFlow(orgId);

  const handleSync = async () => {
    try {
      await syncMutation.mutateAsync(id);
      toast.success("Sync started — your transactions will update shortly.");
    } catch (err) {
      toast.error(err?.message ?? "Sync request failed.");
    }
  };

  const handleDisconnect = async () => {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    try {
      await disconnectMutation.mutateAsync(id);
      toast.success(`${institution_name ?? "Account"} disconnected.`);
    } catch (err) {
      toast.error(err?.message ?? "Disconnect failed.");
      setConfirmDisconnect(false);
    }
  };

  const handleCancelDisconnect = () => setConfirmDisconnect(false);

  const syncing = syncMutation.isPending;
  const disconnecting = disconnectMutation.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          {/* Icon + name */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-md bg-ink-100 flex items-center justify-center text-ink-500 shrink-0">
              <Building2 size={17} />
            </div>
            <div className="min-w-0">
              <CardTitle className="truncate">
                {institution_name ?? "Unknown bank"}
              </CardTitle>
              {mask && (
                <CardSubtitle>
                  ••••&nbsp;{mask}
                </CardSubtitle>
              )}
            </div>
          </div>

          {/* Status badge */}
          <Badge tone={cfg.tone} dot className="shrink-0">
            {cfg.label}
          </Badge>
        </div>
      </CardHeader>

      <CardBody className="space-y-4">
        {/* Last synced */}
        <div className="flex items-center gap-1.5 text-[12px] text-ink-500">
          <Clock size={12} className="shrink-0" />
          {last_synced_at
            ? <>Last synced {formatRelative(last_synced_at)}</>
            : "Never synced"}
        </div>

        {/* Error / reauth callout */}
        {needsReconnect(status) && (
          <div className="flex items-start gap-2 rounded-md bg-red-50 border border-red-200 px-3 py-2.5">
            <AlertTriangle size={14} className="text-red-500 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-red-700">
                {status === "reauth_required"
                  ? "Re-authorisation required"
                  : "Connection error"}
              </p>
              {error_message && (
                <p className="text-[11px] text-red-600 mt-0.5 break-words">
                  {error_message}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {needsReconnect(status) ? (
            <Button
              variant="accent"
              size="sm"
              loading={reconnecting}
              onClick={reconnect}
            >
              <RotateCcw size={13} />
              Reconnect
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={syncing}
              disabled={status === "disconnected" || status === "pending"}
              onClick={handleSync}
            >
              <RefreshCw size={13} />
              Sync now
            </Button>
          )}

          {confirmDisconnect ? (
            <div className="flex items-center gap-2">
              <Button
                variant="destructive"
                size="sm"
                loading={disconnecting}
                onClick={handleDisconnect}
              >
                Confirm disconnect
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancelDisconnect}
                disabled={disconnecting}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-ink-400 hover:text-danger"
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              <Trash2 size={13} />
              Disconnect
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ── Not-configured banner ─────────────────────────────────────────────────────

function NotConfiguredBanner() {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 mb-6">
      <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />
      <div>
        <p className="text-sm font-medium text-amber-800">Bank feeds not configured</p>
        <p className="text-[12px] text-amber-700 mt-0.5">
          The bank-feed provider has not been set up on this server yet. Contact your
          administrator to enable it.
        </p>
      </div>
    </div>
  );
}

// ── Skeleton loader ───────────────────────────────────────────────────────────

function ConnectionSkeleton() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-md" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </CardHeader>
      <CardBody>
        <Skeleton className="h-3 w-36 mb-4" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24 rounded" />
          <Skeleton className="h-8 w-24 rounded" />
        </div>
      </CardBody>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BankFeedsPage() {
  const orgId = useOrgStore((s) => s.activeOrgId);
  const [notConfigured, setNotConfigured] = useState(false);

  const { data: connections, isLoading, isError } = useBankConnections(orgId);
  const connectionList = Array.isArray(connections) ? connections : [];

  const { connect, connecting } = useConnectFlow(orgId, {
    onNotConfigured: () => setNotConfigured(true),
  });

  const connectBtn = (
    <Button
      variant="accent"
      loading={connecting}
      onClick={connect}
    >
      <Plus size={14} />
      Connect a bank
    </Button>
  );

  return (
    <div className="page-shell max-w-[820px]">
      <PageHeader
        eyebrow="Integrations"
        title="Bank Feeds"
        description="Connect your bank accounts to import transactions automatically."
        actions={!notConfigured && connectBtn}
      />

      {/* Not-configured banner (503 from provider) */}
      {notConfigured && <NotConfiguredBanner />}

      {/* Main content */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <ConnectionSkeleton />
          <ConnectionSkeleton />
        </div>
      ) : isError ? (
        <Card>
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-ink-500">Failed to load bank connections.</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => window.location.reload()}
            >
              Retry
            </Button>
          </div>
        </Card>
      ) : connectionList.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Link2 size={22} />}
            title="No bank accounts connected"
            description="Connect your bank to import transactions automatically and keep your books up to date."
            action={!notConfigured && connectBtn}
          />
        </Card>
      ) : (
        <>
          <div
            className={cn(
              "grid gap-4",
              connectionList.length > 1 ? "sm:grid-cols-2" : "",
            )}
          >
            {connectionList.map((conn) => (
              <ConnectionCard
                key={conn?.id ?? Math.random()}
                connection={conn}
                orgId={orgId}
              />
            ))}
          </div>

          {/* Bottom connect button when connections exist */}
          {!notConfigured && (
            <div className="mt-6 flex justify-start">
              <Button variant="secondary" loading={connecting} onClick={connect}>
                <Plus size={14} />
                Connect another bank
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
