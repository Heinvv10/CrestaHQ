// Command wa-agent-bridge pairs to a dedicated WhatsApp number and exposes it
// to registered consumers behind a set of safety rails.
//
// This file is wiring only. Decisions live in rails/, persistence in store/,
// the socket in wa/, and HTTP in api/. Keeping main small is deliberate: the
// sibling bridge's main.go reached 118 KB and became the reason nothing in it
// could be tested.
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/api"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/wa"
)

// version is the build this binary was cut from, stamped by the deploy script
// with `-ldflags "-X main.version=<sha>"`. It stays "dev" in a plain `go build`,
// which is the honest answer for a hand-built binary and is deliberately not
// silence: a rollout compares this against the sha it is rolling out, so a
// hand-built bridge reads as stale and gets restarted rather than skipped.
//
// The manager reads it to decide which bridges a rollout still has to restart.
var version = "dev"

// clientHolder breaks the construction cycle between the WhatsApp client and
// everything constructed before it — the fanout and the HTTP API.
//
// api.NewFanout requires a non-nil replay predicate at construction time, and
// wa.NewClient requires the fanout's Deliver at construction time. One of the
// two has to exist before the other does. Handing NewFanout a closure over a
// plain `var client *wa.Client` (the obvious fix) is a data race: main writes
// that variable while the whatsmeow event goroutine reads it through the
// closure. This holder makes the handoff explicit and race-free.
//
// Before the client is set it answers TRUE — "assume we are replaying". That
// is the fail-closed direction: inbound is still recorded (Fanout records
// before it consults this), it simply is not forwarded, so the worst case is a
// message a consumer never sees. Answering false in that gap would let history
// replay wake every consumer, which is the sibling bridge's duplicate-ack
// outage. The gap is only the microseconds between NewFanout and set(); the
// socket is not connected until after.
// It serves BOTH readers rather than growing a second handoff: the fanout's
// replay predicate and the health endpoint's connection state have the same
// ordering problem and the same race, so they get the same answer.
type clientHolder struct {
	client atomic.Pointer[wa.Client]
}

func (g *clientHolder) set(c *wa.Client) { g.client.Store(c) }

// connectedAt is the fanout's watermark key: it re-snapshots the watermark
// once per connection. Before the client is set it returns the zero time,
// which is stable and therefore snapshots nothing — the fanout's first real
// refresh happens on the first message after the socket connects, which is
// also the first moment a watermark could be meaningful.
func (g *clientHolder) connectedAt() time.Time {
	c := g.client.Load()
	if c == nil {
		return time.Time{}
	}
	return c.ConnectedAt()
}

func (g *clientHolder) inReplayWindow() bool {
	c := g.client.Load()
	if c == nil {
		return true
	}
	return c.InReplayWindow()
}

// Connected satisfies api.ConnectionState. Before the client is set it answers
// FALSE — the fail-closed direction here, and the opposite of
// inReplayWindow's: claiming a connection we cannot observe is the silent
// failure the health endpoint exists to catch, while claiming a replay we
// cannot observe merely withholds a forward.
func (g *clientHolder) Connected() bool {
	c := g.client.Load()
	if c == nil {
		return false
	}
	return c.Connected()
}

// PairingCode satisfies api.ConnectionState. Before the client is set there is
// nothing to pair — the same fail-closed direction as Connected.
func (g *clientHolder) PairingCode() (string, time.Time, bool) {
	c := g.client.Load()
	if c == nil {
		return "", time.Time{}, false
	}
	return c.PairingCode()
}

// Number satisfies api.ConnectionState. Before the client is set there is no
// session and so no number — the same fail-closed direction as Connected.
func (g *clientHolder) Number() string {
	c := g.client.Load()
	if c == nil {
		return ""
	}
	return c.Number()
}

// listenValidated binds the address config.Load already validated.
//
// cfg.ListenAddr is the ONLY source. config.Load refuses anything that is not
// loopback or tailnet (unless ALLOW_PUBLIC_BIND=1), and that check is worth
// nothing unless the process actually binds what was checked — so this must
// never re-derive an address, consult the environment a second time, or fall
// back to a default. The returned listener is handed to http.Server.Serve with
// the server's own Addr field left empty, so there is no second address in the
// program for a typo to hide in.
func listenValidated(cfg config.Config) (net.Listener, error) {
	return net.Listen("tcp", cfg.ListenAddr)
}

// newServer wires the HTTP server's timeouts. Split out of main so they can be
// asserted: a timeout that silently reverts to zero is indistinguishable from
// one that was never added.
func newServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler: handler,
		// Both bound how long a client may hold a connection — and now a
		// multi-megabyte read buffer — without finishing its request. Their
		// absence was a pre-existing gap that only started to matter when
		// /v1/send grew from a 64KiB text body to a 12MiB one carrying an
		// attachment: a slow or stalled body used to cost kilobytes for as
		// long as the client cared to hold it, and now costs megabytes.
		//
		// ReadTimeout covers headers AND body, so it has to admit a genuine
		// 12MiB upload from the CRM over a slow link; 60s is generous for that
		// and still finite, which is the whole point.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		// WriteTimeout is deliberately NOT set. It bounds the time from the
		// end of the request read to the end of the response write, and a
		// legitimate send spends most of that window inside the queue's
		// pacing delay plus its send timeout. Any value large enough not to
		// kill a real send is too large to be a defence, and a value smaller
		// than that would abort sends that are working.
	}
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	st, err := store.OpenSQLite(cfg.DBPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	engine := rails.NewEngine(st, cfg.Rails)

	gate := &clientHolder{}
	fanout := api.NewFanout(cfg.Consumers, cfg.OwnerJID, st, gate.inReplayWindow, gate.connectedAt)

	client, err := wa.NewClient(
		cfg.SessionDir,
		fanout.Deliver,
		func() {
			// The number is gone. Refuse outbound until a human re-pairs, and
			// make sure the state survives a restart — an in-memory flag would
			// clear on the systemd restart that follows.
			//
			// Lifting this afterwards needs an ADMIN consumer token; see the
			// re-pair section of README.md.
			if err := st.SetKill(true); err != nil {
				log.Printf("WARNING could not set kill after LoggedOut: %v", err)
			}
		},
	)
	if err != nil {
		log.Fatalf("whatsapp client: %v", err)
	}
	// Must happen before Connect: from here on inbound can arrive, and until
	// the gate holds the client it answers "replaying" and forwards nothing.
	gate.set(client)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := client.Connect(ctx); err != nil {
		log.Fatalf("connect: %v", err)
	}

	// shutdownBudget bounds the HTTP graceful drain on SIGTERM (see below). It
	// must exceed QueueOpts.Timeout: an in-flight send holds the queue open
	// until it times out, and letting srv.Shutdown give up first would have
	// client.Disconnect() close the WhatsApp socket out from under that send
	// instead of it finishing or timing out cleanly.
	const shutdownBudget = 35 * time.Second

	// fanoutDrainBudget bounds the second step, the inbound delivery drain.
	//
	// The worst case is not one delivery but a BACKLOG of them, so it is worth
	// being exact about why the backlog drains in parallel. Drain stops intake,
	// then cancels every in-flight download and media POST. The (at most two)
	// deliveries holding a media slot finish their abandoned file work — the
	// HTTP phase stops on cancel; whatsmeow's HMAC, decrypt and hash take no
	// context but are bounded by the 16MiB cap to a fraction of a second — and
	// then post text-only. Every delivery still WAITING for a slot stops waiting
	// and posts text-only at once, without a slot, concurrently with the rest.
	// So the backlog costs one text POST per consumer in parallel, each on the
	// 10s client, plus one fallback for the slot holders: ~20s whatever the
	// backlog size. 25s covers that; anything still running after it is logged
	// and abandoned rather than holding systemd past TimeoutStopSec, which
	// would SIGKILL everything including the posts about to succeed.
	const fanoutDrainBudget = 25 * time.Second

	// The one send path. Everything outbound goes through this queue so that
	// exactly one message is on the socket at a time and the pacing rails
	// cannot be bypassed.
	queue := wa.NewQueue(client, wa.QueueOpts{
		MinGap:       2 * time.Second,
		PerRuneDelay: 20 * time.Millisecond,
		Jitter:       1500 * time.Millisecond,
		Timeout:      30 * time.Second, // shutdownBudget above must stay > this
	})

	handler := api.New(api.Deps{
		Engine:    engine,
		Store:     st,
		Sender:    queue,
		Consumers: cfg.Consumers,
		Now:       time.Now,
		// Set after this call, via gate.set(client) above; the holder answers
		// "not connected" until then.
		Connection:         gate,
		InboundSuppression: fanout.SuppressedInbound,
		InboundDropAge:     fanout.InboundDropAge,
		Version:            version,
	})

	ln, err := listenValidated(cfg)
	if err != nil {
		log.Fatalf("listen %s: %v", cfg.ListenAddr, err)
	}
	srv := newServer(handler)
	go func() {
		log.Printf("listening on %s", ln.Addr())
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down")

	// Order matters: stop accepting sends, then close the socket so no further
	// inbound arrives, then drain the webhook deliveries already in flight.
	// shutdownBudget (35s) outlasts the 30s send-queue timeout so an in-flight
	// send gets to finish or time out on its own terms before Disconnect pulls
	// the socket out from under it. client.Disconnect then waits up to 5s for
	// whatsmeow's handler queue to finish (unlockedDisconnect, client.go:715).
	// It can return with a handler still running — after that 5s, or at once
	// when handlerQueueLoop exits mid-node on connCtx.Done (client.go:936-939)
	// — and that handler can call fanout.Deliver during the drain, which is why
	// Deliver refuses new work once Drain has begun. fanout.Drain
	// then gets fanoutDrainBudget (25s): it abandons file work immediately and
	// the messages go text-only. Worst case end to end is 35s + 5s + 25s = 65s;
	// TimeoutStopSec=90 in the systemd unit leaves 25s of headroom before
	// SIGKILL. An unbounded Wait here would let
	// one in-flight 16MiB attachment (120s download + 120s POST) run straight
	// into SIGKILL and lose every delivery behind it, message and all.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownBudget)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("WARNING http shutdown: %v", err)
	}
	client.Disconnect()
	drainCtx, drainCancel := context.WithTimeout(context.Background(), fanoutDrainBudget)
	defer drainCancel()
	if err := fanout.Drain(drainCtx); err != nil {
		log.Printf("WARNING %v", err)
	}
}
