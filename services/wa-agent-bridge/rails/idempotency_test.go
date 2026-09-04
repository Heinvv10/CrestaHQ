package rails

import (
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// testJID is the recipient the shared bodies bind their idempotency keys to.
const testJID = "27821234567@s.whatsapp.net"

// TestIdempotencyKeysAreNamespacedPerConsumer is the regression guard for the
// silent non-delivery: hermes and leadstack both derive keys like
// "turn-<conversationId>-<turnIndex>", so a shared key space makes leadstack's
// send return hermes' message id and never reach the contact.
func TestIdempotencyKeysAreNamespacedPerConsumer(t *testing.T) {
	s := store.NewMemory()

	if _, _, reserved, err := s.ReserveIdempotency(IdempotencyStorageKey("hermes", "k1"), testJID, now); err != nil || !reserved {
		t.Fatalf("hermes must win its own key: reserved=%v err=%v", reserved, err)
	}
	if _, _, reserved, err := s.ReserveIdempotency(IdempotencyStorageKey("leadstack", "k1"), testJID, now); err != nil || !reserved {
		t.Fatalf("leadstack must be free to use the same raw key: reserved=%v err=%v", reserved, err)
	}
	// And the namespace still catches a genuine replay within one consumer.
	if _, _, reserved, _ := s.ReserveIdempotency(IdempotencyStorageKey("hermes", "k1"), testJID, now); reserved {
		t.Fatal("hermes replaying its own key must not win a second reservation")
	}

	// End to end through the rail: hermes' completed send must not be handed
	// back to leadstack as a duplicate.
	if err := s.SaveIdempotency(IdempotencyStorageKey("hermes", "k1"), "msg-from-hermes"); err != nil {
		t.Fatal(err)
	}
	d := checkIdempotency(SendRequest{To: known, IdempotencyKey: "k1", Consumer: "leadstack"}, s)
	if d.DuplicateOf != "" {
		t.Fatalf("leadstack must not inherit hermes' message id, got DuplicateOf=%q", d.DuplicateOf)
	}
	if d := checkIdempotency(SendRequest{To: known, IdempotencyKey: "k1", Consumer: "hermes"}, s); d.DuplicateOf != "msg-from-hermes" {
		t.Fatalf("hermes' own replay must be recognised, got %+v", d)
	}
}

// TestIdempotencyStorageKeyIsUnambiguous pins the property that makes the
// composition safe: no two (consumer, key) pairs may map to one storage key.
func TestIdempotencyStorageKeyIsUnambiguous(t *testing.T) {
	if IdempotencyStorageKey("a", "bc") == IdempotencyStorageKey("ab", "c") {
		t.Fatal(`("a","bc") and ("ab","c") must not collide`)
	}
	if IdempotencyStorageKey("a:b", "c") == IdempotencyStorageKey("a", "b:c") {
		t.Fatal(`a separator appearing inside the consumer name must not collide`)
	}
}

// TestEmptyConsumerIsRefused: writing unnamespaced is not an acceptable
// fallback, because an unnamespaced key is the collision.
func TestEmptyConsumerIsRefused(t *testing.T) {
	d := checkIdempotency(SendRequest{To: known, IdempotencyKey: "k1", Consumer: ""}, store.NewMemory())
	if d.Allow {
		t.Fatalf("empty consumer must refuse, got %+v", d)
	}
	if d.RefusedBy != RefusedInternalError {
		t.Fatalf("want %q, got %q", RefusedInternalError, d.RefusedBy)
	}
}

// TestInFlightReservationIsNotReportedAsDuplicate: a reservation with no
// message id yet must not become Duplicate("") — an empty DuplicateOf is
// indistinguishable from a plain refusal, and callers branch on it.
func TestInFlightReservationIsNotReportedAsDuplicate(t *testing.T) {
	s := store.NewMemory()
	s.ReserveIdempotency(IdempotencyStorageKey("hermes", "k1"), testJID, now)
	d := checkIdempotency(SendRequest{To: known, IdempotencyKey: "k1", Consumer: "hermes"}, s)
	if d.Allow {
		t.Fatalf("an in-flight send must not be allowed through, got %+v", d)
	}
	if d.DuplicateOf != "" {
		t.Fatalf("no message id exists yet; DuplicateOf must stay empty, got %q", d.DuplicateOf)
	}
	// in_flight, not internal_error: a concurrent retry is a normal outcome,
	// not a broken Store, and a consumer must be able to tell them apart.
	if d.RefusedBy != RefusedInFlight {
		t.Fatalf("want %q, got %q", RefusedInFlight, d.RefusedBy)
	}
}
