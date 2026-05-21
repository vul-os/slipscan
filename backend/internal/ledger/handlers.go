package ledger

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/identity"
)

// Handler exposes the P2-03 ledger HTTP endpoints.
type Handler struct {
	store *Store
}

// NewHandler returns a Handler backed by store.
func NewHandler(store *Store) *Handler { return &Handler{store: store} }

// ─── path helpers ─────────────────────────────────────────────────────────────

func pathUUID(r *http.Request, param string) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue(param))
	return id, err == nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Chart of accounts
// ═══════════════════════════════════════════════════════════════════════════

// accountResponse is the JSON representation of an Account.
type accountResponse struct {
	ID             string    `json:"id"`
	OrganizationID string    `json:"organization_id"`
	ParentID       string    `json:"parent_id,omitempty"`
	Code           string    `json:"code,omitempty"`
	Name           string    `json:"name"`
	Type           string    `json:"type"`
	Subtype        string    `json:"subtype,omitempty"`
	Currency       string    `json:"currency"`
	TaxRateID      string    `json:"tax_rate_id,omitempty"`
	Description    string    `json:"description,omitempty"`
	IsArchived     bool      `json:"is_archived"`
	IsSystem       bool      `json:"is_system"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func toAccountResponse(a Account) accountResponse {
	r := accountResponse{
		ID:             a.ID.String(),
		OrganizationID: a.OrganizationID.String(),
		Name:           a.Name,
		Type:           a.Type,
		Currency:       a.Currency,
		IsArchived:     a.IsArchived,
		IsSystem:       a.IsSystem,
		CreatedAt:      a.CreatedAt,
		UpdatedAt:      a.UpdatedAt,
	}
	if a.ParentID.Valid {
		r.ParentID = a.ParentID.UUID.String()
	}
	if a.Code.Valid {
		r.Code = a.Code.String
	}
	if a.Subtype.Valid {
		r.Subtype = a.Subtype.String
	}
	if a.TaxRateID.Valid {
		r.TaxRateID = a.TaxRateID.UUID.String()
	}
	if a.Description.Valid {
		r.Description = a.Description.String
	}
	return r
}

// ListAccounts handles GET /orgs/{orgID}/accounts
func (h *Handler) ListAccounts(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	accounts, err := h.store.ListAccounts(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	out := make([]accountResponse, 0, len(accounts))
	for _, a := range accounts {
		out = append(out, toAccountResponse(a))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"accounts": out})
}

// GetAccount handles GET /orgs/{orgID}/accounts/{accountID}
func (h *Handler) GetAccount(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	accountID, ok := pathUUID(r, "accountID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_account_id", "invalid account id")
		return
	}
	a, err := h.store.GetAccount(r.Context(), orgID, accountID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "account not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "fetch_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, toAccountResponse(*a))
}

type createAccountRequest struct {
	ParentID    string `json:"parent_id,omitempty"`
	Code        string `json:"code,omitempty"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Subtype     string `json:"subtype,omitempty"`
	Currency    string `json:"currency"`
	TaxRateID   string `json:"tax_rate_id,omitempty"`
	Description string `json:"description,omitempty"`
}

// CreateAccount handles POST /orgs/{orgID}/accounts
func (h *Handler) CreateAccount(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	var req createAccountRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	in := CreateAccountInput{
		Code:        req.Code,
		Name:        req.Name,
		Type:        req.Type,
		Subtype:     req.Subtype,
		Currency:    req.Currency,
		Description: req.Description,
	}
	if req.ParentID != "" {
		id, err := uuid.Parse(req.ParentID)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_parent_id", "invalid parent_id")
			return
		}
		in.ParentID = &id
	}
	if req.TaxRateID != "" {
		id, err := uuid.Parse(req.TaxRateID)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_tax_rate_id", "invalid tax_rate_id")
			return
		}
		in.TaxRateID = &id
	}

	a, err := h.store.CreateAccount(r.Context(), orgID, in)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "create_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, toAccountResponse(*a))
}

type updateAccountRequest struct {
	Code        *string `json:"code,omitempty"`
	Name        *string `json:"name,omitempty"`
	Subtype     *string `json:"subtype,omitempty"`
	Description *string `json:"description,omitempty"`
	IsArchived  *bool   `json:"is_archived,omitempty"`
}

// UpdateAccount handles PATCH /orgs/{orgID}/accounts/{accountID}
func (h *Handler) UpdateAccount(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	accountID, ok := pathUUID(r, "accountID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_account_id", "invalid account id")
		return
	}
	var req updateAccountRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	in := UpdateAccountInput{
		Code:        req.Code,
		Name:        req.Name,
		Subtype:     req.Subtype,
		Description: req.Description,
		IsArchived:  req.IsArchived,
	}
	a, err := h.store.UpdateAccount(r.Context(), orgID, accountID, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "account not found")
			return
		}
		if errors.Is(err, ErrSystemAccount) {
			httpx.WriteError(w, http.StatusForbidden, "system_account", err.Error())
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "update_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, toAccountResponse(*a))
}

// DeleteAccount handles DELETE /orgs/{orgID}/accounts/{accountID}
func (h *Handler) DeleteAccount(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	accountID, ok := pathUUID(r, "accountID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_account_id", "invalid account id")
		return
	}
	err := h.store.DeleteAccount(r.Context(), orgID, accountID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "account not found")
			return
		}
		if errors.Is(err, ErrSystemAccount) {
			httpx.WriteError(w, http.StatusForbidden, "system_account", err.Error())
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "delete_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusNoContent, nil)
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction posting
// ═══════════════════════════════════════════════════════════════════════════

// PostTransaction handles POST /orgs/{orgID}/transactions/{txID}/post
func (h *Handler) PostTransaction(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	txID, ok := pathUUID(r, "txID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_tx_id", "invalid transaction id")
		return
	}
	if err := h.store.PostTransaction(r.Context(), orgID, txID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "transaction not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "post_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"posted": true})
}

// ═══════════════════════════════════════════════════════════════════════════
// Manual journals
// ═══════════════════════════════════════════════════════════════════════════

// journalLineRequest is one line in the create-journal request body.
type journalLineRequest struct {
	AccountID   string  `json:"account_id"`
	Debit       float64 `json:"debit"`
	Credit      float64 `json:"credit"`
	Description string  `json:"description,omitempty"`
}

// createJournalRequest is the body for POST /orgs/{orgID}/journals
type createJournalRequest struct {
	PostedDate string               `json:"posted_date"` // YYYY-MM-DD
	Narrative  string               `json:"narrative,omitempty"`
	Reference  string               `json:"reference,omitempty"`
	Lines      []journalLineRequest `json:"lines"`
}

type journalLineResponse struct {
	AccountID   string  `json:"account_id"`
	Debit       float64 `json:"debit"`
	Credit      float64 `json:"credit"`
	Description string  `json:"description,omitempty"`
}

type journalResponse struct {
	ID             string                `json:"id"`
	OrganizationID string                `json:"organization_id"`
	PostedDate     string                `json:"posted_date"`
	Narrative      string                `json:"narrative,omitempty"`
	Reference      string                `json:"reference,omitempty"`
	CreatedBy      string                `json:"created_by,omitempty"`
	CreatedAt      time.Time             `json:"created_at"`
	UpdatedAt      time.Time             `json:"updated_at"`
	Lines          []journalLineResponse `json:"lines,omitempty"`
}

func toJournalResponse(j ManualJournal) journalResponse {
	r := journalResponse{
		ID:             j.ID.String(),
		OrganizationID: j.OrganizationID.String(),
		PostedDate:     j.PostedDate.Format("2006-01-02"),
		CreatedAt:      j.CreatedAt,
		UpdatedAt:      j.UpdatedAt,
	}
	if j.Narrative.Valid {
		r.Narrative = j.Narrative.String
	}
	if j.Reference.Valid {
		r.Reference = j.Reference.String
	}
	if j.CreatedBy.Valid {
		r.CreatedBy = j.CreatedBy.UUID.String()
	}
	for _, l := range j.Lines {
		r.Lines = append(r.Lines, journalLineResponse{
			AccountID:   l.AccountID.String(),
			Debit:       l.Debit,
			Credit:      l.Credit,
			Description: l.Description,
		})
	}
	return r
}

// CreateJournal handles POST /orgs/{orgID}/journals
func (h *Handler) CreateJournal(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	uid, _ := identity.UserIDFrom(r.Context())

	var req createJournalRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if req.PostedDate == "" {
		httpx.WriteError(w, http.StatusBadRequest, "missing_posted_date", "posted_date is required (YYYY-MM-DD)")
		return
	}
	postedDate, err := time.Parse("2006-01-02", req.PostedDate)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_posted_date", "posted_date must be YYYY-MM-DD")
		return
	}

	lines := make([]JournalLine, 0, len(req.Lines))
	for i, l := range req.Lines {
		accID, err := uuid.Parse(l.AccountID)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_account_id",
				"line "+itoa(i)+": invalid account_id")
			return
		}
		lines = append(lines, JournalLine{
			AccountID:   accID,
			Debit:       l.Debit,
			Credit:      l.Credit,
			Description: l.Description,
		})
	}

	j, err := h.store.CreateManualJournal(r.Context(), orgID, postedDate,
		req.Narrative, req.Reference, &uid, lines)
	if err != nil {
		switch {
		case errors.Is(err, ErrUnbalanced):
			httpx.WriteError(w, http.StatusUnprocessableEntity, "unbalanced", err.Error())
		case errors.Is(err, ErrNoLines):
			httpx.WriteError(w, http.StatusBadRequest, "no_lines", err.Error())
		case errors.Is(err, ErrInvalidAmount):
			httpx.WriteError(w, http.StatusBadRequest, "invalid_amount", err.Error())
		default:
			httpx.WriteError(w, http.StatusInternalServerError, "create_failed", err.Error())
		}
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, toJournalResponse(*j))
}

// ListJournals handles GET /orgs/{orgID}/journals
func (h *Handler) ListJournals(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	journals, err := h.store.ListManualJournals(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	out := make([]journalResponse, 0, len(journals))
	for _, j := range journals {
		out = append(out, toJournalResponse(j))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"journals": out})
}

// GetJournal handles GET /orgs/{orgID}/journals/{journalID}
func (h *Handler) GetJournal(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	journalID, ok := pathUUID(r, "journalID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_journal_id", "invalid journal id")
		return
	}
	j, err := h.store.GetManualJournal(r.Context(), orgID, journalID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "journal not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "fetch_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, toJournalResponse(*j))
}

// DeleteJournal handles DELETE /orgs/{orgID}/journals/{journalID}
func (h *Handler) DeleteJournal(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	journalID, ok := pathUUID(r, "journalID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_journal_id", "invalid journal id")
		return
	}
	if err := h.store.DeleteManualJournal(r.Context(), orgID, journalID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "journal not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "delete_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusNoContent, nil)
}

// ═══════════════════════════════════════════════════════════════════════════
// Contacts
// ═══════════════════════════════════════════════════════════════════════════

type contactResponse struct {
	ID               string    `json:"id"`
	OrganizationID   string    `json:"organization_id"`
	Kind             string    `json:"kind"`
	Name             string    `json:"name"`
	LegalName        string    `json:"legal_name,omitempty"`
	Email            string    `json:"email,omitempty"`
	Phone            string    `json:"phone,omitempty"`
	TaxNumber        string    `json:"tax_number,omitempty"`
	PaymentTermsDays int       `json:"payment_terms_days"`
	DefaultAccountID string    `json:"default_account_id,omitempty"`
	DefaultTaxRateID string    `json:"default_tax_rate_id,omitempty"`
	Currency         string    `json:"currency,omitempty"`
	AddressLine1     string    `json:"address_line1,omitempty"`
	AddressLine2     string    `json:"address_line2,omitempty"`
	City             string    `json:"city,omitempty"`
	Region           string    `json:"region,omitempty"`
	PostalCode       string    `json:"postal_code,omitempty"`
	Country          string    `json:"country,omitempty"`
	Notes            string    `json:"notes,omitempty"`
	IsArchived       bool      `json:"is_archived"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

func toContactResponse(c Contact) contactResponse {
	r := contactResponse{
		ID:               c.ID.String(),
		OrganizationID:   c.OrganizationID.String(),
		Kind:             c.Kind,
		Name:             c.Name,
		PaymentTermsDays: c.PaymentTermsDays,
		IsArchived:       c.IsArchived,
		CreatedAt:        c.CreatedAt,
		UpdatedAt:        c.UpdatedAt,
	}
	nullToStr := func(n sql.NullString) string {
		if n.Valid {
			return n.String
		}
		return ""
	}
	r.LegalName = nullToStr(c.LegalName)
	r.Email = nullToStr(c.Email)
	r.Phone = nullToStr(c.Phone)
	r.TaxNumber = nullToStr(c.TaxNumber)
	r.Currency = nullToStr(c.Currency)
	r.AddressLine1 = nullToStr(c.AddressLine1)
	r.AddressLine2 = nullToStr(c.AddressLine2)
	r.City = nullToStr(c.City)
	r.Region = nullToStr(c.Region)
	r.PostalCode = nullToStr(c.PostalCode)
	r.Country = nullToStr(c.Country)
	r.Notes = nullToStr(c.Notes)
	if c.DefaultAccountID.Valid {
		r.DefaultAccountID = c.DefaultAccountID.UUID.String()
	}
	if c.DefaultTaxRateID.Valid {
		r.DefaultTaxRateID = c.DefaultTaxRateID.UUID.String()
	}
	return r
}

// ListContacts handles GET /orgs/{orgID}/contacts
func (h *Handler) ListContacts(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	contacts, err := h.store.ListContacts(r.Context(), orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	out := make([]contactResponse, 0, len(contacts))
	for _, c := range contacts {
		out = append(out, toContactResponse(c))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"contacts": out})
}

// GetContact handles GET /orgs/{orgID}/contacts/{contactID}
func (h *Handler) GetContact(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	contactID, ok := pathUUID(r, "contactID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_contact_id", "invalid contact id")
		return
	}
	c, err := h.store.GetContact(r.Context(), orgID, contactID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "contact not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "fetch_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, toContactResponse(*c))
}

type createContactRequest struct {
	Kind             string `json:"kind,omitempty"`
	Name             string `json:"name"`
	LegalName        string `json:"legal_name,omitempty"`
	Email            string `json:"email,omitempty"`
	Phone            string `json:"phone,omitempty"`
	TaxNumber        string `json:"tax_number,omitempty"`
	PaymentTermsDays int    `json:"payment_terms_days,omitempty"`
	DefaultAccountID string `json:"default_account_id,omitempty"`
	DefaultTaxRateID string `json:"default_tax_rate_id,omitempty"`
	Currency         string `json:"currency,omitempty"`
	AddressLine1     string `json:"address_line1,omitempty"`
	AddressLine2     string `json:"address_line2,omitempty"`
	City             string `json:"city,omitempty"`
	Region           string `json:"region,omitempty"`
	PostalCode       string `json:"postal_code,omitempty"`
	Country          string `json:"country,omitempty"`
	Notes            string `json:"notes,omitempty"`
}

// CreateContact handles POST /orgs/{orgID}/contacts
func (h *Handler) CreateContact(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	var req createContactRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	in := CreateContactInput{
		Kind:             req.Kind,
		Name:             req.Name,
		LegalName:        req.LegalName,
		Email:            req.Email,
		Phone:            req.Phone,
		TaxNumber:        req.TaxNumber,
		PaymentTermsDays: req.PaymentTermsDays,
		Currency:         req.Currency,
		AddressLine1:     req.AddressLine1,
		AddressLine2:     req.AddressLine2,
		City:             req.City,
		Region:           req.Region,
		PostalCode:       req.PostalCode,
		Country:          req.Country,
		Notes:            req.Notes,
	}
	if req.DefaultAccountID != "" {
		id, err := uuid.Parse(req.DefaultAccountID)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_default_account_id", "invalid default_account_id")
			return
		}
		in.DefaultAccountID = &id
	}
	if req.DefaultTaxRateID != "" {
		id, err := uuid.Parse(req.DefaultTaxRateID)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_default_tax_rate_id", "invalid default_tax_rate_id")
			return
		}
		in.DefaultTaxRateID = &id
	}

	c, err := h.store.CreateContact(r.Context(), orgID, in)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "create_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, toContactResponse(*c))
}

type updateContactRequest struct {
	Kind             *string `json:"kind,omitempty"`
	Name             *string `json:"name,omitempty"`
	LegalName        *string `json:"legal_name,omitempty"`
	Email            *string `json:"email,omitempty"`
	Phone            *string `json:"phone,omitempty"`
	TaxNumber        *string `json:"tax_number,omitempty"`
	PaymentTermsDays *int    `json:"payment_terms_days,omitempty"`
	IsArchived       *bool   `json:"is_archived,omitempty"`
	Notes            *string `json:"notes,omitempty"`
}

// UpdateContact handles PATCH /orgs/{orgID}/contacts/{contactID}
func (h *Handler) UpdateContact(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	contactID, ok := pathUUID(r, "contactID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_contact_id", "invalid contact id")
		return
	}
	var req updateContactRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	in := UpdateContactInput{
		Kind:             req.Kind,
		Name:             req.Name,
		LegalName:        req.LegalName,
		Email:            req.Email,
		Phone:            req.Phone,
		TaxNumber:        req.TaxNumber,
		PaymentTermsDays: req.PaymentTermsDays,
		IsArchived:       req.IsArchived,
		Notes:            req.Notes,
	}
	c, err := h.store.UpdateContact(r.Context(), orgID, contactID, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "contact not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "update_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, toContactResponse(*c))
}

// DeleteContact handles DELETE /orgs/{orgID}/contacts/{contactID}
func (h *Handler) DeleteContact(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	contactID, ok := pathUUID(r, "contactID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_contact_id", "invalid contact id")
		return
	}
	if err := h.store.DeleteContact(r.Context(), orgID, contactID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "contact not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "delete_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusNoContent, nil)
}

// ═══════════════════════════════════════════════════════════════════════════
// Queries — account ledger + trial balance
// ═══════════════════════════════════════════════════════════════════════════

// AccountLedger handles GET /orgs/{orgID}/accounts/{accountID}/ledger?from=&to=
func (h *Handler) AccountLedger(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	accountID, ok := pathUUID(r, "accountID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_account_id", "invalid account id")
		return
	}

	var from, to time.Time
	if v := r.URL.Query().Get("from"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_from", "from must be YYYY-MM-DD")
			return
		}
		from = t
	}
	if v := r.URL.Query().Get("to"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_to", "to must be YYYY-MM-DD")
			return
		}
		to = t
	}

	entries, err := h.store.AccountLedger(r.Context(), orgID, accountID, from, to)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "not_found", "account not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "query_failed", err.Error())
		return
	}

	type entryOut struct {
		ID          string  `json:"id"`
		SourceType  string  `json:"source_type"`
		SourceID    string  `json:"source_id"`
		PostedDate  string  `json:"posted_date"`
		Debit       float64 `json:"debit"`
		Credit      float64 `json:"credit"`
		Description string  `json:"description,omitempty"`
	}
	out := make([]entryOut, 0, len(entries))
	for _, e := range entries {
		out = append(out, entryOut{
			ID:          e.EntryID.String(),
			SourceType:  e.SourceType,
			SourceID:    e.SourceID.String(),
			PostedDate:  e.PostedDate.Format("2006-01-02"),
			Debit:       e.Debit,
			Credit:      e.Credit,
			Description: e.Description,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"entries": out})
}

// TrialBalance handles GET /orgs/{orgID}/trial-balance?from=&to=
func (h *Handler) TrialBalance(w http.ResponseWriter, r *http.Request) {
	orgID, ok := pathUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}

	var from, to time.Time
	if v := r.URL.Query().Get("from"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_from", "from must be YYYY-MM-DD")
			return
		}
		from = t
	}
	if v := r.URL.Query().Get("to"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "invalid_to", "to must be YYYY-MM-DD")
			return
		}
		to = t
	}

	lines, err := h.store.TrialBalance(r.Context(), orgID, from, to)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "query_failed", err.Error())
		return
	}

	type lineOut struct {
		AccountID   string  `json:"account_id"`
		AccountCode string  `json:"account_code,omitempty"`
		AccountName string  `json:"account_name"`
		AccountType string  `json:"account_type"`
		TotalDebit  float64 `json:"total_debit"`
		TotalCredit float64 `json:"total_credit"`
	}
	var totalDebit, totalCredit float64
	out := make([]lineOut, 0, len(lines))
	for _, l := range lines {
		totalDebit += l.TotalDebit
		totalCredit += l.TotalCredit
		out = append(out, lineOut{
			AccountID:   l.AccountID.String(),
			AccountCode: l.AccountCode,
			AccountName: l.AccountName,
			AccountType: l.AccountType,
			TotalDebit:  l.TotalDebit,
			TotalCredit: l.TotalCredit,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"lines":        out,
		"total_debit":  totalDebit,
		"total_credit": totalCredit,
	})
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	buf := make([]byte, 0, 10)
	if n < 0 {
		buf = append(buf, '-')
		n = -n
	}
	tmp := make([]byte, 0, 10)
	for n > 0 {
		tmp = append(tmp, byte('0'+n%10))
		n /= 10
	}
	for i := len(tmp) - 1; i >= 0; i-- {
		buf = append(buf, tmp[i])
	}
	return string(buf)
}
