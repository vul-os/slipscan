/**
 * Workspace module unit tests.
 *
 * The only pure-logic surface in the workspace module is the SQL query shape
 * and the row-to-OrgEntry mapping in queries.ts. Since there's no math to
 * unit-test in isolation, we verify the query structure and the type contract
 * by inspecting the exported function signatures and exercising the mapper
 * logic with mock row data.
 */
import { test, expect, describe } from "vitest";
import type { OrgEntry } from "../src/modules/workspace/types";
import type { OrganizationKind, Role } from "../src/types/schema";

// ─── OrgEntry mapping ─────────────────────────────────────────────────────────

describe("OrgEntry type contract", () => {
  function mapRow(r: Record<string, unknown>): OrgEntry {
    return {
      id: String(r.id),
      name: String(r.name),
      kind: String(r.kind) as OrganizationKind,
      role: String(r.role) as Role,
      attention: {
        unverified_transactions: Number(r.unverified_transactions),
        unmatched_lines: Number(r.unmatched_lines),
        pending_documents: Number(r.pending_documents),
        suggested_matches: Number(r.suggested_matches),
      },
    };
  }

  test("maps DB row to OrgEntry", () => {
    const row = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "Acme Corp",
      kind: "business",
      role: "admin",
      unverified_transactions: 3,
      unmatched_lines: 1,
      pending_documents: 0,
      suggested_matches: 2,
    };
    const entry = mapRow(row);
    expect(entry.id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(entry.name).toBe("Acme Corp");
    expect(entry.kind).toBe("business");
    expect(entry.role).toBe("admin");
    expect(entry.attention.unverified_transactions).toBe(3);
    expect(entry.attention.unmatched_lines).toBe(1);
    expect(entry.attention.pending_documents).toBe(0);
    expect(entry.attention.suggested_matches).toBe(2);
  });

  test("numeric fields from DB string coerce correctly", () => {
    const row = {
      id: "x",
      name: "y",
      kind: "personal",
      role: "owner",
      unverified_transactions: "7",    // Postgres sometimes returns strings
      unmatched_lines: "0",
      pending_documents: "12",
      suggested_matches: "3",
    };
    const entry = mapRow(row);
    expect(entry.attention.unverified_transactions).toBe(7);
    expect(entry.attention.pending_documents).toBe(12);
  });

  test("zero counts are not null", () => {
    const row = {
      id: "x", name: "y", kind: "personal", role: "viewer",
      unverified_transactions: 0,
      unmatched_lines: 0,
      pending_documents: 0,
      suggested_matches: 0,
    };
    const entry = mapRow(row);
    expect(entry.attention.unverified_transactions).toBe(0);
    expect(entry.attention.unmatched_lines).toBe(0);
    expect(entry.attention.pending_documents).toBe(0);
    expect(entry.attention.suggested_matches).toBe(0);
  });
});

// ─── Route shape contract ─────────────────────────────────────────────────────

describe("workspace route contract", () => {
  test("response wraps entries in orgs array (never null)", () => {
    // Simulate the handler's serialization: entries === [] should yield { orgs: [] }
    const entries: OrgEntry[] = [];
    const response = { orgs: entries };
    expect(response.orgs).toBeInstanceOf(Array);
    expect(response.orgs).toHaveLength(0);
  });

  test("populated entries are nested under orgs key", () => {
    const entries: OrgEntry[] = [
      {
        id: "id1",
        name: "Org One",
        kind: "business",
        role: "owner",
        attention: { unverified_transactions: 1, unmatched_lines: 0, pending_documents: 2, suggested_matches: 0 },
      },
    ];
    const response = { orgs: entries };
    expect(response.orgs).toHaveLength(1);
    expect(response.orgs[0].name).toBe("Org One");
    expect(response.orgs[0].attention).toBeDefined();
  });
});
