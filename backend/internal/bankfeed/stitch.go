//go:build live

// stitch.go — Stitch (https://stitch.money) live provider implementation.
//
// BUILD TAG: this file is only compiled when `-tags live` is passed, so unit
// tests and CI never make real HTTP calls to Stitch.
//
// # Required environment variables
//
//	STITCH_CLIENT_ID        OAuth2 client ID from https://stitch.money/developers
//	STITCH_CLIENT_SECRET    OAuth2 client secret
//	STITCH_REDIRECT_URL     Callback URL (must match Stitch developer portal)
//	STITCH_WEBHOOK_SECRET   Shared secret for validating webhook signatures
//
// # Stitch API overview
//
// Stitch uses OAuth2 + PKCE for account linking (bank-link modal).
// Transactions are retrieved via the Stitch GraphQL API at
// https://api.stitch.money/graphql.
// Webhooks are delivered as JSON POST to your registered endpoint with an
// HMAC-SHA256 signature in the X-Stitch-Signature header.
//
// SA bank coverage (at time of writing):
//   FNB, ABSA, Standard Bank, Nedbank, Capitec, Investec, Tymebank,
//   Discovery Bank, African Bank, Bidvest Bank, Grindrod Bank.
//
// Pagination: Stitch uses cursor-based pagination on the transactions query.
// The cursor value is persisted on bank_feed_connections.cursor and passed on
// subsequent calls to avoid re-fetching already-seen transactions.

package bankfeed

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	stitchAuthURL    = "https://secure.stitch.money/connect/authorize"
	stitchTokenURL   = "https://secure.stitch.money/connect/token"
	stitchGraphQLURL = "https://api.stitch.money/graphql"
)

// StitchProvider implements Provider against the live Stitch API.
type StitchProvider struct {
	clientID     string
	clientSecret string
	redirectURL  string
	webhookSecret string
	httpClient   *http.Client
}

// StitchConfig holds the credentials for the Stitch integration.
type StitchConfig struct {
	ClientID      string
	ClientSecret  string
	RedirectURL   string
	WebhookSecret string
}

// NewStitchProvider returns a live StitchProvider.
func NewStitchProvider(cfg StitchConfig) *StitchProvider {
	return &StitchProvider{
		clientID:      cfg.ClientID,
		clientSecret:  cfg.ClientSecret,
		redirectURL:   cfg.RedirectURL,
		webhookSecret: cfg.WebhookSecret,
		httpClient:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (p *StitchProvider) Name() ProviderName { return ProviderStitch }

// LinkURL builds the Stitch OAuth2 authorisation URL with the PKCE parameters.
// The user is redirected here to select their bank and consent.
func (p *StitchProvider) LinkURL(_ context.Context, orgID uuid.UUID, state string) (string, error) {
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", p.clientID)
	q.Set("redirect_uri", p.redirectURL)
	q.Set("scope", "accounts transactions balances identity openid offline_access")
	q.Set("state", state)
	// orgID is embedded in state; include as nonce for traceability.
	q.Set("nonce", orgID.String())
	return stitchAuthURL + "?" + q.Encode(), nil
}

// ExchangeCode exchanges an OAuth2 code for tokens and queries Stitch for the
// list of linked accounts.
func (p *StitchProvider) ExchangeCode(ctx context.Context, code string) ([]LinkedAccount, string, string, time.Time, error) {
	// 1. Token exchange.
	data := url.Values{}
	data.Set("grant_type", "authorization_code")
	data.Set("code", code)
	data.Set("redirect_uri", p.redirectURL)
	data.Set("client_id", p.clientID)
	data.Set("client_secret", p.clientSecret)

	accessToken, refreshToken, expiresAt, err := p.doTokenRequest(ctx, data)
	if err != nil {
		return nil, "", "", time.Time{}, fmt.Errorf("stitch: token exchange: %w", err)
	}

	// 2. Fetch linked accounts.
	accounts, err := p.Accounts(ctx, accessToken, "")
	if err != nil {
		return nil, "", "", time.Time{}, fmt.Errorf("stitch: accounts after exchange: %w", err)
	}

	return accounts, accessToken, refreshToken, expiresAt, nil
}

// RefreshToken obtains a new access token using the stored refresh token.
func (p *StitchProvider) RefreshToken(ctx context.Context, refreshToken string) (string, string, time.Time, error) {
	data := url.Values{}
	data.Set("grant_type", "refresh_token")
	data.Set("refresh_token", refreshToken)
	data.Set("client_id", p.clientID)
	data.Set("client_secret", p.clientSecret)
	return p.doTokenRequest(ctx, data)
}

// Accounts queries the Stitch GraphQL API for the user's linked bank accounts.
func (p *StitchProvider) Accounts(ctx context.Context, accessToken, _ string) ([]LinkedAccount, error) {
	const gql = `{
		user {
			bankAccounts {
				id
				name
				currency
				accountType
				bankId
				branchCode
				accountNumber
			}
		}
	}`

	type gqlAccount struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		Currency      string `json:"currency"`
		AccountType   string `json:"accountType"`
		BankID        string `json:"bankId"`
		BranchCode    string `json:"branchCode"`
		AccountNumber string `json:"accountNumber"`
	}
	type gqlUser struct {
		BankAccounts []gqlAccount `json:"bankAccounts"`
	}
	type gqlData struct {
		User gqlUser `json:"user"`
	}
	type gqlResp struct {
		Data   gqlData  `json:"data"`
		Errors []struct{ Message string } `json:"errors"`
	}

	var resp gqlResp
	if err := p.gqlQuery(ctx, accessToken, gql, nil, &resp); err != nil {
		return nil, err
	}
	if len(resp.Errors) > 0 {
		return nil, fmt.Errorf("stitch: accounts gql: %s", resp.Errors[0].Message)
	}

	var out []LinkedAccount
	for _, a := range resp.Data.User.BankAccounts {
		mask := ""
		if len(a.AccountNumber) >= 4 {
			mask = a.AccountNumber[len(a.AccountNumber)-4:]
		}
		out = append(out, LinkedAccount{
			ProviderAccountID: a.ID,
			ProviderItemID:    a.ID, // Stitch: account = item (one-to-one)
			InstitutionID:     a.BankID,
			InstitutionName:   bankIDToName(a.BankID),
			Mask:              mask,
			Currency:          a.Currency,
			AccountType:       a.AccountType,
		})
	}
	return out, nil
}

// FetchTransactions queries the Stitch GraphQL API for transactions on the
// given account within the time window.  Returns the next cursor for
// pagination (empty when exhausted).
func (p *StitchProvider) FetchTransactions(ctx context.Context, accessToken, providerAccountID string, from, to time.Time, cursor string) ([]ProviderTransaction, string, error) {
	const gqlTmpl = `
	query Transactions($accountId: ID!, $first: Int!, $after: String, $fromDate: Date, $toDate: Date) {
		node(id: $accountId) {
			... on BankAccount {
				transactions(first: $first, after: $after, filter: { date: { gte: $fromDate, lte: $toDate } }) {
					pageInfo { hasNextPage endCursor }
					edges {
						node {
							id
							amount { quantity currency }
							description
							date
							runningBalance { quantity currency }
							transactionType
						}
					}
				}
			}
		}
	}`

	vars := map[string]any{
		"accountId": providerAccountID,
		"first":     100,
		"fromDate":  from.Format("2006-01-02"),
		"toDate":    to.Format("2006-01-02"),
	}
	if cursor != "" {
		vars["after"] = cursor
	}

	type amountNode struct {
		Quantity float64 `json:"quantity"`
		Currency string  `json:"currency"`
	}
	type txnNode struct {
		ID             string     `json:"id"`
		Amount         amountNode `json:"amount"`
		Description    string     `json:"description"`
		Date           string     `json:"date"`
		RunningBalance amountNode `json:"runningBalance"`
		TxnType        string     `json:"transactionType"`
	}
	type pageInfo struct {
		HasNextPage bool   `json:"hasNextPage"`
		EndCursor   string `json:"endCursor"`
	}
	type txnConn struct {
		PageInfo pageInfo `json:"pageInfo"`
		Edges    []struct {
			Node txnNode `json:"node"`
		} `json:"edges"`
	}
	type bankAccNode struct {
		Transactions txnConn `json:"transactions"`
	}
	type gqlData struct {
		Node bankAccNode `json:"node"`
	}
	type gqlResp struct {
		Data   gqlData  `json:"data"`
		Errors []struct{ Message string } `json:"errors"`
	}

	var resp gqlResp
	if err := p.gqlQuery(ctx, accessToken, gqlTmpl, vars, &resp); err != nil {
		return nil, "", err
	}
	if len(resp.Errors) > 0 {
		return nil, "", fmt.Errorf("stitch: transactions gql: %s", resp.Errors[0].Message)
	}

	conn := resp.Data.Node.Transactions
	var out []ProviderTransaction
	for _, edge := range conn.Edges {
		n := edge.Node
		date, err := time.Parse("2006-01-02", n.Date)
		if err != nil {
			date = time.Now()
		}
		dir := "debit"
		if n.Amount.Quantity > 0 {
			dir = "credit"
		}
		amt := n.Amount.Quantity
		if amt < 0 {
			amt = -amt
		}
		var bal *float64
		if n.RunningBalance.Quantity != 0 {
			b := n.RunningBalance.Quantity
			bal = &b
		}
		raw := map[string]any{
			"id":              n.ID,
			"transactionType": n.TxnType,
			"date":            n.Date,
			"amount":          n.Amount,
			"runningBalance":  n.RunningBalance,
		}
		out = append(out, ProviderTransaction{
			ProviderTxnID: n.ID,
			Date:          date,
			Description:   n.Description,
			Amount:        amt,
			Currency:      n.Amount.Currency,
			Direction:     dir,
			Balance:       bal,
			Raw:           raw,
		})
	}

	nextCursor := ""
	if conn.PageInfo.HasNextPage {
		nextCursor = conn.PageInfo.EndCursor
	}
	return out, nextCursor, nil
}

// WebhookEventType extracts the top-level "type" field from a Stitch webhook.
func (p *StitchProvider) WebhookEventType(payload []byte) (string, error) {
	var body struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return "", fmt.Errorf("stitch: parse webhook type: %w", err)
	}
	return body.Type, nil
}

// ValidateWebhook verifies the HMAC-SHA256 signature in X-Stitch-Signature.
func (p *StitchProvider) ValidateWebhook(payload []byte, headers map[string]string) error {
	sig, ok := headers["X-Stitch-Signature"]
	if !ok {
		return errors.New("stitch: missing X-Stitch-Signature header")
	}
	mac := hmac.New(sha256.New, []byte(p.webhookSecret))
	mac.Write(payload)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return errors.New("stitch: invalid webhook signature")
	}
	return nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func (p *StitchProvider) doTokenRequest(ctx context.Context, data url.Values) (string, string, time.Time, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, stitchTokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return "", "", time.Time{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return "", "", time.Time{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", "", time.Time{}, fmt.Errorf("stitch: token request %d: %s", resp.StatusCode, body)
	}
	var tok struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", "", time.Time{}, err
	}
	expiresAt := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	return tok.AccessToken, tok.RefreshToken, expiresAt, nil
}

func (p *StitchProvider) gqlQuery(ctx context.Context, accessToken, query string, variables map[string]any, out any) error {
	payload := map[string]any{"query": query}
	if variables != nil {
		payload["variables"] = variables
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, stitchGraphQLURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("stitch: gql %d: %s", resp.StatusCode, raw)
	}
	return json.Unmarshal(raw, out)
}

// bankIDToName maps Stitch bank IDs to display names.
func bankIDToName(id string) string {
	names := map[string]string{
		"fnb":              "FNB / First National Bank",
		"absa":             "ABSA Bank",
		"standard_bank":    "Standard Bank",
		"nedbank":          "Nedbank",
		"capitec":          "Capitec Bank",
		"investec":         "Investec Bank",
		"tymebank":         "TymeBank",
		"discovery_bank":   "Discovery Bank",
		"african_bank":     "African Bank",
		"bidvest_bank":     "Bidvest Bank",
		"grindrod_bank":    "Grindrod Bank",
	}
	if n, ok := names[id]; ok {
		return n
	}
	return id
}
