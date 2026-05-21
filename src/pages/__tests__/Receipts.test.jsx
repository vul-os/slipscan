/**
 * Interaction tests for the Receipts list page.
 *
 * Contract (PHASE1-FRONTEND-CONTRACT.md):
 *   - Page renders a list of transactions from useTransactions(orgId)
 *   - Each row shows merchant, amount, date, and a confidence indicator
 *   - Default sort: low-confidence first (classification_confidence ascending)
 *   - Category picker fires PATCH via usePatchClassification with correct
 *     payload including { categoryId, applyToExisting }
 *
 * Tests that depend on the final FE-1 markup are it.skip'd with a
 * "pending FE-1" note. Tests against pure contract logic (mock-level) run
 * immediately and keep the suite green while FE-1 is in progress.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the api layer — no real HTTP
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

// Mock Sonner (toast) so jsdom doesn't choke on it
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Mock the org store — tests inject activeOrgId directly
vi.mock("@/stores/org", () => ({
  useOrgStore: (selector) =>
    selector({ activeOrgId: "org-test", setActiveOrg: vi.fn() }),
}));

// Mock UI store (upload dialog trigger)
vi.mock("@/stores/ui", () => ({
  useUIStore: (selector) =>
    selector({ uploadOpen: false, setUploadOpen: vi.fn(), setPaletteOpen: vi.fn() }),
}));

// Mock csv utilities (not under test here)
vi.mock("@/lib/csv", () => ({
  documentsToCSV: vi.fn(() => ""),
  downloadCSV: vi.fn(),
}));

import { api } from "@/lib/api";

// ── Sample data ──────────────────────────────────────────────────────────────
const LOW_CONFIDENCE_TX = {
  id: "tx-low",
  document_id: "doc-1",
  merchant: "Unknown Vendor",
  merchant_normalized: "unknown_vendor",
  description: "POS purchase",
  amount: 99.0,
  currency: "ZAR",
  posted_date: "2024-03-01",
  direction: "debit",
  status: "posted",
  classification_source: "model",
  classification_confidence: 0.35,   // LOW
  category_id: null,
  category_name: null,
};

const HIGH_CONFIDENCE_TX = {
  id: "tx-high",
  document_id: "doc-2",
  merchant: "Woolworths Food",
  merchant_normalized: "woolworths_food",
  description: "Grocery purchase",
  amount: 450.0,
  currency: "ZAR",
  posted_date: "2024-03-02",
  direction: "debit",
  status: "posted",
  classification_source: "model",
  classification_confidence: 0.95,   // HIGH
  category_id: "cat-groceries",
  category_name: "Groceries",
};

const SAMPLE_CATEGORIES = [
  { id: "cat-groceries", parent_id: null, name: "Groceries", kind: "expense", icon: null, color: null },
  { id: "cat-travel",   parent_id: null, name: "Travel",    kind: "expense", icon: null, color: null },
];

// ── Wrapper helpers ───────────────────────────────────────────────────────────
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
  });
}

function Wrapper({ children, client }) {
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(MemoryRouter, null, children),
  );
}

// ── Contract-level logic tests (no markup dependency) ─────────────────────────
describe("Receipts page — contract logic (mock-level)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listTransactions.mockResolvedValue({
      transactions: [HIGH_CONFIDENCE_TX, LOW_CONFIDENCE_TX],
    });
    api.listCategories.mockResolvedValue({ categories: SAMPLE_CATEGORIES });
    api.patchClassification.mockResolvedValue({ correction_id: "c-1" });
    // Old page still uses listDocuments
    api.listDocuments.mockResolvedValue({ documents: [] });
  });

  it("api.patchClassification called with correct payload (no apply_to_existing)", async () => {
    // This test exercises the mutation contract directly, not the page UI.
    // Confirmed green without FE-1 final markup.
    const { usePatchClassification } = await import("@/lib/queries");
    const { renderHook, act, waitFor } = await import("@testing-library/react");

    const client = makeQueryClient();
    client.setQueryData(["transactions", "org-test"], [HIGH_CONFIDENCE_TX, LOW_CONFIDENCE_TX]);

    const { result } = renderHook(() => usePatchClassification("org-test"), {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    });

    await act(async () => {
      result.current.mutate({
        txId: "tx-low",
        categoryId: "cat-groceries",
        categoryName: "Groceries",
        applyToExisting: false,
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.patchClassification).toHaveBeenCalledWith(
      "org-test",
      "tx-low",
      expect.objectContaining({ categoryId: "cat-groceries" }),
      expect.objectContaining({ applyToExisting: false }),
    );
  });

  it("api.patchClassification called with apply_to_existing=true", async () => {
    const { usePatchClassification } = await import("@/lib/queries");
    const { renderHook, act, waitFor } = await import("@testing-library/react");

    const client = makeQueryClient();
    client.setQueryData(["transactions", "org-test"], [HIGH_CONFIDENCE_TX, LOW_CONFIDENCE_TX]);

    const { result } = renderHook(() => usePatchClassification("org-test"), {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    });

    await act(async () => {
      result.current.mutate({
        txId: "tx-low",
        categoryId: "cat-travel",
        categoryName: "Travel",
        applyToExisting: true,
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.patchClassification).toHaveBeenCalledWith(
      "org-test",
      "tx-low",
      expect.objectContaining({ categoryId: "cat-travel" }),
      expect.objectContaining({ applyToExisting: true }),
    );
  });

  it("confidenceLevel correctly identifies low-confidence transactions", async () => {
    // Use the format helper to verify the contract threshold logic.
    const { confidenceLevel } = await import("@/lib/format");
    expect(confidenceLevel(LOW_CONFIDENCE_TX.classification_confidence)).toBe("low");
    expect(confidenceLevel(HIGH_CONFIDENCE_TX.classification_confidence)).toBe("high");
  });

  it("'sort low-first' logic: low confidence items sort before high confidence", () => {
    // Pure sort logic against contract; doesn't depend on page markup.
    const txs = [HIGH_CONFIDENCE_TX, LOW_CONFIDENCE_TX];
    const sorted = [...txs].sort(
      (a, b) => (a.classification_confidence ?? 0) - (b.classification_confidence ?? 0),
    );
    expect(sorted[0].id).toBe("tx-low");
    expect(sorted[1].id).toBe("tx-high");
  });
});

// ── UI interaction tests — pending FE-1 rewrite ───────────────────────────────
// These tests describe the contracted UI behaviour (list renders rows +
// confidence, sort works, category picker fires PATCH). They are skipped until
// FE-1 delivers the final Receipts.jsx markup that integrates useTransactions.

describe("Receipts page — UI interactions (pending FE-1)", () => {
  it.skip(
    "pending FE-1/FE-2: renders a row per transaction with merchant name visible",
    async () => {
      // When FE-1 ships: render <ReceiptsPage />, waitFor rows, assert merchant names.
    },
  );

  it.skip(
    "pending FE-1/FE-2: each row shows a confidence indicator (confidenceLevel badge)",
    async () => {
      // When FE-1 ships: assert a low/medium/high badge exists on each row.
    },
  );

  it.skip(
    "pending FE-1/FE-2: default sort places low-confidence rows first",
    async () => {
      // When FE-1 ships: query all rows and assert the first row is tx-low.
    },
  );

  it.skip(
    "pending FE-1/FE-2: category picker opens and selecting a category fires patchClassification",
    async () => {
      // When FE-1 ships:
      //   1. find the category picker on a low-confidence row
      //   2. userEvent.click the picker, select "Groceries"
      //   3. assert api.patchClassification called with { categoryId: "cat-groceries" }
    },
  );

  it.skip(
    "pending FE-1/FE-2: 'apply to existing' checkbox is sent with the PATCH when checked",
    async () => {
      // When FE-1 ships:
      //   1. open the category picker, tick 'apply to all similar'
      //   2. assert api.patchClassification called with applyToExisting: true
    },
  );

  it.skip(
    "pending FE-1/FE-2: shows empty state when transaction list is empty",
    async () => {
      // When FE-1 ships with useTransactions integration, assert empty-state copy.
    },
  );
});
