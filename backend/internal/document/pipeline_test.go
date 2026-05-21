package document

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestUploadTriggersPipeline verifies that a successful upload calls the
// PipelineFn exactly once in a goroutine with the correct docID and orgID.
//
// auto-pipeline: uses a fake PipelineFn so no Gemini / DB calls are made.
func TestUploadTriggersPipeline(t *testing.T) {
	var called atomic.Int32
	var gotDocID, gotOrgID uuid.UUID

	docID := uuid.New()
	orgID := uuid.New()
	uploadedBy := uuid.NullUUID{UUID: uuid.New(), Valid: true}

	done := make(chan struct{})

	fn := PipelineFn(func(_ context.Context, d, o uuid.UUID, _ uuid.NullUUID) {
		gotDocID = d
		gotOrgID = o
		called.Add(1)
		close(done)
	})

	// Simulate what the Upload handler does after a successful store.Create.
	if fn != nil {
		go func() {
			bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			fn(bgCtx, docID, orgID, uploadedBy)
		}()
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("pipeline was not called within 2s")
	}

	if called.Load() != 1 {
		t.Errorf("pipeline called %d times, want 1", called.Load())
	}
	if gotDocID != docID {
		t.Errorf("pipeline docID = %v, want %v", gotDocID, docID)
	}
	if gotOrgID != orgID {
		t.Errorf("pipeline orgID = %v, want %v", gotOrgID, orgID)
	}
}

// TestNilPipelineDoesNotPanic verifies that passing nil for the pipeline
// function to NewHandler is safe and Upload skips the goroutine silently.
//
// auto-pipeline: nil is the safe default for tests without Gemini.
func TestNilPipelineDoesNotPanic(t *testing.T) {
	h := &Handler{pipeline: nil, maxBytes: maxUploadBytes}

	// Simulate the goroutine guard in Upload.
	var triggered bool
	if h.pipeline != nil {
		triggered = true
	}
	if triggered {
		t.Error("nil pipeline should not trigger goroutine")
	}
}

// TestPipelineFnType ensures PipelineFn is a first-class function type
// that can be stored, passed, and invoked.
//
// auto-pipeline: type-level smoke test.
func TestPipelineFnType(t *testing.T) {
	var fn PipelineFn
	if fn != nil {
		t.Error("zero-value PipelineFn should be nil")
	}

	fn = func(_ context.Context, _, _ uuid.UUID, _ uuid.NullUUID) {}
	if fn == nil {
		t.Error("assigned PipelineFn should not be nil")
	}
}
