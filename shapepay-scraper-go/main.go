package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"io/ioutil"
	"log"
	"os"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
)

const (
	url        = "https://fnb.co.za"
	username   = "exolutionza"
	password   = "***REMOVED***"
	cookieFile = "cookies.json"
)

func main() {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", false),
		chromedp.Flag("disable-gpu", false),
		chromedp.Flag("enable-automation", false),
		chromedp.Flag("disable-extensions", false),
	)

	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()

	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	ctx, cancel = context.WithTimeout(ctx, 300*time.Second)
	defer cancel()

	// Load cookies
	cookies, err := loadCookies()
	if err != nil {
		log.Println("No saved cookies found or error loading cookies:", err)
	}

	var tableHTML string

	err = chromedp.Run(ctx,
		chromedp.ActionFunc(func(ctx context.Context) error {
			// Set cookies if they exist
			if len(cookies) > 0 {
				return network.SetCookies(cookies).Do(ctx)
			}
			return nil
		}),
		chromedp.Navigate(url),
		chromedp.ActionFunc(func(ctx context.Context) error {
			return handleCookieBanner(ctx)
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			// Check if we're already logged in
			var loggedIn bool
			err := chromedp.Evaluate(`document.evaluate('//span[contains(@class, "shortCutLink") and contains(text(), "Accounts")]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue !== null`, &loggedIn).Do(ctx)
			if err != nil {
				return err
			}
			if !loggedIn {
				// If not logged in, perform login
				return chromedp.Run(ctx,
					chromedp.WaitVisible(`#user`, chromedp.ByID),
					chromedp.SendKeys(`#user`, username, chromedp.ByID),
					chromedp.SendKeys(`#pass`, password, chromedp.ByID),
					chromedp.Click(`#OBSubmit`, chromedp.ByID),
					chromedp.WaitVisible(`//span[contains(@class, "shortCutLink") and contains(text(), "Accounts")]`, chromedp.BySearch),
				)
			}
			return nil
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			// Save cookies after successful login or navigation
			newCookies, err := network.GetCookies().Do(ctx)
			if err != nil {
				return err
			}
			return saveCookies(newCookies)
		}),
		chromedp.Click(`//span[contains(@class, "shortCutLink") and contains(text(), "Accounts")]`, chromedp.BySearch),
		chromedp.WaitVisible(`//div[@id="nickname_0"]//a[contains(text(), "Gold Business Account")]`, chromedp.BySearch),
		chromedp.Click(`//div[@id="nickname_0"]//a[contains(text(), "Gold Business Account")]`, chromedp.BySearch),
		chromedp.WaitVisible(`//div[contains(@class, "subTabButton") and .//div[contains(text(), "Transaction History")]]`, chromedp.BySearch),
		chromedp.Click(`//div[contains(@class, "subTabButton") and .//div[contains(text(), "Transaction History")]]`, chromedp.BySearch),
		chromedp.WaitVisible(`#transactionHistoryTables_tableContent`, chromedp.ByID),
		chromedp.OuterHTML(`#transactionHistoryTables_tableContent`, &tableHTML),
	)

	if err != nil {
		log.Fatal(err)
	}

	if err := saveAsCSV(tableHTML, "transaction_history.csv"); err != nil {
		log.Fatal(err)
	}

	log.Println("Transaction history saved as CSV successfully")
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

func saveAsCSV(tableHTML, filename string) error {
	rows := parseTableHTML(tableHTML)

	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer file.Close()

	writer := csv.NewWriter(file)
	defer writer.Flush()

	for _, row := range rows {
		if err := writer.Write(row); err != nil {
			return err
		}
	}

	return nil
}

func parseTableHTML(tableHTML string) [][]string {
	reader := strings.NewReader(tableHTML)
	doc, err := goquery.NewDocumentFromReader(reader)
	if err != nil {
		log.Fatal(err)
	}

	var rows [][]string
	headers := []string{"Date", "Description", "Reference", "Service Fee", "Amount", "Balance"}
	rows = append(rows, headers)

	doc.Find(".tableRow.tableDataRow").Each(func(i int, s *goquery.Selection) {
		var row []string
		s.Find(".tableCellItem").Each(func(j int, cell *goquery.Selection) {
			row = append(row, strings.TrimSpace(cell.Text()))
		})
		if len(row) == 6 {
			rows = append(rows, row)
		}
	})

	return rows
}
