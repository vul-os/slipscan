/**
 * Raw SQL queries for the ledger module — 1:1 port of Go
 * backend/internal/ledger/store.go. Uses the frozen queryRows / queryOne /
 * withOrg foundation from db/client.
 *
 * MONEY RULE: Postgres NUMERIC arrives as a STRING from the Neon driver.
 * Never pass a NUMERIC column through Number(). All arithmetic uses lib/money.
 * Amounts are serialised to float64 in the response layer (routes.ts) to match
 * Go's JSON output — conversion happens exactly once, at the boundary.
 *
 * ORG ISOLATION: every query that touches org-scoped tables includes
 * WHERE organization_id = $N. withOrg also sets app.organization_id via
 * set_config for belt-and-suspenders RLS enforcement.
 */
import { queryRows, queryOne, withOrg } from "../../db/client";
import type { Env } from "../../bindings";
import type {
  AccountRow,
  JournalRow,
  JournalLineRow,
  ContactRow,
  LedgerEntryRow,
  TrialBalanceRow,
} from "./types";

// ─── Sentinel error codes (matched in routes.ts) ──────────────────────────────

export class NotFoundError extends Error {
  constructor(msg = "not found") {
    super(msg);
    this.name = "NotFoundError";
  }
}

export class SystemAccountError extends Error {
  constructor() {
    super("system accounts cannot be modified or deleted");
    this.name = "SystemAccountError";
  }
}

export class UnbalancedError extends Error {
  constructor() {
    super("journal entries do not balance (Σdebit ≠ Σcredit)");
    this.name = "UnbalancedError";
  }
}

export class NoLinesError extends Error {
  constructor() {
    super("journal must have at least two lines");
    this.name = "NoLinesError";
  }
}

export class InvalidAmountError extends Error {
  constructor() {
    super("each line must have exactly one of debit or credit > 0");
    this.name = "InvalidAmountError";
  }
}

// ─── Valid enum sets ───────────────────────────────────────────────────────────

export const VALID_ACCOUNT_TYPES = new Set([
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);

export const VALID_CONTACT_KINDS = new Set(["customer", "supplier", "both"]);

// ─── Row → typed helper ───────────────────────────────────────────────────────

function rowToAccountRow(r: Record<string, unknown>): AccountRow {
  return {
    id: r.id as string,
    organization_id: r.organization_id as string,
    parent_id: (r.parent_id as string) ?? null,
    code: (r.code as string) ?? null,
    name: r.name as string,
    type: r.type as string,
    subtype: (r.subtype as string) ?? null,
    currency: r.currency as string,
    tax_rate_id: (r.tax_rate_id as string) ?? null,
    description: (r.description as string) ?? null,
    is_archived: r.is_archived as boolean,
    is_system: r.is_system as boolean,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function rowToContactRow(r: Record<string, unknown>): ContactRow {
  return {
    id: r.id as string,
    organization_id: r.organization_id as string,
    kind: r.kind as string,
    name: r.name as string,
    legal_name: (r.legal_name as string) ?? null,
    email: (r.email as string) ?? null,
    phone: (r.phone as string) ?? null,
    tax_number: (r.tax_number as string) ?? null,
    payment_terms_days: Number(r.payment_terms_days),
    default_account_id: (r.default_account_id as string) ?? null,
    default_tax_rate_id: (r.default_tax_rate_id as string) ?? null,
    currency: (r.currency as string) ?? null,
    address_line1: (r.address_line1 as string) ?? null,
    address_line2: (r.address_line2 as string) ?? null,
    city: (r.city as string) ?? null,
    region: (r.region as string) ?? null,
    postal_code: (r.postal_code as string) ?? null,
    country: (r.country as string) ?? null,
    notes: (r.notes as string) ?? null,
    is_archived: r.is_archived as boolean,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Accounts
// ═══════════════════════════════════════════════════════════════════════════════

export async function listAccounts(env: Env, orgId: string): Promise<AccountRow[]> {
  const rows = await queryRows(
    env,
    `SELECT id, organization_id, parent_id, code, name, type, subtype, currency,
            tax_rate_id, description, is_archived, is_system, created_at, updated_at
     FROM accounts
     WHERE organization_id = $1
     ORDER BY code NULLS LAST, name`,
    [orgId],
  );
  return rows.map(rowToAccountRow);
}

export async function getAccount(
  env: Env,
  orgId: string,
  accountId: string,
): Promise<AccountRow> {
  const row = await queryOne(
    env,
    `SELECT id, organization_id, parent_id, code, name, type, subtype, currency,
            tax_rate_id, description, is_archived, is_system, created_at, updated_at
     FROM accounts
     WHERE id = $1 AND organization_id = $2`,
    [accountId, orgId],
  );
  if (!row) throw new NotFoundError("account not found");
  return rowToAccountRow(row);
}

export interface CreateAccountInput {
  parentId?: string | null;
  code?: string;
  name: string;
  type: string;
  subtype?: string;
  currency: string;
  taxRateId?: string | null;
  description?: string;
}

export async function createAccount(
  env: Env,
  orgId: string,
  input: CreateAccountInput,
): Promise<AccountRow> {
  if (!input.name.trim()) throw new Error("ledger: account name is required");
  if (!VALID_ACCOUNT_TYPES.has(input.type))
    throw new Error(`ledger: invalid account type "${input.type}"`);
  if (!input.currency) throw new Error("ledger: currency is required");

  const rows = await queryRows(
    env,
    `INSERT INTO accounts (organization_id, parent_id, code, name, type, subtype,
                           currency, tax_rate_id, description)
     VALUES ($1, $2, NULLIF($3,''), $4, $5::account_type, NULLIF($6,''), $7, $8, NULLIF($9,''))
     RETURNING id, organization_id, parent_id, code, name, type, subtype, currency,
               tax_rate_id, description, is_archived, is_system, created_at, updated_at`,
    [
      orgId,
      input.parentId ?? null,
      input.code ?? "",
      input.name,
      input.type,
      input.subtype ?? "",
      input.currency,
      input.taxRateId ?? null,
      input.description ?? "",
    ],
  );
  if (!rows[0]) throw new Error("ledger: create account returned no row");
  return rowToAccountRow(rows[0]);
}

export interface UpdateAccountInput {
  code?: string;
  name?: string;
  subtype?: string;
  description?: string;
  isArchived?: boolean;
}

export async function updateAccount(
  env: Env,
  orgId: string,
  accountId: string,
  input: UpdateAccountInput,
): Promise<AccountRow> {
  // Load first to enforce system-account guard (mirrors Go).
  const existing = await getAccount(env, orgId, accountId);
  if (existing.is_system && (input.name !== undefined || input.code !== undefined)) {
    throw new SystemAccountError();
  }

  const setClauses: string[] = ["updated_at = NOW()"];
  const args: unknown[] = [];
  let argN = 1;

  if (input.code !== undefined) {
    setClauses.push(`code = NULLIF($${argN}, '')`);
    args.push(input.code);
    argN++;
  }
  if (input.name !== undefined) {
    setClauses.push(`name = $${argN}`);
    args.push(input.name);
    argN++;
  }
  if (input.subtype !== undefined) {
    setClauses.push(`subtype = NULLIF($${argN}, '')`);
    args.push(input.subtype);
    argN++;
  }
  if (input.description !== undefined) {
    setClauses.push(`description = NULLIF($${argN}, '')`);
    args.push(input.description);
    argN++;
  }
  if (input.isArchived !== undefined) {
    setClauses.push(`is_archived = $${argN}`);
    args.push(input.isArchived);
    argN++;
  }

  args.push(accountId, orgId);
  const q = `
    UPDATE accounts SET ${setClauses.join(", ")}
    WHERE id = $${argN} AND organization_id = $${argN + 1}
    RETURNING id, organization_id, parent_id, code, name, type, subtype, currency,
              tax_rate_id, description, is_archived, is_system, created_at, updated_at
  `;

  const rows = await queryRows(env, q, args);
  if (!rows[0]) throw new NotFoundError("account not found");
  return rowToAccountRow(rows[0]);
}

export async function deleteAccount(env: Env, orgId: string, accountId: string): Promise<void> {
  const existing = await getAccount(env, orgId, accountId);
  if (existing.is_system) throw new SystemAccountError();

  await queryRows(
    env,
    `DELETE FROM accounts WHERE id = $1 AND organization_id = $2`,
    [accountId, orgId],
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Transaction posting (double-entry)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Port of Go postTransactionTx — runs inside a withOrg transaction.
 *
 * Rules (preserved exactly):
 *   direction="debit"  (expense): DR expense-account / CR bank-account
 *   direction="credit" (income):  DR bank-account   / CR income-account
 *   direction="transfer": skip
 *   Non-verified or no account: skip silently
 *   Existing entries reversed (deleted) before re-posting.
 */
export async function postTransaction(
  env: Env,
  orgId: string,
  userId: string | null,
  transactionId: string,
): Promise<void> {
  await withOrg(env, orgId, userId, async (q) => {
    // 1. Load transaction with its current classification.
    const rows = await q(
      `SELECT t.amount, t.currency, t.direction, t.status,
              COALESCE(t.posted_date, CURRENT_DATE) AS posted_date,
              tc.account_id,
              t.merchant
       FROM transactions t
       LEFT JOIN transaction_classifications tc
           ON tc.id = t.current_classification_id
       WHERE t.id = $1 AND t.organization_id = $2`,
      [transactionId, orgId],
    );
    if (!rows[0]) throw new NotFoundError("transaction not found");

    const row = rows[0];
    const status = row.status as string;
    const direction = row.direction as string;
    const accountId = (row.account_id as string) ?? null;
    // amount from NUMERIC — compare as decimal string, not Number
    const amountStr = row.amount as string | null;
    const currency = row.currency as string;
    const postedDate = row.posted_date as string;
    const merchant = (row.merchant as string) ?? null;

    // 2. Guard conditions — skip silently (matches Go behaviour).
    if (status !== "verified") return;
    if (!accountId) return;
    if (direction === "transfer") return;
    // amount must be > 0
    if (!amountStr || parseFloat(amountStr) <= 0) return;

    // 3. Reverse any existing entries for this transaction.
    await q(
      `DELETE FROM ledger_entries
       WHERE source_type = 'transaction' AND source_id = $1 AND organization_id = $2`,
      [transactionId, orgId],
    );

    // 4. Resolve bank/clearing counter-account (code "090", fall back to first asset).
    let bankRows = await q(
      `SELECT id FROM accounts WHERE organization_id = $1 AND code = '090' LIMIT 1`,
      [orgId],
    );
    if (!bankRows[0]) {
      bankRows = await q(
        `SELECT id FROM accounts WHERE organization_id = $1 AND type = 'asset' ORDER BY code NULLS LAST LIMIT 1`,
        [orgId],
      );
    }
    if (!bankRows[0]) throw new Error("ledger: no bank/asset account found for org");
    const bankAccountId = bankRows[0].id as string;

    const desc = merchant ?? null;
    const classAccId = accountId;

    // 5. Write two balanced entries (DR/CR depend on direction).
    const insertEntry = `
      INSERT INTO ledger_entries
          (organization_id, account_id, source_type, source_id, posted_date, debit, credit, currency, description)
      VALUES ($1, $2, 'transaction', $3, $4, $5, $6, $7, $8)
    `;

    if (direction === "debit") {
      // Expense: DR expense-account / CR bank-account
      await q(insertEntry, [orgId, classAccId, transactionId, postedDate, amountStr, "0", currency, desc]);
      await q(insertEntry, [orgId, bankAccountId, transactionId, postedDate, "0", amountStr, currency, desc]);
    } else if (direction === "credit") {
      // Income: DR bank-account / CR income-account
      await q(insertEntry, [orgId, bankAccountId, transactionId, postedDate, amountStr, "0", currency, desc]);
      await q(insertEntry, [orgId, classAccId, transactionId, postedDate, "0", amountStr, currency, desc]);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Manual journals
// ═══════════════════════════════════════════════════════════════════════════════

export interface JournalLineInput {
  accountId: string;
  /** Raw number from request — validated, then stored as decimal string */
  debit: number;
  credit: number;
  description: string;
}

/**
 * Port of Go validateJournalLines.
 *
 * Invariants enforced (money-critical):
 *   1. At least 2 lines (ErrNoLines).
 *   2. Each line has exactly one of debit>0 or credit>0 (ErrInvalidAmount).
 *      Both positive OR both zero → rejected.
 *   3. Σdebit = Σcredit within 0.001 tolerance (ErrUnbalanced).
 *
 * Note: arithmetic uses plain JS addition here only for validation (the values
 * come from the client's JSON as numbers, and we validate relative equality).
 * The actual DB writes use the string representation of the amounts.
 */
export function validateJournalLines(lines: JournalLineInput[]): void {
  if (lines.length < 2) throw new NoLinesError();

  let totalDebit = 0;
  let totalCredit = 0;

  for (const l of lines) {
    // Exactly one side must be positive.
    if ((l.debit > 0 && l.credit > 0) || (l.debit === 0 && l.credit === 0)) {
      throw new InvalidAmountError();
    }
    totalDebit += l.debit;
    totalCredit += l.credit;
  }

  const diff = Math.abs(totalDebit - totalCredit);
  if (diff > 0.001) throw new UnbalancedError();
}

export async function createManualJournal(
  env: Env,
  orgId: string,
  userId: string | null,
  postedDate: string,
  narrative: string,
  reference: string,
  lines: JournalLineInput[],
): Promise<{ journal: JournalRow; lines: JournalLineInput[] }> {
  validateJournalLines(lines);

  let journal!: JournalRow;

  await withOrg(env, orgId, userId, async (q) => {
    // Insert journal header.
    const jRows = await q(
      `INSERT INTO manual_journals (organization_id, posted_date, narrative, reference, created_by)
       VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), $5)
       RETURNING id, organization_id, posted_date, narrative, reference, created_by, created_at, updated_at`,
      [orgId, postedDate, narrative, reference, userId ?? null],
    );
    if (!jRows[0]) throw new Error("ledger: insert journal returned no row");

    const jr = jRows[0];
    journal = {
      id: jr.id as string,
      organization_id: jr.organization_id as string,
      posted_date: jr.posted_date as string,
      narrative: (jr.narrative as string) ?? null,
      reference: (jr.reference as string) ?? null,
      created_by: (jr.created_by as string) ?? null,
      created_at: jr.created_at as string,
      updated_at: jr.updated_at as string,
    };

    // Insert ledger_entries for each line; resolve account currency first.
    for (const line of lines) {
      const accRows = await q(
        `SELECT currency FROM accounts WHERE id = $1 AND organization_id = $2`,
        [line.accountId, orgId],
      );
      if (!accRows[0])
        throw new Error(`ledger: account ${line.accountId} not found or not in org`);

      const currency = accRows[0].currency as string;

      await q(
        `INSERT INTO ledger_entries
             (organization_id, account_id, source_type, source_id, posted_date, debit, credit, currency, description)
         VALUES ($1, $2, 'manual_journal', $3, $4, $5, $6, $7, NULLIF($8,''))`,
        [
          orgId,
          line.accountId,
          journal.id,
          journal.posted_date,
          line.debit,
          line.credit,
          currency,
          line.description,
        ],
      );
    }
  });

  return { journal, lines };
}

export async function listManualJournals(env: Env, orgId: string): Promise<JournalRow[]> {
  const rows = await queryRows(
    env,
    `SELECT id, organization_id, posted_date, narrative, reference, created_by, created_at, updated_at
     FROM manual_journals
     WHERE organization_id = $1
     ORDER BY posted_date DESC, created_at DESC`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    organization_id: r.organization_id as string,
    posted_date: r.posted_date as string,
    narrative: (r.narrative as string) ?? null,
    reference: (r.reference as string) ?? null,
    created_by: (r.created_by as string) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  }));
}

export async function getManualJournal(
  env: Env,
  orgId: string,
  journalId: string,
): Promise<{ journal: JournalRow; lines: JournalLineRow[] }> {
  const row = await queryOne(
    env,
    `SELECT id, organization_id, posted_date, narrative, reference, created_by, created_at, updated_at
     FROM manual_journals
     WHERE id = $1 AND organization_id = $2`,
    [journalId, orgId],
  );
  if (!row) throw new NotFoundError("journal not found");

  const journal: JournalRow = {
    id: row.id as string,
    organization_id: row.organization_id as string,
    posted_date: row.posted_date as string,
    narrative: (row.narrative as string) ?? null,
    reference: (row.reference as string) ?? null,
    created_by: (row.created_by as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };

  const lineRows = await queryRows(
    env,
    `SELECT account_id, debit, credit, COALESCE(description, '') AS description
     FROM ledger_entries
     WHERE source_type = 'manual_journal' AND source_id = $1 AND organization_id = $2
     ORDER BY created_at`,
    [journalId, orgId],
  );
  const lines: JournalLineRow[] = lineRows.map((r) => ({
    account_id: r.account_id as string,
    debit: String(r.debit),
    credit: String(r.credit),
    description: r.description as string,
  }));

  return { journal, lines };
}

export async function deleteManualJournal(
  env: Env,
  orgId: string,
  userId: string | null,
  journalId: string,
): Promise<void> {
  await withOrg(env, orgId, userId, async (q) => {
    // Delete entries first (no FK cascade on source_id — it's a bare UUID field).
    await q(
      `DELETE FROM ledger_entries
       WHERE source_type = 'manual_journal' AND source_id = $1 AND organization_id = $2`,
      [journalId, orgId],
    );

    const delRows = await q(
      `DELETE FROM manual_journals
       WHERE id = $1 AND organization_id = $2
       RETURNING id`,
      [journalId, orgId],
    );
    if (!delRows[0]) throw new NotFoundError("journal not found");
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Contacts
// ═══════════════════════════════════════════════════════════════════════════════

export async function listContacts(env: Env, orgId: string): Promise<ContactRow[]> {
  const rows = await queryRows(
    env,
    `SELECT id, organization_id, kind, name, legal_name, email, phone, tax_number,
            payment_terms_days, default_account_id, default_tax_rate_id, currency,
            address_line1, address_line2, city, region, postal_code, country, notes,
            is_archived, created_at, updated_at
     FROM contacts
     WHERE organization_id = $1
     ORDER BY name`,
    [orgId],
  );
  return rows.map(rowToContactRow);
}

export async function getContact(
  env: Env,
  orgId: string,
  contactId: string,
): Promise<ContactRow> {
  const row = await queryOne(
    env,
    `SELECT id, organization_id, kind, name, legal_name, email, phone, tax_number,
            payment_terms_days, default_account_id, default_tax_rate_id, currency,
            address_line1, address_line2, city, region, postal_code, country, notes,
            is_archived, created_at, updated_at
     FROM contacts
     WHERE id = $1 AND organization_id = $2`,
    [contactId, orgId],
  );
  if (!row) throw new NotFoundError("contact not found");
  return rowToContactRow(row);
}

export interface CreateContactInput {
  kind: string;
  name: string;
  legalName?: string;
  email?: string;
  phone?: string;
  taxNumber?: string;
  paymentTermsDays: number;
  defaultAccountId?: string | null;
  defaultTaxRateId?: string | null;
  currency?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  notes?: string;
}

export async function createContact(
  env: Env,
  orgId: string,
  input: CreateContactInput,
): Promise<ContactRow> {
  if (!input.name.trim()) throw new Error("ledger: contact name is required");
  if (!VALID_CONTACT_KINDS.has(input.kind))
    throw new Error(`ledger: invalid contact kind "${input.kind}"`);
  if (input.paymentTermsDays < 0) throw new Error("ledger: payment_terms_days must be non-negative");

  const rows = await queryRows(
    env,
    `INSERT INTO contacts (organization_id, kind, name, legal_name, email, phone, tax_number,
                           payment_terms_days, default_account_id, default_tax_rate_id, currency,
                           address_line1, address_line2, city, region, postal_code, country, notes)
     VALUES ($1, $2::contact_kind, $3, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), NULLIF($7,''),
             $8, $9, $10, NULLIF($11,''), NULLIF($12,''), NULLIF($13,''), NULLIF($14,''),
             NULLIF($15,''), NULLIF($16,''), NULLIF($17,''), NULLIF($18,''))
     RETURNING id, organization_id, kind, name, legal_name, email, phone, tax_number,
               payment_terms_days, default_account_id, default_tax_rate_id, currency,
               address_line1, address_line2, city, region, postal_code, country, notes,
               is_archived, created_at, updated_at`,
    [
      orgId,
      input.kind,
      input.name,
      input.legalName ?? "",
      input.email ?? "",
      input.phone ?? "",
      input.taxNumber ?? "",
      input.paymentTermsDays,
      input.defaultAccountId ?? null,
      input.defaultTaxRateId ?? null,
      input.currency ?? "",
      input.addressLine1 ?? "",
      input.addressLine2 ?? "",
      input.city ?? "",
      input.region ?? "",
      input.postalCode ?? "",
      input.country ?? "",
      input.notes ?? "",
    ],
  );
  if (!rows[0]) throw new Error("ledger: create contact returned no row");
  return rowToContactRow(rows[0]);
}

export interface UpdateContactInput {
  kind?: string;
  name?: string;
  legalName?: string;
  email?: string;
  phone?: string;
  taxNumber?: string;
  paymentTermsDays?: number;
  isArchived?: boolean;
  notes?: string;
}

export async function updateContact(
  env: Env,
  orgId: string,
  contactId: string,
  input: UpdateContactInput,
): Promise<ContactRow> {
  if (input.kind !== undefined && !VALID_CONTACT_KINDS.has(input.kind)) {
    throw new Error(`ledger: invalid contact kind "${input.kind}"`);
  }

  const setClauses: string[] = ["updated_at = NOW()"];
  const args: unknown[] = [];
  let argN = 1;

  if (input.kind !== undefined) {
    setClauses.push(`kind = $${argN}::contact_kind`);
    args.push(input.kind);
    argN++;
  }
  if (input.name !== undefined) {
    setClauses.push(`name = $${argN}`);
    args.push(input.name);
    argN++;
  }
  if (input.legalName !== undefined) {
    setClauses.push(`legal_name = NULLIF($${argN}, '')`);
    args.push(input.legalName);
    argN++;
  }
  if (input.email !== undefined) {
    setClauses.push(`email = NULLIF($${argN}, '')`);
    args.push(input.email);
    argN++;
  }
  if (input.phone !== undefined) {
    setClauses.push(`phone = NULLIF($${argN}, '')`);
    args.push(input.phone);
    argN++;
  }
  if (input.taxNumber !== undefined) {
    setClauses.push(`tax_number = NULLIF($${argN}, '')`);
    args.push(input.taxNumber);
    argN++;
  }
  if (input.paymentTermsDays !== undefined) {
    setClauses.push(`payment_terms_days = $${argN}`);
    args.push(input.paymentTermsDays);
    argN++;
  }
  if (input.isArchived !== undefined) {
    setClauses.push(`is_archived = $${argN}`);
    args.push(input.isArchived);
    argN++;
  }
  if (input.notes !== undefined) {
    setClauses.push(`notes = NULLIF($${argN}, '')`);
    args.push(input.notes);
    argN++;
  }

  args.push(contactId, orgId);
  const q = `
    UPDATE contacts SET ${setClauses.join(", ")}
    WHERE id = $${argN} AND organization_id = $${argN + 1}
    RETURNING id, organization_id, kind, name, legal_name, email, phone, tax_number,
              payment_terms_days, default_account_id, default_tax_rate_id, currency,
              address_line1, address_line2, city, region, postal_code, country, notes,
              is_archived, created_at, updated_at
  `;

  const rows = await queryRows(env, q, args);
  if (!rows[0]) throw new NotFoundError("contact not found");
  return rowToContactRow(rows[0]);
}

export async function deleteContact(env: Env, orgId: string, contactId: string): Promise<void> {
  const rows = await queryRows(
    env,
    `DELETE FROM contacts WHERE id = $1 AND organization_id = $2 RETURNING id`,
    [contactId, orgId],
  );
  if (!rows[0]) throw new NotFoundError("contact not found");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Account ledger query
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Port of Go AccountLedger — verifies account belongs to org first,
 * then returns ledger entries in date/creation order.
 * from/to are optional YYYY-MM-DD strings; omitted means unbounded.
 */
export async function accountLedger(
  env: Env,
  orgId: string,
  accountId: string,
  from?: string,
  to?: string,
): Promise<LedgerEntryRow[]> {
  // Verify account exists for this org (mirrors Go GetAccount call).
  await getAccount(env, orgId, accountId);

  const args: unknown[] = [orgId, accountId];
  let cond = "WHERE organization_id = $1 AND account_id = $2";
  let argN = 3;

  if (from) {
    cond += ` AND posted_date >= $${argN}`;
    args.push(from);
    argN++;
  }
  if (to) {
    cond += ` AND posted_date <= $${argN}`;
    args.push(to);
    argN++;
  }

  const rows = await queryRows(
    env,
    `SELECT id, source_type, source_id, posted_date, debit, credit,
            COALESCE(description, '') AS description
     FROM ledger_entries
     ${cond}
     ORDER BY posted_date, created_at`,
    args,
  );

  return rows.map((r) => ({
    id: r.id as string,
    source_type: r.source_type as string,
    source_id: r.source_id as string,
    posted_date: r.posted_date as string,
    debit: String(r.debit),
    credit: String(r.credit),
    description: r.description as string,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Trial balance
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Port of Go TrialBalance — returns all accounts with their total debits and
 * credits in the given date range (unbounded when from/to not supplied).
 */
export async function trialBalance(
  env: Env,
  orgId: string,
  from?: string,
  to?: string,
): Promise<TrialBalanceRow[]> {
  const args: unknown[] = [orgId];
  let dateCond = "";
  let argN = 2;

  if (from) {
    dateCond += ` AND le.posted_date >= $${argN}`;
    args.push(from);
    argN++;
  }
  if (to) {
    dateCond += ` AND le.posted_date <= $${argN}`;
    args.push(to);
    argN++;
  }

  const rows = await queryRows(
    env,
    `SELECT a.id AS account_id, COALESCE(a.code,'') AS account_code, a.name AS account_name,
            a.type::text AS account_type,
            COALESCE(SUM(le.debit), 0) AS total_debit,
            COALESCE(SUM(le.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN ledger_entries le
         ON le.account_id = a.id AND le.organization_id = $1 ${dateCond}
     WHERE a.organization_id = $1
     GROUP BY a.id, a.code, a.name, a.type
     ORDER BY a.type, a.code NULLS LAST, a.name`,
    args,
  );

  return rows.map((r) => ({
    account_id: r.account_id as string,
    account_code: r.account_code as string,
    account_name: r.account_name as string,
    account_type: r.account_type as string,
    total_debit: String(r.total_debit),
    total_credit: String(r.total_credit),
  }));
}
