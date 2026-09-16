package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
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

// attach wraps a bare fetch thunk as the attachment the fanout now takes.
// Key is empty, which is what a sender who supplied neither a content hash nor
// a direct path produces: nothing to dedupe on, budget still applies.
func attach(fetch func(context.Context) *wa.InboundMedia) *wa.InboundAttachment {
	return &wa.InboundAttachment{Fetch: fetch}
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
		owner, st, func() bool { return replaying }, func() time.Time { return connectedAt }, 0)
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
	// This test isolates the CATCH-UP cap, so the per-sender media budget is
	// lifted above it: with the production default the budget would refuse
	// first and the assertion below would be measuring the wrong guard.
	// TestMediaBudgetBoundsOneSender covers the budget itself.
	f.mediaGate = newMediaGate(maxCatchUpForward + 10)

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

	f.Deliver(knownJID, "caption only", "wamid.DROP", time.Now(), attach(func(context.Context) *wa.InboundMedia {
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Dropped: "too_large"}
	}))
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
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return connectedAt }, 0)
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
	fetch := attach(func(context.Context) *wa.InboundMedia {
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
	})

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
	fetch := attach(func(context.Context) *wa.InboundMedia {
		<-release
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("b")}
	})

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

	f.Deliver(knownJID, "the caption", "wamid.BIG", time.Now(), attach(func(context.Context) *wa.InboundMedia {
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("big")}
	}))
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

// Shutdown must not lose a message because its FILE was mid-download. Drain
// cancels the download; the fetch reports "shutdown"; the message goes out
// text-only, and Drain returns well inside its budget.
func TestDrainAbandonsTheFileAndStillPostsTheMessage(t *testing.T) {
	srv, body, _ := captureOne(t)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	started := make(chan struct{})
	fetch := attach(func(ctx context.Context) *wa.InboundMedia {
		close(started)
		<-ctx.Done() // a download that would take minutes
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Dropped: "shutdown"}
	})
	f.Deliver(knownJID, "the caption", "wamid.SLOW", time.Now(), fetch)
	<-started // the download is in flight; Drain must cancel it, not pre-empt it

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.Drain(ctx); err != nil {
		t.Fatalf("Drain must complete once the download is cancelled: %v", err)
	}

	payload := awaitBody(t, body)
	if payload["text"] != "the caption" || payload["messageId"] != "wamid.SLOW" {
		t.Fatalf("the message must still be posted on shutdown: %v", payload)
	}
	if payload["mediaDropped"] != "shutdown" {
		t.Fatalf("the reason must be shutdown, got %v", payload)
	}
}

// A media POST that is mid-flight at shutdown is cancelled, and the message is
// re-posted text-only with the reason "shutdown" — not "delivery_failed",
// because the consumer did nothing wrong.
func TestDrainCancelsAMediaPostAndFallsBackWithShutdownReason(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		if _, hasMedia := p["media"]; hasMedia {
			// Hang the media POST until the test says otherwise; the client
			// side is cancelled by Drain long before.
			<-release
			return
		}
		mu.Lock()
		bodies = append(bodies, p)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	defer close(release)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	f.Deliver(knownJID, "caption", "wamid.MID", time.Now(), attach(func(context.Context) *wa.InboundMedia {
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("bytes")}
	}))
	time.Sleep(100 * time.Millisecond) // let the media POST get in flight

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.Drain(ctx); err != nil {
		t.Fatalf("Drain must complete once the media POST is cancelled: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("want exactly one text-only fallback, got %d: %v", len(bodies), bodies)
	}
	if bodies[0]["mediaDropped"] != "shutdown" || bodies[0]["messageId"] != "wamid.MID" {
		t.Fatalf("fallback must carry reason shutdown for the same message: %v", bodies[0])
	}
}

// If a delivery ignores cancellation, Drain must still return when its budget
// expires, and say what it left behind — the alternative is systemd's SIGKILL
// taking every delivery with it silently.
func TestDrainGivesUpOnBudgetAndReportsWhatItAbandoned(t *testing.T) {
	srv, _, _ := captureOne(t)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	release := make(chan struct{})
	defer close(release)
	started := make(chan struct{})
	f.Deliver(knownJID, "stuck", "wamid.STUCK", time.Now(), attach(func(context.Context) *wa.InboundMedia {
		close(started)
		<-release // ignores ctx entirely
		return &wa.InboundMedia{Dropped: "fetch_failed"}
	}))
	// The premise is a fetch ALREADY in flight. Without this, Drain can win
	// the race to the slot, and a message that never started file work is —
	// correctly — posted text-only with nothing left to abandon.
	<-started

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := f.Drain(ctx)
	if err == nil {
		t.Fatal("Drain returned nil while a delivery was still in flight")
	}
	if time.Since(start) > 1500*time.Millisecond {
		t.Fatalf("Drain took %s; it must honour its budget", time.Since(start))
	}
	if !strings.Contains(err.Error(), "1 deliveries abandoned") {
		t.Fatalf("Drain must report the abandoned count, got %v", err)
	}
}

// The text-only fallback goes through the same signer as every other POST —
// asserted on THAT body specifically, since it is a second marshal of a
// second map and a receiver rejects a stale or missing signature outright.
func TestFallbackBodyIsSigned(t *testing.T) {
	var mu sync.Mutex
	var raw [][]byte
	var sigs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		mu.Lock()
		raw = append(raw, b)
		sigs = append(sigs, r.Header.Get("LeadStack-Signature"))
		mu.Unlock()
		if _, hasMedia := p["media"]; hasMedia {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	connectedAt := time.Now()
	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL, WebhookSecret: "whsec_test"}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return connectedAt }, 0)
	fixed := time.Unix(1_700_000_000, 0)
	f.now = func() time.Time { return fixed }

	f.Deliver(knownJID, "caption", "wamid.SIGFB", time.Now(), attach(func(context.Context) *wa.InboundMedia {
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("big")}
	}))
	f.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(raw) != 2 {
		t.Fatalf("want media POST + fallback, got %d", len(raw))
	}
	mac := hmac.New(sha256.New, []byte("whsec_test"))
	mac.Write([]byte(fmt.Sprintf("%d.", fixed.Unix())))
	mac.Write(raw[1])
	want := fmt.Sprintf("t=%d,v1=%s", fixed.Unix(), hex.EncodeToString(mac.Sum(nil)))
	if sigs[1] != want {
		t.Fatalf("fallback body signature mismatch:\n got %q\nwant %q", sigs[1], want)
	}
}

// A backlog of attachments parked on the media slots at shutdown must not be
// lost to those slots. Once shutdown has begun there is no file work left to
// bound — every parked message should skip the slot, and go out text-only
// concurrently, well inside the drain budget.
//
// The fetch deliberately takes 200ms even when its context is already
// cancelled, because the real one does: validateMediaFile, DecryptFile and the
// hash take no context. A parked goroutine that still waits for a slot and
// still fetches after shutdown serialises 20 of those through 2 slots.
func TestDrainDeliversAParkedBacklogWithinBudget(t *testing.T) {
	const n = 20
	var mu sync.Mutex
	got := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		time.Sleep(300 * time.Millisecond) // a slow consumer
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		mu.Lock()
		got[fmt.Sprint(p["messageId"])] = true
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	fetch := attach(func(ctx context.Context) *wa.InboundMedia {
		<-ctx.Done()
		time.Sleep(200 * time.Millisecond) // decrypt + hash ignore ctx
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Dropped: "shutdown"}
	})
	for i := 0; i < n; i++ {
		f.Deliver(knownJID, "photo", fmt.Sprintf("wamid.%d", i), time.Now(), fetch)
	}
	time.Sleep(50 * time.Millisecond) // two hold slots, eighteen park

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	err := f.Drain(ctx)

	mu.Lock()
	defer mu.Unlock()
	if err != nil || len(got) != n {
		t.Fatalf("Drain err=%v; %d of %d parked messages reached the consumer — "+
			"the rest were lost to the media slots at shutdown", err, len(got), n)
	}
}

// A text POST — a dropped file, or no file at all — carries no memory peak and
// must not hold a media slot. Holding one serialises every such message behind
// two slots for as long as a slow consumer takes to answer.
func TestTextOnlyPostsDoNotHoldAMediaSlot(t *testing.T) {
	var mu sync.Mutex
	inFlight, maxSeen := 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		mu.Lock()
		inFlight++
		if inFlight > maxSeen {
			maxSeen = inFlight
		}
		mu.Unlock()
		time.Sleep(150 * time.Millisecond)
		mu.Lock()
		inFlight--
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	for i := 0; i < 8; i++ {
		f.Deliver(knownJID, "caption", fmt.Sprintf("wamid.%d", i), time.Now(), attach(func(context.Context) *wa.InboundMedia {
			return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Dropped: "too_large"}
		}))
	}
	f.Wait()

	mu.Lock()
	defer mu.Unlock()
	if maxSeen <= maxConcurrentMediaDeliveries {
		t.Fatalf("at most %d text-only POSTs ran at once; they are queuing on the %d media slots",
			maxSeen, maxConcurrentMediaDeliveries)
	}
}

// Once Drain has begun, Deliver must not start new work: sync.WaitGroup
// forbids Add racing a Wait at zero, and a delivery started after the drain
// budget was set is one the budget never accounted for.
//
// The message is still RECORDED — reply-only refuses an operator's reply to a
// contact with no recorded inbound — and it is reported as LOST, because it
// is: it was decrypted before shutdown, so WhatsApp's redelivery after restart
// fails with ErrOldCounter and whatsmeow ignores it without dispatching an
// event. An ALERT that promised a redelivery would send nobody looking.
func TestDeliverAfterDrainStartsNothing(t *testing.T) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)

	srv, body, _ := captureOne(t)
	st := store.NewMemory()
	f := openFanout(srv.URL, "", st, false)

	if err := f.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.Deliver(knownJID, "too late", "wamid.LATE", time.Now(), nil)

	done := make(chan struct{})
	go func() { f.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Wait did not return: Deliver added work after Drain")
	}
	time.Sleep(50 * time.Millisecond)
	if len(body) != 0 {
		t.Fatalf("a delivery after Drain was posted (%d); nothing was accounting for it", len(body))
	}
	if ok, _ := st.HasInboundFrom(knownJID); !ok {
		t.Fatal("a message arriving during shutdown was not recorded; reply-only will refuse a reply to this contact")
	}
	out := logged.String()
	if !strings.Contains(out, "LOST") || !strings.Contains(out, "will not be redelivered") {
		t.Fatalf("the ALERT must say the message is lost and will not be redelivered, got: %q", out)
	}
	if !strings.Contains(out, "wamid.LATE") {
		t.Fatalf("the ALERT must carry the WhatsApp message id so an operator can find it, got: %q", out)
	}
	if strings.Contains(out, knownJID) {
		t.Fatalf("the ALERT must carry the JID redacted, not in the clear: %q", out)
	}
}

// Deliver and Drain concurrently, under -race. Before the intake guard this
// was a documented sync.WaitGroup misuse — Add racing Wait at zero.
func TestDeliverConcurrentWithDrainIsSafe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	for round := 0; round < 50; round++ {
		f := openFanout(srv.URL, "", store.NewMemory(), false)
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				f.Deliver(knownJID, "x", fmt.Sprintf("wamid.%d", i), time.Now(), nil)
			}(i)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		if err := f.Drain(ctx); err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		cancel()
		wg.Wait()
		f.Wait()
	}
}

// A failed media POST's text-only FALLBACK carries no file and must not hold a
// media slot. Saturate both slots with deliveries whose media POST fails and
// whose fallback then blocks: if the fallback held the slot, a third
// file-carrying delivery could never start its fetch.
func TestFallbackDoesNotHoldAMediaSlot(t *testing.T) {
	fallbacks := make(chan struct{}, maxConcurrentMediaDeliveries)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		if p["messageId"] == "wamid.THIRD" {
			w.WriteHeader(http.StatusOK)
			return
		}
		if _, hasMedia := p["media"]; hasMedia {
			w.WriteHeader(http.StatusRequestEntityTooLarge) // the media POST fails fast
			return
		}
		fallbacks <- struct{}{} // the text-only fallback blocks
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	defer close(release)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	file := attach(func(context.Context) *wa.InboundMedia {
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("bytes")}
	})
	for i := 0; i < maxConcurrentMediaDeliveries; i++ {
		f.Deliver(knownJID, "caption", fmt.Sprintf("wamid.BLOCKED%d", i), time.Now(), file)
	}
	for i := 0; i < maxConcurrentMediaDeliveries; i++ {
		select {
		case <-fallbacks:
		case <-time.After(2 * time.Second):
			t.Fatal("setup: the fallbacks never reached the consumer")
		}
	}

	started := make(chan struct{})
	f.Deliver(knownJID, "third", "wamid.THIRD", time.Now(), attach(func(context.Context) *wa.InboundMedia {
		close(started)
		return &wa.InboundMedia{Filename: "photo.jpg", MimeType: "image/jpeg", Data: []byte("b")}
	}))
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatalf("with %d fallbacks blocked, a new file-carrying delivery could not get a media slot — "+
			"the text-only fallbacks are holding them", maxConcurrentMediaDeliveries)
	}
}

// panicOnceStore panics on its first RecordInbound, as a store bug or a
// corrupted database page might.
type panicOnceStore struct {
	rails.Store
	mu       sync.Mutex
	panicked bool
}

func (p *panicOnceStore) RecordInbound(jid string, at time.Time) error {
	p.mu.Lock()
	first := !p.panicked
	p.panicked = true
	p.mu.Unlock()
	if first {
		panic("store exploded")
	}
	return p.Store.RecordInbound(jid, at)
}

// whatsmeow's dispatchEvent recovers a panicking handler (client.go:980-985)
// and carries on with the next event. If Deliver panics while holding the
// intake lock and nothing releases it, the NEXT inbound blocks whatsmeow's
// event goroutine forever: every customer's messages stop, whatsmeow logs the
// stuck node — JID in the clear — every 30s, and Drain blocks until SIGKILL.
func TestPanicInsideIntakeDoesNotWedgeTheFanout(t *testing.T) {
	srv, _, _ := captureOne(t)
	f := openFanout(srv.URL, "", &panicOnceStore{Store: store.NewMemory()}, false)

	func() {
		defer func() { _ = recover() }() // what whatsmeow's dispatchEvent does
		f.Deliver(knownJID, "boom", "wamid.PANIC", time.Now(), nil)
	}()

	next := make(chan struct{})
	go func() {
		f.Deliver(knownJID, "after", "wamid.AFTER", time.Now(), nil)
		close(next)
	}()
	select {
	case <-next:
	case <-time.After(time.Second):
		t.Fatal("the next Deliver blocked after a panic inside intake — the lock was never released")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	drained := make(chan error, 1)
	go func() { drained <- f.Drain(ctx) }()
	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("Drain after a recovered panic: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Drain blocked after a panic inside intake")
	}
}

// "ALERT inbound LOST" must fire only for a message that would really have been
// forwarded. A non-owner message, or replayed history, is never posted whether
// or not the bridge is shutting down, so reporting it as lost on every drain
// would train operators to ignore the one ALERT that means a customer's
// message is gone. The closed check therefore sits after the owner filter and
// the replay gate; this pins that order.
func TestNoLostAlertForMessagesThatWouldNotHaveBeenForwarded(t *testing.T) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)

	t.Run("non-owner", func(t *testing.T) {
		logged.Reset()
		srv, body, _ := captureOne(t)
		f := openFanout(srv.URL, "27821234567@s.whatsapp.net", store.NewMemory(), false)
		if err := f.Drain(context.Background()); err != nil {
			t.Fatal(err)
		}
		f.Deliver("27829999999@s.whatsapp.net", "stranger", "wamid.STRANGER", time.Now(), nil)
		f.Wait()
		if strings.Contains(logged.String(), "LOST") {
			t.Fatalf("a non-owner message was reported LOST on shutdown: %q", logged.String())
		}
		if len(body) != 0 {
			t.Fatalf("non-owner message posted (%d)", len(body))
		}
	})

	t.Run("replayed history", func(t *testing.T) {
		logged.Reset()
		srv, body, _ := captureOne(t)
		st := store.NewMemory()
		watermark := time.Now()
		if err := st.RecordInbound("27820000000@s.whatsapp.net", watermark); err != nil {
			t.Fatal(err)
		}
		f := openFanout(srv.URL, "", st, true)
		if err := f.Drain(context.Background()); err != nil {
			t.Fatal(err)
		}
		f.Deliver(knownJID, "yesterday", "wamid.HISTORY", watermark.Add(-30*time.Minute), nil)
		f.Wait()
		if strings.Contains(logged.String(), "LOST") {
			t.Fatalf("replayed history was reported LOST on shutdown: %q", logged.String())
		}
		if len(body) != 0 {
			t.Fatalf("replayed history posted (%d)", len(body))
		}
	})
}
