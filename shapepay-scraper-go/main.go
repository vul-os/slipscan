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
	url                = "https://secured.nedbank.co.za/"
	username           = "imran.paruk"
	password           = "***REMOVED***"
	dbURL              = "user=postgres.wmpyolgckopmwhhlaiye password=***REMOVED*** host=aws-0-eu-central-1.pooler.supabase.com port=6543 dbname=postgres"
	cookieFile         = "./cookies.json"
	localStorageFile   = "./localStorage.json"
	sessionStorageFile = "./sessionStorage.json"
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
	u := launcher.New().Headless(false).MustLaunch()
	browser := rod.New().ControlURL(u).MustConnect()
	defer browser.MustClose()

	for {
		log.Println("DEBUG: Starting new iteration in main loop")
		page := browser.MustPage(url)

		log.Println("DEBUG: Loading cookies")
		cookies, err := loadCookies()
		if err != nil {
			log.Println("No saved cookies found or error loading cookies:", err)
		}

		log.Println("DEBUG: Loading storage")
		if err := loadStorage(page); err != nil {
			log.Printf("Error loading storage: %v", err)
		}

		if err := login(page, cookies); err != nil {
			log.Printf("Login failed: %v", err)
			log.Println("DEBUG: Waiting 5 seconds before retrying login")
			continue
		}

		log.Println("DEBUG: Clicking on account row")
		err = clickAccountRow(page)
		if err != nil {
			fmt.Errorf("error clicking account row: %w", err)
			continue
		}

		log.Println("DEBUG: Login successful, starting main loop")
		if err := runLoop(page); err != nil {
			log.Printf("Error during loop: %v", err)
			if strings.Contains(err.Error(), "logged out") {
				waitTime := 1 * time.Second
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

		// Wait for transaction table to load
		log.Println("DEBUG: Waiting for transaction table to load")
		err := page.MustElement("div.transactions-list-container").WaitVisible()
		if err != nil {
			return fmt.Errorf("error waiting for transaction table: %w", err)
		}

		log.Println("DEBUG: Clicking on Failed transactions tab")
		failedTransactionsSelector := `label.tab-label[data-content="Failed"]`
		err = page.MustElement(failedTransactionsSelector).Click(proto.InputMouseButtonLeft, 1)
		if err != nil {
			return fmt.Errorf("error clicking Failed transactions tab: %w", err)
		}

		// Wait for failed transactions to load
		time.Sleep(2 * time.Second)

		log.Println("DEBUG: Clicking on All transactions tab")
		allTransactionsSelector := `label.tab-label[data-content="All transactions"]`
		err = page.MustElement(allTransactionsSelector).Click(proto.InputMouseButtonLeft, 1)
		if err != nil {
			return fmt.Errorf("error clicking All transactions tab: %w", err)
		}

		// Wait for all transactions to load
		time.Sleep(2 * time.Second)

		log.Println("DEBUG: Extracting transaction data")
		tableHTML, err := page.MustElement("div.transactions-list-container").HTML()
		if err != nil {
			return fmt.Errorf("error extracting transaction history: %w", err)
		}

		log.Println("DEBUG: Parsing table HTML")
		transactions := parseTableHTML(tableHTML)

		log.Println("DEBUG: Saving to Supabase")
		if err := saveToSupabase(dbPool, transactions); err != nil {
			return fmt.Errorf("error saving to database: %w", err)
		}

		log.Println("Transaction history updated and saved successfully")

		log.Println("DEBUG: Saving storage")
		if err := saveStorage(page); err != nil {
			log.Printf("Error saving storage: %v", err)
		}

		log.Println("DEBUG: Waiting 5 seconds before next iteration")
		time.Sleep(5 * time.Second)
	}
}

func clickAccountRow(page *rod.Page) error {
	log.Println("DEBUG: Finding account row")
	accountRow, err := page.Element("div.account-row")
	if err != nil {
		return fmt.Errorf("error finding account row: %w", err)
	}

	log.Println("DEBUG: Clicking account row")
	err = accountRow.Click(proto.InputMouseButtonLeft, 1)
	if err != nil {
		return fmt.Errorf("error clicking account row: %w", err)
	}

	return nil
}

func checkLogout(page *rod.Page) (bool, error) {
	// Check for the presence of the login form
	loginForm, _, err := page.Has("form.gd-form")
	if err != nil {
		return false, fmt.Errorf("error checking for login form: %w", err)
	}

	// Check for the presence of the "Log in with your Nedbank ID" text
	loginText, _, err := page.Has("h4.login-title")
	if err != nil {
		return false, fmt.Errorf("error checking for login title: %w", err)
	}

	// Check for the presence of the username and password input fields
	usernameInput, _, err := page.Has("#username")
	if err != nil {
		return false, fmt.Errorf("error checking for username input: %w", err)
	}

	passwordInput, _, err := page.Has("#password")
	if err != nil {
		return false, fmt.Errorf("error checking for password input: %w", err)
	}

	// If all these elements are present, we're on the login page
	return loginForm && loginText && usernameInput && passwordInput, nil
}

func login(page *rod.Page, cookies []*proto.NetworkCookieParam) error {
	log.Println("DEBUG: Starting login function")

	if len(cookies) > 0 {
		log.Println("DEBUG: Setting cookies")
		page.MustSetCookies(cookies...)
	}

	log.Printf("DEBUG: Navigating to URL: %s", url)
	err := page.Navigate(url)
	if err != nil {
		return fmt.Errorf("error navigating to URL: %w", err)
	}

	log.Println("DEBUG: Waiting for navigation to complete")
	err = page.WaitLoad()
	if err != nil {
		return fmt.Errorf("error waiting for page to load: %w", err)
	}

	log.Println("DEBUG: Checking if logged in")
	loggedIn, _, err := page.Has("div.account-name")
	if err != nil {
		return fmt.Errorf("error checking if logged in: %w", err)
	}

	if !loggedIn {
		log.Println("DEBUG: Not logged in, performing login")

		log.Println("DEBUG: Waiting for username field")
		err = page.MustElement("#username").WaitVisible()
		if err != nil {
			return fmt.Errorf("error waiting for username field: %w", err)
		}

		log.Println("DEBUG: Inputting username")
		err = page.MustElement("#username").Input(username)
		if err != nil {
			return fmt.Errorf("error inputting username: %w", err)
		}

		log.Println("DEBUG: Inputting password")
		err = page.MustElement("#password").Input(password)
		if err != nil {
			return fmt.Errorf("error inputting password: %w", err)
		}

		log.Println("DEBUG: Clicking login button")
		err = page.MustElement("#log_in").Click(proto.InputMouseButtonLeft, 1)
		if err != nil {
			return fmt.Errorf("error clicking login button: %w", err)
		}

		log.Println("DEBUG: Waiting for navigation to complete")
		err = page.WaitLoad()
		if err != nil {
			return fmt.Errorf("error waiting for page to load: %w", err)
		}

		log.Println("DEBUG: Saving cookies and storage")
		newCookies := page.MustCookies()
		if err := saveCookies(newCookies); err != nil {
			log.Printf("Error saving cookies: %v", err)
		}
		if err := saveStorage(page); err != nil {
			log.Printf("Error saving storage: %v", err)
		}

		log.Println("DEBUG: Waiting for account name to be visible")
		err = page.MustElement("div.account-name").WaitLoad()
		if err != nil {
			return fmt.Errorf("error waiting for account name: %w", err)
		}
	}

	return nil
}

func loadCookies() ([]*proto.NetworkCookieParam, error) {
	data, err := os.ReadFile(cookieFile)
	if err != nil {
		return nil, err
	}

	var cookies []*proto.NetworkCookieParam
	err = json.Unmarshal(data, &cookies)
	return cookies, err
}

func saveCookies(cookies []*proto.NetworkCookie) error {
	data, err := json.Marshal(cookies)
	if err != nil {
		return err
	}
	return os.WriteFile(cookieFile, data, 0644)
}

func loadStorage(page *rod.Page) error {
	// Load localStorage
	localStorageData, err := os.ReadFile(localStorageFile)
	if err == nil {
		var localStorage map[string]string
		if err := json.Unmarshal(localStorageData, &localStorage); err == nil {
			for key, value := range localStorage {
				page.MustEval(`(key, value) => localStorage.setItem(key, value)`, key, value)
			}
		}
	}

	// Load sessionStorage
	sessionStorageData, err := os.ReadFile(sessionStorageFile)
	if err == nil {
		var sessionStorage map[string]string
		if err := json.Unmarshal(sessionStorageData, &sessionStorage); err == nil {
			for key, value := range sessionStorage {
				page.MustEval(`(key, value) => sessionStorage.setItem(key, value)`, key, value)
			}
		}
	}

	return nil
}

func saveStorage(page *rod.Page) error {
	// Save localStorage
	localStorage, err := page.Eval(`() => JSON.stringify(localStorage)`)
	if err == nil {
		var localStorageMap map[string]string
		if err := json.Unmarshal([]byte(localStorage.Value.String()), &localStorageMap); err == nil {
			localStorageData, _ := json.Marshal(localStorageMap)
			if err := os.WriteFile(localStorageFile, localStorageData, 0644); err != nil {
				log.Printf("Error writing localStorage: %v", err)
			}
		}
	}

	// Save sessionStorage
	sessionStorage, err := page.Eval(`() => JSON.stringify(sessionStorage)`)
	if err == nil {
		var sessionStorageMap map[string]string
		if err := json.Unmarshal([]byte(sessionStorage.Value.String()), &sessionStorageMap); err == nil {
			sessionStorageData, _ := json.Marshal(sessionStorageMap)
			if err := os.WriteFile(sessionStorageFile, sessionStorageData, 0644); err != nil {
				log.Printf("Error writing sessionStorage: %v", err)
			}
		}
	}

	return nil
}

func parseTableHTML(tableHTML string) []map[string]string {
	reader := strings.NewReader(tableHTML)
	doc, err := goquery.NewDocumentFromReader(reader)
	if err != nil {
		log.Fatal(err)
	}

	var transactions []map[string]string

	doc.Find("tr.selectable").Each(func(i int, s *goquery.Selection) {
		transaction := make(map[string]string)
		transaction["date"] = s.Find("td.date").Text()
		transaction["description"] = s.Find("div.title").Text()
		transaction["amount"] = s.Find("td.amount").Text()
		transaction["balance"] = s.Find("td.balance").Text()
		transactions = append(transactions, transaction)
	})

	return transactions
}

func saveToSupabase(pool *pgxpool.Pool, transactions []map[string]string) error {
	myUuid := uuid.MustParse("***REMOVED***")
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
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

		// Parse amount and balance
		log.Printf("Raw amount: %s", t["amount"])
		amount, err := parseAmount(t["amount"])
		if err != nil {
			return fmt.Errorf("error parsing amount: %w", err)
		}

		log.Printf("Raw balance: %s", t["balance"])
		balance, err := parseAmount(t["balance"])
		if err != nil {
			return fmt.Errorf("error parsing balance: %w", err)
		}

		// Check if transaction already exists
		var count int
		err = tx.QueryRow(ctx, fmt.Sprintf(`
            SELECT COUNT(*) 
            FROM bank_transactions
            WHERE bank_date = '%s' AND description = $1 AND amount = %f AND balance = %f
        `, bankDate.Format("2006-01-02"), amount, balance),
			t["description"],
		).Scan(&count)
		if err != nil {
			fmt.Errorf("error checking existing transaction: %w", err)
		}

		// If transaction does not exist, insert it
		if count == 0 {
			_, err := tx.Exec(ctx, fmt.Sprintf(`
                INSERT INTO bank_transactions (
                    bank_account_id, bank_date, description, reference, 
                    service_fee, amount, balance, detected_date
                ) VALUES ('%s', '%s', '%s', '%s', %f, %f, %f, '%s')`,
				myUuid,
				bankDate.Format("2006-01-02"),
				t["description"],
				t["reference"],
				0.00, // Assuming service_fee is not provided in the transaction data
				amount,
				balance,
				time.Now().Format("2006-01-02 15:04:05"),
			))
			if err != nil {
				return fmt.Errorf("error inserting transaction: %w", err)
			}
		}
	}

	return tx.Commit(ctx)
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
	s = strings.ReplaceAll(s, "R", "")
	s = strings.ReplaceAll(s, ",", "")
	s = strings.TrimSpace(s) // Remove any remaining whitespace

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
