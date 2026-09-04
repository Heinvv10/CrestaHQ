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
	fanout := api.NewFanout(cfg.Consumers, cfg.OwnerJID, st, gate.inReplayWindow)

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
		Connection: gate,
	})

	ln, err := listenValidated(cfg)
	if err != nil {
		log.Fatalf("listen %s: %v", cfg.ListenAddr, err)
	}
	srv := &http.Server{Handler: handler}
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
	// inbound arrives, then wait for the webhook deliveries already in flight.
	// shutdownBudget (35s) outlasts the 30s send-queue timeout so an in-flight
	// send gets to finish or time out on its own terms before Disconnect pulls
	// the socket out from under it. TimeoutStopSec=60 in the systemd unit
	// funds this 35s drain plus fanout.Wait()'s own worst case (bounded by the
	// webhook http.Client's 10s timeout), with headroom before SIGKILL.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownBudget)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("WARNING http shutdown: %v", err)
	}
	client.Disconnect()
	fanout.Wait()
}
