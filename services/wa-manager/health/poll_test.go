package health

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

func TestSnapshotReadsEachBridge(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"connected":true,"killed":false,
			"outboundLast24h":18,"dailyCap":150,"lastInboundAgeSeconds":360}`))
	}))
	defer srv.Close()

	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	got := p.Snapshot(context.Background(), []store.Tenant{{ID: "t1"}})
	r := got["t1"]
	if !r.Reachable || !r.Connected || r.OutboundLast24h != 18 || r.DailyCap != 150 {
		t.Fatalf("bad report: %+v", r)
	}
	if r.LastInboundAgeSeconds == nil || *r.LastInboundAgeSeconds != 360 {
		t.Fatalf("lastInboundAge not carried: %+v", r.LastInboundAgeSeconds)
	}
}

// A bridge that is down must read as UNREACHABLE, never as healthy-with-zeros.
// The whole point of this view is catching a number that has quietly died.
func TestUnreachableBridgeIsNotReportedHealthy(t *testing.T) {
	p := New(&http.Client{Timeout: 100 * time.Millisecond},
		func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return "http://127.0.0.1:1" }

	r := p.Snapshot(context.Background(), []store.Tenant{{ID: "t1"}})["t1"]
	if r.Reachable || r.Connected {
		t.Fatalf("a dead bridge reported reachable/connected: %+v", r)
	}
	if r.Err == "" {
		t.Fatal("an unreachable bridge must carry the reason")
	}
}

func TestDegradedBridgeIsCarriedThrough(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"ok":false,"degraded":true,"connected":false,
			"problems":["whatsapp socket is not connected"]}`))
	}))
	defer srv.Close()

	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	r := p.Snapshot(context.Background(), []store.Tenant{{ID: "t1"}})["t1"]
	if !r.Reachable {
		t.Fatal("a 503 is an answer, not an unreachable bridge")
	}
	if !r.Degraded || r.Connected || len(r.Problems) != 1 {
		t.Fatalf("degraded detail lost: %+v", r)
	}
}
