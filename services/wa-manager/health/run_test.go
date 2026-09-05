package health

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// Nothing else in this service calls Reconcile. Without this loop the manager
// polls only when an operator happens to load the screen, and a number that
// died at 02:00 is dated 09:00 — the state and the event both. The loop is what
// makes "logged out" a record rather than an inference.
func TestRunReconcilesWithoutAnyoneLooking(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"ok":false,"connected":false,"killed":true}`))
	}))
	defer srv.Close()

	st := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StateRunning}
	if err := st.CreateTenant(tenant); err != nil {
		t.Fatal(err)
	}

	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); p.Run(ctx, st, 5*time.Millisecond) }()

	waitFor(t, func() bool {
		got, err := st.GetTenant("t1")
		return err == nil && got.State == store.StateLoggedOut
	}, "the loop never reconciled a logged-out number")

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run ignored its cancelled context; a manager that will not shut down is killed mid-write")
	}
}

// The first sweep must not wait a whole interval. A manager restarted during an
// incident is exactly when someone is watching, and a screen that says
// "unknown" for the first poll interval is the screen being useless when it is
// needed.
func TestRunSweepsImmediatelyRatherThanAfterTheFirstInterval(t *testing.T) {
	var polls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		polls.Add(1)
		w.Write([]byte(`{"ok":true,"connected":true}`))
	}))
	defer srv.Close()

	st := openStore(t)
	if err := st.CreateTenant(store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StatePairing}); err != nil {
		t.Fatal(err)
	}
	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// An interval far longer than the test: only an immediate first sweep can
	// satisfy this.
	go p.Run(ctx, st, time.Hour)

	waitFor(t, func() bool { return polls.Load() > 0 }, "Run waited a full interval before its first sweep")
}

// A BRIDGE failing must not end reconciliation for the life of the process.
// The failure that stops a monitor is worse than the one it monitors.
//
// Named for what it actually drives: an unreachable/undecodable bridge. It does
// NOT reach sweep's Reconcile-error branch — a report carrying only a decode
// error causes no store write, so Reconcile returns nil. The store half is
// TestRunSurvivesAnUnreadableStore below.
func TestRunSurvivesABrokenBridge(t *testing.T) {
	var polls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		polls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`not json`))
	}))
	defer srv.Close()

	st := openStore(t)
	if err := st.CreateTenant(store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StatePairing}); err != nil {
		t.Fatal(err)
	}
	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.Run(ctx, st, 5*time.Millisecond)

	waitFor(t, func() bool { return polls.Load() >= 3 },
		"the loop stopped after a failing sweep; reconciliation would be dead for the life of the process")
}

// The other half of the same guarantee, and the one that reaches sweep's own
// error handling: a store it cannot read. The loop must log and keep ticking.
// Returning here would leave reconciliation dead for the life of the process
// while the HTTP surface kept answering — a monitor that died silently.
func TestRunSurvivesAnUnreadableStore(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"ok":true,"connected":true}`))
	}))
	defer srv.Close()

	st := openStore(t)
	if err := st.CreateTenant(store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StatePairing}); err != nil {
		t.Fatal(err)
	}
	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); p.Run(ctx, st, 2*time.Millisecond) }()

	// Every read from here on fails. The loop must not treat that as its exit.
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond) // many intervals' worth of failing sweeps
	select {
	case <-done:
		t.Fatal("Run returned on an unreadable store; reconciliation would be dead for the life of the process")
	default:
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run ignored its cancelled context")
	}
}

func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal(msg)
}

// The sweep's third failure mode: the poll succeeded, and writing what it saw
// did not. The loop must log and keep going. Returning here would end
// reconciliation for the life of the process while the screen kept rendering
// stale state — the silent monitor death this whole loop exists to avoid.
func TestRunSurvivesAFailingReconcile(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"ok":true,"connected":true}`))
	}))
	defer srv.Close()

	st := openStore(t)
	if err := st.CreateTenant(store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StatePairing}); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int64
	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }
	p.reconcileFn = func(*store.Store, []store.Tenant, map[string]Report) error {
		calls.Add(1)
		return errors.New("the disk is gone")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); p.Run(ctx, st, 2*time.Millisecond) }()

	waitFor(t, func() bool { return calls.Load() >= 3 },
		"the loop stopped after a failing reconcile; state would go stale with nothing saying so")
	select {
	case <-done:
		t.Fatal("Run returned on a reconcile error")
	default:
	}
}

// The seam must not change production behaviour: an unset reconcileFn is
// Reconcile itself, so the default path is the one every other test drives.
func TestTheDefaultReconcilerIsReconcile(t *testing.T) {
	if (&Poller{}).reconciler() == nil {
		t.Fatal("a Poller with no override must still reconcile")
	}
}
