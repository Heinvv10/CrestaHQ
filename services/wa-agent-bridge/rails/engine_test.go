package rails

import (
	"errors"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func engineConfig() Config {
	c := testConfig()
	c.QuietStartHour, c.QuietEndHour = 0, 0 // disabled for these tests
	c.Budgets = map[string]ConsumerBudget{"hermes": {PerHour: 100, PerDay: 500}}
	return c
}

func TestEngineAllowsAValidReply(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Minute))
	e := NewEngine(s, engineConfig())
	d := e.Evaluate(SendRequest{To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k1"})
	if !d.Allow {
		t.Fatalf("valid reply must be allowed, got %+v", d)
	}
}

// Rail order is observable: the kill switch must win over everything, so an
// operator hitting stop during an incident does not have to reason about which
// other rail might have refused first.
func TestKillSwitchWinsOverReplyOnly(t *testing.T) {
	s := store.NewMemory()
	s.SetKill(true)
	e := NewEngine(s, engineConfig())
	d := e.Evaluate(SendRequest{To: stranger, Consumer: "hermes", Now: now})
	if d.RefusedBy != RefusedKillSwitch {
		t.Fatalf("kill switch must be checked first, got %q", d.RefusedBy)
	}
}

func TestIdempotentSendReturnsOriginal(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Minute))
	// Seeded under the composed storage key: keys are namespaced per consumer.
	// Reserve then save, because that is the only sequence the Store accepts —
	// a save with no reservation it owns would fabricate a completed send.
	if _, reserved, err := s.ReserveIdempotency(IdempotencyStorageKey("hermes", "k-dup"), now); err != nil || !reserved {
		t.Fatalf("seed reservation failed: reserved=%v err=%v", reserved, err)
	}
	if err := s.SaveIdempotency(IdempotencyStorageKey("hermes", "k-dup"), "msg-original"); err != nil {
		t.Fatal(err)
	}
	e := NewEngine(s, engineConfig())

	d := e.Evaluate(SendRequest{To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k-dup"})
	if d.Allow {
		t.Fatal("a replayed idempotency key must not produce a second send")
	}
	if d.DuplicateOf != "msg-original" {
		t.Fatalf("want the original message id back, got %q", d.DuplicateOf)
	}
}

func TestMissingIdempotencyKeyIsRefused(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Minute))
	e := NewEngine(s, engineConfig())
	d := e.Evaluate(SendRequest{To: known, Consumer: "hermes", Now: now})
	if d.Allow {
		t.Fatal("a send with no idempotency key must be refused; retries would duplicate")
	}
}

// A rail that errors must never fall through to allow.
func TestStoreErrorFailsClosed(t *testing.T) {
	e := NewEngine(errStore{store.NewMemory()}, engineConfig())
	d := e.Evaluate(SendRequest{To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k"})
	if d.Allow {
		t.Fatal("a Store error must refuse, never allow")
	}
}

// errStore embeds a *pointer* to Memory: Memory's methods have pointer
// receivers, so embedding the value would not satisfy rails.Store and the
// test would fail to compile.
type errStore struct{ *store.Memory }

func (errStore) KillState() (bool, error) { return false, errBoom }

var errBoom = errors.New("boom")
