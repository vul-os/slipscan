/**
 * Router Worker — slipscan API container proxy
 *
 * Forwards every request on this Worker's route to the Go monolith running in a
 * Cloudflare Container, and injects the backend's configuration (DB, storage,
 * secrets) into the container's environment at start.
 *
 * Refs: https://developers.cloudflare.com/containers/  ·  @cloudflare/containers
 */

import { Container, getContainer } from "@cloudflare/containers";

// Bindings available to the Worker/DO. Non-secret values come from [vars] in
// wrangler.toml; secrets are added with `wrangler secret put <NAME>`.
export interface Env {
  /** Container / Durable Object binding declared in wrangler.toml */
  BACKEND: DurableObjectNamespace<GoBackend>;

  // Secrets (wrangler secret put) — required by the Go server's config.Load:
  DATABASE_URL: string;
  JWT_SECRET: string;
  STORAGE_KEY_ID: string;
  STORAGE_SECRET: string;
  GEMINI_API_KEY: string;
  INBOUND_INGEST_SECRET: string;
  // Optional secrets (SES outbound email):
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;

  // Non-secret config ([vars] in wrangler.toml):
  STORAGE_ENDPOINT: string;
  STORAGE_BUCKET: string;
  STORAGE_REGION: string;
  RX_DOMAIN?: string;
  APP_BASE_URL?: string;
  FRONTEND_BASE_URL?: string;
  EXCHANGE_RATE_BASE?: string;
  EMAIL_WORKER_ENABLED?: string;
  AWS_REGION?: string;
  EMAIL_FROM?: string;
  SES_CONFIGURATION_SET?: string;
}

// Env keys forwarded into the container's process environment. Anything unset
// is simply omitted (the Go config treats a missing var the same as empty).
const CONTAINER_ENV_KEYS = [
  "DATABASE_URL",
  "JWT_SECRET",
  "STORAGE_ENDPOINT",
  "STORAGE_KEY_ID",
  "STORAGE_SECRET",
  "STORAGE_BUCKET",
  "STORAGE_REGION",
  "GEMINI_API_KEY",
  "INBOUND_INGEST_SECRET",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "EMAIL_FROM",
  "SES_CONFIGURATION_SET",
  "EMAIL_WORKER_ENABLED",
  "RX_DOMAIN",
  "APP_BASE_URL",
  "FRONTEND_BASE_URL",
  "EXCHANGE_RATE_BASE",
] as const;

/**
 * GoBackend wraps the Go monolith container (cmd/server on $PORT=8080).
 * The container needs outbound internet (Neon, R2, Gemini), so enableInternet
 * is true. Configuration is forwarded from the Worker's bindings into the
 * container env in the constructor.
 */
export class GoBackend extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const vars: Record<string, string> = { PORT: "8080" };
    const e = env as unknown as Record<string, unknown>;
    for (const key of CONTAINER_ENV_KEYS) {
      const v = e[key];
      if (typeof v === "string" && v.length > 0) vars[key] = v;
    }
    this.envVars = vars;
  }

  override onStart(): void {
    console.log("[GoBackend] container started");
  }

  override onError(error: unknown): void {
    console.error("[GoBackend] container error:", error);
    throw error;
  }
}

export default {
  // Forward the request to the singleton container; the DO stub streams the
  // response back without buffering (SSE / chunked responses survive).
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.BACKEND, "singleton").fetch(request);
  },
} satisfies ExportedHandler<Env>;
