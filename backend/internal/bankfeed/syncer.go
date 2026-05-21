package bankfeed

// syncer.go — drives the transaction-import pipeline for a single connection.
//
// The Syncer is shared between the periodic Scheduler and the on-demand
// webhook/manual-sync handlers.  It:
//
//  1. Fetches transactions from the provider for the rolling fetch window.
//  2. Upserts bank_statement + statement_lines rows (deduped on provider_txn_id).
//  3. Creates a transactions row for each new line.
//  4. Runs the P1-02 classification cascade (rule → merchant_signal → skip LLM).
//  5. Updates bank_feed_connections.last_synced_at + cursor.
//
// Classification note: the Syncer runs the classification_rules +
// merchant_signals stages directly via the Cascader interface.  LLM
// classification is skipped for feed-imported transactions because there is no
// document context; the user can trigger it manually or a separate job can
// pick up unclassified rows.
//
// Re-auth handling: on a 401 / token-expired error the Syncer attempts one
// token refresh; on failure it marks the connection reauth_required.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
)

// Cascader is the minimal interface used by the Syncer to run the
// classification cascade on a newly-imported transaction.
// This interface is satisfied by *FeedCascader (defined in cascade.go)
// as well as by test stubs.
type Cascader interface {
	RunCascade(ctx context.Context, orgID, txID uuid.UUID) error
}

// Syncer performs the fetch → upsert → classify pipeline.
type Syncer struct {
	provider Provider
	store    *Store
	cascader Cascader // may be nil (classification skipped)
}

// NewSyncer constructs a Syncer.  cascader may be nil.
func NewSyncer(provider Provider, store *Store, cascader Cascader) *Syncer {
	return &Syncer{provider: provider, store: store, cascader: cascader}
}

// SyncAll fetches due connections and syncs each one.  Safe to call from the
// scheduler or a webhook trigger.
func (s *Syncer) SyncAll(ctx context.Context) error {
	conns, err := s.store.ListDueConnections(ctx, 4*time.Hour)
	if err != nil {
		return fmt.Errorf("bankfeed: list due connections: %w", err)
	}
	for i := range conns {
		c := &conns[i]
		if err := s.SyncConnection(ctx, c, c.AccessTokenEncrypted); err != nil {
			log.Printf("bankfeed: sync connection %s (%s %s): %v",
				c.ID, c.Provider, c.InstitutionName, err)
			// Continue with remaining connections.
		}
	}
	return nil
}

// SyncConnection syncs a single bank_feed_connections row.
func (s *Syncer) SyncConnection(ctx context.Context, conn *Connection, accessToken string) error {
	// Determine fetch window: from the last sync (or 90 days ago for initial).
	var from time.Time
	if conn.LastSyncedAt.Valid {
		from = conn.LastSyncedAt.Time.Add(-24 * time.Hour) // 1-day overlap for late-posting txns
	} else {
		from = time.Now().AddDate(0, -3, 0) // 90-day initial window
	}
	to := time.Now()

	cursor := conn.Cursor
	newTransactions := 0

	for {
		txns, nextCursor, err := s.provider.FetchTransactions(
			ctx, accessToken, conn.ProviderAccountID, from, to, cursor,
		)
		if err != nil {
			// Check if token has expired — attempt one refresh.
			if isAuthError(err) {
				newAccess, newRefresh, expiresAt, refreshErr := s.provider.RefreshToken(ctx, conn.RefreshTokenEncrypted)
				if refreshErr != nil {
					_ = s.store.UpdateConnectionStatus(ctx, conn.ID, StatusReauthRequired,
						"token_expired", "Re-authentication required: "+refreshErr.Error())
					return fmt.Errorf("bankfeed: token refresh failed (conn %s): %w", conn.ID, refreshErr)
				}
				_ = s.store.UpdateTokens(ctx, conn.ID, newAccess, newRefresh, expiresAt)
				accessToken = newAccess
				conn.RefreshTokenEncrypted = newRefresh
				// Retry the fetch with the new token.
				txns, nextCursor, err = s.provider.FetchTransactions(
					ctx, accessToken, conn.ProviderAccountID, from, to, cursor,
				)
				if err != nil {
					_ = s.store.UpdateConnectionStatus(ctx, conn.ID, StatusError,
						"fetch_failed", err.Error())
					return fmt.Errorf("bankfeed: fetch after refresh (conn %s): %w", conn.ID, err)
				}
			} else {
				_ = s.store.UpdateConnectionStatus(ctx, conn.ID, StatusError,
					"fetch_failed", err.Error())
				return fmt.Errorf("bankfeed: fetch transactions (conn %s): %w", conn.ID, err)
			}
		}

		if len(txns) > 0 {
			n, err := s.upsertBatch(ctx, conn, txns, from, to)
			if err != nil {
				return err
			}
			newTransactions += n
		}

		if nextCursor == "" {
			break
		}
		cursor = nextCursor
	}

	if err := s.store.MarkSynced(ctx, conn.ID, cursor); err != nil {
		return fmt.Errorf("bankfeed: mark synced (conn %s): %w", conn.ID, err)
	}

	log.Printf("bankfeed: synced connection %s (%s): %d new transactions",
		conn.ID, conn.InstitutionName, newTransactions)
	return nil
}

// upsertBatch upserts a batch of provider transactions for a connection.
// Returns the count of newly-imported transactions.
func (s *Syncer) upsertBatch(ctx context.Context, conn *Connection, txns []ProviderTransaction, periodStart, periodEnd time.Time) (int, error) {
	// Determine statement currency from the first transaction.
	currency := "ZAR"
	if len(txns) > 0 && txns[0].Currency != "" {
		currency = txns[0].Currency
	}

	statementID, err := s.store.EnsureStatement(ctx, conn.OrganizationID, conn.ID, periodStart, periodEnd, currency)
	if err != nil {
		return 0, fmt.Errorf("bankfeed: ensure statement: %w", err)
	}

	newCount := 0
	for _, pt := range txns {
		lineID, inserted, err := s.store.UpsertLine(ctx, conn.OrganizationID, statementID, conn.ID, pt)
		if errors.Is(err, ErrDuplicate) {
			continue // already imported — skip
		}
		if err != nil {
			log.Printf("bankfeed: upsert line (conn %s, provider_txn_id %s): %v",
				conn.ID, pt.ProviderTxnID, err)
			continue
		}
		if !inserted {
			continue
		}

		// Create a transactions row for the new line.
		txID, err := s.store.CreateTransaction(ctx, conn.OrganizationID, pt)
		if err != nil {
			log.Printf("bankfeed: create transaction for line %s: %v", lineID, err)
			continue
		}

		// Link the statement line to the transaction.
		if err := s.store.LinkTransaction(ctx, lineID, txID); err != nil {
			log.Printf("bankfeed: link transaction %s → line %s: %v", txID, lineID, err)
		}

		// Run the P1-02 classification cascade (rule → signal stages).
		if s.cascader != nil {
			if err := s.cascader.RunCascade(ctx, conn.OrganizationID, txID); err != nil { //nolint:typecheck
				log.Printf("bankfeed: classify transaction %s: %v", txID, err)
				// Non-fatal: transaction is imported; classification is best-effort.
			}
		}

		newCount++
	}
	return newCount, nil
}

// isAuthError heuristically detects a token-expiry / 401 error from the
// provider.  Each provider's FetchTransactions should wrap its HTTP error
// messages consistently so this check works.
func isAuthError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	for _, kw := range []string{"401", "unauthorized", "Unauthorized", "token expired", "invalid_token"} {
		if stringContains(msg, kw) {
			return true
		}
	}
	return false
}

func stringContains(s, substr string) bool {
	if len(substr) == 0 {
		return true
	}
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
