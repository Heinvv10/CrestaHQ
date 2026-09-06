package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/internal/redact"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// Fanout records every inbound message and forwards it to each registered
// consumer's webhook.
//
// Recording happens unconditionally; forwarding does not. During the replay
// window after a reconnect, whatsmeow re-delivers recent history — recording
// it keeps reply-only accurate, but waking a consumer would have it answer a
// day's worth of old messages. That is a real incident from the sibling
// bridge, not a hypothetical.
type Fanout struct {
	consumers      []config.Consumer
	ownerJID       string
	store          rails.Store
	inReplayWindow func() bool
	connectedAt    func() time.Time
	client         *http.Client
	wg             sync.WaitGroup
	// now is the signing clock. Defaulted to time.Now by NewFanout; tests
	// that need to assert a fixed signature override it directly (same
	// package, deliberate unexported access — see f.client.Transport above).
	now func() time.Time

	// Watermark state, guarded by wmMu. Deliver is called from whatsmeow's
	// event goroutine today, but a lock is cheaper than the assumption.
	wmMu sync.Mutex
	// watermark is the newest message this bridge had recorded BEFORE the
	// current connection. Anything at or before it is history whatsmeow is
	// re-delivering; anything after it arrived while we were down or since.
	watermark time.Time
	// watermarkFor is the connectedAt the watermark was taken for, so a new
	// connection re-snapshots it exactly once.
	watermarkFor time.Time
	catchUp      int
	skippedOld   int
	skippedCap   int
}

// maxCatchUpForward bounds how many messages one connection may forward from
// its backlog. A re-pair can hand us a large recent backlog, all of it newer
// than the watermark and all of it genuinely unseen — forwarding is right, but
// unbounded forwarding turns one re-pair into a flood across every thread.
const maxCatchUpForward = 200

// NewFanout wires a Fanout. inReplayWindow is required — it decides whether
// an inbound message wakes a consumer or is recorded silently, and getting
// that wrong either resurrects a day-old conversation (nil treated as
// "never replaying") or blinds every consumer permanently (nil treated as
// "always replaying"). Neither failure mode is acceptable to default into
// silently, so a nil func panics here instead: this is caught at process
// startup, by whoever wires *wa.Client.InReplayWindow into this
// constructor, not at 2am against a live inbound.
// ownerJID, when non-empty, restricts forwarding to that one sender (see
// Deliver). Empty accepts every sender — the phase-2 shape, and the only safe
// default: empty meaning "accept none" would brick any deployment that omits
// the variable, silently and with no error to read.
func NewFanout(consumers []config.Consumer, ownerJID string, st rails.Store, inReplayWindow func() bool, connectedAt func() time.Time) *Fanout {
	if inReplayWindow == nil {
		panic("api: NewFanout requires a non-nil inReplayWindow func")
	}
	// Same reasoning as inReplayWindow: without it the watermark can never be
	// re-snapshotted, so the first connection's watermark would govern every
	// later one and a long-lived process would drift into forwarding history.
	if connectedAt == nil {
		panic("api: NewFanout requires a non-nil connectedAt func")
	}
	return &Fanout{
		consumers:      consumers,
		ownerJID:       ownerJID,
		store:          st,
		inReplayWindow: inReplayWindow,
		connectedAt:    connectedAt,
		client:         &http.Client{Timeout: 10 * time.Second},
		now:            time.Now,
	}
}

// refreshWatermark re-reads the watermark once per connection.
//
// On a read error the watermark is left at the zero time, which admits
// everything and leans on maxCatchUpForward to bound the damage. That is the
// deliberate direction: a message forwarded twice merges in the consumer (the
// payload carries WhatsApp's own message id and consumers key on it), while a
// message never forwarded is gone — this bridge stores no message body, so
// there is nothing to replay it from later.
func (f *Fanout) refreshWatermark() {
	c := f.connectedAt()
	f.wmMu.Lock()
	defer f.wmMu.Unlock()
	if c.Equal(f.watermarkFor) {
		return
	}
	f.watermarkFor = c
	f.catchUp, f.skippedOld, f.skippedCap = 0, 0, 0
	w, err := f.store.LastInboundAt()
	if err != nil {
		log.Printf("WARNING watermark unreadable, admitting the backlog up to %d messages: %v",
			maxCatchUpForward, err)
		f.watermark = time.Time{}
		return
	}
	f.watermark = w
}

// admitDuringReplay decides whether one message survives the post-connect
// window, and reports true when it should be forwarded.
func (f *Fanout) admitDuringReplay(jid, text string, at time.Time) bool {
	f.wmMu.Lock()
	defer f.wmMu.Unlock()

	// STRICTLY older, not "not newer". at_unix is whole seconds, so a message
	// in the same second as the newest recorded one is ordinary, not history —
	// and treating it as history drops it permanently, while admitting it at
	// worst re-delivers one message that the consumer merges on its id.
	if at.Before(f.watermark) {
		f.skippedOld++
		log.Printf("inbound is history, older than the watermark jid=%s len=%s — recorded, not forwarded",
			redact.JID(jid), redact.Body(text))
		return false
	}
	if f.catchUp >= maxCatchUpForward {
		f.skippedCap++
		log.Printf("ALERT catch-up cap reached, DROPPING new inbound jid=%s len=%s (%d suppressed this connection)",
			redact.JID(jid), redact.Body(text), f.skippedCap)
		return false
	}
	f.catchUp++
	return true
}

// SuppressedInbound reports what this connection did not forward: messages
// recognised as history, and genuinely new ones dropped by the catch-up cap.
// The second number is data loss and belongs in front of an operator.
func (f *Fanout) SuppressedInbound() (history, capped int) {
	f.wmMu.Lock()
	defer f.wmMu.Unlock()
	return f.skippedOld, f.skippedCap
}

// Deliver records one inbound message and, outside the replay window, POSTs
// it to every consumer that registered a webhook.
//
// msgID is WhatsApp's own message id, forwarded so a consumer can dedupe a
// redelivery on the id rather than on the body. It is empty when the transport
// did not supply one; consumers must treat empty as "unknown".
func (f *Fanout) Deliver(jid, text, msgID string, at time.Time) {
	// Before RecordInbound, or this very message raises the watermark above
	// itself and every message looks like history.
	f.refreshWatermark()

	if err := f.store.RecordInbound(jid, at); err != nil {
		log.Printf("WARNING inbound not recorded jid=%s err=%v", redact.JID(jid), err)
	}

	// Phase 1 runs on an unpublished number that only the owner is supposed to
	// message. Anything else is recorded and dropped. The check sits AFTER
	// RecordInbound for the same reason the replay gate does: reply-only
	// decides whether a JID may be messaged at all, and it decides on recorded
	// history — dropping the record here would leave a contact who really did
	// message us looking like a stranger.
	//
	// It sits BEFORE the replay gate so the catch-up budget is spent only on
	// messages that could actually be forwarded. With OWNER_JID set, 200
	// non-owner messages during the window would otherwise exhaust the cap and
	// the owner's genuinely new message would be the one dropped.
	if !f.fromOwner(jid) {
		log.Printf("inbound from non-owner jid=%s len=%s — recorded, not forwarded",
			redact.JID(jid), redact.Body(text))
		return
	}

	if f.inReplayWindow() && !f.admitDuringReplay(jid, text, at) {
		return
	}

	payload, err := json.Marshal(map[string]any{
		"from":      jid,
		"text":      text,
		"messageId": msgID,
		"at":        at.UTC().Format(time.RFC3339),
	})
	if err != nil {
		log.Printf("WARNING inbound payload marshal failed jid=%s err=%v", redact.JID(jid), err)
		return
	}

	for _, c := range f.consumers {
		if c.WebhookURL == "" {
			continue
		}
		f.wg.Add(1)
		go func(c config.Consumer) {
			defer f.wg.Done()
			f.post(c, payload)
		}(c)
	}
}

// fromOwner reports whether jid is the configured owner. An empty ownerJID
// means the filter is off and every sender is accepted.
//
// Comparison is normalised because whatsmeow's Info.Sender carries a device
// suffix on a multi-device account ("2782...:12@s.whatsapp.net"), and an exact
// string match against a configured "2782...@s.whatsapp.net" would then drop
// the owner's own messages — a failure that looks exactly like a dead bridge.
// An OWNER_JID written without a server ("2782...") is matched on the user
// part alone, since that is the form an operator is most likely to type.
func (f *Fanout) fromOwner(jid string) bool {
	if f.ownerJID == "" {
		return true
	}
	wantUser, wantServer := splitJID(f.ownerJID)
	gotUser, gotServer := splitJID(jid)
	if wantUser != gotUser {
		return false
	}
	// A configured JID with no server matches any server.
	return wantServer == "" || wantServer == gotServer
}

// splitJID returns the lowercased user part (device suffix stripped) and
// server part of a WhatsApp JID.
func splitJID(jid string) (user, server string) {
	jid = strings.ToLower(strings.TrimSpace(jid))
	if at := strings.IndexByte(jid, '@'); at >= 0 {
		user, server = jid[:at], jid[at+1:]
	} else {
		user = jid
	}
	if colon := strings.IndexByte(user, ':'); colon >= 0 {
		user = user[:colon]
	}
	return user, server
}

// post delivers one payload to one consumer's webhook. Failures are logged,
// never returned — a dead consumer webhook must not block or fail delivery
// to the others, and the caller (Deliver) has nothing to retry against since
// the inbound has already been recorded.
func (f *Fanout) post(c config.Consumer, payload []byte) {
	req, err := http.NewRequest(http.MethodPost, c.WebhookURL, bytes.NewReader(payload))
	if err != nil {
		log.Printf("WARNING webhook request build failed consumer=%s err=%v", c.Name, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	// Signing is additive: the bearer token stays as the primary credential,
	// this header only lets a receiver ALSO verify the request wasn't forged
	// or replayed. An empty secret (the default) means the consumer never
	// configured one, so nothing is signed — a config carried over from
	// before this field existed keeps delivering unchanged.
	if c.WebhookSecret != "" {
		req.Header.Set("LeadStack-Signature", signPayload(c.WebhookSecret, payload, f.now()))
	}
	resp, err := f.client.Do(req)
	if err != nil {
		log.Printf("WARNING webhook delivery failed consumer=%s err=%v", c.Name, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("WARNING webhook consumer=%s status=%d", c.Name, resp.StatusCode)
	}
}

// signPayload produces a Stripe-style "LeadStack-Signature" header value:
// t=<unix_seconds>,v1=<hex HMAC-SHA256 of "<unix_seconds>.<rawBody>">.
//
// This mirrors src/lib/api/webhooks/signing.ts (signWebhookPayload) byte for
// byte — same signed string, same header shape, same v1 prefix — because
// that file's verifyWebhookSignature is the receiver this emitter exists to
// satisfy. The timestamp is generated here, at send time, rather than
// threaded in from Deliver, because the receiver enforces a 5-minute
// tolerance against it: signing a stale "at" would make a slow consumer's
// delivery reject on arrival for a reason that has nothing to do with
// forgery or replay.
func signPayload(secret string, body []byte, at time.Time) string {
	ts := at.Unix()
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.", ts)))
	mac.Write(body)
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}

// Wait blocks until in-flight deliveries finish. Used by tests and by
// shutdown, so an outstanding delivery isn't abandoned mid-flight.
func (f *Fanout) Wait() { f.wg.Wait() }
