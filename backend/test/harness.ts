/**
 * Differential test harness. Fires the same request at the Go backend and the
 * TS worker and lets tests compare responses. Run both first:
 *   Go:  cd backend && PORT=8080 go run ./cmd/server         (dev Neon + R2)
 *   TS:  cd worker  && npx wrangler dev --port 8788          (same dev Neon)
 * Override bases by editing GO_BASE / TS_BASE below.
 */
export const GO_BASE = "http://localhost:8080";
export const TS_BASE = "http://localhost:8788";

export interface Snap {
  status: number;
  body: unknown;
}

async function snap(r: Response): Promise<Snap> {
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: r.status, body };
}

/** Fire `path` at both backends; returns both snapshots. */
export async function both(path: string, init?: RequestInit): Promise<{ go: Snap; ts: Snap }> {
  const [go, ts] = await Promise.all([
    fetch(GO_BASE + path, init).then(snap),
    fetch(TS_BASE + path, init).then(snap),
  ]);
  return { go, ts };
}

/** Recursively strip volatile fields so two responses can be compared. */
const VOLATILE = /(^id$|_id$|_at$|^token$|^jti$|expires_at$|access_token|refresh_token)/i;
export function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (VOLATILE.test(k)) continue;
      out[k] = stripVolatile(val);
    }
    return out;
  }
  return v;
}
