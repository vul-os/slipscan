/**
 * Raw parameterized SQL — ported 1:1 from Go internal/document/store.go and
 * internal/mailrx/store.go. Every query includes WHERE organization_id = $
 * (belt-and-suspenders; the DB also enforces RLS when running as a non-owner).
 */
import type { Query } from "../../db/client";
import type { DocumentRow, InboundEmailRow } from "./types";

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/**
 * INSERT a documents row for an uploaded file.
 * Mirrors Go Store.Create (source='upload', kind='unknown').
 */
export async function insertUploadDocument(
  q: Query,
  orgId: string,
  uploadedBy: string,
  storageUrl: string,
  mimeType: string,
  sizeBytes: number,
  originalName: string | null,
): Promise<DocumentRow> {
  const rows = await q(
    `INSERT INTO documents (
       organization_id, uploaded_by, source, kind,
       storage_url, mime_type, size_bytes, original_name, status
     ) VALUES ($1, $2, 'upload', 'unknown', $3, $4, $5, $6, 'pending')
     RETURNING
       id, organization_id, uploaded_by, inbound_email_id, source, kind,
       storage_url, COALESCE(mime_type,'') AS mime_type,
       COALESCE(size_bytes,0) AS size_bytes, original_name, status,
       created_at, updated_at`,
    [orgId, uploadedBy, storageUrl, mimeType || null, sizeBytes || null, originalName],
  );
  return rows[0] as unknown as DocumentRow;
}

/**
 * INSERT a documents row for an email attachment.
 * Mirrors Go Store.InsertDocument (source='email', kind='unknown').
 */
export async function insertEmailDocument(
  q: Query,
  orgId: string,
  inboundEmailId: string,
  storageUrl: string,
  mimeType: string,
  sizeBytes: number,
  originalName: string,
): Promise<DocumentRow> {
  const rows = await q(
    `INSERT INTO documents (
       organization_id, inbound_email_id, source, kind,
       storage_url, mime_type, size_bytes, original_name, status
     ) VALUES ($1, $2, 'email', 'unknown', $3, $4, $5, $6, 'pending')
     RETURNING
       id, organization_id, uploaded_by, inbound_email_id, source, kind,
       storage_url, COALESCE(mime_type,'') AS mime_type,
       COALESCE(size_bytes,0) AS size_bytes, original_name, status,
       created_at, updated_at`,
    [orgId, inboundEmailId, storageUrl, mimeType || null, sizeBytes || null, originalName || null],
  );
  return rows[0] as unknown as DocumentRow;
}

/**
 * SELECT documents for org, newest first.
 * Mirrors Go Store.ListByOrg.
 */
export async function listDocuments(
  q: Query,
  orgId: string,
  limit: number,
): Promise<DocumentRow[]> {
  const safeLimit = limit > 0 && limit <= 200 ? limit : 50;
  const rows = await q(
    `SELECT id, organization_id, uploaded_by, inbound_email_id, source, kind,
            storage_url, COALESCE(mime_type,'') AS mime_type,
            COALESCE(size_bytes,0) AS size_bytes, original_name, status,
            created_at, updated_at
     FROM documents
     WHERE organization_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [orgId, safeLimit],
  );
  return rows as unknown as DocumentRow[];
}

/**
 * SELECT one document by id+org (org check prevents cross-tenant access).
 * Mirrors Go Store.GetByID.
 */
export async function getDocument(
  q: Query,
  docId: string,
  orgId: string,
): Promise<DocumentRow | null> {
  const rows = await q(
    `SELECT d.id, d.organization_id, d.uploaded_by, d.inbound_email_id, d.source, d.kind,
            d.storage_url, COALESCE(d.mime_type,'') AS mime_type,
            COALESCE(d.size_bytes,0) AS size_bytes, d.original_name, d.status,
            d.error, d.created_at, d.updated_at,
            e.extracted AS extraction
     FROM documents d
     LEFT JOIN document_extractions e
       ON e.document_id = d.id AND e.is_current = TRUE
     WHERE d.id = $1 AND d.organization_id = $2`,
    [docId, orgId],
  );
  return rows.length ? (rows[0] as unknown as DocumentRow) : null;
}

// ---------------------------------------------------------------------------
// inbound_emails
// ---------------------------------------------------------------------------

/**
 * INSERT an inbound_emails row.
 * Mirrors Go Store.InsertInboundEmail.
 */
export async function insertInboundEmail(
  q: Query,
  orgId: string,
  messageId: string,
  fromAddress: string,
  recipientLocalPart: string,
  recipientDomain: string,
  subject: string | null,
  rawStorageUrl: string | null,
  sizeBytes: number,
): Promise<InboundEmailRow> {
  const rows = await q(
    `INSERT INTO inbound_emails (
       organization_id, message_id,
       from_address, recipient_local_part, recipient_domain,
       subject, raw_storage_url, size_bytes, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received')
     RETURNING
       id, organization_id, message_id, from_address,
       recipient_local_part, recipient_domain, subject,
       raw_storage_url, COALESCE(size_bytes,0) AS size_bytes,
       status, created_at, updated_at`,
    [
      orgId,
      messageId,
      fromAddress,
      recipientLocalPart,
      recipientDomain,
      subject || null,
      rawStorageUrl || null,
      sizeBytes || null,
    ],
  );
  return rows[0] as unknown as InboundEmailRow;
}

/**
 * UPDATE inbound_emails.status to processed/rejected/failed.
 * Mirrors Go Store.MarkEmailProcessed.
 */
export async function markEmailProcessed(
  q: Query,
  emailId: string,
  status: string,
  errorMsg: string | null,
): Promise<void> {
  const processedAt =
    status === "processed" || status === "rejected" ? new Date().toISOString() : null;
  await q(
    `UPDATE inbound_emails
     SET status = $2, processed_at = $3, error = $4
     WHERE id = $1`,
    [emailId, status, processedAt, errorMsg || null],
  );
}

/**
 * Resolve an organization by rx_local_part.
 * Used by the ingester to identify the recipient org.
 */
export async function orgByRxLocalPart(
  q: Query,
  localPart: string,
): Promise<{ id: string; slug: string } | null> {
  const rows = await q(
    `SELECT id, slug FROM organizations WHERE rx_local_part = $1`,
    [localPart.toLowerCase()],
  );
  return rows.length ? (rows[0] as unknown as { id: string; slug: string }) : null;
}
