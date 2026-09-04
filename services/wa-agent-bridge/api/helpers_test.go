package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

const (
	knownJID    = "27821234567@s.whatsapp.net"
	strangerJID = "27829999999@s.whatsapp.net"
)

var fixedNow = time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)

// stubSender stands in for the WhatsApp queue. delay widens the window between
// two concurrent sends so a handler that failed to reserve the key would
// actually be caught doing it, rather than passing by luck of scheduling.
type stubSender struct {
	mu    sync.Mutex
	calls int
	err   error
	delay time.Duration
}

func (s *stubSender) Send(_ context.Context, _, _ string) (string, error) {
	s.mu.Lock()
	s.calls++
	n := s.calls
	err, delay := s.err, s.delay
	s.mu.Unlock()

	if delay > 0 {
		time.Sleep(delay)
	}
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("sent-%d", n), nil
}

func (s *stubSender) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func testHandler(t *testing.T) (http.Handler, *store.Memory, *stubSender) {
	t.Helper()
	st := store.NewMemory()
	sender := &stubSender{}
	h := New(Deps{
		Engine: rails.NewEngine(st, rails.Config{
			PerContactPerDay: 10, ConsecutiveMax: 3, GlobalDailyCap: 150,
			Location: time.UTC,
			Budgets: map[string]rails.ConsumerBudget{
				"hermes":    {PerHour: 100, PerDay: 500},
				"leadstack": {PerHour: 100, PerDay: 500},
			},
		}),
		Store:  st,
		Sender: sender,
		Consumers: []config.Consumer{
			{Name: "hermes", Token: "tok-hermes"},
			{Name: "leadstack", Token: "tok-leadstack"},
		},
		Now: func() time.Time { return fixedNow },
	})
	return h, st, sender
}

func post(h http.Handler, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func sendBodyJSON(jid, text, key string) string {
	b, _ := json.Marshal(map[string]string{"to": jid, "text": text, "idempotencyKey": key})
	return string(b)
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON: %q", rec.Body.String())
	}
	return out
}
