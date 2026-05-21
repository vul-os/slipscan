package recon

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Store is the persistence layer for the recon package.  It owns the
// reconciliation_matches table and the read queries against transactions and
// statement_lines needed by the matcher.
type Store struct {
	db  *sql.DB
	cfg Config
}

// NewStore creates a Store backed by db, using the supplied matcher Config.
// Call NewStore(pool, DefaultConfig()) for production defaults.
func NewStore(db *sql.DB, cfg Config) *Store {
	return &Store{db: db, cfg: cfg}
}

// ─── Candidate fetching ───────────────────────────────────────────────────────

// UnmatchedTransactions returns document-derived transactions for orgID that
// do not yet have an active (non-rejected) reconciliation match.
func (s *Store) UnmatchedTransactions(ctx context.Context, orgID uuid.UUID) ([]TxCandidate, error) {
	const q = `
		SELECT t.id, t.organization_id, t.document_id,
		       COALESCE(t.posted_date, '1970-01-01'::date),
		       COALESCE(t.amount, 0),
		       COALESCE(t.currency, ''),
		       COALESCE(t.merchant, ''),
		       COALESCE(t.merchant_normalized, '')
		FROM transactions t
		WHERE t.organization_id = $1
		  AND t.document_id IS NOT NULL
		  AND NOT EXISTS (
		      SELECT 1 FROM reconciliation_matches m
		      WHERE m.transaction_id = t.id
		        AND m.organization_id = $1
		        AND m.state <> 'rejected'
		  )
		ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, fmt.Errorf("recon.UnmatchedTransactions: %w", err)
	}
	defer rows.Close()

	var out []TxCandidate
	for rows.Next() {
		var c TxCandidate
		var pd time.Time
		var docID uuid.NullUUID
		if err := rows.Scan(
			&c.ID, &c.OrganizationID, &docID,
			&pd, &c.Amount, &c.Currency,
			&c.Merchant, &c.MerchantNormalized,
		); err != nil {
			return nil, fmt.Errorf("recon.UnmatchedTransactions scan: %w", err)
		}
		c.DocumentID = docID
		if !pd.IsZero() {
			c.PostedDate = pd
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// UnmatchedLines returns statement_lines for orgID that do not yet have an
// active (non-rejected) reconciliation match.
func (s *Store) UnmatchedLines(ctx context.Context, orgID uuid.UUID) ([]LineCandidate, error) {
	const q = `
		SELECT sl.id, sl.organization_id,
		       COALESCE(sl.line_date, '1970-01-01'::date),
		       COALESCE(sl.description, ''),
		       COALESCE(sl.amount, 0)
		FROM statement_lines sl
		WHERE sl.organization_id = $1
		  AND NOT EXISTS (
		      SELECT 1 FROM reconciliation_matches m
		      WHERE m.statement_line_id = sl.id
		        AND m.organization_id = $1
		        AND m.state <> 'rejected'
		  )
		ORDER BY sl.line_date DESC NULLS LAST, sl.created_at DESC
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, fmt.Errorf("recon.UnmatchedLines: %w", err)
	}
	defer rows.Close()

	var out []LineCandidate
	for rows.Next() {
		var c LineCandidate
		var ld time.Time
		if err := rows.Scan(
			&c.ID, &c.OrganizationID,
			&ld, &c.Description, &c.Amount,
		); err != nil {
			return nil, fmt.Errorf("recon.UnmatchedLines scan: %w", err)
		}
		if !ld.IsZero() {
			c.LineDate = ld
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ─── Match persistence ────────────────────────────────────────────────────────

// InsertMatch persists a single CandidateMatch, assigning the state based on
// whether its confidence meets the auto threshold.  Returns ErrDoubleMatch if
// the DB unique constraint fires (i.e. the transaction or line is already
// matched — callers should silently skip such errors when bulk-inserting).
func (s *Store) InsertMatch(ctx context.Context, orgID uuid.UUID, c CandidateMatch) (MatchRecord, error) {
	state := StateSuggested
	if c.Confidence >= s.cfg.AutoConfidenceThreshold {
		state = StateAuto
	}

	const q = `
		INSERT INTO reconciliation_matches
		    (organization_id, transaction_id, statement_line_id,
		     state, confidence, amount_delta, date_delta_days, merchant_score)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, created_at, updated_at
	`
	var m MatchRecord
	m.OrganizationID = orgID
	m.TransactionID = c.Tx.ID
	m.StatementLineID = c.Line.ID
	m.State = state
	m.Confidence = c.Confidence
	m.AmountDelta = c.AmountDelta
	m.DateDeltaDays = c.DateDeltaDays
	m.MerchantScore = c.MerchantScore

	err := s.db.QueryRowContext(ctx, q,
		orgID, c.Tx.ID, c.Line.ID,
		string(state), c.Confidence, c.AmountDelta, c.DateDeltaDays, c.MerchantScore,
	).Scan(&m.ID, &m.CreatedAt, &m.UpdatedAt)

	if err != nil {
		if isUniqueViolation(err) {
			return MatchRecord{}, ErrDoubleMatch
		}
		return MatchRecord{}, fmt.Errorf("recon.InsertMatch: %w", err)
	}
	return m, nil
}

// isUniqueViolation detects PostgreSQL error code 23505 (unique_violation).
// We check the error string since we don't import a Postgres driver directly.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	return containsStr(err.Error(), "23505") ||
		containsStr(err.Error(), "unique") ||
		containsStr(err.Error(), "duplicate")
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(sub); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		}())
}

// ─── Listing ──────────────────────────────────────────────────────────────────

// ListByState returns all reconciliation_matches for orgID in the given state.
func (s *Store) ListByState(ctx context.Context, orgID uuid.UUID, state MatchState) ([]MatchRecord, error) {
	const q = `
		SELECT id, organization_id, transaction_id, statement_line_id,
		       state, confidence, amount_delta, date_delta_days, merchant_score,
		       actioned_by, actioned_at, created_at, updated_at
		FROM reconciliation_matches
		WHERE organization_id = $1 AND state = $2
		ORDER BY confidence DESC, created_at DESC
	`
	return s.scanMatches(ctx, q, orgID, string(state))
}

// ListUnmatchedTxIDs returns transaction IDs (document-derived, active
// transactions) for orgID that have no non-rejected match.
func (s *Store) ListUnmatchedTxIDs(ctx context.Context, orgID uuid.UUID) ([]uuid.UUID, error) {
	const q = `
		SELECT t.id
		FROM transactions t
		WHERE t.organization_id = $1
		  AND t.document_id IS NOT NULL
		  AND NOT EXISTS (
		      SELECT 1 FROM reconciliation_matches m
		      WHERE m.transaction_id = t.id
		        AND m.organization_id = $1
		        AND m.state <> 'rejected'
		  )
		ORDER BY t.posted_date DESC NULLS LAST
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, fmt.Errorf("recon.ListUnmatchedTxIDs: %w", err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ListUnmatchedLineIDs returns statement_line IDs for orgID that have no
// non-rejected match.
func (s *Store) ListUnmatchedLineIDs(ctx context.Context, orgID uuid.UUID) ([]uuid.UUID, error) {
	const q = `
		SELECT sl.id
		FROM statement_lines sl
		WHERE sl.organization_id = $1
		  AND NOT EXISTS (
		      SELECT 1 FROM reconciliation_matches m
		      WHERE m.statement_line_id = sl.id
		        AND m.organization_id = $1
		        AND m.state <> 'rejected'
		  )
		ORDER BY sl.line_date DESC NULLS LAST
	`
	rows, err := s.db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, fmt.Errorf("recon.ListUnmatchedLineIDs: %w", err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ─── Actions ──────────────────────────────────────────────────────────────────

// GetMatch retrieves a single match by ID, asserting org ownership.
func (s *Store) GetMatch(ctx context.Context, orgID, matchID uuid.UUID) (MatchRecord, error) {
	const q = `
		SELECT id, organization_id, transaction_id, statement_line_id,
		       state, confidence, amount_delta, date_delta_days, merchant_score,
		       actioned_by, actioned_at, created_at, updated_at
		FROM reconciliation_matches
		WHERE id = $1 AND organization_id = $2
	`
	rows, err := s.scanMatches(ctx, q, matchID, orgID)
	if err != nil {
		return MatchRecord{}, err
	}
	if len(rows) == 0 {
		return MatchRecord{}, ErrNotFound
	}
	return rows[0], nil
}

// Confirm transitions a match from auto/suggested → confirmed.  Returns
// ErrAlreadyActioned when already confirmed/rejected.
func (s *Store) Confirm(ctx context.Context, orgID, matchID, userID uuid.UUID) (MatchRecord, error) {
	return s.transition(ctx, orgID, matchID, userID, StateConfirmed,
		[]MatchState{StateAuto, StateSuggested})
}

// Reject transitions a match to rejected (releasing the no-double-match lock
// on the associated transaction and line, allowing a re-match).
func (s *Store) Reject(ctx context.Context, orgID, matchID, userID uuid.UUID) (MatchRecord, error) {
	return s.transition(ctx, orgID, matchID, userID, StateRejected,
		[]MatchState{StateAuto, StateSuggested, StateConfirmed})
}

func (s *Store) transition(
	ctx context.Context,
	orgID, matchID, userID uuid.UUID,
	to MatchState,
	allowedFrom []MatchState,
) (MatchRecord, error) {
	m, err := s.GetMatch(ctx, orgID, matchID)
	if err != nil {
		return MatchRecord{}, err
	}
	allowed := false
	for _, st := range allowedFrom {
		if m.State == st {
			allowed = true
			break
		}
	}
	if !allowed {
		return MatchRecord{}, ErrAlreadyActioned
	}

	now := time.Now().UTC()
	const q = `
		UPDATE reconciliation_matches
		SET state = $1, actioned_by = $2, actioned_at = $3, updated_at = NOW()
		WHERE id = $4 AND organization_id = $5
		RETURNING id, organization_id, transaction_id, statement_line_id,
		          state, confidence, amount_delta, date_delta_days, merchant_score,
		          actioned_by, actioned_at, created_at, updated_at
	`
	rows, err := s.scanMatches(ctx, q,
		string(to), userID, now, matchID, orgID)
	if err != nil {
		return MatchRecord{}, fmt.Errorf("recon.transition: %w", err)
	}
	if len(rows) == 0 {
		return MatchRecord{}, ErrNotFound
	}
	return rows[0], nil
}

// ─── Run ──────────────────────────────────────────────────────────────────────

// RunMatcher fetches unmatched candidates, scores them, and persists results.
// It returns a summary of what happened.  The caller should invoke this after
// new transactions or statement_lines are imported.
func (s *Store) RunMatcher(ctx context.Context, orgID uuid.UUID) (RunResult, error) {
	txs, err := s.UnmatchedTransactions(ctx, orgID)
	if err != nil {
		return RunResult{}, err
	}
	if len(txs) == 0 {
		return RunResult{}, nil
	}

	lines, err := s.UnmatchedLines(ctx, orgID)
	if err != nil {
		return RunResult{}, err
	}
	if len(lines) == 0 {
		return RunResult{}, nil
	}

	candidates := GenerateCandidates(txs, lines, s.cfg)

	// Sort candidates by descending confidence so that when two candidates
	// compete for the same tx or line, the best one wins the race.
	sortByConfidence(candidates)

	var result RunResult
	// Track which tx/line IDs have been committed this run (in-memory guard
	// to avoid hitting the DB unique index for the second candidate in the
	// same run involving the same entity).
	usedTx := make(map[uuid.UUID]bool)
	usedLine := make(map[uuid.UUID]bool)

	for _, c := range candidates {
		if usedTx[c.Tx.ID] || usedLine[c.Line.ID] {
			result.Skipped++
			continue
		}

		m, err := s.InsertMatch(ctx, orgID, c)
		if errors.Is(err, ErrDoubleMatch) {
			result.Skipped++
			continue
		}
		if err != nil {
			return result, err
		}

		usedTx[c.Tx.ID] = true
		usedLine[c.Line.ID] = true

		if m.State == StateAuto {
			result.AutoMatched++
		} else {
			result.Suggested++
		}
	}

	return result, nil
}

// sortByConfidence performs an in-place sort of candidates descending by
// Confidence.  Uses insertion sort (small slices are common; avoids importing
// sort for a single-field compare).
func sortByConfidence(cs []CandidateMatch) {
	for i := 1; i < len(cs); i++ {
		for j := i; j > 0 && cs[j].Confidence > cs[j-1].Confidence; j-- {
			cs[j], cs[j-1] = cs[j-1], cs[j]
		}
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// scanMatches is a generic row scanner for reconciliation_matches queries.
func (s *Store) scanMatches(ctx context.Context, q string, args ...any) ([]MatchRecord, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []MatchRecord
	for rows.Next() {
		var m MatchRecord
		var state string
		var actionedBy uuid.NullUUID
		var actionedAt sql.NullTime
		if err := rows.Scan(
			&m.ID, &m.OrganizationID, &m.TransactionID, &m.StatementLineID,
			&state, &m.Confidence, &m.AmountDelta, &m.DateDeltaDays, &m.MerchantScore,
			&actionedBy, &actionedAt, &m.CreatedAt, &m.UpdatedAt,
		); err != nil {
			return nil, err
		}
		m.State = MatchState(state)
		m.ActionedBy = actionedBy
		if actionedAt.Valid {
			t := actionedAt.Time
			m.ActionedAt = &t
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
