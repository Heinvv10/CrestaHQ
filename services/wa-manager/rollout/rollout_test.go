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
	// failStart names an instance whose Restart returns an error — a bridge
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

func (f *fakeUnits) ResetFailed(i string) error { f.note("reset-failed", i); return nil }
func (f *fakeUnits) Restart(i string) error {
	f.note("restart", i)
	if i == f.failStart {
		return fmt.Errorf("unit refused to restart")
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
		if v == "restart:"+instance {
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
	// onSnapshot fires after a snapshot is served, so a test can change the
	// world mid-tick — which is the only way to exercise a tenant that
	// disappears between being listed and being acted on.
	onSnapshot func()
}

func (p *fakePoll) Snapshot(_ context.Context, tenants []store.Tenant) map[string]health.Report {
	p.mu.Lock()
	defer func() {
		p.mu.Unlock()
		if p.onSnapshot != nil {
			p.onSnapshot()
		}
	}()
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
	return seedState(t, s, store.StateRunning, ids...)
}

func seedState(t *testing.T, s *store.Store, state store.State, ids ...string) []store.Tenant {
	t.Helper()
	var out []store.Tenant
	for i, id := range ids {
		tn := store.Tenant{ID: id, Instance: id, Port: 33100 + len(mustList(t, s)) + i, State: state}
		if err := s.CreateTenant(tn); err != nil {
			t.Fatalf("CreateTenant %s: %v", id, err)
		}
		out = append(out, tn)
	}
	return out
}

// newWorker wires a worker whose clock and sleeps are instant, so a test of a
// 90-second settle budget does not take 90 seconds.
func mustList(t *testing.T, s *store.Store) []store.Tenant {
	t.Helper()
	got, err := s.ListTenants()
	if err != nil {
		t.Fatalf("ListTenants: %v", err)
	}
	return got
}

// drain ticks until the rollout leaves pending/running, or the budget runs
// out. One bridge is restarted per tick, so a test that wants a whole fleet
// rolled has to tick for it — which is the behaviour, not an inconvenience.
func drain(t *testing.T, w *Worker, s *store.Store, maxTicks int) error {
	t.Helper()
	for i := 0; i < maxTicks; i++ {
		err := w.Tick(context.Background())
		if err != nil {
			return err
		}
		r, ok, lerr := s.CurrentRollout()
		if lerr != nil {
			t.Fatalf("CurrentRollout: %v", lerr)
		}
		if !ok || (r.State != store.RolloutPending && r.State != store.RolloutRunning) {
			return nil
		}
	}
	t.Fatalf("rollout did not settle within %d ticks", maxTicks)
	return nil
}

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
	if err := drain(t, w, s, 5); err != nil {
		t.Fatalf("drain: %v", err)
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
	if err := drain(t, w, s, 10); err != nil {
		t.Fatalf("drain: %v", err)
	}

	want := []string{
		"reset-failed:a", "restart:a",
		"reset-failed:c", "restart:c",
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
	var err error
	for i := 0; i < 5 && err == nil; i++ {
		err = w.Tick(context.Background())
	}
	if err == nil {
		t.Fatal("a rollout that could not restart a bridge reported success")
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
	if err := drain(t, w, s, 5); err != nil {
		t.Fatalf("drain: %v", err)
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

// Deploying twice in an evening is the normal case. The second request
// SUPERSEDES the first — there is only ever one valid target, the binary on
// disk — and it reuses the same row rather than queueing behind it.
//
// Refusing here used to leave the fleet aimed at a build that no longer
// existed on disk: the second deploy installs its binary and restarts the
// manager BEFORE it asks for a rollout, so a refusal meant the 22:00 worker
// would bounce a real customer's number, watch it come back on the newer
// build, refuse to accept it, and hold.
func TestASecondDeploySupersedesTheFirst(t *testing.T) {
	s := openStore(t)
	first, err := s.RequestRollout("v2", false)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := s.RequestRollout("v3", false)
	if err != nil {
		t.Fatalf("a second deploy was refused: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("supersede created a second row: %d then %d", first.ID, second.ID)
	}
	cur, ok, err := s.CurrentRollout()
	if err != nil || !ok {
		t.Fatalf("CurrentRollout: %v ok=%v", err, ok)
	}
	if cur.Version != "v3" {
		t.Fatalf("outstanding rollout targets %q, want the newer build v3", cur.Version)
	}
}

// Urgency belongs to the BUILD it was requested for and does not survive a
// retarget.
//
// This test previously asserted the opposite, and the opposite is a way to
// restart a customer's number in the middle of a Monday: `--now` on v1,
// followed by a routine unhurried deploy of v2, left the row marked immediate,
// and the worker then skipped the window for a rollout nobody had marked
// urgent.
func TestUrgencyDoesNotSurviveARetarget(t *testing.T) {
	s := openStore(t)
	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("first: %v", err)
	}
	got, err := s.RequestRollout("v3", false)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if got.Immediate {
		t.Fatal("an unhurried deploy inherited the previous build's urgency")
	}
}

// A rollout left `running` by a manager killed mid-tick must not block the
// next deploy. Superseding is what removes that wedge — the old code refused
// every future request until someone edited the database by hand.
func TestARunningRolloutDoesNotBlockTheNextDeploy(t *testing.T) {
	s := openStore(t)
	r, err := s.RequestRollout("v2", false)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := s.SetRolloutState(r.ID, r.Generation, store.RolloutRunning, ""); err != nil {
		t.Fatalf("SetRolloutState: %v", err)
	}
	if _, err := s.RequestRollout("v3", false); err != nil {
		t.Fatalf("a deploy was blocked by a stuck running rollout: %v", err)
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

// One banned number must not stop the fleet from ever being upgraded again.
//
// `logged_out` is a documented state a number sits in until a human re-pairs
// it, so it can never satisfy the health gate. An earlier version rolled every
// tenant regardless of state, so a single banned number timed out and HELD the
// rollout — permanently, on every future deploy.
func TestALoggedOutTenantDoesNotWedgeTheRollout(t *testing.T) {
	s := openStore(t)
	seed(t, s, "live")
	seedState(t, s, store.StateLoggedOut, "banned")
	p := &fakePoll{
		versions:     map[string]string{"live": "v1"},
		afterRestart: map[string]string{"live": "v2"},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	wireRestartMarking(u, p)

	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	if err := drain(t, w, s, 10); err != nil {
		t.Fatalf("a logged-out tenant wedged the rollout: %v", err)
	}

	if u.started("banned") != 0 {
		t.Fatalf("a logged-out number was restarted: %v", u.seen())
	}
	if u.started("live") != 1 {
		t.Fatalf("the live number was not rolled: %v", u.seen())
	}
	r, _, _ := s.LastRollout()
	if r.State != store.RolloutDone {
		t.Fatalf("state = %q detail=%q, want done", r.State, r.Detail)
	}
}

// A bridge an operator deliberately stopped must not be started by a rollout.
// Starting it would silently undo a decision somebody made on purpose.
func TestAStoppedTenantIsLeftStopped(t *testing.T) {
	s := openStore(t)
	seedState(t, s, store.StateStopped, "parked")
	p := &fakePoll{versions: map[string]string{}, afterRestart: map[string]string{}, restarted: map[string]bool{}}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)

	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	if err := drain(t, w, s, 5); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if got := u.seen(); len(got) != 0 {
		t.Fatalf("a deliberately stopped number was touched: %v", got)
	}
}

// The window is re-read on EVERY tick, not once at the start. An earlier
// version checked it once and then ran the whole fleet, so a rollout that
// became eligible at 04:59 kept restarting customers' numbers into the
// morning. Here the clock crosses out of the window after the first bridge and
// the second one waits for the next night.
func TestTheWindowIsRecheckedBetweenBridges(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a", "b")
	p := &fakePoll{
		versions:     map[string]string{"a": "v1", "b": "v1"},
		afterRestart: map[string]string{"a": "v2", "b": "v2"},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	now := time.Date(2026, 9, 5, 4, 59, 0, 0, time.UTC) // inside 22:00-05:00
	w.now = func() time.Time { return now }
	w.sleep = func(d time.Duration) { now = now.Add(d) }
	wireRestartMarking(u, p)

	if _, err := s.RequestRollout("v2", false); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	if err := w.Tick(context.Background()); err != nil { // rolls one bridge
		t.Fatalf("first tick: %v", err)
	}
	now = time.Date(2026, 9, 5, 5, 30, 0, 0, time.UTC) // window has closed
	if err := w.Tick(context.Background()); err != nil {
		t.Fatalf("second tick: %v", err)
	}

	if got := len(u.seen()); got != 2 { // reset-failed + restart, for ONE bridge
		t.Fatalf("the rollout kept going past the window: %v", u.seen())
	}
	r, _, _ := s.LastRollout()
	if r.State != store.RolloutRunning {
		t.Fatalf("state = %q, want still running (it resumes tomorrow night)", r.State)
	}
}

// At most one bridge per tick, whatever the fleet size. This is the promise
// that keeps a deploy from being an outage.
func TestOnlyOneBridgeIsRestartedPerTick(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a", "b", "c", "d")
	p := &fakePoll{
		versions:     map[string]string{"a": "v1", "b": "v1", "c": "v1", "d": "v1"},
		afterRestart: map[string]string{"a": "v2", "b": "v2", "c": "v2", "d": "v2"},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	wireRestartMarking(u, p)

	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	if err := w.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	restarts := 0
	for _, v := range u.seen() {
		if strings.HasPrefix(v, "restart:") {
			restarts++
		}
	}
	if restarts != 1 {
		t.Fatalf("one tick restarted %d bridges: %v", restarts, u.seen())
	}
}

// A tenant offboarded during the rollout window must not fail the fleet
// upgrade. Destroy releases the unit, the directory AND the port, so acting on
// a stale row could also probe whichever tenant was provisioned onto that port
// next.
func TestATenantDestroyedMidRolloutIsSkippedNotFailed(t *testing.T) {
	s := openStore(t)
	seed(t, s, "going", "staying")
	p := &fakePoll{
		versions:     map[string]string{"going": "v1", "staying": "v1"},
		afterRestart: map[string]string{"staying": "v2"},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	wireRestartMarking(u, p)
	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	// The tenant vanishes INSIDE the tick — after the fleet has been listed
	// and polled, before the restart. Deleting it before the tick would prove
	// nothing: ListTenants would simply never return it, and the guard under
	// test would not be reached.
	p.onSnapshot = func() {
		if _, err := s.GetTenant("going"); err == nil {
			if err := s.DeleteTenant("going"); err != nil {
				t.Errorf("DeleteTenant: %v", err)
			}
		}
	}

	if err := drain(t, w, s, 10); err != nil {
		t.Fatalf("an offboarded tenant failed the rollout: %v", err)
	}
	if u.started("going") != 0 {
		t.Fatalf("a destroyed tenant was restarted: %v", u.seen())
	}
	if u.started("staying") != 1 {
		t.Fatalf("the remaining tenant was not rolled: %v", u.seen())
	}
}

// --now on a build already queued for tonight must ESCALATE it. Without this
// the flag is decoration: a fix that cannot wait would sit until 22:00 because
// an earlier, unhurried deploy had already queued the same build.
func TestAnImmediateRequestEscalatesAQueuedRollout(t *testing.T) {
	s := openStore(t)
	if _, err := s.RequestRollout("v2", false); err != nil {
		t.Fatalf("first: %v", err)
	}
	got, err := s.RequestRollout("v2", true)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if !got.Immediate {
		t.Fatal("--now did not escalate a rollout already queued for the window")
	}
}

// Re-requesting the SAME build must not restart the state machine. The deploy
// script may legitimately ask twice, and resetting a mid-flight rollout to
// pending discards the progress the operator screen is showing.
func TestRerequestingTheSameBuildDoesNotResetAnInFlightRollout(t *testing.T) {
	s := openStore(t)
	r, err := s.RequestRollout("v2", false)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := s.SetRolloutState(r.ID, r.Generation, store.RolloutRunning, "held at a"); err != nil {
		t.Fatalf("SetRolloutState: %v", err)
	}
	got, err := s.RequestRollout("v2", false)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if got.State != store.RolloutRunning {
		t.Fatalf("state = %q, want the in-flight state left alone", got.State)
	}
	if got.Detail != "held at a" {
		t.Fatalf("detail = %q, want the operator-visible progress kept", got.Detail)
	}
}

// The lost update this compare-and-set exists for. The worker reads a rollout,
// spends up to ninety seconds settling one bridge, then writes its verdict; a
// deploy landing in that window supersedes the row in place. Without the
// version check the OLD rollout's verdict lands on the NEW target — observed
// as a row reading done/v3 while every bridge still ran v1, which the deploy
// script reads as "every bridge rolled".
func TestAVerdictCannotLandOnARolloutThatSupersededIt(t *testing.T) {
	s := openStore(t)
	r, err := s.RequestRollout("v2", true)
	if err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	// A second deploy retargets the same row while the worker is mid-flight.
	if _, err := s.RequestRollout("v3", false); err != nil {
		t.Fatalf("supersede: %v", err)
	}

	ok, err := s.SetRolloutState(r.ID, r.Generation, store.RolloutDone, "every eligible bridge runs this build")
	if err != nil {
		t.Fatalf("SetRolloutState: %v", err)
	}
	if ok {
		t.Fatal("a verdict for v2 was written onto a rollout that now targets v3")
	}
	cur, outstanding, err := s.CurrentRollout()
	if err != nil {
		t.Fatalf("CurrentRollout: %v", err)
	}
	if !outstanding {
		t.Fatal("the superseding rollout was marked finished by the previous one's verdict")
	}
	if cur.Version != "v3" || cur.State == store.RolloutDone {
		t.Fatalf("outstanding rollout = %+v, want v3 still to be done", cur)
	}
}

// A verdict for the build actually being rolled still lands.
func TestAVerdictForTheCurrentBuildIsWritten(t *testing.T) {
	s := openStore(t)
	r, err := s.RequestRollout("v2", true)
	if err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	ok, err := s.SetRolloutState(r.ID, r.Generation, store.RolloutDone, "done")
	if err != nil || !ok {
		t.Fatalf("SetRolloutState ok=%v err=%v, want the verdict to land", ok, err)
	}
	if _, outstanding, _ := s.CurrentRollout(); outstanding {
		t.Fatal("a finished rollout is still outstanding")
	}
}

// A manager shutting down mid-restart must not mark the rollout failed. The
// deploy script restarts the manager itself, so this turned a routine deploy
// into the loudest banner on the operator screen — over nothing.
func TestAShutdownMidRestartLeavesTheRolloutOutstanding(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a")
	p := &fakePoll{
		versions:     map[string]string{"a": "v1"},
		afterRestart: map[string]string{"a": "v1"}, // never reaches the target
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	wireRestartMarking(u, p)
	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the process is going down
	if err := w.Tick(ctx); err != nil {
		t.Fatalf("a shutdown reported a rollout failure: %v", err)
	}

	r, ok, err := s.CurrentRollout()
	if err != nil {
		t.Fatalf("CurrentRollout: %v", err)
	}
	if !ok {
		t.Fatal("a shutdown finished the rollout; it must stay outstanding for the next process")
	}
	if r.State == store.RolloutFailed {
		t.Fatalf("a shutdown marked the rollout failed: %+v", r)
	}
}

// A bridge that does not come back is a HOLD, whatever the reason.
//
// This test asserted the opposite once, and the opposite was catastrophic: the
// manager's reconciler marks a bridge logged_out DURING the settle precisely
// because the restart failed, so "skip a tenant that is no longer running"
// consumed the failure signal as its excuse. A fleet whose new binary could
// not hold a session was walked down one number at a time and reported as a
// successful deploy.
func TestABridgeThatComesBackLoggedOutHoldsTheRollout(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a", "b", "c")
	p := &fakePoll{
		versions:     map[string]string{"a": "v1", "b": "v1", "c": "v1"},
		afterRestart: map[string]string{"a": "v1", "b": "v1", "c": "v1"},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	// The reconciler runs during the settle and marks the number logged out,
	// which is exactly what a bridge whose session is rejected looks like.
	wireRestartMarkingWith(u, p, func() {
		_ = s.SetTenantState("a", store.StateLoggedOut, "")
	})
	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}

	var err error
	for i := 0; i < 5 && err == nil; i++ {
		err = w.Tick(context.Background())
	}
	if err == nil {
		t.Fatal("a fleet whose bridges never came back reported success")
	}

	r, _, _ := s.LastRollout()
	if r.State != store.RolloutFailed {
		t.Fatalf("state = %q detail=%q, want failed and LOUD", r.State, r.Detail)
	}
	if u.started("b") != 0 || u.started("c") != 0 {
		t.Fatalf("the rollout walked the rest of the fleet down: %v", u.seen())
	}
}

// Holding does not wedge the NEXT deploy: the number that failed is no longer
// `running`, so it is not eligible, and the rest of the fleet rolls.
func TestAHeldNumberDoesNotBlockTheNextRollout(t *testing.T) {
	s := openStore(t)
	seed(t, s, "healthy")
	seedState(t, s, store.StateLoggedOut, "casualty")
	p := &fakePoll{
		versions:     map[string]string{"healthy": "v1"},
		afterRestart: map[string]string{"healthy": "v3"},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	wireRestartMarking(u, p)

	if _, err := s.RequestRollout("v3", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	if err := drain(t, w, s, 10); err != nil {
		t.Fatalf("a previously held number blocked the next rollout: %v", err)
	}
	if u.started("casualty") != 0 {
		t.Fatalf("a logged-out number was restarted: %v", u.seen())
	}
	if u.started("healthy") != 1 {
		t.Fatalf("the healthy number was not rolled: %v", u.seen())
	}
}

// Urgency is exactly what the LATEST request said. Nothing is inherited.
//
// Both earlier attempts at cleverness restarted a customer's number during a
// working day: sticky-in-both-directions, then cleared-only-on-retarget —
// which still let a SAME-build redeploy inherit last night's --now, and a
// manager-only deploy is a same-build redeploy because the version is the
// bridge artifact hash.
func TestUrgencyIsNeverInherited(t *testing.T) {
	for _, tc := range []struct {
		name              string
		firstVersion      string
		first             bool
		secondVersion     string
		second, wantImmed bool
	}{
		{"same build, later deploy is unhurried", "v1", true, "v1", false, false},
		{"retarget, later deploy is unhurried", "v1", true, "v2", false, false},
		{"same build, later deploy asks for now", "v1", false, "v1", true, true},
		{"retarget, later deploy asks for now", "v1", false, "v2", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := openStore(t)
			if _, err := s.RequestRollout(tc.firstVersion, tc.first); err != nil {
				t.Fatalf("first: %v", err)
			}
			got, err := s.RequestRollout(tc.secondVersion, tc.second)
			if err != nil {
				t.Fatalf("second: %v", err)
			}
			if got.Immediate != tc.wantImmed {
				t.Fatalf("immediate = %v, want %v — urgency must be the latest request's, never inherited",
					got.Immediate, tc.wantImmed)
			}
		})
	}
}

// A version is NOT a fencing token, because a version recurs: v1, v2, then v1
// again is a rollback — which is what keeping the previous binaries is for.
// Supersede reuses the row, so a worker holding the FIRST v1 must not be able
// to land its verdict on the second. The generation only ever goes up.
func TestAVersionThatRecursCannotLandAStaleVerdict(t *testing.T) {
	s := openStore(t)
	first, err := s.RequestRollout("v1", true)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := s.RequestRollout("v2", false); err != nil {
		t.Fatalf("second: %v", err)
	}
	// The rollback: back to v1, same row, same version string as `first`.
	if _, err := s.RequestRollout("v1", false); err != nil {
		t.Fatalf("rollback: %v", err)
	}

	ok, err := s.SetRolloutState(first.ID, first.Generation, store.RolloutFailed, "held at a")
	if err != nil {
		t.Fatalf("SetRolloutState: %v", err)
	}
	if ok {
		t.Fatal("a verdict from the first v1 landed on the rolled-back v1 — a rollout that was never tried is marked held")
	}
	if _, outstanding, _ := s.CurrentRollout(); !outstanding {
		t.Fatal("the rollback rollout was killed by a stale worker's verdict")
	}
}

// The row is re-read before the restart AND used. Driving systemd from the
// snapshot would act on an instance name the poll — which can take minutes
// across a couple of hundred tenants — watched change underneath it.
func TestTheRestartUsesTheFreshlyReadRow(t *testing.T) {
	s := openStore(t)
	seed(t, s, "a")
	p := &fakePoll{
		versions:     map[string]string{"a": "v1"},
		afterRestart: map[string]string{"a": "v2"},
		restarted:    map[string]bool{},
	}
	u := &fakeUnits{}
	w := newWorker(t, s, u, p)
	wireRestartMarking(u, p)
	// The instance is renamed between the poll and the restart.
	p.onSnapshot = func() {
		_ = s.SetTenantIdentity("a", "", "a-renamed")
	}
	if _, err := s.RequestRollout("v2", true); err != nil {
		t.Fatalf("RequestRollout: %v", err)
	}
	_ = w.Tick(context.Background())

	for _, v := range u.seen() {
		if v == "restart:a" {
			t.Fatalf("systemd was driven from the stale snapshot: %v", u.seen())
		}
	}
	if u.started("a-renamed") != 1 {
		t.Fatalf("the freshly read instance was not the one restarted: %v", u.seen())
	}
}
