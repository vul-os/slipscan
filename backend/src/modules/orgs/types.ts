/**
 * Org + invite module types — ported from Go internal/org and internal/invite.
 * Request/response shapes match the Go JSON exactly so the frontend is unaffected.
 */
import type { Role, OrganizationKind } from "../../types/schema";

// ---- Org request / response ----

export interface CreateOrgRequest {
  kind: OrganizationKind;
  name: string;
  full_name?: string;
  // Business-only
  legal_name?: string;
  registration_number?: string;
  tax_number?: string;
  industry?: string;
  website?: string;
  country?: string;
}

export interface OrgResponse {
  id: string;
  kind: OrganizationKind;
  name: string;
  slug: string;
  rx_local_part: string;
  currency: string;
  role: Role;
  created_at: string;
  avatar_url?: string | null;
}

export interface MemberResponse {
  user_id: string;
  email: string;
  full_name?: string;
  role: Role;
  joined_at: string;
}

// ---- Invitation request / response ----

export interface CreateInviteRequest {
  email: string;
  role?: Role;
}

export interface InviteResponse {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
  created_at: string;
  accept_url?: string;
  token?: string;
}

export interface AcceptInviteRequest {
  token: string;
}

export interface AcceptOrgShape {
  id: string;
  name: string;
  slug: string;
  role: Role;
  created_at: string;
}

export interface AcceptResponse {
  organization: AcceptOrgShape;
}

export interface PendingInviteForUserResponse {
  id: string;
  organization_id: string;
  org_name: string;
  role: Role;
  expires_at: string;
  created_at: string;
}

// ---- Internal DB row shapes ----

export interface OrgRow {
  id: string;
  kind: OrganizationKind;
  name: string;
  slug: string;
  rx_local_part: string;
  currency: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  avatar_url?: string | null;
}

export interface MemberRow {
  user_id: string;
  email: string;
  full_name: string | null;
  role: Role;
  joined_at: string;
}

export interface OrgWithRoleRow extends OrgRow {
  role: Role;
  joined_at: string;
}

export interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: Role;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
}
