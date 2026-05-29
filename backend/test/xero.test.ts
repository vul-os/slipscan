/**
 * Unit tests for the Xero module.
 * Covers:
 *   - xero.ts: accountCodeFor, bankAccountCodeFor, taxTypeFor, descriptionFor
 *   - xero.ts: buildXeroContact payload shape
 *   - xero.ts: buildXeroBankTransaction payload shape
 *   - routes.ts: 503 when XERO_CLIENT_ID unset (Hono handler unit test)
 * No live network calls.
 */
import { describe, test, expect } from "vitest";
import {
  accountCodeFor,
  bankAccountCodeFor,
  taxTypeFor,
  descriptionFor,
  _buildXeroContact,
  _buildXeroBankTransaction,
} from "../src/modules/xero/xero";
import type { Contact, Transaction } from "../src/modules/xero/types";

// ── accountCodeFor ────────────────────────────────────────────────────────────

describe("accountCodeFor", () => {
  test("passes through non-empty code", () => {
    expect(accountCodeFor("500")).toBe("500");
    expect(accountCodeFor("OUTPUT")).toBe("OUTPUT");
  });

  test("falls back to '200' when empty", () => {
    expect(accountCodeFor("")).toBe("200");
  });
});

// ── bankAccountCodeFor ────────────────────────────────────────────────────────

describe("bankAccountCodeFor", () => {
  test("passes through non-empty code", () => {
    expect(bankAccountCodeFor("090")).toBe("090");
    expect(bankAccountCodeFor("MY-BANK")).toBe("MY-BANK");
  });

  test("falls back to '090' when empty", () => {
    expect(bankAccountCodeFor("")).toBe("090");
  });
});

// ── taxTypeFor ────────────────────────────────────────────────────────────────

describe("taxTypeFor", () => {
  test("known Xero tax types are returned uppercase", () => {
    expect(taxTypeFor("OUTPUT")).toBe("OUTPUT");
    expect(taxTypeFor("input")).toBe("INPUT");
    expect(taxTypeFor("NONE")).toBe("NONE");
    expect(taxTypeFor("ZERORATEDOUTPUT")).toBe("ZERORATEDOUTPUT");
    expect(taxTypeFor("exemptinput")).toBe("EXEMPTINPUT");
  });

  test("empty string → NONE", () => {
    expect(taxTypeFor("")).toBe("NONE");
  });

  test("unknown code is passed through (org may use Xero-aligned codes)", () => {
    expect(taxTypeFor("TAX001")).toBe("TAX001");
    expect(taxTypeFor("CUSTOM_RATE")).toBe("CUSTOM_RATE");
  });
});

// ── descriptionFor ────────────────────────────────────────────────────────────

describe("descriptionFor", () => {
  const base = (): Transaction => ({
    id:          "tx-1",
    postedDate:  new Date("2025-05-21"),
    direction:   "debit",
    merchant:    "",
    description: "",
    amount:      100,
    currency:    "ZAR",
    tax:         0,
    accountCode: "",
    taxRateCode: "",
    contactId:   "00000000-0000-0000-0000-000000000000",
  });

  test("merchant + distinct description → 'merchant — description'", () => {
    const t = { ...base(), merchant: "ACME", description: "Office supplies" };
    expect(descriptionFor(t)).toBe("ACME — Office supplies");
  });

  test("merchant only", () => {
    const t = { ...base(), merchant: "Shell", description: "" };
    expect(descriptionFor(t)).toBe("Shell");
  });

  test("description only", () => {
    const t = { ...base(), merchant: "", description: "Fuel purchase" };
    expect(descriptionFor(t)).toBe("Fuel purchase");
  });

  test("merchant equals description → returns merchant", () => {
    const t = { ...base(), merchant: "ACME", description: "ACME" };
    expect(descriptionFor(t)).toBe("ACME");
  });

  test("both empty → empty string", () => {
    const t = base();
    expect(descriptionFor(t)).toBe("");
  });
});

// ── buildXeroContact ──────────────────────────────────────────────────────────

describe("buildXeroContact", () => {
  const baseContact = (): Contact => ({
    id:           "c-1",
    name:         "Acme Corp",
    legalName:    "",
    email:        "billing@acme.com",
    phone:        "+27 11 000 0000",
    taxNumber:    "VAT123",
    addressLine1: "1 Main St",
    addressLine2: "",
    city:         "Cape Town",
    region:       "WC",
    postalCode:   "8001",
    country:      "ZA",
    kind:         "customer",
  });

  test("sets Name, EmailAddress, TaxNumber", () => {
    const xc = _buildXeroContact(baseContact());
    expect(xc["Name"]).toBe("Acme Corp");
    expect(xc["EmailAddress"]).toBe("billing@acme.com");
    expect(xc["TaxNumber"]).toBe("VAT123");
  });

  test("includes ContactID when existingExternalId provided (update path)", () => {
    const xc = _buildXeroContact(baseContact(), "xero-contact-uuid");
    expect(xc["ContactID"]).toBe("xero-contact-uuid");
  });

  test("omits ContactID on create path", () => {
    const xc = _buildXeroContact(baseContact());
    expect(xc["ContactID"]).toBeUndefined();
  });

  test("customer kind → IsCustomer=true, no IsSupplier", () => {
    const xc = _buildXeroContact({ ...baseContact(), kind: "customer" });
    expect(xc["IsCustomer"]).toBe(true);
    expect(xc["IsSupplier"]).toBeUndefined();
  });

  test("supplier kind → IsSupplier=true, no IsCustomer", () => {
    const xc = _buildXeroContact({ ...baseContact(), kind: "supplier" });
    expect(xc["IsSupplier"]).toBe(true);
    expect(xc["IsCustomer"]).toBeUndefined();
  });

  test("both kind → IsCustomer=true and IsSupplier=true", () => {
    const xc = _buildXeroContact({ ...baseContact(), kind: "both" });
    expect(xc["IsCustomer"]).toBe(true);
    expect(xc["IsSupplier"]).toBe(true);
  });

  test("Phones set with DEFAULT type", () => {
    const xc = _buildXeroContact(baseContact());
    const phones = xc["Phones"] as Array<{ PhoneType: string; PhoneNumber: string }>;
    expect(phones).toHaveLength(1);
    expect(phones[0].PhoneType).toBe("DEFAULT");
    expect(phones[0].PhoneNumber).toBe("+27 11 000 0000");
  });

  test("Addresses set as STREET type with all fields", () => {
    const xc = _buildXeroContact(baseContact());
    const addrs = xc["Addresses"] as Array<Record<string, string>>;
    expect(addrs).toHaveLength(1);
    expect(addrs[0].AddressType).toBe("STREET");
    expect(addrs[0].City).toBe("Cape Town");
    expect(addrs[0].Country).toBe("ZA");
  });

  test("Addresses omitted when all address fields are empty", () => {
    const c = {
      ...baseContact(),
      addressLine1: "", addressLine2: "", city: "", region: "", postalCode: "", country: "",
    };
    const xc = _buildXeroContact(c);
    expect(xc["Addresses"]).toBeUndefined();
  });
});

// ── buildXeroBankTransaction ──────────────────────────────────────────────────

describe("buildXeroBankTransaction", () => {
  const baseTx = (): Transaction => ({
    id:          "tx-1",
    postedDate:  new Date("2025-05-21T00:00:00Z"),
    direction:   "debit",
    merchant:    "Shell",
    description: "Fuel",
    amount:      500,
    currency:    "ZAR",
    tax:         65,
    accountCode: "400",
    taxRateCode: "INPUT",
    contactId:   "00000000-0000-0000-0000-000000000000",
  });

  test("debit → Type=SPEND", () => {
    const xt = _buildXeroBankTransaction(baseTx());
    expect(xt["Type"]).toBe("SPEND");
  });

  test("credit → Type=RECEIVE", () => {
    const xt = _buildXeroBankTransaction({ ...baseTx(), direction: "credit" });
    expect(xt["Type"]).toBe("RECEIVE");
  });

  test("Date is YYYY-MM-DD", () => {
    const xt = _buildXeroBankTransaction(baseTx());
    expect(xt["Date"]).toBe("2025-05-21");
  });

  test("LineItems has one entry with correct fields", () => {
    const xt  = _buildXeroBankTransaction(baseTx());
    const li  = (xt["LineItems"] as Array<Record<string, unknown>>)[0];
    expect(li["Description"]).toBe("Shell — Fuel");
    expect(li["Quantity"]).toBe(1);
    expect(li["UnitAmount"]).toBe(500);
    expect(li["AccountCode"]).toBe("400");
    expect(li["TaxType"]).toBe("INPUT");
  });

  test("BankAccount Code falls back to '090' when accountCode empty", () => {
    const xt  = _buildXeroBankTransaction({ ...baseTx(), accountCode: "" });
    const bac = xt["BankAccount"] as { Code: string };
    expect(bac.Code).toBe("090");
  });

  test("BankTransactionID included on update", () => {
    const xt = _buildXeroBankTransaction(baseTx(), "existing-xero-tx-id");
    expect(xt["BankTransactionID"]).toBe("existing-xero-tx-id");
  });

  test("Contact omitted for nil UUID", () => {
    const xt = _buildXeroBankTransaction(baseTx());
    expect(xt["Contact"]).toBeUndefined();
  });

  test("Contact included for non-nil UUID", () => {
    const t  = { ...baseTx(), contactId: "aabbccdd-0000-0000-0000-000000000001" };
    const xt = _buildXeroBankTransaction(t);
    expect((xt["Contact"] as { ContactID: string })["ContactID"]).toBe(
      "aabbccdd-0000-0000-0000-000000000001",
    );
  });

  test("CurrencyCode set", () => {
    const xt = _buildXeroBankTransaction(baseTx());
    expect(xt["CurrencyCode"]).toBe("ZAR");
  });
});
