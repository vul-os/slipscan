package fx

import (
	"context"
	"log"
	"math/rand"
	"time"
)

// Scheduler runs an hourly FX sync, capped at ≤24 calls/day.
//
// Single-runner guard
// -------------------
// Across multiple container instances a naive ticker would fire 24×N times
// per day, exhausting free-tier quotas. We prevent this with an
// environment-controlled "leader" flag: only the instance where
// FX_SYNC_ENABLED=true runs the scheduler. Set that variable on exactly one
// instance; the others leave it unset (defaulting to false).
// This is the simplest, zero-dependency approach at this scale — no
// Redis, no DB advisory lock needed. If the leader goes down, the next sync
// fires on the next restart (acceptable: stale FX by <1 day on a
// 24-h ticker).
//
// Jitter
// ------
// A random ±30 s jitter is added to each tick to prevent the thundering-herd
// pattern if multiple envs ever do run a sync (e.g. staging + prod sharing the
// same free key).
type Scheduler struct {
	client *Client
	store  *Store
	base   string
	source string
}

// NewScheduler constructs a Scheduler.
func NewScheduler(client *Client, store *Store, base string) *Scheduler {
	src := "frankfurter.app"
	if client.apiKey != "" {
		src = "exchangerate-api.com"
	}
	return &Scheduler{client: client, store: store, base: base, source: src}
}

// Run starts the hourly ticker and blocks until ctx is cancelled.
// It performs an immediate fetch on startup (backfill on first run), then
// ticks every ~1 h. The function returns when ctx is done.
func (s *Scheduler) Run(ctx context.Context) {
	log.Printf("fx: scheduler started (base=%s source=%s)", s.base, s.source)

	// Startup fetch — populates fx_rates immediately on boot.
	s.sync(ctx)

	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("fx: scheduler stopped")
			return
		case <-ticker.C:
			// Small jitter: sleep 0–60 s before fetching.
			jitter := time.Duration(rand.Int63n(60)) * time.Second //nolint:gosec
			select {
			case <-ctx.Done():
				return
			case <-time.After(jitter):
			}
			s.sync(ctx)
		}
	}
}

func (s *Scheduler) sync(ctx context.Context) {
	result, err := s.client.Fetch(ctx, s.base)
	if err != nil {
		log.Printf("fx: fetch error: %v", err)
		return
	}
	if err := s.store.Upsert(ctx, result, s.source); err != nil {
		log.Printf("fx: upsert error: %v", err)
		return
	}
	log.Printf("fx: synced %d rates (base=%s as_of=%s)",
		len(result.Rates), result.Base, result.AsOf.Format("2006-01-02"))
}
