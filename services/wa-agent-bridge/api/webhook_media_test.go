package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/wa"
)

// countingDownloader is the socket-side half of the seam: a wa.MediaDownloader
// that streams fixed bytes and counts how often it was asked to. The count is
// the assertion that matters in this file — a rail that refuses a message must
// refuse the DOWNLOAD, not just the POST.
type countingDownloader struct {
	mu      sync.Mutex
	calls   int
	payload []byte
}

func (d *countingDownloader) DownloadToFile(_ context.Context, _ whatsmeow.DownloadableMessage, f whatsmeow.File) error {
	d.mu.Lock()
	d.calls++
	d.mu.Unlock()
	_, err := f.Write(d.payload)
	return err
}

func (d *countingDownloader) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls
}

// imageEvent is a real whatsmeow event carrying an image from sender, as the
// socket would deliver it.
func imageEvent(sender, caption string, at time.Time) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			ID: "wamid.IMG",
			MessageSource: types.MessageSource{
				Sender: types.JID{User: sender, Server: types.DefaultUserServer},
			},
			Timestamp: at,
		},
		Message: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Caption:    proto.String(caption),
			Mimetype:   proto.String("image/jpeg"),
			FileLength: proto.Uint64(4),
		}},
	}
}

// deliverEvent joins the two halves: the socket's event goes through
// wa.ParseInbound exactly as handleMessage does it, and the result goes into
// Deliver exactly as main.go wires it. No half-built *wa.InboundMedia is ever
// constructed by hand here.
func deliverEvent(f *Fanout, evt *events.Message, dl wa.MediaDownloader) {
	in := wa.ParseInbound(evt, dl)
	f.Deliver(in.JID, in.Text, in.MsgID, in.At, in.Media)
}

func captureOne(t *testing.T) (srv *httptest.Server, body chan []byte, sig chan string) {
	t.Helper()
	body = make(chan []byte, 8)
	sig = make(chan string, 8)
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

func openFanout(url string, owner string, st rails.Store, replaying bool) *Fanout {
	connectedAt := time.Now()
	return NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: url}},
		owner, st, func() bool { return replaying }, func() time.Time { return connectedAt })
}

// Socket event in, HTTP body out. The file must reach the consumer inline,
// base64-encoded, inside the same payload the message already travels in.
func TestInboundImageReachesTheConsumerInline(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte{0xff, 0xd8, 0xff, 0x00}}
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	deliverEvent(f, imageEvent("27821234567", "look at this", time.Now()), dl)
	f.Wait()

	payload := awaitBody(t, body)
	if payload["text"] != "look at this" || payload["messageId"] != "wamid.IMG" {
		t.Fatalf("message fields wrong: %v", payload)
	}
	media, ok := payload["media"].(map[string]any)
	if !ok {
		t.Fatalf("payload carries no media object: %v", payload)
	}
	if media["filename"] != "photo.jpg" || media["mimeType"] != "image/jpeg" {
		t.Fatalf("media descriptor = %v", media)
	}
	got, err := base64.StdEncoding.DecodeString(fmt.Sprint(media["dataBase64"]))
	if err != nil || string(got) != string([]byte{0xff, 0xd8, 0xff, 0x00}) {
		t.Fatalf("dataBase64 = %v (%v)", media["dataBase64"], err)
	}
	if _, present := payload["mediaDropped"]; present {
		t.Fatalf("a successful download must not also claim a drop: %v", payload)
	}
	if dl.count() != 1 {
		t.Fatalf("downloader calls = %d, want exactly 1", dl.count())
	}
}

// A stranger the bridge is configured to ignore must not be able to make it
// download anything. The old shape downloaded inside handleMessage, before
// this filter ever ran.
func TestNonOwnerMediaIsNeverDownloaded(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte("bytes")}
	f := openFanout(srv.URL, "27821234567@s.whatsapp.net", store.NewMemory(), false)

	deliverEvent(f, imageEvent("27829999999", "stranger's photo", time.Now()), dl)
	f.Wait()

	if len(body) != 0 {
		t.Fatalf("non-owner media must not be forwarded, got %d deliveries", len(body))
	}
	if dl.count() != 0 {
		t.Fatalf("the owner filter refused the message but the file was downloaded %d times — "+
			"a stranger controls this bridge's network use", dl.count())
	}
}

// Replayed history must be recorded, not forwarded — and not fetched. A
// reconnect re-delivers a day of messages; downloading every photo in it only
// to discard them is the cost the thunk exists to avoid.
func TestReplayedMediaIsNeitherForwardedNorDownloaded(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte("bytes")}
	st := store.NewMemory()
	watermark := time.Now()
	if err := st.RecordInbound("27820000000@s.whatsapp.net", watermark); err != nil {
		t.Fatal(err)
	}
	f := openFanout(srv.URL, "", st, true)

	deliverEvent(f, imageEvent("27821234567", "yesterday's photo", watermark.Add(-30*time.Minute)), dl)
	f.Wait()

	if len(body) != 0 {
		t.Fatalf("replayed media must not be forwarded, got %d deliveries", len(body))
	}
	if dl.count() != 0 {
		t.Fatalf("replayed media was downloaded %d times before being discarded", dl.count())
	}
	if ok, _ := st.HasInboundFrom("27821234567@s.whatsapp.net"); !ok {
		t.Fatal("replayed inbound must still be recorded — reply-only depends on it")
	}
}

func TestMediaIsSubjectToTheCatchUpCap(t *testing.T) {
	done := make(chan struct{}, maxCatchUpForward+10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		done <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	dl := &countingDownloader{payload: []byte("bytes")}
	f := openFanout(srv.URL, "", store.NewMemory(), true)

	for i := 0; i < maxCatchUpForward+5; i++ {
		deliverEvent(f, imageEvent("27821234567", "burst", time.Now()), dl)
	}
	f.Wait()

	if len(done) != maxCatchUpForward {
		t.Fatalf("catch-up cap must bound media exactly as it bounds text: forwarded %d, want %d",
			len(done), maxCatchUpForward)
	}
	if _, capped := f.SuppressedInbound(); capped != 5 {
		t.Fatalf("suppressed-capped count = %d, want 5", capped)
	}
	if dl.count() != maxCatchUpForward {
		t.Fatalf("downloads = %d; the 5 capped messages must not have been fetched", dl.count())
	}
}

// A dropped file is reported, never silently omitted. An operator seeing a
// bare caption would read the thread as if no file had been sent.
func TestDeliverForwardsMediaDroppedMarker(t *testing.T) {
	srv, body, _ := captureOne(t)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	f.Deliver(knownJID, "caption only", "wamid.DROP", time.Now(), func() *wa.InboundMedia {
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Dropped: "too_large"}
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
func TestDeliverWithoutMediaKeepsTodaysPayload(t *testing.T) {
	srv, body, _ := captureOne(t)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

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

// The HMAC covers the whole marshalled body, media included.
func TestMediaPayloadIsSignedOverTheWholeBody(t *testing.T) {
	srv, body, sig := captureOne(t)
	dl := &countingDownloader{payload: []byte("bytes")}
	connectedAt := time.Now()
	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL, WebhookSecret: "whsec_test"}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return connectedAt })
	fixed := time.Unix(1_700_000_000, 0)
	f.now = func() time.Time { return fixed }

	deliverEvent(f, imageEvent("27821234567", "look", time.Now()), dl)
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

// The memory bound is a semaphore in THIS code, not an assumption about
// whatsmeow's goroutines. Twenty attachments offered at once must be resolved
// at most maxConcurrentMediaDeliveries at a time.
func TestMediaDeliveriesAreBounded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	var mu sync.Mutex
	inFlight, maxSeen := 0, 0
	fetch := func() *wa.InboundMedia {
		mu.Lock()
		inFlight++
		if inFlight > maxSeen {
			maxSeen = inFlight
		}
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		inFlight--
		mu.Unlock()
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("b")}
	}

	for i := 0; i < 20; i++ {
		f.Deliver(knownJID, "burst", fmt.Sprintf("wamid.%d", i), time.Now(), fetch)
	}
	f.Wait()

	mu.Lock()
	defer mu.Unlock()
	if maxSeen > maxConcurrentMediaDeliveries {
		t.Fatalf("%d attachments were in flight at once; the bound is %d", maxSeen, maxConcurrentMediaDeliveries)
	}
	if maxSeen < 2 {
		t.Fatalf("only %d in flight — the semaphore is serialising, which would stall every customer behind one slow consumer", maxSeen)
	}
}

// Deliver must return to whatsmeow's goroutine without waiting on the
// download. Past five seconds whatsmeow logs the node — customer JID in the
// clear — at WARN; the only defence is to never be slow there.
func TestDeliverReturnsBeforeTheDownloadRuns(t *testing.T) {
	srv, _, _ := captureOne(t)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	release := make(chan struct{})
	fetch := func() *wa.InboundMedia {
		<-release
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("b")}
	}

	returned := make(chan struct{})
	go func() {
		f.Deliver(knownJID, "slow", "wamid.SLOW", time.Now(), fetch)
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("Deliver blocked on the download; whatsmeow's node-handler goroutine is being held")
	}
	close(release)
	f.Wait()
}

// A POST carrying 21MiB can fail where the same message as text would not.
// The FILE may be lost then; the customer's MESSAGE may not — it is re-posted
// text-only with the reason, because the bridge stores no body to replay from
// later.
func TestFailedMediaDeliveryFallsBackToTextOnly(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		mu.Lock()
		bodies = append(bodies, p)
		mu.Unlock()
		if _, hasMedia := p["media"]; hasMedia {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	f.Deliver(knownJID, "the caption", "wamid.BIG", time.Now(), func() *wa.InboundMedia {
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("big")}
	})
	f.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 {
		t.Fatalf("want the media POST then a text-only retry, got %d POSTs: %v", len(bodies), bodies)
	}
	retry := bodies[1]
	if _, hasMedia := retry["media"]; hasMedia {
		t.Fatalf("the retry must not carry the file that just failed: %v", retry)
	}
	if retry["mediaDropped"] != "delivery_failed" {
		t.Fatalf("the retry must say why the file is missing, got %v", retry)
	}
	if retry["text"] != "the caption" || retry["messageId"] != "wamid.BIG" {
		t.Fatalf("the retry must be the same message: %v", retry)
	}
}

// A failed TEXT delivery must not be retried — there is nothing to strip, and
// a second identical POST to a consumer that just refused one is noise.
func TestFailedTextDeliveryIsNotRetried(t *testing.T) {
	var mu sync.Mutex
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		posts++
		mu.Unlock()
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	f.Deliver(knownJID, "hello", "wamid.T", time.Now(), nil)
	f.Wait()

	mu.Lock()
	defer mu.Unlock()
	if posts != 1 {
		t.Fatalf("a failed text POST must not be retried, got %d posts", posts)
	}
}
