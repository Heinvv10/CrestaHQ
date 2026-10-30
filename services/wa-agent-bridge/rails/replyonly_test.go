package rails

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

const stranger = "27829999999@s.whatsapp.net"
const known = "27821234567@s.whatsapp.net"

func TestReplyOnlyRefusesContactWhoNeverMessaged(t *testing.T) {
	s := store.NewMemory()
	d := checkReplyOnly(SendRequest{To: stranger, Consumer: "leadstack"}, s)
	if d.Allow {
		t.Fatal("outbound to a JID with no inbound history must be refused")
	}
	if d.RefusedBy != RefusedReplyOnly {
		t.Fatalf("want %q, got %q", RefusedReplyOnly, d.RefusedBy)
	}
}

func TestReplyOnlyAllowsContactWhoMessagedIn(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, time.Now())
	if d := checkReplyOnly(SendRequest{To: known}, s); !d.Allow {
		t.Fatalf("inbound history must open the contact, got %+v", d)
	}
}

func TestAllowlistOverridesReplyOnly(t *testing.T) {
	s := store.NewMemory()
	s.AddAllowlist(stranger)
	if d := checkReplyOnly(SendRequest{To: stranger}, s); !d.Allow {
		t.Fatalf("allowlist must override reply-only, got %+v", d)
	}
}

// The incident this whole service exists to prevent: on 2026-09-04 the sibling
// bridge's number was logged out 12 times in one window after ~120 outbound
// DMs to people who had never messaged it. Every one of those must refuse.
func TestColdDMToNonContactRefused(t *testing.T) {
	s := store.NewMemory()
	for i := 0; i < 120; i++ {
		jid := "2782000" + string(rune('0'+i%10)) + "00@s.whatsapp.net"
		d := checkReplyOnly(SendRequest{To: jid, Consumer: "leadstack"}, s)
		if d.Allow {
			t.Fatalf("cold DM %d to %s was allowed; this is the ban pattern", i, jid)
		}
	}
}
