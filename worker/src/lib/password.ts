/**
 * Password hashing — PBKDF2-SHA256 via Web Crypto (native, Workers-CPU-safe).
 * Pure-JS scrypt (@noble) blew the free-tier CPU limit (Cloudflare error 1102);
 * Web Crypto runs natively and stays within budget. Async by nature.
 * Stored format: pbkdf2$<iterations>$<saltB64>$<hashB64>.
 * Constraints mirror Go internal/auth/password.go: min 8, max 256 chars.
 */
import { timingSafeEqual } from "./crypto";

const ITERATIONS = 100_000;
const SALT_LEN = 16;
const DK_BITS = 256;

export const MIN_PASSWORD_LEN = 8;
export const MAX_PASSWORD_LEN = 256;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < MIN_PASSWORD_LEN) throw new Error("password too short");
  if (plaintext.length > MAX_PASSWORD_LEN) throw new Error("password too long");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const dk = await pbkdf2(plaintext, salt, ITERATIONS, DK_BITS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(dk)}`;
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  try {
    salt = unb64(parts[2]);
  } catch {
    return false;
  }
  const expected = parts[3];
  const dk = await pbkdf2(plaintext, salt, iterations, DK_BITS);
  return timingSafeEqual(b64(dk), expected);
}

async function pbkdf2(pw: string, salt: Uint8Array, iterations: number, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const buf = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, bits);
  return new Uint8Array(buf);
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
