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
  error?: string | null;
  created_at: string;
  updated_at: string;
  /** Joined from document_extractions.extracted (current row). Null while pending. */
  extraction?: ExtractionPayload | null;
}

/** Gemini extraction payload (mirrors the JSON stored in document_extractions.extracted). */
export interface ExtractionPayload {
  // core fields (all versions)
  merchant?: string;
  date?: string;
  total?: number;
  subtotal?: number;
  tax?: number;
  currency?: string;
  payment_method?: string;
  confidence?: number;
  // v2 slip-only rich fields
  receipt_type?: string;
  merchant_normalized?: string;
  discount_total?: number;
  receipt_number?: string | null;
  items?: Array<{
    raw_text?: string;
    normalized_name?: string;
    category?: string;
    qty?: number;
    unit_price?: number;
    amount?: number;
    vat_status?: "zero-rated" | "standard" | "exempt" | "unknown";
    confidence?: number;
  }>;
  discounts?: Array<{
    raw_text?: string;
    label?: string;
    amount?: number;
    source?: "loyalty" | "promo" | "coupon" | "manager" | "other";
  }>;
  validation?: {
    sum_matches: boolean;
    computed_total: number;
    delta: number;
  };
  // legacy v1 fields (invoice/bank_statement)
  line_items?: Array<{
    description?: string;
    qty?: number;
    unit?: number;
    unit_price?: number;
    amount?: number;
    total?: number;
  }>;
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
  // Extraction surface. Top-level fields are extracted from the current
  // extraction's payload for ergonomic FE consumption; raw_extraction
  // is the full payload (items, discounts, validation, etc.).
  merchant?: string;
  amount?: number;
  currency?: string;
  transaction_date?: string;
  tax?: number;
  payment_method?: string;
  extraction_error?: string;
  // v2 rich fields surfaced at the top level for FE ergonomics
  receipt_type?: string;
  subtotal?: number;
  discount_total?: number;
  validation?: {
    sum_matches: boolean;
    computed_total: number;
    delta: number;
  };
  raw_extraction?: ExtractionPayload;
}
