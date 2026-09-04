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
// is correct; acting on it is not, so the first few minutes after connect are
// receive-only.
func TestReplayWindowSuppressesOutbound(t *testing.T) {
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
	if _, err := c.Send(context.Background(), "27831234567@s.whatsapp.net", "hi"); !errors.Is(err, ErrLoggedOut) {
		t.Fatalf("Send after LoggedOut = %v, want ErrLoggedOut", err)
	}
}

func TestSendRefusesWhileDisconnected(t *testing.T) {
	c := &Client{}
	if _, err := c.Send(context.Background(), "27831234567@s.whatsapp.net", "hi"); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("Send while disconnected = %v, want ErrNotConnected", err)
	}
}

func TestInboundDispatchFilters(t *testing.T) {
	type got struct {
		jid, text string
		at        time.Time
	}
	var seen []got
	c := &Client{onInbound: func(jid, text string, at time.Time) {
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
	c := &Client{onInbound: func(_, text string, _ time.Time) { seen = text }}

	e := msgEvent("27831234567", "", false, false)
	e.Message = &waE2E.Message{
		ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("quoted reply")},
	}
	c.handleEvent(e)

	if seen != "quoted reply" {
		t.Fatalf("extended text not dispatched, got %q", seen)
	}
}
