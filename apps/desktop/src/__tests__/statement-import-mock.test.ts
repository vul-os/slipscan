/**
 * Statement import (ROADMAP.md Phase 3/4.95): the mock's refusals for
 * `statement_import` are read by hand from `commands.rs`'s
 * `statement_import_impl` — an unknown preset id, and an account that
 * belongs to a different book — since `check-mock-guards.ts` only compares
 * a mock operation against a same-named `CoreService` method in
 * `service.rs`, and this pipeline's core function
 * (`slipscan_ingest::bank::import_statement_lines`) lives in a different
 * crate the script never reads. That is exactly the blind spot the guard
 * class it exists to catch was found in before, so this is covered by hand
 * instead of trusted to the automated gate.
 */
import { describe, expect, it } from "vitest";
import { mockApi } from "../lib/api/mock";

async function firstBookAndAccount() {
  const [book] = await mockApi.book_list();
  const [account] = await mockApi.account_list({ book_id: book.id });
  return { book, account };
}

describe("statement_preset_list mock", () => {
  it("returns the same catalog shape core does: SA banks, then generic, grouped by region", async () => {
    const groups = await mockApi.statement_preset_list();
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const za = groups.find((g) => g.region === "za");
    expect(za?.region_name).toBe("South Africa");
    expect(za?.presets.map((p) => p.id)).toEqual(
      expect.arrayContaining(["za-fnb", "za-standard", "za-capitec", "za-nedbank", "za-absa"]),
    );
    const generic = groups.find((g) => g.region === "generic");
    expect(generic?.presets.some((p) => p.id === "generic-iso")).toBe(true);
  });
});

describe("statement_import mock", () => {
  it("imports through a preset, attaches a statement document, and applies the Payments-adjacent transaction shape", async () => {
    const { book, account } = await firstBookAndAccount();

    const result = await mockApi.statement_import({
      book_id: book.id,
      account_id: account.id,
      preset_id: "generic-iso",
      file_name: "test-statement.csv",
      mime_type: "text/csv",
      bytes_base64: btoa("Date,Description,Amount\n2026-07-01,SHOP,-10.00\n"),
    });

    expect(result.document.kind).toBe("statement");
    expect(result.document.file_name).toBe("test-statement.csv");
    expect(result.document_duplicate).toBe(false);
    expect(result.preset_id).toBe("generic-iso");
    expect(result.account_id).toBe(account.id);
    expect(result.imported).toHaveLength(3);
    expect(result.duplicates).toBe(0);
    expect(result.content_duplicates).toBe(0);
    for (const txn of result.imported) {
      expect(txn.account_id).toBe(account.id);
      expect(txn.source).toBe("import");
    }

    // The document actually landed where document_list reads from — this
    // is not a value handed back without being stored.
    const docs = await mockApi.document_list({ book_id: book.id });
    expect(docs.some((d) => d.id === result.document.id)).toBe(true);
  });

  it("re-importing the same file/preset/account dedupes instead of doubling the books", async () => {
    const { book, account } = await firstBookAndAccount();
    const req = {
      book_id: book.id,
      account_id: account.id,
      preset_id: "generic-mdy",
      file_name: "repeat.csv",
      mime_type: "text/csv",
      bytes_base64: btoa("Date,Description,Amount\n06/15/2026,SHOP,-5.00\n"),
    };

    const first = await mockApi.statement_import(req);
    expect(first.imported).toHaveLength(3);
    expect(first.duplicates).toBe(0);

    const second = await mockApi.statement_import(req);
    expect(second.imported).toHaveLength(0);
    expect(second.duplicates).toBe(3);
    expect(second.content_duplicates).toBe(3);
  });

  it("refuses an unknown preset id", async () => {
    const { book, account } = await firstBookAndAccount();
    await expect(
      mockApi.statement_import({
        book_id: book.id,
        account_id: account.id,
        preset_id: "zz-nowhere",
        file_name: "x.csv",
        mime_type: "text/csv",
        bytes_base64: btoa("x"),
      }),
    ).rejects.toThrow(/unknown statement preset/);
  });

  it("refuses an account that belongs to a different book — the guard core enforces inside transaction_create", async () => {
    const { account } = await firstBookAndAccount();
    await expect(
      mockApi.statement_import({
        book_id: "some-other-book-id",
        account_id: account.id,
        preset_id: "generic-iso",
        file_name: "x.csv",
        mime_type: "text/csv",
        bytes_base64: btoa("x"),
      }),
    ).rejects.toThrow(/no account/);
  });

  it("refuses an account id that does not exist at all", async () => {
    const { book } = await firstBookAndAccount();
    await expect(
      mockApi.statement_import({
        book_id: book.id,
        account_id: "not-a-real-account",
        preset_id: "generic-iso",
        file_name: "x.csv",
        mime_type: "text/csv",
        bytes_base64: btoa("x"),
      }),
    ).rejects.toThrow(/no account/);
  });
});
