package redact

import (
	"strings"
	"testing"
)

func TestBodyNeverLeaksContent(t *testing.T) {
	got := Body("hello Sipho, your install is booked")
	if got != "<35 chars>" {
		t.Fatalf("Body leaked content or miscounted: %q", got)
	}
}

func TestBodyEmpty(t *testing.T) {
	if got := Body(""); got != "<0 chars>" {
		t.Fatalf("want <0 chars>, got %q", got)
	}
}

func TestBodyCountsRunesNotBytes(t *testing.T) {
	// A body-length figure that jumps because of an emoji is a bug report
	// waiting to happen, and rune count is what an operator expects.
	if got := Body("hé🎉"); got != "<3 chars>" {
		t.Fatalf("want <3 chars>, got %q", got)
	}
}

// A JID is the customer's phone number (POPIA personal information) and this
// service's logs are not access-controlled, so the full number must never
// come out — only a stable, greppable stand-in with the last 4 digits kept.
func TestJIDMasksAllButLastFourDigits(t *testing.T) {
	const jid = "27821234567@s.whatsapp.net"
	got := JID(jid)

	if strings.Contains(got, "27821234567") {
		t.Fatalf("full phone number leaked: %q", got)
	}
	if !strings.HasSuffix(got, "4567@s.whatsapp.net") {
		t.Fatalf("last 4 digits not retained: %q", got)
	}
	if len(got) != len(jid) {
		t.Fatalf("length changed: got %d chars, want %d", len(got), len(jid))
	}
}

func TestJIDIsStableForTheSameInput(t *testing.T) {
	const jid = "27821234567@s.whatsapp.net"
	if JID(jid) != JID(jid) {
		t.Fatal("same input must mask to the same output, or the value stops being greppable")
	}
}
