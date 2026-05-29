/**
 * Document module types — mirrors Go internal/document and internal/mailrx
 * row shapes. These are the DB-layer types (snake_case columns); the HTTP
 * response shapes are in routes.ts.
 */
import type { DocumentSource, DocumentKind, DocumentStatus } from "../../types/schema";

/** documents table row (subset used by this module). */
export interface DocumentRow {
  id: string;
  organization_id: string;
  uploaded_by: string | null;
  inbound_email_id: string | null;
  source: DocumentSource;
  kind: DocumentKind;
  storage_url: string;
  mime_type: string;
  size_bytes: number;
  original_name: string | null;
  status: DocumentStatus;
  created_at: string;
  updated_at: string;
}

/** inbound_emails table row (subset used by the ingester). */
export interface InboundEmailRow {
  id: string;
  organization_id: string | null;
  message_id: string;
  from_address: string;
  recipient_local_part: string;
  recipient_domain: string;
  subject: string | null;
  raw_storage_url: string | null;
  size_bytes: number;
  status: string; // received | processed | rejected | failed
  created_at: string;
  updated_at: string;
}

/** Parsed attachment ready for R2 + DB write. */
export interface ParsedAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/** Result of parseInboundEmail(). */
export interface ParsedEmail {
  messageId: string;
  fromAddress: string;
  subject: string;
  attachments: ParsedAttachment[];
}

/** HTTP response shape returned to callers (mirrors Go documentResponse). */
export interface DocumentResponse {
  id: string;
  organization_id: string;
  uploaded_by?: string;
  object_key: string;
  image_url?: string;
  mime_type?: string;
  status: string;
  created_at: string;
  updated_at: string;
}
