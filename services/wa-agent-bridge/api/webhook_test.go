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
		"", // no owner filter
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
		"", // no owner filter
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
	NewFanout(nil, "", nil, nil)
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
		"", // no owner filter
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

// Phase 1 runs on an unpublished number: the owner is the only sender whose
// messages should reach a consumer. The drop must happen AFTER the record, or
// reply-only later treats a real contact as a stranger.
func TestFanoutDropsNonOwnerButStillRecordsIt(t *testing.T) {
	rt := &countingRoundTripper{}
	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: "http://example.invalid/hook"}},
		"27820000001@s.whatsapp.net",
		st,
		func() bool { return false },
	)
	f.client.Transport = rt

	stranger := "27829999999@s.whatsapp.net"
	f.Deliver(stranger, "hello", time.Now())
	f.Wait()

	if ok, _ := st.HasInboundFrom(stranger); !ok {
		t.Fatal("a dropped non-owner inbound must still be recorded; reply-only reads that history")
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.calls) != 0 {
		t.Fatalf("non-owner inbound must not reach a consumer, got %d deliveries", len(rt.calls))
	}
}

// The other direction: with the filter on, the owner still gets through —
// including from a multi-device sender JID carrying a ":12" device suffix,
// which is what whatsmeow actually reports. An exact string match would drop
// it and the bridge would look dead.
func TestFanoutForwardsOwnerIncludingDeviceSuffix(t *testing.T) {
	for _, sender := range []string{
		"27820000001@s.whatsapp.net",
		"27820000001:12@s.whatsapp.net",
	} {
		rt := &countingRoundTripper{}
		f := NewFanout(
			[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: "http://example.invalid/hook"}},
			"27820000001@s.whatsapp.net",
			store.NewMemory(),
			func() bool { return false },
		)
		f.client.Transport = rt

		f.Deliver(sender, "hello", time.Now())
		f.Wait()

		rt.mu.Lock()
		n := len(rt.calls)
		rt.mu.Unlock()
		if n != 1 {
			t.Fatalf("owner sender %q: want 1 delivery, got %d", sender, n)
		}
	}
}

// An unset OWNER_JID must accept everyone. The opposite default would brick
// every deployment that omits the variable, with nothing in the log to explain
// why consumers went quiet.
func TestFanoutWithNoOwnerConfiguredAcceptsEverySender(t *testing.T) {
	rt := &countingRoundTripper{}
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: "http://example.invalid/hook"}},
		"",
		store.NewMemory(),
		func() bool { return false },
	)
	f.client.Transport = rt

	f.Deliver("27829999999@s.whatsapp.net", "hello", time.Now())
	f.Wait()

	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.calls) != 1 {
		t.Fatalf("with no owner configured every sender is accepted; got %d deliveries", len(rt.calls))
	}
}
