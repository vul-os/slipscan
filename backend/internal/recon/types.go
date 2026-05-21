// Package recon implements the P3-02 document ↔ bank-feed auto-reconciliation
// engine.  It matches document-derived transactions (produced by the P1-01
// extraction pipeline) against imported bank statement_lines (populated by
// P3-01 or manual import), scoring candidates by amount proximity, date
// proximity, and normalized merchant similarity, then persisting the result
// with a confidence and state so the UI can surface three buckets:
//
//   - matched  — auto or user-confirmed links
//   - suggested — mid-confidence proposals awaiting review
//   - unmatched — transactions or statement lines with no active counterpart
//
// The optional LLM tie-breaker is compiled in only when the "llm" build tag is
// set (go build -tags llm ./...).  Default builds are heuristic-only and
// require no API key.
package recon

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

// ─── Sentinel errors ──────────────────────────────────────────────────────────

var (
	// ErrNotFound is returned when a referenced match or side-entity is absent.
	ErrNotFound = errors.New("recon: not found")

	// ErrDoubleMatch is returned when a confirm would violate the no-double-match
	// invariant (the transaction or line already has an active match).
	ErrDoubleMatch = errors.New("recon: double-match prevented")

	// ErrAlreadyActioned is returned when the caller tries to confirm/reject an
	// already confirmed or rejected match.
	ErrAlreadyActioned = errors.New("recon: match already actioned")
)

// ─── Match state ──────────────────────────────────────────────────────────────

// MatchState mirrors the recon_match_state DB enum.
type MatchState string

const (
	StateAuto      MatchState = "auto"
	StateSuggested MatchState = "suggested"
	StateConfirmed MatchState = "confirmed"
	StateRejected  MatchState = "rejected"
)

// ─── Config ───────────────────────────────────────────────────────────────────

// Config holds the tunable thresholds for the matcher.  All fields have
// sensible defaults (see DefaultConfig).
type Config struct {
	// DateWindowDays is the ± tolerance in calendar days between the document
	// transaction date and the bank statement line date.  Card settlement lag
	// is typically 0–3 days; set to 5 for safety.
	DateWindowDays int

	// AmountToleranceAbs is the maximum absolute difference (in the document's
	// currency) before a candidate is rejected on amount alone.
	AmountToleranceAbs float64

	// AmountTolerancePct is an alternative tolerance expressed as a fraction of
	// the document amount (e.g. 0.01 = 1 %).  The matcher accepts a pair if
	// EITHER absolute OR percentage tolerance is satisfied.
	AmountTolerancePct float64

	// AutoConfidenceThreshold: matches at or above this score are auto-applied
	// (state=auto) without user action.
	AutoConfidenceThreshold float64

	// SuggestConfidenceThreshold: matches at or above this score (but below
	// AutoConfidenceThreshold) are queued as suggestions (state=suggested).
	// Matches below this score are discarded.
	SuggestConfidenceThreshold float64
}

// DefaultConfig returns the recommended production defaults.
func DefaultConfig() Config {
	return Config{
		DateWindowDays:             5,
		AmountToleranceAbs:         0.02,   // 2 cents — rounding only
		AmountTolerancePct:         0.005,  // 0.5 %
		AutoConfidenceThreshold:    0.85,
		SuggestConfidenceThreshold: 0.55,
	}
}

// ─── Core domain types ────────────────────────────────────────────────────────

// TxCandidate is a document-derived transaction row fetched for matching.
type TxCandidate struct {
	ID                 uuid.UUID
	OrganizationID     uuid.UUID
	DocumentID         uuid.NullUUID
	PostedDate         time.Time  // may be zero if unknown
	Amount             float64
	Currency           string
	Merchant           string
	MerchantNormalized string
}

// LineCandidate is an imported bank statement_line row fetched for matching.
type LineCandidate struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	LineDate       time.Time // may be zero if unknown
	Description    string
	Amount         float64
}

// MatchRecord is a persisted reconciliation_matches row returned by the store.
type MatchRecord struct {
	ID              uuid.UUID
	OrganizationID  uuid.UUID
	TransactionID   uuid.UUID
	StatementLineID uuid.UUID
	State           MatchState
	Confidence      float64
	AmountDelta     float64
	DateDeltaDays   int
	MerchantScore   float64
	ActionedBy      uuid.NullUUID
	ActionedAt      *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// ─── Request / response types used by handlers ────────────────────────────────

// Buckets holds the three-bucket reconciliation view for a single org.
type Buckets struct {
	Matched    []MatchRecord `json:"matched"`
	Suggested  []MatchRecord `json:"suggested"`
	Unmatched  *Unmatched    `json:"unmatched"`
}

// Unmatched carries the IDs of the two "missing counterpart" lists.
type Unmatched struct {
	// TransactionIDs: document transactions that have no active match.
	TransactionIDs []uuid.UUID `json:"transaction_ids"`
	// StatementLineIDs: bank lines that have no active match.
	StatementLineIDs []uuid.UUID `json:"statement_line_ids"`
}

// ActionRequest is the body for confirm / reject endpoints.
type ActionRequest struct {
	// No body fields required — the action is implied by the endpoint path.
	// Kept as a struct so we can extend (e.g. split amounts) later.
}

// RunResult summarises a matcher run (returned by POST .../reconcile).
type RunResult struct {
	AutoMatched int `json:"auto_matched"`
	Suggested   int `json:"suggested"`
	Skipped     int `json:"skipped"`
}
