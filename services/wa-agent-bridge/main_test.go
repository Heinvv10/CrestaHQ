package main

import (
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/api"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/wa"
)

// main() itself is not tested: it blocks on a signal, opens a real socket and
// pairs a real WhatsApp session. A test that faked those would read as
// evidence of a working process while proving nothing. What IS tested here is
// the two wiring properties that have a recorded failure mode behind them: the
// replay gate the fanout depends on, and the bind coming from the address
// config validated.

// An unset gate must claim we are replaying. The opposite default lets history
// replay wake every consumer after a reconnect.
func TestReplayGateFailsClosedBeforeClientIsSet(t *testing.T) {
	g := &clientHolder{}
	if !g.inReplayWindow() {
		t.Fatal("gate with no client answered false; inbound would be forwarded during history replay")
	}
}

// Once set, the gate must report the CLIENT's window, not its own default. A
// never-connected client is not in a replay window, so a gate still answering
// true would mean nothing is ever forwarded.
func TestReplayGateDelegatesToClientOnceSet(t *testing.T) {
	c, err := wa.NewClient(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatalf("wa.NewClient: %v", err)
	}
	defer c.Disconnect()

	g := &clientHolder{}
	g.set(c)
	if g.inReplayWindow() != c.InReplayWindow() {
		t.Fatalf("gate answered %v, client answers %v", g.inReplayWindow(), c.InReplayWindow())
	}
	if g.inReplayWindow() {
		t.Fatal("a never-connected client is not replaying, but the gate said it was")
	}
}

// api.NewFanout panics on a nil predicate. This asserts the method value main
// passes actually satisfies it — the panic is the guard, this is the proof the
// guard is not being tripped.
func TestFanoutAcceptsTheGatePredicate(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("NewFanout rejected the replay gate predicate: %v", r)
		}
	}()
	g := &clientHolder{}
	if f := api.NewFanout(nil, "", store.NewMemory(), g.inReplayWindow, g.connectedAt, 0); f == nil {
		t.Fatal("nil fanout")
	}
}

// The bind must be the address config.Load validated. If listenValidated ever
// re-derives an address, this catches it.
func TestListenValidatedBindsTheValidatedAddress(t *testing.T) {
	t.Setenv("LISTEN_ADDR", "127.0.0.1:0")
	t.Setenv("CONSUMERS", "hermes|tok|http://127.0.0.1:1/h|1|1")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	ln, err := listenValidated(cfg)
	if err != nil {
		t.Fatalf("listenValidated: %v", err)
	}
	defer ln.Close()

	wantHost, _, err := net.SplitHostPort(cfg.ListenAddr)
	if err != nil {
		t.Fatalf("split cfg addr: %v", err)
	}
	gotHost, _, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split listener addr: %v", err)
	}
	if gotHost != wantHost {
		t.Fatalf("bound %q, config validated %q", gotHost, wantHost)
	}
	if ip := net.ParseIP(gotHost); ip == nil || !ip.IsLoopback() {
		t.Fatalf("bound %q, which is not the loopback address config approved", gotHost)
	}
}

// The other half of the same property: a publicly-routable address never
// reaches a listener, because Load refuses to produce a config for it.
func TestPublicAddressNeverReachesAListener(t *testing.T) {
	t.Setenv("LISTEN_ADDR", "0.0.0.0:33020")
	t.Setenv("CONSUMERS", "hermes|tok|http://127.0.0.1:1/h|1|1")

	if _, err := config.Load(); err == nil {
		t.Fatal("config.Load accepted 0.0.0.0; main would then bind every interface behind a bearer token")
	}
}

// TestClientHolderReportsNotConnectedBeforeSet: the health endpoint's
// connection state must fail CLOSED in the construction gap, the opposite
// direction to inReplayWindow. Answering true there would have the endpoint
// whose whole job is catching a silently dead socket assert a socket that does
// not exist yet.
func TestClientHolderReportsNotConnectedBeforeSet(t *testing.T) {
	g := &clientHolder{}
	if g.Connected() {
		t.Fatal("before the client exists the holder must report NOT connected")
	}
}

// connectedAt is load-bearing and was untested: replacing its body with
// time.Now() passed every test in the repo while destroying the design. A
// watermark keyed on a value that changes every call re-snapshots on every
// message, which resets the catch-up counter — so maxCatchUpForward never
// fires and the flood protection is gone — and makes any out-of-order message
// look like history.
//
// The property that matters is STABILITY: the same connection must yield the
// same key. Asserting it with no client set is enough to kill that mutation
// and needs no whatsmeow socket.
func TestClientHolderConnectedAtIsStableAcrossCalls(t *testing.T) {
	g := &clientHolder{}
	first := g.connectedAt()
	time.Sleep(2 * time.Millisecond)
	second := g.connectedAt()

	if !first.Equal(second) {
		t.Fatalf("connectedAt must be stable for one connection, got %v then %v", first, second)
	}
	if !first.IsZero() {
		t.Fatalf("with no client set the key must be the zero time, got %v", first)
	}
}

// The send body grew from 64KiB to 12MiB, so a connection held open mid-read
// now holds megabytes rather than kilobytes. These timeouts are the bound on
// how long that can last, and a zero value is the same as not having them.
func TestServerBoundsHowLongARequestMayBeHeldOpen(t *testing.T) {
	srv := newServer(http.NewServeMux())

	if srv.ReadHeaderTimeout <= 0 {
		t.Fatal("ReadHeaderTimeout is unset; a client can hold a connection open indefinitely before sending headers")
	}
	if srv.ReadTimeout <= 0 {
		t.Fatal("ReadTimeout is unset; a stalled 12MiB body is held for as long as the client likes")
	}
	// ReadTimeout covers headers and body together, so it must be the larger
	// of the two or the header timeout is the only one that ever fires.
	if srv.ReadTimeout <= srv.ReadHeaderTimeout {
		t.Fatalf("ReadTimeout %v must exceed ReadHeaderTimeout %v", srv.ReadTimeout, srv.ReadHeaderTimeout)
	}
	// A genuine 12MiB upload over a slow link must still fit.
	if srv.ReadTimeout < 30*time.Second {
		t.Fatalf("ReadTimeout %v is too tight for a 12MiB body over a slow link", srv.ReadTimeout)
	}
	// WriteTimeout stays unset on purpose: a legitimate send spends most of
	// its life in the queue's pacing delay, so any survivable value is too
	// large to defend anything. See newServer.
	if srv.WriteTimeout != 0 {
		t.Fatalf("WriteTimeout = %v; setting it aborts sends that are working", srv.WriteTimeout)
	}
}
