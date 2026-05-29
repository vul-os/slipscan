/**
 * Neon data layer for the Worker.
 *
 * - `queryRows`: one-shot parameterized query over Neon HTTP (no transaction).
 *   Use for auth and other non-org-scoped access.
 * - `withOrg`: opens a transaction, sets RLS GUCs (app.organization_id /
 *   app.user_id via set_config(..., local=true)), and runs `fn` with a
 *   `q(text, params) -> rows` runner. Belt-and-suspenders isolation: handlers
 *   STILL include `WHERE organization_id = $` (ported from Go), and the
 *   schema's RLS policies enforce it again at the DB.
 *
 * Raw parameterized SQL only — ported 1:1 from the Go store.go files. No ORM.
 */
import { neon, Pool } from "@neondatabase/serverless";
import type { Env } from "../bindings";

export type Row = Record<string, unknown>;
export type Query = (text: string, params?: unknown[]) => Promise<Row[]>;

// neon() HTTP supports a direct parameterized call: sql(queryString, params)
// (per NeonQueryFunction overload). With the default options the promise
// resolves to the rows array.
export async function queryRows(env: Env, text: string, params: unknown[] = []): Promise<Row[]> {
  const sql = neon(env.DATABASE_URL);
  return (await sql(text, params as never[])) as unknown as Row[];
}

export async function queryOne(env: Env, text: string, params: unknown[] = []): Promise<Row | null> {
  const rows = await queryRows(env, text, params);
  return rows.length ? rows[0] : null;
}

export async function withOrg<T>(
  env: Env,
  orgId: string,
  userId: string | null,
  fn: (q: Query) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id', $1, true)", [orgId]);
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const q: Query = async (text, params = []) => (await client.query(text, params)).rows as Row[];
    const out = await fn(q);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback error */
    }
    throw e;
  } finally {
    client.release();
    void pool.end().catch(() => {});
  }
}
