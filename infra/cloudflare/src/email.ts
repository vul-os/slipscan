/**
 * Email Worker — slipscan inbound RFC-822 ingestion
 *
 * Cloudflare Email Routing calls the email() handler when an email arrives
 * for a routing rule that targets this Worker.  We collect the raw RFC-822
 * bytes from message.raw (a ReadableStream) and POST them to the Go monolith's
 * /internal/inbound-email endpoint.
 *
 * API references verified from CF docs (2026-05):
 *   Runtime API: https://developers.cloudflare.com/email-routing/email-workers/runtime-api/
 *   ForwardableEmailMessage interface:
 *     { from: string; to: string; headers: Headers;
 *       raw: ReadableStream; rawSize: number;
 *       setReject(reason: string): void;
 *       forward(rcptTo: string, headers?: Headers): Promise<void>;
 *       reply(message: EmailMessage): Promise<void>; }
 *
 * Contract with the Go backend (fixed by backend agent — do NOT change):
 *   POST  ${INGEST_BASE_URL}/internal/inbound-email?recipient=<encoded-to>
 *   Header: X-Inbound-Secret: <INBOUND_INGEST_SECRET>
 *   Header: Content-Type: message/rfc822
 *   Body:   raw RFC-822 bytes
 *
 * On non-2xx response this handler throws, causing Cloudflare to retry and
 * (if retries are exhausted) return a transient SMTP failure to the sender —
 * mail is NOT silently dropped.
 */

/** Maximum accepted message size: 25 MB (matches typical MTA limit). */
const MAX_RAW_SIZE_BYTES = 25 * 1024 * 1024;

// ── Environment type ──────────────────────────────────────────────────────────

interface EmailEnv {
  /** Base URL of the Go API, e.g. https://api.slipscan.app */
  INGEST_BASE_URL: string;
  /** Shared secret verified by Go's /internal/inbound-email handler */
  INBOUND_INGEST_SECRET: string;
}

// ── Minimal ForwardableEmailMessage type ─────────────────────────────────────
// CF's runtime provides this but the Workers type package may not export it
// under this name; we declare what we need.

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

// ── Email handler ─────────────────────────────────────────────────────────────

export default {
  async email(
    message: ForwardableEmailMessage,
    env: EmailEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    // 1. Enforce size guard before reading the stream.
    if (message.rawSize > MAX_RAW_SIZE_BYTES) {
      message.setReject(
        `Message too large: ${message.rawSize} bytes exceeds ${MAX_RAW_SIZE_BYTES} byte limit`,
      );
      return;
    }

    // 2. Collect the raw RFC-822 stream into an ArrayBuffer.
    //    We wrap the ReadableStream in a Response so we can call .arrayBuffer()
    //    without pulling the stream manually (same pattern shown in CF docs).
    const rawBuffer = await new Response(message.raw).arrayBuffer();

    // 3. Build the ingest URL with the encoded recipient address.
    const ingestUrl = new URL("/internal/inbound-email", env.INGEST_BASE_URL);
    ingestUrl.searchParams.set("recipient", message.to);

    // 4. POST to the Go backend.
    const resp = await fetch(ingestUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        "X-Inbound-Secret": env.INBOUND_INGEST_SECRET,
      },
      body: rawBuffer,
    });

    // 5. Throw on non-2xx so CF Email Routing retries / notifies the sender.
    if (!resp.ok) {
      const text = await resp.text().catch(() => "(no body)");
      throw new Error(
        `Ingest endpoint returned ${resp.status}: ${text}`,
      );
    }
  },
} satisfies ExportedHandler<EmailEnv>;
