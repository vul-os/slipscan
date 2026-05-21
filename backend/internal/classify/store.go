package classify

import (
	"context"
	"database/sql"
	"time"

	"github.com/google/uuid"
)

// TransactionRow is a joined view of a transaction plus its current
// classification — used for the GET /orgs/{orgID}/transactions response.
type TransactionRow struct {
	ID                      uuid.UUID
	OrganizationID          uuid.UUID
	DocumentID              uuid.NullUUID
	Merchant                sql.NullString
	MerchantNormalized      sql.NullString
	Description             sql.NullString
	Amount                  sql.NullFloat64
	Currency                sql.NullString
	Tax                     sql.NullFloat64
	PostedDate              sql.NullTime
	Direction               string
	Status                  string
	CurrentClassificationID uuid.NullUUID
	CreatedAt               time.Time
	UpdatedAt               time.Time

	// Classification fields (NULLable — transaction may be unclassified).
	ClassSource     sql.NullString
	ClassConfidence sql.NullFloat64
	ClassCategoryID uuid.NullUUID
	ClassAccountID  uuid.NullUUID
	CategoryName    sql.NullString
}

// ListTransactions returns transactions for an org with their current
// classification joined in.  Pagination via limit/offset.
func ListTransactions(ctx context.Context, db *sql.DB, orgID uuid.UUID, limit, offset int) ([]TransactionRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	const q = `
		SELECT
			t.id, t.organization_id, t.document_id,
			t.merchant, t.merchant_normalized, t.description,
			t.amount, t.currency, t.tax, t.posted_date,
			t.direction, t.status,
			t.current_classification_id,
			t.created_at, t.updated_at,
			tc.source, tc.confidence, tc.category_id, tc.account_id,
			c.name
		FROM transactions t
		LEFT JOIN transaction_classifications tc
			ON tc.id = t.current_classification_id
		LEFT JOIN categories c
			ON c.id = tc.category_id
		WHERE t.organization_id = $1
		ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC
		LIMIT $2 OFFSET $3
	`
	rows, err := db.QueryContext(ctx, q, orgID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []TransactionRow
	for rows.Next() {
		var r TransactionRow
		if err := rows.Scan(
			&r.ID, &r.OrganizationID, &r.DocumentID,
			&r.Merchant, &r.MerchantNormalized, &r.Description,
			&r.Amount, &r.Currency, &r.Tax, &r.PostedDate,
			&r.Direction, &r.Status,
			&r.CurrentClassificationID,
			&r.CreatedAt, &r.UpdatedAt,
			&r.ClassSource, &r.ClassConfidence, &r.ClassCategoryID, &r.ClassAccountID,
			&r.CategoryName,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
