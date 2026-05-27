/**
 * Token hashing + random tokens — port of Go internal/auth/tokens.go helpers.
 * hashToken: SHA-256 hex (deterministic lookup key for verify/reset tokens).
 * newRandomToken: 32 random bytes, base64url no padding (~43 chars), matching
 * Go base64.RawURLEncoding so token lengths/format are identical.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export function hashToken(plaintext: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(plaintext)));
}

export function newRandomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base64UrlNoPad(b);
}

/** Constant-time string compare for hashes/secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64UrlNoPad(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
