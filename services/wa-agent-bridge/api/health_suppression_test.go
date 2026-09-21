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

// A dropped inbound must alert LOUDLY and then stop shouting.
//
// The counter only resets on a new connection, so making it a problem
// unconditionally latches the bridge into ok:false / degraded:true / HTTP 503
// for the entire connection — hours or days after one lost message, on a
// number that is otherwise sending and receiving perfectly. That is the alarm
// fatigue this endpoint's own design rejects for suppressed history, and it
// makes the operator screen misreport a healthy number.
func healthWithDropAge(t *testing.T, capped int, age time.Duration) map[string]any {
	t.Helper()
	st := store.NewMemory()
	now := time.Now()
	h := New(Deps{
		Engine: rails.NewEngine(st, rails.Config{
			PerContactPerDay: 10, ConsecutiveMax: 3, GlobalDailyCap: 150,
			Location: time.UTC,
			Budgets:  map[string]rails.ConsumerBudget{"app": {PerHour: 10, PerDay: 10}},
		}),
		Store:              st,
		Consumers:          []config.Consumer{{Name: "app", Token: "t"}},
		Connection:         upConn{},
		InboundSuppression: func() (int, int) { return 0, capped },
		InboundDropAge: func() (time.Duration, bool) {
			if capped == 0 {
				return 0, false
			}
			return age, true
		},
		Now: func() time.Time { return now },
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/health", nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("health body is not JSON: %v (%s)", err, rec.Body.String())
	}
	body["_status"] = float64(rec.Code)
	return body
}

func TestHealthAlertsWhileADropIsRecent(t *testing.T) {
	body := healthWithDropAge(t, 3, time.Minute)

	if body["droppedInbound"] != float64(3) {
		t.Fatalf("droppedInbound = %v, want 3", body["droppedInbound"])
	}
	if body["_status"] != float64(http.StatusServiceUnavailable) {
		t.Fatalf("a fresh drop must answer 503 so an off-box monitor sees it, got %v", body["_status"])
	}
	if probs, _ := body["problems"].([]any); len(probs) == 0 {
		t.Fatal("a fresh drop must be reported as a problem")
	}
}

func TestHealthStopsAlertingOnceTheDropIsStale(t *testing.T) {
	body := healthWithDropAge(t, 3, 24*time.Hour)

	// The COUNT is still reported — the loss happened and must stay visible.
	if body["droppedInbound"] != float64(3) {
		t.Fatalf("the count must survive, got %v", body["droppedInbound"])
	}
	// But the bridge must not still be calling itself broken a day later.
	if body["_status"] != float64(http.StatusOK) {
		t.Fatalf("a day-old drop must not latch the bridge degraded, got %v", body["_status"])
	}
	if probs, _ := body["problems"].([]any); len(probs) > 0 {
		t.Fatalf("a stale drop must not still be a problem, got %v", probs)
	}
}
