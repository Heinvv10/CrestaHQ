package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// budgetPoller records the deadline the on-demand path handed it, and answers
// with whatever a test wants the sweep to have produced.
type budgetPoller struct {
	incomplete  bool
	hadDeadline bool
	budget      time.Duration
}

func (b *budgetPoller) Snapshot(ctx context.Context, tenants []store.Tenant) map[string]health.Report {
	if dl, ok := ctx.Deadline(); ok {
		b.hadDeadline = true
		b.budget = time.Until(dl)
	}
	out := map[string]health.Report{}
	for _, t := range tenants {
		if b.incomplete {
			out[t.ID] = health.Report{Incomplete: true, Err: "not checked: the health sweep ran out of time"}
			continue
		}
		out[t.ID] = health.Report{Reachable: true, Connected: true}
	}
	return out
}

func budgetHarness(t *testing.T, poll *budgetPoller) (http.Handler, *store.Store) {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/manager.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.CreateTenant(store.Tenant{
		ID: "blitz", DisplayName: "Blitz", Instance: "blitz", Port: 8412, State: store.StateRunning,
	}); err != nil {
		t.Fatal(err)
	}
	return New(Deps{Store: st, Poller: poll, OperatorToken: operatorTok}), st
}

func budgetGet(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+operatorTok)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

// The on-demand sweep — a page load, a list call — must carry a deadline.
// Unbounded, its duration is a function of how many bridges are DEAD: 200
// tenants each timing out at 5s across 8 workers is ~125 seconds on a page
// whose meta-refresh is 15, so the operator screen collapses during exactly
// the outage it exists to show.
func TestOnDemandSnapshotCarriesTheBudget(t *testing.T) {
	for _, path := range []string{"/", "/tenants/blitz", "/api/tenants"} {
		poll := &budgetPoller{}
		h, _ := budgetHarness(t, poll)
		if w := budgetGet(t, h, path); w.Code != http.StatusOK {
			t.Fatalf("%s: status %d", path, w.Code)
		}
		if !poll.hadDeadline {
			t.Fatalf("%s ran its health sweep with no deadline at all", path)
		}
		if poll.budget <= 0 || poll.budget > SnapshotBudget {
			t.Fatalf("%s swept with a budget of %v, want (0, %v]", path, poll.budget, SnapshotBudget)
		}
	}
}

// A truncated sweep is SAID OUT LOUD. A safety screen that quietly omits
// numbers, or draws unchecked ones as dead, is worse than one that admits it
// is incomplete.
func TestATruncatedSweepIsAnnouncedOnEveryOnDemandSurface(t *testing.T) {
	for _, path := range []string{"/", "/tenants/blitz"} {
		h, _ := budgetHarness(t, &budgetPoller{incomplete: true})
		body := budgetGet(t, h, path).Body.String()
		if !strings.Contains(body, "ran out of time") {
			t.Fatalf("%s rendered a truncated sweep with no notice:\n%s", path, body)
		}
	}

	h, _ := budgetHarness(t, &budgetPoller{incomplete: true})
	body := budgetGet(t, h, "/api/tenants").Body.String()
	if !strings.Contains(body, `"healthSweepTruncated":true`) {
		t.Fatalf("the JSON list hid a truncated sweep:\n%s", body)
	}
	if !strings.Contains(body, `"incomplete":true`) {
		t.Fatalf("the JSON list reported an unchecked tenant as if it had been checked:\n%s", body)
	}
}

// The complement: a sweep that COMPLETED must not cry wolf. A banner on every
// page load is a banner nobody reads.
func TestACompleteSweepSaysNothing(t *testing.T) {
	for _, path := range []string{"/", "/tenants/blitz", "/api/tenants"} {
		h, _ := budgetHarness(t, &budgetPoller{})
		body := budgetGet(t, h, path).Body.String()
		if strings.Contains(body, "ran out of time") || strings.Contains(body, "healthSweepTruncated") {
			t.Fatalf("%s announced a truncation that did not happen:\n%s", path, body)
		}
	}
}
