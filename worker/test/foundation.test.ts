import { test, expect } from "vitest";
import { normalizeMerchant } from "../src/lib/merchant";
import { money, add, sub, cmp } from "../src/lib/money";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { issueTokens, parseToken } from "../src/lib/jwt";
import { hashToken, newRandomToken } from "../src/lib/crypto";

// merchant.Normalize parity with the Go doc examples.
test("normalizeMerchant matches Go examples", () => {
  expect(normalizeMerchant("WOOLWORTHS PTY LTD #4021  JHB")).toBe("woolworths jhb");
  expect(normalizeMerchant("Uber *EATS help.uber.com")).toBe("uber eats help uber com");
  expect(normalizeMerchant("  Pick n Pay 0123 ")).toBe("pick n pay");
  expect(normalizeMerchant("")).toBe("");
  expect(normalizeMerchant("12345")).toBe("12345"); // all-noise → fallback
});

test("money uses decimal precision (no float drift)", () => {
  expect(money(add("0.1", "0.2"))).toBe("0.30"); // float would give 0.30000000000000004
  expect(money(sub("100.00", "0.01"))).toBe("99.99");
  expect(cmp("10.00", "10.000")).toBe(0);
});

test("password scrypt round-trips and rejects wrong", () => {
  const h = hashPassword("correct horse battery");
  expect(verifyPassword("correct horse battery", h)).toBe(true);
  expect(verifyPassword("wrong", h)).toBe(false);
  expect(h.startsWith("scrypt$")).toBe(true);
});

test("jwt issue/parse round-trips; rejects wrong type", async () => {
  const secret = "x".repeat(40);
  const uid = crypto.randomUUID();
  const pair = await issueTokens(secret, uid, "a@b.com", 900, 3600);
  const access = await parseToken(secret, pair.access_token, "access");
  expect(access.uid).toBe(uid);
  expect(access.email).toBe("a@b.com");
  await expect(parseToken(secret, pair.access_token, "refresh")).rejects.toBeTruthy();
});

test("token hashing is deterministic; random tokens are unique", () => {
  expect(hashToken("abc")).toBe(hashToken("abc"));
  expect(hashToken("abc")).not.toBe(hashToken("abd"));
  expect(newRandomToken()).not.toBe(newRandomToken());
});
