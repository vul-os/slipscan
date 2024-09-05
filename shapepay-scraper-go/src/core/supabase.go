package core

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/exolutionza/shapepay-scraper-go/src/db"
	"github.com/google/uuid"
)

type Account struct {
	ID            string
	BankAccountID uuid.UUID
	Username      string
	Password      string
}

func getAvailableAccounts(limit int) ([]Account, error) {
	ctx := context.Background()
	query := `
		UPDATE bank_account_logins
		SET is_running = TRUE
		WHERE id IN (
			SELECT id
			FROM bank_account_logins
			LIMIT $1
		)
		RETURNING id, bank_account_id, encrypted_username, encrypted_password
	`

	rows, err := db.Pool.Query(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("error querying available accounts: %w", err)
	}
	defer rows.Close()

	var accounts []Account
	for rows.Next() {
		var account Account
		var encryptedUsername, encryptedPassword []byte
		if err := rows.Scan(&account.ID, &account.BankAccountID, &encryptedUsername, &encryptedPassword); err != nil {
			return nil, fmt.Errorf("error scanning account row: %w", err)
		}
		account.Username, account.Password, err = getUsernamePassword(encryptedUsername, encryptedPassword)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}

	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating over rows: %w", err)
	}
	return accounts, nil
}

func updateAccountActivity(accountID string) error {
	ctx := context.Background()
	query := `
        UPDATE bank_account_logins
        SET last_activity_time = NOW()
        WHERE id = $1
    `
	_, err := db.Pool.Exec(ctx, query, accountID)
	return err
}

func resetAccount(accountID string) error {
	ctx := context.Background()
	query := `
		UPDATE bank_account_logins
		SET is_running = FALSE, last_activity_time = NULL
		WHERE id = $1
	`
	_, err := db.Pool.Exec(ctx, query, accountID)
	if err != nil {
		return fmt.Errorf("error resetting account %s: %w", accountID, err)
	}
	log.Printf("Account %s has been reset", accountID)
	return nil
}

func insertAccount(username, password string, bankAccountID uuid.UUID) error {
	encryptedUsername, err := Encrypt(username)
	if err != nil {
		return err
	}
	encryptedPassword, err := Encrypt(password)
	if err != nil {
		return err
	}

	ctx := context.Background()
	_, err = db.Pool.Exec(ctx, `
		INSERT INTO bank_account_logins (bank_account_id, encrypted_username, encrypted_password)
		VALUES ($1, $2, $3)
	`, bankAccountID, encryptedUsername, encryptedPassword)
	return err
}

func saveToSupabase(transactions []map[string]string, bankAccountID uuid.UUID) error {
	ctx := context.Background()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("error beginning transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, t := range transactions {
		// Log raw transaction data for debugging
		log.Printf("Raw transaction data: %+v", t)

		// Parse date
		cleanDateString := strings.TrimSpace(t["date"])
		bankDate, err := time.Parse("02 Jan 2006", cleanDateString)
		if err != nil {
			return fmt.Errorf("error parsing date '%s': %w", cleanDateString, err)
		}

		// Parse amount, balance, and service fee
		amount, err := parseAmount(t["amount"])
		if err != nil {
			return fmt.Errorf("error parsing amount: %w", err)
		}

		balance, err := parseAmount(t["balance"])
		if err != nil {
			return fmt.Errorf("error parsing balance: %w", err)
		}

		serviceFee, err := parseAmount(t["service_fee"])
		if err != nil {
			return fmt.Errorf("error parsing service fee: %w", err)
		}

		// Check if transaction already exists
		var count int
		err = tx.QueryRow(ctx, `
			SELECT COUNT(*) 
			FROM bank_transactions
			WHERE bank_account_id = $1 AND bank_date = $2 AND description = $3 AND reference = $4 AND 
				  service_fee = $5 AND amount = $6 AND balance = $7
		`,
			bankAccountID,
			bankDate,
			t["description"],
			t["reference"],
			serviceFee,
			amount,
			balance,
		).Scan(&count)
		if err != nil {
			return fmt.Errorf("error checking existing transaction: %w", err)
		}

		// If transaction does not exist, insert it
		if count == 0 {
			_, err := tx.Exec(ctx,
				`INSERT INTO bank_transactions (
					id, bank_account_id, bank_date, description, reference, 
					service_fee, amount, balance, detected_date
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				uuid.New(),
				bankAccountID,
				bankDate,
				t["description"],
				t["reference"],
				serviceFee,
				amount,
				balance,
				time.Now(),
			)
			if err != nil {
				return fmt.Errorf("error inserting transaction: %w", err)
			}
			log.Printf("Inserted new transaction: date=%s, description=%s, amount=%.2f, bank_account_id=%s",
				bankDate.Format("2006-01-02"), t["description"], amount, bankAccountID)
		} else {
			log.Printf("Skipped duplicate transaction: date=%s, description=%s, amount=%.2f, bank_account_id=%s",
				bankDate.Format("2006-01-02"), t["description"], amount, bankAccountID)
		}
	}

	return tx.Commit(ctx)
}

func getLastActivityTime(accountID string) (time.Time, error) {
	ctx := context.Background()
	var lastActivityTime sql.NullTime

	err := db.Pool.QueryRow(ctx, "SELECT last_activity_time FROM bank_account_logins WHERE id = $1", accountID).Scan(&lastActivityTime)
	if err != nil {
		return time.Time{}, err
	}

	if lastActivityTime.Valid {
		return lastActivityTime.Time, nil
	} else {
		// Return a time very far in the past if last_activity_time is NULL
		return time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC), nil
	}
}

func getAllRunningAccounts() ([]Account, error) {
	ctx := context.Background()
	rows, err := db.Pool.Query(ctx, "SELECT id, bank_account_id, encrypted_username, encrypted_password FROM bank_account_logins WHERE is_running = TRUE")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []Account
	for rows.Next() {
		var account Account
		var encryptedUsername, encryptedPassword []byte
		if err := rows.Scan(&account.ID, &account.BankAccountID, &encryptedUsername, &encryptedPassword); err != nil {
			return nil, err
		}
		account.Username, account.Password, err = getUsernamePassword(encryptedUsername, encryptedPassword)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}

	return accounts, nil
}

func parseAmount(s string) (float64, error) {
	// Remove any whitespace
	s = strings.TrimSpace(s)

	// Check if the amount is negative
	isNegative := strings.HasPrefix(s, "-")
	if isNegative {
		s = strings.TrimPrefix(s, "-")
	}

	// Remove 'R' prefix and any thousands separators
	s = strings.TrimPrefix(s, "R")
	s = strings.ReplaceAll(s, ",", "")

	// Parse the float
	amount, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("error parsing amount '%s': %w", s, err)
	}

	// Make the amount negative if necessary
	if isNegative {
		amount = -amount
	}

	return amount, nil
}
