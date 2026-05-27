/**
 * Auth module unit tests — pure helpers only (no DB / network).
 * Tests: duration parsing, email normalisation, request validation paths.
 */
import { test, expect, describe } from "vitest";
import { parseDurationSec, normalizeEmail, isUniqueViolation } from "../src/modules/auth/queries";
import { hashPassword } from "../src/lib/password";

// ---- parseDurationSec ----

describe("parseDurationSec", () => {
  test("single hour unit", () => {
    expect(parseDurationSec("1h", 0)).toBe(3600);
    expect(parseDurationSec("168h", 0)).toBe(168 * 3600);
  });

  test("single minute unit", () => {
    expect(parseDurationSec("15m", 0)).toBe(900);
    expect(parseDurationSec("30m", 0)).toBe(1800);
  });

  test("single second unit", () => {
    expect(parseDurationSec("900s", 0)).toBe(900);
    expect(parseDurationSec("60s", 0)).toBe(60);
  });

  test("compound h+m", () => {
    expect(parseDurationSec("1h30m", 0)).toBe(5400);
    expect(parseDurationSec("2h15m", 0)).toBe(8100);
  });

  test("compound h+m+s", () => {
    expect(parseDurationSec("1h1m1s", 0)).toBe(3661);
  });

  test("fractional hours", () => {
    expect(parseDurationSec("0.5h", 0)).toBe(1800);
  });

  test("falls back to default when undefined", () => {
    expect(parseDurationSec(undefined, 900)).toBe(900);
  });

  test("falls back to default when empty string", () => {
    expect(parseDurationSec("", 900)).toBe(900);
  });

  test("bare integer treated as seconds", () => {
    expect(parseDurationSec("3600", 0)).toBe(3600);
  });

  test("garbage falls back to default", () => {
    expect(parseDurationSec("xyz", 42)).toBe(42);
  });

  test("Go defaults: 15m access, 168h refresh", () => {
    expect(parseDurationSec("15m", 0)).toBe(900);
    expect(parseDurationSec("168h", 0)).toBe(604800);
  });
});

// ---- normalizeEmail ----

describe("normalizeEmail", () => {
  test("lowercases a plain address", () => {
    expect(normalizeEmail("User@Example.COM")).toBe("user@example.com");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeEmail("  foo@bar.com  ")).toBe("foo@bar.com");
  });

  test("rejects empty string", () => {
    expect(normalizeEmail("")).toBeNull();
  });

  test("rejects missing @", () => {
    expect(normalizeEmail("notanemail")).toBeNull();
  });

  test("rejects missing domain dot", () => {
    expect(normalizeEmail("a@localhost")).toBeNull();
  });

  test("rejects leading @", () => {
    expect(normalizeEmail("@domain.com")).toBeNull();
  });

  test("accepts subdomain addresses", () => {
    expect(normalizeEmail("x@sub.domain.co.za")).toBe("x@sub.domain.co.za");
  });

  test("accepts plus-addressing", () => {
    expect(normalizeEmail("user+tag@example.com")).toBe("user+tag@example.com");
  });

  test("accepts dots in local part", () => {
    expect(normalizeEmail("first.last@example.com")).toBe("first.last@example.com");
  });
});

// ---- Request validation (shape checks, no DB) ----

describe("register input validation", () => {
  test("valid email is accepted by normalizeEmail", () => {
    expect(normalizeEmail("test@example.com")).not.toBeNull();
  });

  test("invalid email is rejected", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
  });

  test("password too short throws from hashPassword", () => {
    expect(() => hashPassword("short")).toThrow(/short/);
  });

  test("password too long throws from hashPassword", () => {
    expect(() => hashPassword("x".repeat(257))).toThrow(/long/);
  });
});

// ---- isUniqueViolation helper ----

describe("isUniqueViolation", () => {
  test("matches 23505 SQLSTATE string", () => {
    expect(isUniqueViolation(new Error("ERROR: SQLSTATE 23505"))).toBe(true);
  });

  test("matches unique constraint text", () => {
    expect(isUniqueViolation(new Error("duplicate key value violates unique constraint"))).toBe(true);
  });

  test("matches unique_violation text", () => {
    expect(isUniqueViolation(new Error("unique_violation on users_email_key"))).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isUniqueViolation(new Error("connection refused"))).toBe(false);
  });

  test("handles null/undefined gracefully", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
