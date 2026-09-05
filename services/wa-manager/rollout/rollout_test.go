package rollout

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// fakeUnits records the systemd verbs in order, so a test can assert that a
// rollout stopped where it said it stopped.
type fakeUnits struct {
	mu    sync.Mutex
	verbs []string
	// failStart names an instance whose Start returns an error — a bridge
	// that will not come back.
	failStart string
	// onStart lets the fake poll learn that an instance has been restarted, so
	// it can start answering with the post-restart version.
	onStart func(instance string)
}

func (f *fakeUnits) note(verb, i string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.verbs = append(f.verbs, verb+":"+i)
}

func (f *fakeUnits) Stop(i string) error        { f.note("stop", i); return nil }
func (f *fakeUnits) ResetFailed(i string) error { f.note("reset-failed", i); return nil }
func (f *fakeUnits) Start(i string) error {
	f.note("start", i)
	if i == f.failStart {
		return fmt.Errorf("unit refused to start")
	}
	if f.onStart != nil {
		f.onStart(i)
	}
	return nil
}

func (f *fakeUnits) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.verbs...)
}

func (f *fakeUnits) started(instance string) int {
	n := 0
	for _, v := range f.seen() {
		if v == "start:"+instance {
			n++
		}
	}
	return n
}

// fakePoll answers what each bridge is running. versions maps tenant id to the
// version it reports; a tenant absent from the map is unreachable.
//
// afterRestart lets a test say "this bridge comes back on the OLD build",
// which is what a half-written install looks like from the outside.
type fakePoll struct {
	mu           sync.Mutex
	versions     map[string]string
	afterRestart map[string]string
	restarted    map[string]bool
}

func (p *fakePoll) Snapshot(_ context.Context, tenants []store.Tenant) map[string]health.Report {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make(map[string]health.Report, len(tenants))
	for _, t := range tenants {
		v, ok := p.versions[t.ID]
		if !ok {
			out[t.ID] = health.Report{Reachable: false, Err: "unreachable"}
			continue
		}
		if p.restarted[t.ID] {
			if after, ok := p.afterRestart[t.ID]; ok {
				v = after
			}
		}
		out[t.ID] = health.Report{Reachable: true, Connected: true, Version: v}
	}
	return out
}

// markRestarted is called by the fake units wiring below so the poll can start
// answering with the post-restart version.
func (p *fakePoll) markRestarted(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.restarted[id] = true
}

func openStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "mgr.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func seed(t *testing.T, s *store.Store, ids ...string) []store.Tenant {
	t.Helper()
	var out []store.Tenant
	for i, id := range ids {
		tn := store.Tenant{ID: id, Instance: id, Port: 33100 + i, State: store.StateRunning}
		if err := s.CreateTenant(tn); err != nil {
			t.Fatalf("CreateTenant %s: %v", id, err)
		}
		out = append(out, tn)
	}
	return out
}

// newWorker wires a worker whose clock and sleeps are instant, so a test of a
// 90-second settle budget does not take 90 seconds.
func newWorker(t *testing.T, s *store.Store, u *fakeUnits, p *fakePoll) *Worker {
	t.Helper()
	now := time.Date(2026, 9, 5, 23, 0, 0, 0, time.UTC)
	w := &Worker{
		Store: s, Units: u, Poll: p,
		Loc: time.UTC, StartHour: 22, EndHour: 5,
		now:   func() time.Time { return now },
		sleep: func(d time.Duration) { now = now.Add(d) },
	}
	return w
}

// The case that pays for the whole design: a deploy that changed only the
// manager must not bounce a single customer's number.
func TestNothingIsRestartedWhenEveryBridgeAlreadyRunsTheBuild(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a", "b", "c")
	u := &fakeUnits{}
	p := &fakePoll{versions: map[string]string{"a": "v2", "b": "v2", "c": "v2"}, restarted: map[string]bool{}}
	w := newWorker(t, s, u, p)

	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	if err := w.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}

	if got := u.seen(); len(got) != 0 {
		t.Fatalf("a no-op rollout touched systemd: %v", got)
	}
	r, _, _ := s.LastRollout()
	if r.State != store.RolloutDone {
		t.Fatalf("state = %q, want done", r.State)
	}
}

// One at a time, and only the stale ones. Forty numbers going deaf together is
// an outage; "b" is already current and must not be touched.
func TestOnlyStaleBridgesAreRestartedAndOneAtATime(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a", "b", "c")
	p := &fakePoll{
		versions:     map[string]string{"a": "v1", "b": "v2", "c": "v1"},
		afterRestart: map[string]string{},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	// A restarted bridge comes back on the new build.
	p.afterRestart = map[string]string{"a": "v2", "c": "v2"}
	wireRestartMarking(u, p)

	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	if err := w.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}

	want := []string{
		"stop:a", "reset-failed:a", "start:a",
		"stop:c", "reset-failed:c", "start:c",
	}
	if got := strings.Join(u.seen(), ","); got != strings.Join(want, ",") {
		t.Fatalf("verbs = %v, want %v", u.seen(), want)
	}
	r, _, _ := s.LastRollout()
	if r.State != store.RolloutDone {
		t.Fatalf("state = %q detail=%q, want done", r.State, r.Detail)
	}
}

// The failure this design is chosen for. Bridge "b" will not start: "a" is
// already upgraded and stays upgraded, "c" is never touched, and the rollout
// records where it stopped.
func TestAFailedBridgeHoldsTheRolloutAndLeavesTheRestAlone(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a", "b", "c")
	p := &fakePoll{
		versions:     map[string]string{"a": "v1", "b": "v1", "c": "v1"},
		afterRestart: map[string]string{"a": "v2"},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{failStart: "b"}
	w := newWorker(t, s, u, p)
	wireRestartMarking(u, p)

	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	err := w.Tick(context.Background())
	if err == nil {
		t.Fatal("a rollout that could not start a bridge reported success")
	}

	if u.started("c") != 0 {
		t.Fatal("the rollout carried on past a bridge that did not come back")
	}
	if u.started("a") != 1 {
		t.Fatalf("the already-upgraded bridge was disturbed: %v", u.seen())
	}
	r, _, _ := s.LastRollout()
	if r.State != store.RolloutFailed {
		t.Fatalf("state = %q, want failed", r.State)
	}
	if !strings.Contains(r.Detail, "held at b") {
		t.Fatalf("detail does not name the bridge that stopped it: %q", r.Detail)
	}
}

// A bridge that starts but comes back on the OLD build is a failure, not a
// success. That is what a half-written install looks like from the outside,
// and accepting it would let a rollout report every bridge upgraded while none
// of them were.
func TestABridgeThatComesBackOnTheOldBuildIsAFailure(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a")
	p := &fakePoll{
		versions:     map[string]string{"a": "v1"},
		afterRestart: map[string]string{"a": "v1"}, // still old
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	wireRestartMarking(u, p)

	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	if err := w.Tick(context.Background()); err == nil {
		t.Fatal("a bridge that came back on the old build was accepted")
	}
	r, _, _ := s.LastRollout()
	if r.State != store.RolloutFailed {
		t.Fatalf("state = %q, want failed", r.State)
	}
}

// An unreachable bridge is restarted rather than skipped: it is either down —
// in which case starting it is right and costs no delivery hole — or it needs
// the remedy a restart is. Skipping would strand the fleet split on the one
// number nobody can see.
func TestAnUnreachableBridgeIsIncludedInTheRollout(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a")
	p := &fakePoll{
		versions:     map[string]string{}, // unreachable
		afterRestart: map[string]string{},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	// It comes back reachable on the new build once started.
	wireRestartMarkingWith(u, p, func() {
		p.mu.Lock()
		p.versions["a"] = "v2"
		p.mu.Unlock()
	})

	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	if err := w.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if u.started("a") != 1 {
		t.Fatalf("an unreachable bridge was skipped: %v", u.seen())
	}
}

// A deferred rollout waits for the window; the same rollout marked immediate
// does not. Without this, --now is decoration.
func TestADeferredRolloutWaitsForTheWindowAndImmediateDoesNot(t *testing.T) {
	for _, tc := range []struct {
		name      string
		immediate bool
		hour      int
		wantStart int
	}{
		{"deferred outside the window waits", false, 12, 0},
		{"deferred inside the window runs", false, 23, 1},
		{"immediate runs outside the window", true, 12, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := openStore(t)
			seed(t, s, "a")
			p := &fakePoll{
				versions:     map[string]string{"a": "v1"},
				afterRestart: map[string]string{"a": "v2"},
				restarted:    map[string]bool{},
			}
			u := &fakeUnits{}
			w := newWorker(t, s, u, p)
			now := time.Date(2026, 9, 5, tc.hour, 0, 0, 0, time.UTC)
			w.now = func() time.Time { return now }
			w.sleep = func(d time.Duration) { now = now.Add(d) }
			wireRestartMarking(u, p)

			if _, err := s.RequestRollout("v2", tc.immediate); err != nil {
				t.Fatalf("RequestRollout: %v", err)
			}
			_ = w.Tick(context.Background())
			if got := u.started("a"); got != tc.wantStart {
				t.Fatalf("starts = %d, want %d (verbs %v)", got, tc.wantStart, u.seen())
			}
		})
	}
}

// The window wraps midnight, which is the shape every real configuration uses.
func TestTheWindowWrapsMidnight(t *testing.T) {
	w := &Worker{Loc: time.UTC, StartHour: 22, EndHour: 5}
	for _, tc := range []struct {
		hour int
		want bool
	}{{21, false}, {22, true}, {23, true}, {0, true}, {4, true}, {5, false}, {12, false}} {
		got := w.InWindow(time.Date(2026, 9, 5, tc.hour, 30, 0, 0, time.UTC))
		if got != tc.want {
			t.Errorf("InWindow(%02d:30) = %v, want %v", tc.hour, got, tc.want)
		}
	}
}

// Equal hours mean "always", not "never". The other reading turns a plausible
// misconfiguration into a rollout that never runs, which looks on the operator
// screen exactly like a rollout nobody asked for.
func TestAnEmptyWindowMeansAlways(t *testing.T) {
	w := &Worker{Loc: time.UTC, StartHour: 0, EndHour: 0}
	if !w.InWindow(time.Date(2026, 9, 5, 13, 0, 0, 0, time.UTC)) {
		t.Fatal("a zero window refused a rollout at midday")
	}
}

// Two rollouts on different builds would fight over the same fleet, and each
// restart costs a real customer five minutes of delivery. One at a time.
func TestASecondRolloutOnADifferentBuildIsRefused(t *testing.T) {
	s := openStore(t)
	if _, err := s.RequestRollout("v2", false); err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := s.RequestRollout("v3", false); err == nil {
		t.Fatal("a second rollout on a different build was accepted")
	}
}

// The deploy script may legitimately run twice — a retry, a repeated command.
// Re-requesting the SAME build returns the outstanding rollout instead of
// failing the deploy.
func TestRequestingTheSameBuildTwiceIsNotAnError(t *testing.T) {
	s := openStore(t)
	first, err := s.RequestRollout("v2", false)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := s.RequestRollout("v2", false)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("a repeat request created a second rollout: %d then %d", first.ID, second.ID)
	}
}

// wireRestartMarking makes the fake poll answer post-restart versions once the
// unit has been started.
func wireRestartMarking(u *fakeUnits, p *fakePoll) {
	wireRestartMarkingWith(u, p, nil)
}

func wireRestartMarkingWith(u *fakeUnits, p *fakePoll, extra func()) {
	orig := u.failStart
	u.onStart = func(i string) {
		if i == orig {
			return
		}
		p.markRestarted(i)
		if extra != nil {
			extra()
		}
	}
}
