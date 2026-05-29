/**
 * Unit tests for the documents module pure helpers.
 * Tests are isolated — no DB, no R2, no network.
 *
 * Covers:
 *  - recipient local-part extraction (Go: splitAddress + normalisation)
 *  - attachment MIME filtering (Go: allowed types + normalizeMIME)
 *  - sha256Hex (Web Crypto wrapper)
 */
import { test, expect, describe } from "vitest";
import {
  extractLocalPart,
  extractDomain,
  normalizeMime,
  extForMime,
  sha256Hex,
  ALLOWED_UPLOAD_MIMES,
} from "../src/modules/documents/service";

// ---------------------------------------------------------------------------
// extractLocalPart — mirrors Go splitAddress + Ingest normalisation
// ---------------------------------------------------------------------------

describe("extractLocalPart", () => {
  test("plain address", () => {
    expect(extractLocalPart("acme@mail.slipscan.app")).toBe("acme");
  });

  test("display name + angle brackets", () => {
    expect(extractLocalPart("Acme Corp <acme@mail.slipscan.app>")).toBe("acme");
  });

  test("no @ present → returns the whole string lower-cased", () => {
    expect(extractLocalPart("acme-local")).toBe("acme-local");
  });

  test("upper-case local-part is lowercased", () => {
    expect(extractLocalPart("ACME@mail.slipscan.app")).toBe("acme");
  });

  test("local-part with dots and hyphens is preserved", () => {
    expect(extractLocalPart("foo.bar-baz@example.com")).toBe("foo.bar-baz");
  });
});

// ---------------------------------------------------------------------------
// extractDomain
// ---------------------------------------------------------------------------

describe("extractDomain", () => {
  test("returns domain part", () => {
    expect(extractDomain("acme@mail.slipscan.app")).toBe("mail.slipscan.app");
  });

  test("no @ → empty string", () => {
    expect(extractDomain("localonly")).toBe("");
  });

  test("angle bracket format", () => {
    expect(extractDomain("Foo <foo@example.com>")).toBe("example.com");
  });
});

// ---------------------------------------------------------------------------
// normalizeMime — mirrors Go normalizeMIME / normalizeMime
// ---------------------------------------------------------------------------

describe("normalizeMime", () => {
  test("strips charset parameter", () => {
    expect(normalizeMime("application/pdf; charset=utf-8")).toBe("application/pdf");
  });

  test("lowercases", () => {
    expect(normalizeMime("Image/JPEG")).toBe("image/jpeg");
  });

  test("trims whitespace", () => {
    expect(normalizeMime("  image/png  ")).toBe("image/png");
  });

  test("no parameter → unchanged (lowercased + trimmed)", () => {
    expect(normalizeMime("application/pdf")).toBe("application/pdf");
  });
});

// ---------------------------------------------------------------------------
// extForMime — mirrors Go extForMIME
// ---------------------------------------------------------------------------

describe("extForMime", () => {
  test("pdf", () => expect(extForMime("application/pdf")).toBe(".pdf"));
  test("jpeg", () => expect(extForMime("image/jpeg")).toBe(".jpg"));
  test("png", () => expect(extForMime("image/png")).toBe(".png"));
  test("heic", () => expect(extForMime("image/heic")).toBe(".heic"));
  test("heif maps to .heic", () => expect(extForMime("image/heif")).toBe(".heic"));
  test("unknown → .bin", () => expect(extForMime("text/plain")).toBe(".bin"));
});

// ---------------------------------------------------------------------------
// ALLOWED_UPLOAD_MIMES — mirrors Go allowedMimes map
// ---------------------------------------------------------------------------

describe("ALLOWED_UPLOAD_MIMES", () => {
  const expected = new Map([
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["image/heic", ".heic"],
    ["image/heif", ".heif"],
    ["application/pdf", ".pdf"],
  ]);

  test("has the same keys as Go allowedMimes", () => {
    expect(new Set(ALLOWED_UPLOAD_MIMES.keys())).toEqual(new Set(expected.keys()));
  });

  test("extensions match", () => {
    for (const [mime, ext] of expected) {
      expect(ALLOWED_UPLOAD_MIMES.get(mime)).toBe(ext);
    }
  });

  test("text/html is not allowed", () => {
    expect(ALLOWED_UPLOAD_MIMES.has("text/html")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sha256Hex — Web Crypto wrapper
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  test("known digest (empty input)", async () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const h = await sha256Hex(new Uint8Array(0));
    expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("known digest (hello)", async () => {
    // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const data = new TextEncoder().encode("hello");
    const h = await sha256Hex(data);
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  test("is deterministic", async () => {
    const data = new TextEncoder().encode("slipscan");
    const h1 = await sha256Hex(data);
    const h2 = await sha256Hex(data);
    expect(h1).toBe(h2);
  });

  test("different inputs produce different hashes", async () => {
    const h1 = await sha256Hex(new TextEncoder().encode("foo"));
    const h2 = await sha256Hex(new TextEncoder().encode("bar"));
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Attachment MIME filtering — behaviour mirrors Go ParseMessage allowed check
// ---------------------------------------------------------------------------

describe("attachment MIME filtering logic", () => {
  const allowed = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/heif",
  ]);

  const cases: [string, boolean][] = [
    ["application/pdf", true],
    ["image/jpeg", true],
    ["image/png", true],
    ["image/heic", true],
    ["image/heif", true],
    ["image/gif", false],
    ["text/plain", false],
    ["application/zip", false],
    ["image/webp", false], // webp not in attachment allowed set (upload-only)
  ];

  for (const [mime, expected] of cases) {
    test(`${mime} → ${expected ? "allowed" : "rejected"}`, () => {
      expect(allowed.has(normalizeMime(mime))).toBe(expected);
    });
  }
});
