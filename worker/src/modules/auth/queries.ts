/**
 * Auth SQL queries — ported 1:1 from Go internal/auth/{store.go,tokens.go}.
 * All SQL is raw parameterised (no ORM). Connection is the Neon table owner
 * (RLS bypassed), so app-layer filtering provides the real isolation.
 */
import { queryRows, queryOne } from "../../db/client";
import type { Env } from "../../bindings";
import { hashToken, newRandomToken } from "../../lib/crypto";
import type { UserRow } from "./types";

// ---- TTL helpers ----

/**
 * Parse a Go-style duration string ("15m", "168h", "1h30m") to seconds.
 * Supports h, m, s units. Falls back to `defaultSec` on any parse failure.
 */
export function parseDurationSec(raw: string | undefined, defaultSec: number): number {
  if (!raw) return defaultSec;
  const s = raw.trim();
  // Simple single-unit: e.g. "15m", "168h", "900s"
  const single = /^(\d+(?:\.\d+)?)(h|m|s)$/.exec(s);
  if (single) {
    const n = parseFloat(single[1]);
    switch (single[2]) {
      case "h": return Math.round(n * 3600);
      case "m": return Math.round(n * 60);
      case "s": return Math.round(n);
    }
  }
  // Compound: e.g. "1h30m", "2h15m30s"
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    switch (m[2]) {
      case "h": total += n * 3600; break;
      case "m": total += n * 60; break;
      case "s": total += n; break;
    }
  }
  if (matched) return Math.round(total);
  // Parse as bare seconds integer
  const n = parseInt(s, 10);
  if (!isNaN(n)) return n;
  return defaultSec;
}

// ---- Email normalisation ----

/** Mirrors Go normalizeEmail: trim, parse, lowercase. */
export function normalizeEmail(raw: string): string | null {
  const addr = raw.trim();
  if (!addr) return null;
  // Basic RFC 5321 structure: local@domain
  const at = addr.lastIndexOf("@");
  if (at < 1 || at >= addr.length - 1) return null;
  // Reject obvious illegal chars but allow wide Unicode in display names
  // by accepting anything with an @ and at least one dot after it.
  const domain = addr.slice(at + 1);
  if (!domain.includes(".")) return null;
  return addr.toLowerCase();
}

// ---- User store (mirrors Go internal/auth/store.go) ----

export async function createUser(
  env: Env,
  email: string,
  passwordHash: string,
  fullName: string,
): Promise<UserRow> {
  const rows = await queryRows(
    env,
    `INSERT INTO users (email, password_hash, full_name)
     VALUES ($1, $2, NULLIF($3, ''))
     RETURNING id, email, password_hash, full_name, avatar_url,
               email_verified_at, last_login_at, created_at, updated_at`,
    [email, passwordHash, fullName],
  );
  if (!rows.length) throw new Error("insert returned no rows");
  return rows[0] as unknown as UserRow;
}

export async function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  const row = await queryOne(
    env,
    `SELECT id, email, password_hash, full_name, avatar_url,
            email_verified_at, last_login_at, created_at, updated_at
     FROM users
     WHERE email = $1`,
    [email],
  );
  return row ? (row as unknown as UserRow) : null;
}

export async function getUserById(env: Env, id: string): Promise<UserRow | null> {
  const row = await queryOne(
    env,
    `SELECT id, email, password_hash, full_name, avatar_url,
            email_verified_at, last_login_at, created_at, updated_at
     FROM users
     WHERE id = $1`,
    [id],
  );
  return row ? (row as unknown as UserRow) : null;
}

export async function touchLogin(env: Env, id: string): Promise<void> {
  await queryRows(env, `UPDATE users SET last_login_at = NOW() WHERE id = $1`, [id]);
}

export async function markVerified(env: Env, id: string): Promise<void> {
  await queryRows(
    env,
    `UPDATE users SET email_verified_at = NOW() WHERE id = $1 AND email_verified_at IS NULL`,
    [id],
  );
}

export async function updatePasswordHash(env: Env, id: string, hash: string): Promise<void> {
  await queryRows(env, `UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, id]);
}

export async function updateUser(
  env: Env,
  id: string,
  fields: { full_name?: string; avatar_url?: string | null },
): Promise<UserRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if ("full_name" in fields) {
    sets.push(`full_name = NULLIF($${idx++}, '')`);
    params.push(fields.full_name ?? "");
  }
  if ("avatar_url" in fields) {
    sets.push(`avatar_url = NULLIF($${idx++}, '')`);
    params.push(fields.avatar_url ?? "");
  }
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  params.push(id);
  const rows = await queryRows(
    env,
    `UPDATE users SET ${sets.join(", ")}
     WHERE id = $${idx}
     RETURNING id, email, password_hash, full_name, avatar_url,
               email_verified_at, last_login_at, created_at, updated_at`,
    params,
  );
  return rows.length ? (rows[0] as unknown as UserRow) : null;
}

// ---- Token store (mirrors Go internal/auth/tokens.go) ----

type TokenKind = "email_verify" | "password_reset";

function tokenTable(kind: TokenKind): string {
  return kind === "email_verify" ? "email_verification_tokens" : "password_reset_tokens";
}

/**
 * Issue a token: generates random plaintext, stores its SHA-256 hash.
 * Returns the plaintext (caller embeds it in a URL / response).
 */
export async function issueToken(
  env: Env,
  kind: TokenKind,
  userId: string,
  ttlSec: number,
): Promise<string> {
  const plaintext = newRandomToken();
  const hash = hashToken(plaintext);
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  await queryRows(
    env,
    `INSERT INTO ${tokenTable(kind)} (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt],
  );
  return plaintext;
}

/**
 * Consume a token atomically: sets consumed_at, returns user_id.
 * Returns null when the token is missing, already consumed, or expired.
 */
export async function consumeToken(
  env: Env,
  kind: TokenKind,
  plaintext: string,
): Promise<string | null> {
  if (!plaintext) return null;
  const hash = hashToken(plaintext);
  const rows = await queryRows(
    env,
    `UPDATE ${tokenTable(kind)}
     SET consumed_at = NOW()
     WHERE token_hash = $1
       AND consumed_at IS NULL
       AND expires_at > NOW()
     RETURNING user_id`,
    [hash],
  );
  if (!rows.length) return null;
  return rows[0].user_id as string;
}

/**
 * Invalidate all unconsumed tokens of this kind for a user.
 * Called before issuing a new verify/reset token so old links stop working.
 */
export async function invalidateUserTokens(
  env: Env,
  kind: TokenKind,
  userId: string,
): Promise<void> {
  await queryRows(
    env,
    `UPDATE ${tokenTable(kind)} SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );
}

// ---- Unique-violation detection ----

/** True when the DB error is a Postgres unique_violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err instanceof Error ? err.message : err);
  return msg.includes("23505") || msg.includes("unique constraint") || msg.includes("unique_violation");
}
