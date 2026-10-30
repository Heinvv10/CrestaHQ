package wa

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// Fake is the test transport, and it lives in a _test.go file so it does not
// compile into the shipped binary. Only same-package tests use it; if another
// package ever needs it, export a real fixture rather than moving this back.
//
// MaxConcurrent is the assertion that matters: it proves the queue actually
// serialises.
type Fake struct {
	mu            sync.Mutex
	sent          []string
	inFlight      int
	maxConcurrent int
	BlockForever  bool
	// lastMedia is what the queue handed down on the most recent call. Nil for
	// a text send, which is the assertion that an attachment survives the hop
	// rather than being quietly dropped somewhere in the pacing code.
	lastMedia *rails.Media
}

func NewFake() *Fake { return &Fake{} }

func (f *Fake) Send(ctx context.Context, jid, text string, media *rails.Media) (string, error) {
	f.mu.Lock()
	f.lastMedia = media
	f.inFlight++
	if f.inFlight > f.maxConcurrent {
		f.maxConcurrent = f.inFlight
	}
	f.mu.Unlock()

	defer func() {
		f.mu.Lock()
		f.inFlight--
		f.mu.Unlock()
	}()

	if f.BlockForever {
		<-ctx.Done()
		return "", ctx.Err()
	}
	time.Sleep(time.Millisecond)

	f.mu.Lock()
	id := fmt.Sprintf("fake-%d", len(f.sent))
	f.sent = append(f.sent, jid)
	f.mu.Unlock()
	return id, nil
}

func (f *Fake) Connected() bool { return !f.BlockForever }

func (f *Fake) LastMedia() *rails.Media {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastMedia
}

func (f *Fake) Sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.sent))
	copy(out, f.sent)
	return out
}

func (f *Fake) MaxConcurrent() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.maxConcurrent
}
