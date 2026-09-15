package api

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// These run against the REAL SQLite store, not the in-memory fake.
//
// Both bugs below were invisible to the fake: it kept nanosecond timestamps
// while SQLite writes at.Unix() and reads it back floored, so the boundary the
// tests appeared to cover was not the boundary that shipped.
func realStoreFanout(t *testing.T, connectedAt time.Time) (*Fanout, *store.SQLite, func() int) {
	t.Helper()
	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	// Atomic: the handler runs on one goroutine per connection, and the
	// fanout posts deliveries concurrently.
	var n atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		n.Add(1)
	}))
	t.Cleanup(srv.Close)

	f := NewFanout([]config.Consumer{{Name: "app", Token: "t", WebhookURL: srv.URL}},
		"", st, func() bool { return true }, func() time.Time { return connectedAt })
	return f, st, func() int { return int(n.Load()) }
}

// Inbound timestamps come from WhatsApp; outbound ones come from this host's
// wall clock. A watermark built from both means a host clock running 30s fast
// pushes it past messages that really did arrive — and drops them for good.
func TestWatermarkIgnoresOutboundHostClock(t *testing.T) {
	base := time.Now().Add(-10 * time.Minute)
	f, st, count := realStoreFanout(t, time.Now())

	if err := st.RecordOutbound("27820000000@s.whatsapp.net", "app", "m1", base.Add(30*time.Second)); err != nil {
		t.Fatal(err)
	}
	f.Deliver("27821234567@s.whatsapp.net", "arrived while we were down", "wamid.A", base.Add(10*time.Second), nil)
	f.Wait()

	if got := count(); got != 1 {
		t.Fatalf("an outbound row stamped by a fast host clock must not shadow a real inbound (forwarded=%d, want 1)", got)
	}
}

// at_unix is whole seconds, so a message in the same second as the newest
// recorded one is ordinary traffic. Treating equality as history drops it
// permanently; admitting it at worst re-delivers one message the consumer
// merges on its id.
func TestWatermarkAdmitsTheSameSecond(t *testing.T) {
	at := time.Now().Add(-5 * time.Minute).Truncate(time.Second)
	f, st, count := realStoreFanout(t, time.Now())

	if err := st.RecordInbound("27820000000@s.whatsapp.net", at); err != nil {
		t.Fatal(err)
	}
	f.Deliver("27821234567@s.whatsapp.net", "same second", "wamid.S", at, nil)
	f.Wait()

	if got := count(); got != 1 {
		t.Fatalf("a message in the watermark's own second must be forwarded (forwarded=%d, want 1)", got)
	}
}

// Strictly older is still history.
func TestWatermarkStillSuppressesAnOlderSecond(t *testing.T) {
	at := time.Now().Add(-5 * time.Minute).Truncate(time.Second)
	f, st, count := realStoreFanout(t, time.Now())

	if err := st.RecordInbound("27820000000@s.whatsapp.net", at); err != nil {
		t.Fatal(err)
	}
	f.Deliver("27821234567@s.whatsapp.net", "a second earlier", "wamid.O", at.Add(-time.Second), nil)
	f.Wait()

	if got := count(); got != 0 {
		t.Fatalf("history must stay suppressed (forwarded=%d, want 0)", got)
	}
}

// failingWatermarkStore answers every watermark read with an error and is
// otherwise a working memory store.
type failingWatermarkStore struct {
	*store.Memory
}

func (failingWatermarkStore) LastInboundAt() (time.Time, error) {
	return time.Time{}, errors.New("watermark unreadable")
}

// The comment on refreshWatermark spends six lines justifying which way this
// fails, and nothing exercised it: mutating the zero time to a future one —
// total blindness, every message treated as history — passed the whole suite.
//
// An unreadable watermark must ADMIT the backlog. A duplicate merges at the
// consumer; a drop is permanent and there is no body to replay from.
func TestUnreadableWatermarkAdmitsRatherThanMutes(t *testing.T) {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		n++
	}))
	defer srv.Close()

	st := failingWatermarkStore{store.NewMemory()}
	connectedAt := time.Now()
	f := NewFanout([]config.Consumer{{Name: "app", Token: "t", WebhookURL: srv.URL}},
		"", st, func() bool { return true }, func() time.Time { return connectedAt })

	// Deliberately OLD: with no readable watermark there is nothing to judge it
	// against, and silence is the one outcome that cannot be undone.
	f.Deliver("27821234567@s.whatsapp.net", "cannot be judged", "wamid.E", time.Now().Add(-48*time.Hour), nil)
	f.Wait()

	if n != 1 {
		t.Fatalf("an unreadable watermark must admit rather than mute (forwarded=%d, want 1)", n)
	}
}

// The catch-up budget must only be spent on messages that could actually be
// forwarded. With OWNER_JID set, non-owner traffic used to charge the cap
// before fromOwner ran, so a burst of it exhausted the budget and the owner's
// genuinely new message — the one message that mattered — was the one dropped.
//
// This is the repair whose justification is permanent message loss, and it was
// the one repair of four with no test: reverting the ordering left all seven
// packages green.
func TestNonOwnerTrafficDoesNotSpendTheCatchUpBudget(t *testing.T) {
	const owner = "27821111111@s.whatsapp.net"
	at := time.Now().Add(-time.Minute)

	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, string(b))
		mu.Unlock()
	}))
	defer srv.Close()

	connectedAt := time.Now()
	f := NewFanout([]config.Consumer{{Name: "app", Token: "t", WebhookURL: srv.URL}},
		owner, st, func() bool { return true }, func() time.Time { return connectedAt })

	// A burst from strangers, more than the whole budget.
	for i := 0; i < maxCatchUpForward+50; i++ {
		f.Deliver("27829999999@s.whatsapp.net", "not the owner", "wamid.N", at, nil)
	}
	// Then the one message that must get through.
	f.Deliver(owner, "the owner's real message", "wamid.OWNER", at, nil)
	f.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 {
		t.Fatalf("exactly the owner's message should be forwarded, got %d deliveries", len(seen))
	}
	if !strings.Contains(seen[0], "wamid.OWNER") {
		t.Fatalf("the forwarded message is not the owner's: %s", seen[0])
	}
}

// The age must come from a real drop, not from a test double. This drives the
// actual cap and then asks the Fanout how long ago it dropped something.
func TestInboundDropAgeReflectsARealDrop(t *testing.T) {
	f, _, _ := realStoreFanout(t, time.Now())

	if _, ok := f.InboundDropAge(); ok {
		t.Fatal("a connection that has dropped nothing must report no drop")
	}

	at := time.Now()
	for i := 0; i < maxCatchUpForward+1; i++ {
		f.Deliver("27821234567@s.whatsapp.net", "burst", "wamid.B", at, nil)
	}
	f.Wait()

	age, ok := f.InboundDropAge()
	if !ok {
		t.Fatal("after the cap dropped a message the age must be reported")
	}
	if age < 0 || age > time.Minute {
		t.Fatalf("age should be freshly measured, got %v", age)
	}
	if _, capped := f.SuppressedInbound(); capped != 1 {
		t.Fatalf("expected exactly one drop, got %d", capped)
	}
}
