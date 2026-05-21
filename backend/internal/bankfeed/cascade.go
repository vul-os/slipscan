package bankfeed

// cascade.go — lightweight rule→signal classification cascade for feed-imported
// transactions.
//
// Rather than calling into classify.Classifier (which is document-centric),
// the FeedCascader runs the same rule→merchant_signal SQL logic directly.
// This avoids an import cycle and keeps the bankfeed package self-contained.
//
// The LLM stage is intentionally omitted for feed imports: there is no
// document or raw-text context to send to the LLM, and the other two stages
// cover the vast majority of known merchants.  Unclassified feed transactions
// remain as-is and can be manually or batch-classified later.

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

// FeedCascader runs the classification_rules + merchant_signals stages for
// a transactions row that was imported from a bank feed.
type FeedCascader struct {
	db *sql.DB
}

// NewFeedCascader constructs a FeedCascader backed by the given DB pool.
func NewFeedCascader(db *sql.DB) *FeedCascader {
	return &FeedCascader{db: db}
}

// RunCascade runs the rule→signal cascade for the given transaction.
// Non-fatal errors are returned but the caller typically logs and continues.
func (c *FeedCascader) RunCascade(ctx context.Context, orgID, txID uuid.UUID) error {
	// Load the transaction's merchant_normalized value.
	var merchantNorm sql.NullString
	err := c.db.QueryRowContext(ctx, `
		SELECT merchant_normalized FROM transactions WHERE id = $1 AND organization_id = $2
	`, txID, orgID).Scan(&merchantNorm)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // nothing to classify
	}
	if err != nil {
		return err
	}
	if !merchantNorm.Valid || merchantNorm.String == "" {
		return nil // no merchant info
	}
	mn := merchantNorm.String

	// Stage 1: exact rule.
	cl, err := c.tryRule(ctx, orgID, mn, "merchant_exact")
	if err != nil {
		return err
	}
	if cl != nil {
		return c.writeClassification(ctx, orgID, txID, cl)
	}

	// Stage 2: contains rule.
	cl, err = c.tryContainsRule(ctx, orgID, mn)
	if err != nil {
		return err
	}
	if cl != nil {
		return c.writeClassification(ctx, orgID, txID, cl)
	}

	// Stage 3: merchant_signals (cross-tenant).
	cl, err = c.trySignal(ctx, orgID, mn)
	if err != nil {
		return err
	}
	if cl != nil {
		return c.writeClassification(ctx, orgID, txID, cl)
	}

	return nil // unclassified — leave for manual or LLM classification
}

type cascadeResult struct {
	ruleID     uuid.NullUUID
	categoryID uuid.NullUUID
	confidence float64
	source     string // 'rule' | 'merchant_signal'
}

func (c *FeedCascader) tryRule(ctx context.Context, orgID uuid.UUID, merchantNorm, matchType string) (*cascadeResult, error) {
	const q = `
		SELECT id, category_id, COALESCE(confidence, 1.0)
		FROM classification_rules
		WHERE organization_id = $1
		  AND match_type = $2::classification_match_type
		  AND match_value = $3
		ORDER BY confidence DESC
		LIMIT 1
	`
	var r cascadeResult
	r.source = "rule"
	var ruleID uuid.UUID
	err := c.db.QueryRowContext(ctx, q, orgID, matchType, merchantNorm).Scan(
		&ruleID, &r.categoryID, &r.confidence,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.ruleID = uuid.NullUUID{UUID: ruleID, Valid: true}
	return &r, nil
}

func (c *FeedCascader) tryContainsRule(ctx context.Context, orgID uuid.UUID, merchantNorm string) (*cascadeResult, error) {
	const q = `
		SELECT id, category_id, COALESCE(confidence, 1.0)
		FROM classification_rules
		WHERE organization_id = $1
		  AND match_type = 'merchant_contains'
		  AND $2 LIKE '%' || match_value || '%'
		ORDER BY confidence DESC
		LIMIT 1
	`
	var r cascadeResult
	r.source = "rule"
	var ruleID uuid.UUID
	err := c.db.QueryRowContext(ctx, q, orgID, merchantNorm).Scan(
		&ruleID, &r.categoryID, &r.confidence,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.ruleID = uuid.NullUUID{UUID: ruleID, Valid: true}
	return &r, nil
}

func (c *FeedCascader) trySignal(ctx context.Context, orgID uuid.UUID, merchantNorm string) (*cascadeResult, error) {
	// Look up the top-voted category label from merchant_signals.
	const qLabel = `
		SELECT category_label
		FROM merchant_signals
		WHERE merchant_normalized = $1
		ORDER BY vote_count DESC
		LIMIT 1
	`
	var label string
	err := c.db.QueryRowContext(ctx, qLabel, merchantNorm).Scan(&label)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// Resolve label → category_id within the org.
	const qCat = `
		SELECT id FROM categories
		WHERE organization_id = $1 AND LOWER(name) = LOWER($2)
		LIMIT 1
	`
	var catID uuid.UUID
	err = c.db.QueryRowContext(ctx, qCat, orgID, label).Scan(&catID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &cascadeResult{
		categoryID: uuid.NullUUID{UUID: catID, Valid: true},
		confidence: 0.7, // signal confidence
		source:     "merchant_signal",
	}, nil
}

func (c *FeedCascader) writeClassification(ctx context.Context, orgID, txID uuid.UUID, cl *cascadeResult) error {
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// Clear any existing current classification.
	_, err = tx.ExecContext(ctx, `
		UPDATE transaction_classifications SET is_current = false
		WHERE transaction_id = $1 AND is_current
	`, txID)
	if err != nil {
		return err
	}

	// Insert the new classification row.
	var classID uuid.UUID
	err = tx.QueryRowContext(ctx, `
		INSERT INTO transaction_classifications (
			transaction_id, organization_id,
			rule_id, category_id,
			source, confidence, is_current
		) VALUES (
			$1, $2,
			$3, $4,
			$5::classification_source, $6, true
		) RETURNING id
	`, txID, orgID,
		cl.ruleID, cl.categoryID,
		cl.source, cl.confidence,
	).Scan(&classID)
	if err != nil {
		return err
	}

	// Update the denormalized pointer.
	_, err = tx.ExecContext(ctx, `
		UPDATE transactions SET
			category_id                  = $2,
			current_classification_id    = $3,
			status                       = 'verified'::transaction_status,
			updated_at                   = $4
		WHERE id = $1
	`, txID, cl.categoryID, classID, time.Now())
	if err != nil {
		return err
	}

	return tx.Commit()
}
