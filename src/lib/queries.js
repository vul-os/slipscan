// Centralized TanStack Query keys. Co-locating them here keeps cache
// invalidation predictable — never magic-string a key in a component.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const qk = {
  me:                            ["me"],
  orgs:                          ["orgs"],
  billingUsage:   (orgId)      => ["billing-usage", orgId],
  billingPlans:   (orgId)      => ["billing-plans", orgId],
  subscription:   (orgId)      => ["subscription", orgId],
  extractionModels:(orgId)     => ["extraction-models", orgId],
  pendingInvitations:            ["pending-invitations"],
  members:    (orgId)         => ["members", orgId],
  invitations:(orgId)         => ["invitations", orgId],
  documents:  (orgId)         => ["documents", orgId],
  document:   (orgId, id)     => ["document", orgId, id],
  transactions:(orgId)        => ["transactions", orgId],
  categories: (orgId)         => ["categories", orgId],
  spending:   (orgId, r)      => ["spending", orgId, r],
  budgets:    (orgId)         => ["budgets", orgId],
  goals:      (orgId)         => ["goals", orgId],
  netWorth:   (orgId)         => ["net-worth", orgId],
  netWorthHistory:(orgId)     => ["net-worth-history", orgId],
  accounts:   (orgId)         => ["accounts", orgId],
  trialBalance:(orgId, r)     => ["trial-balance", orgId, r],
  journals:   (orgId)         => ["journals", orgId],
  contacts:   (orgId)         => ["contacts", orgId],
  report:     (orgId, n, r)   => ["report", orgId, n, r],
  xeroStatus: (orgId)         => ["xero-status", orgId],
  audit:      (orgId, f)      => ["audit", orgId, f],
  bankConnections:(orgId)     => ["bank-connections", orgId],
  reconcile:  (orgId)         => ["reconcile", orgId],
  workspace:                     ["workspace"],
  forecast:   (orgId, h)      => ["forecast", orgId, h],
  anomalies:  (orgId)         => ["anomalies", orgId],
  taxReadiness:(orgId)        => ["tax-readiness", orgId],
};

// arr normalizes a `{ <key>: [...] }` envelope or bare array to an array.
const arr = (res, key) => (Array.isArray(res) ? res : res?.[key] ?? []);

export const useMe = () =>
  useQuery({ queryKey: qk.me, queryFn: api.me });

export const useUpdateProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.updateProfile(body),
    onSuccess: (data) => {
      if (data) qc.setQueryData(qk.me, data);
    },
  });
};

export const useUploadAvatar = () =>
  useMutation({ mutationFn: (file) => api.uploadAvatar(file) });

export const useUploadOrgAvatar = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file) => api.uploadOrgAvatar(orgId, file),
    onSuccess: () => {
      if (orgId) qc.invalidateQueries({ queryKey: qk.orgs });
    },
  });
};

export const useUpdateOrgAvatar = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.updateOrgAvatar(orgId, body),
    onSuccess: () => {
      if (orgId) qc.invalidateQueries({ queryKey: qk.orgs });
    },
  });
};

export const useOrgs = () =>
  useQuery({ queryKey: qk.orgs, queryFn: api.listOrgs });

// Fetch pending invitations addressed to the authenticated user's email.
// Enabled only when the user is logged in (accessToken present).
export const usePendingInvitations = (accessToken) =>
  useQuery({
    queryKey: qk.pendingInvitations,
    queryFn: () => api.listPendingInvitations().then((r) => r?.invitations ?? []),
    enabled: !!accessToken,
    staleTime: 30 * 1000, // re-check every 30 s max
  });

export const useMembers = (orgId) =>
  useQuery({
    queryKey: orgId ? qk.members(orgId) : ["members", "none"],
    queryFn: () => api.listMembers(orgId),
    enabled: !!orgId,
  });

export const useInvitations = (orgId) =>
  useQuery({
    queryKey: orgId ? qk.invitations(orgId) : ["invitations", "none"],
    queryFn: () => api.listInvitations(orgId),
    enabled: !!orgId,
  });

export const useDocuments = (orgId) =>
  useQuery({
    queryKey: orgId ? qk.documents(orgId) : ["documents", "none"],
    queryFn: () => api.listDocuments(orgId),
    enabled: !!orgId,
  });

export const useDocument = (orgId, docId) =>
  useQuery({
    queryKey: orgId && docId ? qk.document(orgId, docId) : ["document", "none"],
    queryFn: () => api.getDocument(orgId, docId),
    enabled: !!orgId && !!docId,
    // Poll while extraction is in flight so fields appear without a refresh.
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "pending" || s === "processing" ? 3000 : false;
    },
  });

// ── Phase 1: transactions, categories, classification corrections ───────────

// Normalizes the list endpoint's `{ transactions: [...] }` (or bare array) to
// an array. Each item carries its current classification inline.
export const useTransactions = (orgId) =>
  useQuery({
    queryKey: orgId ? qk.transactions(orgId) : ["transactions", "none"],
    queryFn: async () => {
      const res = await api.listTransactions(orgId);
      return Array.isArray(res) ? res : res?.transactions ?? [];
    },
    enabled: !!orgId,
  });

export const useCategories = (orgId) =>
  useQuery({
    queryKey: orgId ? qk.categories(orgId) : ["categories", "none"],
    queryFn: async () => {
      const res = await api.listCategories(orgId);
      return Array.isArray(res) ? res : res?.categories ?? [];
    },
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000, // categories rarely change
  });

export const useClassifyDocument = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId) => api.classifyDocument(orgId, docId),
    onSuccess: () => {
      if (orgId) qc.invalidateQueries({ queryKey: qk.transactions(orgId) });
    },
  });
};

export const useTriggerExtract = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId) => api.triggerExtract(orgId, docId),
    onSuccess: (_data, docId) => {
      if (orgId) {
        qc.invalidateQueries({ queryKey: qk.document(orgId, docId) });
        qc.invalidateQueries({ queryKey: qk.documents(orgId) });
      }
    },
  });
};

// Recategorize a transaction with an optimistic cache update. Variables:
// { txId, categoryId, categoryName?, accountId?, applyToExisting? }.
export const usePatchClassification = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ txId, categoryId, accountId, applyToExisting }) =>
      api.patchClassification(orgId, txId, { categoryId, accountId }, { applyToExisting }),
    onMutate: async ({ txId, categoryId, categoryName }) => {
      if (!orgId) return {};
      await qc.cancelQueries({ queryKey: qk.transactions(orgId) });
      const prev = qc.getQueryData(qk.transactions(orgId));
      qc.setQueryData(qk.transactions(orgId), (old) =>
        Array.isArray(old)
          ? old.map((t) =>
              t.id === txId
                ? { ...t, category_id: categoryId, category_name: categoryName ?? t.category_name, classification_source: "user", classification_confidence: 1 }
                : t,
            )
          : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (orgId && ctx?.prev !== undefined) qc.setQueryData(qk.transactions(orgId), ctx.prev);
    },
    onSettled: () => {
      if (orgId) qc.invalidateQueries({ queryKey: qk.transactions(orgId) });
    },
  });
};

export const useCreateOrg = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createOrg,
    onSuccess: (org) => {
      // Write the new org into the cache synchronously so the next render
      // sees orgs.length > 0. Without this, AppLayout reads the stale
      // empty list and bounces the user back to /onboarding before the
      // background refetch completes.
      qc.setQueryData(qk.orgs, (prev) => {
        const list = prev?.organizations ?? [];
        if (list.some((o) => o.id === org.id)) return prev;
        return { organizations: [...list, org] };
      });
      qc.invalidateQueries({ queryKey: qk.orgs });
    },
  });
};

export const useUploadDocument = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file }) =>
      api.uploadDocument(orgId, file),
    onSuccess: () => {
      if (orgId) qc.invalidateQueries({ queryKey: qk.documents(orgId) });
    },
  });
};

export const useCreateInvitation = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      api.createInvitation(orgId, input),
    onSuccess: () => {
      if (orgId) qc.invalidateQueries({ queryKey: qk.invitations(orgId) });
    },
  });
};

export const useRevokeInvitation = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId) => api.revokeInvitation(orgId, inviteId),
    onSuccess: () => {
      if (orgId) qc.invalidateQueries({ queryKey: qk.invitations(orgId) });
    },
  });
};

export const useResendInvitation = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId) => api.resendInvitation(orgId, inviteId),
    onSuccess: () => {
      if (orgId) qc.invalidateQueries({ queryKey: qk.invitations(orgId) });
    },
  });
};

export const useAcceptInvitation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token) => api.acceptInvitation(token),
    // The accept response carries the full org payload, so we hydrate the
    // orgs cache directly instead of round-tripping. AppLayout sees the
    // new membership immediately and won't bounce the user back to
    // /onboarding.
    onSuccess: (res) => {
      const newOrg = res?.organization;
      if (!newOrg) {
        qc.refetchQueries({ queryKey: qk.orgs });
        return;
      }
      qc.setQueryData(qk.orgs, (prev) => {
        const existing = prev?.organizations ?? [];
        if (existing.some((o) => o.id === newOrg.id)) return prev;
        return { organizations: [...existing, newOrg] };
      });
    },
  });
};

// ── Phase 2/4 read hooks (finance, ledger, reporting, audit, xero) ──────────
const enabledQuery = (orgId, key, fn, extra = {}) =>
  useQuery({ queryKey: orgId ? key : ["none"], queryFn: fn, enabled: !!orgId, ...extra });

export const useSpending = (orgId, range = {}) =>
  enabledQuery(orgId, qk.spending(orgId, range), () => api.getSpending(orgId, range));
export const useBudgets = (orgId) =>
  enabledQuery(orgId, qk.budgets(orgId), async () => arr(await api.listBudgets(orgId), "budgets"));
export const useGoals = (orgId) =>
  enabledQuery(orgId, qk.goals(orgId), async () => arr(await api.listGoals(orgId), "goals"));
export const useNetWorth = (orgId) =>
  enabledQuery(orgId, qk.netWorth(orgId), () => api.getNetWorth(orgId));
export const useNetWorthHistory = (orgId) =>
  enabledQuery(orgId, qk.netWorthHistory(orgId), () => api.getNetWorthHistory(orgId));
export const useAccounts = (orgId) =>
  enabledQuery(orgId, qk.accounts(orgId), async () => arr(await api.listAccounts(orgId), "accounts"));
export const useTrialBalance = (orgId, range = {}) =>
  enabledQuery(orgId, qk.trialBalance(orgId, range), () => api.getTrialBalance(orgId, range));
export const useJournals = (orgId) =>
  enabledQuery(orgId, qk.journals(orgId), async () => arr(await api.listJournals(orgId), "journals"));
export const useContacts = (orgId) =>
  enabledQuery(orgId, qk.contacts(orgId), async () => arr(await api.listContacts(orgId), "contacts"));
export const useReport = (orgId, name, range = {}) =>
  useQuery({ queryKey: orgId && name ? qk.report(orgId, name, range) : ["none"], queryFn: () => api.getReport(orgId, name, range), enabled: !!orgId && !!name });
export const useXeroStatus = (orgId) =>
  enabledQuery(orgId, qk.xeroStatus(orgId), () => api.xeroStatus(orgId), { retry: false });
export const useAudit = (orgId, filter = {}) =>
  enabledQuery(orgId, qk.audit(orgId, filter), async () => arr(await api.listAudit(orgId, filter), "entries"));

// Generic mutation factory: runs fn(orgId, vars) then invalidates the given keys.
export const useOrgMutation = (orgId, fn, invalidateKeys = []) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars) => fn(orgId, vars),
    onSuccess: () => invalidateKeys.forEach((k) => qc.invalidateQueries({ queryKey: k })),
  });
};

// ── Phase 3 read hooks (bank feeds, reconciliation) ─────────────────────────
export const useBankConnections = (orgId) =>
  enabledQuery(orgId, qk.bankConnections(orgId), async () => arr(await api.listBankConnections(orgId), "connections"));
export const useReconcile = (orgId) =>
  enabledQuery(orgId, qk.reconcile(orgId), () => api.getReconcile(orgId));

// ── Phase 4 read hooks (accountant workspace, cross-org intelligence) ───────
export const useWorkspace = () =>
  useQuery({ queryKey: qk.workspace, queryFn: async () => arr(await api.getWorkspace(), "orgs") });
export const useForecast = (orgId, horizon) =>
  enabledQuery(orgId, qk.forecast(orgId, horizon), () => api.getForecast(orgId, { horizon }));
export const useAnomalies = (orgId) =>
  enabledQuery(orgId, qk.anomalies(orgId), async () => arr(await api.getAnomalies(orgId), "anomalies"));
export const useTaxReadiness = (orgId) =>
  enabledQuery(orgId, qk.taxReadiness(orgId), () => api.getTaxReadiness(orgId));

// ── Billing ─────────────────────────────────────────────────────────────────

export const useBillingUsage = (orgId) =>
  useQuery({
    queryKey: orgId ? qk.billingUsage(orgId) : ["none"],
    queryFn: () => api.getBillingUsage(orgId),
    enabled: !!orgId,
    refetchInterval: 60_000, // refresh every 60 s
  });

export const useExtractionModels = (orgId) =>
  useQuery({
    queryKey: orgId ? qk.extractionModels(orgId) : ["none"],
    queryFn: () => api.listExtractionModels(orgId),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

export const useSetExtractionModel = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (modelId) => api.setExtractionModel(orgId, modelId),
    onSuccess: () => {
      if (orgId) qc.invalidateQueries({ queryKey: qk.extractionModels(orgId) });
    },
  });
};

// ── Paystack subscription hooks ──────────────────────────────────────────────

export const usePlans = (orgId) =>
  useQuery({
    queryKey: orgId ? qk.billingPlans(orgId) : ["none"],
    queryFn: async () => {
      const res = await api.getPlans(orgId);
      return Array.isArray(res) ? res : res?.plans ?? [];
    },
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

export const useSubscription = (orgId) =>
  useQuery({
    queryKey: orgId ? qk.subscription(orgId) : ["none"],
    queryFn: () => api.getSubscription(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });

export const useSubscribePlan = (orgId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.subscribePlan(orgId, body),
    onSuccess: () => {
      if (orgId) {
        qc.invalidateQueries({ queryKey: qk.subscription(orgId) });
        qc.invalidateQueries({ queryKey: qk.billingUsage(orgId) });
      }
    },
  });
};

export const useVerifySubscription = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.verifySubscription(body),
    onSuccess: (_data, _vars) => {
      // Invalidate subscription for all orgs (we may not know orgId here).
      qc.invalidateQueries({ queryKey: ["subscription"] });
      qc.invalidateQueries({ queryKey: ["billing-usage"] });
    },
  });
};
