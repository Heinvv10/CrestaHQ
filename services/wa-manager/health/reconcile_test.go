package health

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "mgr.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestReconcileMarksRunningWhenReachableAndConnected(t *testing.T) {
	s := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StatePairing}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}

	reports := map[string]Report{"t1": {Reachable: true, Connected: true}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	got, err := s.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.State != store.StateRunning {
		t.Fatalf("state = %q, want running", got.State)
	}
}

func TestReconcileMarksLoggedOutAndRecordsOneEvent(t *testing.T) {
	s := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StateRunning}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}

	reports := map[string]Report{"t1": {Reachable: true, Killed: true, Connected: false}}

	// First poll: killed + disconnected while stored state is still "running"
	// must transition to logged_out AND append exactly one event.
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile (1st): %v", err)
	}
	got, err := s.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.State != store.StateLoggedOut {
		t.Fatalf("state = %q, want logged_out", got.State)
	}
	events, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1: %+v", len(events), events)
	}

	// Second identical poll, now against the already-logged_out tenant row:
	// must NOT append a second event.
	if err := Reconcile(s, []store.Tenant{got}, reports); err != nil {
		t.Fatalf("Reconcile (2nd): %v", err)
	}
	events, err = s.ListEvents("t1", 10)
	if err != nil {
		t.Fatalf("ListEvents (2nd): %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("events after 2nd poll = %d, want still 1 (no duplicate)", len(events))
	}
}

func TestReconcileLeavesStateAloneWhenUnreachable(t *testing.T) {
	s := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StateRunning}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}

	// Killed:true is deliberate: this report would otherwise satisfy neither
	// switch case in Reconcile, so dropping the !Reachable guard would be
	// invisible to this test. With Killed:true, an unguarded Reconcile would
	// hit the logged_out branch — pinning the guard, not just exercising it.
	reports := map[string]Report{"t1": {Reachable: false, Killed: true, Err: "unreachable: request failed"}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	got, err := s.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.State != store.StateRunning {
		t.Fatalf("state = %q, want unchanged running (manager restart / blip must not log out a live tenant)", got.State)
	}
	events, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %d, want 0", len(events))
	}
}

// A tenant destroyed between the ListTenants that built the sweep and the
// write that reconciles it takes every write with it: its row is gone, so
// SetTenantState reports "no tenant". Returning on that first error abandoned
// every tenant AFTER it in the list — one deleted number silently stopped
// reconciling all the others, including the logged_out event that dates a ban.
//
// The failure must still be reported, and the rest of the sweep must still
// happen.
func TestReconcileContinuesPastOneTenantsFailure(t *testing.T) {
	s := openStore(t)
	tenants := []store.Tenant{
		{ID: "before", Instance: "before", Port: 1, State: store.StatePairing},
		{ID: "gone", Instance: "gone", Port: 2, State: store.StateRunning},
		{ID: "after", Instance: "after", Port: 3, State: store.StateRunning},
	}
	for _, tenant := range tenants {
		if err := s.CreateTenant(tenant); err != nil {
			t.Fatalf("CreateTenant %q: %v", tenant.ID, err)
		}
	}
	// Destroyed after the sweep listed it, exactly as a concurrent teardown
	// does. The sweep still holds the stale row.
	if err := s.DeleteTenant("gone"); err != nil {
		t.Fatalf("DeleteTenant: %v", err)
	}

	reports := map[string]Report{
		"before": {Reachable: true, Connected: true},
		"gone":   {Reachable: true, Killed: true, Connected: false},
		"after":  {Reachable: true, Killed: true, Connected: false},
	}
	err := Reconcile(s, tenants, reports)
	if err == nil {
		t.Fatal("a tenant whose row vanished mid-sweep must still be reported, not swallowed")
	}
	if !strings.Contains(err.Error(), "gone") {
		t.Fatalf("the error must name the tenant that failed; got %v", err)
	}

	// The tenant BEFORE the failure was reconciled, and — the point of this
	// test — so was the one after it.
	got, gotErr := s.GetTenant("before")
	if gotErr != nil {
		t.Fatalf("GetTenant before: %v", gotErr)
	}
	if got.State != store.StateRunning {
		t.Fatalf("tenant before the failure: state = %q, want running", got.State)
	}
	got, gotErr = s.GetTenant("after")
	if gotErr != nil {
		t.Fatalf("GetTenant after: %v", gotErr)
	}
	if got.State != store.StateLoggedOut {
		t.Fatalf("tenant after the failure was abandoned: state = %q, want logged_out", got.State)
	}
	events, gotErr := s.ListEvents("after", 10)
	if gotErr != nil {
		t.Fatalf("ListEvents: %v", gotErr)
	}
	if len(events) != 1 {
		t.Fatalf("the logged_out event after the failure = %d, want 1", len(events))
	}
}

// The Connected branch wrote on EVERY sweep. A healthy tenant is connected
// every time, so under synchronous=FULL that is one fsync-backed UPDATE per
// tenant per cycle — ~13 writes a second at 200 tenants — recording state that
// is not changing. Only a CHANGE may write, exactly as the logged_out branch
// already did.
//
// The write is observed through updated_unix, which SetTenantState stamps with
// the current time. The row is seeded far enough in the past that a write is
// unmistakable rather than a second-boundary coin flip.
func TestReconcileDoesNotRewriteAnAlreadyRunningTenant(t *testing.T) {
	s := openStore(t)
	long := time.Now().Add(-100 * 24 * time.Hour).Truncate(time.Second)
	running := store.Tenant{ID: "steady", Instance: "steady", Port: 1,
		State: store.StateRunning, CreatedAt: long}
	pairing := store.Tenant{ID: "fresh", Instance: "fresh", Port: 2,
		State: store.StatePairing, CreatedAt: long}
	for _, tenant := range []store.Tenant{running, pairing} {
		if err := s.CreateTenant(tenant); err != nil {
			t.Fatalf("CreateTenant %q: %v", tenant.ID, err)
		}
	}

	reports := map[string]Report{
		"steady": {Reachable: true, Connected: true},
		"fresh":  {Reachable: true, Connected: true},
	}
	if err := Reconcile(s, []store.Tenant{running, pairing}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	got, err := s.GetTenant("steady")
	if err != nil {
		t.Fatalf("GetTenant steady: %v", err)
	}
	if !got.UpdatedAt.Equal(long) {
		t.Fatalf("an already-running tenant was rewritten (updated_unix %v -> %v); "+
			"only a state CHANGE may write", long, got.UpdatedAt)
	}

	// The other half: a tenant whose state IS changing must still be written,
	// so the guard cannot be satisfied by never writing at all.
	got, err = s.GetTenant("fresh")
	if err != nil {
		t.Fatalf("GetTenant fresh: %v", err)
	}
	if got.State != store.StateRunning {
		t.Fatalf("a tenant that became connected was not written: state = %q", got.State)
	}
	if got.UpdatedAt.Equal(long) {
		t.Fatal("a real transition left updated_unix untouched")
	}
}

// The card said "not paired" about a number that was connected and taking
// messages, because Tenant.Phone was never written by anything. Reconcile is
// where the manager learns it: the bridge reports its own number to an
// authenticated caller, and the poller is one.
func TestReconcileRecordsTheNumberTheBridgeReports(t *testing.T) {
	s := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StatePairing}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}

	reports := map[string]Report{"t1": {Reachable: true, Connected: true, Number: "27821234567"}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	got, err := s.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.Phone != "27821234567" {
		t.Fatalf("phone = %q, want the number the bridge reported", got.Phone)
	}
}

// The tenant this was actually found on: already running for hours, its number
// never recorded. An "only on change of state" reconcile would leave that card
// contradicting itself forever, so a known-running tenant with no phone must
// still take the number.
func TestReconcileBackfillsTheNumberOnAnAlreadyRunningTenant(t *testing.T) {
	s := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StateRunning}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}

	reports := map[string]Report{"t1": {Reachable: true, Connected: true, Number: "27821234567"}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	got, err := s.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.Phone != "27821234567" {
		t.Fatalf("phone = %q, want the number backfilled onto a running tenant", got.Phone)
	}
}

// A bridge that reports no number — restarted and not yet paired, or an older
// build — must not erase a number already known. The write path is deliberately
// one-way for exactly this reason.
func TestReconcileNeverErasesAKnownNumber(t *testing.T) {
	s := openStore(t)
	tenant := store.Tenant{ID: "t1", Instance: "t1", Port: 1, State: store.StateRunning, Phone: "27821234567"}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}

	reports := map[string]Report{"t1": {Reachable: true, Connected: true}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	got, err := s.GetTenant("t1")
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if got.Phone != "27821234567" {
		t.Fatalf("phone = %q, want the known number left alone", got.Phone)
	}
}

// intp is a local helper: Report.DroppedInbound is a pointer precisely so that
// "unknown" and "zero" cannot be spelled the same way, so the tests below have
// to be explicit about which one they mean.
func intp(n int) *int { return &n }

// steadyTenant is a tenant that is already running with its number known, so
// the Connected branch of Reconcile writes nothing. Any updated_unix movement
// observed by these tests therefore came from the dropped-inbound path alone.
// created is far in the past so a write is unmistakable rather than a
// second-boundary coin flip.
func steadyTenant(t *testing.T, s *store.Store, id string, baseline int) (store.Tenant, time.Time) {
	t.Helper()
	created := time.Now().Add(-100 * 24 * time.Hour).Truncate(time.Second)
	tenant := store.Tenant{
		ID: id, Instance: id, Port: 1, State: store.StateRunning,
		Phone: "27821234567", CreatedAt: created, LastDroppedInbound: baseline,
	}
	if err := s.CreateTenant(tenant); err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}
	return tenant, created
}

func reload(t *testing.T, s *store.Store, id string) store.Tenant {
	t.Helper()
	got, err := s.GetTenant(id)
	if err != nil {
		t.Fatalf("GetTenant %q: %v", id, err)
	}
	return got
}

func onlyEvent(t *testing.T, s *store.Store, id string) store.Event {
	t.Helper()
	events, err := s.ListEvents(id, 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want exactly 1: %+v", len(events), events)
	}
	return events[0]
}

// The whole point of the feature: a bridge that drops customer messages at
// 02:00 and reconnects at 03:00 used to leave nothing behind but a journald
// line, because the counter is the only trace (no body is stored anywhere) and
// it resets on reconnect. The rising edge must be recorded.
func TestReconcileRecordsARiseInDroppedInbound(t *testing.T) {
	s := openStore(t)
	tenant, _ := steadyTenant(t, s, "t1", 2)

	reports := map[string]Report{"t1": {Reachable: true, Connected: true,
		Number: "27821234567", DroppedInbound: intp(5)}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	ev := onlyEvent(t, s, "t1")
	if ev.Kind != "dropped_inbound" {
		t.Fatalf("kind = %q, want dropped_inbound", ev.Kind)
	}
	// The DELTA is 3 (5 observed against a baseline of 2) and the TOTAL is 5.
	// Both must appear: the delta alone hides how deep the hole is, and the
	// total alone re-reports messages already recorded.
	if !strings.Contains(ev.Detail, "3 more") {
		t.Fatalf("detail must report the delta of 3; got %q", ev.Detail)
	}
	if !strings.Contains(ev.Detail, "bridge reports 5") {
		t.Fatalf("detail must report the running total of 5; got %q", ev.Detail)
	}
	// Nothing here retries or redelivers, so the detail must not imply it.
	if !strings.Contains(ev.Detail, "not recoverable") {
		t.Fatalf("detail must not imply the loss was undone; got %q", ev.Detail)
	}

	if got := reload(t, s, "t1"); got.LastDroppedInbound != 5 {
		t.Fatalf("baseline = %d, want 5", got.LastDroppedInbound)
	}
}

// An unchanged count must write NOTHING — not just no event. Polling is
// continuous, so an unconditional UPDATE here is an fsync per tenant per sweep
// under synchronous=FULL, the exact cost the Connected branch already refuses.
func TestReconcileWritesNothingWhenDroppedInboundIsUnchanged(t *testing.T) {
	s := openStore(t)
	tenant, created := steadyTenant(t, s, "t1", 5)

	reports := map[string]Report{"t1": {Reachable: true, Connected: true,
		Number: "27821234567", DroppedInbound: intp(5)}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	events, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %d, want 0 for an unchanged count: %+v", len(events), events)
	}
	got := reload(t, s, "t1")
	if !got.UpdatedAt.Equal(created) {
		t.Fatalf("an unchanged count wrote the row anyway (updated_unix %v -> %v); "+
			"only a CHANGE may write", created, got.UpdatedAt)
	}
	if got.LastDroppedInbound != 5 {
		t.Fatalf("baseline = %d, want 5", got.LastDroppedInbound)
	}
}

// The counter going backwards means the bridge RECONNECTED and started
// counting again. The messages are still lost, so there is no event — but the
// baseline must follow the counter down, or a later real drop from the new
// lower count would be invisible.
func TestReconcileTakesALoweredCounterAsANewBaselineWithoutAnEvent(t *testing.T) {
	s := openStore(t)
	tenant, _ := steadyTenant(t, s, "t1", 5)

	reports := map[string]Report{"t1": {Reachable: true, Connected: true,
		Number: "27821234567", DroppedInbound: intp(1)}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	events, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("a reconnect is not a recovery and must record no event; got %+v", events)
	}
	got := reload(t, s, "t1")
	if got.LastDroppedInbound != 1 {
		t.Fatalf("baseline = %d, want 1 (the counter restarted)", got.LastDroppedInbound)
	}

	// A rise from the NEW, lower baseline is a real drop and must be caught.
	reports["t1"] = Report{Reachable: true, Connected: true,
		Number: "27821234567", DroppedInbound: intp(3)}
	if err := Reconcile(s, []store.Tenant{got}, reports); err != nil {
		t.Fatalf("Reconcile (2nd): %v", err)
	}
	ev := onlyEvent(t, s, "t1")
	if !strings.Contains(ev.Detail, "2 more") || !strings.Contains(ev.Detail, "bridge reports 3") {
		t.Fatalf("rise from the lowered baseline mis-reported: %q", ev.Detail)
	}
}

// nil is UNKNOWN, not zero. An older bridge omits the field entirely, and
// deploy-wa.sh rolls the manager and the bridges separately — so during every
// rollout this is the normal case. Treating it as zero would either invent a
// drop or, worse, reset the baseline and lose the next real one.
func TestReconcileIgnoresAnUnknownDroppedInboundCount(t *testing.T) {
	s := openStore(t)
	tenant, created := steadyTenant(t, s, "t1", 5)

	reports := map[string]Report{"t1": {Reachable: true, Connected: true,
		Number: "27821234567", DroppedInbound: nil}}
	if err := Reconcile(s, []store.Tenant{tenant}, reports); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	events, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("unknown must record nothing; got %+v", events)
	}
	got := reload(t, s, "t1")
	if got.LastDroppedInbound != 5 {
		t.Fatalf("baseline = %d, want 5 untouched by an unknown count", got.LastDroppedInbound)
	}
	if !got.UpdatedAt.Equal(created) {
		t.Fatalf("unknown wrote the row (updated_unix %v -> %v)", created, got.UpdatedAt)
	}

	// And the baseline it preserved must still be the one a later real count
	// is compared against.
	reports["t1"] = Report{Reachable: true, Connected: true,
		Number: "27821234567", DroppedInbound: intp(7)}
	if err := Reconcile(s, []store.Tenant{got}, reports); err != nil {
		t.Fatalf("Reconcile (2nd): %v", err)
	}
	ev := onlyEvent(t, s, "t1")
	if !strings.Contains(ev.Detail, "2 more") || !strings.Contains(ev.Detail, "bridge reports 7") {
		t.Fatalf("the preserved baseline was not used: %q", ev.Detail)
	}
}

// A store whose file path the caller knows, so a test can reach the database
// behind the Store's back.
func openStoreAt(t *testing.T) (*store.Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mgr.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s, path
}

// The baseline must NOT advance when the event failed to land.
//
// This is the one branch whose comment promises the most and which nothing
// pinned: a blind review mutated it to advance the baseline anyway and every
// test still passed. Advancing it would mark the drop as recorded when the only
// record of it never got written — the loss would be silently forgotten, which
// is the exact failure this whole change exists to prevent.
//
// The fault is injected by dropping the `events` table on a second connection.
// That fails AppendEvent while leaving SetLastDroppedInbound working, which is
// what makes the two writes distinguishable — closing the database would fail
// both and the test would pass for the wrong reason.
func TestReconcileKeepsTheBaselineWhenTheEventCannotBeRecorded(t *testing.T) {
	s, path := openStoreAt(t)
	tenant, _ := steadyTenant(t, s, "t1", 2)

	raw, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer raw.Close()
	if _, err := raw.Exec(`DROP TABLE events`); err != nil {
		t.Fatalf("DROP TABLE events: %v", err)
	}

	five := 5
	err = Reconcile(s, []store.Tenant{tenant}, map[string]Report{
		"t1": {Reachable: true, Connected: true, Number: tenant.Phone, DroppedInbound: &five},
	})
	if err == nil {
		t.Fatal("a failed AppendEvent must be reported, not swallowed")
	}

	if got := reload(t, s, "t1").LastDroppedInbound; got != 2 {
		t.Fatalf("baseline = %d, want 2 left behind so the next sweep retries; "+
			"advancing it marks the drop recorded when nothing recorded it", got)
	}
}
