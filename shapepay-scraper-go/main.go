package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v4/pgxpool"
)

const (
	url        = "https://fnb.co.za"
	username   = "exolutionza"
	password   = "***REMOVED***"
	dbURL      = "user=postgres.zkimqgkcwxaeyibtjwnt password=***REMOVED*** host=aws-0-eu-central-1.pooler.supabase.com port=6543 dbname=postgres"
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

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", false),
		chromedp.Flag("disable-gpu", false),
		chromedp.Flag("enable-automation", false),
		chromedp.Flag("disable-extensions", false),
	)

	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()
	log.Println("DEBUG: Created ChromeDP execution allocator")

	for {
		log.Println("DEBUG: Starting new iteration in main loop")
		ctx, cancel := chromedp.NewContext(allocCtx)

		log.Println("DEBUG: Loading cookies")
		cookies, err := loadCookies()
		if err != nil {
			log.Println("No saved cookies found or error loading cookies:", err)
		}

		log.Println("DEBUG: Attempting login")
		if err := login(ctx, cookies); err != nil {
			log.Printf("Login failed: %v", err)
			cancel()
			log.Println("DEBUG: Waiting 5 seconds before retrying login")
			time.Sleep(5 * time.Second)
			continue
		}

		log.Println("DEBUG: Login successful, starting main loop")
		if err := runLoop(ctx); err != nil {
			log.Printf("Error during loop: %v", err)
			if strings.Contains(err.Error(), "logged out") {
				waitTime := 5 * time.Second
				if strings.Contains(err.Error(), "concurrent") {
					waitTime = 15 * time.Second
				}
				log.Printf("Detected logout. Waiting %v before restarting...", waitTime)
				cancel()
				time.Sleep(waitTime)
				continue
			}
		}

		cancel()
		log.Println("DEBUG: Finished iteration, waiting 5 seconds before next iteration")
		time.Sleep(5 * time.Second)
	}
}

func runLoop(ctx context.Context) error {
	for {
		log.Println("DEBUG: Starting new iteration in runLoop")

		log.Println("DEBUG: Checking logout status")
		loggedOut, reason, err := checkLogout(ctx)
		if err != nil {
			return fmt.Errorf("error checking logout status: %w", err)
		}

		if loggedOut {
			log.Printf("DEBUG: Logged out detected. Reason: %s", reason)
			return fmt.Errorf("logged out: %s", reason)
		}

		log.Println("DEBUG: Navigating to transaction history")
		err = chromedp.Run(ctx,
			chromedp.Navigate(url),
			chromedp.WaitVisible(`//span[contains(@class, "shortCutLink") and contains(text(), "Accounts")]`, chromedp.BySearch),
			chromedp.Click(`//span[contains(@class, "shortCutLink") and contains(text(), "Accounts")]`, chromedp.BySearch),
			chromedp.WaitVisible(`//div[@id="nickname_0"]//a[contains(text(), "Gold Business Account")]`, chromedp.BySearch),
			chromedp.Click(`//div[@id="nickname_0"]//a[contains(text(), "Gold Business Account")]`, chromedp.BySearch),
			chromedp.WaitVisible(`//div[contains(@class, "subTabButton") and .//div[contains(text(), "Transaction History")]]`, chromedp.BySearch),
		)
		if err != nil {
			return fmt.Errorf("error navigating to transaction history: %w", err)
		}

		log.Println("DEBUG: Clicking transaction history to update table")
		err = chromedp.Run(ctx,
			chromedp.Click(`//div[contains(@class, "subTabButton") and .//div[contains(text(), "Transaction History")]]`, chromedp.BySearch),
			chromedp.WaitVisible(`#transactionHistoryTables_tableContent`, chromedp.ByID),
		)
		if err != nil {
			return fmt.Errorf("error updating transaction history: %w", err)
		}

		log.Println("DEBUG: Extracting transaction data")
		var tableHTML string
		err = chromedp.Run(ctx,
			chromedp.OuterHTML(`#transactionHistoryTables_tableContent`, &tableHTML),
		)
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
		log.Println("DEBUG: Waiting 5 seconds before next iteration")
		time.Sleep(5 * time.Second)
	}
}

func checkLogout(ctx context.Context) (bool, string, error) {
	var result struct {
		LoggedOut bool
		Reason    string
	}
	err := chromedp.Run(ctx,
		chromedp.Evaluate(`
			(function() {
				if (document.body.innerText.includes("You have successfully logged out of banking")) {
					return {LoggedOut: true, Reason: "normal"};
				} else if (document.body.innerText.includes("This session is being terminated because you are logged in concurrent sessions")) {
					return {LoggedOut: true, Reason: "concurrent"};
				} else if (!document.querySelector('span.shortCutLink')) {
					return {LoggedOut: true, Reason: "no_menu"};
				}
				return {LoggedOut: false, Reason: ""};
			})()
		`, &result),
	)
	return result.LoggedOut, result.Reason, err
}

func login(ctx context.Context, cookies []*network.CookieParam) error {
	log.Println("DEBUG: Starting login function")
	return chromedp.Run(ctx,
		chromedp.ActionFunc(func(ctx context.Context) error {
			// Set cookies if they exist
			if len(cookies) > 0 {
				log.Println("DEBUG: Setting cookies")
				return network.SetCookies(cookies).Do(ctx)
			}
			log.Println("DEBUG: No cookies to set")
			return nil
		}),
		chromedp.Navigate(url),
		chromedp.ActionFunc(func(ctx context.Context) error {
			log.Println("DEBUG: Handling cookie banner")
			return handleCookieBanner(ctx)
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			log.Println("DEBUG: Checking if logged in")
			var loggedIn bool
			err := chromedp.Evaluate(`document.querySelector('span.shortCutLink') !== null`, &loggedIn).Do(ctx)
			if err != nil {
				log.Println("DEBUG: Error checking login status:", err)
				return err
			}
			log.Println("DEBUG: Logged In:", loggedIn)

			if !loggedIn {
				log.Println("DEBUG: Not logged in, performing login")
				return chromedp.Run(ctx,
					chromedp.ActionFunc(func(ctx context.Context) error {
						log.Println("DEBUG: Waiting for #user to be visible")
						err := chromedp.WaitVisible(`#user`, chromedp.ByID).Do(ctx)
						if err != nil {
							log.Println("DEBUG: Error waiting for #user:", err)
							return err
						}
						return nil
					}),
					chromedp.ActionFunc(func(ctx context.Context) error {
						log.Println("DEBUG: Entering username")
						err := chromedp.SendKeys(`#user`, username, chromedp.ByID).Do(ctx)
						if err != nil {
							log.Println("DEBUG: Error entering username:", err)
							return err
						}
						return nil
					}),
					chromedp.ActionFunc(func(ctx context.Context) error {
						log.Println("DEBUG: Entering password")
						err := chromedp.SendKeys(`#pass`, password, chromedp.ByID).Do(ctx)
						if err != nil {
							log.Println("DEBUG: Error entering password:", err)
							return err
						}
						return nil
					}),
					chromedp.ActionFunc(func(ctx context.Context) error {
						log.Println("DEBUG: Clicking submit button")
						err := chromedp.Click(`#OBSubmit`, chromedp.ByID).Do(ctx)
						if err != nil {
							log.Println("DEBUG: Error clicking submit button:", err)
							return err
						}
						return nil
					}),
					chromedp.ActionFunc(func(ctx context.Context) error {
						log.Println("DEBUG: Waiting for span.shortCutLink to be visible")
						err := chromedp.WaitVisible(`span.shortCutLink`, chromedp.ByQuery).Do(ctx)
						if err != nil {
							log.Println("DEBUG: Error waiting for span.shortCutLink:", err)
							return err
						}
						return nil
					}),
				)
			} else {
				log.Println("DEBUG: Already logged in, skipping login process")
			}
			return nil
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			log.Println("DEBUG: Saving cookies")
			newCookies, err := network.GetCookies().Do(ctx)
			if err != nil {
				log.Println("DEBUG: Error getting cookies:", err)
				return err
			}
			return saveCookies(newCookies)
		}),
	)
}

func handleCookieBanner(ctx context.Context) error {
	var cookieBannerVisible bool
	err := chromedp.Run(ctx,
		chromedp.Evaluate(`!!document.querySelector('.cookieBanner')`, &cookieBannerVisible),
	)
	if err != nil {
		return err
	}

	if cookieBannerVisible {
		err = chromedp.Run(ctx,
			chromedp.Click(`button.js-accept-cookies.s-btn__primary`, chromedp.ByQuery),
			chromedp.WaitNotPresent(`.cookieBanner`, chromedp.ByQuery),
		)
		if err != nil {
			return err
		}
		log.Println("Cookie banner accepted")
	}

	return nil
}

func loadCookies() ([]*network.CookieParam, error) {
	data, err := ioutil.ReadFile(cookieFile)
	if err != nil {
		return nil, err
	}

	var cookies []*network.CookieParam
	err = json.Unmarshal(data, &cookies)
	return cookies, err
}

func saveCookies(cookies []*network.Cookie) error {
	cookieParams := make([]*network.CookieParam, len(cookies))
	for i, cookie := range cookies {
		cookieParams[i] = &network.CookieParam{
			Name:     cookie.Name,
			Value:    cookie.Value,
			Domain:   cookie.Domain,
			Path:     cookie.Path,
			Secure:   cookie.Secure,
			HTTPOnly: cookie.HTTPOnly,
		}
	}

	data, err := json.Marshal(cookieParams)
	if err != nil {
		return err
	}
	return ioutil.WriteFile(cookieFile, data, 0644)
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
		if len(transaction) == 6 {
			transactions = append(transactions, transaction)
		}
	})

	return transactions
}

func saveToSupabase(dbPool *pgxpool.Pool, transactions []map[string]string) error {
	ctx := context.Background()
	tx, err := dbPool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, t := range transactions {
		_, err := tx.Exec(ctx,
			`INSERT INTO bank_transactions (id, date, description, reference, service_fee, amount, balance)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (id) DO NOTHING`,
			uuid.New(),
			t["date"],
			t["description"],
			t["reference"],
			t["service_fee"],
			t["amount"],
			t["balance"],
		)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
