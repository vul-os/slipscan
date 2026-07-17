/**
 * Ledger routes — port of Go backend/internal/ledger/handlers.go.
 *
 * Routes (all behind requireMember; absolute paths from root):
 *
 *   Accounts:
 *     GET    /orgs/:orgID/accounts
 *     POST   /orgs/:orgID/accounts
 *     GET    /orgs/:orgID/accounts/:accountID
 *     PATCH  /orgs/:orgID/accounts/:accountID
 *     DELETE /orgs/:orgID/accounts/:accountID
 *     GET    /orgs/:orgID/accounts/:accountID/ledger?from=&to=
 *
 *   Trial balance:
 *     GET    /orgs/:orgID/trial-balance?from=&to=
 *
 *   Transaction posting:
 *     POST   /orgs/:orgID/transactions/:txID/post
 *
 *   Manual journals:
 *     GET    /orgs/:orgID/journals
 *     POST   /orgs/:orgID/journals
 *     GET    /orgs/:orgID/journals/:journalID
 *     DELETE /orgs/:orgID/journals/:journalID
 *
 *   Contacts:
 *     GET    /orgs/:orgID/contacts
 *     POST   /orgs/:orgID/contacts
 *     GET    /orgs/:orgID/contacts/:contactID
 *     PATCH  /orgs/:orgID/contacts/:contactID
 *     DELETE /orgs/:orgID/contacts/:contactID
 *
 * MONEY: NUMERIC columns from Postgres arrive as strings; all arithmetic uses
 * lib/money. Responses serialise amounts as number (float64) to match Go JSON
 * output exactly — conversion from Decimal to number happens once per response
 * at the toFixed(2) boundary.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireMember } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import { dec, money, add, sum } from "../../lib/money";
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  postTransaction,
  createManualJournal,
  listManualJournals,
  getManualJournal,
  deleteManualJournal,
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  accountLedger,
  trialBalance,
  validateJournalLines,
  NotFoundError,
  SystemAccountError,
  UnbalancedError,
  NoLinesError,
  InvalidAmountError,
  VALID_ACCOUNT_TYPES,
  VALID_CONTACT_KINDS,
} from "./queries";
import type {
  AccountRow,
  AccountResponse,
  ContactRow,
  ContactResponse,
  JournalRow,
  JournalLineRow,
  JournalResponse,
  JournalLineResponse,
  LedgerEntryRow,
  LedgerEntryResponse,
  TrialBalanceRow,
  TrialBalanceLineResponse,
  CreateAccountRequest,
  UpdateAccountRequest,
  CreateContactRequest,
  UpdateContactRequest,
  CreateJournalRequest,
} from "./types";
import type { JournalLineInput } from "./queries";
import { emitAudit } from "../audit/emit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(s: string): boolean {
  return UUID_RE.test(s);
}

// ─── Shape helpers ─────────────────────────────────────────────────────────────

function toAccountResponse(a: AccountRow): AccountResponse {
  const r: AccountResponse = {
    id: a.id,
    organization_id: a.organization_id,
    name: a.name,
    type: a.type,
    currency: a.currency,
    is_archived: a.is_archived,
    is_system: a.is_system,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
  if (a.parent_id) r.parent_id = a.parent_id;
  if (a.code) r.code = a.code;
  if (a.subtype) r.subtype = a.subtype;
  if (a.tax_rate_id) r.tax_rate_id = a.tax_rate_id;
  if (a.description) r.description = a.description;
  return r;
}

function toContactResponse(c: ContactRow): ContactResponse {
  const r: ContactResponse = {
    id: c.id,
    organization_id: c.organization_id,
    kind: c.kind,
    name: c.name,
    payment_terms_days: c.payment_terms_days,
    is_archived: c.is_archived,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
  if (c.legal_name) r.legal_name = c.legal_name;
  if (c.email) r.email = c.email;
  if (c.phone) r.phone = c.phone;
  if (c.tax_number) r.tax_number = c.tax_number;
  if (c.currency) r.currency = c.currency;
  if (c.address_line1) r.address_line1 = c.address_line1;
  if (c.address_line2) r.address_line2 = c.address_line2;
  if (c.city) r.city = c.city;
  if (c.region) r.region = c.region;
  if (c.postal_code) r.postal_code = c.postal_code;
  if (c.country) r.country = c.country;
  if (c.notes) r.notes = c.notes;
  if (c.default_account_id) r.default_account_id = c.default_account_id;
  if (c.default_tax_rate_id) r.default_tax_rate_id = c.default_tax_rate_id;
  return r;
}

/**
 * Converts stored NUMERIC strings to a JournalLineResponse.
 * Debit/credit are serialised as number (float64) to match Go JSON shape.
 * Using parseFloat here is safe because the values are already validated
 * ledger amounts with at most 2dp (NUMERIC(14,2)) — no precision loss possible.
 */
function toJournalLineResponse(l: JournalLineRow): JournalLineResponse {
  const r: JournalLineResponse = {
    account_id: l.account_id,
    debit: parseFloat(l.debit),
    credit: parseFloat(l.credit),
  };
  if (l.description) r.description = l.description;
  return r;
}

function toJournalResponse(
  j: JournalRow,
  lines?: JournalLineRow[],
): JournalResponse {
  const r: JournalResponse = {
    id: j.id,
    organization_id: j.organization_id,
    posted_date: typeof j.posted_date === "string"
      ? j.posted_date.slice(0, 10)
      : j.posted_date,
    created_at: j.created_at,
    updated_at: j.updated_at,
  };
  if (j.narrative) r.narrative = j.narrative;
  if (j.reference) r.reference = j.reference;
  if (j.created_by) r.created_by = j.created_by;
  if (lines && lines.length > 0) r.lines = lines.map(toJournalLineResponse);
  return r;
}

/**
 * Converts stored NUMERIC strings to a LedgerEntryResponse.
 * Same float64 rationale as toJournalLineResponse.
 */
function toLedgerEntryResponse(e: LedgerEntryRow): LedgerEntryResponse {
  const r: LedgerEntryResponse = {
    id: e.id,
    source_type: e.source_type,
    source_id: e.source_id,
    posted_date: typeof e.posted_date === "string"
      ? e.posted_date.slice(0, 10)
      : e.posted_date,
    debit: parseFloat(e.debit),
    credit: parseFloat(e.credit),
  };
  if (e.description) r.description = e.description;
  return r;
}

/**
 * Converts stored NUMERIC strings to a TrialBalanceLineResponse.
 * Uses lib/money for the grand total summation, then converts to number once.
 */
function toTrialBalanceLine(row: TrialBalanceRow): TrialBalanceLineResponse {
  const out: TrialBalanceLineResponse = {
    account_id: row.account_id,
    account_name: row.account_name,
    account_type: row.account_type,
    total_debit: parseFloat(money(row.total_debit)),
    total_credit: parseFloat(money(row.total_credit)),
  };
  if (row.account_code) out.account_code = row.account_code;
  return out;
}

// ─── Router ───────────────────────────────────────────────────────────────────

const router = new Hono<AppEnv>();

// ═══════════════════════════════════════════════════════════════════════════════
// Accounts
// ═══════════════════════════════════════════════════════════════════════════════

// GET /orgs/:orgID/accounts
router.get("/orgs/:orgID/accounts", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  try {
    const accounts = await listAccounts(c.env, orgId);
    return c.json({ accounts: accounts.map(toAccountResponse) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "list_failed", msg);
  }
});

// GET /orgs/:orgID/accounts/:accountID
router.get("/orgs/:orgID/accounts/:accountID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const accountId = c.req.param("accountID");
  if (!isUUID(accountId)) return writeError(c, 400, "invalid_account_id", "invalid account id");

  try {
    const account = await getAccount(c.env, orgId, accountId);
    return c.json(toAccountResponse(account));
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "account not found");
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "fetch_failed", msg);
  }
});

// POST /orgs/:orgID/accounts
router.post("/orgs/:orgID/accounts", requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  let body: CreateAccountRequest;
  try {
    body = await c.req.json<CreateAccountRequest>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  // Validate optional UUID fields.
  if (body.parent_id && !isUUID(body.parent_id))
    return writeError(c, 400, "invalid_parent_id", "invalid parent_id");
  if (body.tax_rate_id && !isUUID(body.tax_rate_id))
    return writeError(c, 400, "invalid_tax_rate_id", "invalid tax_rate_id");

  const userId = c.get("userId");
  try {
    const account = await createAccount(c.env, orgId, {
      parentId: body.parent_id ?? null,
      code: body.code,
      name: body.name ?? "",
      type: body.type ?? "",
      subtype: body.subtype,
      currency: body.currency ?? "",
      taxRateId: body.tax_rate_id ?? null,
      description: body.description,
    });
    // P4-03: audit account creation
    emitAudit(c.env, {
      organization_id: orgId,
      actor_user_id: userId,
      entity_type: "account",
      entity_id: account.id,
      action: "account.created",
      after: { name: account.name, type: account.type, currency: account.currency },
    }, c.executionCtx);
    return c.json(toAccountResponse(account), 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 400, "create_failed", msg);
  }
});

// PATCH /orgs/:orgID/accounts/:accountID
router.patch("/orgs/:orgID/accounts/:accountID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const accountId = c.req.param("accountID");
  if (!isUUID(accountId)) return writeError(c, 400, "invalid_account_id", "invalid account id");

  let body: UpdateAccountRequest;
  try {
    body = await c.req.json<UpdateAccountRequest>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  // Capture before-state
  let accountBefore: { name?: string; code?: string; is_archived?: boolean } | null = null;
  try {
    const ab = await getAccount(c.env, orgId, accountId);
    accountBefore = { name: ab.name, code: ab.code ?? undefined, is_archived: ab.is_archived };
  } catch {
    // Non-fatal
  }

  try {
    const account = await updateAccount(c.env, orgId, accountId, {
      code: body.code,
      name: body.name,
      subtype: body.subtype,
      description: body.description,
      isArchived: body.is_archived,
    });
    // P4-03: audit account update
    emitAudit(c.env, {
      organization_id: orgId,
      actor_user_id: c.get("userId"),
      entity_type: "account",
      entity_id: accountId,
      action: "account.updated",
      before: accountBefore,
      after: { name: account.name, code: account.code ?? null, is_archived: account.is_archived },
    }, c.executionCtx);
    return c.json(toAccountResponse(account));
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "account not found");
    if (err instanceof SystemAccountError)
      return writeError(c, 403, "system_account", err.message);
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "update_failed", msg);
  }
});

// DELETE /orgs/:orgID/accounts/:accountID
router.delete("/orgs/:orgID/accounts/:accountID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const accountId = c.req.param("accountID");
  if (!isUUID(accountId)) return writeError(c, 400, "invalid_account_id", "invalid account id");

  // Capture before-state
  let acctBeforeDelete: { name?: string; type?: string } | null = null;
  try {
    const ab = await getAccount(c.env, orgId, accountId);
    acctBeforeDelete = { name: ab.name, type: ab.type };
  } catch {
    // Non-fatal
  }

  try {
    await deleteAccount(c.env, orgId, accountId);
    // P4-03: audit account deletion
    emitAudit(c.env, {
      organization_id: orgId,
      actor_user_id: c.get("userId"),
      entity_type: "account",
      entity_id: accountId,
      action: "account.deleted",
      before: acctBeforeDelete,
    }, c.executionCtx);
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "account not found");
    if (err instanceof SystemAccountError)
      return writeError(c, 403, "system_account", err.message);
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "delete_failed", msg);
  }
});

// GET /orgs/:orgID/accounts/:accountID/ledger?from=&to=
router.get("/orgs/:orgID/accounts/:accountID/ledger", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const accountId = c.req.param("accountID");
  if (!isUUID(accountId)) return writeError(c, 400, "invalid_account_id", "invalid account id");

  const fromStr = c.req.query("from");
  const toStr = c.req.query("to");

  const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
  if (fromStr && !YYYY_MM_DD.test(fromStr))
    return writeError(c, 400, "invalid_from", "from must be YYYY-MM-DD");
  if (toStr && !YYYY_MM_DD.test(toStr))
    return writeError(c, 400, "invalid_to", "to must be YYYY-MM-DD");

  try {
    const entries = await accountLedger(c.env, orgId, accountId, fromStr, toStr);
    return c.json({ entries: entries.map(toLedgerEntryResponse) });
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "account not found");
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "query_failed", msg);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Trial balance
// ═══════════════════════════════════════════════════════════════════════════════

// GET /orgs/:orgID/trial-balance?from=&to=
router.get("/orgs/:orgID/trial-balance", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const fromStr = c.req.query("from");
  const toStr = c.req.query("to");

  const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
  if (fromStr && !YYYY_MM_DD.test(fromStr))
    return writeError(c, 400, "invalid_from", "from must be YYYY-MM-DD");
  if (toStr && !YYYY_MM_DD.test(toStr))
    return writeError(c, 400, "invalid_to", "to must be YYYY-MM-DD");

  try {
    const rows = await trialBalance(c.env, orgId, fromStr, toStr);

    // Grand totals computed via lib/money (Decimal) — never Number accumulation.
    const totalDebit = parseFloat(money(sum(rows.map((r) => r.total_debit))));
    const totalCredit = parseFloat(money(sum(rows.map((r) => r.total_credit))));

    return c.json({
      lines: rows.map(toTrialBalanceLine),
      total_debit: totalDebit,
      total_credit: totalCredit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "query_failed", msg);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Transaction posting
// ═══════════════════════════════════════════════════════════════════════════════

// POST /orgs/:orgID/transactions/:txID/post
router.post("/orgs/:orgID/transactions/:txID/post", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const txId = c.req.param("txID");
  if (!isUUID(txId)) return writeError(c, 400, "invalid_tx_id", "invalid transaction id");

  const userId = c.get("userId");

  try {
    await postTransaction(c.env, orgId, userId ?? null, txId);
    // P4-03: audit transaction posting
    emitAudit(c.env, {
      organization_id: orgId,
      actor_user_id: userId,
      entity_type: "transaction",
      entity_id: txId,
      action: "transaction.posted",
      after: { posted: true },
    }, c.executionCtx);
    return c.json({ posted: true });
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "transaction not found");
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "post_failed", msg);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Manual journals
// ═══════════════════════════════════════════════════════════════════════════════

// GET /orgs/:orgID/journals
router.get("/orgs/:orgID/journals", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  try {
    const journals = await listManualJournals(c.env, orgId);
    return c.json({ journals: journals.map((j) => toJournalResponse(j)) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "list_failed", msg);
  }
});

// POST /orgs/:orgID/journals
router.post("/orgs/:orgID/journals", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");

  let body: CreateJournalRequest;
  try {
    body = await c.req.json<CreateJournalRequest>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  if (!body.posted_date)
    return writeError(c, 400, "missing_posted_date", "posted_date is required (YYYY-MM-DD)");

  const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
  if (!YYYY_MM_DD.test(body.posted_date))
    return writeError(c, 400, "invalid_posted_date", "posted_date must be YYYY-MM-DD");

  if (!Array.isArray(body.lines) || body.lines.length === 0)
    return writeError(c, 400, "no_lines", "journal must have at least two lines");

  // Parse + validate each line's account_id UUID.
  const lines: JournalLineInput[] = [];
  for (let i = 0; i < body.lines.length; i++) {
    const l = body.lines[i];
    if (!isUUID(l.account_id))
      return writeError(c, 400, "invalid_account_id", `line ${i}: invalid account_id`);
    lines.push({
      accountId: l.account_id,
      debit: Number(l.debit ?? 0),
      credit: Number(l.credit ?? 0),
      description: l.description ?? "",
    });
  }

  try {
    const { journal, lines: savedLines } = await createManualJournal(
      c.env,
      orgId,
      userId ?? null,
      body.posted_date,
      body.narrative ?? "",
      body.reference ?? "",
      lines,
    );

    // Convert JournalLineInput back to JournalLineRow shape for the response.
    const lineRows: JournalLineRow[] = savedLines.map((l) => ({
      account_id: l.accountId,
      debit: String(l.debit),
      credit: String(l.credit),
      description: l.description,
    }));

    // P4-03: audit manual journal creation
    emitAudit(c.env, {
      organization_id: orgId,
      actor_user_id: userId,
      entity_type: "journal",
      entity_id: journal.id,
      action: "journal.created",
      after: {
        posted_date: journal.posted_date,
        narrative: journal.narrative,
        reference: journal.reference,
        lines: lineRows.map((l) => ({
          account_id: l.account_id,
          debit: l.debit,
          credit: l.credit,
        })),
      },
    }, c.executionCtx);
    return c.json(toJournalResponse(journal, lineRows), 201);
  } catch (err) {
    if (err instanceof UnbalancedError)
      return writeError(c, 422, "unbalanced", err.message);
    if (err instanceof NoLinesError)
      return writeError(c, 400, "no_lines", err.message);
    if (err instanceof InvalidAmountError)
      return writeError(c, 400, "invalid_amount", err.message);
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "create_failed", msg);
  }
});

// GET /orgs/:orgID/journals/:journalID
router.get("/orgs/:orgID/journals/:journalID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const journalId = c.req.param("journalID");
  if (!isUUID(journalId)) return writeError(c, 400, "invalid_journal_id", "invalid journal id");

  try {
    const { journal, lines } = await getManualJournal(c.env, orgId, journalId);
    return c.json(toJournalResponse(journal, lines));
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "journal not found");
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "fetch_failed", msg);
  }
});

// DELETE /orgs/:orgID/journals/:journalID
router.delete("/orgs/:orgID/journals/:journalID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const journalId = c.req.param("journalID");
  if (!isUUID(journalId)) return writeError(c, 400, "invalid_journal_id", "invalid journal id");

  const userId = c.get("userId");

  // Capture before-state
  let journalBefore: { posted_date?: string; narrative?: string; reference?: string } | null = null;
  try {
    const { journal: jBefore } = await getManualJournal(c.env, orgId, journalId);
    journalBefore = {
      posted_date: typeof jBefore.posted_date === "string" ? jBefore.posted_date.slice(0, 10) : jBefore.posted_date,
      narrative: jBefore.narrative ?? undefined,
      reference: jBefore.reference ?? undefined,
    };
  } catch {
    // Non-fatal: proceed if before-state fetch fails
  }

  try {
    await deleteManualJournal(c.env, orgId, userId ?? null, journalId);
    // P4-03: audit journal deletion
    emitAudit(c.env, {
      organization_id: orgId,
      actor_user_id: userId,
      entity_type: "journal",
      entity_id: journalId,
      action: "journal.deleted",
      before: journalBefore,
    }, c.executionCtx);
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "journal not found");
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "delete_failed", msg);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Contacts
// ═══════════════════════════════════════════════════════════════════════════════

// GET /orgs/:orgID/contacts
router.get("/orgs/:orgID/contacts", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  try {
    const contacts = await listContacts(c.env, orgId);
    return c.json({ contacts: contacts.map(toContactResponse) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "list_failed", msg);
  }
});

// GET /orgs/:orgID/contacts/:contactID
router.get("/orgs/:orgID/contacts/:contactID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const contactId = c.req.param("contactID");
  if (!isUUID(contactId)) return writeError(c, 400, "invalid_contact_id", "invalid contact id");

  try {
    const contact = await getContact(c.env, orgId, contactId);
    return c.json(toContactResponse(contact));
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "contact not found");
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "fetch_failed", msg);
  }
});

// POST /orgs/:orgID/contacts
router.post("/orgs/:orgID/contacts", requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  let body: CreateContactRequest;
  try {
    body = await c.req.json<CreateContactRequest>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  if (body.default_account_id && !isUUID(body.default_account_id))
    return writeError(c, 400, "invalid_default_account_id", "invalid default_account_id");
  if (body.default_tax_rate_id && !isUUID(body.default_tax_rate_id))
    return writeError(c, 400, "invalid_default_tax_rate_id", "invalid default_tax_rate_id");

  try {
    const contact = await createContact(c.env, orgId, {
      kind: body.kind?.trim() || "customer",
      name: body.name ?? "",
      legalName: body.legal_name,
      email: body.email,
      phone: body.phone,
      taxNumber: body.tax_number,
      paymentTermsDays: body.payment_terms_days ?? 0,
      defaultAccountId: body.default_account_id ?? null,
      defaultTaxRateId: body.default_tax_rate_id ?? null,
      currency: body.currency,
      addressLine1: body.address_line1,
      addressLine2: body.address_line2,
      city: body.city,
      region: body.region,
      postalCode: body.postal_code,
      country: body.country,
      notes: body.notes,
    });
    return c.json(toContactResponse(contact), 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 400, "create_failed", msg);
  }
});

// PATCH /orgs/:orgID/contacts/:contactID
router.patch("/orgs/:orgID/contacts/:contactID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const contactId = c.req.param("contactID");
  if (!isUUID(contactId)) return writeError(c, 400, "invalid_contact_id", "invalid contact id");

  let body: UpdateContactRequest;
  try {
    body = await c.req.json<UpdateContactRequest>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  try {
    const contact = await updateContact(c.env, orgId, contactId, {
      kind: body.kind,
      name: body.name,
      legalName: body.legal_name,
      email: body.email,
      phone: body.phone,
      taxNumber: body.tax_number,
      paymentTermsDays: body.payment_terms_days,
      isArchived: body.is_archived,
      notes: body.notes,
    });
    return c.json(toContactResponse(contact));
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "contact not found");
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "update_failed", msg);
  }
});

// DELETE /orgs/:orgID/contacts/:contactID
router.delete("/orgs/:orgID/contacts/:contactID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const contactId = c.req.param("contactID");
  if (!isUUID(contactId)) return writeError(c, 400, "invalid_contact_id", "invalid contact id");

  try {
    await deleteContact(c.env, orgId, contactId);
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof NotFoundError) return writeError(c, 404, "not_found", "contact not found");
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 500, "delete_failed", msg);
  }
});

export default router;
