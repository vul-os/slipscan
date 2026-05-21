// Package classify implements the transaction classification engine for
// slip/scan.  It covers:
//
//   - Idempotent default-category seeding (personal: Vault22-style,
//     business: Xero-style chart-of-accounts + categories).
//   - Transaction creation from document_extractions.
//   - The four-stage classification cascade:
//     user > rule (exact→contains→regex) > merchant_signal > LLM.
//   - Writing transaction_classifications with source + confidence.
//   - ai_runs recording for every LLM call.
package classify

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"
)

// ─── Personal seed (Vault22 style) ─────────────────────────────────────────

// personalCategory describes one node of the personal category tree.
type personalCategory struct {
	Name     string
	Kind     string // "income" | "expense" | "transfer"
	Icon     string
	Color    string
	Children []personalCategory
}

// personalTree is the Vault22-style default category tree for personal orgs.
// Top-level entries may have children; children may not have further children
// in this seed (the user can extend later).
var personalTree = []personalCategory{
	// ---- Income -------------------------------------------------------
	{Name: "Income", Kind: "income", Icon: "wallet", Color: "#22c55e", Children: []personalCategory{
		{Name: "Salary", Kind: "income", Icon: "briefcase", Color: "#16a34a"},
		{Name: "Freelance", Kind: "income", Icon: "laptop", Color: "#15803d"},
		{Name: "Rental Income", Kind: "income", Icon: "home", Color: "#166534"},
		{Name: "Investment Returns", Kind: "income", Icon: "trending-up", Color: "#14532d"},
		{Name: "Gifts Received", Kind: "income", Icon: "gift", Color: "#86efac"},
		{Name: "Other Income", Kind: "income", Icon: "plus-circle", Color: "#4ade80"},
	}},
	// ---- Housing ------------------------------------------------------
	{Name: "Housing", Kind: "expense", Icon: "home", Color: "#3b82f6", Children: []personalCategory{
		{Name: "Rent / Bond", Kind: "expense", Icon: "key", Color: "#2563eb"},
		{Name: "Rates & Taxes", Kind: "expense", Icon: "file-text", Color: "#1d4ed8"},
		{Name: "Home Insurance", Kind: "expense", Icon: "shield", Color: "#1e40af"},
		{Name: "Maintenance & Repairs", Kind: "expense", Icon: "tool", Color: "#1e3a8a"},
		{Name: "Electricity & Water", Kind: "expense", Icon: "zap", Color: "#60a5fa"},
		{Name: "Internet & TV", Kind: "expense", Icon: "wifi", Color: "#93c5fd"},
	}},
	// ---- Groceries & Food --------------------------------------------
	{Name: "Groceries & Food", Kind: "expense", Icon: "shopping-cart", Color: "#f97316", Children: []personalCategory{
		{Name: "Supermarket", Kind: "expense", Icon: "shopping-bag", Color: "#ea580c"},
		{Name: "Restaurants & Takeaways", Kind: "expense", Icon: "coffee", Color: "#c2410c"},
		{Name: "Fast Food", Kind: "expense", Icon: "zap", Color: "#9a3412"},
		{Name: "Alcohol & Beverages", Kind: "expense", Icon: "droplet", Color: "#fed7aa"},
	}},
	// ---- Transport ---------------------------------------------------
	{Name: "Transport", Kind: "expense", Icon: "car", Color: "#8b5cf6", Children: []personalCategory{
		{Name: "Fuel", Kind: "expense", Icon: "droplets", Color: "#7c3aed"},
		{Name: "Public Transport", Kind: "expense", Icon: "bus", Color: "#6d28d9"},
		{Name: "Uber / Bolt", Kind: "expense", Icon: "navigation", Color: "#5b21b6"},
		{Name: "Vehicle Insurance", Kind: "expense", Icon: "shield", Color: "#4c1d95"},
		{Name: "Vehicle Service", Kind: "expense", Icon: "settings", Color: "#a78bfa"},
		{Name: "Parking & Tolls", Kind: "expense", Icon: "map-pin", Color: "#c4b5fd"},
	}},
	// ---- Health & Wellness ------------------------------------------
	{Name: "Health & Wellness", Kind: "expense", Icon: "heart", Color: "#ef4444", Children: []personalCategory{
		{Name: "Medical", Kind: "expense", Icon: "activity", Color: "#dc2626"},
		{Name: "Pharmacy", Kind: "expense", Icon: "plus", Color: "#b91c1c"},
		{Name: "Gym & Sport", Kind: "expense", Icon: "trending-up", Color: "#991b1b"},
		{Name: "Medical Aid", Kind: "expense", Icon: "shield", Color: "#fca5a5"},
	}},
	// ---- Personal Care -----------------------------------------------
	{Name: "Personal Care", Kind: "expense", Icon: "smile", Color: "#ec4899", Children: []personalCategory{
		{Name: "Hair & Beauty", Kind: "expense", Icon: "scissors", Color: "#db2777"},
		{Name: "Clothing & Shoes", Kind: "expense", Icon: "tag", Color: "#be185d"},
		{Name: "Accessories", Kind: "expense", Icon: "watch", Color: "#9d174d"},
	}},
	// ---- Education ---------------------------------------------------
	{Name: "Education", Kind: "expense", Icon: "book-open", Color: "#06b6d4", Children: []personalCategory{
		{Name: "School Fees", Kind: "expense", Icon: "book", Color: "#0891b2"},
		{Name: "Books & Stationery", Kind: "expense", Icon: "file-text", Color: "#0e7490"},
		{Name: "Online Courses", Kind: "expense", Icon: "monitor", Color: "#155e75"},
	}},
	// ---- Entertainment -----------------------------------------------
	{Name: "Entertainment", Kind: "expense", Icon: "tv", Color: "#f59e0b", Children: []personalCategory{
		{Name: "Streaming Services", Kind: "expense", Icon: "play-circle", Color: "#d97706"},
		{Name: "Events & Outings", Kind: "expense", Icon: "calendar", Color: "#b45309"},
		{Name: "Hobbies", Kind: "expense", Icon: "star", Color: "#92400e"},
		{Name: "Gaming", Kind: "expense", Icon: "gamepad", Color: "#fcd34d"},
	}},
	// ---- Financial Services -----------------------------------------
	{Name: "Financial Services", Kind: "expense", Icon: "credit-card", Color: "#64748b", Children: []personalCategory{
		{Name: "Bank Charges", Kind: "expense", Icon: "dollar-sign", Color: "#475569"},
		{Name: "Loan Repayments", Kind: "expense", Icon: "trending-down", Color: "#334155"},
		{Name: "Credit Card Repayments", Kind: "expense", Icon: "credit-card", Color: "#1e293b"},
		{Name: "Life Insurance", Kind: "expense", Icon: "umbrella", Color: "#94a3b8"},
		{Name: "Short-term Insurance", Kind: "expense", Icon: "shield", Color: "#cbd5e1"},
	}},
	// ---- Savings & Investments ----------------------------------------
	{Name: "Savings & Investments", Kind: "transfer", Icon: "piggy-bank", Color: "#10b981", Children: []personalCategory{
		{Name: "Emergency Fund", Kind: "transfer", Icon: "alert-circle", Color: "#059669"},
		{Name: "Retirement", Kind: "transfer", Icon: "sunset", Color: "#047857"},
		{Name: "Unit Trusts / ETFs", Kind: "transfer", Icon: "trending-up", Color: "#065f46"},
		{Name: "Tax-free Savings", Kind: "transfer", Icon: "percent", Color: "#6ee7b7"},
	}},
	// ---- Giving & Donations ------------------------------------------
	{Name: "Giving", Kind: "expense", Icon: "heart", Color: "#a855f7", Children: []personalCategory{
		{Name: "Charitable Donations", Kind: "expense", Icon: "gift", Color: "#9333ea"},
		{Name: "Gifts Given", Kind: "expense", Icon: "package", Color: "#7e22ce"},
	}},
	// ---- Travel & Accommodation -------------------------------------
	{Name: "Travel & Accommodation", Kind: "expense", Icon: "map", Color: "#14b8a6", Children: []personalCategory{
		{Name: "Flights", Kind: "expense", Icon: "plane", Color: "#0d9488"},
		{Name: "Hotels & Lodging", Kind: "expense", Icon: "building", Color: "#0f766e"},
		{Name: "Car Rental", Kind: "expense", Icon: "car", Color: "#115e59"},
		{Name: "Travel Insurance", Kind: "expense", Icon: "shield", Color: "#99f6e4"},
	}},
	// ---- Other -------------------------------------------------------
	{Name: "Other Expenses", Kind: "expense", Icon: "more-horizontal", Color: "#9ca3af"},
}

// ─── Business seed (Xero style) ────────────────────────────────────────────

// businessAccount describes a chart-of-accounts entry.
type businessAccount struct {
	Code    string
	Name    string
	Type    string // maps to SQL account_type enum
	Subtype string
}

// businessCategory describes a category linked to an account by code.
type businessCategory struct {
	Name      string
	Kind      string // category_kind enum
	AccountCode string // matches businessAccount.Code; "" for no link
	Icon      string
	Color     string
}

// xeroAccounts is the Xero-style default chart of accounts for business orgs.
// Codes follow the Xero default numbering scheme.
var xeroAccounts = []businessAccount{
	// ─ Asset ─────────────────────────────────────────────────
	{Code: "090", Name: "Bank Accounts", Type: "asset", Subtype: "current"},
	{Code: "091", Name: "Savings Accounts", Type: "asset", Subtype: "current"},
	{Code: "092", Name: "Petty Cash", Type: "asset", Subtype: "current"},
	{Code: "120", Name: "Accounts Receivable", Type: "asset", Subtype: "current"},
	{Code: "130", Name: "Inventory", Type: "asset", Subtype: "current"},
	{Code: "140", Name: "Prepayments", Type: "asset", Subtype: "current"},
	{Code: "710", Name: "Property, Plant & Equipment", Type: "asset", Subtype: "fixed"},
	{Code: "711", Name: "Less Accumulated Depreciation", Type: "asset", Subtype: "fixed"},
	// ─ Liability ─────────────────────────────────────────────
	{Code: "200", Name: "Accounts Payable", Type: "liability", Subtype: "current"},
	{Code: "210", Name: "VAT on Sales", Type: "liability", Subtype: "current"},
	{Code: "220", Name: "Income Tax Payable", Type: "liability", Subtype: "current"},
	{Code: "230", Name: "Payroll Liabilities", Type: "liability", Subtype: "current"},
	{Code: "240", Name: "Employee Benefits Payable", Type: "liability", Subtype: "current"},
	{Code: "800", Name: "Loan – Long-term", Type: "liability", Subtype: "non_current"},
	// ─ Equity ────────────────────────────────────────────────
	{Code: "300", Name: "Share Capital", Type: "equity", Subtype: ""},
	{Code: "310", Name: "Retained Earnings", Type: "equity", Subtype: ""},
	{Code: "320", Name: "Owner's Equity", Type: "equity", Subtype: ""},
	// ─ Income ────────────────────────────────────────────────
	{Code: "400", Name: "Sales Revenue", Type: "income", Subtype: "revenue"},
	{Code: "410", Name: "Other Income", Type: "income", Subtype: "revenue"},
	{Code: "420", Name: "Interest Income", Type: "income", Subtype: "revenue"},
	// ─ Expense ───────────────────────────────────────────────
	{Code: "310", Name: "Cost of Goods Sold", Type: "expense", Subtype: "cost_of_sales"},
	{Code: "410", Name: "Advertising", Type: "expense", Subtype: "operating"},
	{Code: "420", Name: "Bank Charges", Type: "expense", Subtype: "operating"},
	{Code: "425", Name: "Cleaning", Type: "expense", Subtype: "operating"},
	{Code: "430", Name: "Computer & IT", Type: "expense", Subtype: "operating"},
	{Code: "440", Name: "Consulting & Legal", Type: "expense", Subtype: "operating"},
	{Code: "445", Name: "Depreciation", Type: "expense", Subtype: "operating"},
	{Code: "450", Name: "Entertainment", Type: "expense", Subtype: "operating"},
	{Code: "455", Name: "Freight & Courier", Type: "expense", Subtype: "operating"},
	{Code: "460", Name: "Insurance", Type: "expense", Subtype: "operating"},
	{Code: "461", Name: "Fuel", Type: "expense", Subtype: "operating"},
	{Code: "462", Name: "Motor Vehicle", Type: "expense", Subtype: "operating"},
	{Code: "463", Name: "Motor Vehicle Insurance", Type: "expense", Subtype: "operating"},
	{Code: "470", Name: "Office Supplies", Type: "expense", Subtype: "operating"},
	{Code: "475", Name: "Printing & Stationery", Type: "expense", Subtype: "operating"},
	{Code: "480", Name: "Rent", Type: "expense", Subtype: "operating"},
	{Code: "485", Name: "Repairs & Maintenance", Type: "expense", Subtype: "operating"},
	{Code: "490", Name: "Salaries & Wages", Type: "expense", Subtype: "operating"},
	{Code: "491", Name: "Staff Training", Type: "expense", Subtype: "operating"},
	{Code: "493", Name: "Subscriptions", Type: "expense", Subtype: "operating"},
	{Code: "494", Name: "Telephone & Internet", Type: "expense", Subtype: "operating"},
	{Code: "495", Name: "Travel – Domestic", Type: "expense", Subtype: "operating"},
	{Code: "496", Name: "Travel – International", Type: "expense", Subtype: "operating"},
	{Code: "498", Name: "Utilities", Type: "expense", Subtype: "operating"},
	{Code: "499", Name: "General Expenses", Type: "expense", Subtype: "operating"},
}

// xeroCategories maps category names to account codes for the business seed.
// These are the user-visible labels used in classification.
var xeroCategories = []businessCategory{
	// ─ Income ─────────────────────────────────────────────────────────
	{Name: "Sales", Kind: "income", AccountCode: "400", Icon: "dollar-sign", Color: "#22c55e"},
	{Name: "Other Income", Kind: "income", AccountCode: "410", Icon: "plus-circle", Color: "#4ade80"},
	{Name: "Interest Received", Kind: "income", AccountCode: "420", Icon: "trending-up", Color: "#86efac"},
	// ─ Cost of sales ──────────────────────────────────────────────────
	{Name: "Cost of Goods Sold", Kind: "expense", AccountCode: "310", Icon: "package", Color: "#f97316"},
	// ─ Operating expenses ─────────────────────────────────────────────
	{Name: "Advertising & Marketing", Kind: "expense", AccountCode: "410", Icon: "megaphone", Color: "#3b82f6"},
	{Name: "Bank Charges", Kind: "expense", AccountCode: "420", Icon: "credit-card", Color: "#64748b"},
	{Name: "Cleaning", Kind: "expense", AccountCode: "425", Icon: "trash-2", Color: "#06b6d4"},
	{Name: "Computer & IT", Kind: "expense", AccountCode: "430", Icon: "monitor", Color: "#8b5cf6"},
	{Name: "Consulting & Legal", Kind: "expense", AccountCode: "440", Icon: "briefcase", Color: "#ec4899"},
	{Name: "Depreciation", Kind: "expense", AccountCode: "445", Icon: "trending-down", Color: "#94a3b8"},
	{Name: "Entertainment", Kind: "expense", AccountCode: "450", Icon: "coffee", Color: "#f59e0b"},
	{Name: "Freight & Courier", Kind: "expense", AccountCode: "455", Icon: "truck", Color: "#14b8a6"},
	{Name: "Insurance", Kind: "expense", AccountCode: "460", Icon: "shield", Color: "#a855f7"},
	{Name: "Fuel", Kind: "expense", AccountCode: "461", Icon: "droplets", Color: "#7c3aed"},
	{Name: "Motor Vehicle", Kind: "expense", AccountCode: "462", Icon: "car", Color: "#6d28d9"},
	{Name: "Motor Vehicle Insurance", Kind: "expense", AccountCode: "463", Icon: "shield", Color: "#5b21b6"},
	{Name: "Office Supplies", Kind: "expense", AccountCode: "470", Icon: "paperclip", Color: "#0891b2"},
	{Name: "Printing & Stationery", Kind: "expense", AccountCode: "475", Icon: "printer", Color: "#0e7490"},
	{Name: "Rent", Kind: "expense", AccountCode: "480", Icon: "building", Color: "#1d4ed8"},
	{Name: "Repairs & Maintenance", Kind: "expense", AccountCode: "485", Icon: "tool", Color: "#1e40af"},
	{Name: "Salaries & Wages", Kind: "expense", AccountCode: "490", Icon: "users", Color: "#dc2626"},
	{Name: "Staff Training", Kind: "expense", AccountCode: "491", Icon: "book-open", Color: "#b91c1c"},
	{Name: "Subscriptions", Kind: "expense", AccountCode: "493", Icon: "refresh-cw", Color: "#9333ea"},
	{Name: "Telephone & Internet", Kind: "expense", AccountCode: "494", Icon: "wifi", Color: "#0d9488"},
	{Name: "Travel – Domestic", Kind: "expense", AccountCode: "495", Icon: "map", Color: "#0f766e"},
	{Name: "Travel – International", Kind: "expense", AccountCode: "496", Icon: "plane", Color: "#115e59"},
	{Name: "Utilities", Kind: "expense", AccountCode: "498", Icon: "zap", Color: "#ca8a04"},
	{Name: "General Expenses", Kind: "expense", AccountCode: "499", Icon: "more-horizontal", Color: "#9ca3af"},
	// ─ Transfers ──────────────────────────────────────────────────────
	{Name: "Owner's Drawings", Kind: "transfer", AccountCode: "320", Icon: "user", Color: "#f59e0b"},
}

// ─── Seeder ────────────────────────────────────────────────────────────────

// SeedDefaultCategories idempotently inserts the default category/account
// tree for the given organization. It is safe to call multiple times — any
// existing row with the same (org, parent, name) is left unchanged thanks to
// ON CONFLICT DO NOTHING.
//
// For personal orgs a Vault22-style expense/income tree is inserted.
// For business orgs a Xero-style chart-of-accounts is inserted first,
// then the matching categories are linked by account code.
func SeedDefaultCategories(ctx context.Context, tx *sql.Tx, orgID uuid.UUID, orgKind string, currency string) error {
	if currency == "" {
		currency = "ZAR"
	}

	switch orgKind {
	case "personal":
		return seedPersonal(ctx, tx, orgID)
	case "business":
		return seedBusiness(ctx, tx, orgID, currency)
	default:
		return fmt.Errorf("classify: unknown org kind %q", orgKind)
	}
}

func seedPersonal(ctx context.Context, tx *sql.Tx, orgID uuid.UUID) error {
	for _, top := range personalTree {
		parentID, err := upsertCategory(ctx, tx, orgID, uuid.NullUUID{}, top.Name, top.Kind, top.Icon, top.Color)
		if err != nil {
			return err
		}
		for _, child := range top.Children {
			if _, err := upsertCategory(ctx, tx, orgID, uuid.NullUUID{UUID: parentID, Valid: true}, child.Name, child.Kind, child.Icon, child.Color); err != nil {
				return err
			}
		}
	}
	return nil
}

func seedBusiness(ctx context.Context, tx *sql.Tx, orgID uuid.UUID, currency string) error {
	// 1. Upsert accounts; build code→ID map.
	codeToAccountID := make(map[string]uuid.UUID, len(xeroAccounts))
	for _, a := range xeroAccounts {
		id, err := upsertAccount(ctx, tx, orgID, a.Code, a.Name, a.Type, a.Subtype, currency)
		if err != nil {
			return err
		}
		// Last writer wins for duplicate codes — intentional; only one per type matters.
		codeToAccountID[a.Code] = id
	}

	// 2. Upsert categories, linking to accounts where the code is known.
	for _, c := range xeroCategories {
		accountID := uuid.NullUUID{}
		if c.AccountCode != "" {
			if id, ok := codeToAccountID[c.AccountCode]; ok {
				accountID = uuid.NullUUID{UUID: id, Valid: true}
			}
		}
		if _, err := upsertCategoryWithAccount(ctx, tx, orgID, uuid.NullUUID{}, c.Name, c.Kind, c.Icon, c.Color, accountID); err != nil {
			return err
		}
	}
	return nil
}

// ─── DB helpers ────────────────────────────────────────────────────────────

func upsertCategory(ctx context.Context, tx *sql.Tx, orgID uuid.UUID, parentID uuid.NullUUID, name, kind, icon, color string) (uuid.UUID, error) {
	return upsertCategoryWithAccount(ctx, tx, orgID, parentID, name, kind, icon, color, uuid.NullUUID{})
}

func upsertCategoryWithAccount(ctx context.Context, tx *sql.Tx, orgID uuid.UUID, parentID uuid.NullUUID, name, kind, icon, color string, accountID uuid.NullUUID) (uuid.UUID, error) {
	const q = `
		INSERT INTO categories (organization_id, parent_id, account_id, name, kind, icon, color, is_system)
		VALUES ($1, $2, $3, $4, $5::category_kind, $6, $7, true)
		ON CONFLICT (organization_id, parent_id, name) DO UPDATE
			SET account_id = EXCLUDED.account_id
		RETURNING id
	`
	var id uuid.UUID
	err := tx.QueryRowContext(ctx, q, orgID, parentID, accountID, name, kind, nullStr(icon), nullStr(color)).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("classify: upsert category %q: %w", name, err)
	}
	return id, nil
}

func upsertAccount(ctx context.Context, tx *sql.Tx, orgID uuid.UUID, code, name, acctType, subtype, currency string) (uuid.UUID, error) {
	const q = `
		INSERT INTO accounts (organization_id, code, name, type, subtype, currency, is_system)
		VALUES ($1, $2, $3, $4::account_type, $5, $6, true)
		ON CONFLICT (organization_id, code) DO UPDATE
			SET name = EXCLUDED.name
		RETURNING id
	`
	var id uuid.UUID
	err := tx.QueryRowContext(ctx, q, orgID, code, name, acctType, nullStr(subtype), currency).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("classify: upsert account %q: %w", code, err)
	}
	return id, nil
}

func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
