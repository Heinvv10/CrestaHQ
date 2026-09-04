package store

import (
	"testing"
	"time"
)

func TestMemoryRecordsInboundAndOutbound(t *testing.T) {
	s := NewMemory()
	jid := "27821234567@s.whatsapp.net"
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	ok, err := s.HasInboundFrom(jid)
	if err != nil || ok {
		t.Fatalf("fresh store must have no inbound: ok=%v err=%v", ok, err)
	}

	if err := s.RecordInbound(jid, base); err != nil {
		t.Fatal(err)
	}
	ok, _ = s.HasInboundFrom(jid)
	if !ok {
		t.Fatal("inbound not recorded")
	}

	if err := s.RecordOutbound(jid, "hermes", "msg-1", base.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	n, _ := s.OutboundCountForContact(jid, base)
	if n != 1 {
		t.Fatalf("want 1 outbound, got %d", n)
	}
}

func TestConsecutiveOutboundResetsOnInbound(t *testing.T) {
	s := NewMemory()
	jid := "27821234567@s.whatsapp.net"
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	s.RecordInbound(jid, base)
	s.RecordOutbound(jid, "hermes", "a", base.Add(1*time.Minute))
	s.RecordOutbound(jid, "hermes", "b", base.Add(2*time.Minute))

	n, _ := s.ConsecutiveOutbound(jid)
	if n != 2 {
		t.Fatalf("want 2 consecutive, got %d", n)
	}

	// A reply from the contact resets the streak — that is the whole point of
	// the counter: it measures how long we have been talking at someone.
	s.RecordInbound(jid, base.Add(3*time.Minute))
	n, _ = s.ConsecutiveOutbound(jid)
	if n != 0 {
		t.Fatalf("inbound must reset the streak, got %d", n)
	}
}

func TestIdempotencyRoundTrip(t *testing.T) {
	s := NewMemory()
	if _, found, _ := s.LookupIdempotency("k1"); found {
		t.Fatal("unknown key must not be found")
	}
	if err := s.SaveIdempotency("k1", "msg-9"); err != nil {
		t.Fatal(err)
	}
	id, found, _ := s.LookupIdempotency("k1")
	if !found || id != "msg-9" {
		t.Fatalf("want msg-9/true, got %q/%v", id, found)
	}
}
