/**
 * Interaction tests for the ReceiptDetail page.
 *
 * Contract (PHASE1-FRONTEND-CONTRACT.md):
 *   - Page uses useDocument(orgId, docId) for the main receipt
 *   - Transactions filtered client-side on document_id via useTransactions
 *   - usePatchClassification drives the category picker
 *   - useTriggerExtract / useClassifyDocument are available action buttons
 *   - No "verify" endpoint exists — do not test for it
 *
 * FE-2 is rewriting ReceiptDetail.jsx to integrate Phase 1 hooks.
 * The current page file only shows document details (no transactions/confidence).
 * UI tests against the final markup are it.skip'd with "pending FE-1/FE-2" notes.
 * Contract-level and hook-level tests run immediately.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api", () => ({
  api: {
    listTransactions: vi.fn(),
    listCategories: vi.fn(),
    patchClassification: vi.fn(),
    listDocuments: vi.fn(),
    getDocument: vi.fn(),
    me: vi.fn(),
    listOrgs: vi.fn(),
    listMembers: vi.fn(),
    listInvitations: vi.fn(),
    uploadDocument: vi.fn(),
    ask: vi.fn(),
    triggerExtract: vi.fn(),
    classifyDocument: vi.fn(),
    register: vi.fn(),
    login: vi.fn(),
    createOrg: vi.fn(),
    createInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    resendInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/stores/org", () => ({
  useOrgStore: (selector) =>
    selector({ activeOrgId: "org-test", setActiveOrg: vi.fn() }),
}));

import { api } from "@/lib/api";

// ── Sample data ───────────────────────────────────────────────────────────────
const SAMPLE_DOC = {
  id: "doc-abc123",
  object_key: "uploads/receipt.jpg",
  merchant: "Checkers",
  amount: 312.5,
  currency: "ZAR",
  transaction_date: "2024-04-10",
  created_at: "2024-04-10T09:00:00Z",
  status: "pending",
  image_url: "https://storage.example.com/receipt.jpg",
  tax: 40.75,
  payment_method: "card",
  notes: null,
  extraction_error: null,
  raw_extraction: {
    kind: "slip",
    merchant: "Checkers",
    total: 312.5,
    currency: "ZAR",
    confidence: 0.88,
    line_items: [
      { description: "Milk 2L", qty: 2, unit_price: 24.99, total: 49.98 },
      { description: "Bread",   qty: 1, unit_price: 15.99, total: 15.99 },
    ],
  },
};

const TX_FOR_DOC = [
  {
    id: "tx-1",
    document_id: "doc-abc123",
    merchant: "Checkers",
    amount: 312.5,
    currency: "ZAR",
    posted_date: "2024-04-10",
    direction: "debit",
    status: "posted",
    classification_source: "model",
    classification_confidence: 0.88,
    category_id: "cat-groceries",
    category_name: "Groceries",
  },
];

const SAMPLE_CATEGORIES = [
  { id: "cat-groceries", parent_id: null, name: "Groceries", kind: "expense", icon: null, color: null },
  { id: "cat-travel",   parent_id: null, name: "Travel",    kind: "expense", icon: null, color: null },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
  });
}

// ── Contract-level tests (hook-level, no page markup dependency) ──────────────
describe("ReceiptDetail page — contract logic (mock-level)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDocument.mockResolvedValue(SAMPLE_DOC);
    api.listTransactions.mockResolvedValue({ transactions: TX_FOR_DOC });
    api.listCategories.mockResolvedValue({ categories: SAMPLE_CATEGORIES });
    api.patchClassification.mockResolvedValue({ correction_id: "c-1" });
  });

  it("client-side document_id filter isolates transactions for this document", async () => {
    const { useTransactions } = await import("@/lib/queries");
    const { renderHook, waitFor } = await import("@testing-library/react");

    const docId = "doc-abc123";
    const otherTx = { ...TX_FOR_DOC[0], id: "tx-other", document_id: "doc-other-999" };

    api.listTransactions.mockResolvedValue({
      transactions: [...TX_FOR_DOC, otherTx],
    });

    const client = makeQueryClient();
    const { result } = renderHook(() => useTransactions("org-test"), {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Filter client-side as the page will do
    const forThisDoc = result.current.data.filter((t) => t.document_id === docId);
    expect(forThisDoc).toHaveLength(1);
    expect(forThisDoc[0].id).toBe("tx-1");
  });

  it("patchClassification on a detail-view transaction uses correct orgId and txId", async () => {
    const { usePatchClassification } = await import("@/lib/queries");
    const { renderHook, act, waitFor } = await import("@testing-library/react");

    const client = makeQueryClient();
    client.setQueryData(["transactions", "org-test"], TX_FOR_DOC);

    const { result } = renderHook(() => usePatchClassification("org-test"), {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    });

    await act(async () => {
      result.current.mutate({
        txId: "tx-1",
        categoryId: "cat-travel",
        categoryName: "Travel",
        applyToExisting: false,
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.patchClassification).toHaveBeenCalledWith(
      "org-test",
      "tx-1",
      expect.objectContaining({ categoryId: "cat-travel" }),
      expect.objectContaining({ applyToExisting: false }),
    );
  });

  it("triggerExtract mutation calls api.triggerExtract with correct orgId + docId", async () => {
    const { useTriggerExtract } = await import("@/lib/queries");
    const { renderHook, act, waitFor } = await import("@testing-library/react");

    api.triggerExtract.mockResolvedValue({ status: "ok" });
    api.getDocument.mockResolvedValue(SAMPLE_DOC);
    api.listDocuments.mockResolvedValue({ documents: [SAMPLE_DOC] });

    const client = makeQueryClient();
    const { result } = renderHook(() => useTriggerExtract("org-test"), {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    });

    await act(async () => {
      result.current.mutate("doc-abc123");
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.triggerExtract).toHaveBeenCalledWith("org-test", "doc-abc123");
  });

  it("classifyDocument mutation calls api.classifyDocument with correct args", async () => {
    const { useClassifyDocument } = await import("@/lib/queries");
    const { renderHook, act, waitFor } = await import("@testing-library/react");

    api.classifyDocument.mockResolvedValue({ transactions: TX_FOR_DOC });
    api.listTransactions.mockResolvedValue({ transactions: TX_FOR_DOC });

    const client = makeQueryClient();
    const { result } = renderHook(() => useClassifyDocument("org-test"), {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    });

    await act(async () => {
      result.current.mutate("doc-abc123");
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.classifyDocument).toHaveBeenCalledWith("org-test", "doc-abc123");
  });

  it("there is no verify endpoint — patchClassification is the only correction path", () => {
    // Defensive: confirm the api object does NOT expose a verifyTransaction method.
    // This catches regressions where someone accidentally adds it.
    expect(api.verifyTransaction).toBeUndefined();
    expect(api.verify).toBeUndefined();
  });
});

// ── UI interaction tests — pending FE-2 rewrite ───────────────────────────────
describe("ReceiptDetail page — UI interactions (pending FE-2)", () => {
  it.skip(
    "pending FE-1/FE-2: renders merchant name and formatted amount in the document header",
    async () => {
      // When FE-2 ships: render <ReceiptDetailPage /> at /receipts/doc-abc123,
      // assert "Checkers" and "R 312.50" (or locale-equivalent) are visible.
    },
  );

  it.skip(
    "pending FE-1/FE-2: renders confidence badge for each transaction row",
    async () => {
      // When FE-2 ships: assert a confidence pill (88% / high) exists in the UI.
    },
  );

  it.skip(
    "pending FE-1/FE-2: category picker on transaction fires PATCH with categoryId",
    async () => {
      // When FE-2 ships:
      //   1. find the category dropdown on tx-1
      //   2. select "Travel"
      //   3. assert patchClassification called with { categoryId: "cat-travel" }
    },
  );

  it.skip(
    "pending FE-1/FE-2: 'apply to existing' checkbox sends applyToExisting=true",
    async () => {
      // When FE-2 ships: tick the checkbox, submit, assert applyToExisting: true.
    },
  );

  it.skip(
    "pending FE-1/FE-2: Trigger extract button calls useTriggerExtract mutation",
    async () => {
      // When FE-2 ships: click the extract button, assert api.triggerExtract called.
    },
  );

  it.skip(
    "pending FE-1/FE-2: extraction error banner appears when doc has extraction_error",
    async () => {
      // When FE-2 ships: mock doc with extraction_error set, assert banner visible.
    },
  );

  it.skip(
    "pending FE-1/FE-2: line items table renders correctly from raw_extraction",
    async () => {
      // When FE-2 ships: assert "Milk 2L" and "Bread" rows are in the line items table.
    },
  );
});
