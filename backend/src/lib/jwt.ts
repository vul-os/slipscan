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
