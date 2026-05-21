// Single-file API client. All backend calls flow through `request()` so
// auth, error shape, and refresh logic live in exactly one place.

import { useAuthStore } from "@/stores/auth";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8081";

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
  get isRateLimited() {
    return this.status === 429 || this.code === "rate_limited";
  }
}

let refreshInFlight = null;

async function refreshTokens() {
  if (refreshInFlight) return refreshInFlight;
  const refresh = useAuthStore.getState().refreshToken;
  if (!refresh) return null;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (!res.ok) return null;
      const pair = await res.json();
      useAuthStore.getState().setTokens(pair);
      return pair;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body;

  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  if (!opts.noAuth) {
    const token = useAuthStore.getState().accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const doFetch = () =>
    fetch(`${BASE_URL}${path}`, { method: opts.method || "GET", headers, body, signal: opts.signal });

  let res = await doFetch();

  if (res.status === 401 && !opts.noAuth) {
    const pair = await refreshTokens();
    if (pair) {
      headers["Authorization"] = `Bearer ${pair.access_token}`;
      res = await doFetch();
    } else {
      useAuthStore.getState().logout();
    }
  }

  if (res.status === 204) {
    return undefined;
  }

  const text = await res.text();
  const data = text ? safeJSON(text) : null;
  if (!res.ok) {
    const msg = (data && typeof data === "object" && "error" in data && typeof data.error === "string")
      ? data.error
      : `Request failed (${res.status})`;
    const code = data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : undefined;
    throw new ApiError(msg, res.status, code);
  }
  return data;
}

function safeJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export const api = {
  register: (input) =>
    request("/auth/register", { method: "POST", body: input, noAuth: true }),

  login: (input) =>
    request("/auth/login", { method: "POST", body: input, noAuth: true }),

  me: () => request("/auth/me"),

  listOrgs: () => request("/orgs"),
  createOrg: (input) =>
    request("/orgs", { method: "POST", body: input }),
  listMembers: (orgId) =>
    request(`/orgs/${orgId}/members`),

  listInvitations: (orgId) =>
    request(`/orgs/${orgId}/invitations`),
  createInvitation: (orgId, input) =>
    request(`/orgs/${orgId}/invitations`, { method: "POST", body: input }),
  revokeInvitation: (orgId, inviteId) =>
    request(`/orgs/${orgId}/invitations/${inviteId}`, { method: "DELETE" }),
  resendInvitation: (orgId, inviteId) =>
    request(`/orgs/${orgId}/invitations/${inviteId}/resend`, { method: "POST" }),
  acceptInvitation: (token) =>
    request("/invitations/accept", {
      method: "POST",
      body: { token },
    }),

  listDocuments: (orgId, limit = 100) =>
    request(`/orgs/${orgId}/documents?limit=${limit}`),
  getDocument: (orgId, docId) =>
    request(`/orgs/${orgId}/documents/${docId}`),
  uploadDocument: (orgId, file, signal) => {
    const fd = new FormData();
    fd.append("file", file);
    return request(`/orgs/${orgId}/documents`, {
      method: "POST",
      formData: fd,
      signal,
    });
  },

  ask: (orgId, question, signal) =>
    request(`/orgs/${orgId}/ask`, {
      method: "POST",
      body: { question },
      signal,
    }),

  // ── Phase 1: extraction, classification, corrections ──────────────────────

  // Re-run the typed extraction pipeline (P1-01) on an existing document.
  triggerExtract: (orgId, docId) =>
    request(`/orgs/${orgId}/documents/${docId}/extract`, { method: "POST" }),

  // (Re-)run the classification cascade (P1-02) for a document.
  // Returns { transactions: [...] }.
  classifyDocument: (orgId, docId) =>
    request(`/orgs/${orgId}/documents/${docId}/classify`, { method: "POST" }),

  // List the org's transactions (P1-02). Each row carries its current
  // classification inline: category_id, category_name, classification_source,
  // classification_confidence. Filter by document client-side on `document_id`.
  listTransactions: (orgId, { limit = 100, offset = 0 } = {}) =>
    request(`/orgs/${orgId}/transactions?limit=${limit}&offset=${offset}`),

  // The org's category tree (for the correction picker). Returns
  // { categories: [{ id, parent_id, name, kind, icon, color }] }.
  listCategories: (orgId) => request(`/orgs/${orgId}/categories`),

  // Recategorize a transaction (P1-03). When applyToExisting is true the
  // backend also reclassifies past non-user transactions for the same merchant.
  patchClassification: (orgId, txId, { categoryId, accountId } = {}, { applyToExisting = false } = {}) =>
    request(
      `/orgs/${orgId}/transactions/${txId}/classification${applyToExisting ? "?apply_to_existing=true" : ""}`,
      {
        method: "PATCH",
        body: accountId ? { category_id: categoryId, account_id: accountId } : { category_id: categoryId },
      },
    ),
};
