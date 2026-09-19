package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func TestFanoutRecordsInboundAndPostsToConsumers(t *testing.T) {
	var mu sync.Mutex
	var got []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		"", // no owner filter
		st,
		func() bool { return false },
		func() time.Time { return time.Time{} },
		0,
	)

	// The message must be OLDER than the watermark to count as history. A
	// blanket mute used to drop everything in the window, including messages
	// that arrived one second earlier; that lost two real messages on
	// 2026-09-06, so "inside the window" is no longer sufficient on its own.
	jid := "27821234567@s.whatsapp.net"
	if err := st.RecordInbound("27820000000@s.whatsapp.net", time.Now()); err != nil {
		t.Fatal(err)
	}
	f.Deliver(jid, "hello", "wamid.TEST", time.Now().Add(-time.Hour), nil, nil)
	f.Wait()

	ok, _ := st.HasInboundFrom(jid)
	if !ok {
		t.Fatal("inbound must be recorded — reply-only depends on it")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("want 1 webhook delivery, got %d", len(got))
	}
	if got[0]["from"] != jid {
		t.Fatalf("wrong from: %v", got[0])
	}
}

// During history replay the inbound must still be recorded (so reply-only
// stays accurate) but must NOT wake a consumer, or a reconnect re-answers
// every message from the last day.
func TestFanoutRecordsButDoesNotNotifyDuringReplay(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
	}))
	defer srv.Close()

	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		"", // no owner filter
		st,
		func() bool { return true }, // in replay window
		func() time.Time { return time.Now() },
		0,
	)

	jid := "27821234567@s.whatsapp.net"
	// The message must be OLDER than the watermark to count as history. The
	// blanket mute this replaces dropped everything inside the window,
	// including messages that had arrived seconds earlier — that is how two
	// real messages were lost on 2026-09-06.
	if err := st.RecordInbound("27820000000@s.whatsapp.net", time.Now()); err != nil {
		t.Fatal(err)
	}
	f.Deliver(jid, "hello", "wamid.TEST", time.Now().Add(-time.Hour), nil, nil)
	f.Wait()

	ok, _ := st.HasInboundFrom(jid)
	if !ok {
		t.Fatal("replayed inbound must still be recorded")
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 0 {
		t.Fatalf("replayed inbound must not notify consumers, got %d calls", calls)
	}
}

// A nil inReplayWindow must never silently mean "not replaying" — that would
// wake every consumer with a day of replayed history on the next reconnect,
// which is the exact incident the replay window exists to prevent. It must
// fail loudly at construction instead, so a wiring mistake is caught at
// startup, not against a live inbound.
func TestNewFanoutPanicsOnNilInReplayWindow(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on nil inReplayWindow")
		}
	}()
	NewFanout(nil, "", nil, nil, nil, 0)
}

// countingRoundTripper counts every HTTP request attempted, including one
// built against an empty WebhookURL. This matters: http.NewRequest and
// http.Client.Do both accept an empty URL without erroring at the call site
// that matters here — the request only fails once a real Transport tries to
// dial it, deep enough that a caller who merely logs the error (as post()
// does) would let a "no panic or block" test pass whether or not the
// consumer was actually skipped. Installing a fake Transport intercepts the
// attempt itself, before any dial happens, so the count reflects whether the
// skip guard ran at all, not just whether a socket connection was reachable.
type countingRoundTripper struct {
	mu    sync.Mutex
	calls []string // Authorization header per attempted request
}

func (c *countingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	c.mu.Lock()
	c.calls = append(c.calls, req.Header.Get("Authorization"))
	c.mu.Unlock()
	return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
}

// A consumer with no WebhookURL must be skipped entirely — never attempted.
// Proven with the counting mock above rather than an httptest server pointed
// at "": that would let this test pass even with the skip guard removed,
// because the empty-URL request fails silently past the server before it's
// ever observed. Registering a real webhook alongside the empty one and
// asserting exactly one attempt was made, at the configured consumer, is
// what makes removing the guard (which adds a second attempt) actually turn
// this test red.
func TestFanoutSkipsConsumersWithNoWebhook(t *testing.T) {
	rt := &countingRoundTripper{}

	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{
			{Name: "leadstack", Token: "no-webhook-token"}, // no WebhookURL — must be skipped
			{Name: "hermes", Token: "hermes-token", WebhookURL: "http://example.invalid/hook"},
		},
		"", // no owner filter
		st,
		func() bool { return false },
		func() time.Time { return time.Time{} },
		0,
	)
	f.client.Transport = rt // same package: unexported field access is deliberate here
	f.Deliver("27821234567@s.whatsapp.net", "hi", "wamid.TEST", time.Now(), nil, nil)
	f.Wait()

	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.calls) != 1 {
		t.Fatalf("want exactly 1 attempted delivery (only the consumer with a webhook), got %d: %v", len(rt.calls), rt.calls)
	}
	if rt.calls[0] != "Bearer hermes-token" {
		t.Fatalf("delivery attempt went to the wrong consumer: %v", rt.calls)
	}
}

// Phase 1 runs on an unpublished number: the owner is the only sender whose
// messages should reach a consumer. The drop must happen AFTER the record, or
// reply-only later treats a real contact as a stranger.
func TestFanoutDropsNonOwnerButStillRecordsIt(t *testing.T) {
	rt := &countingRoundTripper{}
	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: "http://example.invalid/hook"}},
		"27820000001@s.whatsapp.net",
		st,
		func() bool { return false },
		func() time.Time { return time.Time{} },
		0,
	)
	f.client.Transport = rt

	stranger := "27829999999@s.whatsapp.net"
	f.Deliver(stranger, "hello", "wamid.TEST", time.Now(), nil, nil)
	f.Wait()

	if ok, _ := st.HasInboundFrom(stranger); !ok {
		t.Fatal("a dropped non-owner inbound must still be recorded; reply-only reads that history")
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.calls) != 0 {
		t.Fatalf("non-owner inbound must not reach a consumer, got %d deliveries", len(rt.calls))
	}
}

// The other direction: with the filter on, the owner still gets through —
// including from a multi-device sender JID carrying a ":12" device suffix,
// which is what whatsmeow actually reports. An exact string match would drop
// it and the bridge would look dead.
func TestFanoutForwardsOwnerIncludingDeviceSuffix(t *testing.T) {
	for _, sender := range []string{
		"27820000001@s.whatsapp.net",
		"27820000001:12@s.whatsapp.net",
	} {
		rt := &countingRoundTripper{}
		f := NewFanout(
			[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: "http://example.invalid/hook"}},
			"27820000001@s.whatsapp.net",
			store.NewMemory(),
			func() bool { return false },
			func() time.Time { return time.Time{} },
			0,
		)
		f.client.Transport = rt

		f.Deliver(sender, "hello", "wamid.TEST", time.Now(), nil, nil)
		f.Wait()

		rt.mu.Lock()
		n := len(rt.calls)
		rt.mu.Unlock()
		if n != 1 {
			t.Fatalf("owner sender %q: want 1 delivery, got %d", sender, n)
		}
	}
}

// An unset OWNER_JID must accept everyone. The opposite default would brick
// every deployment that omits the variable, with nothing in the log to explain
// why consumers went quiet.
func TestFanoutWithNoOwnerConfiguredAcceptsEverySender(t *testing.T) {
	rt := &countingRoundTripper{}
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: "http://example.invalid/hook"}},
		"",
		store.NewMemory(),
		func() bool { return false },
		func() time.Time { return time.Time{} },
		0,
	)
	f.client.Transport = rt

	f.Deliver("27829999999@s.whatsapp.net", "hello", "wamid.TEST", time.Now(), nil, nil)
	f.Wait()

	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.calls) != 1 {
		t.Fatalf("with no owner configured every sender is accepted; got %d deliveries", len(rt.calls))
	}
}

// The inbound payload carries WhatsApp's own message id, so a consumer can
// dedupe a redelivery on the id rather than on the body. The shape is pinned
// here because docs/hermes-consumer.md publishes it as the complete payload,
// and a doc describing a field the bridge does not send is worse than no doc.
func TestInboundPayloadCarriesTheMessageID(t *testing.T) {
	body := make(chan []byte, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body <- b
	}))
	defer srv.Close()

	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "tok", WebhookURL: srv.URL}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return time.Time{} }, 0)
	f.Deliver(knownJID, "hello", "wamid.ABC123", time.Now(), nil, nil)
	f.Wait()

	var payload map[string]any
	select {
	case b := <-body:
		if err := json.Unmarshal(b, &payload); err != nil {
			t.Fatalf("payload is not JSON: %q", b)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no webhook delivery")
	}
	if payload["messageId"] != "wamid.ABC123" {
		t.Fatalf("inbound payload must forward the WhatsApp message id, got %v", payload)
	}
	// The published shape is exactly these four keys.
	for _, k := range []string{"from", "text", "messageId", "at"} {
		if _, ok := payload[k]; !ok {
			t.Fatalf("published payload key %q is missing: %v", k, payload)
		}
	}
	if len(payload) != 4 {
		t.Fatalf("payload gained a key the consumer contract does not publish: %v", payload)
	}
}

// A consumer configured with a WebhookSecret must receive a LeadStack-Signature
// header whose HMAC recomputes correctly over the exact posted body and the
// timestamp carried in the header itself — the same scheme the CRM receiver
// implements in src/lib/api/webhooks/signing.ts.
func TestFanoutSignsWebhookWhenConsumerHasASecret(t *testing.T) {
	reqBody := make(chan []byte, 1)
	sig := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		reqBody <- b
		sig <- r.Header.Get("LeadStack-Signature")
	}))
	defer srv.Close()

	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "tok", WebhookURL: srv.URL, WebhookSecret: "whsec_test"}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return time.Time{} }, 0)
	fixed := time.Unix(1_700_000_000, 0)
	f.now = func() time.Time { return fixed }

	f.Deliver(knownJID, "hello", "wamid.SIG", time.Now(), nil, nil)
	f.Wait()

	var body []byte
	var header string
	select {
	case body = <-reqBody:
		header = <-sig
	case <-time.After(2 * time.Second):
		t.Fatal("no webhook delivery")
	}

	wantTS := fixed.Unix()
	mac := hmac.New(sha256.New, []byte("whsec_test"))
	mac.Write([]byte(fmt.Sprintf("%d.", wantTS)))
	mac.Write(body)
	wantHeader := fmt.Sprintf("t=%d,v1=%s", wantTS, hex.EncodeToString(mac.Sum(nil)))

	if header != wantHeader {
		t.Fatalf("signature header mismatch:\n got %q\nwant %q", header, wantHeader)
	}
}

// A consumer with no WebhookSecret is the default and the safe one: no
// signature header at all, and the bearer token — the only credential such a
// consumer ever had — still goes out unchanged.
func TestFanoutOmitsSignatureWhenConsumerHasNoSecret(t *testing.T) {
	sig := make(chan string, 1)
	bearer := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		sig <- r.Header.Get("LeadStack-Signature")
		bearer <- r.Header.Get("Authorization")
	}))
	defer srv.Close()

	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "tok", WebhookURL: srv.URL}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return time.Time{} }, 0)
	f.Deliver(knownJID, "hello", "wamid.NOSIG", time.Now(), nil, nil)
	f.Wait()

	select {
	case got := <-sig:
		if got != "" {
			t.Fatalf("consumer with no secret must get no LeadStack-Signature header, got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no webhook delivery")
	}
	if got := <-bearer; got != "Bearer tok" {
		t.Fatalf("bearer header must still be present, got %q", got)
	}
}

// TestFanoutSignsWithAFreshTimestampEachSend guards against threading a stale
// "at" (the WhatsApp inbound time) into the signature instead of the real
// send time: the receiver enforces a 5-minute tolerance against the
// timestamp in the header, so signing history rather than "now" would reject
// on arrival for a reason that has nothing to do with forgery.
func TestFanoutSignsWithAFreshTimestampEachSend(t *testing.T) {
	sig := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		sig <- r.Header.Get("LeadStack-Signature")
	}))
	defer srv.Close()

	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "tok", WebhookURL: srv.URL, WebhookSecret: "whsec_test"}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return time.Time{} }, 0)
	fixed := time.Unix(1_700_000_000, 0)
	f.now = func() time.Time { return fixed }

	old := time.Now().Add(-24 * time.Hour)
	f.Deliver(knownJID, "hello", "wamid.OLD", old, nil, nil)
	f.Wait()

	header := <-sig
	if !strings.HasPrefix(header, fmt.Sprintf("t=%d,", fixed.Unix())) {
		t.Fatalf("signature must use the send-time clock, not the inbound message time: %q", header)
	}
}

// TestSignPayloadMatchesTheGoldenVector pins the wire format this service
// shares with the CRM that receives its webhooks.
//
// The receiver verifies with src/lib/api/webhooks/signing.ts, in a different
// language and a module neither side can import. Every other signing test here
// — and on the TypeScript side — recomputes the digest with the same
// implementation it is testing, so both suites stay green if either side
// changes the signed string, the "." separator or the "v1" prefix. Nothing
// fails until a real inbound message is silently rejected in production.
//
// This vector is asserted verbatim in signing.test.ts as well. If the two
// implementations drift, exactly one of the two suites goes red and names the
// side that moved. Changing this expectation is a wire-format change: every
// deployed bridge must be redeployed together with the receiver.
func TestSignPayloadMatchesTheGoldenVector(t *testing.T) {
	const (
		secret = "whsec_golden_vector_do_not_change"
		body   = `{"from":"27821234567@s.whatsapp.net","text":"hallo — \"toets\"","messageId":"3EB0GOLDEN","at":"2026-09-05T09:00:00Z"}`
		want   = "t=1788600000,v1=68243cdfdf788bc7bff717acef17e8ee7aec563aa8f0c1462171c3f3146e551c"
	)
	if got := signPayload(secret, []byte(body), time.Unix(1788600000, 0)); got != want {
		t.Fatalf("wire format drifted from the receiver.\n got: %s\nwant: %s", got, want)
	}
}

// countingSink is a webhook that records the bodies it received.
func countingSink(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		got = append(got, string(b))
		mu.Unlock()
	}))
	t.Cleanup(srv.Close)
	return srv, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), got...) }
}

// The reason the blanket mute had to go. It could not tell re-delivered
// history from a message that arrived one second ago, and this bridge stores
// no message body — so a dropped inbound is gone for good. Two real messages
// were lost this way on 2026-09-06, to restarts the operator had asked for.
func TestFanoutForwardsAMessageNewerThanTheWatermarkDuringReplay(t *testing.T) {
	srv, bodies := countingSink(t)
	st := store.NewMemory()
	if err := st.RecordInbound("27820000000@s.whatsapp.net", time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	connectedAt := time.Now()

	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		"", st,
		func() bool { return true }, // still inside the replay window
		func() time.Time { return connectedAt },
		0,
	)

	f.Deliver("27821234567@s.whatsapp.net", "sent while we were restarting", "wamid.NEW", time.Now(), nil, nil)
	f.Wait()

	if got := bodies(); len(got) != 1 {
		t.Fatalf("a message newer than the watermark must reach the consumer, got %d deliveries", len(got))
	}
}

// The protection this must not lose: waking a consumer with re-delivered
// history is the sibling bridge's incident.
func TestFanoutStillSuppressesHistoryOlderThanTheWatermark(t *testing.T) {
	srv, bodies := countingSink(t)
	st := store.NewMemory()
	watermark := time.Now().Add(-time.Hour)
	if err := st.RecordInbound("27820000000@s.whatsapp.net", watermark); err != nil {
		t.Fatal(err)
	}
	connectedAt := time.Now()

	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		"", st,
		func() bool { return true },
		func() time.Time { return connectedAt },
		0,
	)

	jid := "27821234567@s.whatsapp.net"
	f.Deliver(jid, "yesterday's conversation", "wamid.OLD", watermark.Add(-30*time.Minute), nil, nil)
	f.Wait()

	if got := bodies(); len(got) != 0 {
		t.Fatalf("history older than the watermark must not wake a consumer, got %d deliveries", len(got))
	}
	if ok, _ := st.HasInboundFrom(jid); !ok {
		t.Fatal("suppressed history must still be recorded, or reply-only forgets a real contact")
	}
}

// A re-pair can hand us a large backlog, all of it newer than the watermark.
// Forwarding is the right default but must be bounded, or one re-pair floods
// every thread — and the drop must be counted, because it is real data loss.
func TestFanoutCapsTheCatchUpBurst(t *testing.T) {
	srv, bodies := countingSink(t)
	st := store.NewMemory()
	connectedAt := time.Now()

	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		"", st,
		func() bool { return true },
		func() time.Time { return connectedAt },
		0,
	)

	for i := 0; i < maxCatchUpForward+25; i++ {
		f.Deliver("27821234567@s.whatsapp.net", "burst", "wamid.B", time.Now(), nil, nil)
	}
	f.Wait()

	if got := len(bodies()); got != maxCatchUpForward {
		t.Fatalf("catch-up must stop at %d, forwarded %d", maxCatchUpForward, got)
	}
	if _, capped := f.SuppressedInbound(); capped != 25 {
		t.Fatalf("the operator needs the suppressed count; got %d, want 25", capped)
	}
}

// Outside the replay window the watermark does not apply at all.
func TestFanoutIgnoresTheWatermarkOutsideTheReplayWindow(t *testing.T) {
	srv, bodies := countingSink(t)
	st := store.NewMemory()
	if err := st.RecordInbound("27820000000@s.whatsapp.net", time.Now()); err != nil {
		t.Fatal(err)
	}
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		"", st,
		func() bool { return false }, // window closed
		func() time.Time { return time.Now() },
		0,
	)
	f.Deliver("27821234567@s.whatsapp.net", "normal traffic", "wamid.X", time.Now().Add(-2*time.Hour), nil, nil)
	f.Wait()
	if got := bodies(); len(got) != 1 {
		t.Fatalf("outside the window every message forwards, got %d", len(got))
	}
}
