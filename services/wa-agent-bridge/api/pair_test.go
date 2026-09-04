package api

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

type stubPairer struct {
	code      string
	expiresAt time.Time
	pairing   bool
	connected bool
}

func (s stubPairer) Connected() bool { return s.connected }
func (s stubPairer) PairingCode() (string, time.Time, bool) {
	return s.code, s.expiresAt, s.pairing
}

func TestPairRequiresAToken(t *testing.T) {
	h := newHandlerWithConnection(t, store.NewMemory(), &stubSender{}, stubPairer{})
	rec := get(h, "/v1/pair")
	if rec.Code != 401 {
		t.Fatalf("the QR is a credential and must not be public: got %d", rec.Code)
	}
}

func TestPairServesTheLiveCode(t *testing.T) {
	exp := time.Now().Add(30 * time.Second).UTC().Truncate(time.Second)
	h := newHandlerWithConnection(t, store.NewMemory(), &stubSender{}, stubPairer{code: "2@abc", expiresAt: exp, pairing: true})

	rec := getAuthed(h, "/v1/pair", "tok-hermes")
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	out := decode(t, rec)
	if out["pairing"] != true || out["code"] != "2@abc" {
		t.Fatalf("live code not served: %v", out)
	}
}

func TestPairOmitsTheCodeWhenNotPairing(t *testing.T) {
	h := newHandlerWithConnection(t, store.NewMemory(), &stubSender{}, stubPairer{connected: true})
	rec := getAuthed(h, "/v1/pair", "tok-hermes")

	out := decode(t, rec)
	if out["pairing"] != false {
		t.Fatalf("want pairing false, got %v", out["pairing"])
	}
	if c, ok := out["code"]; ok {
		t.Fatalf("a non-pairing bridge must not emit a code field at all: %v", c)
	}
	if out["connected"] != true {
		t.Fatalf("want connected true, got %v", out["connected"])
	}
}
