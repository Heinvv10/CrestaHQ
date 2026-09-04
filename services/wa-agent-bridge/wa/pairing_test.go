package wa

import (
	"go.mau.fi/whatsmeow"
	"testing"
	"time"
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
