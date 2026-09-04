package rails

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// TestRailsFailClosedOnStoreError proves the fail-closed guarantee for real:
// store.Memory never returns a non-nil error, so without this test the claim
// "a Store error refuses" was true only by inspection of the code, not by any
// test that could catch a regression. Each fake below breaks exactly one
// Store method the rail under test depends on; every other method still
// works via the embedded *store.Memory, same shape as engine_test.go's
// errStore.
func TestRailsFailClosedOnStoreError(t *testing.T) {
	cfg := testConfig()

	t.Run("checkReplyOnly: IsAllowlisted erroring", func(t *testing.T) {
		s := errIsAllowlisted{store.NewMemory()}
		d := checkReplyOnly(SendRequest{To: known}, s)
		if d.Allow {
			t.Fatalf("want refuse, got %+v", d)
		}
		if d.RefusedBy != RefusedInternalError {
			t.Fatalf("want %q, got %q", RefusedInternalError, d.RefusedBy)
		}
	})

	t.Run("checkReplyOnly: HasInboundFrom erroring", func(t *testing.T) {
		s := errHasInboundFrom{store.NewMemory()}
		d := checkReplyOnly(SendRequest{To: known}, s)
		if d.Allow {
			t.Fatalf("want refuse, got %+v", d)
		}
		if d.RefusedBy != RefusedInternalError {
			t.Fatalf("want %q, got %q", RefusedInternalError, d.RefusedBy)
		}
	})

	t.Run("checkCaps: OutboundCountForContact erroring", func(t *testing.T) {
		s := errOutboundCountForContact{store.NewMemory()}
		d := checkCaps(SendRequest{To: known, Now: now}, s, cfg)
		if d.Allow {
			t.Fatalf("want refuse, got %+v", d)
		}
		if d.RefusedBy != RefusedInternalError {
			t.Fatalf("want %q, got %q", RefusedInternalError, d.RefusedBy)
		}
	})

	t.Run("checkCaps: ConsecutiveOutbound erroring", func(t *testing.T) {
		s := errConsecutiveOutbound{store.NewMemory()}
		d := checkCaps(SendRequest{To: known, Now: now}, s, cfg)
		if d.Allow {
			t.Fatalf("want refuse, got %+v", d)
		}
		if d.RefusedBy != RefusedInternalError {
			t.Fatalf("want %q, got %q", RefusedInternalError, d.RefusedBy)
		}
	})

	t.Run("checkCaps: OutboundCountTotal erroring", func(t *testing.T) {
		s := errOutboundCountTotal{store.NewMemory()}
		d := checkCaps(SendRequest{To: known, Now: now}, s, cfg)
		if d.Allow {
			t.Fatalf("want refuse, got %+v", d)
		}
		if d.RefusedBy != RefusedInternalError {
			t.Fatalf("want %q, got %q", RefusedInternalError, d.RefusedBy)
		}
	})
}

type errIsAllowlisted struct{ *store.Memory }

func (errIsAllowlisted) IsAllowlisted(jid string) (bool, error) { return false, errBoom }

type errHasInboundFrom struct{ *store.Memory }

func (errHasInboundFrom) HasInboundFrom(jid string) (bool, error) { return false, errBoom }

type errOutboundCountForContact struct{ *store.Memory }

func (errOutboundCountForContact) OutboundCountForContact(jid string, since time.Time) (int, error) {
	return 0, errBoom
}

type errConsecutiveOutbound struct{ *store.Memory }

func (errConsecutiveOutbound) ConsecutiveOutbound(jid string) (int, error) { return 0, errBoom }

type errOutboundCountTotal struct{ *store.Memory }

func (errOutboundCountTotal) OutboundCountTotal(since time.Time) (int, error) { return 0, errBoom }

// TestCapOrderingIsPinned pins the order checkCaps' doc comment promises:
// per-contact, then consecutive, then global. Every existing caps test
// exceeds exactly one cap at a time, so none of them would notice the checks
// being reordered. Here two caps are exceeded simultaneously and the test
// asserts which one wins.
func TestCapOrderingIsPinned(t *testing.T) {
	cfg := testConfig() // PerContactPerDay:10 ConsecutiveMax:3 GlobalDailyCap:150

	t.Run("per-contact and global both exceeded: per-contact wins", func(t *testing.T) {
		s := store.NewMemory()
		// Exceed the global cap using messages to other contacts.
		for i := 0; i < 150; i++ {
			jid := "27820000" + string(rune('0'+i%10)) + "0" + string(rune('0'+(i/10)%10)) + "@s.whatsapp.net"
			s.RecordOutbound(jid, "hermes", "m", now.Add(-time.Duration(i)*time.Second))
		}
		// Exceed the per-contact cap for `known` too.
		s.RecordInbound(known, now.Add(-time.Hour))
		for i := 0; i < 10; i++ {
			s.RecordOutbound(known, "hermes", "m", now.Add(-time.Duration(i)*time.Minute))
		}
		d := checkCaps(SendRequest{To: known, Now: now}, s, cfg)
		if d.Allow {
			t.Fatalf("both caps exceeded; must refuse, got %+v", d)
		}
		if d.RefusedBy != RefusedPerContactCap {
			t.Fatalf("per-contact must be checked first, got %q", d.RefusedBy)
		}
	})

	t.Run("consecutive and global both exceeded: consecutive wins", func(t *testing.T) {
		s := store.NewMemory()
		// Exceed the global cap using messages to other contacts.
		for i := 0; i < 150; i++ {
			jid := "27821000" + string(rune('0'+i%10)) + "0" + string(rune('0'+(i/10)%10)) + "@s.whatsapp.net"
			s.RecordOutbound(jid, "hermes", "m", now.Add(-time.Duration(i)*time.Second))
		}
		// `known` stays well under its per-contact cap (3 < 10) but its
		// unanswered streak exceeds ConsecutiveMax (3 >= 3).
		s.RecordInbound(known, now.Add(-time.Hour))
		for i := 0; i < 3; i++ {
			s.RecordOutbound(known, "hermes", "m", now.Add(-time.Duration(3-i)*time.Minute))
		}
		d := checkCaps(SendRequest{To: known, Now: now}, s, cfg)
		if d.Allow {
			t.Fatalf("both caps exceeded; must refuse, got %+v", d)
		}
		if d.RefusedBy != RefusedConsecutiveCap {
			t.Fatalf("consecutive must be checked before global, got %q", d.RefusedBy)
		}
	})
}
