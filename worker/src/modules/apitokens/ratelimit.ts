/**
 * KV-backed per-token rate limiter for Cloudflare Workers.
 *
 * Design (mirrors Go RateLimiter but distributed via KV):
 *   Key:   "rl:{tokenId}:{windowKey}"  where windowKey = floor(Date.now() / 60000)
 *   Value: request count (integer string)
 *   TTL:   90s (covers the current 60s window + 30s grace)
 *
 * On each request:
 *   1. Compute windowKey = Math.floor(Date.now() / 60_000)
 *   2. KV key = `rl:${tokenId}:${windowKey}`
 *   3. GET the current count; if absent, treat as 0
 *   4. If count >= limit → deny (429)
 *   5. PUT count+1 with 90s TTL (non-atomic — best-effort; Workers has no
 *      atomic KV increment. In the worst case a burst window can slightly
 *      exceed the limit, which is acceptable for this use case.)
 *
 * When RATE_LIMIT KVNamespace is absent (env.RATE_LIMIT == null), rate
 * limiting is bypassed (allow-all). This matches the Go behavior of falling
 * back to an in-process limiter, adjusted for the serverless context where
 * KV is optional.
 *
 * Default limit: 60 req/min (mirrors Go DefaultRateLimitPerMin = 60).
 */
import type { Env } from "../../bindings";

export const DEFAULT_RATE_LIMIT_PER_MIN = 60;

/**
 * Check the KV rate limit for a token. Returns true if the request is
 * allowed, false if it should be rejected (429).
 *
 * @param env         - Worker bindings (uses env.RATE_LIMIT KVNamespace)
 * @param tokenId     - Unique token ID (UUID)
 * @param limitPerMin - Per-minute limit; 0 → DEFAULT_RATE_LIMIT_PER_MIN
 */
export async function checkRateLimit(
  env: Env,
  tokenId: string,
  limitPerMin: number,
): Promise<boolean> {
  // If the KV namespace is not bound, bypass rate limiting (allow).
  if (!env.RATE_LIMIT) return true;

  const limit = limitPerMin > 0 ? limitPerMin : DEFAULT_RATE_LIMIT_PER_MIN;

  // 60-second fixed window keyed by minute epoch.
  const windowKey = Math.floor(Date.now() / 60_000);
  const kvKey = `rl:${tokenId}:${windowKey}`;

  const existing = await env.RATE_LIMIT.get(kvKey);
  const count = existing !== null ? parseInt(existing, 10) : 0;

  if (count >= limit) return false;

  // Best-effort increment with 90s TTL (covers the window + 30s grace).
  // Non-atomic: slight over-burst is acceptable (see design note above).
  await env.RATE_LIMIT.put(kvKey, String(count + 1), { expirationTtl: 90 });
  return true;
}
