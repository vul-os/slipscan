package mailout

import (
	"context"
	"fmt"

	"github.com/exolutionza/slipscan/backend/internal/email"
)

// Queue satisfies email.Sender by enqueuing messages into the outbox store.
// The background Worker is responsible for the actual delivery.
type Queue struct {
	store *Store
	from  string // default from address
}

// NewQueue returns a Queue backed by store.
// from is used as the default From address when msg.From is empty.
func NewQueue(store *Store, from string) *Queue {
	return &Queue{store: store, from: from}
}

// Send implements email.Sender.  It persists the message as a pending outbox
// row and returns immediately.  Delivery is handled asynchronously by the
// Worker.
func (q *Queue) Send(ctx context.Context, msg email.Message) error {
	from := msg.From
	if from == "" {
		from = q.from
	}
	if from == "" {
		return fmt.Errorf("mailout: queue: missing from address")
	}

	p := EnqueueParams{
		ToAddress:   msg.To,
		FromAddress: from,
		Subject:     msg.Subject,
		HTMLBody:    msg.HTML,
		TextBody:    msg.Text,
		EmailKind:   "transactional",
	}
	if err := q.store.Enqueue(ctx, p); err != nil {
		return fmt.Errorf("mailout: queue send: %w", err)
	}
	return nil
}
