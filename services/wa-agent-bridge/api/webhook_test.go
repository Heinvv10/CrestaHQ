package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func TestFanoutRecordsInboundAndPostsToConsumers(t *testing.T) {
	var mu sync.Mutex
	var got []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		st,
		func() bool { return false },
	)

	jid := "27821234567@s.whatsapp.net"
	f.Deliver(jid, "hello", time.Now())
	f.Wait()

	ok, _ := st.HasInboundFrom(jid)
	if !ok {
		t.Fatal("inbound must be recorded — reply-only depends on it")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("want 1 webhook delivery, got %d", len(got))
	}
	if got[0]["from"] != jid {
		t.Fatalf("wrong from: %v", got[0])
	}
}

// During history replay the inbound must still be recorded (so reply-only
// stays accurate) but must NOT wake a consumer, or a reconnect re-answers
// every message from the last day.
func TestFanoutRecordsButDoesNotNotifyDuringReplay(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
	}))
	defer srv.Close()

	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		st,
		func() bool { return true }, // in replay window
	)

	jid := "27821234567@s.whatsapp.net"
	f.Deliver(jid, "hello", time.Now())
	f.Wait()

	ok, _ := st.HasInboundFrom(jid)
	if !ok {
		t.Fatal("replayed inbound must still be recorded")
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 0 {
		t.Fatalf("replayed inbound must not notify consumers, got %d calls", calls)
	}
}

// A nil inReplayWindow must never silently mean "not replaying" — that would
// wake every consumer with a day of replayed history on the next reconnect,
// which is the exact incident the replay window exists to prevent. It must
// fail loudly at construction instead, so a wiring mistake is caught at
// startup, not against a live inbound.
func TestNewFanoutPanicsOnNilInReplayWindow(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on nil inReplayWindow")
		}
	}()
	NewFanout(nil, nil, nil)
}

// countingRoundTripper counts every HTTP request attempted, including one
// built against an empty WebhookURL. This matters: http.NewRequest and
// http.Client.Do both accept an empty URL without erroring at the call site
// that matters here — the request only fails once a real Transport tries to
// dial it, deep enough that a caller who merely logs the error (as post()
// does) would let a "no panic or block" test pass whether or not the
// consumer was actually skipped. Installing a fake Transport intercepts the
// attempt itself, before any dial happens, so the count reflects whether the
// skip guard ran at all, not just whether a socket connection was reachable.
type countingRoundTripper struct {
	mu    sync.Mutex
	calls []string // Authorization header per attempted request
}

func (c *countingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	c.mu.Lock()
	c.calls = append(c.calls, req.Header.Get("Authorization"))
	c.mu.Unlock()
	return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
}

// A consumer with no WebhookURL must be skipped entirely — never attempted.
// Proven with the counting mock above rather than an httptest server pointed
// at "": that would let this test pass even with the skip guard removed,
// because the empty-URL request fails silently past the server before it's
// ever observed. Registering a real webhook alongside the empty one and
// asserting exactly one attempt was made, at the configured consumer, is
// what makes removing the guard (which adds a second attempt) actually turn
// this test red.
func TestFanoutSkipsConsumersWithNoWebhook(t *testing.T) {
	rt := &countingRoundTripper{}

	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{
			{Name: "leadstack", Token: "no-webhook-token"}, // no WebhookURL — must be skipped
			{Name: "hermes", Token: "hermes-token", WebhookURL: "http://example.invalid/hook"},
		},
		st,
		func() bool { return false },
	)
	f.client.Transport = rt // same package: unexported field access is deliberate here
	f.Deliver("27821234567@s.whatsapp.net", "hi", time.Now())
	f.Wait()

	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.calls) != 1 {
		t.Fatalf("want exactly 1 attempted delivery (only the consumer with a webhook), got %d: %v", len(rt.calls), rt.calls)
	}
	if rt.calls[0] != "Bearer hermes-token" {
		t.Fatalf("delivery attempt went to the wrong consumer: %v", rt.calls)
	}
}
