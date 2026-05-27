/**
 * Shared schema types — enums (as string unions) + core identity rows.
 * Source of truth for cross-module types so feature agents don't invent
 * divergent enum spellings. Mirrors the Postgres enums in
 * backend/migrations/*.sql. Domain-specific row types live in each module.
 */

// ---- Enums (mirror Postgres CREATE TYPE … AS ENUM) ----
export type OrganizationKind = "personal" | "business";
export type MembershipRole = "owner" | "admin" | "accountant" | "member" | "viewer";
export type Role = MembershipRole;
export type OAuthProvider = "gmail" | "outlook" | "paystack" | "xero" | "google_drive";
export type ApiTokenKind = "live" | "test" | "restricted";

export type AiModelKind = "ocr" | "extraction" | "classification" | "insights" | "embedding" | "normalization";
export type AiRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AiTargetType = "document" | "inbound_email" | "transaction" | "insights_query" | "organization";

export type DocumentSource = "upload" | "email" | "api";
export type DocumentKind = "slip" | "invoice" | "bank_statement" | "unknown";
export type DocumentStatus = "pending" | "processing" | "extracted" | "failed";
export type InboundEmailStatus = "received" | "processed" | "rejected" | "failed";

export type ChatChannel = "web" | "whatsapp" | "api";
export type ChatStatus = "active" | "archived";
export type ChatMessageRole = "user" | "assistant" | "system" | "tool";
export type QueryKind = "sql" | "aggregate";
export type QueryRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type TransactionStatus = "pending" | "verified" | "rejected";
export type TransactionDirection = "debit" | "credit" | "transfer";
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type CategoryKind = "income" | "expense" | "transfer";
export type ClassificationMatchType = "merchant_exact" | "merchant_contains" | "merchant_regex";
export type ClassificationSource = "user" | "rule" | "llm" | "merchant_signal" | "system";
export type LedgerSourceType = "transaction" | "manual_journal" | "opening_balance" | "invoice" | "bill" | "transfer";

export type InvoiceStatus = "draft" | "sent" | "partially_paid" | "paid" | "overdue" | "voided";
export type BillStatus = "draft" | "awaiting_payment" | "partially_paid" | "paid" | "overdue" | "voided";
export type ContactKind = "customer" | "supplier" | "both";
export type BudgetPeriod = "weekly" | "monthly" | "quarterly" | "yearly";
export type GoalKind = "savings" | "debt_payoff" | "spending";
export type GoalStatus = "active" | "achieved" | "abandoned";
export type RecurringFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
export type RecurringStatus = "active" | "paused" | "cancelled";

export type AssetKind = "property" | "vehicle" | "cash" | "investment" | "retirement" | "business" | "collectible" | "other";
export type LiabilityKind = "mortgage" | "student_loan" | "credit_card" | "personal_loan" | "auto_loan" | "business_loan" | "other";
export type HoldingKind = "equity" | "etf" | "mutual_fund" | "bond" | "crypto" | "commodity" | "cash" | "other";

export type BankFeedProvider = "plaid" | "yodlee" | "truelayer" | "salt_edge" | "manual" | "stitch";
export type BankFeedStatus = "pending" | "connected" | "reauth_required" | "error" | "disconnected";
export type ReconMatchState = "auto" | "suggested" | "confirmed" | "rejected";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "paused" | "incomplete";
export type AccountingProvider = "xero" | "quickbooks";

// ---- Core identity rows (shared across modules) ----
export interface User {
  id: string;
  email: string;
  full_name: string | null;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  kind: OrganizationKind;
  name: string;
  slug: string;
  rx_local_part: string;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface Membership {
  organization_id: string;
  user_id: string;
  role: Role;
  joined_at: string;
}

/** owner/admin pass an admin gate (Go: roleAtLeastAdmin). */
export const roleAtLeastAdmin = (r: Role): boolean => r === "owner" || r === "admin";
