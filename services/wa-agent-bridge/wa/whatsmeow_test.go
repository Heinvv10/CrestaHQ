package wa

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// After a reconnect whatsmeow replays recent history. The sibling bridge sent
// duplicate acks for hours because of exactly this. Recording replayed inbound
// is correct; acting on it is not.
//
// Named for what it asserts — that the window opens and expires — and NOT for
// suppression, because nothing in this package suppresses outbound. That is
// the caller's job; this only reports the window.
func TestReplayWindowOpensAndExpires(t *testing.T) {
	c := &Client{connectedAt: time.Now()}
	if !c.InReplayWindow() {
		t.Fatal("must be in the replay window immediately after connect")
	}

	c.connectedAt = time.Now().Add(-ReplayWindow - time.Second)
	if c.InReplayWindow() {
		t.Fatal("replay window must expire")
	}
}

// NOTE: this test passes with or without the explicit IsZero guard in
// InReplayWindow, because time.Since(zero time) is already far larger than
// ReplayWindow. Deleting that guard leaves this green. It is kept as a
// vacuous-but-cheap statement of the property, and the guard is kept as
// documentation of intent — not because this test enforces it.
func TestNotConnectedIsNotInReplayWindow(t *testing.T) {
	c := &Client{}
	if c.InReplayWindow() {
		t.Fatal("a client that never connected is not replaying")
	}
}

func TestLoggedOutRefusesImmediately(t *testing.T) {
	called := false
	c := &Client{onLoggedOut: func() { called = true }}
	c.connectedAt = time.Now()

	c.handleLoggedOut()

	if c.Connected() {
		t.Fatal("a logged-out client must report disconnected immediately")
	}
	if !called {
		t.Fatal("onLoggedOut callback not fired; the alert would never be sent")
	}
}

// The remaining tests drive the event handler directly. That is the whole of
// the socket lifecycle that is observable without a WhatsApp connection: the
// events themselves are plain structs, so everything except the bytes on the
// wire can be exercised here.

func msgEvent(sender, text string, fromMe, group bool) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Sender:   types.JID{User: sender, Server: types.DefaultUserServer},
				IsFromMe: fromMe,
				IsGroup:  group,
			},
			Timestamp: time.Unix(1700000000, 0),
		},
		Message: &waE2E.Message{Conversation: proto.String(text)},
	}
}

func TestConnectedTransitions(t *testing.T) {
	c := &Client{}
	if c.Connected() {
		t.Fatal("a fresh client must not report connected")
	}

	c.handleEvent(&events.Connected{})
	if !c.Connected() {
		t.Fatal("must report connected after events.Connected")
	}
	if !c.InReplayWindow() {
		t.Fatal("connecting must open the replay window")
	}

	// A transient drop must fail closed, not keep reporting healthy.
	c.handleEvent(&events.Disconnected{})
	if c.Connected() {
		t.Fatal("must report disconnected after events.Disconnected")
	}
	if c.InReplayWindow() {
		t.Fatal("a disconnected client is not replaying")
	}

	// Reconnect reopens the window, because a reconnect replays history again.
	c.handleEvent(&events.Connected{})
	if !c.InReplayWindow() {
		t.Fatal("reconnect must reopen the replay window")
	}
}

func TestLoggedOutSurvivesLaterConnected(t *testing.T) {
	// Guards against a reconnect quietly resurrecting a flagged number.
	// events.Connected clears loggedOut deliberately (that is what a
	// successful re-pair looks like), so what must hold is only that nothing
	// short of a real Connected undoes it.
	c := &Client{}
	c.handleEvent(&events.Connected{})
	c.handleEvent(&events.LoggedOut{})

	if c.Connected() {
		t.Fatal("logged out must report disconnected")
	}
	c.handleEvent(&events.Disconnected{})
	if c.Connected() {
		t.Fatal("still logged out after a disconnect")
	}
	if _, err := c.Send(context.Background(), "27831234567@s.whatsapp.net", "hi", nil); !errors.Is(err, ErrLoggedOut) {
		t.Fatalf("Send after LoggedOut = %v, want ErrLoggedOut", err)
	}
}

func TestSendRefusesWhileDisconnected(t *testing.T) {
	c := &Client{}
	if _, err := c.Send(context.Background(), "27831234567@s.whatsapp.net", "hi", nil); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("Send while disconnected = %v, want ErrNotConnected", err)
	}
}

func TestInboundDispatchFilters(t *testing.T) {
	type got struct {
		jid, text string
		at        time.Time
	}
	var seen []got
	c := &Client{onInbound: func(jid, text, _ string, at time.Time, _ *InboundAttachment, _ *InboundLocation) {
		seen = append(seen, got{jid, text, at})
	}}

	c.handleEvent(msgEvent("27831234567", "real message", false, false))
	c.handleEvent(msgEvent("27831234567", "echo of our own send", true, false))
	c.handleEvent(msgEvent("27831234567", "group chatter", false, true))
	c.handleEvent(msgEvent("27831234567", "", false, false)) // non-text
	c.handleEvent(&events.Receipt{})                         // not a message at all

	if len(seen) != 1 {
		t.Fatalf("dispatched %d inbound, want exactly 1 (the non-group, non-echo text)", len(seen))
	}
	if seen[0].text != "real message" {
		t.Fatalf("text = %q", seen[0].text)
	}
	if seen[0].jid != "27831234567@s.whatsapp.net" {
		t.Fatalf("jid = %q", seen[0].jid)
	}
	if !seen[0].at.Equal(time.Unix(1700000000, 0)) {
		t.Fatalf("timestamp = %v; the ordering engine keys off this", seen[0].at)
	}
}

func TestExtendedTextMessageIsDispatched(t *testing.T) {
	// A reply, or any message with a link preview, arrives as an
	// ExtendedTextMessage with an empty Conversation field. Missing this
	// makes the bridge deaf to every quoted reply.
	var seen string
	c := &Client{onInbound: func(_, text, _ string, _ time.Time, _ *InboundAttachment, _ *InboundLocation) { seen = text }}

	e := msgEvent("27831234567", "", false, false)
	e.Message = &waE2E.Message{
		ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("quoted reply")},
	}
	c.handleEvent(e)

	if seen != "quoted reply" {
		t.Fatalf("extended text not dispatched, got %q", seen)
	}
}

// WhatsApp addresses many senders by LID now, and for those Info.Sender is
// "<lid>@lid" while Info.SenderAlt carries the real "<msisdn>@s.whatsapp.net".
//
// Forwarding the LID is not a cosmetic wart. The consumer stores the JID's user
// part as the contact's phone number and rebuilds "<user>@s.whatsapp.net" to
// reply — so a LID becomes a phone number that was never dialled. The reply
// then goes nowhere, or to whichever stranger genuinely owns that number.
// Observed in production on 2026-09-05: a real inbound landed in the CRM as
// contactPhone "+155228775178345".
func TestLIDSenderIsForwardedAsThePhoneJID(t *testing.T) {
	var seen string
	c := &Client{onInbound: func(jid, _, _ string, _ time.Time, _ *InboundAttachment, _ *InboundLocation) { seen = jid }}

	e := msgEvent("27831234567", "hello from a lid-addressed sender", false, false)
	e.Info.Sender = types.JID{User: "155228775178345", Server: types.HiddenUserServer}
	e.Info.SenderAlt = types.JID{User: "27831234567", Server: types.DefaultUserServer}
	e.Info.AddressingMode = types.AddressingModeLID
	c.handleEvent(e)

	if seen != "27831234567@s.whatsapp.net" {
		t.Fatalf("forwarded %q; the consumer will treat that as a phone number and reply to a stranger", seen)
	}
}

// The fallback must not invent an address. When no alternative is offered there
// is nothing better than what WhatsApp gave us, and dropping the message would
// silently lose a real customer.
func TestSenderIsForwardedUnchangedWithoutAnAlternative(t *testing.T) {
	var seen string
	c := &Client{onInbound: func(jid, _, _ string, _ time.Time, _ *InboundAttachment, _ *InboundLocation) { seen = jid }}

	e := msgEvent("27831234567", "ordinary phone-addressed sender", false, false)
	c.handleEvent(e)
	if seen != "27831234567@s.whatsapp.net" {
		t.Fatalf("jid = %q", seen)
	}

	seen = ""
	e = msgEvent("27831234567", "lid with no alternative", false, false)
	e.Info.Sender = types.JID{User: "155228775178345", Server: types.HiddenUserServer}
	c.handleEvent(e) // SenderAlt is the zero JID
	if seen != "155228775178345@lid" {
		t.Fatalf("with no alternative the sender must pass through unchanged, got %q", seen)
	}
}

// ConnectedAt is the key the fanout uses to decide a new connection has begun
// and its replay watermark needs re-reading. STABILITY is the property that
// matters: a value that changes between calls re-snapshots the watermark on
// every message, which resets the catch-up counter so the flood cap never
// fires, and makes any out-of-order message look like history.
//
// Tested here rather than on the clientHolder that wraps it, because a
// *wa.Client with a live connection cannot be constructed from package main
// without either a whatsmeow socket or a test double promoted into the
// shipped binary — which this package deliberately refuses to do.
func TestConnectedAtIsStableWhileConnected(t *testing.T) {
	c := &Client{}
	if !c.ConnectedAt().IsZero() {
		t.Fatal("an unconnected client must report the zero time")
	}

	c.handleEvent(&events.Connected{})
	first := c.ConnectedAt()
	if first.IsZero() {
		t.Fatal("ConnectedAt must be set once the socket connects")
	}
	time.Sleep(2 * time.Millisecond)
	if second := c.ConnectedAt(); !second.Equal(first) {
		t.Fatalf("ConnectedAt must not move while one connection lasts: %v then %v", first, second)
	}

	// A NEW connection must move it, or the watermark is never re-read.
	time.Sleep(2 * time.Millisecond)
	c.handleEvent(&events.Connected{})
	if again := c.ConnectedAt(); !again.After(first) {
		t.Fatalf("a new connection must advance ConnectedAt: %v then %v", first, again)
	}
}
