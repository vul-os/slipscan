/**
 * Org + invitation routes — port of Go internal/org + internal/invite handlers.
 *
 * Routes:
 *   POST   /orgs                                        requireAuth
 *   GET    /orgs                                        requireAuth
 *   GET    /orgs/:orgID/members                         requireMember
 *   POST   /orgs/:orgID/invitations                     requireAdmin
 *   GET    /orgs/:orgID/invitations                     requireAdmin
 *   POST   /orgs/:orgID/invitations/:inviteID/resend    requireAdmin
 *   DELETE /orgs/:orgID/invitations/:inviteID           requireAdmin
 *   POST   /invitations/accept                          requireAuth  (mounted at root)
 *
 * Mount as:
 *   app.route("/orgs", orgRoutes);
 *   app.route("/invitations", inviteAcceptRoutes);  // or merge into one export
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireAuth } from "../../middleware/auth";
import { requireMember, requireAdmin } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import { hashToken, newRandomToken } from "../../lib/crypto";
import { putObject } from "../../lib/r2";
import {
  createOrg,
  listOrgsForUser,
  listOrgMembers,
  createInvitation,
  listPendingInvitations,
  listPendingInvitationsForEmail,
  revokeInvitation,
  resendInvitation,
  acceptInvitationByTokenHash,
  getUserEmail,
  updateOrganizationAvatar,
  SlugTakenError,
} from "./queries";
import type {
  CreateOrgRequest,
  OrgResponse,
  MemberResponse,
  CreateInviteRequest,
  InviteResponse,
  AcceptInviteRequest,
  PendingInviteForUserResponse,
  OrgRow,
  OrgWithRoleRow,
  MemberRow,
  InvitationRow,
} from "./types";
import type { Role, OrganizationKind } from "../../types/schema";

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_ROLES: Role[] = ["owner", "admin", "accountant", "member", "viewer"];
const VALID_KINDS: OrganizationKind[] = ["personal", "business"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidEmail(s: string): boolean {
  // Port of Go net/mail.ParseAddress — basic RFC 5322 check
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function toOrgResponse(row: OrgRow | OrgWithRoleRow, role: Role): OrgResponse {
  const resp: OrgResponse = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    rx_local_part: row.rx_local_part,
    currency: row.currency,
    role,
    created_at: row.created_at,
  };
  if (row.avatar_url != null) resp.avatar_url = row.avatar_url;
  return resp;
}

function toMemberResponse(row: MemberRow): MemberResponse {
  const out: MemberResponse = {
    user_id: row.user_id,
    email: row.email,
    role: row.role,
    joined_at: row.joined_at,
  };
  if (row.full_name) out.full_name = row.full_name;
  return out;
}

function toInviteResponse(row: InvitationRow, plain?: string, acceptURL?: string): InviteResponse {
  const out: InviteResponse = {
    id: row.id,
    email: row.email,
    role: row.role,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
  if (plain) out.token = plain;
  if (acceptURL) out.accept_url = acceptURL;
  return out;
}

function inviteTTLMs(env: AppEnv["Bindings"]): number {
  // Default 168 h (7 days) — mirrors Go cfg.InvitationTTL default.
  if (env.INVITATION_TTL) {
    const n = parseInt(env.INVITATION_TTL, 10);
    if (!isNaN(n)) return n * 1000;
  }
  return 168 * 60 * 60 * 1000;
}

// ─── Router ─────────────────────────────────────────────────────────────────

const router = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// POST /orgs — create organization
// ---------------------------------------------------------------------------
router.post("/", requireAuth, async (c) => {
  const userId = c.get("userId");

  let body: CreateOrgRequest;
  try {
    body = await c.req.json<CreateOrgRequest>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  const name = (body.name ?? "").trim();
  if (!name || name.length > 120) {
    return writeError(c, 400, "invalid_name", "name is required (max 120 chars)");
  }
  if (!VALID_KINDS.includes(body.kind)) {
    return writeError(c, 400, "invalid_kind", "kind must be 'personal' or 'business'");
  }

  const opts = {
    kind: body.kind,
    name,
    ownerUserId: userId,
    personal: undefined as { fullName: string } | undefined,
    business: undefined as {
      legalName: string;
      registrationNumber: string;
      taxNumber: string;
      industry: string;
      website: string;
      country: string;
    } | undefined,
  };

  if (body.kind === "personal") {
    const fn = (body.full_name ?? "").trim() || name;
    opts.personal = { fullName: fn };
  } else {
    const legal = (body.legal_name ?? "").trim() || name;
    opts.business = {
      legalName: legal,
      registrationNumber: (body.registration_number ?? "").trim(),
      taxNumber: (body.tax_number ?? "").trim(),
      industry: (body.industry ?? "").trim(),
      website: (body.website ?? "").trim(),
      country: (body.country ?? "").trim(),
    };
  }

  try {
    const org = await createOrg(c.env, opts);
    const resp = toOrgResponse(org, "owner");
    return c.json(resp, 201);
  } catch (err) {
    if (err instanceof SlugTakenError) {
      return writeError(c, 409, "slug_taken", "slug already in use");
    }
    const msg = err instanceof Error ? err.message : String(err);
    return writeError(c, 400, "create_failed", msg);
  }
});

// ---------------------------------------------------------------------------
// GET /orgs — list orgs the user is a member of
// ---------------------------------------------------------------------------
router.get("/", requireAuth, async (c) => {
  const userId = c.get("userId");
  const rows = await listOrgsForUser(c.env, userId);
  const organizations: OrgResponse[] = rows.map((r) => toOrgResponse(r, r.role));
  return c.json({ organizations });
});

// ---------------------------------------------------------------------------
// GET /orgs/:orgID/members — list members (requireMember)
// ---------------------------------------------------------------------------
router.get("/:orgID/members", requireAuth, requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const rows = await listOrgMembers(c.env, orgId);
  const members: MemberResponse[] = rows.map(toMemberResponse);
  return c.json({ members });
});

// ---------------------------------------------------------------------------
// POST /orgs/:orgID/invitations — create invitation (requireAdmin)
// ---------------------------------------------------------------------------
router.post("/:orgID/invitations", requireAuth, requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");

  let body: CreateInviteRequest;
  try {
    body = await c.req.json<CreateInviteRequest>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !isValidEmail(email)) {
    return writeError(c, 400, "invalid_email", "invalid email address");
  }

  const role: Role = body.role || "member";
  if (!VALID_ROLES.includes(role)) {
    return writeError(
      c, 400, "invalid_role",
      "role must be one of: owner, admin, accountant, member, viewer",
    );
  }

  const plain = newRandomToken();
  const hash = hashToken(plain);
  const expiresAt = new Date(Date.now() + inviteTTLMs(c.env));

  try {
    const inv = await createInvitation(c.env, orgId, email, role, userId, hash, expiresAt);
    const frontendBase = c.env.FRONTEND_BASE_URL ?? "";
    const acceptURL = `${frontendBase}/invitations/accept?token=${plain}`;
    // Email is deferred (NoopSender) — return token+URL in response only.
    return c.json(toInviteResponse(inv, plain, acceptURL), 201);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "pending_exists") {
      return writeError(c, 409, "pending_exists", "a pending invitation for this email already exists");
    }
    return writeError(c, 500, "create_failed", "could not create invitation");
  }
});

// ---------------------------------------------------------------------------
// GET /orgs/:orgID/invitations — list pending invitations (requireAdmin)
// ---------------------------------------------------------------------------
router.get("/:orgID/invitations", requireAuth, requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");
  const rows = await listPendingInvitations(c.env, orgId);
  const invitations: InviteResponse[] = rows.map((r) => toInviteResponse(r));
  return c.json({ invitations });
});

// ---------------------------------------------------------------------------
// POST /orgs/:orgID/invitations/:inviteID/resend — rotate token (requireAdmin)
// ---------------------------------------------------------------------------
router.post("/:orgID/invitations/:inviteID/resend", requireAuth, requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");
  const inviteId = c.req.param("inviteID");

  if (!UUID_RE.test(inviteId)) {
    return writeError(c, 400, "invalid_invite_id", "invalid invitation id");
  }

  const plain = newRandomToken();
  const hash = hashToken(plain);
  const expiresAt = new Date(Date.now() + inviteTTLMs(c.env));

  const inv = await resendInvitation(c.env, orgId, inviteId, hash, expiresAt);
  if (!inv) {
    return writeError(c, 404, "not_found", "invitation not found or already consumed");
  }

  const frontendBase = c.env.FRONTEND_BASE_URL ?? "";
  const acceptURL = `${frontendBase}/invitations/accept?token=${plain}`;
  // Email is deferred (NoopSender).
  return c.json(toInviteResponse(inv, plain, acceptURL));
});

// ---------------------------------------------------------------------------
// DELETE /orgs/:orgID/invitations/:inviteID — revoke invitation (requireAdmin)
// ---------------------------------------------------------------------------
router.delete("/:orgID/invitations/:inviteID", requireAuth, requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");
  const inviteId = c.req.param("inviteID");

  if (!UUID_RE.test(inviteId)) {
    return writeError(c, 400, "invalid_invite_id", "invalid invitation id");
  }

  const ok = await revokeInvitation(c.env, orgId, inviteId);
  if (!ok) {
    return writeError(c, 404, "not_found", "invitation not found or already consumed");
  }
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// POST /orgs/:orgID/avatar — upload an org avatar image (admin only)
// PATCH /orgs/:orgID/avatar — set/clear avatar_url by value (admin only)
// ---------------------------------------------------------------------------

const ORG_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const ORG_AVATAR_MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

router.post("/:orgID/avatar", requireAuth, requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return writeError(c, 400, "invalid_upload", "could not parse form (max 2MB)");
  }

  const fileField = formData.get("file") as unknown;
  const isFileLike = (v: unknown): v is Blob =>
    v !== null && typeof v === "object" && typeof (v as Blob).arrayBuffer === "function";
  if (!fileField || !isFileLike(fileField)) {
    return writeError(c, 400, "missing_file", `expected a file under field "file"`);
  }
  const file = fileField as Blob & { type: string; size: number };

  if (file.size > ORG_AVATAR_MAX_BYTES) {
    return writeError(c, 400, "too_large", "avatar must be 2MB or smaller");
  }

  const ext = ORG_AVATAR_MIME_EXT[file.type];
  if (!ext) {
    return writeError(c, 415, "unsupported_type", "avatar must be JPG, PNG, or WebP");
  }

  let data: Uint8Array;
  try {
    data = new Uint8Array(await file.arrayBuffer());
  } catch {
    return writeError(c, 400, "read_failed", "could not read uploaded file");
  }

  const key = `orgs/${orgId}/${crypto.randomUUID()}${ext}`;
  try {
    await putObject(c.env, key, data, file.type);
  } catch {
    return writeError(c, 502, "storage_failed", "could not store avatar");
  }

  const base = c.env.APP_BASE_URL || new URL(c.req.url).origin;
  const url = `${base}/${key}`;
  return c.json({ url }, 201);
});

router.patch("/:orgID/avatar", requireAuth, requireAdmin, async (c) => {
  const orgId = c.req.param("orgID");

  let body: { avatar_url?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const avatarUrl = "avatar_url" in body
    ? (typeof body.avatar_url === "string" ? body.avatar_url.trim() || null : null)
    : undefined;

  if (avatarUrl === undefined) {
    return writeError(c, 400, "missing_field", "avatar_url is required");
  }

  const updated = await updateOrganizationAvatar(c.env, orgId, avatarUrl);
  if (!updated) {
    return writeError(c, 404, "not_found", "organization not found");
  }

  // Determine the caller's role (already set by requireAdmin middleware)
  const role = c.get("orgRole") as Role;
  return c.json(toOrgResponse(updated, role), 200);
});

// ---------------------------------------------------------------------------
// Public GET /orgs-avatars/:orgId/:filename — streams R2 object.
// Separate prefix from user avatars to avoid router collision.
// ---------------------------------------------------------------------------
export const orgAvatarRouter = new Hono<AppEnv>();
orgAvatarRouter.get("/orgs-avatars/:orgId/:filename", async (c) => {
  const orgId = c.req.param("orgId");
  const filename = c.req.param("filename");
  if (filename.includes("/") || filename.includes("..")) {
    return writeError(c, 400, "invalid_path", "bad filename");
  }
  const key = `orgs/${orgId}/${filename}`;
  const obj = await c.env.DOCS.get(key);
  if (!obj) return writeError(c, 404, "not_found", "avatar not found");
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ---------------------------------------------------------------------------
// POST /invitations/accept — consume token (requireAuth)
// GET  /invitations/pending — list pending invites for the current user (requireAuth)
// NOTE: mounted at /invitations from the parent app.
// ---------------------------------------------------------------------------
export const inviteAcceptRouter = new Hono<AppEnv>();

// GET /invitations/pending — return all non-expired pending invites for the
// authenticated user's email address.  No token required; the frontend calls
// this after every login to auto-detect invites.
inviteAcceptRouter.get("/pending", requireAuth, async (c) => {
  const userId = c.get("userId");
  const callerEmail = await getUserEmail(c.env, userId);
  if (!callerEmail) {
    return writeError(c, 500, "user_lookup_failed", "could not load caller");
  }
  const rows = await listPendingInvitationsForEmail(c.env, callerEmail);
  const invitations: PendingInviteForUserResponse[] = rows.map((r) => ({
    id: r.id,
    organization_id: r.organization_id,
    org_name: r.org_name,
    role: r.role,
    expires_at: r.expires_at,
    created_at: r.created_at,
  }));
  return c.json({ invitations });
});

inviteAcceptRouter.post("/accept", requireAuth, async (c) => {
  const userId = c.get("userId");

  let body: AcceptInviteRequest;
  try {
    body = await c.req.json<AcceptInviteRequest>();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be valid JSON");
  }

  const token = (body.token ?? "").trim();
  if (!token) {
    return writeError(c, 400, "invalid_token", "token is required");
  }

  // We need the caller's email to match against the invitation.
  const callerEmail = await getUserEmail(c.env, userId);
  if (!callerEmail) {
    return writeError(c, 500, "user_lookup_failed", "could not load caller");
  }

  let inv;
  try {
    inv = await acceptInvitationByTokenHash(c.env, hashToken(token), userId, callerEmail);
  } catch (err) {
    const e = err as { code?: string };
    switch (e.code) {
      case "not_found":
        return writeError(c, 404, "not_found", "invitation not found");
      case "expired":
        return writeError(c, 410, "expired", "invitation has expired");
      case "consumed":
        return writeError(c, 409, "consumed", "invitation already accepted or revoked");
      case "email_mismatch":
        return writeError(c, 403, "email_mismatch", "this invitation was sent to a different email address");
      default:
        return writeError(c, 500, "accept_failed", "could not accept invitation");
    }
  }

  // Fetch org for the response payload.
  const { getOrgById } = await import("./queries");
  const org = await getOrgById(c.env, inv.organization_id);
  if (!org) {
    return writeError(c, 500, "org_lookup_failed", "could not load organization");
  }

  return c.json({
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: inv.role,
      created_at: org.created_at,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /invitations/:id/accept — accept by invite ID (caller email matched
// server-side). Used by the auto-detect InvitationPrompt UI which has the
// invite id from GET /invitations/pending but not the plain token.
// ---------------------------------------------------------------------------
inviteAcceptRouter.post("/:id/accept", requireAuth, async (c) => {
  const userId = c.get("userId");
  const inviteId = c.req.param("id");

  if (!UUID_RE.test(inviteId)) {
    return writeError(c, 400, "invalid_invite_id", "invalid invitation id");
  }

  const callerEmail = await getUserEmail(c.env, userId);
  if (!callerEmail) {
    return writeError(c, 500, "user_lookup_failed", "could not load caller");
  }

  const { acceptInvitationById } = await import("./queries");
  let inv;
  try {
    inv = await acceptInvitationById(c.env, inviteId, userId, callerEmail);
  } catch (err) {
    const e = err as { code?: string };
    switch (e.code) {
      case "not_found":
        return writeError(c, 404, "not_found", "invitation not found");
      case "expired":
        return writeError(c, 410, "expired", "invitation has expired");
      case "consumed":
        return writeError(c, 409, "consumed", "invitation already accepted or revoked");
      case "email_mismatch":
        return writeError(c, 403, "email_mismatch", "this invitation was sent to a different email address");
      default:
        return writeError(c, 500, "accept_failed", "could not accept invitation");
    }
  }

  const { getOrgById } = await import("./queries");
  const org = await getOrgById(c.env, inv.organization_id);
  if (!org) {
    return writeError(c, 500, "org_lookup_failed", "could not load organization");
  }

  return c.json({
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: inv.role,
      created_at: org.created_at,
    },
  });
});

export default router;
