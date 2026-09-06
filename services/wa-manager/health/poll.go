// Package health polls every tenant's bridge for its own view of its health,
// and reconciles what that poll observed back into the store.
//
// It never handles message content — it only reads counters and booleans off
// the bridge's admin API.
package health

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// Report is one tenant's health as observed by a single poll.
type Report struct {
	Reachable             bool
	Connected             bool
	Killed                bool
	Degraded              bool
	OutboundLast24h       int
	DailyCap              int
	LastInboundAgeSeconds *int

	// AllowlistCount is how many contacts have escaped the bridge's reply-only
	// rail. A POINTER, like LastInboundAgeSeconds and for the same reason: the
	// bridge sends null when it could not read its own allowlist, and "nobody
	// has escaped" must never render as the same fact as "we could not find
	// out" — the second is a safety rail gone blind.
	AllowlistCount *int

	// DroppedInbound counts messages this bridge received and never forwarded
	// because its catch-up cap was reached. It is customer messages nobody
	// will ever see — the bridge stores no message body, so this counter is
	// their only trace. Resets when the bridge reconnects.
	//
	// A POINTER, for the same reason as AllowlistCount above: a bridge that
	// omits the field has not told us it lost nothing, and rendering "none"
	// for it is a safety claim about something unobserved. That case is not
	// hypothetical — deploy-wa.sh rolls the manager and the bridges
	// separately, so during a rollout every older bridge omits it.
	DroppedInbound *int

	// Number is the phone number the bridge is paired to, digits only, empty
	// when the bridge is unpaired or did not report one. The bridge sends it
	// only to an authenticated caller, which the poller is.
	Number string

	// Version is the build the bridge PROCESS is running, empty when it did
	// not report one. It has to come from the process rather than from the
	// binary on disk: one binary is shared by every instance and is replaced
	// before any of them restart, so the file says "new" for forty bridges
	// that are all still running the old code. A rollout treats empty as
	// stale, which fails towards restarting rather than skipping.
	Version string

	// Incomplete says this tenant was never actually checked: the sweep's own
	// deadline ran out first. It is NOT Reachable=false, and collapsing the
	// two would be the worst kind of lie this screen can tell — "we ran out of
	// time" rendered as "this number is down" sends an operator to fix a
	// bridge that is fine, during the outage the screen exists to explain.
	Incomplete bool

	Problems []string
	Err      string
}

// bridgeHealthBody mirrors wa-agent-bridge's /v1/health response shape.
type bridgeHealthBody struct {
	Connected             bool     `json:"connected"`
	Killed                bool     `json:"killed"`
	Degraded              bool     `json:"degraded"`
	OutboundLast24h       int      `json:"outboundLast24h"`
	DailyCap              int      `json:"dailyCap"`
	LastInboundAgeSeconds *int     `json:"lastInboundAgeSeconds"`
	Allowlisted           *int     `json:"allowlisted"`
	DroppedInbound        *int     `json:"droppedInbound"`
	Number                string   `json:"number"`
	Version               string   `json:"version"`
	Problems              []string `json:"problems"`
}

// Poller polls every tenant's bridge concurrently, bounded by Concurrency.
type Poller struct {
	client *http.Client
	token  func(store.Tenant) string

	// BaseURL derives a bridge's admin base URL from its tenant row. A field
	// rather than a hardcoded scheme so tests can point it at an httptest
	// server; production leaves it at the default 127.0.0.1:<port> — the
	// bridge only ever listens on loopback.
	BaseURL func(store.Tenant) string

	// Concurrency bounds how many bridges are polled at once. Zero falls back
	// to defaultConcurrency — this service is built to ramp to a few hundred
	// numbers per host, and a zero value must bound the fan-out, not remove
	// the bound: an unlimited poll of 200 tenants opens 200 simultaneous
	// connections every cycle, a thundering herd against its own box.
	Concurrency int

	// reconcileFn overrides Reconcile in the background sweep. Test-only; see
	// (*Poller).reconciler.
	reconcileFn func(*store.Store, []store.Tenant, map[string]Report) error
}

// defaultConcurrency is used when Concurrency is left at its zero value.
const defaultConcurrency = 8

// New builds a Poller. token derives the per-tenant bearer token the bridge
// expects; it is never logged.
func New(client *http.Client, token func(store.Tenant) string) *Poller {
	return &Poller{
		client: client,
		token:  token,
		BaseURL: func(t store.Tenant) string {
			return fmt.Sprintf("http://127.0.0.1:%d", t.Port)
		},
	}
}

// Snapshot polls every tenant and returns one Report per tenant id.
func (p *Poller) Snapshot(ctx context.Context, tenants []store.Tenant) map[string]Report {
	out := make(map[string]Report, len(tenants))
	var mu sync.Mutex
	var wg sync.WaitGroup

	sem := make(chan struct{}, p.concurrency())
	for _, t := range tenants {
		wg.Add(1)
		go func(t store.Tenant) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			r := p.poll(ctx, t)
			mu.Lock()
			out[t.ID] = r
			mu.Unlock()
		}(t)
	}
	wg.Wait()
	return out
}

func (p *Poller) concurrency() int {
	if p.Concurrency > 0 {
		return p.Concurrency
	}
	return defaultConcurrency
}

// poll fetches one tenant's health. A response that arrived at all — any
// status code — is Reachable; only a transport-level failure (connection
// refused, timeout, DNS) is not. Conflating a degraded-but-answering bridge
// with a genuinely unreachable one would report the wrong cause during an
// incident, which is exactly the failure this endpoint exists to catch.
func (p *Poller) poll(ctx context.Context, t store.Tenant) Report {
	url := p.BaseURL(t) + "/v1/health"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		// url.Parse's error embeds the raw URL verbatim — including any query
		// string — so a malformed BaseURL must not surface err.Error() here.
		return Report{Reachable: false, Err: "building request: malformed base URL"}
	}
	req.Header.Set("Authorization", "Bearer "+p.token(t))

	resp, err := p.client.Do(req)
	if err != nil {
		// The caller's deadline expiring is not evidence about the bridge.
		// Checked first, because a cancelled request fails exactly like a
		// refused connection.
		if ctx.Err() != nil {
			return Report{Incomplete: true, Err: "not checked: the health sweep ran out of time"}
		}
		// A URL can carry a token in the query string on a misconfigured
		// BaseURL; err from net/http already includes the URL, so redact
		// rather than pass it straight into the report.
		return Report{Reachable: false, Err: "unreachable: request failed"}
	}
	defer resp.Body.Close()

	var body bridgeHealthBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Report{Reachable: true, Err: fmt.Sprintf("decoding response (status %d): %s", resp.StatusCode, err.Error())}
	}

	return Report{
		Reachable:             true,
		Connected:             body.Connected,
		Killed:                body.Killed,
		Degraded:              body.Degraded,
		OutboundLast24h:       body.OutboundLast24h,
		DailyCap:              body.DailyCap,
		LastInboundAgeSeconds: body.LastInboundAgeSeconds,
		AllowlistCount:        body.Allowlisted,
		DroppedInbound:        body.DroppedInbound,
		Number:                body.Number,
		Version:               body.Version,
		Problems:              body.Problems,
	}
}

// Reconcile writes what the poll observed back into tenant state, and records
// the transition once. A bridge whose kill switch is set and whose socket is
// down has been logged out — banned, or unlinked from the phone — and that is
// the moment an operator needs dated, not inferred later from a red card.
//
// Transitions are recorded only on CHANGE. Polling runs continuously; an event
// per poll would bury the one line that matters under thousands of duplicates.
//
// One tenant's failure never ends the sweep. Returning on the first error meant
// a single tenant destroyed mid-sweep — its row gone, so every write against it
// fails — stopped reconciliation for every tenant AFTER it in the list, for as
// long as it took someone to notice. Errors are collected and returned joined,
// so the failure is still loud and the remaining tenants are still reconciled.
func Reconcile(st *store.Store, tenants []store.Tenant, reports map[string]Report) error {
	var errs []error
	for _, t := range tenants {
		r, ok := reports[t.ID]
		if !ok || !r.Reachable {
			// A manager that cannot reach a bridge knows only that it cannot
			// see it, not that the number is dead. Writing state here would
			// mark every tenant logged-out during a manager restart or a
			// brief network blip — a worse failure than the one detected.
			continue
		}

		// Dropped inbound is checked BEFORE the switch, not after it. The
		// Connected branch `continue`s on the unchanged case — which is
		// precisely the healthy, steady-state sweep on which a drop is most
		// likely to be reported — so anything after the switch would be
		// skipped exactly when it matters.
		//
		// The bridge stores no message body, so this counter is the only trace
		// a customer message was received and never delivered; it lives in the
		// bridge process and restarts at zero when the bridge reconnects. An
		// event on the rising edge is what survives that reset, and the tenant
		// row is what survives a manager restart.
		//
		// It is a FLOOR on the loss, not a count of it. This polls a volatile
		// counter every pollEvery, so a rise that is fully undone by a
		// reconnect between two sweeps is never seen — and because catch-up
		// drops are bounded by a fixed cap, "dropped N, reconnected, dropped N
		// again" is a likely shape rather than a coincidence, and reads here
		// as observed == baseline: no event. Closing that needs the bridge to
		// report a connection epoch alongside the counter, so a reset is
		// detectable independently of the value. Until then, an event here
		// means messages were certainly lost; the absence of one does not mean
		// none were.
		if r.DroppedInbound != nil {
			observed := *r.DroppedInbound
			switch {
			case observed > t.LastDroppedInbound:
				detail := fmt.Sprintf(
					"%d more inbound message(s) dropped and never delivered (bridge reports %d this connection); not recoverable",
					observed-t.LastDroppedInbound, observed)
				if err := st.AppendEvent(t.ID, "dropped_inbound", detail); err != nil {
					// The baseline is NOT moved when the event failed to
					// land: leaving it behind means the next sweep tries
					// again, where advancing it would lose the only record
					// the drop ever happened. That makes the event
					// at-least-once — a store that fails here and recovers
					// writes the same line twice. Deliberate: a duplicated
					// "messages were lost" is harmless, a dropped one is the
					// failure this whole path exists to prevent.
					errs = append(errs, fmt.Errorf("reconcile %q: %w", t.ID, err))
				} else if err := st.SetLastDroppedInbound(t.ID, observed); err != nil {
					errs = append(errs, fmt.Errorf("reconcile %q: %w", t.ID, err))
				}
			case observed < t.LastDroppedInbound:
				// The counter went backwards, which means the bridge
				// reconnected and started counting again — NOT that the
				// messages were recovered. Take the new baseline silently; an
				// event here would announce a recovery that never happened.
				if err := st.SetLastDroppedInbound(t.ID, observed); err != nil {
					errs = append(errs, fmt.Errorf("reconcile %q: %w", t.ID, err))
				}
			}
			// observed == baseline writes NOTHING. Polling is continuous, and
			// an unconditional write here is an fsync-backed UPDATE per tenant
			// per sweep under synchronous=FULL — the same cost the Connected
			// branch below refuses to pay.
		}
		// A nil DroppedInbound is UNKNOWN, not zero. Two ways to get one: an
		// older bridge omits the field entirely — and deploy-wa.sh restarts
		// the manager first, then hands the fleet to a rollout, so that is the
		// normal state mid-rollout — and a current bridge reports it only when
		// its inbound-suppression dependency is wired. A current bridge with a
		// genuine zero sends 0, not nothing, so the pointer really does carry
		// the distinction. Neither an event nor a baseline write may come from
		// an unknown.

		switch {
		case r.Connected:
			// Only on CHANGE, like the logged_out branch below. A healthy
			// tenant is Connected on every single sweep, and an unconditional
			// write is an fsync-backed UPDATE per tenant per cycle under
			// synchronous=FULL — at 200 tenants on a 15s sweep, ~13 writes a
			// second recording state that is not changing.
			//
			// The number the bridge reports is the second thing that can
			// change here, and it is why this is not a bare state check.
			// Nothing ever wrote Tenant.Phone, so a number that was paired,
			// connected and taking messages still rendered as "not paired" —
			// a safety screen contradicting itself about the one fact an
			// operator uses to tell forty cards apart. It is learned once and
			// then left alone: SetTenantState never blanks a known phone, and
			// a bridge that reports no number cannot erase one.
			if t.State == store.StateRunning && (r.Number == "" || t.Phone != "") {
				continue
			}
			if err := st.SetTenantState(t.ID, store.StateRunning, r.Number); err != nil {
				errs = append(errs, fmt.Errorf("reconcile %q: %w", t.ID, err))
			}
		case r.Killed && !r.Connected:
			if t.State == store.StateLoggedOut {
				continue
			}
			if err := st.SetTenantState(t.ID, store.StateLoggedOut, ""); err != nil {
				// The event is the dated record a ban appeal needs, and it is
				// only worth writing against a row that took the state. A
				// tenant whose row is gone gets neither.
				errs = append(errs, fmt.Errorf("reconcile %q: %w", t.ID, err))
				continue
			}
			if err := st.AppendEvent(t.ID, "logged_out", "bridge reports killed and disconnected"); err != nil {
				errs = append(errs, fmt.Errorf("reconcile %q: %w", t.ID, err))
			}
		}
	}
	return errors.Join(errs...)
}
