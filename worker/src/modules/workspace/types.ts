/**
 * Workspace module types — port of Go backend/internal/workspace/store.go.
 */
import type { OrganizationKind, Role } from "../../types/schema";

export interface Attention {
  unverified_transactions: number;
  unmatched_lines: number;
  pending_documents: number;
  suggested_matches: number;
}

export interface OrgEntry {
  id: string;
  name: string;
  kind: OrganizationKind;
  role: Role;
  attention: Attention;
}
