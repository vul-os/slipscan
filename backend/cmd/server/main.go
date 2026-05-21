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
	"github.com/exolutionza/slipscan/backend/internal/config"
	"github.com/exolutionza/slipscan/backend/internal/db"
	"github.com/exolutionza/slipscan/backend/internal/document"
	"github.com/exolutionza/slipscan/backend/internal/email"
	"github.com/exolutionza/slipscan/backend/internal/extract"
	"github.com/exolutionza/slipscan/backend/internal/fx"
	"github.com/exolutionza/slipscan/backend/internal/httpx"
	"github.com/exolutionza/slipscan/backend/internal/insights"
	"github.com/exolutionza/slipscan/backend/internal/invite"
	"github.com/exolutionza/slipscan/backend/internal/ocr"
	"github.com/exolutionza/slipscan/backend/internal/org"
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
	orgStore := org.NewStore(pool)
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
