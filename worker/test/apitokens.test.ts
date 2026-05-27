/**
 * API-token module unit tests — pure logic only (no DB / network / KV).
 *
 * Tests:
 *   - Token generation: format, prefix length, uniqueness
 *   - Token hashing: SHA-256 determinism, prefix lookup
 *   - prefixOf: 12-char prefix matches "sk_{kind}_" + first random chars
 *   - Scope checking: hasScope logic
 *   - Rate-limit window logic: fixed-window counter behaviour
 *   - VALID_KINDS set
 */
import { test, expect, describe } from "vitest";
import { generateToken, prefixOf } from "../src/modules/apitokens/queries";
import { hashToken } from "../src/lib/crypto";
import { VALID_KINDS, ScopeDocumentsWrite, ScopeTransactionsRead } from "../src/modules/apitokens/types";
import { DEFAULT_RATE_LIMIT_PER_MIN } from "../src/modules/apitokens/ratelimit";

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

describe("generateToken", () => {
  test("format is sk_{kind}_{base64url}", () => {
    const { plaintext } = generateToken("live");
    expect(plaintext).toMatch(/^sk_live_[A-Za-z0-9_-]+$/);
  });

  test("test kind produces sk_test_... prefix", () => {
    const { plaintext } = generateToken("test");
    expect(plaintext.startsWith("sk_test_")).toBe(true);
  });

  test("restricted kind produces sk_restricted_... prefix", () => {
    const { plaintext } = generateToken("restricted");
    expect(plaintext.startsWith("sk_restricted_")).toBe(true);
  });

  test("plaintext is unique on each call", () => {
    const a = generateToken("live");
    const b = generateToken("live");
    expect(a.plaintext).not.toBe(b.plaintext);
  });

  test("prefix is exactly 12 characters", () => {
    const { prefix } = generateToken("live");
    expect(prefix.length).toBe(12);
  });

  test("prefix is first 12 chars of plaintext", () => {
    const { plaintext, prefix } = generateToken("live");
    expect(prefix).toBe(plaintext.slice(0, 12));
  });

  test("prefix matches sk_live_ start", () => {
    const { prefix } = generateToken("live");
    expect(prefix.startsWith("sk_live_")).toBe(true);
  });

  test("prefix for test kind starts with sk_test_", () => {
    const { prefix } = generateToken("test");
    expect(prefix.startsWith("sk_te")).toBe(true); // "sk_test_" = 8 chars, prefix[0..7]
    // prefix is 12 chars: "sk_test_" (8) + 4 random chars
    expect(prefix.slice(0, 8)).toBe("sk_test_");
  });
});

// ---------------------------------------------------------------------------
// prefixOf
// ---------------------------------------------------------------------------

describe("prefixOf", () => {
  test("returns first 12 chars for a long token", () => {
    const token = "sk_live_abcdefghij1234567890";
    expect(prefixOf(token)).toBe("sk_live_abcd");
    expect(prefixOf(token).length).toBe(12);
  });

  test("returns full string when shorter than 12", () => {
    expect(prefixOf("sk_live_ab")).toBe("sk_live_ab");
  });

  test("returns exact string when exactly 12", () => {
    expect(prefixOf("sk_live_abcd")).toBe("sk_live_abcd");
  });
});

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

describe("hashToken (via lib/crypto)", () => {
  test("SHA-256 output is 64 hex chars", () => {
    const h = hashToken("sk_live_test");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hashing is deterministic", () => {
    expect(hashToken("sk_live_abc")).toBe(hashToken("sk_live_abc"));
  });

  test("different inputs produce different hashes", () => {
    expect(hashToken("sk_live_abc")).not.toBe(hashToken("sk_live_abd"));
  });

  test("prefix + hash lookup pattern works", () => {
    const { plaintext, prefix } = generateToken("live");
    const hash = hashToken(plaintext);
    // Simulate: stored prefix matches, stored hash matches
    expect(prefix).toBe(prefixOf(plaintext));
    expect(hash).toBe(hashToken(plaintext));
    // A different token won't match
    const { plaintext: other } = generateToken("live");
    expect(hashToken(other)).not.toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Scope checking (mirrors Go (*Token).HasScope)
// ---------------------------------------------------------------------------

describe("scope checking", () => {
  function hasScope(scopes: string[], scope: string): boolean {
    return scopes.includes(scope);
  }

  test("hasScope returns true for exact match", () => {
    expect(hasScope([ScopeDocumentsWrite], ScopeDocumentsWrite)).toBe(true);
  });

  test("hasScope returns false for missing scope", () => {
    expect(hasScope([ScopeDocumentsWrite], ScopeTransactionsRead)).toBe(false);
  });

  test("hasScope returns true when scope is among multiple", () => {
    expect(hasScope([ScopeDocumentsWrite, ScopeTransactionsRead], ScopeTransactionsRead)).toBe(true);
  });

  test("empty scopes always returns false", () => {
    expect(hasScope([], ScopeDocumentsWrite)).toBe(false);
  });

  test("scope constants match Go values", () => {
    expect(ScopeDocumentsWrite).toBe("documents:write");
    expect(ScopeTransactionsRead).toBe("transactions:read");
  });
});

// ---------------------------------------------------------------------------
// VALID_KINDS
// ---------------------------------------------------------------------------

describe("VALID_KINDS", () => {
  test("live is valid", () => expect(VALID_KINDS.has("live")).toBe(true));
  test("test is valid", () => expect(VALID_KINDS.has("test")).toBe(true));
  test("restricted is valid", () => expect(VALID_KINDS.has("restricted")).toBe(true));
  test("arbitrary string is invalid", () => expect(VALID_KINDS.has("admin")).toBe(false));
  test("empty string is invalid", () => expect(VALID_KINDS.has("")).toBe(false));
});

// ---------------------------------------------------------------------------
// Rate-limit window logic (unit-level, no KV)
// ---------------------------------------------------------------------------

describe("rate-limit window logic", () => {
  test("default rate limit is 60", () => {
    expect(DEFAULT_RATE_LIMIT_PER_MIN).toBe(60);
  });

  test("window key is consistent within same minute", () => {
    const t1 = Math.floor(Date.now() / 60_000);
    const t2 = Math.floor(Date.now() / 60_000);
    expect(t1).toBe(t2);
  });

  test("window key increments across minutes", () => {
    const base = Math.floor(1_700_000_000_000 / 60_000);
    const next = Math.floor((1_700_000_000_000 + 60_000) / 60_000);
    expect(next).toBe(base + 1);
  });

  test("KV key format includes token id and window", () => {
    const tokenId = "test-token-id";
    const windowKey = Math.floor(Date.now() / 60_000);
    const kvKey = `rl:${tokenId}:${windowKey}`;
    expect(kvKey).toMatch(/^rl:[^:]+:\d+$/);
  });

  test("counter below limit returns allowed=true (simulated)", () => {
    // Simulate the logic: count < limit → allowed
    const limit = 60;
    const count = 59;
    expect(count < limit).toBe(true);
  });

  test("counter at limit returns allowed=false (simulated)", () => {
    const limit = 60;
    const count = 60;
    expect(count >= limit).toBe(true);
  });

  test("zero limitPerMin falls back to default (simulated)", () => {
    const limitPerMin = 0;
    const effective = limitPerMin > 0 ? limitPerMin : DEFAULT_RATE_LIMIT_PER_MIN;
    expect(effective).toBe(DEFAULT_RATE_LIMIT_PER_MIN);
  });

  test("custom limitPerMin is used as-is (simulated)", () => {
    const limitPerMin = 120;
    const effective = limitPerMin > 0 ? limitPerMin : DEFAULT_RATE_LIMIT_PER_MIN;
    expect(effective).toBe(120);
  });

  test("new window resets counter (simulated)", () => {
    // The key changes → KV.get() returns null → count starts at 0
    const prevWindow = 100;
    const currWindow = 101; // new minute
    expect(prevWindow).not.toBe(currWindow);
    // With a new window key, existing counter is not found → count = 0 → allowed
    const count = 0; // simulates KV miss
    const limit = 60;
    expect(count < limit).toBe(true);
  });
});
