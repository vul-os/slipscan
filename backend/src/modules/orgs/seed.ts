/**
 * Default category + account seeder — ported from Go internal/classify/seed.go.
 * Called inside the org-creation transaction (withOrg) so failures roll back
 * the whole org creation. Safe to call multiple times (ON CONFLICT DO NOTHING /
 * DO UPDATE — idempotent).
 */
import type { Query } from "../../db/client";

// ─── Personal seed (Vault22 style) ─────────────────────────────────────────

interface PersonalCategory {
  name: string;
  kind: string; // "income" | "expense" | "transfer"
  icon: string;
  color: string;
  children?: PersonalCategory[];
}

const personalTree: PersonalCategory[] = [
  // ---- Income -------------------------------------------------------
  {
    name: "Income", kind: "income", icon: "wallet", color: "#22c55e",
    children: [
      { name: "Salary", kind: "income", icon: "briefcase", color: "#16a34a" },
      { name: "Freelance", kind: "income", icon: "laptop", color: "#15803d" },
      { name: "Rental Income", kind: "income", icon: "home", color: "#166534" },
      { name: "Investment Returns", kind: "income", icon: "trending-up", color: "#14532d" },
      { name: "Gifts Received", kind: "income", icon: "gift", color: "#86efac" },
      { name: "Other Income", kind: "income", icon: "plus-circle", color: "#4ade80" },
    ],
  },
  // ---- Housing ------------------------------------------------------
  {
    name: "Housing", kind: "expense", icon: "home", color: "#3b82f6",
    children: [
      { name: "Rent / Bond", kind: "expense", icon: "key", color: "#2563eb" },
      { name: "Rates & Taxes", kind: "expense", icon: "file-text", color: "#1d4ed8" },
      { name: "Home Insurance", kind: "expense", icon: "shield", color: "#1e40af" },
      { name: "Maintenance & Repairs", kind: "expense", icon: "tool", color: "#1e3a8a" },
      { name: "Electricity & Water", kind: "expense", icon: "zap", color: "#60a5fa" },
      { name: "Internet & TV", kind: "expense", icon: "wifi", color: "#93c5fd" },
    ],
  },
  // ---- Groceries & Food --------------------------------------------
  {
    name: "Groceries & Food", kind: "expense", icon: "shopping-cart", color: "#f97316",
    children: [
      { name: "Supermarket", kind: "expense", icon: "shopping-bag", color: "#ea580c" },
      { name: "Restaurants & Takeaways", kind: "expense", icon: "coffee", color: "#c2410c" },
      { name: "Fast Food", kind: "expense", icon: "zap", color: "#9a3412" },
      { name: "Alcohol & Beverages", kind: "expense", icon: "droplet", color: "#fed7aa" },
    ],
  },
  // ---- Transport ---------------------------------------------------
  {
    name: "Transport", kind: "expense", icon: "car", color: "#8b5cf6",
    children: [
      { name: "Fuel", kind: "expense", icon: "droplets", color: "#7c3aed" },
      { name: "Public Transport", kind: "expense", icon: "bus", color: "#6d28d9" },
      { name: "Uber / Bolt", kind: "expense", icon: "navigation", color: "#5b21b6" },
      { name: "Vehicle Insurance", kind: "expense", icon: "shield", color: "#4c1d95" },
      { name: "Vehicle Service", kind: "expense", icon: "settings", color: "#a78bfa" },
      { name: "Parking & Tolls", kind: "expense", icon: "map-pin", color: "#c4b5fd" },
    ],
  },
  // ---- Health & Wellness ------------------------------------------
  {
    name: "Health & Wellness", kind: "expense", icon: "heart", color: "#ef4444",
    children: [
      { name: "Medical", kind: "expense", icon: "activity", color: "#dc2626" },
      { name: "Pharmacy", kind: "expense", icon: "plus", color: "#b91c1c" },
      { name: "Gym & Sport", kind: "expense", icon: "trending-up", color: "#991b1b" },
      { name: "Medical Aid", kind: "expense", icon: "shield", color: "#fca5a5" },
    ],
  },
  // ---- Personal Care -----------------------------------------------
  {
    name: "Personal Care", kind: "expense", icon: "smile", color: "#ec4899",
    children: [
      { name: "Hair & Beauty", kind: "expense", icon: "scissors", color: "#db2777" },
      { name: "Clothing & Shoes", kind: "expense", icon: "tag", color: "#be185d" },
      { name: "Accessories", kind: "expense", icon: "watch", color: "#9d174d" },
    ],
  },
  // ---- Education ---------------------------------------------------
  {
    name: "Education", kind: "expense", icon: "book-open", color: "#06b6d4",
    children: [
      { name: "School Fees", kind: "expense", icon: "book", color: "#0891b2" },
      { name: "Books & Stationery", kind: "expense", icon: "file-text", color: "#0e7490" },
      { name: "Online Courses", kind: "expense", icon: "monitor", color: "#155e75" },
    ],
  },
  // ---- Entertainment -----------------------------------------------
  {
    name: "Entertainment", kind: "expense", icon: "tv", color: "#f59e0b",
    children: [
      { name: "Streaming Services", kind: "expense", icon: "play-circle", color: "#d97706" },
      { name: "Events & Outings", kind: "expense", icon: "calendar", color: "#b45309" },
      { name: "Hobbies", kind: "expense", icon: "star", color: "#92400e" },
      { name: "Gaming", kind: "expense", icon: "gamepad", color: "#fcd34d" },
    ],
  },
  // ---- Financial Services -----------------------------------------
  {
    name: "Financial Services", kind: "expense", icon: "credit-card", color: "#64748b",
    children: [
      { name: "Bank Charges", kind: "expense", icon: "dollar-sign", color: "#475569" },
      { name: "Loan Repayments", kind: "expense", icon: "trending-down", color: "#334155" },
      { name: "Credit Card Repayments", kind: "expense", icon: "credit-card", color: "#1e293b" },
      { name: "Life Insurance", kind: "expense", icon: "umbrella", color: "#94a3b8" },
      { name: "Short-term Insurance", kind: "expense", icon: "shield", color: "#cbd5e1" },
    ],
  },
  // ---- Savings & Investments ----------------------------------------
  {
    name: "Savings & Investments", kind: "transfer", icon: "piggy-bank", color: "#10b981",
    children: [
      { name: "Emergency Fund", kind: "transfer", icon: "alert-circle", color: "#059669" },
      { name: "Retirement", kind: "transfer", icon: "sunset", color: "#047857" },
      { name: "Unit Trusts / ETFs", kind: "transfer", icon: "trending-up", color: "#065f46" },
      { name: "Tax-free Savings", kind: "transfer", icon: "percent", color: "#6ee7b7" },
    ],
  },
  // ---- Giving & Donations ------------------------------------------
  {
    name: "Giving", kind: "expense", icon: "heart", color: "#a855f7",
    children: [
      { name: "Charitable Donations", kind: "expense", icon: "gift", color: "#9333ea" },
      { name: "Gifts Given", kind: "expense", icon: "package", color: "#7e22ce" },
    ],
  },
  // ---- Travel & Accommodation -------------------------------------
  {
    name: "Travel & Accommodation", kind: "expense", icon: "map", color: "#14b8a6",
    children: [
      { name: "Flights", kind: "expense", icon: "plane", color: "#0d9488" },
      { name: "Hotels & Lodging", kind: "expense", icon: "building", color: "#0f766e" },
      { name: "Car Rental", kind: "expense", icon: "car", color: "#115e59" },
      { name: "Travel Insurance", kind: "expense", icon: "shield", color: "#99f6e4" },
    ],
  },
  // ---- Other -------------------------------------------------------
  { name: "Other Expenses", kind: "expense", icon: "more-horizontal", color: "#9ca3af" },
];

// ─── Business seed (Xero style) ────────────────────────────────────────────

interface BusinessAccount {
  code: string;
  name: string;
  type: string; // account_type enum
  subtype: string;
}

interface BusinessCategory {
  name: string;
  kind: string; // category_kind enum
  accountCode: string; // "" for no link
  icon: string;
  color: string;
}

const xeroAccounts: BusinessAccount[] = [
  // ─ Asset ─────────────────────────────────────────────
  { code: "090", name: "Bank Accounts", type: "asset", subtype: "current" },
  { code: "091", name: "Savings Accounts", type: "asset", subtype: "current" },
  { code: "092", name: "Petty Cash", type: "asset", subtype: "current" },
  { code: "120", name: "Accounts Receivable", type: "asset", subtype: "current" },
  { code: "130", name: "Inventory", type: "asset", subtype: "current" },
  { code: "140", name: "Prepayments", type: "asset", subtype: "current" },
  { code: "710", name: "Property, Plant & Equipment", type: "asset", subtype: "fixed" },
  { code: "711", name: "Less Accumulated Depreciation", type: "asset", subtype: "fixed" },
  // ─ Liability ─────────────────────────────────────────
  { code: "200", name: "Accounts Payable", type: "liability", subtype: "current" },
  { code: "210", name: "VAT on Sales", type: "liability", subtype: "current" },
  { code: "220", name: "Income Tax Payable", type: "liability", subtype: "current" },
  { code: "230", name: "Payroll Liabilities", type: "liability", subtype: "current" },
  { code: "240", name: "Employee Benefits Payable", type: "liability", subtype: "current" },
  { code: "800", name: "Loan – Long-term", type: "liability", subtype: "non_current" },
  // ─ Equity ────────────────────────────────────────────
  { code: "300", name: "Share Capital", type: "equity", subtype: "" },
  { code: "310", name: "Retained Earnings", type: "equity", subtype: "" },
  { code: "320", name: "Owner's Equity", type: "equity", subtype: "" },
  // ─ Income ────────────────────────────────────────────
  { code: "400", name: "Sales Revenue", type: "income", subtype: "revenue" },
  { code: "410", name: "Other Income", type: "income", subtype: "revenue" },
  { code: "420", name: "Interest Income", type: "income", subtype: "revenue" },
  // ─ Expense ───────────────────────────────────────────
  // Note: Go source has code "310" for COGS (duplicate with Retained Earnings).
  // Last writer wins for duplicate codes in code→id map (intentional per Go comment).
  { code: "310", name: "Cost of Goods Sold", type: "expense", subtype: "cost_of_sales" },
  { code: "410", name: "Advertising", type: "expense", subtype: "operating" },
  { code: "420", name: "Bank Charges", type: "expense", subtype: "operating" },
  { code: "425", name: "Cleaning", type: "expense", subtype: "operating" },
  { code: "430", name: "Computer & IT", type: "expense", subtype: "operating" },
  { code: "440", name: "Consulting & Legal", type: "expense", subtype: "operating" },
  { code: "445", name: "Depreciation", type: "expense", subtype: "operating" },
  { code: "450", name: "Entertainment", type: "expense", subtype: "operating" },
  { code: "455", name: "Freight & Courier", type: "expense", subtype: "operating" },
  { code: "460", name: "Insurance", type: "expense", subtype: "operating" },
  { code: "461", name: "Fuel", type: "expense", subtype: "operating" },
  { code: "462", name: "Motor Vehicle", type: "expense", subtype: "operating" },
  { code: "463", name: "Motor Vehicle Insurance", type: "expense", subtype: "operating" },
  { code: "470", name: "Office Supplies", type: "expense", subtype: "operating" },
  { code: "475", name: "Printing & Stationery", type: "expense", subtype: "operating" },
  { code: "480", name: "Rent", type: "expense", subtype: "operating" },
  { code: "485", name: "Repairs & Maintenance", type: "expense", subtype: "operating" },
  { code: "490", name: "Salaries & Wages", type: "expense", subtype: "operating" },
  { code: "491", name: "Staff Training", type: "expense", subtype: "operating" },
  { code: "493", name: "Subscriptions", type: "expense", subtype: "operating" },
  { code: "494", name: "Telephone & Internet", type: "expense", subtype: "operating" },
  { code: "495", name: "Travel – Domestic", type: "expense", subtype: "operating" },
  { code: "496", name: "Travel – International", type: "expense", subtype: "operating" },
  { code: "498", name: "Utilities", type: "expense", subtype: "operating" },
  { code: "499", name: "General Expenses", type: "expense", subtype: "operating" },
];

const xeroCategories: BusinessCategory[] = [
  // ─ Income ─────────────────────────────────────────────────────────
  { name: "Sales", kind: "income", accountCode: "400", icon: "dollar-sign", color: "#22c55e" },
  { name: "Other Income", kind: "income", accountCode: "410", icon: "plus-circle", color: "#4ade80" },
  { name: "Interest Received", kind: "income", accountCode: "420", icon: "trending-up", color: "#86efac" },
  // ─ Cost of sales ──────────────────────────────────────────────────
  { name: "Cost of Goods Sold", kind: "expense", accountCode: "310", icon: "package", color: "#f97316" },
  // ─ Operating expenses ─────────────────────────────────────────────
  { name: "Advertising & Marketing", kind: "expense", accountCode: "410", icon: "megaphone", color: "#3b82f6" },
  { name: "Bank Charges", kind: "expense", accountCode: "420", icon: "credit-card", color: "#64748b" },
  { name: "Cleaning", kind: "expense", accountCode: "425", icon: "trash-2", color: "#06b6d4" },
  { name: "Computer & IT", kind: "expense", accountCode: "430", icon: "monitor", color: "#8b5cf6" },
  { name: "Consulting & Legal", kind: "expense", accountCode: "440", icon: "briefcase", color: "#ec4899" },
  { name: "Depreciation", kind: "expense", accountCode: "445", icon: "trending-down", color: "#94a3b8" },
  { name: "Entertainment", kind: "expense", accountCode: "450", icon: "coffee", color: "#f59e0b" },
  { name: "Freight & Courier", kind: "expense", accountCode: "455", icon: "truck", color: "#14b8a6" },
  { name: "Insurance", kind: "expense", accountCode: "460", icon: "shield", color: "#a855f7" },
  { name: "Fuel", kind: "expense", accountCode: "461", icon: "droplets", color: "#7c3aed" },
  { name: "Motor Vehicle", kind: "expense", accountCode: "462", icon: "car", color: "#6d28d9" },
  { name: "Motor Vehicle Insurance", kind: "expense", accountCode: "463", icon: "shield", color: "#5b21b6" },
  { name: "Office Supplies", kind: "expense", accountCode: "470", icon: "paperclip", color: "#0891b2" },
  { name: "Printing & Stationery", kind: "expense", accountCode: "475", icon: "printer", color: "#0e7490" },
  { name: "Rent", kind: "expense", accountCode: "480", icon: "building", color: "#1d4ed8" },
  { name: "Repairs & Maintenance", kind: "expense", accountCode: "485", icon: "tool", color: "#1e40af" },
  { name: "Salaries & Wages", kind: "expense", accountCode: "490", icon: "users", color: "#dc2626" },
  { name: "Staff Training", kind: "expense", accountCode: "491", icon: "book-open", color: "#b91c1c" },
  { name: "Subscriptions", kind: "expense", accountCode: "493", icon: "refresh-cw", color: "#9333ea" },
  { name: "Telephone & Internet", kind: "expense", accountCode: "494", icon: "wifi", color: "#0d9488" },
  { name: "Travel – Domestic", kind: "expense", accountCode: "495", icon: "map", color: "#0f766e" },
  { name: "Travel – International", kind: "expense", accountCode: "496", icon: "plane", color: "#115e59" },
  { name: "Utilities", kind: "expense", accountCode: "498", icon: "zap", color: "#ca8a04" },
  { name: "General Expenses", kind: "expense", accountCode: "499", icon: "more-horizontal", color: "#9ca3af" },
  // ─ Transfers ──────────────────────────────────────────────────────
  { name: "Owner's Drawings", kind: "transfer", accountCode: "320", icon: "user", color: "#f59e0b" },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function nullStr(s: string): string | null {
  return s === "" ? null : s;
}

async function upsertCategoryWithAccount(
  q: Query,
  orgId: string,
  parentId: string | null,
  name: string,
  kind: string,
  icon: string,
  color: string,
  accountId: string | null,
): Promise<string> {
  const sql = `
    INSERT INTO categories (organization_id, parent_id, account_id, name, kind, icon, color, is_system)
    VALUES ($1, $2, $3, $4, $5::category_kind, $6, $7, true)
    ON CONFLICT (organization_id, parent_id, name) DO UPDATE
      SET account_id = EXCLUDED.account_id
    RETURNING id
  `;
  const rows = await q(sql, [orgId, parentId, accountId, name, kind, nullStr(icon), nullStr(color)]);
  if (!rows.length) throw new Error(`classify: upsert category "${name}" returned no rows`);
  return rows[0].id as string;
}

async function upsertAccount(
  q: Query,
  orgId: string,
  code: string,
  name: string,
  type: string,
  subtype: string,
  currency: string,
): Promise<string> {
  const sql = `
    INSERT INTO accounts (organization_id, code, name, type, subtype, currency, is_system)
    VALUES ($1, $2, $3, $4::account_type, $5, $6, true)
    ON CONFLICT (organization_id, code) DO UPDATE
      SET name = EXCLUDED.name
    RETURNING id
  `;
  const rows = await q(sql, [orgId, code, name, type, nullStr(subtype), currency]);
  if (!rows.length) throw new Error(`classify: upsert account "${code}" returned no rows`);
  return rows[0].id as string;
}

async function seedPersonal(q: Query, orgId: string): Promise<void> {
  for (const top of personalTree) {
    const parentId = await upsertCategoryWithAccount(
      q, orgId, null, top.name, top.kind, top.icon, top.color, null,
    );
    for (const child of top.children ?? []) {
      await upsertCategoryWithAccount(
        q, orgId, parentId, child.name, child.kind, child.icon, child.color, null,
      );
    }
  }
}

async function seedBusiness(q: Query, orgId: string, currency: string): Promise<void> {
  // 1. Upsert accounts; build code→id map.
  const codeToAccountId = new Map<string, string>();
  for (const a of xeroAccounts) {
    const id = await upsertAccount(q, orgId, a.code, a.name, a.type, a.subtype, currency);
    // Last writer wins for duplicate codes — intentional; mirrors Go behaviour.
    codeToAccountId.set(a.code, id);
  }

  // 2. Upsert categories, linking to accounts where code is known.
  for (const c of xeroCategories) {
    const accountId = c.accountCode ? (codeToAccountId.get(c.accountCode) ?? null) : null;
    await upsertCategoryWithAccount(q, orgId, null, c.name, c.kind, c.icon, c.color, accountId);
  }
}

/**
 * seedDefaultCategories — port of Go classify.SeedDefaultCategories.
 * Must be called with the withOrg query runner so it participates in the
 * org-creation transaction.
 */
export async function seedDefaultCategories(
  q: Query,
  orgId: string,
  orgKind: string,
  currency: string,
): Promise<void> {
  const cur = currency || "ZAR";
  switch (orgKind) {
    case "personal":
      return seedPersonal(q, orgId);
    case "business":
      return seedBusiness(q, orgId, cur);
    default:
      throw new Error(`classify: unknown org kind "${orgKind}"`);
  }
}
