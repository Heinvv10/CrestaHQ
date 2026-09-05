// Package rollout brings every bridge onto a new binary, one number at a time.
//
// A restart is not free. The bridge records inbound for five minutes after it
// connects and forwards none of it (wa.ReplayWindow), so every bounce is a
// five-minute hole in webhook delivery for a real customer's number. That one
// fact shapes everything here:
//
//   - Bridges already running the target build are never touched, so a deploy
//     that changed only the manager restarts nothing at all.
//   - One at a time, health-gated, never in parallel — forty numbers going
//     deaf together is an outage, not a deploy.
//   - Deferred to a configured overnight window unless the operator asks for
//     it now, so the holes land where the fewest customers are messaging.
//   - The first bridge that does not come back STOPS the rollout. Everything
//     already upgraded stays upgraded and everything else stays as it was: a
//     split fleet is a known, inspectable state, and bouncing the upgraded
//     ones back would spend more five-minute holes to buy uniformity during
//     an incident.
//
// A rollout is a standing intent — "every bridge should be running version X"
// — rather than a list of steps. The worker asks each bridge what it is
// actually running and acts on the answer, which makes it idempotent, safe to
// resume after a manager restart, and self-correcting for a bridge that was
// down while it ran.
package rollout

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// Units is the slice of systemd this package drives. Stop and Start rather
// than a single restart verb, so a failure between them is attributable.
type Units interface {
	Stop(instance string) error
	Start(instance string) error
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
	// StartHour, EndHour bound the window a deferred rollout may run in. The
	// window wraps midnight when StartHour > EndHour, which is the normal case.
	StartHour, EndHour int

	// Settle is how long a restarted bridge is given to report connected
	// before it counts as failed. Generous on purpose: whatsmeow reconnects
	// and then synchronises app state, and a bridge that took forty seconds is
	// not a bridge that is broken.
	Settle time.Duration
	// Between is the pause after a bridge comes back before the next one is
	// touched. It is not politeness — it keeps two consecutive five-minute
	// delivery holes from overlapping any more than they must.
	Between time.Duration

	// now and sleep are seams for tests. Nil means the real clock.
	now   func() time.Time
	sleep func(time.Duration)
}

const (
	defaultSettle  = 90 * time.Second
	defaultBetween = 15 * time.Second
)

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

func (w *Worker) between() time.Duration {
	if w.Between > 0 {
		return w.Between
	}
	return defaultBetween
}

// InWindow reports whether local time is inside the rollout window.
//
// A window of equal hours means "always", not "never". The alternative reading
// turns a plausible misconfiguration into a deferred rollout that never runs,
// which on the operator screen is indistinguishable from one nobody requested.
func (w *Worker) InWindow(t time.Time) bool {
	if w.StartHour == w.EndHour {
		return true
	}
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
// It checks on every tick rather than sleeping until the window opens, so a
// manager restarted at 23:00 picks up a rollout requested at 18:00 without
// anybody re-requesting it.
func (w *Worker) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := w.Tick(ctx); err != nil {
			log.Printf("WARNING rollout tick failed err=%v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Tick advances the outstanding rollout at most one step: it either does
// nothing, or it runs the whole rollout to completion or to its first failure.
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
	return w.execute(ctx, r)
}

// execute restarts every stale bridge in turn, stopping at the first failure.
func (w *Worker) execute(ctx context.Context, r store.Rollout) error {
	if err := w.Store.SetRolloutState(r.ID, store.RolloutRunning, ""); err != nil {
		return err
	}

	tenants, err := w.Store.ListTenants()
	if err != nil {
		return w.fail(r, fmt.Sprintf("could not list tenants: %v", err))
	}
	stale := w.stale(ctx, tenants, r.Version)
	if len(stale) == 0 {
		log.Printf("rollout %d: every bridge already runs %s", r.ID, r.Version)
		return w.Store.SetRolloutState(r.ID, store.RolloutDone, "every bridge already ran this build")
	}
	log.Printf("rollout %d: %d of %d bridges to restart onto %s", r.ID, len(stale), len(tenants), r.Version)

	done := 0
	for _, t := range stale {
		if ctx.Err() != nil {
			// A manager shutting down mid-rollout leaves the row running; the
			// next Tick after boot re-derives what is left from the fleet
			// itself, so nothing is lost by stopping here.
			return ctx.Err()
		}
		if err := w.restart(ctx, t, r.Version); err != nil {
			log.Printf("rollout %d HELD at %s after %d restarted: %v", r.ID, t.ID, done, err)
			return w.fail(r, fmt.Sprintf("held at %s after %d of %d restarted: %v",
				t.ID, done, len(stale), err))
		}
		done++
		_ = w.Store.AppendEvent(t.ID, "rolled", "restarted onto "+r.Version)
		if done < len(stale) {
			w.pause(w.between())
		}
	}
	log.Printf("rollout %d: %d bridges now run %s", r.ID, done, r.Version)
	return w.Store.SetRolloutState(r.ID, store.RolloutDone,
		fmt.Sprintf("%d bridges restarted onto this build", done))
}

// stale is every tenant whose bridge is not already running version.
//
// A bridge the manager cannot reach is INCLUDED. It is either down — in which
// case starting it is the right move and it is not costing a delivery hole
// anyway — or it is unreachable for a reason a restart is the standard remedy
// for. Skipping it would leave the fleet permanently split on the one number
// nobody can see.
func (w *Worker) stale(ctx context.Context, tenants []store.Tenant, version string) []store.Tenant {
	reports := w.Poll.Snapshot(ctx, tenants)
	var out []store.Tenant
	for _, t := range tenants {
		r, ok := reports[t.ID]
		if ok && r.Reachable && r.Version == version {
			continue
		}
		out = append(out, t)
	}
	return out
}

// restart bounces one bridge and waits for it to report connected.
//
// reset-failed first, for the same reason the operator screen's restart button
// does it: under Restart=always a bridge that has exited five times in ten
// minutes has tripped the unit's start limit, and systemd then refuses the
// start with an error that says nothing about the rate limit.
func (w *Worker) restart(ctx context.Context, t store.Tenant, version string) error {
	if err := w.Units.Stop(t.Instance); err != nil {
		return fmt.Errorf("stop: %w", err)
	}
	if err := w.Units.ResetFailed(t.Instance); err != nil {
		log.Printf("rollout reset-failed did not take instance=%s err=%v", t.Instance, err)
	}
	if err := w.Units.Start(t.Instance); err != nil {
		return fmt.Errorf("start: %w", err)
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
	if err := w.Store.SetRolloutState(r.ID, store.RolloutFailed, detail); err != nil {
		return err
	}
	return fmt.Errorf("rollout %d failed: %s", r.ID, detail)
}
