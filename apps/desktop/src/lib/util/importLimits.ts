/**
 * Client-side cap on a single imported file — shared by the Receipts file
 * picker and drag-and-drop capture so the two agree on the same number
 * rather than each hand-typing 50MB.
 *
 * This is a UX guard, not the source of truth for what SlipScan can import:
 * the backend's `document_import` command imposes no size limit of its own,
 * and which *extensions* are accepted lives in
 * `crates/slipscan-ingest/src/import.rs`'s `SUPPORTED_EXTENSIONS` — read
 * from there, never duplicated here.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
