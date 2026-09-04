package api

import (
	"context"
	"encoding/json"
	"errors"
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

// faultyStore injects Store failures the Memory store cannot produce on its
// own. The endpoints that DEGRADE rather than fail — health, and the outbound
// bookkeeping after a delivered message — can only be tested against a store
// that breaks on demand.
type faultyStore struct {
	*store.Memory
	failRecordOutbound bool
	failCountTotal     bool
}

func (f *faultyStore) RecordOutbound(jid, consumer, messageID string, at time.Time) error {
	if f.failRecordOutbound {
		return errors.New("disk is gone")
	}
	return f.Memory.RecordOutbound(jid, consumer, messageID, at)
}

// ReserveOutboundSlot is the write the send path actually depends on now: the
// outbound row is written when the reservation is won, not after the send
// returns. failRecordOutbound breaks both so a test can describe "the store
// cannot record outbound" with one flag.
func (f *faultyStore) ReserveOutboundSlot(storageKey, jid, consumer string, at time.Time) error {
	if f.failRecordOutbound {
		return errors.New("disk is gone")
	}
	return f.Memory.ReserveOutboundSlot(storageKey, jid, consumer, at)
}

func (f *faultyStore) OutboundCountTotal(since time.Time) (int, error) {
	if f.failCountTotal {
		return 0, errors.New("disk is gone")
	}
	return f.Memory.OutboundCountTotal(since)
}

// stubConnection stands in for the WhatsApp client's connection state. It
// defaults to CONNECTED so the existing tests describe a healthy bridge; the
// tests that are about the socket set it false explicitly.
type stubConnection struct {
	mu sync.Mutex
	up bool
}

func (c *stubConnection) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.up
}

func (c *stubConnection) set(up bool) {
	c.mu.Lock()
	c.up = up
	c.mu.Unlock()
}

func testHandler(t *testing.T) (http.Handler, *store.Memory, *stubSender) {
	t.Helper()
	st := store.NewMemory()
	sender := &stubSender{}
	return newHandler(t, st, sender), st, sender
}

func newHandler(t *testing.T, st rails.Store, sender Sender) http.Handler {
	t.Helper()
	return newHandlerWithConnection(t, st, sender, &stubConnection{up: true})
}

func newHandlerWithConnection(t *testing.T, st rails.Store, sender Sender, conn ConnectionState) http.Handler {
	t.Helper()
	return New(Deps{
		Engine: rails.NewEngine(st, rails.Config{
			PerContactPerDay: 10, ConsecutiveMax: 3, GlobalDailyCap: 150,
			Location: time.UTC,
			Budgets: map[string]rails.ConsumerBudget{
				"hermes":    {PerHour: 100, PerDay: 500},
				"leadstack": {PerHour: 100, PerDay: 500},
				"operator":  {PerHour: 100, PerDay: 500},
			},
		}),
		Store:  st,
		Sender: sender,
		Consumers: []config.Consumer{
			{Name: "hermes", Token: "tok-hermes"},
			{Name: "leadstack", Token: "tok-leadstack"},
			{Name: "operator", Token: "tok-operator", Admin: true},
		},
		Now:        func() time.Time { return fixedNow },
		Connection: conn,
	})
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

func get(h http.Handler, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func getAuthed(h http.Handler, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
