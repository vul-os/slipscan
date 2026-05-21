package extract

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// Store handles all DB writes for the extraction pipeline.
type Store struct{ db *sql.DB }

// NewStore constructs an extraction Store.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// docRow is the minimal fields we need from documents.
type docRow struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Kind           string
	Status         string
	StorageURL     string
	MimeType       sql.NullString
}

// GetDocument fetches the minimal document row needed for extraction.
func (s *Store) GetDocument(ctx context.Context, docID, orgID uuid.UUID) (*docRow, error) {
	const q = `
		SELECT id, organization_id, kind, status, storage_url, mime_type
		FROM documents
		WHERE id = $1 AND organization_id = $2
	`
	var d docRow
	err := s.db.QueryRowContext(ctx, q, docID, orgID).Scan(
		&d.ID, &d.OrganizationID, &d.Kind, &d.Status, &d.StorageURL, &d.MimeType,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("document not found")
		}
		return nil, err
	}
	return &d, nil
}

// OrgCurrency returns the default currency for an org.
func (s *Store) OrgCurrency(ctx context.Context, orgID uuid.UUID) (string, error) {
	var currency string
	err := s.db.QueryRowContext(ctx, `SELECT currency FROM organizations WHERE id = $1`, orgID).Scan(&currency)
	if err != nil {
		return "ZAR", err
	}
	return currency, nil
}

// SetDocumentStatus transitions documents.status and optionally clears/sets
// documents.kind and documents.error.
func (s *Store) SetDocumentStatus(ctx context.Context, docID uuid.UUID, status DocumentStatus, kind DocumentKind, errMsg string) error {
	const q = `
		UPDATE documents
		SET status = $2, kind = $3, error = NULLIF($4, '')
		WHERE id = $1
	`
	_, err := s.db.ExecContext(ctx, q, docID, string(status), string(kind), errMsg)
	return err
}

// EnsureAIModel upserts the extraction model record into ai_models and returns
// its UUID. Uses INSERT … ON CONFLICT DO NOTHING + a SELECT so it is safe
// to call on every request.
func (s *Store) EnsureAIModel(ctx context.Context, providerName, modelID, displayName string) (uuid.UUID, error) {
	const upsert = `
		INSERT INTO ai_models (provider, model_id, display_name, kind, is_default, is_active)
		VALUES ($1, $2, $3, 'extraction', false, true)
		ON CONFLICT (provider, model_id, kind) DO NOTHING
	`
	if _, err := s.db.ExecContext(ctx, upsert, providerName, modelID, displayName); err != nil {
		return uuid.Nil, fmt.Errorf("upsert ai_model: %w", err)
	}
	var id uuid.UUID
	err := s.db.QueryRowContext(ctx,
		`SELECT id FROM ai_models WHERE provider = $1 AND model_id = $2 AND kind = 'extraction'`,
		providerName, modelID,
	).Scan(&id)
	return id, err
}

// CreateAIRun inserts an ai_runs row in 'running' state and returns its ID.
func (s *Store) CreateAIRun(ctx context.Context, orgID, modelID, docID uuid.UUID, promptVersion string) (uuid.UUID, error) {
	const q = `
		INSERT INTO ai_runs (
			organization_id, model_id, target_type, target_id, status,
			started_at, request_payload
		)
		VALUES ($1, $2, 'document', $3, 'running', NOW(), $4)
		RETURNING id
	`
	payload, _ := json.Marshal(map[string]string{"prompt_version": promptVersion})
	var id uuid.UUID
	err := s.db.QueryRowContext(ctx, q, orgID, modelID, docID, payload).Scan(&id)
	return id, err
}

// FinishAIRun updates an ai_runs row to succeeded/failed with token usage + latency.
func (s *Store) FinishAIRun(ctx context.Context, runID uuid.UUID, status string, latencyMS int, inputTokens, outputTokens int64, errMsg string) error {
	const q = `
		UPDATE ai_runs
		SET status = $2,
		    finished_at = NOW(),
		    latency_ms = $3,
		    input_tokens = $4,
		    output_tokens = $5,
		    error = NULLIF($6, '')
		WHERE id = $1
	`
	_, err := s.db.ExecContext(ctx, q, runID, status, latencyMS, inputTokens, outputTokens, errMsg)
	return err
}

// CreateExtraction inserts a new document_extractions row in 'pending' state
// and returns its ID.
func (s *Store) CreateExtraction(ctx context.Context, docID, orgID, aiRunID, modelID uuid.UUID) (uuid.UUID, error) {
	const q = `
		INSERT INTO document_extractions (document_id, organization_id, ai_run_id, model_id, status, is_current)
		VALUES ($1, $2, $3, $4, 'processing', false)
		RETURNING id
	`
	var id uuid.UUID
	err := s.db.QueryRowContext(ctx, q, docID, orgID, aiRunID, modelID).Scan(&id)
	return id, err
}

// CompleteExtraction sets extracted JSONB, status=extracted, marks is_current=true
// on this row, clears is_current on all other rows for this document, and
// updates documents.current_extraction_id + documents.status in a single
// transaction.
func (s *Store) CompleteExtraction(ctx context.Context, extractionID, docID uuid.UUID, extracted *Extracted, kind DocumentKind) error {
	extractedJSON, err := json.Marshal(extracted)
	if err != nil {
		return fmt.Errorf("marshal extracted: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// Clear is_current on any prior extraction.
	if _, err := tx.ExecContext(ctx,
		`UPDATE document_extractions SET is_current = false WHERE document_id = $1 AND id <> $2`,
		docID, extractionID,
	); err != nil {
		return err
	}

	// Mark this extraction as current + store result.
	if _, err := tx.ExecContext(ctx, `
		UPDATE document_extractions
		SET status = 'extracted', extracted = $2, is_current = true
		WHERE id = $1`,
		extractionID, extractedJSON,
	); err != nil {
		return err
	}

	// Update documents: $1=kind, $2=extractionID, $3=docID.
	if _, err := tx.ExecContext(ctx, `
		UPDATE documents
		SET status = 'extracted', kind = $1, current_extraction_id = $2, error = NULL
		WHERE id = $3`,
		string(kind), extractionID, docID,
	); err != nil {
		return err
	}

	return tx.Commit()
}

// FailExtraction stores the raw response, sets status=failed on both
// document_extractions and documents, and records the error message.
func (s *Store) FailExtraction(ctx context.Context, extractionID, docID uuid.UUID, rawResp json.RawMessage, errMsg string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		UPDATE document_extractions
		SET status = 'failed', raw = $2, error = $3
		WHERE id = $1`,
		extractionID, rawResp, errMsg,
	); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE documents SET status = 'failed', error = $2
		WHERE id = $1`,
		docID, errMsg,
	); err != nil {
		return err
	}

	return tx.Commit()
}

