/**
 * Public /v1 API router — API-token authenticated, not JWT.
 *
 * Mounts at "/" (integrator mounts at "/"):
 *   POST /v1/orgs/:orgID/documents      — ingest document (scope: documents:write)
 *   GET  /v1/orgs/:orgID/transactions   — list transactions (scope: transactions:read)
 *
 * Shapes/status/error codes match Go internal/apitokens/v1handlers.go exactly.
 * Stable v1 contract: field names and removals require an API version bump.
 */
import { Hono } from "hono";
import { requireApiToken } from "./middleware";
import type { ApiTokenEnv } from "./middleware";
import { putObject } from "../../lib/r2";
import { writeError } from "../../lib/errors";
import { queryRows } from "../../db/client";
import { ScopeDocumentsWrite, ScopeTransactionsRead } from "./types";

const V1_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const V1_ALLOWED_MIMES = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["application/pdf", ".pdf"],
]);

function normalizeMime(s: string): string {
  const i = s.indexOf(";");
  return (i >= 0 ? s.slice(0, i) : s).toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<ApiTokenEnv>();

// ---- POST /v1/orgs/:orgID/documents ----
//
// Accepts multipart/form-data with a "file" field.
// Persists with source='api', status='pending'.
// Mirrors Go V1Handler.CreateDocument.
router.post(
  "/v1/orgs/:orgID/documents",
  requireApiToken(ScopeDocumentsWrite),
  async (c) => {
    const tok = c.get("apiToken");
    if (!tok) {
      return writeError(c, 401, "missing_token", "API token required");
    }
    // Belt-and-suspenders scope check (middleware already enforced this).
    if (!tok.scopes.includes(ScopeDocumentsWrite)) {
      return writeError(c, 403, "insufficient_scope", `token requires '${ScopeDocumentsWrite}' scope`);
    }

    const orgId = tok.organization_id;

    // Parse multipart form.
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return writeError(c, 400, "invalid_upload", "could not parse multipart form (max 10 MB)");
    }

    const fileField = formData.get("file") as unknown;
    const isFileLike = (v: unknown): v is Blob =>
      v !== null && typeof v === "object" && typeof (v as Blob).arrayBuffer === "function";

    if (!fileField || !isFileLike(fileField)) {
      return writeError(c, 400, "missing_file", `expected a file under field "file"`);
    }
    const file = fileField as Blob & { name?: string; type: string; size: number };

    if (file.size > V1_MAX_UPLOAD_BYTES) {
      return writeError(c, 400, "invalid_upload", "could not parse multipart form (max 10 MB)");
    }

    let data: Uint8Array;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch {
      return writeError(c, 400, "read_failed", "could not read uploaded file");
    }

    const mime = normalizeMime(file.type || "");
    const ext = V1_ALLOWED_MIMES.get(mime);
    if (!ext) {
      return writeError(
        c,
        415,
        "unsupported_type",
        "file must be image/jpeg, image/png, image/webp, image/heic, or application/pdf",
      );
    }

    // Object key mirrors Go: org/<orgId>/<YYYY>/<MM>/<uuid><ext>
    const now = new Date();
    const docId = crypto.randomUUID();
    const objectKey = `org/${orgId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${docId}${ext}`;

    try {
      await putObject(c.env, objectKey, data, mime);
    } catch {
      return writeError(c, 502, "storage_failed", "could not store file");
    }

    const originalName = (file as { name?: string }).name ?? null;

    let createdAt: string;
    try {
      const rows = await queryRows(
        c.env,
        `INSERT INTO documents
           (id, organization_id, source, storage_url, mime_type, size_bytes,
            original_name, status)
         VALUES ($1, $2, 'api', $3, $4, $5, $6, 'pending')
         RETURNING id::text, created_at`,
        [docId, orgId, objectKey, mime, data.length, originalName],
      );
      createdAt = rows[0].created_at instanceof Date
        ? (rows[0].created_at as Date).toISOString()
        : String(rows[0].created_at);
    } catch (err) {
      console.error("v1 documents create: save failed:", err);
      return writeError(c, 500, "save_failed", "could not save document");
    }

    return c.json(
      {
        id: docId,
        organization_id: orgId,
        source: "api",
        status: "pending",
        storage_url: objectKey,
        mime_type: mime,
        size_bytes: data.length,
        original_name: originalName ?? undefined,
        created_at: createdAt,
      },
      201,
    );
  },
);

// ---- GET /v1/orgs/:orgID/transactions ----
//
// Stable paginated shape. Mirrors Go V1Handler.ListTransactions.
// Version: v1 — do not change field names or remove fields without bumping.
router.get(
  "/v1/orgs/:orgID/transactions",
  requireApiToken(ScopeTransactionsRead),
  async (c) => {
    const tok = c.get("apiToken");
    if (!tok) {
      return writeError(c, 401, "missing_token", "API token required");
    }
    if (!tok.scopes.includes(ScopeTransactionsRead)) {
      return writeError(c, 403, "insufficient_scope", `token requires '${ScopeTransactionsRead}' scope`);
    }

    const orgId = tok.organization_id;

    let limit = 50;
    let offset = 0;
    const limitParam = c.req.query("limit");
    if (limitParam) {
      const n = parseInt(limitParam, 10);
      if (!isNaN(n) && n > 0 && n <= 200) limit = n;
    }
    const offsetParam = c.req.query("offset");
    if (offsetParam) {
      const n = parseInt(offsetParam, 10);
      if (!isNaN(n) && n >= 0) offset = n;
    }

    let txns: unknown[];
    try {
      const rows = await queryRows(
        c.env,
        `SELECT
           t.id::text,
           t.organization_id::text,
           t.document_id::text,
           t.merchant,
           t.description,
           t.amount,
           t.currency,
           t.posted_date,
           t.direction,
           t.status,
           c.name AS category_name
         FROM transactions t
         LEFT JOIN transaction_classifications tc
           ON tc.id = t.current_classification_id
         LEFT JOIN categories c
           ON c.id = tc.category_id
         WHERE t.organization_id = $1
         ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC
         LIMIT $2 OFFSET $3`,
        [orgId, limit, offset],
      );

      txns = rows.map((r) => {
        const txn: Record<string, unknown> = {
          id: r.id,
          organization_id: r.organization_id,
          direction: r.direction,
          status: r.status,
        };
        if (r.document_id != null) txn.document_id = r.document_id;
        if (r.merchant != null) txn.merchant = r.merchant;
        if (r.description != null) txn.description = r.description;
        if (r.amount != null) txn.amount = Number(r.amount);
        if (r.currency != null) txn.currency = (r.currency as string).trim();
        if (r.posted_date != null) {
          const d = r.posted_date instanceof Date
            ? (r.posted_date as Date).toISOString().slice(0, 10)
            : String(r.posted_date).slice(0, 10);
          txn.posted_date = d;
        }
        if (r.category_name != null) txn.category_name = r.category_name;
        return txn;
      });
    } catch (err) {
      console.error("v1 transactions list:", err);
      return writeError(c, 500, "list_failed", "could not list transactions");
    }

    return c.json({ transactions: txns, limit, offset });
  },
);

export default router;
