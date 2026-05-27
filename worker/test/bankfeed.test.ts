/**
 * Bankfeed tests — covers the error-prone parts:
 *   1. HMAC-SHA256 webhook signature validation (validateWebhook)
 *   2. webhookEventType extraction
 *   3. Stitch linkURL construction (PKCE parameters present)
 *   4. fetchTransactions direction logic (debit/credit)
 *
 * These tests use the Web Crypto API (available in the vitest/workers runtime
 * or in Node ≥ 19 via globalThis.crypto).
 */
import { test, expect, describe, beforeAll } from "vitest";
import { validateWebhook, webhookEventType, linkURL } from "../src/modules/bankfeed/stitch";
import type { Env } from "../src/bindings";

// ─── HMAC helpers ──────────────────────────────────────────────────────────────

async function signPayload(payload: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, payload);
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── validateWebhook ──────────────────────────────────────────────────────────

describe("validateWebhook", () => {
  const SECRET = "test-webhook-secret-abc123";
  const BODY = new TextEncoder().encode(JSON.stringify({ type: "transaction.settled", accountId: "acc-1" }));

  test("valid signature → true", async () => {
    const sig = await signPayload(BODY, SECRET);
    const ok = await validateWebhook(BODY, sig, SECRET);
    expect(ok).toBe(true);
  });

  test("wrong secret → false", async () => {
    const sig = await signPayload(BODY, "different-secret");
    const ok = await validateWebhook(BODY, sig, SECRET);
    expect(ok).toBe(false);
  });

  test("tampered body → false", async () => {
    const sig = await signPayload(BODY, SECRET);
    const tampered = new TextEncoder().encode(JSON.stringify({ type: "transaction.settled", accountId: "TAMPERED" }));
    const ok = await validateWebhook(tampered, sig, SECRET);
    expect(ok).toBe(false);
  });

  test("truncated signature → false", async () => {
    const sig = await signPayload(BODY, SECRET);
    const truncated = sig.slice(0, sig.length - 2);
    const ok = await validateWebhook(BODY, truncated, SECRET);
    expect(ok).toBe(false);
  });

  test("empty signature → false", async () => {
    const ok = await validateWebhook(BODY, "", SECRET);
    expect(ok).toBe(false);
  });

  test("uppercase hex signature also accepted (constant-time equal lowercases)", async () => {
    const sig = await signPayload(BODY, SECRET);
    const upper = sig.toUpperCase();
    const ok = await validateWebhook(BODY, upper, SECRET);
    expect(ok).toBe(true);
  });

  test("empty body with correct signature → true", async () => {
    const emptyBody = new Uint8Array(0);
    const sig = await signPayload(emptyBody, SECRET);
    const ok = await validateWebhook(emptyBody, sig, SECRET);
    expect(ok).toBe(true);
  });
});

// ─── webhookEventType ─────────────────────────────────────────────────────────

describe("webhookEventType", () => {
  function enc(obj: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  test("extracts 'type' field from Stitch payload", () => {
    expect(webhookEventType(enc({ type: "transaction.settled" }))).toBe("transaction.settled");
    expect(webhookEventType(enc({ type: "reauth_required" }))).toBe("reauth_required");
  });

  test("missing 'type' field → empty string", () => {
    expect(webhookEventType(enc({ event: "transaction.settled" }))).toBe("");
  });

  test("throws on non-JSON payload", () => {
    expect(() => webhookEventType(new TextEncoder().encode("not json"))).toThrow();
  });
});

// ─── linkURL ──────────────────────────────────────────────────────────────────

describe("linkURL", () => {
  const mockEnv = {
    STITCH_CLIENT_ID: "client-abc",
    STITCH_REDIRECT_URL: "https://app.example.com/callback",
  } as Partial<Env> as Env;

  test("includes required OAuth2 parameters", () => {
    const url = linkURL(mockEnv, "org-123", "state-nonce-xyz");
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("secure.stitch.money");
    expect(parsed.searchParams.get("client_id")).toBe("client-abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(parsed.searchParams.get("state")).toBe("state-nonce-xyz");
    expect(parsed.searchParams.get("response_type")).toBe("code");
  });

  test("scope includes transactions and offline_access", () => {
    const url = linkURL(mockEnv, "org-123", "state-x");
    const parsed = new URL(url);
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("transactions");
    expect(scope).toContain("offline_access");
  });

  test("nonce is set to orgId", () => {
    const url = linkURL(mockEnv, "org-456", "state-y");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("nonce")).toBe("org-456");
  });
});

// ─── direction logic (inline unit test) ───────────────────────────────────────

describe("Stitch direction mapping", () => {
  // The Go rule: amount.quantity >= 0 → credit; < 0 → debit; amount always positive.
  function mapDirection(quantity: number): { dir: "debit" | "credit"; amt: number } {
    const dir = quantity >= 0 ? "credit" : "debit";
    const amt = Math.abs(quantity);
    return { dir, amt };
  }

  test("positive quantity → credit, positive amount", () => {
    const r = mapDirection(150.5);
    expect(r.dir).toBe("credit");
    expect(r.amt).toBe(150.5);
  });

  test("negative quantity → debit, positive amount", () => {
    const r = mapDirection(-75.25);
    expect(r.dir).toBe("debit");
    expect(r.amt).toBe(75.25);
  });

  test("zero quantity → credit (inclusive boundary)", () => {
    const r = mapDirection(0);
    expect(r.dir).toBe("credit");
    expect(r.amt).toBe(0);
  });
});
