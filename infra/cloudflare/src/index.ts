/**
 * Router Worker — slipscan API container proxy
 *
 * Routes every incoming request on api.slipscan.app/* through to the Go
 * monolith running inside a Cloudflare Container.
 *
 * API reference used:
 *   https://developers.cloudflare.com/containers/container-package/
 *   https://developers.cloudflare.com/containers/get-started/
 *
 * Container binding pattern (verified from CF docs, 2026-05):
 *   - Import { Container, getContainer } from "@cloudflare/containers"
 *   - Subclass Container; set defaultPort to match $PORT in the Go binary (8080).
 *   - Use getContainer(binding, name).fetch(request) to forward the request.
 *     getContainer returns a DurableObjectStub; calling .fetch() on it:
 *       1. Boots the container if it isn't running.
 *       2. Waits for the health-check port (pingEndpoint) to be ready.
 *       3. Streams the HTTP response back — this preserves chunked transfer
 *          encoding and SSE (no response body buffering occurs in the DO stub).
 *
 * Streaming / SSE note:
 *   DurableObjectStub.fetch() returns the Response as a stream; the Worker
 *   runtime forwards it without buffering, so SSE and chunked responses used
 *   by the chat endpoints pass through correctly.
 */

import { Container, getContainer } from "@cloudflare/containers";

// ── Environment type ──────────────────────────────────────────────────────────
export interface Env {
  /** Container / DO binding declared in wrangler.toml */
  BACKEND: DurableObjectNamespace<GoBackend>;
}

// ── Container class ───────────────────────────────────────────────────────────

/**
 * GoBackend wraps the Go monolith container.
 *
 * defaultPort   — must match the $PORT the Go binary listens on (default 8080).
 * pingEndpoint  — CF polls this path to determine when the container is ready.
 *                 The Go server exposes GET /healthz (confirmed by the backend
 *                 agent); we strip the leading "/" because pingEndpoint is a
 *                 relative path, not a URL path component.
 * sleepAfter    — keeps the container alive for 10 minutes after the last
 *                 request; tune to balance cold-start latency vs cost.
 * envVars       — static env passed at container start.  Secrets are injected
 *                 by Cloudflare as worker secrets and must be forwarded as env
 *                 vars; see README.md for the full list and the container env
 *                 injection method.
 */
export class GoBackend extends Container {
  defaultPort  = 8080;
  pingEndpoint = "healthz"; // GET /healthz — CF prepends "/"
  sleepAfter   = "10m";

  override onStart(): void {
    console.log("[GoBackend] container started");
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: "exit" | "runtime_signal" }): void {
    console.log(`[GoBackend] container stopped: exitCode=${exitCode} reason=${reason}`);
  }

  override onError(error: unknown): void {
    console.error("[GoBackend] container error:", error);
    throw error; // re-throw so CF retries / surfaces the error
  }
}

// ── Worker entry point ────────────────────────────────────────────────────────

export default {
  /**
   * fetch — forward every request to the singleton container instance.
   *
   * We use a single named instance ("singleton") so all traffic shares one
   * container.  To scale horizontally, switch to getRandom() from
   * @cloudflare/containers and increase max_instances in wrangler.toml.
   *
   * Request forwarding preserves:
   *   - Method, URL (path + query string)
   *   - All request headers
   *   - Request body (streaming, so large uploads work)
   *   - Response headers and status
   *   - Response body stream (SSE / chunked transfer-encoding not broken)
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = getContainer(env.BACKEND, "singleton");
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
