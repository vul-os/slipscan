/**
 * Auth module types — ported from Go internal/auth/{handlers.go,store.go,jwt.go}.
 * Request/response shapes match the Go JSON exactly so the frontend is unaffected.
 */

// ---- Request bodies ----

export interface RegisterRequest {
  email: string;
  password: string;
  full_name?: string;
  // org fields are accepted but ignored (org creation is optional here)
  kind?: string;
  org_name?: string;
  legal_name?: string;
  registration_number?: string;
  tax_number?: string;
  industry?: string;
  website?: string;
  country?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface VerifyRequest {
  token: string;
}

export interface ResendVerifyRequest {
  email: string;
}

export interface ResetRequestBody {
  email: string;
}

export interface ResetConfirmRequest {
  token: string;
  new_password: string;
}

// ---- Response shapes ----

export interface UserResponse {
  id: string;
  email: string;
  full_name?: string;
  email_verified_at?: string; // ISO-8601 or absent
  created_at: string; // ISO-8601
}

export interface RegisterResponse {
  user: UserResponse;
  organization: null; // org creation is deferred to POST /orgs
  tokens: TokenPairResponse;
  verify_email_sent: boolean;
}

export interface AuthResponse {
  user: UserResponse;
  tokens: TokenPairResponse;
}

export interface TokenPairResponse {
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
}

// ---- Internal DB row shapes ----

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  avatar_url: string | null;
  email_verified_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}
