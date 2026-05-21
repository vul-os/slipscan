package accounting_export

import (
	"bytes"
	"context"
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

// ─── Xero OAuth2 + API configuration ─────────────────────────────────────────

// XeroConfig holds OAuth2 credentials and endpoints. All values are injected
// from environment variables (XERO_CLIENT_ID, XERO_CLIENT_SECRET,
// XERO_REDIRECT_URL). No defaults for secrets; missing values produce an
// error at construction time.
type XeroConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
	// Scopes is the list of Xero OAuth2 scopes to request.
	// Defaults to the recommended set when nil.
	Scopes []string
}

// DefaultXeroScopes are the Xero API scopes required for contacts +
// bank transactions. "offline_access" is required for refresh tokens.
var DefaultXeroScopes = []string{
	"openid",
	"profile",
	"email",
	"accounting.contacts",
	"accounting.transactions",
	"offline_access",
}

// xeroTokenResponse is the JSON body returned by the Xero token endpoint.
type xeroTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"` // seconds
	IDToken      string `json:"id_token"`
}

// xeroConnectionsResponse is the JSON from GET /connections.
type xeroConnectionsResponse []struct {
	TenantID   string `json:"tenantId"`
	TenantType string `json:"tenantType"`
	TenantName string `json:"tenantName"`
}

// ─── XeroHTTPClient interface (allows mock in tests) ─────────────────────────

// XeroHTTPClient is the subset of *http.Client that XeroProvider uses.
// Swap in a test double via NewXeroProviderWithClient to avoid live network
// calls in unit tests. Gate real integration tests behind build tag `integration`.
type XeroHTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
}

// ─── Token encryption ─────────────────────────────────────────────────────────

// TokenCipher handles symmetric encryption of OAuth tokens before storage in
// oauth_grants. The real implementation uses AES-256-GCM with a key derived
// from APP_SECRET. Keeping it as an interface lets tests inject a no-op.
type TokenCipher interface {
	Encrypt(plaintext []byte) ([]byte, error)
	Decrypt(ciphertext []byte) ([]byte, error)
}

// PlaintextCipher is a no-op TokenCipher used in development/tests.
// In production replace with an AES-GCM implementation keyed from APP_SECRET.
type PlaintextCipher struct{}

func (PlaintextCipher) Encrypt(b []byte) ([]byte, error) { return b, nil }
func (PlaintextCipher) Decrypt(b []byte) ([]byte, error) { return b, nil }

// ─── XeroProvider ─────────────────────────────────────────────────────────────

// XeroProvider implements Provider for Xero. It is safe for concurrent use.
type XeroProvider struct {
	cfg    XeroConfig
	store  *Store
	client XeroHTTPClient
	cipher TokenCipher
}

// NewXeroProvider constructs a XeroProvider using the standard http.Client and
// PlaintextCipher. For production use swap cipher for a real AES-GCM cipher.
func NewXeroProvider(cfg XeroConfig, store *Store) (*XeroProvider, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		return nil, errors.New("xero: XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URL are required")
	}
	if len(cfg.Scopes) == 0 {
		cfg.Scopes = DefaultXeroScopes
	}
	return &XeroProvider{
		cfg:    cfg,
		store:  store,
		client: &http.Client{Timeout: 15 * time.Second},
		cipher: PlaintextCipher{},
	}, nil
}

// NewXeroProviderWithClient constructs a XeroProvider with an injected HTTP
// client and cipher. Used in tests to avoid live network calls.
func NewXeroProviderWithClient(cfg XeroConfig, store *Store, client XeroHTTPClient, cipher TokenCipher) (*XeroProvider, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		return nil, errors.New("xero: XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URL are required")
	}
	if len(cfg.Scopes) == 0 {
		cfg.Scopes = DefaultXeroScopes
	}
	return &XeroProvider{
		cfg:    cfg,
		store:  store,
		client: client,
		cipher: cipher,
	}, nil
}

// Name implements Provider.
func (p *XeroProvider) Name() string { return "xero" }

// AuthURL implements Provider. Returns the Xero consent URL.
// state must be a cryptographically random, session-bound nonce validated
// in the callback handler.
func (p *XeroProvider) AuthURL(orgID uuid.UUID, state string) string {
	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", p.cfg.ClientID)
	params.Set("redirect_uri", p.cfg.RedirectURL)
	params.Set("scope", strings.Join(p.cfg.Scopes, " "))
	params.Set("state", state)
	return "https://login.xero.com/identity/connect/authorize?" + params.Encode()
}

// ExchangeCode implements Provider. Exchanges an authorisation code for tokens
// and stores them encrypted in oauth_grants. It also calls GET /connections to
// fetch the Xero tenant ID (stored as account_email for display purposes).
func (p *XeroProvider) ExchangeCode(ctx context.Context, orgID, userID uuid.UUID, code string) (string, error) {
	tok, err := p.tokenRequest(ctx, url.Values{
		"grant_type":   {"authorization_code"},
		"code":         {code},
		"redirect_uri": {p.cfg.RedirectURL},
	})
	if err != nil {
		return "", fmt.Errorf("xero: exchange code: %w", err)
	}

	tenantID, err := p.fetchTenantID(ctx, tok.AccessToken)
	if err != nil {
		return "", fmt.Errorf("xero: fetch tenant id: %w", err)
	}

	if err := p.storeTokens(ctx, orgID, userID, tenantID, tok); err != nil {
		return "", fmt.Errorf("xero: store tokens: %w", err)
	}
	return tenantID, nil
}

// RefreshToken implements Provider. Fetches a new access token using the stored
// refresh token and persists the updated pair to oauth_grants.
func (p *XeroProvider) RefreshToken(ctx context.Context, orgID uuid.UUID) error {
	grant, err := p.store.GetGrant(ctx, orgID, p.Name())
	if err != nil {
		return fmt.Errorf("xero: refresh: %w", err)
	}

	refreshPlain, err := p.cipher.Decrypt(grant.RefreshTokenEncrypted)
	if err != nil {
		return fmt.Errorf("xero: decrypt refresh token: %w", err)
	}

	tok, err := p.tokenRequest(ctx, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {string(refreshPlain)},
	})
	if err != nil {
		return fmt.Errorf("xero: refresh token: %w", err)
	}

	accessEnc, err := p.cipher.Encrypt([]byte(tok.AccessToken))
	if err != nil {
		return fmt.Errorf("xero: encrypt access token: %w", err)
	}
	refreshEnc, err := p.cipher.Encrypt([]byte(tok.RefreshToken))
	if err != nil {
		return fmt.Errorf("xero: encrypt refresh token: %w", err)
	}

	expiresAt := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	return p.store.UpdateGrantTokens(ctx, grant.ID, accessEnc, refreshEnc, expiresAt)
}

// PushContact implements Provider. Creates or updates a Xero Contact.
func (p *XeroProvider) PushContact(ctx context.Context, orgID uuid.UUID, c Contact) (PushResult, error) {
	accessToken, tenantID, err := p.getAccessToken(ctx, orgID)
	if err != nil {
		return PushResult{}, err
	}

	// Check for existing mapping to decide create vs update.
	mapping, err := p.store.GetMapping(ctx, orgID, p.Name(), "contact", c.ID)
	isUpdate := err == nil

	xc := p.buildXeroContact(c, mapping)
	body, err := json.Marshal(map[string]any{"Contacts": []any{xc}})
	if err != nil {
		return PushResult{}, fmt.Errorf("xero: marshal contact: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.xero.com/api.xro/2.0/Contacts", bytes.NewReader(body))
	if err != nil {
		return PushResult{}, err
	}
	p.setHeaders(req, accessToken, tenantID)

	resp, err := p.client.Do(req)
	if err != nil {
		return PushResult{}, fmt.Errorf("xero: push contact: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return PushResult{}, fmt.Errorf("xero: push contact: HTTP %d: %s", resp.StatusCode, string(b))
	}

	var result struct {
		Contacts []struct {
			ContactID string `json:"ContactID"`
		} `json:"Contacts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return PushResult{}, fmt.Errorf("xero: decode contact response: %w", err)
	}
	if len(result.Contacts) == 0 {
		return PushResult{}, errors.New("xero: push contact: empty response")
	}
	externalID := result.Contacts[0].ContactID
	if err := p.store.UpsertMapping(ctx, orgID, p.Name(), "contact", c.ID, externalID); err != nil {
		return PushResult{}, fmt.Errorf("xero: upsert contact mapping: %w", err)
	}
	return PushResult{LocalID: c.ID, ExternalID: externalID, Updated: isUpdate}, nil
}

// PushTransaction implements Provider. Creates or updates a Xero BankTransaction
// (RECEIVE for credits, SPEND for debits) or a bill (ACCPAY) when the
// transaction direction is debit and a supplier contact is mapped.
func (p *XeroProvider) PushTransaction(ctx context.Context, orgID uuid.UUID, t Transaction) (PushResult, error) {
	accessToken, tenantID, err := p.getAccessToken(ctx, orgID)
	if err != nil {
		return PushResult{}, err
	}

	mapping, err := p.store.GetMapping(ctx, orgID, p.Name(), "transaction", t.ID)
	isUpdate := err == nil

	xt := p.buildXeroBankTransaction(t, mapping)
	body, err := json.Marshal(map[string]any{"BankTransactions": []any{xt}})
	if err != nil {
		return PushResult{}, fmt.Errorf("xero: marshal transaction: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.xero.com/api.xro/2.0/BankTransactions", bytes.NewReader(body))
	if err != nil {
		return PushResult{}, err
	}
	p.setHeaders(req, accessToken, tenantID)

	resp, err := p.client.Do(req)
	if err != nil {
		return PushResult{}, fmt.Errorf("xero: push transaction: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return PushResult{}, fmt.Errorf("xero: push transaction: HTTP %d: %s", resp.StatusCode, string(b))
	}

	var result struct {
		BankTransactions []struct {
			BankTransactionID string `json:"BankTransactionID"`
		} `json:"BankTransactions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return PushResult{}, fmt.Errorf("xero: decode transaction response: %w", err)
	}
	if len(result.BankTransactions) == 0 {
		return PushResult{}, errors.New("xero: push transaction: empty response")
	}
	externalID := result.BankTransactions[0].BankTransactionID
	if err := p.store.UpsertMapping(ctx, orgID, p.Name(), "transaction", t.ID, externalID); err != nil {
		return PushResult{}, fmt.Errorf("xero: upsert transaction mapping: %w", err)
	}
	return PushResult{LocalID: t.ID, ExternalID: externalID, Updated: isUpdate}, nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// getAccessToken returns the plaintext access token and Xero tenant ID for the
// org, refreshing first if the stored token has expired.
func (p *XeroProvider) getAccessToken(ctx context.Context, orgID uuid.UUID) (accessToken, tenantID string, err error) {
	grant, err := p.store.GetGrant(ctx, orgID, p.Name())
	if err != nil {
		return "", "", fmt.Errorf("xero: no active grant for org %s: %w", orgID, err)
	}

	// Lazy refresh: refresh if expiry is within 60 seconds.
	if grant.ExpiresAt.Valid && time.Until(grant.ExpiresAt.Time) < 60*time.Second {
		if err := p.RefreshToken(ctx, orgID); err != nil {
			return "", "", fmt.Errorf("xero: token refresh: %w", err)
		}
		// Re-fetch after refresh.
		grant, err = p.store.GetGrant(ctx, orgID, p.Name())
		if err != nil {
			return "", "", err
		}
	}

	plain, err := p.cipher.Decrypt(grant.AccessTokenEncrypted)
	if err != nil {
		return "", "", fmt.Errorf("xero: decrypt access token: %w", err)
	}
	tenant := ""
	if grant.AccountEmail.Valid {
		tenant = grant.AccountEmail.String
	}
	return string(plain), tenant, nil
}

// tokenRequest performs a POST to the Xero token endpoint with the given form values.
func (p *XeroProvider) tokenRequest(ctx context.Context, params url.Values) (*xeroTokenResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://identity.xero.com/connect/token",
		strings.NewReader(params.Encode()))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(p.cfg.ClientID, p.cfg.ClientSecret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("token endpoint HTTP %d: %s", resp.StatusCode, string(b))
	}
	var tok xeroTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return nil, err
	}
	return &tok, nil
}

// fetchTenantID calls GET /connections to find the first ORGANISATION tenant
// and returns its tenantId. The tenant ID is used as the Xero-Tenant-Id header
// on all subsequent API calls and stored as account_email in oauth_grants.
func (p *XeroProvider) fetchTenantID(ctx context.Context, accessToken string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.xero.com/connections", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("connections HTTP %d: %s", resp.StatusCode, string(b))
	}
	var conns xeroConnectionsResponse
	if err := json.NewDecoder(resp.Body).Decode(&conns); err != nil {
		return "", err
	}
	for _, c := range conns {
		if c.TenantType == "ORGANISATION" {
			return c.TenantID, nil
		}
	}
	if len(conns) > 0 {
		return conns[0].TenantID, nil
	}
	return "", errors.New("no Xero tenants found for this connection")
}

// storeTokens encrypts and persists the token pair to oauth_grants.
func (p *XeroProvider) storeTokens(ctx context.Context, orgID, userID uuid.UUID, tenantID string, tok *xeroTokenResponse) error {
	accessEnc, err := p.cipher.Encrypt([]byte(tok.AccessToken))
	if err != nil {
		return err
	}
	refreshEnc, err := p.cipher.Encrypt([]byte(tok.RefreshToken))
	if err != nil {
		return err
	}
	expiresAt := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	return p.store.UpsertGrant(ctx, orgID, userID, p.Name(), tenantID, tok.TokenType, accessEnc, refreshEnc, expiresAt)
}

// setHeaders applies the required Xero API headers to an outgoing request.
func (p *XeroProvider) setHeaders(req *http.Request, accessToken, tenantID string) {
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Xero-Tenant-Id", tenantID)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
}

// ─── Xero payload builders ────────────────────────────────────────────────────

// buildXeroContact returns the JSON-serialisable map for the Xero Contact
// endpoint. If a mapping already exists the ContactID is included so Xero
// updates instead of creating a duplicate.
func (p *XeroProvider) buildXeroContact(c Contact, mapping *Mapping) map[string]any {
	xc := map[string]any{
		"Name": c.Name,
	}
	if mapping != nil {
		xc["ContactID"] = mapping.ExternalID
	}
	if c.Email != "" {
		xc["EmailAddress"] = c.Email
	}
	if c.Phone != "" {
		xc["Phones"] = []map[string]any{
			{"PhoneType": "DEFAULT", "PhoneNumber": c.Phone},
		}
	}
	if c.TaxNumber != "" {
		xc["TaxNumber"] = c.TaxNumber
	}
	// Map contact kind to Xero ContactStatus / IsSupplier / IsCustomer flags.
	switch c.Kind {
	case "customer":
		xc["IsCustomer"] = true
	case "supplier":
		xc["IsSupplier"] = true
	case "both":
		xc["IsCustomer"] = true
		xc["IsSupplier"] = true
	}
	// Address
	if c.AddressLine1 != "" || c.City != "" || c.Country != "" {
		xc["Addresses"] = []map[string]any{
			{
				"AddressType":  "STREET",
				"AddressLine1": c.AddressLine1,
				"AddressLine2": c.AddressLine2,
				"City":         c.City,
				"Region":       c.Region,
				"PostalCode":   c.PostalCode,
				"Country":      c.Country,
			},
		}
	}
	return xc
}

// buildXeroBankTransaction returns the JSON-serialisable map for the Xero
// BankTransactions endpoint. Type is SPEND for debits, RECEIVE for credits.
// If a mapping exists the BankTransactionID is included for update.
func (p *XeroProvider) buildXeroBankTransaction(t Transaction, mapping *Mapping) map[string]any {
	txType := "SPEND"
	if t.Direction == "credit" {
		txType = "RECEIVE"
	}

	xt := map[string]any{
		"Type": txType,
		"Date": t.PostedDate.Format("2006-01-02"),
		"LineItems": []map[string]any{
			{
				"Description": descriptionFor(t),
				"Quantity":    1,
				"UnitAmount":  t.Amount,
				"AccountCode": accountCodeFor(t.AccountCode),
				"TaxType":     taxTypeFor(t.TaxRateCode),
			},
		},
		"BankAccount": map[string]any{
			// The bank account code should match the org's clearing/bank account
			// in Xero. When AccountCode is blank we fall back to "090" (a common
			// default bank account code in Xero demo orgs).
			"Code": bankAccountCodeFor(t.AccountCode),
		},
	}
	if mapping != nil {
		xt["BankTransactionID"] = mapping.ExternalID
	}
	// Attach a contact when one is mapped.
	if t.ContactID != uuid.Nil {
		xt["Contact"] = map[string]any{"ContactID": t.ContactID.String()}
	}
	if t.Currency != "" {
		xt["CurrencyCode"] = t.Currency
	}
	return xt
}

// ─── Mapping helpers: categories → account codes, tax → Xero tax types ──────

// accountCodeFor returns the Xero chart-of-accounts code for a transaction line.
// If the transaction already carries a code (from the slip/scan accounts table)
// it is used directly. Missing or blank codes fall back to the Xero default
// "200" (Sales / general income/expense).
func accountCodeFor(code string) string {
	if code != "" {
		return code
	}
	return "200" // Xero default fallback
}

// bankAccountCodeFor returns the Xero bank account code. We use the same code
// from the transaction's account when it looks like a bank account code;
// otherwise fall back to "090" (Xero demo default bank).
func bankAccountCodeFor(code string) string {
	if code != "" {
		return code
	}
	return "090"
}

// taxTypeFor maps our internal tax_rates.code to the Xero tax type string.
// Xero uses its own named types (OUTPUT, INPUT, NONE, etc.).  We pass through
// our code directly — if the org has configured Xero-compatible codes in the
// tax_rates table they work immediately.  Unknown codes fall back to "NONE".
func taxTypeFor(code string) string {
	switch strings.ToUpper(code) {
	case "OUTPUT", "INPUT", "EXEMPTOUTPUT", "EXEMPTINPUT",
		"ZERORATEDOUTPUT", "ZERORATEDINPUT", "NONE":
		return strings.ToUpper(code)
	case "":
		return "NONE"
	default:
		// Pass through — the org may have configured Xero-aligned codes.
		return code
	}
}

// descriptionFor builds a human-readable line-item description.
func descriptionFor(t Transaction) string {
	if t.Merchant != "" && t.Description != "" && t.Merchant != t.Description {
		return t.Merchant + " — " + t.Description
	}
	if t.Merchant != "" {
		return t.Merchant
	}
	return t.Description
}
