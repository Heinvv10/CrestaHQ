package health

import (
	"context"
	"log"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// Run polls every tenant on a timer and reconciles what it sees into the store,
// until ctx is cancelled.
//
// Without it, Reconcile has no caller: the API and the UI both Snapshot on
// demand, but neither writes the result back. A number that logged out at 02:00
// would then be recorded as logged out whenever an operator next happened to
// open the screen, and the `logged_out` event — the dated record of when the
// number actually died, which is the one thing a WhatsApp ban appeal needs —
// would carry the wrong time.
//
// It sweeps ONCE before the first tick. A manager restarted mid-incident is
// exactly when someone is watching, and a first interval spent reporting
// "unknown" is the screen being useless precisely when it is needed.
//
// A failing sweep is logged and the loop continues. Returning on error would
// mean one unreadable store or one broken bridge ends reconciliation for the
// life of the process — a monitor that dies silently is worse than the failure
// it was watching for.
func (p *Poller) Run(ctx context.Context, st *store.Store, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		p.sweep(ctx, st)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (p *Poller) sweep(ctx context.Context, st *store.Store) {
	tenants, err := st.ListTenants()
	if err != nil {
		// Nothing to reconcile against, and a list returned alongside an error
		// is a list we know is incomplete. Both facts say stop here.
		log.Printf("WARNING health sweep could not list tenants err=%v", err)
		return
	}
	if len(tenants) == 0 {
		return
	}
	if err := p.reconciler()(st, tenants, p.Snapshot(ctx, tenants)); err != nil {
		log.Printf("WARNING health sweep could not reconcile err=%v", err)
	}
}

// reconciler is a seam, not a strategy. Its only job is to let a test drive the
// branch above — a store write failing mid-sweep — because that branch's whole
// purpose is that the loop KEEPS GOING, and a guard nothing can exercise is one
// a future edit turns into a `return` with nothing going red. A deliberate
// break confirmed exactly that before this existed.
//
// Nothing sets reconcileFn in production; nil means Reconcile.
func (p *Poller) reconciler() func(*store.Store, []store.Tenant, map[string]Report) error {
	if p.reconcileFn != nil {
		return p.reconcileFn
	}
	return Reconcile
}
