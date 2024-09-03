package payouts

import (
	"context"
	"encoding/csv"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
)

// GenerateFNBCSV generates a CSV file with merchant bank details and payout information formatted for FNB
func GenerateFNBCSV(ctx context.Context, pool *pgxpool.Pool, outputDir string) (string, error) {
	// Query the database
	rows, err := pool.Query(ctx, `
		SELECT 
			m.name AS "Name",
			mbd.account_name AS "Their Reference",
			mbd.account_number AS "My Reference",
			mbd.bank_name,
			mbd.branch_code,
			COALESCE(p.amount, 0) AS "Pay Amount",
			COALESCE(p.created_at, CURRENT_TIMESTAMP) AS "Last Paid"
		FROM 
			merchant_bank_details mbd
		JOIN 
			merchants m ON m.id = mbd.merchant_id
		LEFT JOIN 
			payouts p ON p.merchant_id = m.id AND p.status = 'completed'
		ORDER BY 
			m.name, p.created_at DESC
	`)
	if err != nil {
		return "", fmt.Errorf("query error: %w", err)
	}
	defer rows.Close()

	// Create a CSV file
	currentTime := time.Now()
	fileName := fmt.Sprintf("fnb_merchant_bank_details_%s.csv", currentTime.Format("20060102_150405"))
	filePath := fmt.Sprintf("%s/%s", outputDir, fileName)
	file, err := os.Create(filePath)
	if err != nil {
		return "", fmt.Errorf("file creation error: %w", err)
	}
	defer file.Close()

	// Create a CSV writer
	writer := csv.NewWriter(file)
	defer writer.Flush()

	// Write the header
	header := []string{"Name", "Their Reference", "My Reference", "Amount", "Last Paid", "Pay Amount", "Bank", "Branch Code"}
	if err := writer.Write(header); err != nil {
		return "", fmt.Errorf("error writing header: %w", err)
	}

	// Write the data
	for rows.Next() {
		var name, theirReference, myReference, bankName, branchCode string
		var payAmount float64
		var lastPaid time.Time

		err := rows.Scan(&name, &theirReference, &myReference, &bankName, &branchCode, &payAmount, &lastPaid)
		if err != nil {
			return "", fmt.Errorf("error scanning row: %w", err)
		}

		// FNB specific formatting
		amount := "0.00" // Placeholder amount

		row := []string{
			name,
			theirReference,
			myReference,
			amount,
			lastPaid.Format("2006/01/02"),
			fmt.Sprintf("%.2f", payAmount),
			bankName,
			branchCode,
		}

		if err := writer.Write(row); err != nil {
			return "", fmt.Errorf("error writing row: %w", err)
		}
	}

	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("error iterating rows: %w", err)
	}

	return filePath, nil
}
