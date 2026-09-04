package main

import (
	"net"
	"testing"

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
	if f := api.NewFanout(nil, "", store.NewMemory(), g.inReplayWindow); f == nil {
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
