package redact

import "testing"

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
