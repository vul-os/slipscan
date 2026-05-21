package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/exolutionza/slipscan/backend/internal/auth"
	"github.com/exolutionza/slipscan/backend/internal/classify"
	"github.com/exolutionza/slipscan/backend/internal/config"
	"github.com/exolutionza/slipscan/backend/internal/db"
	"github.com/exolutionza/slipscan/backend/internal/document"
	"github.com/exolutionza/slipscan/backend/internal/email"
	"github.com/exolutionza/slipscan/backend/internal/extract"
	"github.com/exolutionza/slipscan/backend/internal/fx"
	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/insights"
	"github.com/exolutionza/slipscan/backend/internal/invite"
	"github.com/exolutionza/slipscan/backend/internal/ledger"
	"github.com/exolutionza/slipscan/backend/internal/ocr"
	"github.com/exolutionza/slipscan/backend/internal/org"
	"github.com/exolutionza/slipscan/backend/internal/reporting"
	"github.com/exolutionza/slipscan/backend/internal/storage"
)

func main() {
	for _, name := range envFilesForAppEnv(os.Getenv("APP_ENV")) {
		if err := config.LoadDotenv(name); err != nil {
			log.Fatalf("dotenv %s: %v", name, err)
		}
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()

	signer := auth.NewSigner(cfg.JWTSecret, cfg.AccessTokenTTL, cfg.RefreshTTL, "slipscan")

	storageClient, err := storage.New(storage.Config{
		KeyID:          cfg.B2KeyID,
		ApplicationKey: cfg.B2ApplicationKey,
		Bucket:         cfg.B2Bucket,
		Region:         cfg.B2Region,
		Endpoint:       cfg.B2Endpoint,
	})
	if err != nil {
		log.Fatalf("storage: %v", err)
	}
	ocrClient := ocr.New(cfg.GeminiAPIKey)

	var mailer email.Sender = email.NoopSender{}
	if cfg.ResendAPIKey != "" {
		mailer = email.NewResend(cfg.ResendAPIKey, cfg.ResendFrom)
	} else {
		log.Printf("RESEND_API_KEY not set — invitation emails disabled (admin still gets the link)")
	}

	userStore := auth.NewStore(pool)
	tokenStore := auth.NewTokenStore(pool)
	// P1-02: wire category seeder into org creation so every new org gets a
	// sensible default category (and, for business orgs, account) tree.
	orgStore := org.NewStore(pool).WithCategorySeeder(classify.SeedDefaultCategories)
	inviteStore := invite.NewStore(pool)
	docStore := document.NewStore(pool)

	// FX rate scheduler — only starts when FX_SYNC_ENABLED=true.
	// This env var must be set on EXACTLY ONE fleet member so the ≤24 calls/day
	// cap is respected across the whole fleet. A missing API key disables the
	// scheduler gracefully (logs a warning; does not crash).
	if cfg.FXSyncEnabled {
		fxClient := fx.NewClient(cfg.ExchangeRateAPIKey)
		fxStore := fx.NewStore(pool)
		fxScheduler := fx.NewScheduler(fxClient, fxStore, cfg.ExchangeRateBase)
		go fxScheduler.Run(ctx)
	} else {
		log.Printf("fx: scheduler disabled (FX_SYNC_ENABLED != true)")
	}

	// P1-04: Cross-tenant merchant signal aggregation scheduler.
	// Only starts when SIGNALS_AGG_ENABLED=true. Set that env var on EXACTLY ONE
	// fleet member so the aggregation job runs on a single node (leader guard).
	if cfg.SignalsAggEnabled {
		signalsStore := classify.NewStore(pool)
		signalsScheduler := classify.NewScheduler(signalsStore, cfg.SignalsMinOrgs, 0)
		go signalsScheduler.Run(ctx)
	} else {
		log.Printf("classify: signal aggregation disabled (SIGNALS_AGG_ENABLED != true)")
	}

	authH := auth.NewHandler(auth.HandlerConfig{
		Users:           userStore,
		Tokens:          tokenStore,
		Signer:          signer,
		Orgs:            orgStore,
		Mailer:          mailer,
		FrontendBaseURL: cfg.FrontendBaseURL,
		RxDomain:        os.Getenv("RX_DOMAIN"),
	})
	orgH := org.NewHandler(orgStore)
	inviteH := invite.NewHandler(inviteStore, userStore, orgStore, cfg.InvitationTTL, cfg.FrontendBaseURL, mailer)
	docH := document.NewHandler(docStore, storageClient, ocrClient)
	insightsH := insights.NewHandler(pool, insights.NewTranslator(ocrClient))

	// P1-01: extraction hardening — typed structured extraction pipeline.
	extractStore := extract.NewStore(pool)
	extractSvc := extract.NewService(extractStore, ocrClient, storageClient)
	extractH := extract.NewHandler(extractSvc)
	// P1-02: classification engine
	classifyEngine := classify.New(pool, ocrClient)
	classifyH := classify.NewHandler(pool, classifyEngine)
	// P1-03: correction-learning loop
	// PromotionThreshold defaults to 2; override via CLASSIFY_PROMOTION_THRESHOLD.
	correctionsH := classify.NewCorrectionsHandler(classify.NewCorrectionsStore(pool, classify.CorrectionsConfig{
		PromotionThreshold: cfg.ClassifyPromotionThreshold,
	}))
	// P2-03: business ledger, chart of accounts, manual journals.
	ledgerH := ledger.NewHandler(ledger.NewStore(pool))
	// P2-04: reporting by org kind.
	reportH := reporting.NewHandler(pool)

	mux := http.NewServeMux()

	// Public routes.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.PingContext(r.Context()); err != nil {
			http.Error(w, "db unhealthy", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /auth/register", authH.Register)
	mux.HandleFunc("POST /auth/login", authH.Login)
	mux.HandleFunc("POST /auth/refresh", authH.Refresh)
	mux.HandleFunc("POST /auth/verify", authH.VerifyEmail)
	mux.HandleFunc("GET /auth/verify", authH.VerifyEmail)
	mux.HandleFunc("POST /auth/verify/resend", authH.ResendVerify)
	mux.HandleFunc("POST /auth/password-reset/request", authH.RequestPasswordReset)
	mux.HandleFunc("POST /auth/password-reset/confirm", authH.ConfirmPasswordReset)

	// Authenticated routes.
	authed := func(h http.HandlerFunc) http.Handler {
		return signer.Middleware(h)
	}
	authedAdmin := func(h http.HandlerFunc) http.Handler {
		return signer.Middleware(org.RequireAdmin(orgStore)(h))
	}
	authedMember := func(h http.HandlerFunc) http.Handler {
		return signer.Middleware(org.RequireMember(orgStore)(h))
	}

	mux.Handle("GET /auth/me", authed(authH.Me))

	mux.Handle("POST /orgs", authed(orgH.Create))
	mux.Handle("GET /orgs", authed(orgH.ListMine))
	mux.Handle("GET /orgs/{orgID}/members", authed(orgH.ListMembers))

	mux.Handle("POST /orgs/{orgID}/invitations", authedAdmin(inviteH.Create))
	mux.Handle("GET /orgs/{orgID}/invitations", authedAdmin(inviteH.ListPending))
	mux.Handle("POST /orgs/{orgID}/invitations/{inviteID}/resend", authedAdmin(inviteH.Resend))
	mux.Handle("DELETE /orgs/{orgID}/invitations/{inviteID}", authedAdmin(inviteH.Revoke))

	mux.Handle("POST /invitations/accept", authed(inviteH.Accept))

	mux.Handle("POST /orgs/{orgID}/documents", authedMember(docH.Upload))
	mux.Handle("GET /orgs/{orgID}/documents", authedMember(docH.List))
	mux.Handle("POST /orgs/{orgID}/ask", authedMember(insightsH.Ask))
	mux.Handle("GET /orgs/{orgID}/documents/{docID}", authedMember(docH.Get))

	// P1-01: re-run extraction on an existing document.
	mux.Handle("POST /orgs/{orgID}/documents/{docID}/extract", authedMember(extractH.TriggerExtract))
	// P1-02: classification engine routes
	mux.Handle("POST /orgs/{orgID}/documents/{docID}/classify", authedMember(classifyH.Classify))
	mux.Handle("GET /orgs/{orgID}/transactions", authedMember(classifyH.ListTransactions))
	mux.Handle("GET /orgs/{orgID}/categories", authedMember(classifyH.ListCategories))
	// P1-03: correction-learning loop
	// PATCH /orgs/{orgID}/transactions/{txID}/classification
	// ?apply_to_existing=true  →  also reclassifies past non-user transactions
	mux.Handle("PATCH /orgs/{orgID}/transactions/{txID}/classification",
		authedMember(correctionsH.PatchClassification))

	// P2-03: business ledger, chart of accounts, manual journals, contacts
	// Chart of accounts
	mux.Handle("GET /orgs/{orgID}/accounts",
		authedMember(ledgerH.ListAccounts))
	mux.Handle("POST /orgs/{orgID}/accounts",
		authedMember(ledgerH.CreateAccount))
	mux.Handle("GET /orgs/{orgID}/accounts/{accountID}",
		authedMember(ledgerH.GetAccount))
	mux.Handle("PATCH /orgs/{orgID}/accounts/{accountID}",
		authedMember(ledgerH.UpdateAccount))
	mux.Handle("DELETE /orgs/{orgID}/accounts/{accountID}",
		authedMember(ledgerH.DeleteAccount))
	// Account ledger drill-down
	mux.Handle("GET /orgs/{orgID}/accounts/{accountID}/ledger",
		authedMember(ledgerH.AccountLedger))
	// Trial balance
	mux.Handle("GET /orgs/{orgID}/trial-balance",
		authedMember(ledgerH.TrialBalance))
	// Transaction posting (double-entry)
	mux.Handle("POST /orgs/{orgID}/transactions/{txID}/post",
		authedMember(ledgerH.PostTransaction))
	// Manual journals
	mux.Handle("GET /orgs/{orgID}/journals",
		authedMember(ledgerH.ListJournals))
	mux.Handle("POST /orgs/{orgID}/journals",
		authedMember(ledgerH.CreateJournal))
	mux.Handle("GET /orgs/{orgID}/journals/{journalID}",
		authedMember(ledgerH.GetJournal))
	mux.Handle("DELETE /orgs/{orgID}/journals/{journalID}",
		authedMember(ledgerH.DeleteJournal))
	// Contacts
	mux.Handle("GET /orgs/{orgID}/contacts",
		authedMember(ledgerH.ListContacts))
	mux.Handle("POST /orgs/{orgID}/contacts",
		authedMember(ledgerH.CreateContact))
	mux.Handle("GET /orgs/{orgID}/contacts/{contactID}",
		authedMember(ledgerH.GetContact))
	mux.Handle("PATCH /orgs/{orgID}/contacts/{contactID}",
		authedMember(ledgerH.UpdateContact))
	mux.Handle("DELETE /orgs/{orgID}/contacts/{contactID}",
		authedMember(ledgerH.DeleteContact))

	// P2-04: reporting by org kind
	// GET /orgs/{orgID}/reports/{name}?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]
	// Business: profit-and-loss, balance-sheet, vat-summary
	// Personal: cash-flow, spending-trend, net-worth
	mux.Handle("GET /orgs/{orgID}/reports/{name}",
		authedMember(reportH.Get))

	corsOrigins := os.Getenv("CORS_ALLOWED_ORIGINS")
	if corsOrigins == "" {
		corsOrigins = "*"
	}
	root := httpx.Chain(mux,
		httpx.RequestLogger,
		httpx.SecurityHeaders,
		httpx.CORS(corsOrigins),
	)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           root,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	go func() {
		log.Printf("listening on :%s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

// envFilesForAppEnv returns the dotenv files to load, in priority order. Earlier
// files win because LoadDotenv only sets keys that are not already in the
// environment. The base .env is always loaded last as a fallback for keys not
// overridden by the env-specific file.
func envFilesForAppEnv(appEnv string) []string {
	switch appEnv {
	case "main":
		return []string{".env.main", ".env"}
	case "dev":
		return []string{".env.dev", ".env"}
	default:
		return []string{".env"}
	}
}
