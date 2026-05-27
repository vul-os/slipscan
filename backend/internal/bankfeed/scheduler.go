package bankfeed

// scheduler.go — leader-guarded periodic poll scheduler for bank-feed sync.
//
// Single-runner guard (same pattern as internal/fx/scheduler.go):
// Across multiple container instances only the one where
// BANKFEED_SYNC_ENABLED=true runs the scheduler.  All other instances leave it
// unset.  This prevents duplicate sync runs without requiring a distributed lock.
//
// Jitter: a random ±60 s delay is applied before each poll cycle to prevent
// thundering-herd if the env var is accidentally set on multiple instances.

import (
	"context"
	"log"
	"math/rand"
	"time"
)

// Scheduler runs a periodic bank-feed poll on a configurable interval.
type Scheduler struct {
	syncer   *Syncer
	interval time.Duration
}

// NewScheduler constructs a Scheduler.  interval is the polling period;
// 4 hours is the recommended default.
func NewScheduler(syncer *Syncer, interval time.Duration) *Scheduler {
	if interval <= 0 {
		interval = 4 * time.Hour
	}
	return &Scheduler{syncer: syncer, interval: interval}
}

// Run starts the scheduler and blocks until ctx is cancelled.
// It performs an immediate sync cycle on startup, then ticks every interval.
func (s *Scheduler) Run(ctx context.Context) {
	log.Printf("bankfeed: scheduler started (interval=%s)", s.interval)

	// Immediate startup sync to populate connections on first run.
	s.poll(ctx)

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("bankfeed: scheduler stopped")
			return
		case <-ticker.C:
			// Small random jitter 0–60 s to prevent thundering herd.
			jitter := time.Duration(rand.Int63n(60)) * time.Second //nolint:gosec
			select {
			case <-ctx.Done():
				return
			case <-time.After(jitter):
			}
			s.poll(ctx)
		}
	}
}

func (s *Scheduler) poll(ctx context.Context) {
	if err := s.syncer.SyncAll(ctx); err != nil {
		log.Printf("bankfeed: poll error: %v", err)
	}
}
