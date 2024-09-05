package payout

import (
	"context"
	"encoding/csv"
	"fmt"
	"os"
	"time"

	"github.com/exolutionza/shapepay-scraper-go/src/db"
)

type Recipient struct {
	Name           string
	Account        string
	AccountType    string
	BranchCode     string
	Amount         string
	OwnReference   string
	TheirReference string
}

func GenerateCSV() error {
	recipients, err := fetchRecipients()
	if err != nil {
		return fmt.Errorf("failed to fetch recipients: %w", err)
	}

	fileName, err := createCSVFile(recipients)
	if err != nil {
		return fmt.Errorf("failed to create CSV file: %w", err)
	}

	fmt.Printf("CSV file generated successfully: %s\n", fileName)
	return nil
}

func fetchRecipients() ([]Recipient, error) {
	ctx := context.Background()
	query := `
		SELECT 
			mbd.account_name AS "RECIPIENT NAME",
			mbd.account_number AS "RECIPIENT ACCOUNT",
			'CURRENT' AS "RECIPIENT ACCOUNT TYPE",
			mbd.branch_code AS "BRANCHCODE",
			'1.00' AS "AMOUNT",
			m.name AS "OWN REFERENCE",
			'shapepay' AS "RECIPIENT REFERENCE"
		FROM 
			merchant_bank_details mbd
		JOIN 
			merchants m ON m.id = mbd.merchant_id
		ORDER BY 
			m.name
	`

	rows, err := db.Pool.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query database: %w", err)
	}
	defer rows.Close()

	var recipients []Recipient
	for rows.Next() {
		var r Recipient
		err := rows.Scan(&r.Name, &r.Account, &r.AccountType, &r.BranchCode, &r.Amount, &r.OwnReference, &r.TheirReference)
		if err != nil {
			return nil, fmt.Errorf("failed to scan row: %w", err)
		}
		recipients = append(recipients, r)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating over rows: %w", err)
	}

	return recipients, nil
}

func createCSVFile(recipients []Recipient) (string, error) {
	currentTime := time.Now()
	fileName := fmt.Sprintf("OB_Recipients_CSV_Import_%s.csv", currentTime.Format("20060102_150405"))
	file, err := os.Create(fileName)
	if err != nil {
		return "", fmt.Errorf("failed to create CSV file: %w", err)
	}
	defer file.Close()

	writer := csv.NewWriter(file)
	defer writer.Flush()

	if err := writeHeaderRows(writer, currentTime); err != nil {
		return "", err
	}

	if err := writeRecipients(writer, recipients); err != nil {
		return "", err
	}

	return fileName, nil
}

func writeHeaderRows(writer *csv.Writer, currentTime time.Time) error {
	headerRows := [][]string{
		{"BInSol - U ver 1.00"},
		{currentTime.Format("02-01-2006")},
		{"63112690961"},
		{
			"RECIPIENT NAME", "RECIPIENT ACCOUNT", "RECIPIENT ACCOUNT TYPE", "BRANCHCODE", "AMOUNT",
			"OWN REFERENCE", "RECIPIENT REFERENCE", "EMAIL 1 NOTIFY", "EMAIL 1 ADDRESS", "EMAIL 1 SUBJECT",
			"EMAIL 2 NOTIFY", "EMAIL 2 ADDRESS", "EMAIL 2 SUBJECT", "EMAIL 3 NOTIFY", "EMAIL 3 ADDRESS",
			"EMAIL 3 SUBJECT", "EMAIL 4 NOTIFY", "EMAIL 4 ADDRESS", "EMAIL 4 SUBJECT", "EMAIL 5 NOTIFY",
			"EMAIL 5 ADDRESS", "EMAIL 5 SUBJECT", "FAX 1 NOTIFY", "FAX 1 CODE", "FAX 1 NUMBER",
			"FAX 1 SUBJECT", "FAX 2 NOTIFY", "FAX 2 CODE", "FAX 2 NUMBER", "FAX 2 SUBJECT",
			"SMS 1 NOTIFY", "SMS 1 CODE", "SMS 1 NUMBER", "SMS 2 NOTIFY", "SMS 2 CODE", "SMS 2 NUMBER",
		},
	}

	for _, row := range headerRows {
		if err := writer.Write(row); err != nil {
			return fmt.Errorf("failed to write CSV header: %w", err)
		}
	}

	return nil
}

func writeRecipients(writer *csv.Writer, recipients []Recipient) error {
	for _, r := range recipients {
		row := make([]string, 36) // Initialize with 36 empty strings
		row[0] = r.Name
		row[1] = r.Account
		row[2] = r.AccountType
		row[3] = r.BranchCode
		row[4] = r.Amount
		row[5] = r.OwnReference
		row[6] = r.TheirReference

		if err := writer.Write(row); err != nil {
			return fmt.Errorf("failed to write CSV row: %w", err)
		}
	}

	return nil
}
