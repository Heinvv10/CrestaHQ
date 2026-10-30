// Package rollout brings every bridge onto a new binary, one number per tick.
//
// A restart is not free. The bridge records inbound for five minutes after it
// connects and forwards none of it (wa.ReplayWindow), so every bounce is a
// five-minute hole in webhook delivery for a real customer's number. That one
// fact shapes everything here:
//
//   - Bridges already running the target build are never touched, so a deploy
//     that changed only the manager restarts nothing at all.
//   - One per tick, health-gated, never in parallel — forty numbers going deaf
//     together is an outage, not a deploy.
//   - Deferred to a configured overnight window unless the operator asks for
//     it now, so the holes land where the fewest customers are messaging.
//   - The first bridge that does not come back STOPS the rollout. Everything
//     already upgraded stays upgraded and everything else stays as it was: a
//     split fleet is a known, inspectable state, and bouncing the upgraded
//     ones back would spend more five-minute holes to buy uniformity during
//     an incident.
//
// ONE BRIDGE PER TICK is the load-bearing decision, and it is what makes the
// rest simple. An earlier version ran the whole fleet inside a single call:
// the window was then checked once at the start, so a rollout that became
// eligible at 04:59 kept restarting numbers deep into the morning; a manager
// killed mid-run left work in flight that nothing owned; and a tenant created
// or destroyed while it ran was operating against a stale list. Doing one
// bridge per tick and re-deriving everything each time deletes all three: the
// clock is re-read every tick, there is never anything in flight to lose, and
// the fleet is whatever the store says it is right now.
//
// A rollout is therefore a standing intent — "every bridge should be running
// version X" — rather than a list of steps. The worker asks each bridge what
// it is actually running and acts on the answer, which makes it idempotent,
// safe to resume, and self-correcting for a bridge that was down while it ran.
package rollout

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// Units is the slice of systemd this package drives.
//
// Restart, not Stop-then-Start. The pair leaves a number STOPPED when the
// start half fails — down until a human notices, rather than deaf for five
// minutes — and leaves it stopped too if the manager is signalled between the
// two calls. systemd's own restart has no such gap, and a unit whose start
// fails is left `failed`, where the unit's Restart=always brings it back
// within the start limit.
type Units interface {
	Restart(instance string) error
	ResetFailed(instance string) error
}

// Snapshotter reports what every bridge is currently running. It is the health
// poller in production.
type Snapshotter interface {
	Snapshot(ctx context.Context, tenants []store.Tenant) map[string]health.Report
}

// Worker executes rollouts. One per process.
type Worker struct {
	Store *store.Store
	Units Units
	Poll  Snapshotter

	// Loc is the timezone the window hours are expressed in.
	Loc *time.Location
	// StartHour, EndHour bound the window a deferred rollout may restart
	// bridges in. The window wraps midnight when StartHour > EndHour, which is
	// the normal case. Equal hours are refused by config.Load rather than
	// given a meaning here; see InWindow.
	StartHour, EndHour int

	// Settle is how long a restarted bridge is given to report the new build
	// before it counts as failed. Generous on purpose: whatsmeow reconnects
	// and then synchronises app state, and a bridge that took forty seconds is
	// not a bridge that is broken.
	Settle time.Duration

	// now and sleep are seams for tests. Nil means the real clock.
	now   func() time.Time
	sleep func(time.Duration)
}

const defaultSettle = 90 * time.Second

func (w *Worker) clock() time.Time {
	if w.now != nil {
		return w.now()
	}
	return time.Now()
}

func (w *Worker) pause(d time.Duration) {
	if w.sleep != nil {
		w.sleep(d)
		return
	}
	time.Sleep(d)
}

func (w *Worker) settle() time.Duration {
	if w.Settle > 0 {
		return w.Settle
	}
	return defaultSettle
}

// InWindow reports whether local time is inside the rollout window.
//
// Equal hours cannot reach here: config.Load refuses them at boot. Reading
// them as "always" was fail-OPEN on the one control whose entire job is
// keeping outages out of business hours — `ROLLOUT_START_HOUR=0
// ROLLOUT_END_HOUR=0`, a plausible way to try to disable it, would instead
// have restarted every customer's number at ten in the morning. Reading them
// as "never" is fail-closed but silent, which is its own trap. Refusing the
// configuration is the only reading that cannot surprise anyone.
func (w *Worker) InWindow(t time.Time) bool {
	loc := w.Loc
	if loc == nil {
		loc = time.UTC
	}
	h := t.In(loc).Hour()
	if w.StartHour < w.EndHour {
		return h >= w.StartHour && h < w.EndHour
	}
	// Wraps midnight: 22:00-05:00 is >= 22 or < 5.
	return h >= w.StartHour || h < w.EndHour
}

// Run drives the outstanding rollout on a timer until ctx is cancelled.
//
// The interval doubles as the spacing between bridges: one restart per tick.
// It checks on every tick rather than sleeping until the window opens, so a
// manager restarted at 23:00 picks up a rollout requested at 18:00 without
// anybody re-requesting it.
func (w *Worker) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		// Wait BEFORE the first tick, unlike the health poller which sweeps
		// immediately. A restart-looping manager would otherwise bounce one
		// customer's number on every process start, ignoring the one-a-minute
		// pacing entirely — the pacing is the whole protection here, and a
		// rollout is never so urgent that a minute matters.
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if err := w.Tick(ctx); err != nil {
			log.Printf("WARNING rollout tick failed err=%v", err)
		}
	}
}

// Tick restarts AT MOST ONE bridge, or finishes the rollout when none are
// left. Everything it needs is re-derived from the store and from live health,
// so a tenant added, destroyed or re-paired since the last tick is simply part
// of the fleet this tick sees.
func (w *Worker) Tick(ctx context.Context) error {
	r, ok, err := w.Store.CurrentRollout()
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	if !r.Immediate && !w.InWindow(w.clock()) {
		return nil
	}
	if r.State != store.RolloutRunning {
		ok, err := w.Store.SetRolloutState(r.ID, r.Generation, store.RolloutRunning, "")
		if err != nil {
			return err
		}
		if !ok {
			return nil // superseded between the read and the write; next tick
		}
	}

	tenants, err := w.Store.ListTenants()
	if err != nil {
		return w.fail(r, fmt.Sprintf("could not list tenants: %v", err))
	}
	stale := w.stale(ctx, tenants, r.Version)
	if len(stale) == 0 {
		log.Printf("rollout %d: every eligible bridge runs %s", r.ID, r.Version)
		// Compare-and-set: a deploy that superseded this rollout while the
		// fleet was being polled must not have OUR verdict stamped on ITS
		// target. Dropping the write leaves the new rollout pending, which is
		// exactly right — the next tick evaluates it on its own terms.
		if ok, err := w.Store.SetRolloutState(r.ID, r.Generation, store.RolloutDone,
			"every eligible bridge runs this build"); err != nil || !ok {
			return err
		}
		return nil
	}

	t := stale[0]
	// Re-read the row immediately before acting on it. A tenant destroyed
	// since the snapshot has had its unit stopped, its directory removed and
	// its PORT RELEASED — so restarting it would fail the whole fleet upgrade
	// because one customer was offboarded during the window, and a health
	// probe against the freed port could be answered by whichever tenant was
	// provisioned onto it next. A tenant that has gone is simply not our work.
	// Re-read AND USE the row. Discarding it and restarting from the snapshot
	// would drive systemd with an Instance and probe a Port that the poll —
	// which can take minutes across a couple of hundred tenants — may have
	// watched change underneath it.
	fresh, err := w.Store.GetTenant(t.ID)
	if err != nil {
		log.Printf("rollout %d: %s is gone, skipping it", r.ID, t.ID)
		return nil
	}
	t = fresh
	log.Printf("rollout %d: restarting %s onto %s (%d left)", r.ID, t.ID, r.Version, len(stale))
	if err := w.restart(ctx, t, r.Version); err != nil {
		// A cancelled context is this process shutting down, not a bridge
		// failing. Marking the rollout failed here raised the loudest banner
		// on the operator screen over a false incident — and the deploy script
		// restarts the manager itself, so its own deploy could hold the
		// rollout it had just requested. The rollout stays outstanding and the
		// next tick, in this process or the next one, re-derives it.
		if ctx.Err() != nil {
			log.Printf("rollout %d: shutting down mid-restart of %s; it stays outstanding", r.ID, t.ID)
			return nil
		}
		// NOTHING else is consulted here. A bridge that did not come back is a
		// hold, full stop.
		//
		// An earlier version skipped a tenant that was no longer `running`,
		// reasoning that it could never satisfy the health gate. That check
		// was circular and catastrophic: the manager's own reconciler marks a
		// bridge `logged_out` DURING the settle precisely BECAUSE the restart
		// did not bring it back, so the failure signal became the excuse to
		// skip it. A fleet whose new binary could not hold a session was
		// walked down one number at a time and the rollout then reported
		// "every eligible bridge runs this build" with every number logged
		// out — an outage reported as a successful deploy.
		//
		// There was never a wedge to fix. Holding is loud, and a number that
		// is logged_out is not eligible for the NEXT rollout, so it cannot
		// block future deploys.
		log.Printf("rollout %d HELD at %s: %v", r.ID, t.ID, err)
		return w.fail(r, fmt.Sprintf("held at %s: %v", t.ID, err))
	}
	if err := w.Store.AppendEvent(t.ID, "rolled", "restarted onto "+r.Version); err != nil {
		log.Printf("WARNING rollout event not recorded tenant=%s err=%v", t.ID, err)
	}
	return nil
}

// stale is every tenant that should be restarted, in list order.
//
// ONLY tenants the store calls running are eligible. The others cannot satisfy
// the health gate and would wedge every future deploy: `logged_out` is a
// documented state a banned number sits in until a human re-pairs it,
// `pairing` and `provisioned` have no session yet, and `stopped` is a bridge
// an operator deliberately turned off — starting it would silently undo that
// decision. One banned number must not be able to stop the fleet from ever
// being upgraded again.
//
// Within that set, a bridge the manager cannot REACH is included. It is either
// down — in which case restarting it is the right move and it is not costing a
// delivery hole anyway — or it is unreachable for a reason a restart is the
// standard remedy for.
func (w *Worker) stale(ctx context.Context, tenants []store.Tenant, version string) []store.Tenant {
	var eligible []store.Tenant
	for _, t := range tenants {
		if t.State == store.StateRunning {
			eligible = append(eligible, t)
		}
	}
	if len(eligible) == 0 {
		return nil
	}
	reports := w.Poll.Snapshot(ctx, eligible)
	var out []store.Tenant
	for _, t := range eligible {
		r, ok := reports[t.ID]
		if ok && r.Reachable && r.Version == version {
			continue
		}
		out = append(out, t)
	}
	return out
}

// restart bounces one bridge and waits for it to report the new build.
//
// reset-failed first, for the same reason the operator screen's restart button
// does it: under Restart=always a bridge that has exited five times in ten
// minutes has tripped the unit's start limit, and systemd then refuses the
// start with an error that says nothing about the rate limit.
func (w *Worker) restart(ctx context.Context, t store.Tenant, version string) error {
	if err := w.Units.ResetFailed(t.Instance); err != nil {
		log.Printf("rollout reset-failed did not take instance=%s err=%v", t.Instance, err)
	}
	if err := w.Units.Restart(t.Instance); err != nil {
		return fmt.Errorf("restart: %w", err)
	}

	deadline := w.clock().Add(w.settle())
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		rep := w.Poll.Snapshot(ctx, []store.Tenant{t})[t.ID]
		// Connected AND running the build we asked for. Connected alone would
		// accept a bridge that came back on the old binary — which is what a
		// half-written install looks like, and is exactly the case this whole
		// rollout exists to detect.
		if rep.Reachable && rep.Connected && rep.Version == version {
			return nil
		}
		if !w.clock().Before(deadline) {
			return fmt.Errorf("did not come back on %s within %s (reachable=%v connected=%v version=%q)",
				version, w.settle(), rep.Reachable, rep.Connected, rep.Version)
		}
		w.pause(time.Second)
	}
}

func (w *Worker) fail(r store.Rollout, detail string) error {
	// Compare-and-set for the same reason the success path is: a failure
	// against the build we were rolling says nothing about a build that
	// superseded it mid-flight, and stamping it there would mark a rollout
	// failed that has not been tried.
	ok, err := w.Store.SetRolloutState(r.ID, r.Generation, store.RolloutFailed, detail)
	if err != nil {
		return err
	}
	if !ok {
		log.Printf("rollout %d was superseded while failing: %s", r.ID, detail)
		return nil
	}
	return fmt.Errorf("rollout %d failed: %s", r.ID, detail)
}
