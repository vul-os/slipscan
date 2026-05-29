/**
 * JWT — HS256 via `jose` (Web Crypto). Port of Go internal/auth/jwt.go.
 * Claims: uid, email (access only), typ, plus registered iss/sub/iat/nbf/exp/jti.
 * 30s clock tolerance, issuer enforced, HS256 only. The TS app both issues and
 * verifies its own tokens (no cross-backend validation needed).
 */
import { SignJWT, jwtVerify } from "jose";

const ISSUER = "slipscan"; // keep internally consistent (issue == verify)
const ALG = "HS256";

export type TokenType = "access" | "refresh";

export interface Claims {
  uid: string;
  email?: string;
  typ: TokenType;
  iss?: string;
  sub?: string;
  iat?: number;
  nbf?: number;
  exp?: number;
  jti?: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
}

const key = (secret: string) => new TextEncoder().encode(secret);

async function sign(
  secret: string,
  uid: string,
  email: string,
  typ: TokenType,
  ttlSec: number,
): Promise<{ token: string; exp: Date }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSec;
  const payload: Record<string, unknown> = { uid, typ };
  if (email) payload.email = email;
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(uid)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(exp)
    .setJti(crypto.randomUUID())
    .sign(key(secret));
  return { token, exp: new Date(exp * 1000) };
}

export async function issueTokens(
  secret: string,
  uid: string,
  email: string,
  accessTTLSec: number,
  refreshTTLSec: number,
): Promise<TokenPair> {
  const a = await sign(secret, uid, email, "access", accessTTLSec);
  const r = await sign(secret, uid, "", "refresh", refreshTTLSec);
  return {
    access_token: a.token,
    refresh_token: r.token,
    access_expires_at: a.exp.toISOString(),
    refresh_expires_at: r.exp.toISOString(),
  };
}

// ── Short-lived file-access tokens ───────────────────────────────────────────
// Issued by the doc detail endpoint so the FE can drop the URL into <img src>
// without sending Authorization headers. Scoped to (docId, orgId) and verified
// against the same JWT_SECRET. Short TTL (15 min) to keep blast radius small.

export interface FileTokenClaims {
  doc: string;
  org: string;
}

export async function signFileToken(
  secret: string,
  docId: string,
  orgId: string,
  ttlSec = 15 * 60,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ doc: docId, org: orgId, typ: "file" })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttlSec)
    .setJti(crypto.randomUUID())
    .sign(key(secret));
}

export async function verifyFileToken(
  secret: string,
  raw: string,
): Promise<FileTokenClaims> {
  const { payload } = await jwtVerify(raw, key(secret), {
    issuer: ISSUER,
    algorithms: [ALG],
    clockTolerance: 30,
  });
  const p = payload as { doc?: string; org?: string; typ?: string };
  if (p.typ !== "file") throw new Error("wrong token type");
  if (!p.doc || !p.org) throw new Error("missing scope");
  return { doc: p.doc, org: p.org };
}

export async function parseToken(
  secret: string,
  raw: string,
  expect: TokenType,
): Promise<Claims> {
  const { payload } = await jwtVerify(raw, key(secret), {
    issuer: ISSUER,
    algorithms: [ALG],
    clockTolerance: 30,
  });
  const c = payload as unknown as Claims;
  if (c.typ !== expect) throw new Error("wrong token type");
  if (!c.uid) throw new Error("missing user id");
  return c;
}
