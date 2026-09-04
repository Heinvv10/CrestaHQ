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

func TestFanoutSkipsConsumersWithNoWebhook(t *testing.T) {
	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "t"}}, // no WebhookURL
		st,
		func() bool { return false },
	)
	f.Deliver("27821234567@s.whatsapp.net", "hi", time.Now())
	f.Wait() // must not panic or block
}
