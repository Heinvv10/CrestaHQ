package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

type upConn struct{}

func (upConn) Connected() bool                        { return true }
func (upConn) PairingCode() (string, time.Time, bool) { return "", time.Time{}, false }
func (upConn) Number() string                         { return "27820000000" }

func healthWithSuppression(t *testing.T, history, capped int) map[string]any {
	t.Helper()
	st := store.NewMemory()
	h := New(Deps{
		Engine: rails.NewEngine(st, rails.Config{
			PerContactPerDay: 10, ConsecutiveMax: 3, GlobalDailyCap: 150,
			Location: time.UTC,
			Budgets:  map[string]rails.ConsumerBudget{"app": {PerHour: 10, PerDay: 10}},
		}),
		Store:              st,
		Consumers:          []config.Consumer{{Name: "app", Token: "t"}},
		Connection:         upConn{},
		InboundSuppression: func() (int, int) { return history, capped },
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/health", nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("health body is not JSON: %v (%s)", err, rec.Body.String())
	}
	body["_status"] = rec.Code
	return body
}

// A dropped inbound is a customer message nobody will ever see — the bridge
// stores no body, so there is no other trace of it anywhere. It has to reach
// the endpoint the off-box monitor already watches, and it has to read as a
// PROBLEM rather than as one more counter nobody scrolls to.
func TestHealthSurfacesDroppedInbound(t *testing.T) {
	body := healthWithSuppression(t, 7, 3)

	if body["droppedInbound"] != float64(3) {
		t.Fatalf("droppedInbound = %v, want 3", body["droppedInbound"])
	}
	if body["suppressedHistory"] != float64(7) {
		t.Fatalf("suppressedHistory = %v, want 7", body["suppressedHistory"])
	}
	probs, _ := body["problems"].([]any)
	found := false
	for _, p := range probs {
		if s, ok := p.(string); ok && len(s) > 0 && s[0] == '3' {
			found = true
		}
	}
	if !found {
		t.Fatalf("a dropped inbound must be reported as a problem, got problems=%v", body["problems"])
	}
}

// Suppressed HISTORY is normal on every reconnect. Reporting it as a problem
// would make the endpoint cry wolf on a routine restart, and an alert that
// fires every time is one nobody reads.
func TestHealthDoesNotAlarmOnSuppressedHistoryAlone(t *testing.T) {
	body := healthWithSuppression(t, 40, 0)

	if body["suppressedHistory"] != float64(40) {
		t.Fatalf("suppressedHistory = %v, want 40", body["suppressedHistory"])
	}
	if probs, ok := body["problems"].([]any); ok && len(probs) > 0 {
		t.Fatalf("history alone must not be a problem, got %v", probs)
	}
}
