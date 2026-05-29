/**
 * Extract module routes — port of backend/internal/extract/handler.go.
 *
 * POST /orgs/:orgID/documents/:docID/extract
 *   Triggers (or re-triggers) the extraction pipeline for a document.
 *   Returns the new document_extractions row on success.
 *
 * Mount via:
 *   app.route("/orgs", extractRoutes);
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireMember } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import { extractDocument, getExtractionForDoc } from "./service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = new Hono<AppEnv>();

/**
 * POST /orgs/:orgID/documents/:docID/extract
 * Re-runs extraction on an existing document; returns the new extraction row.
 * Protected by requireMember (validates orgID membership, sets c.var.orgRole).
 */
router.post(
  "/:orgID/documents/:docID/extract",
  requireMember,
  async (c) => {
    const orgId = c.req.param("orgID");
    const docId = c.req.param("docID");

    if (!docId || !UUID_RE.test(docId)) {
      return writeError(c, 400, "invalid_doc_id", "invalid document id");
    }

    let extractionId: string;
    try {
      extractionId = await extractDocument(c.env, orgId, docId);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "not_found") {
        return writeError(c, 404, "not_found", "document not found");
      }
      console.error("extract route: extraction failed:", e);
      return writeError(c, 500, "extraction_failed", err.message ?? "extraction failed");
    }

    const row = await getExtractionForDoc(c.env, orgId, extractionId);
    if (!row) {
      // Extraction row was just written — should not happen.
      return writeError(c, 500, "extraction_missing", "extraction row not found after completion");
    }

    return c.json(row, 200);
  },
);

export default router;
