/**
 * Password hashing — scrypt via @noble/hashes (Workers/Web-Crypto friendly).
 * Go used bcrypt cost-12 (~250ms), which would blow the free-tier CPU budget;
 * the DB is fresh (no existing hashes) so we choose a Workers-appropriate KDF.
 * Stored format: scrypt$N$r$p$saltHex$hashHex.
 *
 * Constraints mirror Go internal/auth/password.go: min 8, max 256 chars.
 */
import { scrypt } from "@noble/hashes/scrypt";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import { timingSafeEqual } from "./crypto";

// N=2^14 keeps CPU ~tens of ms; raise on paid plans if desired.
const N = 16384;
const R = 8;
const P = 1;
const DK_LEN = 32;
const SALT_LEN = 16;

export const MIN_PASSWORD_LEN = 8;
export const MAX_PASSWORD_LEN = 256;

export function hashPassword(plaintext: string): string {
  if (plaintext.length < MIN_PASSWORD_LEN) throw new Error("password too short");
  if (plaintext.length > MAX_PASSWORD_LEN) throw new Error("password too long");
  const salt = randomBytes(SALT_LEN);
  const dk = scrypt(new TextEncoder().encode(plaintext), salt, { N, r: R, p: P, dkLen: DK_LEN });
  return `scrypt$${N}$${R}$${P}$${bytesToHex(salt)}$${bytesToHex(dk)}`;
}

export function verifyPassword(plaintext: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  let salt: Uint8Array;
  try {
    salt = hexToBytes(parts[4]);
  } catch {
    return false;
  }
  const expectedHex = parts[5];
  const dk = scrypt(new TextEncoder().encode(plaintext), salt, {
    N: n,
    r,
    p,
    dkLen: expectedHex.length / 2,
  });
  return timingSafeEqual(bytesToHex(dk), expectedHex);
}
