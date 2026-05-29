/**
 * Documents module — Hono router.
 *
 * Mounts at /orgs/:orgID/documents (called from index.ts):
 *   POST   /orgs/:orgID/documents          upload handler
 *   GET    /orgs/:orgID/documents          list handler
 *   GET    /orgs/:orgID/documents/:docID   get handler
 *
 * Internal (no auth middleware, secret-gated):
 *   POST   /internal/inbound-email         mailrx HTTP ingest
 *
 * All shapes/status codes match Go exactly (document.handlers.go +
 * cmd/server/main.go inboundEmailHandler).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireAuth } from "../../middleware/auth";
import { requireMember } from "../../middleware/org";
import { withOrg, queryRows } from "../../db/client";
import { putObject, deleteObject } from "../../lib/r2";
import { writeError } from "../../lib/errors";
import {
  insertUploadDocument,
  listDocuments,
  getDocument,
} from "./queries";
import { ingestEmail, ErrUnknownRecipient, ALLOWED_UPLOAD_MIMES, normalizeMime, sha256Hex } from "./service";
import type { DocumentRow, DocumentResponse } from "./types";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function toResponse(d: DocumentRow, imageUrl?: string): DocumentResponse {
  const r: DocumentResponse = {
    id: d.id,
    organization_id: d.organization_id,
    object_key: d.storage_url,
    mime_type: d.mime_type || undefined,
    status: d.status,
    created_at: typeof d.created_at === "string" ? d.created_at : new Date(d.created_at as unknown as string).toISOString(),
    updated_at: typeof d.updated_at === "string" ? d.updated_at : new Date(d.updated_at as unknown as string).toISOString(),
  };
  if (d.uploaded_by) r.uploaded_by = d.uploaded_by;
  if (imageUrl) r.image_url = imageUrl;
  return r;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<AppEnv>();

// ---- POST /orgs/:orgID/documents ----
router.post(
  "/orgs/:orgID/documents",
  requireAuth,
  requireMember,
  async (c) => {
    const orgId = c.req.param("orgID");
    const userId = c.get("userId");

    // Parse multipart form.
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return writeError(c, 400, "invalid_upload", "could not parse multipart form (max 10MB)");
    }

    // CF workers-types declares FormData.get() as string|null, but at runtime
    // it returns string|File|null for multipart forms. We cast via unknown.
    const fileField = formData.get("file") as unknown;
    // A File is a Blob with a name; check for arrayBuffer method as discriminator.
    const isFileLike = (v: unknown): v is Blob =>
      v !== null && typeof v === "object" && typeof (v as Blob).arrayBuffer === "function";

    if (!fileField || !isFileLike(fileField)) {
      return writeError(c, 400, "missing_file", `expected a file under field "file"`);
    }
    const file = fileField as Blob & { name?: string; type: string; size: number };

    if (file.size > MAX_UPLOAD_BYTES) {
      return writeError(c, 400, "invalid_upload", "could not parse multipart form (max 10MB)");
    }

    let data: Uint8Array;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch {
      return writeError(c, 400, "read_failed", "could not read uploaded file");
    }

    const mime = normalizeMime(file.type || "");
    const ext = ALLOWED_UPLOAD_MIMES.get(mime);
    if (!ext) {
      return writeError(
        c,
        415,
        "unsupported_type",
        "file must be image/jpeg, image/png, image/webp, image/heic, or application/pdf",
      );
    }

    // Object key: documents/<orgId>/<YYYY>/<MM>/<uuid><ext>
    const now = new Date();
    const objectKey = `documents/${orgId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}${ext}`;

    try {
      await putObject(c.env, objectKey, data, mime);
    } catch {
      return writeError(c, 502, "storage_failed", "could not store file");
    }

    let doc: DocumentRow;
    try {
      doc = await withOrg(c.env, orgId, userId, async (q) => {
        const originalName = (file as { name?: string }).name ?? null;
        return insertUploadDocument(
          q,
          orgId,
          userId,
          objectKey,
          mime,
          data.length,
          originalName,
        );
      });
    } catch (err) {
      // Best-effort cleanup of orphaned R2 object.
      void deleteObject(c.env, objectKey).catch(() => {});
      console.error("documents upload: save failed:", err);
      return writeError(c, 500, "save_failed", "could not save document");
    }

    return c.json(toResponse(doc), 201);
  },
);

// ---- GET /orgs/:orgID/documents ----
router.get(
  "/orgs/:orgID/documents",
  requireAuth,
  requireMember,
  async (c) => {
    const orgId = c.req.param("orgID");

    let limit = 50;
    const limitParam = c.req.query("limit");
    if (limitParam) {
      const n = parseInt(limitParam, 10);
      if (!isNaN(n)) limit = n;
    }

    let docs: DocumentRow[];
    try {
      docs = await withOrg(c.env, orgId, c.get("userId"), async (q) => {
        return listDocuments(q, orgId, limit);
      });
    } catch (err) {
      console.error("documents list:", err);
      return writeError(c, 500, "list_failed", "could not list documents");
    }

    return c.json({ documents: docs.map((d) => toResponse(d)) });
  },
);

// ---- GET /orgs/:orgID/documents/:docID ----
router.get(
  "/orgs/:orgID/documents/:docID",
  requireAuth,
  requireMember,
  async (c) => {
    const orgId = c.req.param("orgID");
    const docId = c.req.param("docID");

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(docId)) {
      return writeError(c, 400, "invalid_doc_id", "invalid document id");
    }

    let doc: DocumentRow | null;
    try {
      doc = await withOrg(c.env, orgId, c.get("userId"), async (q) => {
        return getDocument(q, docId, orgId);
      });
    } catch (err) {
      console.error("documents get:", err);
      return writeError(c, 500, "lookup_failed", "could not load document");
    }

    if (!doc) {
      return writeError(c, 404, "not_found", "document not found");
    }

    return c.json(toResponse(doc));
  },
);

// ---- POST /internal/inbound-email ----
// Mounted at the app root (not under /orgs/), so this route is registered as
// a standalone handler. See comment in index.ts mounting instructions.
router.post("/internal/inbound-email", async (c) => {
  // Gate 1: env must have the secret set; if not → 404 (route disabled).
  const secret = c.env.INBOUND_INGEST_SECRET;
  if (!secret) {
    return writeError(c, 404, "not_found", "not found");
  }

  // Gate 2: request must carry the matching header.
  if (c.req.header("X-Inbound-Secret") !== secret) {
    return writeError(c, 401, "unauthorized", "unauthorized");
  }

  // Recipient from query param.
  const recipient = c.req.query("recipient") ?? "";
  if (!recipient) {
    return writeError(c, 400, "missing_recipient", "missing recipient query parameter");
  }

  // Read body (raw RFC 822).
  let raw: Uint8Array;
  try {
    const buf = await c.req.arrayBuffer();
    raw = new Uint8Array(buf);
  } catch {
    return writeError(c, 413, "body_too_large", "request body too large or unreadable");
  }
  if (!raw.length) {
    return writeError(c, 400, "empty_body", "empty request body");
  }

  try {
    await ingestEmail(c.env, raw, recipient);
  } catch (err) {
    if (err instanceof ErrUnknownRecipient) {
      return writeError(c, 400, "unknown_recipient", err.message);
    }
    console.error("inbound-email ingest:", err);
    return writeError(c, 500, "internal_error", "internal error");
  }

  return c.body(null, 202);
});

export default router;
