/**
 * Audit module unit tests — pure helpers only (no DB / network).
 *
 * Tests:
 *   - listAuditLog SQL builder: correct WHERE clause param numbering
 *   - writeAuditLog param ordering (shape check)
 *   - ListFilter defaults (limit clamping, offset floor)
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { listAuditLog } from "../src/modules/audit/queries";
import type { ListFilter } from "../src/modules/audit/types";

// ---------------------------------------------------------------------------
// Minimal Query spy: captures the last SQL + params
// ---------------------------------------------------------------------------
function makeQuerySpy() {
  let lastSql = "";
  let lastParams: unknown[] = [];
  const spy = vi.fn(async (sql: string, params: unknown[] = []) => {
    lastSql = sql;
    lastParams = params;
    return [];
  });
  return { spy, getSql: () => lastSql, getParams: () => lastParams };
}

// ---------------------------------------------------------------------------
// listAuditLog — SQL builder
// ---------------------------------------------------------------------------

describe("listAuditLog SQL builder", () => {
  test("base query uses organization_id = $1", async () => {
    const { spy, getSql, getParams } = makeQuerySpy();
    await listAuditLog(spy, "org-1", {});
    expect(getSql()).toContain("WHERE organization_id = $1");
    expect(getParams()[0]).toBe("org-1");
  });

  test("actor_user_id filter adds AND clause", async () => {
    const { spy, getSql, getParams } = makeQuerySpy();
    await listAuditLog(spy, "org-1", { actor_user_id: "user-abc" });
    expect(getSql()).toContain("actor_user_id = $2");
    expect(getParams()[1]).toBe("user-abc");
  });

  test("entity_type filter appended in order", async () => {
    const { spy, getSql, getParams } = makeQuerySpy();
    await listAuditLog(spy, "org-1", { entity_type: "transaction" });
    expect(getSql()).toContain("entity_type = $2");
    expect(getParams()[1]).toBe("transaction");
  });

  test("action filter appended after entity_type", async () => {
    const { spy, getSql, getParams } = makeQuerySpy();
    await listAuditLog(spy, "org-1", {
      entity_type: "transaction",
      action: "classification.corrected",
    });
    expect(getSql()).toContain("entity_type = $2");
    expect(getSql()).toContain("action = $3");
    expect(getParams()[2]).toBe("classification.corrected");
  });

  test("since / until use > / <=", async () => {
    const { spy, getSql } = makeQuerySpy();
    await listAuditLog(spy, "org-1", {
      since: "2024-01-01T00:00:00Z",
      until: "2024-12-31T23:59:59Z",
    });
    expect(getSql()).toContain("created_at > $");
    expect(getSql()).toContain("created_at <= $");
  });

  test("default limit is 100, offset is 0", async () => {
    const { spy, getParams } = makeQuerySpy();
    await listAuditLog(spy, "org-1", {});
    // Last two params before the dynamic ones are limit+offset.
    const params = getParams();
    const limit = params[params.length - 2];
    const offset = params[params.length - 1];
    expect(limit).toBe(100);
    expect(offset).toBe(0);
  });

  test("limit clamped to 1000", async () => {
    const { spy, getParams } = makeQuerySpy();
    await listAuditLog(spy, "org-1", { limit: 9999 });
    const params = getParams();
    expect(params[params.length - 2]).toBe(1000);
  });

  test("limit negative defaults to 100", async () => {
    const { spy, getParams } = makeQuerySpy();
    await listAuditLog(spy, "org-1", { limit: -5 });
    const params = getParams();
    expect(params[params.length - 2]).toBe(100);
  });

  test("offset negative defaults to 0", async () => {
    const { spy, getParams } = makeQuerySpy();
    await listAuditLog(spy, "org-1", { offset: -10 });
    const params = getParams();
    expect(params[params.length - 1]).toBe(0);
  });

  test("all filters combine with correct param indices", async () => {
    const { spy, getSql, getParams } = makeQuerySpy();
    const f: ListFilter = {
      actor_user_id: "u1",
      entity_type: "transaction",
      entity_id: "e1",
      action: "test.action",
      since: "2024-01-01T00:00:00Z",
      until: "2024-12-31T23:59:59Z",
      limit: 50,
      offset: 10,
    };
    await listAuditLog(spy, "org-1", f);
    const sql = getSql();
    const params = getParams();
    // Indices: $1=orgId, $2=actor_user_id, $3=entity_type, $4=entity_id,
    //           $5=action, $6=since, $7=until, $8=limit, $9=offset
    expect(params[0]).toBe("org-1");
    expect(params[1]).toBe("u1");
    expect(params[2]).toBe("transaction");
    expect(params[3]).toBe("e1");
    expect(params[4]).toBe("test.action");
    expect(params[5]).toBe("2024-01-01T00:00:00Z");
    expect(params[6]).toBe("2024-12-31T23:59:59Z");
    expect(params[7]).toBe(50);
    expect(params[8]).toBe(10);
    expect(sql).toContain("ORDER BY created_at DESC");
  });

  test("result rows are mapped to LogEntry shape", async () => {
    const rowData = {
      id: "row-id",
      organization_id: "org-1",
      actor_user_id: null,
      actor_token_id: null,
      entity_type: "transaction",
      entity_id: null,
      action: "test.action",
      before: null,
      after: null,
      ip_address: "1.2.3.4",
      user_agent: "vitest",
      created_at: "2024-06-01T12:00:00.000Z",
    };
    const q = async (_sql: string, _params?: unknown[]) => [rowData];
    const entries = await listAuditLog(q, "org-1", {});
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("row-id");
    expect(entries[0].entity_type).toBe("transaction");
    expect(entries[0].action).toBe("test.action");
    expect(entries[0].ip_address).toBe("1.2.3.4");
    expect(entries[0].actor_user_id).toBeUndefined();
  });
});
