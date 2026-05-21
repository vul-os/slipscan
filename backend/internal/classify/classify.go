package classify

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/merchant"
	"github.com/exolutionza/slipscan/backend/internal/ocr"
)

// ─── Extracted document shape (P1-01 → P1-02 contract) ────────────────────

// Extracted mirrors the JSONB shape written by P1-01 into
// document_extractions.extracted.  All fields are optional to handle
// partial extractions gracefully.
type Extracted struct {
	Kind           string          `json:"kind"`     // slip|invoice|bank_statement
	Merchant       string          `json:"merchant"`
	Date           string          `json:"date"`     // YYYY-MM-DD
	Currency       string          `json:"currency"` // ISO-4217
	Subtotal       *float64        `json:"subtotal"`
	Tax            *float64        `json:"tax"`
	Total          *float64        `json:"total"`
	Confidence     *float64        `json:"confidence"`
	LineItems      []LineItem      `json:"line_items"`
	StatementLines []StatementLine `json:"statement_lines"`
}

// LineItem is one purchased line from a slip or invoice.
type LineItem struct {
	Description string   `json:"description"`
	Qty         *float64 `json:"qty"`
	Unit        *float64 `json:"unit"`
	Amount      *float64 `json:"amount"`
}

// StatementLine is one row from a bank statement.
type StatementLine struct {
	Date        string   `json:"date"`
	Description string   `json:"description"`
	Amount      float64  `json:"amount"`
	Balance     *float64 `json:"balance"`
}

// ─── Transaction record ────────────────────────────────────────────────────

// Transaction is a thin wrapper over the DB row we create / look up.
type Transaction struct {
	ID                    uuid.UUID
	OrganizationID        uuid.UUID
	DocumentID            uuid.NullUUID
	DocumentExtractionID  uuid.NullUUID
	UploadedBy            uuid.NullUUID
	Merchant              string
	MerchantNormalized    string
	Description           string
	Amount                *float64
	Currency              string
	Tax                   *float64
	PostedDate            *time.Time
	Direction             string // "debit"|"credit"|"transfer"
	Status                string // always "pending" on creation
	CurrentClassificationID uuid.NullUUID
}

// Classification holds the winning classification row.
type Classification struct {
	ID             uuid.UUID
	TransactionID  uuid.UUID
	OrganizationID uuid.UUID
	AIRunID        uuid.NullUUID
	RuleID         uuid.NullUUID
	CategoryID     uuid.NullUUID
	AccountID      uuid.NullUUID
	Source         string  // rule|merchant_signal|llm
	Confidence     float64
	Reasoning      string
	IsCurrent      bool
}

// ─── Classifier ───────────────────────────────────────────────────────────

// Classifier holds the dependencies needed to run the full cascade.
type Classifier struct {
	db  *sql.DB
	llm *ocr.Client // may be nil — LLM stage is skipped when nil
}

// New returns a Classifier.  Pass nil for llmClient to disable the LLM stage
// (useful in tests).
func New(db *sql.DB, llmClient *ocr.Client) *Classifier {
	return &Classifier{db: db, llm: llmClient}
}

// ClassifyDocument reads the current extraction for the given document,
// creates transaction row(s), runs the cascade for each, and returns the
// resulting transactions with their winning classifications.
//
// Cascade precedence (highest first): user > rule > merchant_signal > llm.
// "user" corrections are written by P1-03; this function handles the remaining
// three stages.
func (c *Classifier) ClassifyDocument(ctx context.Context, orgID, docID uuid.UUID, uploadedBy uuid.NullUUID) ([]*Transaction, error) {
	// 1. Load the current extraction for this document.
	ext, extractionID, err := c.loadCurrentExtraction(ctx, orgID, docID)
	if err != nil {
		return nil, fmt.Errorf("classify: load extraction: %w", err)
	}
	if ext == nil {
		return nil, errors.New("classify: document has no current extraction")
	}

	// 2. Build the transaction list from the extracted data.
	var txns []*Transaction

	switch ext.Kind {
	case "bank_statement":
		for i, line := range ext.StatementLines {
			txns = append(txns, extractionToTransaction(ext, i, orgID, docID, extractionID, uploadedBy, &line))
		}
		if len(txns) == 0 {
			// Treat the whole statement as one transaction if no lines.
			txns = append(txns, extractionToTransaction(ext, 0, orgID, docID, extractionID, uploadedBy, nil))
		}
	default:
		txns = append(txns, extractionToTransaction(ext, 0, orgID, docID, extractionID, uploadedBy, nil))
	}

	// 3. Persist transactions + run cascade for each.
	for _, tx := range txns {
		if err := c.persistTransaction(ctx, tx); err != nil {
			return nil, fmt.Errorf("classify: persist transaction: %w", err)
		}
		if err := c.cascade(ctx, orgID, tx); err != nil {
			// Log but don't fail the whole operation — the tx row exists.
			// The UI can re-trigger classification.
			_ = err
		}
	}

	return txns, nil
}

// ─── Transaction builder ───────────────────────────────────────────────────

func extractionToTransaction(
	ext *Extracted,
	_ int,
	orgID, docID, extractionID uuid.UUID,
	uploadedBy uuid.NullUUID,
	line *StatementLine,
) *Transaction {
	t := &Transaction{
		OrganizationID:       orgID,
		DocumentID:           uuid.NullUUID{UUID: docID, Valid: true},
		DocumentExtractionID: uuid.NullUUID{UUID: extractionID, Valid: true},
		UploadedBy:           uploadedBy,
		Currency:             strings.ToUpper(ext.Currency),
		Status:               "pending",
		Direction:            "debit",
	}

	if line != nil {
		// Bank statement line
		amt := line.Amount
		t.Amount = &amt
		t.Description = line.Description
		t.Merchant = line.Description
		if line.Amount > 0 {
			t.Direction = "credit"
		}
		if d, err := time.Parse("2006-01-02", line.Date); err == nil {
			t.PostedDate = &d
		}
	} else {
		// Slip / invoice
		t.Merchant = ext.Merchant
		t.Amount = ext.Total
		t.Tax = ext.Tax
		if d, err := time.Parse("2006-01-02", ext.Date); err == nil {
			t.PostedDate = &d
		}
	}

	t.MerchantNormalized = merchant.Normalize(t.Merchant)
	return t
}

// ─── Persistence ──────────────────────────────────────────────────────────

func (c *Classifier) persistTransaction(ctx context.Context, t *Transaction) error {
	const q = `
		INSERT INTO transactions (
			organization_id, document_id, document_extraction_id,
			uploaded_by, merchant, merchant_normalized,
			description, amount, currency, tax,
			posted_date, direction, status
		) VALUES (
			$1, $2, $3,
			$4, $5, $6,
			$7, $8, $9, $10,
			$11, $12::transaction_direction, $13::transaction_status
		) RETURNING id, created_at
	`
	var createdAt time.Time
	return c.db.QueryRowContext(ctx, q,
		t.OrganizationID,
		t.DocumentID,
		t.DocumentExtractionID,
		t.UploadedBy,
		nullStrVal(t.Merchant),
		nullStrVal(t.MerchantNormalized),
		nullStrVal(t.Description),
		t.Amount,
		nullStrVal(t.Currency),
		t.Tax,
		t.PostedDate,
		t.Direction,
		t.Status,
	).Scan(&t.ID, &createdAt)
}

// ─── Cascade ──────────────────────────────────────────────────────────────

// cascade runs the rule→signal→llm stages and writes the winning
// transaction_classifications row, then updates
// transactions.current_classification_id.
func (c *Classifier) cascade(ctx context.Context, orgID uuid.UUID, t *Transaction) error {
	// Stage 1: classification_rules
	cl, err := c.tryRules(ctx, orgID, t)
	if err != nil {
		return err
	}
	if cl != nil {
		return c.writeClassification(ctx, t, cl)
	}

	// Stage 2: merchant_signals (cross-tenant)
	cl, err = c.trySignal(ctx, orgID, t)
	if err != nil {
		return err
	}
	if cl != nil {
		return c.writeClassification(ctx, t, cl)
	}

	// Stage 3: LLM
	if c.llm != nil {
		cl, err = c.tryLLM(ctx, orgID, t)
		if err != nil {
			return err
		}
		if cl != nil {
			return c.writeClassification(ctx, t, cl)
		}
	}

	return nil // no classification — OK, left unclassified
}

// ─── Stage 1: rules ────────────────────────────────────────────────────────

const (
	matchExact    = "merchant_exact"
	matchContains = "merchant_contains"
	matchRegex    = "merchant_regex"
)

// tryRules checks classification_rules for the org in order:
// exact → contains → regex. Returns the first matching classification stub.
func (c *Classifier) tryRules(ctx context.Context, orgID uuid.UUID, t *Transaction) (*Classification, error) {
	if t.MerchantNormalized == "" {
		return nil, nil
	}

	const q = `
		SELECT id, match_type, match_value, category_id, account_id, confidence
		FROM classification_rules
		WHERE organization_id = $1
		ORDER BY
			CASE match_type
				WHEN 'merchant_exact'    THEN 1
				WHEN 'merchant_contains' THEN 2
				WHEN 'merchant_regex'    THEN 3
			END,
			confidence DESC
	`
	rows, err := c.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type rule struct {
		id         uuid.UUID
		matchType  string
		matchValue string
		categoryID uuid.NullUUID
		accountID  uuid.NullUUID
		confidence float64
	}

	var rules []rule
	for rows.Next() {
		var r rule
		if err := rows.Scan(&r.id, &r.matchType, &r.matchValue, &r.categoryID, &r.accountID, &r.confidence); err != nil {
			return nil, err
		}
		rules = append(rules, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Evaluate in precedence order: exact first, then contains, then regex.
	norm := t.MerchantNormalized
	for _, pass := range []string{matchExact, matchContains, matchRegex} {
		for _, r := range rules {
			if r.matchType != pass {
				continue
			}
			matched := false
			switch r.matchType {
			case matchExact:
				matched = norm == r.matchValue
			case matchContains:
				matched = strings.Contains(norm, r.matchValue)
			case matchRegex:
				if re, err := regexp.Compile(r.matchValue); err == nil {
					matched = re.MatchString(norm)
				}
			}
			if matched {
				// Update the rule's applied_count + last_applied_at in background.
				// Ignore error — non-critical bookkeeping.
				_, _ = c.db.ExecContext(ctx, `
					UPDATE classification_rules
					SET applied_count = applied_count + 1,
					    last_applied_at = NOW()
					WHERE id = $1
				`, r.id)

				return &Classification{
					TransactionID:  t.ID,
					OrganizationID: orgID,
					RuleID:         uuid.NullUUID{UUID: r.id, Valid: true},
					CategoryID:     r.categoryID,
					AccountID:      r.accountID,
					Source:         "rule",
					Confidence:     r.confidence,
					IsCurrent:      true,
				}, nil
			}
		}
	}
	return nil, nil
}

// ─── Stage 2: merchant signal ──────────────────────────────────────────────

func (c *Classifier) trySignal(ctx context.Context, orgID uuid.UUID, t *Transaction) (*Classification, error) {
	sig, err := LookupSignal(ctx, c.db, t.MerchantNormalized)
	if err != nil || sig == nil {
		return nil, err
	}

	catID, err := mapSignalToCategory(ctx, c.db, orgID, sig.CategoryLabel)
	if err != nil || catID == uuid.Nil {
		return nil, err
	}

	// Confidence: cap at 0.85 since signal votes can be noisy.
	conf := 0.6 + float64(sig.VoteCount)*0.01
	if conf > 0.85 {
		conf = 0.85
	}

	return &Classification{
		TransactionID:  t.ID,
		OrganizationID: orgID,
		CategoryID:     uuid.NullUUID{UUID: catID, Valid: true},
		Source:         "merchant_signal",
		Confidence:     conf,
		IsCurrent:      true,
	}, nil
}

// ─── Stage 3: LLM ─────────────────────────────────────────────────────────

// classifyPrompt is the LLM classification prompt template.
const classifyPromptTemplate = `You are a transaction classifier for a %s organisation.

Transaction:
- Merchant: %s
- Amount: %s
- Currency: %s
- Date: %s

Available categories (you MUST pick one exactly as listed, or "uncategorised" if truly none fit):
%s

Respond with JSON matching the schema. category must be one of the listed names verbatim.`

func (c *Classifier) tryLLM(ctx context.Context, orgID uuid.UUID, t *Transaction) (*Classification, error) {
	if c.llm == nil {
		return nil, nil
	}

	// Fetch org kind + categories in one query.
	orgKind, catNames, err := c.loadOrgAndCategories(ctx, orgID)
	if err != nil {
		return nil, err
	}
	if len(catNames) == 0 {
		return nil, nil
	}

	amtStr := "unknown"
	if t.Amount != nil {
		amtStr = fmt.Sprintf("%.2f", *t.Amount)
	}
	dateStr := "unknown"
	if t.PostedDate != nil {
		dateStr = t.PostedDate.Format("2006-01-02")
	}

	catList := strings.Join(catNames, "\n- ")
	prompt := fmt.Sprintf(classifyPromptTemplate,
		orgKind,
		t.Merchant,
		amtStr,
		t.Currency,
		dateStr,
		"- "+catList,
	)

	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"category":   map[string]any{"type": "string"},
			"confidence": map[string]any{"type": "number"},
			"reasoning":  map[string]any{"type": "string", "nullable": true},
		},
		"required": []string{"category", "confidence"},
	}

	// Record the AI run start.
	aiRunID, modelID, err := c.recordAIRunStart(ctx, orgID, t.ID)
	if err != nil {
		// Non-fatal — proceed without run tracking.
		aiRunID = uuid.Nil
		modelID = uuid.Nil
	}

	startTime := time.Now()
	raw, llmErr := c.llm.GenerateJSON(ctx, prompt, schema, 0.1)
	latencyMS := int(time.Since(startTime).Milliseconds())

	// Update ai_run record.
	if aiRunID != uuid.Nil {
		c.finishAIRun(ctx, aiRunID, raw, llmErr, latencyMS)
	}

	if llmErr != nil {
		return nil, llmErr
	}

	var result struct {
		Category   string  `json:"category"`
		Confidence float64 `json:"confidence"`
		Reasoning  string  `json:"reasoning"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("classify: parse LLM response: %w", err)
	}

	// Enforce constraint: the category MUST be in the org's list.
	catID := c.findCategoryByName(ctx, orgID, catNames, result.Category)
	if catID == uuid.Nil {
		// LLM returned an invented category — discard.
		return nil, nil
	}

	cl := &Classification{
		TransactionID:  t.ID,
		OrganizationID: orgID,
		CategoryID:     uuid.NullUUID{UUID: catID, Valid: true},
		Source:         "llm",
		Confidence:     clampConfidence(result.Confidence),
		Reasoning:      result.Reasoning,
		IsCurrent:      true,
	}
	if aiRunID != uuid.Nil {
		cl.AIRunID = uuid.NullUUID{UUID: aiRunID, Valid: true}
	}
	_ = modelID
	return cl, nil
}

// ─── Write classification ─────────────────────────────────────────────────

func (c *Classifier) writeClassification(ctx context.Context, t *Transaction, cl *Classification) error {
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Clear any existing is_current row (handles re-classification).
	if _, err := tx.ExecContext(ctx, `
		UPDATE transaction_classifications
		SET is_current = false
		WHERE transaction_id = $1 AND is_current = true
	`, t.ID); err != nil {
		return err
	}

	const insertQ = `
		INSERT INTO transaction_classifications (
			transaction_id, organization_id, ai_run_id, rule_id,
			category_id, account_id,
			source, confidence, reasoning, is_current
		) VALUES ($1, $2, $3, $4, $5, $6, $7::classification_source, $8, $9, true)
		RETURNING id
	`
	err = tx.QueryRowContext(ctx, insertQ,
		cl.TransactionID, cl.OrganizationID,
		cl.AIRunID, cl.RuleID,
		cl.CategoryID, cl.AccountID,
		cl.Source,
		cl.Confidence,
		nullStrVal(cl.Reasoning),
	).Scan(&cl.ID)
	if err != nil {
		return err
	}

	// Update the denormalized pointer on the transaction.
	if _, err := tx.ExecContext(ctx, `
		UPDATE transactions SET current_classification_id = $1 WHERE id = $2
	`, cl.ID, cl.TransactionID); err != nil {
		return err
	}
	t.CurrentClassificationID = uuid.NullUUID{UUID: cl.ID, Valid: true}

	return tx.Commit()
}

// ─── Helpers ──────────────────────────────────────────────────────────────

func (c *Classifier) loadCurrentExtraction(ctx context.Context, orgID, docID uuid.UUID) (*Extracted, uuid.UUID, error) {
	const q = `
		SELECT de.id, de.extracted
		FROM document_extractions de
		WHERE de.document_id = $1
		  AND de.organization_id = $2
		  AND de.is_current = true
		LIMIT 1
	`
	var extractionID uuid.UUID
	var raw []byte
	err := c.db.QueryRowContext(ctx, q, docID, orgID).Scan(&extractionID, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, uuid.Nil, nil
	}
	if err != nil {
		return nil, uuid.Nil, err
	}
	if raw == nil {
		return nil, uuid.Nil, errors.New("classify: extraction has no extracted JSONB")
	}

	var ext Extracted
	if err := json.Unmarshal(raw, &ext); err != nil {
		return nil, uuid.Nil, fmt.Errorf("classify: unmarshal extracted: %w", err)
	}
	return &ext, extractionID, nil
}

func (c *Classifier) loadOrgAndCategories(ctx context.Context, orgID uuid.UUID) (string, []string, error) {
	// Load org kind.
	var orgKind string
	if err := c.db.QueryRowContext(ctx,
		`SELECT kind FROM organizations WHERE id = $1`, orgID,
	).Scan(&orgKind); err != nil {
		return "", nil, err
	}

	// Load category names.
	rows, err := c.db.QueryContext(ctx,
		`SELECT name FROM categories WHERE organization_id = $1 ORDER BY kind, name`, orgID)
	if err != nil {
		return orgKind, nil, err
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return orgKind, nil, err
		}
		names = append(names, n)
	}
	return orgKind, names, rows.Err()
}

func (c *Classifier) findCategoryByName(ctx context.Context, orgID uuid.UUID, catNames []string, name string) uuid.UUID {
	// Confirm the name is in the allowed list first (LLM constraint).
	lower := strings.ToLower(strings.TrimSpace(name))
	found := false
	for _, n := range catNames {
		if strings.ToLower(n) == lower {
			found = true
			break
		}
	}
	if !found {
		return uuid.Nil
	}

	var id uuid.UUID
	_ = c.db.QueryRowContext(ctx,
		`SELECT id FROM categories WHERE organization_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
		orgID, name,
	).Scan(&id)
	return id
}

// ─── AI run recording ────────────────────────────────────────────────────

func (c *Classifier) recordAIRunStart(ctx context.Context, orgID, txID uuid.UUID) (aiRunID, modelID uuid.UUID, err error) {
	// Look up (or skip) the default classification model.
	err = c.db.QueryRowContext(ctx, `
		SELECT id FROM ai_models
		WHERE kind = 'classification' AND is_default = true AND is_active = true
		LIMIT 1
	`).Scan(&modelID)
	if errors.Is(err, sql.ErrNoRows) {
		// Try any active classification model.
		err = c.db.QueryRowContext(ctx, `
			SELECT id FROM ai_models
			WHERE kind = 'classification' AND is_active = true
			LIMIT 1
		`).Scan(&modelID)
	}
	if err != nil {
		return uuid.Nil, uuid.Nil, nil // No model registered — skip tracking.
	}

	err = c.db.QueryRowContext(ctx, `
		INSERT INTO ai_runs (organization_id, model_id, target_type, target_id, status)
		VALUES ($1, $2, 'transaction', $3, 'running')
		RETURNING id
	`, orgID, modelID, txID).Scan(&aiRunID)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return aiRunID, modelID, nil
}

func (c *Classifier) finishAIRun(ctx context.Context, runID uuid.UUID, raw json.RawMessage, runErr error, latencyMS int) {
	status := "succeeded"
	errStr := ""
	if runErr != nil {
		status = "failed"
		errStr = runErr.Error()
	}
	_, _ = c.db.ExecContext(ctx, `
		UPDATE ai_runs
		SET status       = $2::ai_run_status,
		    response_payload = $3,
		    error        = NULLIF($4, ''),
		    latency_ms   = $5,
		    finished_at  = NOW()
		WHERE id = $1
	`, runID, status, raw, errStr, latencyMS)
}

// ─── Utilities ───────────────────────────────────────────────────────────

func nullStrVal(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func clampConfidence(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
