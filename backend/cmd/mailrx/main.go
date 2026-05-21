// cmd/mailrx is the inbound-SMTP receiver for slip/scan.
//
// It listens on MAILRX_ADDR (default :2525) for incoming SMTP connections,
// validates that each recipient is a known org slug, parses MIME attachments,
// stores the raw email + attachment bytes to B2, and inserts inbound_emails +
// documents rows so the extraction pipeline picks them up.
//
// Run locally:
//
//	cd backend && go run ./cmd/mailrx
//
// Or via the Makefile:
//
//	make mailrx
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	gosmtp "github.com/emersion/go-smtp"

	"github.com/exolutionza/slipscan/backend/internal/config"
	"github.com/exolutionza/slipscan/backend/internal/db"
	"github.com/exolutionza/slipscan/backend/internal/mailrx"
	"github.com/exolutionza/slipscan/backend/internal/org"
	"github.com/exolutionza/slipscan/backend/internal/storage"
)

func main() {
	// Load env files using the same pattern as cmd/server.
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

	orgStore := org.NewStore(pool)
	mailStore := mailrx.NewStore(pool)

	be := mailrx.NewBackend(mailrx.Config{
		RxDomain:     cfg.RxDomain,
		MaxBytes:     cfg.MailrxMaxBytes,
		AllowedTypes: cfg.MailrxAllowedTypes,
		Hostname:     cfg.RxDomain,
	}, orgStore, mailStore, storageClient)

	srv := gosmtp.NewServer(be)
	srv.Addr = cfg.MailrxAddr
	srv.Domain = cfg.RxDomain
	srv.MaxMessageBytes = cfg.MailrxMaxBytes
	srv.MaxRecipients = 10
	srv.AllowInsecureAuth = true // no AUTH required for inbound mail
	srv.ReadTimeout = 60 * time.Second
	srv.WriteTimeout = 60 * time.Second

	go func() {
		log.Printf("mailrx listening on %s (domain=%s)", cfg.MailrxAddr, cfg.RxDomain)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, gosmtp.ErrServerClosed) {
			log.Fatalf("mailrx listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("mailrx shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("mailrx shutdown: %v", err)
	}
}

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
