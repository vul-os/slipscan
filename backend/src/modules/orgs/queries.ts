/**
 * Org + invite queries — raw parameterized SQL ported 1:1 from Go
 * internal/org/store.go and internal/invite/store.go.
 *
 * Every query that touches org-owned data MUST include WHERE organization_id=$
 * (belt-and-suspenders on top of RLS via withOrg).
 */
import { queryRows, queryOne, withOrg } from "../../db/client";
import type { Env } from "../../bindings";
import type { OrgRow, OrgWithRoleRow, MemberRow, InvitationRow } from "./types";
import type { Role, OrganizationKind } from "../../types/schema";
import { seedDefaultCategories } from "./seed";

// ─── Slug helpers (port of Go slugify + findFreeIdentifier) ─────────────────

/** Mirrors Go org.slugify exactly. */
export function slugify(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) {
    const c = ch.codePointAt(0)!;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += ch;
    } else if (ch === " " || ch === "-" || ch === "_" || ch === "." || ch === "/" || ch === "+" || ch === "&") {
      out += "-";
    }
  }
  // Squash consecutive dashes
  out = out.replace(/-+/g, "-");
  // Trim leading/trailing dashes
  out = out.replace(/(^-+|-+$)/g, "");
  // Pad too-short slugs
  if (out.length < 3) {
    out = (out + "-org").replace(/(^-+|-+$)/g, "");
  }
  // Truncate too-long slugs
  if (out.length > 60) {
    out = out.slice(0, 60).replace(/(^-+|-+$)/g, "");
  }
  return out;
}

// ─── Org creation ───────────────────────────────────────────────────────────

export interface CreateOrgOptions {
  kind: OrganizationKind;
  name: string;
  ownerUserId: string;
  personal?: { fullName: string };
  business?: {
    legalName: string;
    registrationNumber: string;
    taxNumber: string;
    industry: string;
    website: string;
    country: string;
  };
}

/** Error codes surfaced to the HTTP layer. */
export class SlugTakenError extends Error {
  constructor() { super("slug already in use"); }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err);
  return msg.includes("23505") || msg.toLowerCase().includes("unique");
}

/**
 * createOrg — port of Go Store.Create.
 * Runs inside withOrg so the tx gets the RLS GUCs set, and on success
 * calls seedDefaultCategories inside the same transaction.
 */
export async function createOrg(env: Env, opts: CreateOrgOptions): Promise<OrgRow> {
  const name = opts.name.trim();
  const kind = opts.kind;

  // We need to allocate slug+rx_local_part within the same transaction, but
  // withOrg's query runner executes inside that tx. We call withOrg with a
  // placeholder orgId ("" — org doesn't exist yet), then do everything inside.
  // To avoid setting a broken RLS GUC we use the owner's userId as the org
  // placeholder; the real org id comes from the INSERT RETURNING.
  //
  // NOTE: The RLS set_config for organization_id is not meaningful here
  // because the org doesn't exist yet — but withOrg still handles the
  // transaction/connection lifecycle for us.  We use a raw Pool connection
  // via withOrg (orgId="") to keep one transaction. The Go code does the
  // same thing: allocSlug uses tx.QueryRowContext on the same transaction.

  return withOrg(env, opts.ownerUserId, opts.ownerUserId, async (q) => {
    // --- Allocate slug ---
    const slugBase = slugify(name) || "org";
    const slug = await findFreeIdentifier(
      q,
      "SELECT 1 FROM organizations WHERE slug = $1",
      slugBase,
    );

    // --- Allocate rx_local_part ---
    const rxBase = slugify(name) || "rx";
    const rx = await findFreeIdentifier(
      q,
      "SELECT 1 FROM organizations WHERE rx_local_part = $1",
      rxBase,
    );

    // --- country (business only) ---
    let country: string | null = null;
    if (kind === "business" && opts.business) {
      const c = opts.business.country.toUpperCase().trim();
      country = c || null;
    }

    // --- Insert org ---
    let orgRow: OrgRow;
    try {
      const rows = await q(
        `INSERT INTO organizations (kind, name, slug, rx_local_part, country, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, kind, name, slug, rx_local_part, currency,
                   created_by, created_at, updated_at, avatar_url`,
        [kind, name, slug, rx, country, opts.ownerUserId],
      );
      if (!rows.length) throw new Error("org insert returned no rows");
      orgRow = rows[0] as unknown as OrgRow;
    } catch (err) {
      if (isUniqueViolation(err)) throw new SlugTakenError();
      throw err;
    }

    const orgId = orgRow.id;

    // --- Insert profile ---
    if (kind === "personal") {
      const p = opts.personal;
      if (!p || !p.fullName.trim()) throw new Error("personal profile full_name is required");
      await q(
        `INSERT INTO personal_profiles (organization_id, full_name) VALUES ($1, $2)`,
        [orgId, p.fullName.trim()],
      );
    } else {
      const p = opts.business;
      if (!p || !p.legalName.trim()) throw new Error("business profile legal_name is required");
      await q(
        `INSERT INTO business_profiles (
           organization_id, legal_name, registration_number, tax_number, industry, website
         ) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''))`,
        [
          orgId,
          p.legalName.trim(),
          p.registrationNumber.trim(),
          p.taxNumber.trim(),
          p.industry.trim(),
          p.website.trim(),
        ],
      );
    }

    // --- Insert owner membership ---
    await q(
      `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [orgId, opts.ownerUserId],
    );

    // --- Seed default categories ---
    await seedDefaultCategories(q, orgId, kind, orgRow.currency as string);

    return orgRow;
  });
}

/** Port of Go findFreeIdentifier — numeric suffixes then random hex. */
async function findFreeIdentifier(
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  lookupSQL: string,
  base: string,
): Promise<string> {
  const check = async (candidate: string): Promise<boolean> => {
    const rows = await q(lookupSQL, [candidate]);
    return rows.length === 0;
  };

  if (await check(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (await check(candidate)) return candidate;
  }
  // Random hex suffix — statistically impossible to exhaust in normal use.
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${base}-${hex}`;
}

// ─── Org queries ────────────────────────────────────────────────────────────

/** Port of Go Store.ListForUser */
export async function listOrgsForUser(env: Env, userId: string): Promise<OrgWithRoleRow[]> {
  const rows = await queryRows(
    env,
    `SELECT o.id, o.kind, o.name, o.slug, o.rx_local_part, o.currency,
            o.created_by, o.created_at, o.updated_at, o.avatar_url,
            m.role, m.joined_at
     FROM organizations o
     JOIN memberships m ON m.organization_id = o.id
     WHERE m.user_id = $1
     ORDER BY m.joined_at ASC`,
    [userId],
  );
  return rows as unknown as OrgWithRoleRow[];
}

/** Port of Go Store.ByID */
export async function getOrgById(env: Env, orgId: string): Promise<OrgRow | null> {
  const row = await queryOne(
    env,
    `SELECT id, kind, name, slug, rx_local_part, currency,
            created_by, created_at, updated_at, avatar_url
     FROM organizations
     WHERE id = $1`,
    [orgId],
  );
  return row as unknown as OrgRow | null;
}

/** Update the avatar_url for an organization. */
export async function updateOrganizationAvatar(
  env: Env,
  orgId: string,
  avatarUrl: string | null,
): Promise<OrgRow | null> {
  const row = await queryOne(
    env,
    `UPDATE organizations
     SET avatar_url = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, kind, name, slug, rx_local_part, currency,
               created_by, created_at, updated_at, avatar_url`,
    [orgId, avatarUrl],
  );
  return row as unknown as OrgRow | null;
}

/** Port of Go Store.ListMembers */
export async function listOrgMembers(env: Env, orgId: string): Promise<MemberRow[]> {
  const rows = await queryRows(
    env,
    `SELECT u.id AS user_id, u.email, u.full_name, m.role, m.joined_at
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1
     ORDER BY m.joined_at ASC`,
    [orgId],
  );
  return rows as unknown as MemberRow[];
}

// ─── Invitation queries ──────────────────────────────────────────────────────

/** Port of Go invite.Store.Create */
export async function createInvitation(
  env: Env,
  orgId: string,
  email: string,
  role: Role,
  invitedBy: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<InvitationRow> {
  try {
    const rows = await queryRows(
      env,
      `INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, organization_id, email, role, invited_by, expires_at,
                 accepted_at, accepted_by, revoked_at, created_at`,
      [orgId, email, role, tokenHash, invitedBy, expiresAt.toISOString()],
    );
    if (!rows.length) throw new Error("invitation insert returned no rows");
    return rows[0] as unknown as InvitationRow;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const e = new Error("pending invitation already exists for this email");
      (e as unknown as { code: string }).code = "pending_exists";
      throw e;
    }
    throw err;
  }
}

/** Port of Go invite.Store.ListPending */
export async function listPendingInvitations(env: Env, orgId: string): Promise<InvitationRow[]> {
  const rows = await queryRows(
    env,
    `SELECT id, organization_id, email, role, invited_by, expires_at,
            accepted_at, accepted_by, revoked_at, created_at
     FROM invitations
     WHERE organization_id = $1
       AND accepted_at IS NULL
       AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [orgId],
  );
  return rows as unknown as InvitationRow[];
}

/**
 * List all non-expired, non-consumed invitations addressed to a given email.
 * Used by GET /invitations/pending (caller-scoped) so the invitee can discover
 * pending invites after login without needing the token URL.
 */
export async function listPendingInvitationsForEmail(env: Env, email: string): Promise<(InvitationRow & { org_name: string })[]> {
  const rows = await queryRows(
    env,
    `SELECT i.id, i.organization_id, i.email, i.role, i.invited_by, i.expires_at,
            i.accepted_at, i.accepted_by, i.revoked_at, i.created_at,
            o.name AS org_name
     FROM invitations i
     JOIN organizations o ON o.id = i.organization_id
     WHERE LOWER(i.email) = LOWER($1)
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > NOW()
     ORDER BY i.created_at DESC`,
    [email],
  );
  return rows as unknown as (InvitationRow & { org_name: string })[];
}

/** Port of Go invite.Store.Revoke — returns false when not found/already consumed. */
export async function revokeInvitation(env: Env, orgId: string, inviteId: string): Promise<boolean> {
  const rows = await queryRows(
    env,
    `UPDATE invitations
     SET revoked_at = NOW()
     WHERE id = $1 AND organization_id = $2
       AND accepted_at IS NULL AND revoked_at IS NULL
     RETURNING id`,
    [inviteId, orgId],
  );
  return rows.length > 0;
}

/** Port of Go invite.Store.Resend — returns null when not found/already consumed. */
export async function resendInvitation(
  env: Env,
  orgId: string,
  inviteId: string,
  newTokenHash: string,
  newExpiresAt: Date,
): Promise<InvitationRow | null> {
  const rows = await queryRows(
    env,
    `UPDATE invitations
     SET token_hash = $3, expires_at = $4
     WHERE id = $1 AND organization_id = $2
       AND accepted_at IS NULL AND revoked_at IS NULL
     RETURNING id, organization_id, email, role, invited_by, expires_at,
               accepted_at, accepted_by, revoked_at, created_at`,
    [inviteId, orgId, newTokenHash, newExpiresAt.toISOString()],
  );
  return rows.length ? (rows[0] as unknown as InvitationRow) : null;
}

/**
 * Port of Go invite.Store.AcceptByTokenHash.
 * Atomically validates the invitation and inserts the membership.
 * Returns the invitation row on success; throws a typed error otherwise.
 */
export async function acceptInvitationByTokenHash(
  env: Env,
  tokenHash: string,
  userId: string,
  callerEmail: string,
): Promise<InvitationRow> {
  // Use withOrg with the orgId from the invitation — we discover it inside the tx.
  // We open the tx against the user's own context (userId) since we don't know
  // the orgId yet. withOrg sets RLS GUCs; the explicit WHERE clauses remain the
  // app-layer guard.
  return withOrg(env, userId, userId, async (q) => {
    // Lock the row for update
    const rows = await q(
      `SELECT id, organization_id, email, role, invited_by, expires_at,
              accepted_at, accepted_by, revoked_at, created_at
       FROM invitations
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );

    if (!rows.length) {
      const e = new Error("invitation not found");
      (e as unknown as { code: string }).code = "not_found";
      throw e;
    }

    const inv = rows[0] as unknown as InvitationRow;

    if (inv.accepted_at !== null || inv.revoked_at !== null) {
      const e = new Error("invitation already accepted or revoked");
      (e as unknown as { code: string }).code = "consumed";
      throw e;
    }
    if (new Date() > new Date(inv.expires_at)) {
      const e = new Error("invitation has expired");
      (e as unknown as { code: string }).code = "expired";
      throw e;
    }
    if (callerEmail.trim().toLowerCase() !== inv.email.toLowerCase()) {
      const e = new Error("this invitation was sent to a different email address");
      (e as unknown as { code: string }).code = "email_mismatch";
      throw e;
    }

    // Insert membership (idempotent)
    await q(
      `INSERT INTO memberships (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [inv.organization_id, userId, inv.role],
    );

    // Mark invitation accepted
    await q(
      `UPDATE invitations SET accepted_at = NOW(), accepted_by = $2 WHERE id = $1`,
      [inv.id, userId],
    );

    return { ...inv, accepted_at: new Date().toISOString(), accepted_by: userId };
  });
}

/** Fetch the caller's email from the users table (needed for accept). */
export async function getUserEmail(env: Env, userId: string): Promise<string | null> {
  const row = await queryOne(env, "SELECT email FROM users WHERE id = $1", [userId]);
  return row ? (row.email as string) : null;
}

/**
 * Accept an invitation by its UUID (not token).  Used by the auto-detect
 * InvitationPrompt path where the frontend has the invite id from
 * GET /invitations/pending but not the plain token.
 *
 * Same email-match and expiry validation as acceptInvitationByTokenHash.
 */
export async function acceptInvitationById(
  env: Env,
  inviteId: string,
  userId: string,
  callerEmail: string,
): Promise<InvitationRow> {
  return withOrg(env, userId, userId, async (q) => {
    const rows = await q(
      `SELECT id, organization_id, email, role, invited_by, expires_at,
              accepted_at, accepted_by, revoked_at, created_at
       FROM invitations
       WHERE id = $1
       FOR UPDATE`,
      [inviteId],
    );

    if (!rows.length) {
      const e = new Error("invitation not found");
      (e as unknown as { code: string }).code = "not_found";
      throw e;
    }

    const inv = rows[0] as unknown as InvitationRow;

    if (inv.accepted_at !== null || inv.revoked_at !== null) {
      const e = new Error("invitation already accepted or revoked");
      (e as unknown as { code: string }).code = "consumed";
      throw e;
    }
    if (new Date() > new Date(inv.expires_at)) {
      const e = new Error("invitation has expired");
      (e as unknown as { code: string }).code = "expired";
      throw e;
    }
    if (callerEmail.trim().toLowerCase() !== inv.email.toLowerCase()) {
      const e = new Error("this invitation was sent to a different email address");
      (e as unknown as { code: string }).code = "email_mismatch";
      throw e;
    }

    await q(
      `INSERT INTO memberships (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [inv.organization_id, userId, inv.role],
    );

    await q(
      `UPDATE invitations SET accepted_at = NOW(), accepted_by = $2 WHERE id = $1`,
      [inv.id, userId],
    );

    return { ...inv, accepted_at: new Date().toISOString(), accepted_by: userId };
  });
}
