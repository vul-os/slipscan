package mailout

import (
	"context"
	"log"
	"math"
	"math/rand"
	"time"

	"github.com/exolutionza/slipscan/backend/internal/email"
)

const (
	defaultInterval = 5 * time.Second
	claimBatchSize  = 20
	maxBackoff      = 6 * time.Hour
)

// SenderWithID is an optional interface the Worker will try to use to
// obtain the provider message id after a successful send.  *email.SESClient
// implements this; plain email.Sender implementations do not and the worker
// stores an empty string in that case.
type SenderWithID interface {
	SendWithID(ctx context.Context, msg email.Message) (string, error)
}

// Worker polls email_outbox for due jobs and delivers them via sender.
type Worker struct {
	store    *Store
	sender   email.Sender
	interval time.Duration
}

// NewWorker creates a Worker.  interval controls how often the worker polls
// for due rows; pass 0 to use the default (5 s).
func NewWorker(store *Store, sender email.Sender, interval time.Duration) *Worker {
	if interval <= 0 {
		interval = defaultInterval
	}
	return &Worker{store: store, sender: sender, interval: interval}
}

// Run starts the polling loop and blocks until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) {
	log.Printf("mailout: worker started (interval=%s)", w.interval)

	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("mailout: worker stopped")
			return
		case <-ticker.C:
			w.tick(ctx)
		}
	}
}

func (w *Worker) tick(ctx context.Context) {
	jobs, err := w.store.ClaimDue(ctx, claimBatchSize)
	if err != nil {
		log.Printf("mailout: claim due: %v", err)
		return
	}
	for _, j := range jobs {
		w.deliver(ctx, j)
	}
}

func (w *Worker) deliver(ctx context.Context, j Job) {
	// Suppression check — dead-letter immediately if address is suppressed.
	suppressed, err := w.store.IsSuppressed(ctx, j.ToAddress)
	if err != nil {
		log.Printf("mailout: suppression check id=%s: %v", j.ID, err)
		// Treat as transient — leave in 'sending' state; next claim will retry.
		_ = w.store.MarkRetry(ctx, j.ID, j.Attempts+1,
			nextAttempt(j.Attempts+1), "suppression check error: "+err.Error())
		return
	}
	if suppressed {
		log.Printf("mailout: address suppressed id=%s to=%s", j.ID, j.ToAddress)
		_ = w.store.MarkDead(ctx, j.ID, "address is suppressed")
		return
	}

	msg := email.Message{
		From:    j.FromAddress,
		To:      j.ToAddress,
		Subject: j.Subject,
		HTML:    j.HTMLBody,
		Text:    j.TextBody,
	}

	attempts := j.Attempts + 1

	// If the sender supports returning a provider message id, use that path.
	if s, ok := w.sender.(SenderWithID); ok {
		providerID, sendErr := s.SendWithID(ctx, msg)
		if sendErr == nil {
			if storeErr := w.store.MarkSent(ctx, j.ID, providerID); storeErr != nil {
				log.Printf("mailout: mark sent id=%s: %v", j.ID, storeErr)
			}
			return
		}
		w.handleFailure(ctx, j, attempts, sendErr)
		return
	}

	// Plain Sender path.
	sendErr := w.sender.Send(ctx, msg)
	if sendErr == nil {
		if storeErr := w.store.MarkSent(ctx, j.ID, ""); storeErr != nil {
			log.Printf("mailout: mark sent id=%s: %v", j.ID, storeErr)
		}
		return
	}
	w.handleFailure(ctx, j, attempts, sendErr)
}

func (w *Worker) handleFailure(ctx context.Context, j Job, attempts int, sendErr error) {
	log.Printf("mailout: send error id=%s attempt=%d: %v", j.ID, attempts, sendErr)

	if !email.IsTransient(sendErr) {
		// Permanent failure — dead-letter immediately.
		if storeErr := w.store.MarkDead(ctx, j.ID, sendErr.Error()); storeErr != nil {
			log.Printf("mailout: mark dead id=%s: %v", j.ID, storeErr)
		}
		return
	}

	// Transient failure — schedule retry with exponential backoff, or dead-letter
	// if we've exhausted max_attempts.
	if attempts >= j.MaxAttempts {
		if storeErr := w.store.MarkDead(ctx, j.ID, sendErr.Error()); storeErr != nil {
			log.Printf("mailout: mark dead id=%s: %v", j.ID, storeErr)
		}
		return
	}

	next := nextAttempt(attempts)
	if storeErr := w.store.MarkRetry(ctx, j.ID, attempts, next, sendErr.Error()); storeErr != nil {
		log.Printf("mailout: mark retry id=%s: %v", j.ID, storeErr)
	}
}

// nextAttempt returns the time of the next delivery attempt using exponential
// backoff: min(2^attempts minutes, 6h) plus ±10 % jitter.
func nextAttempt(attempts int) time.Time {
	exp := math.Pow(2, float64(attempts))
	base := time.Duration(exp) * time.Minute
	if base > maxBackoff {
		base = maxBackoff
	}
	// ±10 % jitter to spread retries.
	jitter := time.Duration(rand.Int63n(int64(base/10) + 1)) //nolint:gosec
	return time.Now().Add(base + jitter)
}
