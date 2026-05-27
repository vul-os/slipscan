/**
 * Document ingest service — transport-neutral core ported from Go
 * internal/mailrx/ingester.go + internal/mailrx/backend.go.
 *
 * Exported as a named function so both:
 *   - the HTTP handler (routes.ts)
 *   - the Cloudflare Email Worker (email() export in another module)
 * can call ingestEmail() without importing route machinery.
 *
 * Do NOT import other modules in this file.
 */
import PostalMime from "postal-mime";
import type { Env } from "../../bindings";
import { withOrg, queryRows } from "../../db/client";
import { putObject } from "../../lib/r2";
import {
  insertInboundEmail,
  insertEmailDocument,
  markEmailProcessed,
  orgByRxLocalPart,
} from "./queries";
import type { ParsedEmail, ParsedAttachment } from "./types";

// ---------------------------------------------------------------------------
// Public constants (mirrors Go ingester defaults)
// ---------------------------------------------------------------------------

const MAX_INGEST_BYTES = 25 * 1024 * 1024; // 25 MB

/** MIME types accepted as document attachments. Mirrors Go AllowedTypes. */
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);

// ---------------------------------------------------------------------------
// Public: ingestEmail
// ---------------------------------------------------------------------------

export class ErrUnknownRecipient extends Error {
  constructor(localPart: string) {
    super(`mailrx: unknown recipient: ${localPart}`);
    this.name = "ErrUnknownRecipient";
  }
}

/**
 * Ingest one inbound RFC 822 message delivered to `recipient`.
 *
 * `recipient` may be "localpart@domain" or just "localpart"; if no "@" is
 * present the caller is responsible for passing the correct local-part only.
 *
 * Steps (mirrors Go Ingester.Ingest + deliver):
 *  1. Resolve org by recipient local-part → ErrUnknownRecipient if unknown.
 *  2. Parse MIME (postal-mime); degrade gracefully on parse error.
 *  3. Store raw .eml to R2 under inbound/<orgId>/<msgId>.eml.
 *  4. INSERT inbound_emails row.
 *  5. For each allowed attachment: store to R2 + INSERT documents row.
 *  6. Mark email processed/rejected.
 */
export async function ingestEmail(
  env: Env,
  raw: Uint8Array,
  recipient: string,
): Promise<void> {
  if (raw.length > MAX_INGEST_BYTES) {
    throw new Error(`mailrx: raw message exceeds ${MAX_INGEST_BYTES} bytes`);
  }

  // 1. Resolve org by local-part.
  const localPart = extractLocalPart(recipient);

  // orgByRxLocalPart uses a plain (non-transactional) query — org lookup is
  // not org-scoped; we are resolving *which* org owns this address.
  const orgRows = await queryRows(
    env,
    "SELECT id, slug FROM organizations WHERE rx_local_part = $1",
    [localPart.toLowerCase()],
  );
  if (!orgRows.length) {
    throw new ErrUnknownRecipient(localPart);
  }
  const org = orgRows[0] as { id: string; slug: string };
  const domain = extractDomain(recipient);

  // 2. Parse MIME.
  let parsed: ParsedEmail;
  try {
    parsed = await parseMime(raw);
  } catch (err) {
    console.error("mailrx ingest: parse:", err);
    parsed = { messageId: generateFallbackMsgId(), fromAddress: "", subject: "", attachments: [] };
  }
  if (!parsed.messageId) {
    parsed = { ...parsed, messageId: generateFallbackMsgId() };
  }

  // 3 + 4 + 5 + 6 inside a single org-scoped transaction.
  await withOrg(env, org.id, null, async (q) => {
    // 3. Store raw email to R2.
    const rawKey = storageKeyForEmail(org.id, parsed.messageId);
    let rawStorageUrl: string | null = null;
    try {
      await putObject(env, rawKey, raw, "message/rfc822");
      rawStorageUrl = rawKey;
    } catch (err) {
      console.error("mailrx store raw email:", err);
    }

    // 4. INSERT inbound_emails.
    const email = await insertInboundEmail(
      q,
      org.id,
      parsed.messageId,
      parsed.fromAddress,
      localPart,
      domain,
      parsed.subject || null,
      rawStorageUrl,
      raw.length,
    );

    // 5. Process attachments.
    let savedCount = 0;
    let lastErr = "";

    for (const att of parsed.attachments) {
      const attKey = storageKeyForAttachment(org.id, extForMime(att.contentType));
      try {
        await putObject(env, attKey, att.data, att.contentType);
      } catch (err) {
        console.error(`mailrx store attachment "${att.filename}":`, err);
        lastErr = String(err);
        continue;
      }
      try {
        await insertEmailDocument(
          q,
          org.id,
          email.id,
          attKey,
          att.contentType,
          att.data.length,
          att.filename,
        );
        savedCount++;
      } catch (err) {
        console.error(`mailrx insert document "${att.filename}":`, err);
        lastErr = String(err);
      }
    }

    // 6. Mark email.
    const finalStatus =
      savedCount === 0 && parsed.attachments.length > 0 ? "rejected" : "processed";
    const finalErr =
      finalStatus === "rejected" ? `no usable attachments; ${lastErr}` : null;

    try {
      await markEmailProcessed(q, email.id, finalStatus, finalErr);
    } catch (err) {
      console.error("mailrx mark processed:", err);
    }

    console.log(
      `mailrx delivered msg=${parsed.messageId} org=${org.slug} attachments=${savedCount} status=${finalStatus}`,
    );
  });
}

// ---------------------------------------------------------------------------
// MIME parsing helpers (mirrors Go internal/mailrx/mime.go)
// ---------------------------------------------------------------------------

/**
 * Parse a raw RFC 822 message; returns only the fields the ingester needs.
 * postal-mime is used because go-message is unavailable in Workers.
 */
async function parseMime(raw: Uint8Array): Promise<ParsedEmail> {
  const email = await PostalMime.parse(raw);

  const fromAddress =
    email.from?.address ?? "";
  const subject = email.subject ?? "";
  const messageId = stripAngle(email.messageId ?? "");

  const attachments: ParsedAttachment[] = [];
  for (const att of email.attachments ?? []) {
    // Only accept attachment-disposition parts (not inline body parts).
    // postal-mime sets disposition to "inline" for text/html body parts.
    if (att.disposition === "inline" && !isDocumentMime(att.mimeType)) {
      continue;
    }
    const ct = normalizeMime(att.mimeType);
    if (!ALLOWED_ATTACHMENT_TYPES.has(ct)) {
      console.log(`mailrx parse: skipping "${att.filename}" (${ct}): not in allowed types`);
      continue;
    }
    let data: Uint8Array;
    if (att.content instanceof Uint8Array) {
      data = att.content;
    } else if (att.content instanceof ArrayBuffer) {
      data = new Uint8Array(att.content);
    } else {
      // string encoding — should not happen with default arraybuffer mode
      data = new TextEncoder().encode(att.content as string);
    }
    const filename =
      (att.filename ?? "").trim() || `attachment${extForMime(ct)}`;
    attachments.push({ filename, contentType: ct, data });
  }

  return { messageId, fromAddress, subject, attachments };
}

// ---------------------------------------------------------------------------
// Storage key helpers (mirrors Go store.go)
// ---------------------------------------------------------------------------

/** inbound/<orgId>/<safe-msgid>.eml */
function storageKeyForEmail(orgId: string, msgId: string): string {
  const now = new Date();
  const safe = sanitizeForKey(msgId);
  return `inbound/${orgId}/${now.getUTCFullYear()}/${pad2(now.getUTCMonth() + 1)}/${safe}.eml`;
}

/** documents/<orgId>/<uuid><ext> */
function storageKeyForAttachment(orgId: string, ext: string): string {
  const now = new Date();
  return `documents/${orgId}/${now.getUTCFullYear()}/${pad2(now.getUTCMonth() + 1)}/${crypto.randomUUID()}${ext}`;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Drop "; charset=..." from a Content-Type string. Mirrors Go normalizeMIME. */
export function normalizeMime(s: string): string {
  const i = s.indexOf(";");
  return (i >= 0 ? s.slice(0, i) : s).toLowerCase().trim();
}

/** Map MIME type to file extension. Mirrors Go extForMIME. */
export function extForMime(mime: string): string {
  switch (mime) {
    case "application/pdf":
      return ".pdf";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/heic":
    case "image/heif":
      return ".heic";
    default:
      return ".bin";
  }
}

/**
 * Extract the local-part from a recipient address.
 * "user@domain" → "user";  "user" → "user" (no "@" present).
 * Mirrors Go splitAddress + normalisation in Ingester.Ingest.
 */
export function extractLocalPart(addr: string): string {
  // Strip display name: "Foo <foo@bar.com>" → "foo@bar.com"
  const angle = addr.match(/<([^>]+)>$/);
  const clean = angle ? angle[1].trim() : addr.trim();
  const at = clean.lastIndexOf("@");
  return at > 0 ? clean.slice(0, at).toLowerCase() : clean.toLowerCase();
}

/** Extract the domain part; returns "" if no "@". */
export function extractDomain(addr: string): string {
  const angle = addr.match(/<([^>]+)>$/);
  const clean = angle ? angle[1].trim() : addr.trim();
  const at = clean.lastIndexOf("@");
  return at > 0 && at < clean.length - 1 ? clean.slice(at + 1).toLowerCase() : "";
}

/** SHA-256 of a Uint8Array → hex string (uses Web Crypto). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateFallbackMsgId(): string {
  return `${crypto.randomUUID()}@mailrx-generated`;
}

function stripAngle(s: string): string {
  return s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1) : s;
}

/** True if the MIME type is a document type we store (regardless of disposition). */
function isDocumentMime(mimeType: string): boolean {
  return ALLOWED_ATTACHMENT_TYPES.has(normalizeMime(mimeType));
}

function sanitizeForKey(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length && out.length < 100; i++) {
    const c = s[i];
    if (/[a-zA-Z0-9\-_.]/.test(c)) {
      out.push(c);
    } else {
      out.push("_");
    }
  }
  return out.length ? out.join("") : crypto.randomUUID();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Allowed MIME types map for upload handler (mirrors Go allowedMimes). */
export const ALLOWED_UPLOAD_MIMES: ReadonlyMap<string, string> = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["application/pdf", ".pdf"],
]);
