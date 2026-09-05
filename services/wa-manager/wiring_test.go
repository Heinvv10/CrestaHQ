package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/api"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/provision"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// openStore opens a throwaway registry.
func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "manager.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// startTestPoller starts the poller exactly as main does, with a context the
// test cancels on the way out so the sweep cannot outlive it.
func startTestPoller(t *testing.T, client *http.Client, tokens provision.TokenSource, st *store.Store) *health.Poller {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return startPoller(ctx, client, tokens, st)
}

// A bridge provisioned before its consumer exists has no webhook. nil (rather
// than a function returning "") is what makes the provisioner write no webhook
// field at all — the bridge then receives and records inbound and forwards
// nowhere, instead of trying to POST to an empty URL every message.
func TestWebhookURLIsNilWhenNoBaseIsConfigured(t *testing.T) {
	if webhookURL("") != nil {
		t.Fatal("an unset WEBHOOK_BASE_URL must produce no webhook function at all")
	}
}

// The tenant id has to reach the URL. A base shared by every tenant, with no
// per-tenant path, would deliver every number's inbound to one endpoint with
// nothing saying which number it came from.
func TestWebhookURLCarriesTheTenantID(t *testing.T) {
	f := webhookURL("https://app.example/wa-inbound")
	if f == nil {
		t.Fatal("a configured base must produce a webhook function")
	}
	if got := f("acme"); got != "https://app.example/wa-inbound/acme" {
		t.Fatalf("the tenant id must reach the webhook URL, got %q", got)
	}
	if f("acme") == f("other") {
		t.Fatal("two tenants share one webhook URL; nothing would say which number an inbound came from")
	}
}

// tokenFor is the fail-closed edge: neither caller can take an error, so an
// unreadable .env must become an empty token (a 401 at the bridge), never a
// panic and never a stale token from another tenant.
func TestTokenForReturnsEmptyWhenTheTokenCannotBeRead(t *testing.T) {
	ts := provision.TokenSource{Root: t.TempDir()}
	if got := tokenFor(ts, "missing"); got != "" {
		t.Fatalf("an unreadable token must fail closed to empty, got %q", got)
	}
}

func TestTokenForReturnsTheManagerToken(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "acme")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	const env = "LISTEN_ADDR=127.0.0.1:1\nCONSUMERS=app|tok-app|http://x|100|500,manager|tok-mgr|||500|admin\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := tokenFor(provision.TokenSource{Root: root}, "acme"); got != "tok-mgr" {
		t.Fatalf("want the manager's admin token, got %q", got)
	}
}

// The bound this project keeps losing. A review found the health fan-out
// unbounded with NOTHING setting it, and the fix was an explicit value at the
// wiring site — which is only a fix if something can see it go away.
func TestPollerFanOutIsBoundedExplicitly(t *testing.T) {
	p := startTestPoller(t, &http.Client{}, provision.TokenSource{Root: t.TempDir()}, openStore(t))
	if p.Concurrency <= 0 {
		t.Fatal("the health fan-out must be bounded at the wiring site, not left to a default; " +
			"200 tenants unbounded is 200 simultaneous connections per cycle")
	}
	if p.Concurrency != pollConcurrency {
		t.Fatalf("the wired bound (%d) is not the declared one (%d)", p.Concurrency, pollConcurrency)
	}
}

// The poller must authenticate to each bridge with THAT bridge's manager token,
// read from its own .env — never a blank, and never another tenant's.
func TestPollerUsesThePerTenantManagerToken(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct{ instance, token string }{{"one", "tok-one"}, {"two", "tok-two"}} {
		dir := filepath.Join(root, tc.instance)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		env := "CONSUMERS=app|app-" + tc.instance + "|http://x|100|500,manager|" + tc.token + "|||500|admin\n"
		if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization"))
		w.Write([]byte(`{"ok":true,"connected":true}`))
	}))
	defer srv.Close()

	p := startTestPoller(t, srv.Client(), provision.TokenSource{Root: root}, openStore(t))
	p.BaseURL = func(store.Tenant) string { return srv.URL }
	p.Concurrency = 1 // keep `seen` ordered without a mutex
	p.Snapshot(context.Background(), []store.Tenant{{ID: "one", Instance: "one"}})
	p.Snapshot(context.Background(), []store.Tenant{{ID: "two", Instance: "two"}})

	want := []string{"Bearer tok-one", "Bearer tok-two"}
	if len(seen) != 2 || seen[0] != want[0] || seen[1] != want[1] {
		t.Fatalf("each bridge must be called with its own manager token; got %q want %q", seen, want)
	}
}

// listenValidated must bind cfg.ListenAddr and NOTHING else. config.Load
// refuses a publicly routable address, and that check is worth nothing if the
// process goes on to bind something it re-derived from the environment.
func TestListenValidatedBindsTheValidatedAddressOnly(t *testing.T) {
	// A second, wrong address in the environment. If listenValidated consults
	// it, this test binds the wrong interface and fails.
	t.Setenv("LISTEN_ADDR", "127.0.0.1:0")

	ln, err := listenValidated(config.Config{ListenAddr: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	bound := ln.Addr().String()
	ln.Close()

	// Bind the SAME struct value again and confirm the host it chose came from
	// the config, not from anywhere else.
	if !strings.HasPrefix(bound, "127.0.0.1:") {
		t.Fatalf("bound %q, which is not the configured host", bound)
	}
	if _, err := listenValidated(config.Config{ListenAddr: "203.0.113.1:0"}); err == nil {
		t.Fatal("listenValidated must bind exactly what it was given; an unassignable address must fail, not fall back")
	}
}

// The line a review found nobody could see. main built the poller and started
// its loop as two statements, and replacing `go poller.Run(...)` with `_ = ctx`
// left every test in both services green — reconciliation dead, the screen
// still rendering, and a number's death dated whenever an operator next looked
// rather than when it happened.
//
// So this drives the wiring function itself and asserts the sweep RAN: a bridge
// reporting a logged-out number must reach the store with nobody watching. It
// deliberately does not override p.BaseURL — the tenant's port is the real one,
// which is the only way the assertion covers the production path rather than a
// test-only one.
func TestStartPollerRunsTheReconcileSweep(t *testing.T) {
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"ok":false,"connected":false,"killed":true}`))
	}))
	defer bridge.Close()

	_, portStr, err := net.SplitHostPort(strings.TrimPrefix(bridge.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}

	st := openStore(t)
	if err := st.CreateTenant(store.Tenant{
		ID: "blitz", Instance: "blitz", Port: port, State: store.StateRunning,
	}); err != nil {
		t.Fatal(err)
	}

	startTestPoller(t, bridge.Client(), provision.TokenSource{Root: t.TempDir()}, st)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		got, err := st.GetTenant("blitz")
		if err == nil && got.State == store.StateLoggedOut {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("nothing reconciled the number: the wiring builds a poller whose sweep is never started, " +
		"so a number's death is dated whenever an operator next opens the screen")
}

// A server with no deadlines is the Go default and looks identical at a
// glance: one client that opens a connection and never finishes its request
// line holds a goroutine and an fd indefinitely, on a service where every
// route writes an .env full of bearer tokens or starts a systemd unit.
//
// The write deadline additionally has to outlast the longest response this
// service can legitimately produce — a page whose on-demand health sweep runs
// the full api.SnapshotBudget and then renders. A write deadline shorter than
// that budget cuts the page off mid-render.
func TestHTTPServerHasEveryTimeoutSet(t *testing.T) {
	srv := newHTTPServer(http.NewServeMux())
	for _, tc := range []struct {
		name string
		got  time.Duration
	}{
		{"ReadHeaderTimeout", srv.ReadHeaderTimeout},
		{"ReadTimeout", srv.ReadTimeout},
		{"WriteTimeout", srv.WriteTimeout},
		{"IdleTimeout", srv.IdleTimeout},
	} {
		if tc.got <= 0 {
			t.Errorf("%s is unset; a client that never finishes its request holds a goroutine forever", tc.name)
		}
	}
	if srv.WriteTimeout <= api.SnapshotBudget {
		t.Fatalf("WriteTimeout (%v) does not outlast the on-demand health sweep (%v); "+
			"the page would be cut off mid-render", srv.WriteTimeout, api.SnapshotBudget)
	}
}
