package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v4/pgxpool"
)

const (
	url        = "https://fnb.co.za"
	username   = "exolutionza"
	password   = "***REMOVED***"
	dbURL      = "user=postgres.wmpyolgckopmwhhlaiye password=***REMOVED*** host=aws-0-eu-central-1.pooler.supabase.com port=6543 dbname=postgres"
	cookieFile = "./cookies.json"
)

var dbPool *pgxpool.Pool

func main() {
	log.Println("DEBUG: Starting main function")
	var err error
	dbPool, err = pgxpool.Connect(context.Background(), dbURL)
	if err != nil {
		log.Fatalf("Unable to connect to database: %v", err)
	}
	defer dbPool.Close()
	log.Println("DEBUG: Connected to database")

	// Initialize rod browser with headless mode off
	u := launcher.New().Headless(true).MustLaunch()
	browser := rod.New().ControlURL(u).MustConnect()
	defer browser.MustClose()

	for {
		log.Println("DEBUG: Starting new iteration in main loop")

		log.Println("DEBUG: Loading cookies")
		cookies, err := loadCookies()
		if err != nil {
			log.Println("No saved cookies found or error loading cookies:", err)
		}

		page := browser.MustPage(url)
		page.WaitLoad()
		if err := login(page, cookies); err != nil {
			log.Printf("Login failed: %v", err)
			log.Println("DEBUG: Waiting 5 seconds before retrying login")
			time.Sleep(5 * time.Second)
			continue
		}

		log.Println("DEBUG: Login successful, starting main loop")
		if err := runLoop(page); err != nil {
			log.Printf("Error during loop: %v", err)
			if strings.Contains(err.Error(), "logged out") {
				waitTime := 5 * time.Second
				if strings.Contains(err.Error(), "concurrent") {
					waitTime = 15 * time.Second
				}
				log.Printf("Detected logout. Waiting %v before restarting...", waitTime)
				time.Sleep(waitTime)
				continue
			}
		}

		log.Println("DEBUG: Finished iteration, waiting 5 seconds before next iteration")
		time.Sleep(5 * time.Second)
	}
}

func runLoop(page *rod.Page) error {
	for {
		log.Println("DEBUG: Starting new iteration in runLoop")

		log.Println("DEBUG: Checking logout status")
		loggedOut, err := checkLogout(page)
		if err != nil {
			return fmt.Errorf("error checking logout status: %w", err)
		}

		if loggedOut {
			log.Println("DEBUG: Logged out detected")
			return fmt.Errorf("logged out")
		}

		log.Println("DEBUG: Navigating to transaction history")

		// Click on "Accounts" link
		accountElement, err := page.ElementR("span.shortCutLink", "Accounts")
		if err != nil {
			return fmt.Errorf("error finding Accounts link: %w", err)
		}
		if err := accountElement.Click(proto.InputMouseButtonLeft, 1); err != nil {
			return fmt.Errorf("error clicking on Accounts link: %w", err)
		}

		// Click on "Gold Business Account" link
		businessAccountElement, err := page.ElementR("#nickname_0 a", "Gold Business Account")
		if err != nil {
			return fmt.Errorf("error finding Gold Business Account link: %w", err)
		}
		if err := businessAccountElement.Click(proto.InputMouseButtonLeft, 1); err != nil {
			return fmt.Errorf("error clicking on Gold Business Account link: %w", err)
		}

		// Click on "Transaction History" link
		transactionHistoryElement, err := page.ElementR("div.subTabButton", "Transaction History")
		if err != nil {
			return fmt.Errorf("error finding Transaction History link: %w", err)
		}
		if err := transactionHistoryElement.Click(proto.InputMouseButtonLeft, 1); err != nil {
			return fmt.Errorf("error clicking on Transaction History link: %w", err)
		}

		log.Println("DEBUG: Clicking transaction history to update table")
		if err := page.MustElement(`#transactionHistoryTables_tableContent`).WaitVisible(); err != nil {
			return fmt.Errorf("error updating transaction history: %w", err)
		}

		log.Println("DEBUG: Extracting transaction data")
		tableHTML, err := page.MustElement(`#transactionHistoryTables_tableContent`).HTML()
		if err != nil {
			return fmt.Errorf("error extracting transaction history: %w", err)
		}

		log.Println("DEBUG: Parsing table HTML")
		transactions := parseTableHTML(tableHTML)

		log.Println("DEBUG: Saving to Supabase")
		if err := saveToSupabase(dbPool, transactions); err != nil {
			fmt.Errorf("error saving to database: %w", err)
		}

		log.Println("Transaction history updated and saved successfully")
		log.Println("DEBUG: Waiting 5 seconds before next iteration")
		time.Sleep(1 * time.Second)
	}
}

func checkLogout(page *rod.Page) (bool, error) {
	text, err := page.MustElement("body").Text()
	if err != nil {
		return false, fmt.Errorf("error getting page text: %w", err)
	}
	if strings.Contains(text, "You have successfully logged out of banking") {
		return true, nil
	}
	return false, nil
}

func login(page *rod.Page, cookies []*proto.NetworkCookieParam) error {
	log.Println("DEBUG: Starting login function")
	if len(cookies) > 0 {
		log.Println("DEBUG: Setting cookies")
		page.MustSetCookies(cookies...)
	}

	page.MustNavigate(url)
	if err := handleCookieBanner(page); err != nil {
		return err
	}

	log.Println("DEBUG: Checking if logged in")
	loggedIn := page.MustHas(`span.shortCutLink`)
	if !loggedIn {
		log.Println("DEBUG: Not logged in, performing login")
		page.MustElement(`#user`).MustWaitVisible()
		page.MustElement(`#user`).MustInput(username)
		page.MustElement(`#pass`).MustInput(password)
		page.MustElement(`#OBSubmit`).MustClick()
		page.MustElement(`span.shortCutLink`).MustWaitVisible()
	}

	log.Println("DEBUG: Saving cookies")
	newCookies := page.MustCookies()
	return saveCookies(newCookies)
}

func handleCookieBanner(page *rod.Page) error {
	cookieBannerVisible := page.MustHas(`.cookieBanner`)
	if cookieBannerVisible {
		page.MustElement(`button.js-accept-cookies.s-btn__primary`).MustClick()
		page.MustElement(`.cookieBanner`).MustWaitVisible()
		log.Println("Cookie banner accepted")
	}
	return nil
}

func loadCookies() ([]*proto.NetworkCookieParam, error) {
	// data, err := os.ReadFile(cookieFile)
	// if err != nil {
	// 	return nil, err
	// }

	var cookies []*proto.NetworkCookieParam
	// err = json.Unmarshal(data, &cookies)
	return cookies, nil
}

func saveCookies(cookies []*proto.NetworkCookie) error {
	data, err := json.Marshal(cookies)
	if err != nil {
		return err
	}
	return os.WriteFile(cookieFile, data, 0644)
}

func parseTableHTML(tableHTML string) []map[string]string {
	reader := strings.NewReader(tableHTML)
	doc, err := goquery.NewDocumentFromReader(reader)
	if err != nil {
		log.Fatal(err)
	}

	var transactions []map[string]string

	doc.Find(".tableRow.tableDataRow").Each(func(i int, s *goquery.Selection) {
		transaction := make(map[string]string)
		s.Find(".tableCellItem").Each(func(j int, cell *goquery.Selection) {
			switch j {
			case 0:
				transaction["date"] = strings.TrimSpace(cell.Text())
			case 1:
				transaction["description"] = strings.TrimSpace(cell.Text())
			case 2:
				transaction["reference"] = strings.TrimSpace(cell.Text())
			case 3:
				transaction["service_fee"] = strings.TrimSpace(cell.Text())
			case 4:
				transaction["amount"] = strings.TrimSpace(cell.Text())
			case 5:
				transaction["balance"] = strings.TrimSpace(cell.Text())
			}
		})
		transactions = append(transactions, transaction)
	})

	return transactions
}

func saveToSupabase(pool *pgxpool.Pool, transactions []map[string]string) error {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("error beginning transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	bankAccountId := uuid.MustParse("***REMOVED***")

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
			bankAccountId,
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
				bankAccountId,
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
			log.Printf("Inserted new transaction: date=%s, description=%s, amount=%.2f",
				bankDate.Format("2006-01-02"), t["description"], amount)
		} else {
			log.Printf("Skipped duplicate transaction: date=%s, description=%s, amount=%.2f",
				bankDate.Format("2006-01-02"), t["description"], amount)
		}
	}

	return tx.Commit(ctx)
}

// Helper function to parse amount strings
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
