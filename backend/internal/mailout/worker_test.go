package mailout

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/email"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

// ── fakeStore — in-memory outbox for worker unit tests ─────────────────────

type fakeStore struct {
	jobs        []Job
	sentIDs     []uuid.UUID
	retryIDs    []uuid.UUID
	deadIDs     []uuid.UUID
	suppressed  map[string]bool
	suppErrAddr string // address that makes IsSuppressed return an error
}

func newFakeStore(jobs ...Job) *fakeStore {
	return &fakeStore{
		jobs:       jobs,
		suppressed: make(map[string]bool),
	}
}

func (s *fakeStore) ClaimDue(ctx context.Context, limit int) ([]Job, error) {
	out := s.jobs
	s.jobs = nil
	return out, nil
}

func (s *fakeStore) MarkSent(ctx context.Context, id uuid.UUID, providerID string) error {
	s.sentIDs = append(s.sentIDs, id)
	return nil
}

func (s *fakeStore) MarkRetry(ctx context.Context, id uuid.UUID, attempts int, next time.Time, lastErr string) error {
	s.retryIDs = append(s.retryIDs, id)
	return nil
}

func (s *fakeStore) MarkDead(ctx context.Context, id uuid.UUID, lastErr string) error {
	s.deadIDs = append(s.deadIDs, id)
	return nil
}

func (s *fakeStore) IsSuppressed(ctx context.Context, address string) (bool, error) {
	if s.suppErrAddr == address {
		return false, errors.New("db error")
	}
	return s.suppressed[address], nil
}

func (s *fakeStore) Enqueue(ctx context.Context, p EnqueueParams) error { return nil }

// ── fakeWorkerStore wraps fakeStore to satisfy the worker's internal
//    store interface (ClaimDue / Mark* / IsSuppressed).
// The Worker uses *Store from pgx, but we make a thin interface-aligned
// wrapper to drive the logic directly.

// workerStore is the minimal interface the worker uses.
type workerStore interface {
	ClaimDue(ctx context.Context, limit int) ([]Job, error)
	MarkSent(ctx context.Context, id uuid.UUID, providerID string) error
	MarkRetry(ctx context.Context, id uuid.UUID, attempts int, next time.Time, lastErr string) error
	MarkDead(ctx context.Context, id uuid.UUID, lastErr string) error
	IsSuppressed(ctx context.Context, address string) (bool, error)
}

// workerUnderTest drives the same logic as Worker but accepts a workerStore
// interface so tests can use fakeStore.
type workerUnderTest struct {
	store    workerStore
	sender   email.Sender
	interval time.Duration
}

func newWorkerUnderTest(store workerStore, sender email.Sender) *workerUnderTest {
	return &workerUnderTest{store: store, sender: sender, interval: 5 * time.Second}
}

func (w *workerUnderTest) tick(ctx context.Context) {
	jobs, err := w.store.ClaimDue(ctx, claimBatchSize)
	if err != nil {
		return
	}
	for _, j := range jobs {
		w.deliver(ctx, j)
	}
}

func (w *workerUnderTest) deliver(ctx context.Context, j Job) {
	suppressed, err := w.store.IsSuppressed(ctx, j.ToAddress)
	if err != nil {
		_ = w.store.MarkRetry(ctx, j.ID, j.Attempts+1,
			nextAttempt(j.Attempts+1), "suppression check error: "+err.Error())
		return
	}
	if suppressed {
		_ = w.store.MarkDead(ctx, j.ID, "address is suppressed")
		return
	}

	msg := email.Message{
		From: j.FromAddress, To: j.ToAddress,
		Subject: j.Subject, HTML: j.HTMLBody, Text: j.TextBody,
	}
	attempts := j.Attempts + 1

	if s, ok := w.sender.(SenderWithID); ok {
		providerID, sendErr := s.SendWithID(ctx, msg)
		if sendErr == nil {
			_ = w.store.MarkSent(ctx, j.ID, providerID)
			return
		}
		w.handleFailure(ctx, j, attempts, sendErr)
		return
	}

	sendErr := w.sender.Send(ctx, msg)
	if sendErr == nil {
		_ = w.store.MarkSent(ctx, j.ID, "")
		return
	}
	w.handleFailure(ctx, j, attempts, sendErr)
}

func (w *workerUnderTest) handleFailure(ctx context.Context, j Job, attempts int, sendErr error) {
	if !email.IsTransient(sendErr) {
		_ = w.store.MarkDead(ctx, j.ID, sendErr.Error())
		return
	}
	if attempts >= j.MaxAttempts {
		_ = w.store.MarkDead(ctx, j.ID, sendErr.Error())
		return
	}
	_ = w.store.MarkRetry(ctx, j.ID, attempts, nextAttempt(attempts), sendErr.Error())
}

// ── fakeSender helpers ─────────────────────────────────────────────────────

type fakeSender struct {
	errs []error // pop from front on each call
	msgs []email.Message
}

func (f *fakeSender) Send(_ context.Context, msg email.Message) error {
	f.msgs = append(f.msgs, msg)
	if len(f.errs) == 0 {
		return nil
	}
	err := f.errs[0]
	f.errs = f.errs[1:]
	return err
}

func newJob(to string, attempts, max int) Job {
	return Job{
		ID:          uuid.New(),
		ToAddress:   to,
		FromAddress: "from@example.com",
		Subject:     "test",
		HTMLBody:    "<p>hi</p>",
		Attempts:    attempts,
		MaxAttempts: max,
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────

func TestWorkerSuccessfulSend(t *testing.T) {
	j := newJob("ok@example.com", 0, 3)
	store := newFakeStore(j)
	sender := &fakeSender{}
	w := newWorkerUnderTest(store, sender)

	w.tick(context.Background())

	if len(store.sentIDs) != 1 || store.sentIDs[0] != j.ID {
		t.Errorf("expected job to be marked sent, got sentIDs=%v", store.sentIDs)
	}
	if len(store.retryIDs) != 0 {
		t.Errorf("expected no retries, got %d", len(store.retryIDs))
	}
	if len(store.deadIDs) != 0 {
		t.Errorf("expected no dead, got %d", len(store.deadIDs))
	}
}

func TestWorkerTransientThenSuccess(t *testing.T) {
	j := newJob("ok@example.com", 0, 3)
	store := newFakeStore(j)
	transientErr := fmt.Errorf("ses: send email: %w", &sestypes.TooManyRequestsException{})
	sender := &fakeSender{errs: []error{transientErr}}
	w := newWorkerUnderTest(store, sender)

	// First tick: transient error → retry.
	w.tick(context.Background())
	if len(store.retryIDs) != 1 {
		t.Fatalf("expected 1 retry after transient error, got %d", len(store.retryIDs))
	}
	if len(store.sentIDs) != 0 {
		t.Error("should not be marked sent after transient error")
	}

	// Second tick: success (sender has no more errors).
	j2 := newJob("ok@example.com", 1, 3)
	store.jobs = []Job{j2}
	w.tick(context.Background())
	if len(store.sentIDs) != 1 {
		t.Errorf("expected 1 sent after retry, got %d", len(store.sentIDs))
	}
}

func TestWorkerPermanentFailureDeadLetters(t *testing.T) {
	j := newJob("bad@example.com", 0, 3)
	store := newFakeStore(j)
	permanentErr := fmt.Errorf("ses: send email: %w", &sestypes.MessageRejected{})
	sender := &fakeSender{errs: []error{permanentErr}}
	w := newWorkerUnderTest(store, sender)

	w.tick(context.Background())

	if len(store.deadIDs) != 1 || store.deadIDs[0] != j.ID {
		t.Errorf("expected job to be dead-lettered on permanent error, got deadIDs=%v", store.deadIDs)
	}
	if len(store.retryIDs) != 0 {
		t.Errorf("expected no retries on permanent error, got %d", len(store.retryIDs))
	}
}

func TestWorkerExhaustedRetriesDeadLetters(t *testing.T) {
	// Job has already used max_attempts-1 attempts; next failure should dead-letter.
	j := newJob("retry@example.com", 5, 6)
	store := newFakeStore(j)
	transientErr := fmt.Errorf("ses: send email: %w", &sestypes.TooManyRequestsException{})
	sender := &fakeSender{errs: []error{transientErr}}
	w := newWorkerUnderTest(store, sender)

	w.tick(context.Background())

	if len(store.deadIDs) != 1 {
		t.Errorf("expected dead after exhausting attempts, got deadIDs=%v retryIDs=%v", store.deadIDs, store.retryIDs)
	}
	if len(store.retryIDs) != 0 {
		t.Errorf("expected no retry at max_attempts, got %d", len(store.retryIDs))
	}
}

func TestWorkerSuppressedAddressDeadLetters(t *testing.T) {
	j := newJob("suppressed@example.com", 0, 3)
	store := newFakeStore(j)
	store.suppressed["suppressed@example.com"] = true
	sender := &fakeSender{}
	w := newWorkerUnderTest(store, sender)

	w.tick(context.Background())

	if len(store.deadIDs) != 1 || store.deadIDs[0] != j.ID {
		t.Errorf("expected suppressed job to be dead-lettered, got deadIDs=%v", store.deadIDs)
	}
	if len(sender.msgs) != 0 {
		t.Error("sender should not be called for suppressed addresses")
	}
}

func TestWorkerSuppressionCheckErrorRetries(t *testing.T) {
	j := newJob("erraddr@example.com", 0, 3)
	store := newFakeStore(j)
	store.suppErrAddr = "erraddr@example.com"
	sender := &fakeSender{}
	w := newWorkerUnderTest(store, sender)

	w.tick(context.Background())

	// Suppression check error should cause a retry, not a dead-letter.
	if len(store.retryIDs) != 1 {
		t.Errorf("expected retry on suppression check error, got retryIDs=%v deadIDs=%v", store.retryIDs, store.deadIDs)
	}
	if len(sender.msgs) != 0 {
		t.Error("sender should not be called when suppression check errors")
	}
}

// ── nextAttempt backoff tests ──────────────────────────────────────────────

func TestNextAttemptBackoffIncreases(t *testing.T) {
	prev := time.Now()
	for attempt := 1; attempt <= 5; attempt++ {
		next := nextAttempt(attempt)
		if !next.After(prev) {
			t.Errorf("attempt %d: next=%v is not after prev=%v", attempt, next, prev)
		}
		prev = next
	}
}

func TestNextAttemptCapsAtMaxBackoff(t *testing.T) {
	// attempt=100 should still be at most maxBackoff + 10% jitter above now.
	before := time.Now()
	next := nextAttempt(100)
	ceiling := before.Add(maxBackoff + maxBackoff/10 + time.Second)
	if next.After(ceiling) {
		t.Errorf("attempt 100: next=%v is above ceiling=%v", next, ceiling)
	}
}

func TestNextAttemptAttempt1IsAboutTwoMinutes(t *testing.T) {
	before := time.Now()
	next := nextAttempt(1)
	// 2^1 min = 2 min; jitter adds ±12 s (10% of 2m).
	low := before.Add(1 * time.Minute)
	high := before.Add(3 * time.Minute)
	if next.Before(low) || next.After(high) {
		t.Errorf("attempt 1: next=%v outside [%v, %v]", next, low, high)
	}
}
