package api

import (
	"strings"
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

// A send-capable token is the one an off-box consumer holds — LeadStack, say.
// If that token could read the QR, anyone holding it could link their own
// device to the customer's number during a re-pair window, which is a strictly
// larger privilege than the sending the token was issued for.
func TestPairRefusesANonAdminConsumer(t *testing.T) {
	exp := time.Now().Add(30 * time.Second)
	h := newHandlerWithConnection(t, store.NewMemory(), &stubSender{}, stubPairer{code: "2@abc", expiresAt: exp, pairing: true})

	rec := getAuthed(h, "/v1/pair", "tok-hermes")
	if rec.Code != 403 {
		t.Fatalf("a consumer token must not reach the QR: got %d", rec.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, "2@abc") {
		t.Fatalf("the refusal leaked the code it refused: %s", body)
	}
}

func TestPairServesTheLiveCode(t *testing.T) {
	exp := time.Now().Add(30 * time.Second).UTC().Truncate(time.Second)
	h := newHandlerWithConnection(t, store.NewMemory(), &stubSender{}, stubPairer{code: "2@abc", expiresAt: exp, pairing: true})

	rec := getAuthed(h, "/v1/pair", "tok-operator")
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	out := decode(t, rec)
	if out["pairing"] != true || out["code"] != "2@abc" {
		t.Fatalf("live code not served: %v", out)
	}
}

func TestPairResponseIsNotCached(t *testing.T) {
	// The pairing code is a credential; a cached copy of this response would
	// outlive the pairing window it was issued for.
	h := newHandlerWithConnection(t, store.NewMemory(), &stubSender{}, stubPairer{code: "2@abc", expiresAt: time.Now().Add(30 * time.Second), pairing: true})
	rec := getAuthed(h, "/v1/pair", "tok-operator")

	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestPairOmitsTheCodeWhenNotPairing(t *testing.T) {
	h := newHandlerWithConnection(t, store.NewMemory(), &stubSender{}, stubPairer{connected: true})
	rec := getAuthed(h, "/v1/pair", "tok-operator")

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
