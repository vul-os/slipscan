// Package classify owns the classification correction loop for P1-03.
//
// Responsibility split:
//   - This file (corrections.go): CorrectionsStore (DB layer) and all
//     correction + rule-promotion logic.
//   - A future classify.go (P1-02): cascade matching, transaction creation,
//     category seeding. Put it in a separate file so merges are clean.
//
// Integration note for P1-02 reconciliation: if P1-02 defines its own Store
// type in this package, fold CorrectionsStore fields into it (they share the
// same *sql.DB). The exported functions and the Handler remain unchanged.
package classify

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/audit" // P4-03 audit
	"github.com/exolutionza/slipscan/backend/internal/merchant"
)

// DefaultPromotionThreshold is the minimum number of identical
// (merchant_normalized → category) user corrections required before a
// classification_rules row is upserted. Configurable via CorrectionsConfig.
const DefaultPromotionThreshold = 2

// MatchType mirrors the classification_match_type SQL enum values that
// P1-03 can produce. P1-02 uses the same enum, so keep in sync.
type MatchType string

const (
	MatchTypeMerchantExact    MatchType = "merchant_exact"
	MatchTypeMerchantContains MatchType = "merchant_contains"
)

// ClassificationSource mirrors the classification_source SQL enum.
type ClassificationSource string

const (
	SourceUser           ClassificationSource = "user"
	SourceRule           ClassificationSource = "rule"
	SourceLLM            ClassificationSource = "llm"
	SourceMerchantSignal ClassificationSource = "merchant_signal"
	SourceSystem         ClassificationSource = "system"
)

// ErrNotFound is returned when a referenced row (transaction, classification)
// does not exist or does not belong to the requested org.
var ErrNotFound = errors.New("not found")

// ErrForbidden is returned when the caller tries to overwrite a user-classified
// transaction (invariant: never overwrite source='user').
var ErrForbidden = errors.New("cannot overwrite a user classification")

// CorrectionsConfig holds tuneable parameters. All fields have sensible
// defaults; callers may pass a zero value and call WithDefaults().
type CorrectionsConfig struct {
	// PromotionThreshold is the number of identical corrections
	// (merchant_normalized → same category_id) needed to upsert a rule.
	// Defaults to DefaultPromotionThreshold (2).
	PromotionThreshold int
}

// WithDefaults fills in zero values with package-level defaults.
func (c CorrectionsConfig) WithDefaults() CorrectionsConfig {
	if c.PromotionThreshold <= 0 {
		c.PromotionThreshold = DefaultPromotionThreshold
	}
	return c
}

// CorrectionsStore is the data-access layer for the correction loop.
// It wraps a *sql.DB (the same pool passed to other stores in this binary).
type CorrectionsStore struct {
	db  *sql.DB
	cfg CorrectionsConfig
}

// NewCorrectionsStore creates a CorrectionsStore with the given config.
// Pass a zero CorrectionsConfig to use the defaults.
func NewCorrectionsStore(db *sql.DB, cfg CorrectionsConfig) *CorrectionsStore {
	return &CorrectionsStore{db: db, cfg: cfg.WithDefaults()}
}

// -----------------------------------------------------------------------------
// Row types
// -----------------------------------------------------------------------------

// currentClassification holds the fields we need from the active
// transaction_classifications row before applying a correction.
type currentClassification struct {
	ID         uuid.UUID
	CategoryID uuid.NullUUID
	AccountID  uuid.NullUUID
	Source     ClassificationSource
}

// CorrectionInput is what the PATCH handler receives after JSON-decoding.
type CorrectionInput struct {
	// NewCategoryID is required for all org kinds.
	NewCategoryID uuid.UUID `json:"category_id"`
	// NewAccountID is optional; meaningful only for business orgs.
	NewAccountID uuid.NullUUID `json:"account_id,omitempty"`
}

// CorrectionResult is returned by ApplyCorrection.
type CorrectionResult struct {
	// CorrectionID is the newly inserted classification_corrections row.
	CorrectionID uuid.UUID `json:"correction_id"`
	// ClassificationID is the new transaction_classifications row (source=user).
	ClassificationID uuid.UUID `json:"classification_id"`
	// RulePromoted is true when this correction pushed the count to the
	// threshold and a classification_rules row was upserted.
	RulePromoted bool `json:"rule_promoted"`
	// RuleID is the rule that was upserted (only meaningful when RulePromoted).
	RuleID uuid.UUID `json:"rule_id,omitempty"`
}

// BackfillResult is returned by ApplyToExisting.
type BackfillResult struct {
	// Updated is the number of non-user transactions reclassified.
	Updated int `json:"updated"`
	// Skipped is the number of transactions skipped (source=user invariant).
	Skipped int `json:"skipped"`
}

// -----------------------------------------------------------------------------
// Core: ApplyCorrection
// -----------------------------------------------------------------------------

// ApplyCorrection records a user-initiated recategorisation and, when the
// promotion threshold is reached, upserts a classification_rules row.
//
// Contract (P1-03 §2):
//   - Inserts a classification_corrections row (old/new category, corrected_by).
//   - Inserts a new transaction_classifications row (source='user', conf 1.0).
//   - Flips is_current: old row → false, new row → true.
//   - Updates transactions.current_classification_id to the new row's ID.
//   - Idempotent: if the transaction already has source='user' with the same
//     category_id, still inserts a correction row but skips duplicate promotion.
//   - After ≥ PromotionThreshold identical corrections for the same
//     (merchant_normalized, new_category_id) pair, upserts a classification_rules
//     row with match_type='merchant_exact'. Logs the promotion.
//
// It never returns ErrForbidden: the "never overwrite user" invariant applies
// only to backfill (ApplyToExisting). Direct user corrections can always
// supersede a previous user classification (it records the history).
func (s *CorrectionsStore) ApplyCorrection(
	ctx context.Context,
	orgID, txID, correctedBy uuid.UUID,
	input CorrectionInput,
) (*CorrectionResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// 1. Lock the transaction row and read merchant_normalized.
	var merchantNorm sql.NullString
	var currentClsID uuid.NullUUID
	err = tx.QueryRowContext(ctx, `
		SELECT merchant_normalized, current_classification_id
		FROM transactions
		WHERE id = $1 AND organization_id = $2
		FOR UPDATE
	`, txID, orgID).Scan(&merchantNorm, &currentClsID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("lock transaction: %w", err)
	}

	// 2. Read the current classification if there is one.
	var cur currentClassification
	if currentClsID.Valid {
		err = tx.QueryRowContext(ctx, `
			SELECT id, category_id, account_id, source
			FROM transaction_classifications
			WHERE id = $1
		`, currentClsID.UUID).Scan(&cur.ID, &cur.CategoryID, &cur.AccountID, &cur.Source)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("read current classification: %w", err)
		}
	}

	// 3. Insert the new classification row (source=user, confidence=1.0).
	newClsID := uuid.New()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO transaction_classifications
			(id, transaction_id, organization_id, category_id, account_id,
			 source, confidence, is_current, created_at)
		VALUES ($1, $2, $3, $4, $5, 'user', 1.0, TRUE, NOW())
	`, newClsID, txID, orgID,
		nullableUUID(input.NewCategoryID),
		input.NewAccountID,
	)
	if err != nil {
		return nil, fmt.Errorf("insert classification: %w", err)
	}

	// 4. Flip the old row to is_current=false (if it exists and differs).
	if currentClsID.Valid && currentClsID.UUID != newClsID {
		_, err = tx.ExecContext(ctx, `
			UPDATE transaction_classifications
			SET is_current = FALSE
			WHERE id = $1
		`, currentClsID.UUID)
		if err != nil {
			return nil, fmt.Errorf("clear old is_current: %w", err)
		}
	}

	// 5. Update transactions.current_classification_id.
	_, err = tx.ExecContext(ctx, `
		UPDATE transactions
		SET current_classification_id = $1,
		    category_id               = $2,
		    account_id                = $3,
		    updated_at                = NOW()
		WHERE id = $4 AND organization_id = $5
	`, newClsID,
		nullableUUID(input.NewCategoryID),
		input.NewAccountID,
		txID, orgID,
	)
	if err != nil {
		return nil, fmt.Errorf("update transaction pointer: %w", err)
	}

	// 6. Insert classification_corrections.
	corrID := uuid.New()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO classification_corrections
			(id, organization_id, transaction_id, merchant_normalized,
			 old_category_id, new_category_id,
			 old_source,
			 old_classification_id, new_classification_id,
			 corrected_by, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
	`,
		corrID, orgID, txID,
		merchantNorm,
		cur.CategoryID,
		nullableUUID(input.NewCategoryID),
		nullableSource(cur.Source),
		nullableUUID(cur.ID),
		newClsID,
		correctedBy,
	)
	if err != nil {
		return nil, fmt.Errorf("insert correction: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit correction: %w", err)
	}

	// P4-03 audit: record classification correction in the append-only audit log.
	{
		actor := correctedBy
		entityID := txID
		auditErr := audit.Write(ctx, s.db, audit.Entry{
			OrganizationID: &orgID,
			ActorUserID:    &actor,
			EntityType:     "transaction",
			EntityID:       &entityID,
			Action:         "classification.corrected",
			Before:         audit.MarshalBefore(map[string]any{
				"category_id":       cur.CategoryID,
				"classification_id": cur.ID,
				"source":            cur.Source,
			}),
			After: audit.MarshalAfter(map[string]any{
				"category_id":       input.NewCategoryID,
				"account_id":        input.NewAccountID,
				"classification_id": newClsID,
				"source":            "user",
			}),
		})
		if auditErr != nil {
			log.Printf("audit: classify correction write failed: %v", auditErr)
		}
	}

	// 7. Check for promotion (outside the transaction; idempotent upsert).
	var rulePromoted bool
	var ruleID uuid.UUID
	if merchantNorm.Valid && merchantNorm.String != "" {
		ruleID, rulePromoted, err = s.maybePromote(ctx, orgID, merchantNorm.String, input)
		if err != nil {
			// Promotion failure is non-fatal; log and continue.
			log.Printf("classify: promotion check failed org=%s merchant=%q: %v",
				orgID, merchantNorm.String, err)
		}
	}

	return &CorrectionResult{
		CorrectionID:     corrID,
		ClassificationID: newClsID,
		RulePromoted:     rulePromoted,
		RuleID:           ruleID,
	}, nil
}

// maybePromote counts identical corrections and, when ≥ threshold, upserts a
// classification_rules row. It is called outside the main transaction so its
// own idempotent upsert doesn't inflate the correction count.
func (s *CorrectionsStore) maybePromote(
	ctx context.Context,
	orgID uuid.UUID,
	merchantNorm string,
	input CorrectionInput,
) (uuid.UUID, bool, error) {
	norm := merchant.Normalize(merchantNorm)
	if norm == "" {
		return uuid.Nil, false, nil
	}

	// Count distinct transactions that have been user-corrected to this
	// (merchant_normalized, new_category_id) pair in this org.
	var count int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT transaction_id)
		FROM classification_corrections
		WHERE organization_id     = $1
		  AND merchant_normalized = $2
		  AND new_category_id     = $3
	`, orgID, norm, input.NewCategoryID).Scan(&count)
	if err != nil {
		return uuid.Nil, false, fmt.Errorf("count corrections: %w", err)
	}

	if count < s.cfg.PromotionThreshold {
		return uuid.Nil, false, nil
	}

	// Upsert the rule.
	ruleID := uuid.New()
	var returnedID uuid.UUID
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO classification_rules
			(id, organization_id, match_type, match_value,
			 category_id, account_id,
			 source, confidence, applied_count, last_applied_at,
			 created_at, updated_at)
		VALUES ($1, $2, 'merchant_exact', $3, $4, $5, 'user', 1.0, 0, NULL, NOW(), NOW())
		ON CONFLICT (organization_id, match_type, match_value)
		DO UPDATE SET
			category_id     = EXCLUDED.category_id,
			account_id      = EXCLUDED.account_id,
			updated_at      = NOW()
		RETURNING id
	`, ruleID, orgID, norm,
		nullableUUID(input.NewCategoryID),
		input.NewAccountID,
	).Scan(&returnedID)
	if err != nil {
		return uuid.Nil, false, fmt.Errorf("upsert rule: %w", err)
	}

	log.Printf("classify: promoted merchant=%q → category=%s as rule=%s (org=%s, corrections=%d)",
		norm, input.NewCategoryID, returnedID, orgID, count)

	return returnedID, true, nil
}

// -----------------------------------------------------------------------------
// Backfill: ApplyToExisting
// -----------------------------------------------------------------------------

// ApplyToExisting reclassifies past transactions for the same
// merchant_normalized, applying the new category/account. It NEVER overwrites
// a transaction whose current classification has source='user'. The given
// txID is excluded (it was already updated by ApplyCorrection).
//
// It processes rows in batches to avoid long-running transactions, but each
// individual update is wrapped in a short transaction to maintain atomicity
// per row. A per-row error is logged and skipped so one bad row doesn't block
// the rest.
func (s *CorrectionsStore) ApplyToExisting(
	ctx context.Context,
	orgID, excludeTxID uuid.UUID,
	merchantNorm string,
	input CorrectionInput,
	appliedBy uuid.UUID,
) (*BackfillResult, error) {
	norm := merchant.Normalize(merchantNorm)
	if norm == "" {
		return &BackfillResult{}, nil
	}

	// Collect all non-user-classified transactions with this merchant.
	rows, err := s.db.QueryContext(ctx, `
		SELECT t.id, tc.id, tc.category_id, tc.source
		FROM transactions t
		LEFT JOIN transaction_classifications tc
			ON tc.id = t.current_classification_id
		WHERE t.organization_id     = $1
		  AND t.merchant_normalized = $2
		  AND t.id                 != $3
		  AND (tc.id IS NULL OR tc.source != 'user')
		ORDER BY t.created_at DESC
	`, orgID, norm, excludeTxID)
	if err != nil {
		return nil, fmt.Errorf("query existing transactions: %w", err)
	}
	defer rows.Close()

	type candidate struct {
		txID       uuid.UUID
		curClsID   uuid.NullUUID
		curCatID   uuid.NullUUID
		curSource  sql.NullString
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.txID, &c.curClsID, &c.curCatID, &c.curSource); err != nil {
			return nil, fmt.Errorf("scan candidate: %w", err)
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate candidates: %w", err)
	}

	res := &BackfillResult{}
	for _, c := range candidates {
		updated, err := s.backfillOne(ctx, orgID, c.txID,
			c.curClsID, c.curCatID, c.curSource,
			input, appliedBy)
		if err != nil {
			log.Printf("classify: backfill tx=%s failed: %v", c.txID, err)
			res.Skipped++
			continue
		}
		if updated {
			res.Updated++
		} else {
			res.Skipped++
		}
	}
	return res, nil
}

// backfillOne applies a single reclassification within its own transaction.
// Returns (true, nil) when updated, (false, nil) when skipped (user invariant
// or already matching), and (false, err) on error.
func (s *CorrectionsStore) backfillOne(
	ctx context.Context,
	orgID, txID uuid.UUID,
	curClsID uuid.NullUUID,
	curCatID uuid.NullUUID,
	curSource sql.NullString,
	input CorrectionInput,
	appliedBy uuid.UUID,
) (bool, error) {
	dbTx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = dbTx.Rollback() }()

	// Re-read with lock to guard against concurrent corrections.
	var lockedClsID uuid.NullUUID
	var lockedSource sql.NullString
	err = dbTx.QueryRowContext(ctx, `
		SELECT tc.id, tc.source
		FROM transactions t
		LEFT JOIN transaction_classifications tc ON tc.id = t.current_classification_id
		WHERE t.id = $1 AND t.organization_id = $2
		FOR UPDATE OF t
	`, txID, orgID).Scan(&lockedClsID, &lockedSource)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("lock row: %w", err)
	}

	// Invariant: never overwrite source='user'.
	if lockedSource.Valid && ClassificationSource(lockedSource.String) == SourceUser {
		return false, nil
	}

	// Skip if already classified with the same category (idempotent).
	if lockedClsID.Valid {
		var existingCatID uuid.NullUUID
		_ = dbTx.QueryRowContext(ctx, `
			SELECT category_id FROM transaction_classifications WHERE id = $1
		`, lockedClsID.UUID).Scan(&existingCatID)
		if existingCatID.Valid && existingCatID.UUID == input.NewCategoryID {
			_ = dbTx.Rollback()
			return false, nil
		}
	}

	// Insert new classification row.
	newClsID := uuid.New()
	_, err = dbTx.ExecContext(ctx, `
		INSERT INTO transaction_classifications
			(id, transaction_id, organization_id, category_id, account_id,
			 source, confidence, is_current, created_at)
		VALUES ($1, $2, $3, $4, $5, 'user', 1.0, TRUE, NOW())
	`, newClsID, txID, orgID,
		nullableUUID(input.NewCategoryID),
		input.NewAccountID,
	)
	if err != nil {
		return false, fmt.Errorf("insert classification: %w", err)
	}

	// Flip old is_current.
	if lockedClsID.Valid {
		_, err = dbTx.ExecContext(ctx, `
			UPDATE transaction_classifications SET is_current = FALSE WHERE id = $1
		`, lockedClsID.UUID)
		if err != nil {
			return false, fmt.Errorf("clear old: %w", err)
		}
	}

	// Update transactions pointer.
	_, err = dbTx.ExecContext(ctx, `
		UPDATE transactions
		SET current_classification_id = $1,
		    category_id               = $2,
		    account_id                = $3,
		    updated_at                = NOW()
		WHERE id = $4 AND organization_id = $5
	`, newClsID,
		nullableUUID(input.NewCategoryID),
		input.NewAccountID,
		txID, orgID,
	)
	if err != nil {
		return false, fmt.Errorf("update pointer: %w", err)
	}

	// Record the backfill correction.
	_, err = dbTx.ExecContext(ctx, `
		INSERT INTO classification_corrections
			(id, organization_id, transaction_id, merchant_normalized,
			 old_category_id, new_category_id, old_source,
			 old_classification_id, new_classification_id,
			 corrected_by, created_at)
		VALUES ($1, $2, $3,
			(SELECT merchant_normalized FROM transactions WHERE id = $3),
			$4, $5, $6, $7, $8, $9, NOW())
	`, uuid.New(), orgID, txID,
		curCatID,
		nullableUUID(input.NewCategoryID),
		curSource,
		curClsID,
		newClsID,
		appliedBy,
	)
	if err != nil {
		return false, fmt.Errorf("insert correction record: %w", err)
	}

	if err = dbTx.Commit(); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// nullableUUID converts a uuid.UUID to a value suitable for a nullable UUID
// column: returns nil when id is uuid.Nil so the driver stores NULL.
func nullableUUID(id uuid.UUID) interface{} {
	if id == uuid.Nil {
		return nil
	}
	return id
}

// nullableSource converts a ClassificationSource to a nullable SQL value.
func nullableSource(s ClassificationSource) interface{} {
	if s == "" {
		return nil
	}
	return string(s)
}

// GetTransactionMerchantNorm returns the merchant_normalized value for a
// transaction, used by the handler to pass to ApplyToExisting after the
// main correction is recorded.
func (s *CorrectionsStore) GetTransactionMerchantNorm(
	ctx context.Context,
	orgID, txID uuid.UUID,
) (string, error) {
	var norm sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT merchant_normalized FROM transactions WHERE id = $1 AND organization_id = $2
	`, txID, orgID).Scan(&norm)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return norm.String, nil
}

// PromotionCount returns the number of distinct transactions that have been
// user-corrected to a given (merchant_normalized, category_id) pair in an org.
// Exposed for testing.
func (s *CorrectionsStore) PromotionCount(
	ctx context.Context,
	orgID uuid.UUID,
	merchantNorm string,
	categoryID uuid.UUID,
) (int, error) {
	norm := merchant.Normalize(merchantNorm)
	var count int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT transaction_id)
		FROM classification_corrections
		WHERE organization_id     = $1
		  AND merchant_normalized = $2
		  AND new_category_id     = $3
	`, orgID, norm, categoryID).Scan(&count)
	return count, err
}

// RuleExists returns true when a classification_rules row exists for the given
// (org, merchant_exact, merchant_normalized) key. Exposed for testing.
func (s *CorrectionsStore) RuleExists(
	ctx context.Context,
	orgID uuid.UUID,
	merchantNorm string,
) (bool, error) {
	norm := merchant.Normalize(merchantNorm)
	var exists bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM classification_rules
			WHERE organization_id = $1
			  AND match_type      = 'merchant_exact'
			  AND match_value     = $2
		)
	`, orgID, norm).Scan(&exists)
	return exists, err
}

