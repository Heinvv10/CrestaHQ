package wa

import (
	"context"
	"errors"
	"log"
	"math/rand"
	"sync"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/internal/redact"
)

// ErrSendTimeout means the provider was given its full per-send budget and did
// not answer. ErrSendCancelled means WE stopped waiting early because the
// caller's context was cancelled — a shutdown, or a client hanging up.
//
// They are distinct because they say different things about the bridge, but
// they are equally AMBIGUOUS about delivery: in both cases the message may
// already have reached the contact. Callers must treat both the same way —
// never release the idempotency key, never retry blind. Reporting a shutdown
// as a timeout hid a real distinction; reporting it as a plain failure would
// be far worse, because a plain failure releases the key.
var (
	ErrSendTimeout   = errors.New("send timed out")
	ErrSendCancelled = errors.New("send cancelled before it returned")
)

// drainGrace bounds how long Send waits for a timed-out transport call to
// actually return after its context is cancelled, before giving up on it
// (see the comment on the timeout branch of Send for why this wait exists).
const drainGrace = 5 * time.Second

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

		// Cancelling sendCtx only SIGNALS the goroutine; it does not prove
		// q.t.Send has returned. A transport that ignores or is slow to
		// notice cancellation can still be on the socket when we return, and
		// this queue's entire job is that only one send is ever on the
		// socket at a time. So we hold the lock (deferred Unlock hasn't run
		// yet) and wait, bounded, for the goroutine to actually drain before
		// releasing it to the next queued send — otherwise a timeout would
		// be exactly the moment serialisation quietly breaks.
		select {
		case <-done:
			// Drained within grace. Discard the result: deliberately NOT
			// retried here either way. A timed-out send may or may not have
			// been delivered; retrying risks messaging the contact twice.
			// The caller reports this as ambiguous.
		case <-time.After(drainGrace):
			// The transport is genuinely stuck past cancellation. We can no
			// longer guarantee serialisation for the next send, but blocking
			// this queue forever is worse — log loudly (no body) and move on.
			log.Printf("wa: queue: send to %s did not drain within %s of cancellation; transport may still be in flight", redact.JID(jid), drainGrace)
		}
		// Distinguish "the provider never answered" from "we were told to stop".
		// Both are ambiguous about delivery; only one of them is a provider
		// problem, and an operator reading a shutdown log should not be hunting
		// a timeout that never happened.
		if ctx.Err() != nil {
			return "", ErrSendCancelled
		}
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
