// Centralized TanStack Query keys. Co-locating them here keeps cache
// invalidation predictable — never magic-string a key in a component.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const qk = {
  me:                            ["me"],
  orgs:                          ["orgs"],
  members:    (orgId)         => ["members", orgId],
  invitations:(orgId)         => ["invitations", orgId],
  documents:  (orgId)         => ["documents", orgId],
  document:   (orgId, id)     => ["document", orgId, id],
};

export const useMe = () =>
  useQuery({ queryKey: qk.me, queryFn: api.me });

export const useOrgs = () =>
  useQuery({ queryKey: qk.orgs, queryFn: api.listOrgs });

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
  });

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
