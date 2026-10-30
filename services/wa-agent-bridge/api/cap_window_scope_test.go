package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// The catch-up cap is scoped to the REPLAY WINDOW, not to the connection.
//
// Every other test here passes `func() bool { return true }` for the window
// predicate, which is convenient and is not production: the real one is
// `time.Since(connectedAt) < 5*time.Minute` (wa.Client.InReplayWindow). Read
// through the constant-true lens, `catchUp` looks like it latches a connection
// into dropping everything forever, because it is only reset per connection —
// a blind reviewer reached exactly that conclusion on 2026-09-06 and filed it
// as a HIGH.
//
// It does not latch, and this test is here so nobody has to re-derive that.
// It also underwrites the health design: droppedInbound really is a record of
// a past loss rather than a live one, which is why a recency window is the
// right thing to alert on.
func TestCatchUpCapIsScopedToTheReplayWindowNotTheConnection(t *testing.T) {
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
	defer srv.Close()

	connectedAt := time.Now()
	now := connectedAt
	f := NewFanout([]config.Consumer{{Name: "app", Token: "t", WebhookURL: srv.URL}},
		"", st,
		func() bool { return now.Sub(connectedAt) < 5*time.Minute }, // the real rule
		func() time.Time { return connectedAt }, 0)

	for i := 0; i < maxCatchUpForward+10; i++ {
		f.Deliver("27821234567@s.whatsapp.net", "burst", "wamid.B", now, nil, nil)
	}
	f.Wait()
	inWindow := n.Load()
	_, capped := f.SuppressedInbound()

	// Now step past the window on the SAME connection.
	now = connectedAt.Add(10 * time.Minute)
	f.Deliver("27821234567@s.whatsapp.net", "an hour later", "wamid.LATER", now, nil, nil)
	f.Wait()

	t.Logf("during window: forwarded=%d capped=%d", inWindow, capped)
	t.Logf("after window : forwarded total=%d", n.Load())
	if n.Load() != inWindow+1 {
		t.Fatalf("LATCHED: a message after the window was not forwarded (total %d, want %d)", n.Load(), inWindow+1)
	}
}
