package apitokens

import (
	"sync"
	"time"
)

// DefaultRateLimitPerMin is used when a token's rate_limit_per_minute is 0.
const DefaultRateLimitPerMin = 60

// RateLimiter is an in-memory sliding-window rate limiter keyed by token ID
// string.
//
// NOTE: This implementation is per-process.  In a multi-node deployment every
// node has its own counter; effective per-token throughput is up to N times
// limitPerMin where N is the node count.  A production multi-node deployment
// should use a shared Redis counter (INCRBY + EXPIRE Lua script).  The
// in-memory version is sufficient for a single-node deployment and is noted
// in the operator docs (P4-04).
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	count     int
	windowEnd time.Time
}

// NewRateLimiter returns an initialised RateLimiter.
func NewRateLimiter() *RateLimiter {
	return &RateLimiter{buckets: make(map[string]*bucket)}
}

// Allow returns true if the token is under its per-minute limit.
// limitPerMin == 0 falls back to DefaultRateLimitPerMin.
func (rl *RateLimiter) Allow(tokenID string, limitPerMin int) bool {
	if limitPerMin <= 0 {
		limitPerMin = DefaultRateLimitPerMin
	}

	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[tokenID]
	if !ok || now.After(b.windowEnd) {
		// Start a new 1-minute window.
		rl.buckets[tokenID] = &bucket{count: 1, windowEnd: now.Add(time.Minute)}
		return true
	}
	if b.count >= limitPerMin {
		return false
	}
	b.count++
	return true
}
