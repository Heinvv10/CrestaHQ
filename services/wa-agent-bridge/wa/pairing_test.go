package wa

import (
	"bytes"
	"log"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
)

func TestPairingCodeIsEmptyBeforeAnyCodeArrives(t *testing.T) {
	c := &Client{}
	if _, _, pairing := c.PairingCode(); pairing {
		t.Fatal("a client that has never emitted a code must not report pairing")
	}
}

func TestPairingCodeIsServedThenClearedOnSuccess(t *testing.T) {
	c := &Client{}
	exp := time.Now().Add(30 * time.Second)
	c.setPairingCode("2@abc123", exp)

	code, expiresAt, pairing := c.PairingCode()
	if !pairing || code != "2@abc123" || !expiresAt.Equal(exp) {
		t.Fatalf("want the live code back, got %q %v %v", code, expiresAt, pairing)
	}

	// Pairing succeeded: the code is a credential and must not outlive its use.
	c.clearPairingCode()
	if code, _, pairing := c.PairingCode(); pairing || code != "" {
		t.Fatalf("code survived pairing: %q %v", code, pairing)
	}
}

func TestExpiredPairingCodeIsNotServed(t *testing.T) {
	c := &Client{}
	c.setPairingCode("2@stale", time.Now().Add(-time.Second))
	if _, _, pairing := c.PairingCode(); pairing {
		t.Fatal("an expired code must not be served — a stale QR scans into nothing")
	}
}

func TestQRTimeoutClearsAnyLiveCode(t *testing.T) {
	c := &Client{}
	c.setPairingCode("2@abc123", time.Now().Add(30*time.Second))

	c.handleQREvent(whatsmeow.QRChannelItem{Event: "timeout"})

	if _, _, pairing := c.PairingCode(); pairing {
		t.Fatal("a pairing that ended in timeout must not leave a dead code being served")
	}
}

func TestQRSuccessClearsAnyLiveCode(t *testing.T) {
	c := &Client{}
	c.setPairingCode("2@abc123", time.Now().Add(30*time.Second))

	c.handleQREvent(whatsmeow.QRChannelItem{Event: "success"})

	if _, _, pairing := c.PairingCode(); pairing {
		t.Fatal("a successful pairing must not leave the code being served")
	}
}

// The QR payload is a credential: scanning it links a device to this
// number. It must never reach the log writer, which on the deployed unit is
// a persistent, access-uncontrolled file. This drives the real code path
// (handleQREvent) against a captured log.Writer, rather than grepping source.
//
// A plain substring check on the raw code is not enough: qrterminal renders
// the code as a scannable image of half-block glyphs, not as the literal
// code string, so the substring would never appear even with the leak
// present. What distinguishes a one-line "pairing started" log from a
// rendered QR is size — measured at ~2KB for the image against under 100
// bytes for the announcement — so the assertion is a byte-count ceiling.
func TestQRCodeEventNeverLogsThePayload(t *testing.T) {
	prev := log.Writer()
	defer log.SetOutput(prev)
	var buf bytes.Buffer
	log.SetOutput(&buf)

	c := &Client{}
	const code = "2@super-secret-pairing-payload-of-realistic-length-1234567890"
	c.handleQREvent(whatsmeow.QRChannelItem{Event: "code", Code: code, Timeout: 30 * time.Second})

	if strings.Contains(buf.String(), code) {
		t.Fatalf("pairing code payload reached the log writer verbatim: %q", buf.String())
	}
	const maxAnnouncementBytes = 200
	if buf.Len() > maxAnnouncementBytes {
		t.Fatalf("log writer received %d bytes, want <= %d (a bare announcement line) — a rendered QR image would look like this", buf.Len(), maxAnnouncementBytes)
	}
}
