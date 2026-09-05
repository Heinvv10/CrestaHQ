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

// The allowlist count is how the operator screen reports the reply-only rail.
// It travels as a POINTER because the bridge sends null when it could not read
// its own allowlist, and "nobody has escaped reply-only" must not be
// indistinguishable from "we could not find out".
func TestAllowlistCountIsCarriedThrough(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"ok":true,"connected":true,"allowlisted":2}`))
	}))
	defer srv.Close()

	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	r := p.Snapshot(context.Background(), []store.Tenant{{ID: "t1"}})["t1"]
	if r.AllowlistCount == nil {
		t.Fatal("a reported allowlist count must reach the report")
	}
	if *r.AllowlistCount != 2 {
		t.Fatalf("want 2 allowlisted, got %d", *r.AllowlistCount)
	}
}

// An empty allowlist is a real, reportable state and must arrive as 0, not as
// "unknown" — otherwise the screen would say it cannot see a rail it can.
func TestAnEmptyAllowlistArrivesAsZeroNotUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"ok":true,"connected":true,"allowlisted":0}`))
	}))
	defer srv.Close()

	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	r := p.Snapshot(context.Background(), []store.Tenant{{ID: "t1"}})["t1"]
	if r.AllowlistCount == nil || *r.AllowlistCount != 0 {
		t.Fatalf("an empty allowlist must arrive as 0, got %v", r.AllowlistCount)
	}
}

// A bridge that could not read its own allowlist sends null. That must stay
// unknown all the way up rather than collapsing to a reassuring zero.
func TestAnUnreadableAllowlistStaysUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"ok":false,"degraded":true,"connected":true,"allowlisted":null,
			"problems":["allowlist unreadable"]}`))
	}))
	defer srv.Close()

	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	r := p.Snapshot(context.Background(), []store.Tenant{{ID: "t1"}})["t1"]
	if r.AllowlistCount != nil {
		t.Fatalf("a null allowlist count must not become a number, got %d", *r.AllowlistCount)
	}
}
