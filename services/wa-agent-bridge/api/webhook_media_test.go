package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/wa"
)

// captureOne spins up a consumer webhook that records the first request's body
// and signature header.
func captureOne(t *testing.T) (srv *httptest.Server, body chan []byte, sig chan string) {
	t.Helper()
	body = make(chan []byte, 4)
	sig = make(chan string, 4)
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body <- b
		sig <- r.Header.Get("LeadStack-Signature")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, body, sig
}

func awaitBody(t *testing.T, body chan []byte) map[string]any {
	t.Helper()
	select {
	case b := <-body:
		var payload map[string]any
		if err := json.Unmarshal(b, &payload); err != nil {
			t.Fatalf("payload is not JSON: %q", b)
		}
		return payload
	case <-time.After(2 * time.Second):
		t.Fatal("no webhook delivery")
		return nil
	}
}

// The file must reach the consumer inline, base64-encoded, inside the same
// payload the message already travels in — that is the whole of A3 on the wire.
func TestDeliverForwardsMediaInline(t *testing.T) {
	srv, body, _ := captureOne(t)

	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return time.Time{} })
	f.Deliver(knownJID, "look at this", "wamid.MEDIA", time.Now(), &wa.InboundMedia{
		Filename: "photo.jpg",
		MimeType: "image/jpeg",
		Data:     []byte{0xff, 0xd8, 0xff, 0x00},
	})
	f.Wait()

	payload := awaitBody(t, body)
	media, ok := payload["media"].(map[string]any)
	if !ok {
		t.Fatalf("payload carries no media object: %v", payload)
	}
	if media["filename"] != "photo.jpg" || media["mimeType"] != "image/jpeg" {
		t.Fatalf("media descriptor = %v", media)
	}
	got, err := base64.StdEncoding.DecodeString(fmt.Sprint(media["dataBase64"]))
	if err != nil {
		t.Fatalf("dataBase64 does not decode: %v", err)
	}
	if string(got) != string([]byte{0xff, 0xd8, 0xff, 0x00}) {
		t.Fatalf("decoded bytes = %x", got)
	}
	if _, present := payload["mediaDropped"]; present {
		t.Fatalf("a successful download must not also claim a drop: %v", payload)
	}
}

// A dropped file is reported, never silently omitted. An operator seeing a
// bare caption would read the thread as if no file had been sent.
func TestDeliverForwardsMediaDroppedMarker(t *testing.T) {
	srv, body, _ := captureOne(t)

	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return time.Time{} })
	f.Deliver(knownJID, "caption only", "wamid.DROP", time.Now(), &wa.InboundMedia{
		Filename: "photo.jpg",
		MimeType: "image/jpeg",
		Dropped:  "too_large",
	})
	f.Wait()

	payload := awaitBody(t, body)
	if payload["mediaDropped"] != "too_large" {
		t.Fatalf("payload must carry the drop reason: %v", payload)
	}
	if _, present := payload["media"]; present {
		t.Fatalf("a dropped file must not also produce a media object: %v", payload)
	}
	if payload["text"] != "caption only" {
		t.Fatalf("the message itself must still be forwarded: %v", payload)
	}
}

// Today's payload is four keys and consumers are entitled to it byte for byte.
// Marshalling media unconditionally would send `"media": null` to every text
// message on a live rail.
func TestDeliverWithoutMediaKeepsTodaysPayload(t *testing.T) {
	srv, body, _ := captureOne(t)

	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return time.Time{} })
	f.Deliver(knownJID, "hello", "wamid.TEXT", time.Now(), nil)
	f.Wait()

	payload := awaitBody(t, body)
	if len(payload) != 4 {
		t.Fatalf("a text inbound must post exactly the four published keys, got %v", payload)
	}
	for _, k := range []string{"from", "text", "messageId", "at"} {
		if _, ok := payload[k]; !ok {
			t.Fatalf("published key %q missing: %v", k, payload)
		}
	}
}

// The HMAC covers the whole marshalled body, so it must verify over a payload
// that includes the media. Nothing about signing changes — this proves it.
func TestMediaPayloadIsSignedOverTheWholeBody(t *testing.T) {
	srv, body, sig := captureOne(t)

	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL, WebhookSecret: "whsec_test"}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return time.Time{} })
	fixed := time.Unix(1_700_000_000, 0)
	f.now = func() time.Time { return fixed }

	f.Deliver(knownJID, "look", "wamid.SIGMEDIA", time.Now(), &wa.InboundMedia{
		Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("bytes"),
	})
	f.Wait()

	var raw []byte
	select {
	case raw = <-body:
	case <-time.After(2 * time.Second):
		t.Fatal("no webhook delivery")
	}
	header := <-sig

	mac := hmac.New(sha256.New, []byte("whsec_test"))
	mac.Write([]byte(fmt.Sprintf("%d.", fixed.Unix())))
	mac.Write(raw)
	want := fmt.Sprintf("t=%d,v1=%s", fixed.Unix(), hex.EncodeToString(mac.Sum(nil)))
	if header != want {
		t.Fatalf("signature does not cover the media body:\n got %q\nwant %q", header, want)
	}
}

// Media passes through every rail exactly as text does. These three are the
// guards a media message must not be able to route around — they are asserted
// again here with a media payload because "the file arrives" must never mean
// "the file arrives from a stranger, or out of history".
func TestMediaIsSubjectToTheOwnerFilter(t *testing.T) {
	calls := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL}},
		"27821234567@s.whatsapp.net", store.NewMemory(),
		func() bool { return false }, func() time.Time { return time.Time{} })
	f.Deliver("27829999999@s.whatsapp.net", "stranger's photo", "wamid.X", time.Now(), &wa.InboundMedia{
		Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("bytes"),
	})
	f.Wait()

	if len(calls) != 0 {
		t.Fatalf("media from a non-owner must not be forwarded, got %d deliveries", len(calls))
	}
}

func TestMediaOlderThanTheWatermarkIsNotForwarded(t *testing.T) {
	calls := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	st := store.NewMemory()
	watermark := time.Now()
	if err := st.RecordInbound("27820000000@s.whatsapp.net", watermark); err != nil {
		t.Fatal(err)
	}
	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL}},
		"", st, func() bool { return true }, func() time.Time { return time.Now() })

	f.Deliver(knownJID, "yesterday's photo", "wamid.OLD", watermark.Add(-30*time.Minute), &wa.InboundMedia{
		Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("bytes"),
	})
	f.Wait()

	if len(calls) != 0 {
		t.Fatalf("replayed media must be recorded, not forwarded; got %d deliveries", len(calls))
	}
	if ok, _ := st.HasInboundFrom(knownJID); !ok {
		t.Fatal("replayed media inbound must still be recorded — reply-only depends on it")
	}
}

func TestMediaIsSubjectToTheCatchUpCap(t *testing.T) {
	var delivered int
	done := make(chan struct{}, maxCatchUpForward+10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		done <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// connectedAt must be STABLE, or the watermark re-snapshots on every
	// message, the catch-up counter resets and the cap never fires.
	connectedAt := time.Now()
	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL}},
		"", store.NewMemory(), func() bool { return true }, func() time.Time { return connectedAt })

	for i := 0; i < maxCatchUpForward+5; i++ {
		f.Deliver(knownJID, "burst", "wamid.B", time.Now(), &wa.InboundMedia{
			Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("bytes"),
		})
	}
	f.Wait()
	delivered = len(done)

	if delivered != maxCatchUpForward {
		t.Fatalf("catch-up cap must bound media exactly as it bounds text: forwarded %d, want %d",
			delivered, maxCatchUpForward)
	}
	if _, capped := f.SuppressedInbound(); capped != 5 {
		t.Fatalf("suppressed-capped count = %d, want 5", capped)
	}
}
