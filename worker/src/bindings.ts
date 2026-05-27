/**
 * Worker bindings + env. Mirrors the env vars consumed by the Go
 * `internal/config/config.go`, split into Cloudflare bindings, secrets, and
 * non-secret vars.
 */
export interface Env {
  // ---- Cloudflare bindings ----
  DOCS: R2Bucket; // object storage (documents + raw emails)
  RATE_LIMIT?: KVNamespace; // API-token rate limiting (Wave 3)

  // ---- Secrets (wrangler secret put) ----
  DATABASE_URL: string; // Neon connection string
  JWT_SECRET: string; // HS256 signing key (>=32 chars)
  GEMINI_API_KEY: string;
  INBOUND_INGEST_SECRET?: string; // gates POST /internal/inbound-email

  // SES (outbound email) — optional; NoopSender when absent
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  EMAIL_FROM?: string;
  SES_CONFIGURATION_SET?: string;

  // R2 S3 creds — only needed for presigned URLs via aws4fetch (optional;
  // default download path proxies through the Worker).
  STORAGE_ENDPOINT?: string;
  STORAGE_KEY_ID?: string;
  STORAGE_SECRET?: string;
  STORAGE_BUCKET?: string;

  // Integrations (optional — features disabled when unset)
  STITCH_CLIENT_ID?: string;
  STITCH_CLIENT_SECRET?: string;
  STITCH_REDIRECT_URL?: string;
  STITCH_WEBHOOK_SECRET?: string;
  XERO_CLIENT_ID?: string;
  XERO_CLIENT_SECRET?: string;
  XERO_REDIRECT_URL?: string;
  EXCHANGE_RATE_API_KEY?: string;

  // ---- Non-secret vars (wrangler.toml [vars]) ----
  RX_DOMAIN?: string;
  APP_BASE_URL?: string;
  FRONTEND_BASE_URL?: string;
  EXCHANGE_RATE_BASE?: string;
  CORS_ALLOWED_ORIGINS?: string;
  // TTLs (Go defaults: access 15m, refresh 168h, invite 168h)
  JWT_ACCESS_TTL?: string;
  JWT_REFRESH_TTL?: string;
  INVITATION_TTL?: string;
}
