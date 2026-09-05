package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// hangingBridgeCount is how many tenants this test wires against a bridge
// that never answers. Large enough that a truncated sweep is the only
// possible outcome under SnapshotBudget with the production concurrency —
// small enough that 40 httptest servers do not make this the slow test in the
// suite.
const hangingBridgeCount = 40

// TestTruncatedSweepReachesTheRenderedPageWithoutDroppingACard is the wiring
// test snapshot_budget_test.go and health/poll_test.go each stop short of:
// those cover "the on-demand path carries a deadline" and "one poll under a
// deadline is marked Incomplete" separately, but nothing shipped drove a REAL
// health.Poller, under the REAL SnapshotBudget, against many simultaneously
// hanging bridges, through to what the operator's page actually renders.
//
// The property this protects: a truncated sweep must be SAID OUT LOUD and
// every tenant must still get a card. A poller that silently dropped tenants
// it never reached — rather than reporting them Incomplete — would sail
// through both of the narrower tests (each drives at most a couple of
// tenants) while failing an operator screen exactly during the outage it
// exists to explain.
func TestTruncatedSweepReachesTheRenderedPageWithoutDroppingACard(t *testing.T) {
	release := make(chan struct{})
	defer close(release)

	st, err := store.Open(t.TempDir() + "/manager.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	tenants := make([]store.Tenant, 0, hangingBridgeCount)
	servers := make(map[string]*httptest.Server, hangingBridgeCount)
	for i := 0; i < hangingBridgeCount; i++ {
		id := fmt.Sprintf("t%02d", i)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			<-release // never answers inside this test's lifetime
		}))
		t.Cleanup(srv.Close)
		servers[id] = srv

		tn := store.Tenant{ID: id, DisplayName: id, Instance: id, Port: 10000 + i, State: store.StateRunning}
		if err := st.CreateTenant(tn); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
		tenants = append(tenants, tn)
	}

	// The real poller, not a fake — this is the point of the test. Concurrency
	// matches production's pollConcurrency (main.go) so the fan-out this test
	// exercises is the one an operator's box actually runs.
	poller := health.New(&http.Client{}, func(store.Tenant) string { return "tok" })
	poller.Concurrency = 8
	poller.BaseURL = func(t store.Tenant) string { return servers[t.ID].URL }

	h := New(Deps{Store: st, Poller: poller, OperatorToken: operatorTok})

	req := httptest.NewRequest(http.MethodGet, "/api/tenants", nil)
	req.Header.Set("Authorization", "Bearer "+operatorTok)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status %d body=%s", w.Code, w.Body.String())
	}

	var body struct {
		Tenants []struct {
			TenantID string `json:"tenantId"`
			Health   *struct {
				Reachable  bool `json:"reachable"`
				Incomplete bool `json:"incomplete"`
			} `json:"health"`
		} `json:"tenants"`
		HealthSweepTruncated bool `json:"healthSweepTruncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("undecodable list body: %v\n%s", err, w.Body.String())
	}

	if !body.HealthSweepTruncated {
		t.Fatalf("a sweep against %d permanently-hanging bridges under an %v budget must announce truncation; it did not:\n%s",
			hangingBridgeCount, SnapshotBudget, w.Body.String())
	}
	if len(body.Tenants) != hangingBridgeCount {
		t.Fatalf("the list dropped tenants: got %d cards, want %d — a truncated sweep must never omit a tenant, only mark it unchecked", len(body.Tenants), hangingBridgeCount)
	}

	var incomplete, other int
	for _, tv := range body.Tenants {
		if tv.Health == nil {
			t.Fatalf("tenant %s has no health entry at all — that is the silent omission this test guards against", tv.TenantID)
		}
		if tv.Health.Reachable && !tv.Health.Incomplete {
			t.Fatalf("tenant %s reads as reachable, but its bridge never answered", tv.TenantID)
		}
		if tv.Health.Incomplete {
			incomplete++
		} else {
			other++
		}
	}
	if incomplete+other != hangingBridgeCount {
		t.Fatalf("accounted for %d of %d tenants", incomplete+other, hangingBridgeCount)
	}
	if incomplete == 0 {
		t.Fatalf("a sweep this saturated must leave at least some tenants genuinely unchecked, not merely slow: incomplete=%d other=%d", incomplete, other)
	}
}
