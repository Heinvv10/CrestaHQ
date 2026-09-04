package wa

import (
	"context"
	"errors"
	"math/rand"
	"sync"
	"time"
)

var ErrSendTimeout = errors.New("send timed out")

// QueueOpts controls pacing. The delay is length-proportional plus jitter so
// the traffic pattern resembles a person typing rather than a loop emitting.
// This is the one genuine benefit browser automation was supposed to provide,
// obtained here without a browser.
type QueueOpts struct {
	MinGap       time.Duration // floor between consecutive sends
	PerRuneDelay time.Duration // added per rune of the message
	Jitter       time.Duration // uniform random extra, 0 disables
	Timeout      time.Duration // per-send ceiling
}

// Queue serialises every send onto one socket.
//
// Two independent reasons. Concurrent sendMessage calls race inside the
// underlying library, and unpaced bursts are a bot signal. One queue solves
// both, and a timeout means a hung send surfaces as an ambiguous result rather
// than blocking the service forever.
type Queue struct {
	mu       sync.Mutex
	t        Transport
	opts     QueueOpts
	lastSent time.Time
}

func NewQueue(t Transport, opts QueueOpts) *Queue {
	return &Queue{t: t, opts: opts}
}

func (q *Queue) Send(ctx context.Context, jid, text string) (string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if wait := q.waitFor(text); wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}

	timeout := q.opts.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	sendCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	type result struct {
		id  string
		err error
	}
	done := make(chan result, 1)
	go func() {
		id, err := q.t.Send(sendCtx, jid, text)
		done <- result{id, err}
	}()

	select {
	case r := <-done:
		q.lastSent = time.Now()
		return r.id, r.err
	case <-sendCtx.Done():
		q.lastSent = time.Now()
		// Deliberately NOT retried here. A timed-out send may or may not have
		// been delivered; retrying risks messaging the contact twice. The
		// caller reports this as ambiguous.
		return "", ErrSendTimeout
	}
}

func (q *Queue) waitFor(text string) time.Duration {
	delay := q.opts.MinGap
	delay += time.Duration(len([]rune(text))) * q.opts.PerRuneDelay
	if q.opts.Jitter > 0 {
		delay += time.Duration(rand.Int63n(int64(q.opts.Jitter)))
	}
	if q.lastSent.IsZero() {
		return 0
	}
	elapsed := time.Since(q.lastSent)
	if elapsed >= delay {
		return 0
	}
	return delay - elapsed
}
