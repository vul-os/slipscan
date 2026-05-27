/**
 * Auth routes — port of Go backend/internal/auth/handlers.go.
 *
 * Implements:
 *   POST /auth/register
 *   POST /auth/login
 *   POST /auth/refresh
 *   POST /auth/verify        (consume token from JSON body)
 *   GET  /auth/verify        (consume token from ?token= query param)
 *   POST /auth/verify/resend
 *   POST /auth/password-reset/request
 *   POST /auth/password-reset/confirm
 *   GET  /auth/me            (requireAuth)
 *
 * Email delivery is DEFERRED (NoopSender): tokens are created but no email
 * is sent; verify_email_sent is always false.
 *
 * Org creation is NOT performed here — deferred to POST /orgs.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../types/app";
import { writeError } from "../../lib/errors";
import { issueTokens, parseToken } from "../../lib/jwt";
import { hashPassword, verifyPassword } from "../../lib/password";
import { requireAuth } from "../../middleware/auth";
import {
  parseDurationSec,
  normalizeEmail,
  createUser,
  getUserByEmail,
  getUserById,
  touchLogin,
  markVerified,
  updatePasswordHash,
  issueToken,
  consumeToken,
  invalidateUserTokens,
  isUniqueViolation,
} from "./queries";
import type {
  UserRow,
  UserResponse,
  RegisterResponse,
  AuthResponse,
} from "./types";
import { enqueue } from "../email/mailer";
import { verifyEmail, passwordResetEmail } from "../email/templates";

// Default TTLs match Go constants (15 min access, 7 days refresh, 24h verify, 1h reset)
const DEFAULT_ACCESS_TTL = 900;    // 15 min
const DEFAULT_REFRESH_TTL = 604800; // 168h = 7 days
const VERIFY_TOKEN_TTL = 86400;    // 24h
const RESET_TOKEN_TTL = 3600;      // 1h

const r = new Hono<AppEnv>();

// ---- helpers ----

function userToResponse(u: UserRow): UserResponse {
  const resp: UserResponse = {
    id: u.id,
    email: u.email,
    created_at: u.created_at,
  };
  if (u.full_name) resp.full_name = u.full_name;
  if (u.email_verified_at) resp.email_verified_at = u.email_verified_at;
  return resp;
}

function getTTLs(env: AppEnv["Bindings"]) {
  return {
    accessTTL: parseDurationSec(env.JWT_ACCESS_TTL, DEFAULT_ACCESS_TTL),
    refreshTTL: parseDurationSec(env.JWT_REFRESH_TTL, DEFAULT_REFRESH_TTL),
  };
}

// ---- POST /auth/register ----

r.post("/register", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  const rawPassword = typeof body.password === "string" ? body.password : "";
  const rawFullName = typeof body.full_name === "string" ? body.full_name.trim() : "";

  const email = normalizeEmail(rawEmail);
  if (!email) return writeError(c, 400, "invalid_email", "invalid email address");

  let hash: string;
  try {
    hash = await hashPassword(rawPassword);
  } catch (e) {
    return writeError(c, 400, "invalid_password", e instanceof Error ? e.message : "invalid password");
  }

  let user: UserRow;
  try {
    user = await createUser(c.env, email, hash, rawFullName);
  } catch (e) {
    if (isUniqueViolation(e)) {
      return writeError(c, 409, "email_taken", "email already in use");
    }
    console.error("register: createUser:", e);
    return writeError(c, 500, "create_failed", "could not create user");
  }

  const { accessTTL, refreshTTL } = getTTLs(c.env);
  let tokens;
  try {
    tokens = await issueTokens(c.env.JWT_SECRET, user.id, user.email, accessTTL, refreshTTL);
  } catch (e) {
    console.error("register: issueTokens:", e);
    return writeError(c, 500, "token_failed", "could not issue tokens");
  }

  // Issue verify token + enqueue the verification email (Resend via outbox).
  let verifySent = false;
  try {
    const vtok = await issueToken(c.env, "email_verify", user.id, VERIFY_TOKEN_TTL);
    const base = c.env.FRONTEND_BASE_URL ?? "";
    const verifyURL = `${base}/verify?token=${encodeURIComponent(vtok)}`;
    const em = verifyEmail(user.full_name ?? "", verifyURL);
    await enqueue(c.env, {
      to: user.email, subject: em.subject, html: em.html, text: em.text,
      kind: "verify", userId: user.id,
    });
    verifySent = true;
  } catch (e) {
    console.error("register: verify email:", e);
    // Non-fatal — registration still succeeds (user can hit /resend later)
  }

  const resp: RegisterResponse = {
    user: userToResponse(user),
    organization: null,
    tokens,
    verify_email_sent: verifySent,
  };
  return c.json(resp, 201);
});

// ---- POST /auth/login ----

r.post("/login", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  const rawPassword = typeof body.password === "string" ? body.password : "";

  const email = normalizeEmail(rawEmail);
  if (!email) {
    return writeError(c, 401, "invalid_credentials", "invalid email or password");
  }

  const user = await getUserByEmail(c.env, email);
  if (!user) {
    // Constant-time-ish: hash a dummy value so timing reveals less about
    // whether the email exists.
    try {
      await verifyPassword(rawPassword, "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    } catch {
      // ignore
    }
    return writeError(c, 401, "invalid_credentials", "invalid email or password");
  }

  if (!(await verifyPassword(rawPassword, user.password_hash))) {
    return writeError(c, 401, "invalid_credentials", "invalid email or password");
  }

  const { accessTTL, refreshTTL } = getTTLs(c.env);
  let tokens;
  try {
    tokens = await issueTokens(c.env.JWT_SECRET, user.id, user.email, accessTTL, refreshTTL);
  } catch (e) {
    console.error("login: issueTokens:", e);
    return writeError(c, 500, "token_failed", "could not issue tokens");
  }

  // Non-fatal — login already succeeded
  touchLogin(c.env, user.id).catch((e) => console.error("login: touchLogin:", e));

  const resp: AuthResponse = { user: userToResponse(user), tokens };
  return c.json(resp, 200);
});

// ---- POST /auth/refresh ----

r.post("/refresh", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const raw = typeof body.refresh_token === "string" ? body.refresh_token : "";

  let claims;
  try {
    claims = await parseToken(c.env.JWT_SECRET, raw, "refresh");
  } catch {
    return writeError(c, 401, "invalid_token", "invalid or expired refresh token");
  }

  const user = await getUserById(c.env, claims.uid);
  if (!user) {
    return writeError(c, 401, "invalid_token", "user no longer exists");
  }

  const { accessTTL, refreshTTL } = getTTLs(c.env);
  let tokens;
  try {
    tokens = await issueTokens(c.env.JWT_SECRET, user.id, user.email, accessTTL, refreshTTL);
  } catch (e) {
    console.error("refresh: issueTokens:", e);
    return writeError(c, 500, "token_failed", "could not issue tokens");
  }

  return c.json(tokens, 200);
});

// ---- POST /auth/verify (JSON body) & GET /auth/verify?token= ----

async function handleVerify(c: Context<AppEnv>, token: string): Promise<Response> {
  const userId = await consumeToken(c.env, "email_verify", token);
  if (!userId) {
    return writeError(c, 400, "invalid_token", "verification link is invalid or expired");
  }

  try {
    await markVerified(c.env, userId);
  } catch (e) {
    console.error("verify: markVerified:", e);
    return writeError(c, 500, "verify_failed", "could not verify email");
  }

  const user = await getUserById(c.env, userId);
  if (!user) {
    // Verification recorded; just can't return user. Don't fail.
    return c.json({ verified: true }, 200);
  }

  return c.json({ verified: true, user: userToResponse(user) }, 200);
}

r.post("/verify", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }
  const token = typeof body.token === "string" ? body.token : "";
  return handleVerify(c, token);
});

r.get("/verify", async (c) => {
  const token = c.req.query("token") ?? "";
  return handleVerify(c, token);
});

// ---- POST /auth/verify/resend ----

r.post("/verify/resend", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  const email = normalizeEmail(rawEmail);
  if (!email) {
    // Don't leak that the email is invalid — always 200
    return c.json({ sent: true }, 200);
  }

  const user = await getUserByEmail(c.env, email);
  if (!user || user.email_verified_at) {
    // User doesn't exist or is already verified — silent 200
    return c.json({ sent: true }, 200);
  }

  // Invalidate existing tokens then issue a fresh one (NoopSender)
  try {
    await invalidateUserTokens(c.env, "email_verify", user.id);
    await issueToken(c.env, "email_verify", user.id, VERIFY_TOKEN_TTL);
  } catch (e) {
    console.error("verify/resend: issueToken:", e);
    // Still return 200 — don't leak failures
  }

  return c.json({ sent: true }, 200);
});

// ---- POST /auth/password-reset/request ----

r.post("/password-reset/request", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return c.json({ sent: true }, 200);
  }

  const user = await getUserByEmail(c.env, email);
  if (!user) {
    return c.json({ sent: true }, 200);
  }

  try {
    await invalidateUserTokens(c.env, "password_reset", user.id);
    const rtok = await issueToken(c.env, "password_reset", user.id, RESET_TOKEN_TTL);
    const base = c.env.FRONTEND_BASE_URL ?? "";
    const resetURL = `${base}/reset-password?token=${encodeURIComponent(rtok)}`;
    const em = passwordResetEmail(user.full_name ?? "", resetURL);
    await enqueue(c.env, {
      to: user.email, subject: em.subject, html: em.html, text: em.text,
      kind: "password_reset", userId: user.id,
    });
  } catch (e) {
    console.error("password-reset/request:", e);
    // Still return 200 — don't leak failures
  }

  return c.json({ sent: true }, 200);
});

// ---- POST /auth/password-reset/confirm ----

r.post("/password-reset/confirm", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const token = typeof body.token === "string" ? body.token : "";
  const newPassword = typeof body.new_password === "string" ? body.new_password : "";

  const userId = await consumeToken(c.env, "password_reset", token);
  if (!userId) {
    return writeError(c, 400, "invalid_token", "reset link is invalid or expired");
  }

  let hash: string;
  try {
    hash = await hashPassword(newPassword);
  } catch (e) {
    return writeError(c, 400, "invalid_password", e instanceof Error ? e.message : "invalid password");
  }

  try {
    await updatePasswordHash(c.env, userId, hash);
  } catch (e) {
    console.error("password-reset/confirm: updatePasswordHash:", e);
    return writeError(c, 500, "update_failed", "could not update password");
  }

  // Invalidate any remaining reset tokens so older links can't be reused
  invalidateUserTokens(c.env, "password_reset", userId).catch((e) =>
    console.error("password-reset/confirm: invalidateUserTokens:", e),
  );

  return c.json({ reset: true }, 200);
});

// ---- GET /auth/me ----

r.get("/me", requireAuth, async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return writeError(c, 401, "unauthorized", "missing identity");
  }

  const user = await getUserById(c.env, userId);
  if (!user) {
    return writeError(c, 404, "not_found", "user not found");
  }

  return c.json(userToResponse(user), 200);
});

export default r;
