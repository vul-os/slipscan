package extract

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/ocr"
)

const (
	geminiProvider    = "google"
	geminiDisplayName = "Gemini 2.5 Flash (extraction)"
)

// Service orchestrates the full extraction pipeline:
//  1. Fetch the document row.
//  2. Transition status pending → processing.
//  3. Detect kind (if unknown) with a cheap classify call.
//  4. Run the kind-specific extraction prompt.
//  5. Persist document_extractions, ai_runs; update documents.
type Service struct {
	store   *Store
	ocr     *ocr.Client
	storage StorageGetter
}

// StorageGetter can fetch raw file bytes by object key.
// Satisfied by *storage.Client so we don't import the storage package here.
type StorageGetter interface {
	Get(ctx context.Context, key string) ([]byte, error)
}

// NewService creates an extraction Service.
func NewService(store *Store, ocrClient *ocr.Client, storage StorageGetter) *Service {
	return &Service{store: store, ocr: ocrClient, storage: storage}
}

// Run executes the full extraction pipeline for one document.
// It is safe to call multiple times (re-run). On re-run the old extraction
// row stays (is_current flipped to false) and a new row is written.
func (s *Service) Run(ctx context.Context, docID, orgID uuid.UUID) error {
	start := time.Now()

	// 1. Fetch document.
	doc, err := s.store.GetDocument(ctx, docID, orgID)
	if err != nil {
		if err.Error() == "document not found" {
			return errDocNotFound
		}
		return fmt.Errorf("get document: %w", err)
	}

	// 2. Org default currency (fallback for ambiguous symbols).
	orgCurrency, _ := s.store.OrgCurrency(ctx, orgID)

	// 3. Ensure the AI model row exists.
	modelUUID, err := s.store.EnsureAIModel(ctx, geminiProvider, s.ocr.Model(), geminiDisplayName)
	if err != nil {
		return fmt.Errorf("ensure ai model: %w", err)
	}

	// Determine current document kind (may still be unknown).
	kind := DocumentKind(doc.Kind)

	// 4. Transition document to processing.
	if err := s.store.SetDocumentStatus(ctx, docID, StatusProcessing, kind, ""); err != nil {
		return fmt.Errorf("set processing: %w", err)
	}

	// 5. If kind is unknown, run cheap kind-detection first.
	//    We need the file bytes for this anyway so fetch them now.
	mime := "image/jpeg"
	if doc.MimeType.Valid && doc.MimeType.String != "" {
		mime = doc.MimeType.String
	}

	fileBytes, err := s.storage.Get(ctx, doc.StorageURL)
	if err != nil {
		_ = s.store.SetDocumentStatus(ctx, docID, StatusFailed, kind, "storage fetch failed: "+err.Error())
		return fmt.Errorf("fetch file: %w", err)
	}

	promptVersion := s.promptVersionFor(kind)
	aiRunID, err := s.store.CreateAIRun(ctx, orgID, modelUUID, docID, promptVersion)
	if err != nil {
		return fmt.Errorf("create ai_run: %w", err)
	}

	extractionID, err := s.store.CreateExtraction(ctx, docID, orgID, aiRunID, modelUUID)
	if err != nil {
		return fmt.Errorf("create extraction row: %w", err)
	}

	if kind == KindUnknown || kind == "" {
		detected, detectErr := s.detectKind(ctx, fileBytes, mime)
		if detectErr != nil {
			log.Printf("extract: kind detection failed (docID=%s): %v — defaulting to slip", docID, detectErr)
			detected = KindSlip
		}
		kind = detected
		// Update promptVersion now that we know the kind.
		promptVersion = s.promptVersionFor(kind)
	}

	// 6. Run the kind-specific extraction.
	rawJSON, extractedResult, extractErr := s.runExtraction(ctx, fileBytes, mime, kind, orgCurrency)

	latencyMS := int(time.Since(start).Milliseconds())

	if extractErr != nil {
		_ = s.store.FinishAIRun(ctx, aiRunID, "failed", latencyMS, 0, 0, extractErr.Error())
		_ = s.store.FailExtraction(ctx, extractionID, docID, rawJSON, extractErr.Error())
		return fmt.Errorf("extraction failed: %w", extractErr)
	}

	// 7. Persist successful result.
	if err := s.store.FinishAIRun(ctx, aiRunID, "succeeded", latencyMS, 0, 0, ""); err != nil {
		log.Printf("extract: finish ai_run: %v", err)
	}
	if err := s.store.CompleteExtraction(ctx, extractionID, docID, extractedResult, kind); err != nil {
		return fmt.Errorf("complete extraction: %w", err)
	}

	log.Printf("extract: doc=%s kind=%s confidence=%.2f latency=%dms",
		docID, kind, extractedResult.Confidence, latencyMS)
	return nil
}

// detectKind runs a lightweight Gemini call to classify an unknown document.
func (s *Service) detectKind(ctx context.Context, fileBytes []byte, mime string) (DocumentKind, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	raw, err := s.ocr.ExtractWithSchema(ctx, fileBytes, mime, kindDetectPrompt, kindDetectSchema)
	if err != nil {
		return KindUnknown, err
	}
	var kd geminiKind
	if err := json.Unmarshal(raw, &kd); err != nil {
		return KindUnknown, fmt.Errorf("parse kind response: %w", err)
	}
	switch kd.Kind {
	case "slip":
		return KindSlip, nil
	case "invoice":
		return KindInvoice, nil
	case "bank_statement":
		return KindBankStatement, nil
	default:
		return KindSlip, nil
	}
}

// runExtraction calls Gemini with the kind-specific prompt and maps the
// response to the canonical Extracted struct.
func (s *Service) runExtraction(
	ctx context.Context,
	fileBytes []byte,
	mime string,
	kind DocumentKind,
	orgCurrency string,
) (json.RawMessage, *Extracted, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	prompt, schema := s.promptSchemaFor(kind)
	raw, err := s.ocr.ExtractWithSchema(ctx, fileBytes, mime, prompt, schema)
	if err != nil {
		return raw, nil, err
	}

	var gr geminiRaw
	if err := json.Unmarshal(raw, &gr); err != nil {
		return raw, nil, fmt.Errorf("parse extraction response: %w", err)
	}

	result := mapToExtracted(kind, &gr, orgCurrency)
	return raw, result, nil
}

func (s *Service) promptVersionFor(kind DocumentKind) string {
	switch kind {
	case KindSlip:
		return PromptVersionSlip
	case KindInvoice:
		return PromptVersionInvoice
	case KindBankStatement:
		return PromptVersionStatement
	default:
		return PromptVersionKindDetect
	}
}

func (s *Service) promptSchemaFor(kind DocumentKind) (string, map[string]any) {
	switch kind {
	case KindInvoice:
		return invoicePrompt, invoiceSchema
	case KindBankStatement:
		return statementPrompt, statementSchema
	default:
		return slipPrompt, slipSchema
	}
}
