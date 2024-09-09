package core

import (
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
)

const (
	url = "https://fnb.co.za"
)

func runAccount(as *AccountScraper, iterationIterval time.Duration) error {
	log.Printf("DEBUG: Starting new session for account %s (Bank Account ID: %s)", as.account.Username, as.account.BankAccountID)

	as.lastActivity = time.Now()
	var err error
	if as.browser == nil {
		as.browser, err = initializeBrowser()
		if err != nil {
			return fmt.Errorf("failed to initialize browser: %w", err)
		}
		as.page = as.browser.MustPage(url)
		as.lastActivity = time.Now()
		if err := login(as.page, as.account); err != nil {
			log.Printf("Login failed for account %s (Bank Account ID: %s): %v", as.account.Username, as.account.BankAccountID, err)
			as.browser.Close()
			as.browser = nil
			as.page = nil
			return err
		}
	}

	for {
		as.lastActivity = time.Now()
		if err := runLoop(as.page, as.account); err != nil {
			if strings.Contains(err.Error(), "logged out") {
				log.Printf("Logged out detected for account %s (Bank Account ID: %s). Attempting to log in again.", as.account.Username, as.account.BankAccountID)
				if loginErr := login(as.page, as.account); loginErr != nil {
					log.Printf("Re-login failed for account %s (Bank Account ID: %s): %v", as.account.Username, as.account.BankAccountID, loginErr)
					as.browser.Close()
					as.browser = nil
					as.page = nil
					return loginErr
				}
				continue
			}
			log.Printf("Error during loop for account %s (Bank Account ID: %s): %v", as.account.Username, as.account.BankAccountID, err)
			return err
		}
		as.lastActivity = time.Now()
		log.Printf("DEBUG: Waiting for %v before next iteration", iterationIterval)
		time.Sleep(iterationIterval)
	}
}

func initializeBrowser() (*rod.Browser, error) {
	u := launcher.New().
		Headless(true).
		Set("disable-gpu").
		Set("no-sandbox").
		MustLaunch()

	browser := rod.New().ControlURL(u).MustConnect()
	return browser, nil
}

func login(page *rod.Page, account Account) error {
	log.Printf("DEBUG: Starting login for account %s (Bank Account ID: %s)", account.Username, account.BankAccountID)

	if err := page.Navigate(url); err != nil {
		return fmt.Errorf("failed to navigate to login page: %w", err)
	}

	if err := handleCookieBanner(page); err != nil {
		return fmt.Errorf("failed to handle cookie banner: %w", err)
	}

	log.Println("DEBUG: Checking if logged in")
	var loggedIn bool
	err := rod.Try(func() {
		loggedIn = page.MustHas("span.shortCutLink")
	})
	if err != nil {
		return fmt.Errorf("failed to check login status: %w", err)
	}

	if !loggedIn {
		log.Println("DEBUG: Not logged in, performing login")

		if err := performLogin(page, account); err != nil {
			return fmt.Errorf("login failed: %w", err)
		}
	}

	log.Printf("DEBUG: Login successful for account %s (Bank Account ID: %s)", account.Username, account.BankAccountID)
	return nil
}

func performLogin(page *rod.Page, account Account) error {
	err := rod.Try(func() {
		page.MustElement("#user").MustWaitVisible().MustInput(account.Username)
		page.MustElement("#pass").MustInput(account.Password)
		page.MustElement("#OBSubmit").MustClick()
		page.MustElement("span.shortCutLink").MustWaitVisible()
	})
	if err != nil {
		return fmt.Errorf("login process failed: %w", err)
	}
	return nil
}

func runLoop(page *rod.Page, account Account) error {
	log.Printf("DEBUG: Starting new iteration in runLoop for account %s (Bank Account ID: %s)", account.Username, account.BankAccountID)

	if err := updateAccountActivity(account.ID); err != nil {
		return fmt.Errorf("error updating account activity: %w", err)
	}

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

	// Find the row containing "Gold Business Account"
	goldAccountRow, err := page.ElementR("div.tableRowInner", "Gold Business Account")
	if err != nil {
		return fmt.Errorf("error finding Gold Business Account row: %w", err)
	}

	// Within that row, find and click on the available balance link
	availableBalanceElement, err := goldAccountRow.Element("div[id^='availablebalance_'] a")
	if err != nil {
		return fmt.Errorf("error finding available balance link for Gold Business Account: %w", err)
	}

	if err := availableBalanceElement.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return fmt.Errorf("error clicking on available balance link for Gold Business Account: %w", err)
	}

	// // Click on "Gold Business Account" link
	// businessAccountElement, err := page.ElementR("#nickname_0 a", "Gold Business Account")
	// if err != nil {
	// 	return fmt.Errorf("error finding Gold Business Account link: %w", err)
	// }
	// if err := businessAccountElement.Click(proto.InputMouseButtonLeft, 1); err != nil {
	// 	return fmt.Errorf("error clicking on Gold Business Account link: %w", err)
	// }

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
	if err := saveToSupabase(transactions, account.BankAccountID); err != nil {
		return fmt.Errorf("error saving to database: %w", err)
	}

	log.Printf("Transaction history updated and saved successfully for account %s (Bank Account ID: %s)", account.Username, account.BankAccountID)
	return nil
}

func checkLogout(page *rod.Page) (bool, error) {
	if page == nil {
		return true, fmt.Errorf("page is nil")
	}
	text, err := page.MustElement("body").Text()
	if err != nil {
		return false, fmt.Errorf("error getting page text: %w", err)
	}
	if strings.Contains(text, "You have successfully logged out of banking") {
		return true, nil
	}
	return false, nil
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
