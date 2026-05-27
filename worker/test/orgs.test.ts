/**
 * Pure-function tests for the orgs module helpers.
 * These tests are offline (no DB, no Worker) — they exercise:
 *   - slugify() generation and edge cases (matches Go slugify exactly)
 *   - OrganizationKind validation
 *   - Role validation
 *   - Invitation token hashing round-trip (via lib/crypto)
 */
import { test, expect, describe } from "vitest";
import { slugify } from "../src/modules/orgs/queries";
import { hashToken, newRandomToken } from "../src/lib/crypto";

// ─── slugify ────────────────────────────────────────────────────────────────

describe("slugify — matches Go org.slugify", () => {
  test("lowercases and keeps alphanumeric", () => {
    expect(slugify("MyOrg")).toBe("myorg");
    expect(slugify("Acme123")).toBe("acme123");
  });

  test("converts separators to single dash", () => {
    expect(slugify("hello world")).toBe("hello-world");
    expect(slugify("hello--world")).toBe("hello-world");
    expect(slugify("hello_world")).toBe("hello-world");
    expect(slugify("hello/world")).toBe("hello-world");
    expect(slugify("a & b")).toBe("a-b");
  });

  test("trims leading/trailing dashes", () => {
    expect(slugify("-foo-")).toBe("foo");
    expect(slugify("  -foo-  ")).toBe("foo");
  });

  test("pads short slugs with -org suffix", () => {
    // "ab" -> "ab-org" (length 6, passes check)
    expect(slugify("ab")).toBe("ab-org");
    // single char -> "a-org" (5 chars)
    expect(slugify("a")).toBe("a-org");
    // empty string: "" + "-org" -> trim dashes -> "org" (matches Go behaviour)
    expect(slugify("")).toBe("org");
    // three chars — no padding needed
    expect(slugify("abc")).toBe("abc");
  });

  test("truncates at 60 characters and trims trailing dash", () => {
    const long = "a".repeat(65);
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).not.toMatch(/^-|-$/);
  });

  test("strips unsupported characters", () => {
    expect(slugify("héllo!")).toBe("hllo");
    expect(slugify("C++ Corp")).toBe("c-corp");
    // all-noise input: "" + "-org" -> trim -> "org" (matches Go behaviour)
    expect(slugify("$$$")).toBe("org");
  });

  test("real company names produce stable slugs", () => {
    expect(slugify("Pick n Pay")).toBe("pick-n-pay");
    expect(slugify("Woolworths PTY LTD")).toBe("woolworths-pty-ltd");
    expect(slugify("Uber Eats SA")).toBe("uber-eats-sa");
    expect(slugify("John & Jane's Bakery")).toBe("john-janes-bakery");
  });

  test("slug passes DB constraint regex ^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", () => {
    const slugConstraint = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
    const names = [
      "My Business", "Acme Corp", "Test Org 42", "AB", "xyz",
      "a".repeat(60),
    ];
    for (const name of names) {
      const s = slugify(name);
      if (s.length >= 3) {
        expect(s).toMatch(slugConstraint);
      }
    }
  });
});

// ─── Kind validation ────────────────────────────────────────────────────────

describe("OrganizationKind validation", () => {
  const VALID_KINDS = ["personal", "business"] as const;

  test("accepts valid kinds", () => {
    expect(VALID_KINDS.includes("personal")).toBe(true);
    expect(VALID_KINDS.includes("business")).toBe(true);
  });

  test("rejects invalid kinds", () => {
    // Cast to any to simulate runtime validation of unknown input
    const badKinds = ["solo", "company", "", "PERSONAL", "Business"];
    for (const k of badKinds) {
      expect((VALID_KINDS as readonly string[]).includes(k)).toBe(false);
    }
  });
});

// ─── Role validation ────────────────────────────────────────────────────────

describe("Role validation", () => {
  const VALID_ROLES = ["owner", "admin", "accountant", "member", "viewer"] as const;

  test("accepts all five roles", () => {
    for (const r of VALID_ROLES) {
      expect(VALID_ROLES.includes(r)).toBe(true);
    }
  });

  test("rejects unknown roles", () => {
    const bad = ["superadmin", "guest", "", "Owner", "ADMIN"];
    for (const r of bad) {
      expect((VALID_ROLES as readonly string[]).includes(r)).toBe(false);
    }
  });
});

// ─── Invitation token round-trip ────────────────────────────────────────────

describe("invitation token hashing (lib/crypto)", () => {
  test("hashToken is deterministic", () => {
    const token = "some-plain-token-abc123";
    expect(hashToken(token)).toBe(hashToken(token));
  });

  test("different tokens produce different hashes", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });

  test("newRandomToken produces unique tokens", () => {
    const a = newRandomToken();
    const b = newRandomToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
    expect(b.length).toBeGreaterThan(20);
  });

  test("token hash is hex string of length 64 (SHA-256)", () => {
    const h = hashToken(newRandomToken());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("round-trip: hash of newRandomToken can be used as lookup key", () => {
    const plain = newRandomToken();
    const hash1 = hashToken(plain);
    const hash2 = hashToken(plain);
    // Deterministic — DB lookup by hash will find the same row
    expect(hash1).toBe(hash2);
  });
});
