package api

import (
	"context"
	"errors"

	"encoding/json"
	"fmt"
	"go.mau.fi/whatsmeow"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// uploadedImageEvent is a real socket event carrying an image, with the two
// fields that make one UPLOADED FILE identifiable across many messages: the
// plaintext content hash and the CDN path. imageEvent above omits both, which
// is the shape of a sender who gives this bridge nothing to dedupe on.
//
// sha is the file; msgID is the message. Varying one while holding the other
// is the whole amplification, so they are separate parameters.
func uploadedImageEvent(sender, msgID, sha, path string, at time.Time) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			ID: msgID,
			MessageSource: types.MessageSource{
				Sender: types.JID{User: sender, Server: types.DefaultUserServer},
			},
			Timestamp: at,
		},
		Message: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Caption:    proto.String("caption"),
			Mimetype:   proto.String("image/jpeg"),
			FileLength: proto.Uint64(4),
			FileSHA256: []byte(sha),
			DirectPath: proto.String(path),
		}},
	}
}

// drainBodies reads n webhook payloads and tallies what happened to the file
// in each.
func drainBodies(t *testing.T, body chan []byte, n int) (withFile int, dropped map[string]int) {
	t.Helper()
	dropped = map[string]int{}
	for i := 0; i < n; i++ {
		p := awaitBody(t, body)
		if _, ok := p["media"]; ok {
			withFile++
			continue
		}
		reason, ok := p["mediaDropped"].(string)
		if !ok {
			t.Fatalf("payload carries neither media nor mediaDropped: %v", p)
		}
		dropped[reason]++
	}
	return withFile, dropped
}

// ONE uploaded file, cited by many messages, is downloaded ONCE.
//
// This is the amplification. WhatsApp uploads a file once; anyone can then
// reference it from as many messages as they like, each with its own message
// id. Before the gate this cost one full 16MiB download and one ~21.3MiB POST
// per MESSAGE, bounded by nothing outside the replay window — the baseline run
// of this test observed 5 downloads for 5 messages.
//
// Every message still reaches the consumer. Only the repeat FILES are refused,
// and they say so by name.
func TestOneUploadedFileIsDownloadedOnceHoweverManyMessagesCiteIt(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	const n = 5
	for i := 0; i < n; i++ {
		deliverEvent(f, uploadedImageEvent("27821234567",
			fmt.Sprintf("wamid.CITE%d", i), "one-uploaded-file", "/v/t62/one", time.Now()), dl)
	}
	f.Wait()

	if dl.count() != 1 {
		t.Fatalf("%d messages citing ONE uploaded file caused %d downloads, want 1", n, dl.count())
	}
	withFile, dropped := drainBodies(t, body, n)
	if withFile != 1 || dropped[mediaDroppedDuplicate] != n-1 {
		t.Fatalf("payloads: %d carried the file, dropped=%v; want 1 with the file and %d %q",
			withFile, dropped, n-1, mediaDroppedDuplicate)
	}
}

// A DIFFERENT file from the same sender is still fetched. The gate must bound
// repetition, not photos.
func TestDistinctFilesAreEachDownloaded(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	for i := 0; i < 3; i++ {
		deliverEvent(f, uploadedImageEvent("27821234567",
			fmt.Sprintf("wamid.DIFF%d", i), fmt.Sprintf("file-%d", i),
			fmt.Sprintf("/v/t62/%d", i), time.Now()), dl)
	}
	f.Wait()

	if dl.count() != 3 {
		t.Fatalf("three different files caused %d downloads, want 3", dl.count())
	}
	if withFile, dropped := drainBodies(t, body, 3); withFile != 3 {
		t.Fatalf("payloads: %d carried the file, dropped=%v; want all 3 with the file", withFile, dropped)
	}
}

// Dedupe keys on the FILE, so a sender who varies the content hash still meets
// the per-sender budget — and that budget applies OUTSIDE the replay window,
// where the catch-up cap does not.
//
// The message is forwarded every time. Only the file is skipped, and the
// downloader is never reached for a refused one.
func TestMediaBudgetBoundsOneSenderOutsideTheReplayWindow(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	// replaying=false: the catch-up cap is not in play at all here.
	f := openFanout(srv.URL, "", store.NewMemory(), false)
	const budget = 3
	f.mediaGate = newMediaGate(budget)

	const n = budget + 4
	for i := 0; i < n; i++ {
		deliverEvent(f, uploadedImageEvent("27821234567",
			fmt.Sprintf("wamid.BUD%d", i), fmt.Sprintf("distinct-file-%d", i),
			fmt.Sprintf("/v/t62/b%d", i), time.Now()), dl)
	}
	f.Wait()

	if dl.count() != budget {
		t.Fatalf("a single sender drove %d downloads against a budget of %d", dl.count(), budget)
	}
	withFile, dropped := drainBodies(t, body, n)
	if withFile != budget || dropped[mediaDroppedBudget] != n-budget {
		t.Fatalf("payloads: %d carried the file, dropped=%v; want %d with the file and %d %q",
			withFile, dropped, budget, n-budget, mediaDroppedBudget)
	}
}

// One sender exhausting their budget must not silence another. A shared
// counter would make any customer able to blind the bridge to every other.
func TestMediaBudgetIsPerSender(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	f := openFanout(srv.URL, "", store.NewMemory(), false)
	f.mediaGate = newMediaGate(1)

	for i := 0; i < 2; i++ {
		deliverEvent(f, uploadedImageEvent("27821234567",
			fmt.Sprintf("wamid.A%d", i), fmt.Sprintf("noisy-%d", i), "/v/a", time.Now()), dl)
	}
	deliverEvent(f, uploadedImageEvent("27831112222", "wamid.B0", "quiet-0", "/v/b", time.Now()), dl)
	f.Wait()

	if dl.count() != 2 {
		t.Fatalf("downloads = %d, want 2: one per sender's first file", dl.count())
	}
	withFile, dropped := drainBodies(t, body, 3)
	if withFile != 2 || dropped[mediaDroppedBudget] != 1 {
		t.Fatalf("payloads: %d carried the file, dropped=%v; want 2 with the file and 1 %q",
			withFile, dropped, mediaDroppedBudget)
	}
}

// The budget refills. A customer who sent a lot of photos this morning must
// not be file-deaf for the rest of the process's life.
func TestMediaBudgetRefillsAfterTheWindow(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	f := openFanout(srv.URL, "", store.NewMemory(), false)
	f.mediaGate = newMediaGate(1)
	clock := time.Now()
	f.now = func() time.Time { return clock }

	deliverEvent(f, uploadedImageEvent("27821234567", "wamid.W0", "f0", "/v/0", clock), dl)
	deliverEvent(f, uploadedImageEvent("27821234567", "wamid.W1", "f1", "/v/1", clock), dl)
	f.Wait()
	if dl.count() != 1 {
		t.Fatalf("setup: downloads = %d, want 1", dl.count())
	}

	clock = clock.Add(inboundMediaBudgetWindow + time.Minute)
	deliverEvent(f, uploadedImageEvent("27821234567", "wamid.W2", "f2", "/v/2", clock), dl)
	f.Wait()

	if dl.count() != 2 {
		t.Fatalf("downloads = %d after the window rolled over, want 2 — the budget never refilled", dl.count())
	}
	if withFile, dropped := drainBodies(t, body, 3); withFile != 2 || dropped[mediaDroppedBudget] != 1 {
		t.Fatalf("payloads: %d carried the file, dropped=%v", withFile, dropped)
	}
}

// The dedupe table must not remember a file forever; and it must not forget it
// while the sender's budget is still refilling, or the pair of guards would
// have a hole between them.
func TestDedupeTTLOutlivesTheBudgetWindow(t *testing.T) {
	if mediaSeenTTL <= inboundMediaBudgetWindow {
		t.Fatalf("mediaSeenTTL %s must exceed the budget window %s, or a file becomes "+
			"re-downloadable exactly when the sender's budget refills", mediaSeenTTL, inboundMediaBudgetWindow)
	}
	g := newMediaGate(10)
	start := time.Now()
	if r := g.admit("jid", "k", start); r != "" {
		t.Fatalf("first admit refused: %q", r)
	}
	if r := g.admit("jid", "k", start.Add(mediaSeenTTL-time.Second)); r != mediaDroppedDuplicate {
		t.Fatalf("inside the TTL the file is a duplicate, got %q", r)
	}
	if r := g.admit("jid", "k", start.Add(mediaSeenTTL)); r != "" {
		t.Fatalf("past the TTL the file must be fetchable again, got %q", r)
	}
}

// A sender who supplies neither hash nor path gives nothing to dedupe on. That
// must not become a free pass: the budget is the bound that still holds.
func TestUnidentifiableMediaStillMeetsTheBudget(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	f := openFanout(srv.URL, "", store.NewMemory(), false)
	f.mediaGate = newMediaGate(2)

	// imageEvent carries no FileSHA256 and no DirectPath.
	for i := 0; i < 4; i++ {
		deliverEvent(f, imageEvent("27821234567", "burst", time.Now()), dl)
	}
	f.Wait()

	if dl.count() != 2 {
		t.Fatalf("downloads = %d against a budget of 2 for media with no content identity", dl.count())
	}
	if withFile, dropped := drainBodies(t, body, 4); withFile != 2 || dropped[mediaDroppedBudget] != 2 {
		t.Fatalf("payloads: %d carried the file, dropped=%v", withFile, dropped)
	}
}

// The dedupe table is bounded in SIZE, not only in age. An attacker with a
// fresh file every time must not be able to grow it without limit — the budget
// stops them long before this, but a guard that relies on another guard being
// perfect is not a bound.
func TestDedupeTableIsBounded(t *testing.T) {
	g := newMediaGate(maxMediaSeen * 4)
	now := time.Now()
	for i := 0; i < maxMediaSeen*2; i++ {
		g.admit("jid", fmt.Sprintf("k%d", i), now)
	}
	g.mu.Lock()
	n := len(g.seen)
	g.mu.Unlock()
	if n > maxMediaSeen {
		t.Fatalf("dedupe table holds %d entries, above the %d bound", n, maxMediaSeen)
	}
}

// The per-sender table is bounded, and it is bounded by EVICTING rather than
// by refusing. Refusing was the first version and it failed the wrong way: an
// eviction refunds at most one sender's hourly allowance, while refusing
// denies every new sender every file for as long as an attacker keeps the
// table full — and it does not self-heal, because a known sender whose window
// rolls over refreshes `since`, so the attacker's entries never expire.
func TestSenderBudgetTableEvictsRatherThanRefusingNewSenders(t *testing.T) {
	g := newMediaGate(1)
	now := time.Now()
	for i := 0; i < maxMediaSenders; i++ {
		if r := g.admit(fmt.Sprintf("jid-%d@s.whatsapp.net", i), "", now); r != "" {
			t.Fatalf("jid-%d refused while the table had room: %q", i, r)
		}
	}

	// A brand-new customer arriving at a full table gets their file.
	if r := g.admit("newcomer@s.whatsapp.net", "", now); r != "" {
		t.Fatalf("a new sender at a full table was refused with %q — this denies real "+
			"customers' files for as long as an attacker holds the table full", r)
	}
	// And it stays that way while the attacker keeps sending, rather than
	// wedging after the first one.
	for i := 0; i < 5; i++ {
		if r := g.admit(fmt.Sprintf("newcomer-%d@s.whatsapp.net", i), "", now); r != "" {
			t.Fatalf("new sender %d refused at a full table with %q", i, r)
		}
	}

	g.mu.Lock()
	n := len(g.spent)
	g.mu.Unlock()
	if n > maxMediaSenders {
		t.Fatalf("sender budget table holds %d entries, above the %d bound", n, maxMediaSenders)
	}
}

// Eviction is affordable only because it is bounded: each one refunds at most
// ONE sender, never the whole table.
func TestEvictionRefundsOnlyOneSender(t *testing.T) {
	g := newMediaGate(1)
	now := time.Now()
	for i := 0; i < maxMediaSenders; i++ {
		g.admit(fmt.Sprintf("jid-%d@s.whatsapp.net", i), "", now)
	}
	g.admit("newcomer@s.whatsapp.net", "", now) // evicts exactly one

	refunded := 0
	for i := 0; i < maxMediaSenders; i++ {
		if g.admit(fmt.Sprintf("jid-%d@s.whatsapp.net", i), "", now) == "" {
			refunded++
		}
	}
	// One eviction, so at most one of the originals got its budget back — and
	// each of those re-admits can itself evict one more, so allow for the
	// cascade rather than pinning an exact number.
	if refunded > maxMediaSenders/2 {
		t.Fatalf("%d of %d senders were refunded by eviction; the refund is meant to be "+
			"one sender at a time, not the table", refunded, maxMediaSenders)
	}
}

// A refusal must cost the sender nothing. Both tables are written only on the
// path that actually downloads, so a file the budget refused is not also
// recorded as "seen" — otherwise the sender's next hour would refuse it again
// as a duplicate of a download that never happened, and the file would be
// unreachable for the whole dedupe TTL.
func TestARefusedDownloadBurnsNeitherTable(t *testing.T) {
	g := newMediaGate(1)
	now := time.Now()

	if r := g.admit("jid", "first-file", now); r != "" {
		t.Fatalf("setup: first file refused: %q", r)
	}
	if r := g.admit("jid", "second-file", now); r != mediaDroppedBudget {
		t.Fatalf("setup: second file should exhaust the budget of 1, got %q", r)
	}

	// The budget refills, and the file the budget refused is fetchable — it
	// was never downloaded, so it is not a duplicate of anything.
	later := now.Add(inboundMediaBudgetWindow + time.Minute)
	if r := g.admit("jid", "second-file", later); r != "" {
		t.Fatalf("a file the BUDGET refused came back as %q; the refusal recorded it as downloaded", r)
	}

	// And a duplicate costs no budget either: with one spend left in this
	// window, a repeat must be refused as a duplicate and the real next file
	// must still get through.
	g2 := newMediaGate(2)
	if r := g2.admit("jid", "f", now); r != "" {
		t.Fatalf("setup: %q", r)
	}
	if r := g2.admit("jid", "f", now); r != mediaDroppedDuplicate {
		t.Fatalf("setup: repeat should be a duplicate, got %q", r)
	}
	if r := g2.admit("jid", "g", now); r != "" {
		t.Fatalf("the duplicate spent budget: a genuine second file was refused with %q", r)
	}
}

// waitForWaiters blocks until exactly n deliveries are queued for a media slot.
func waitForWaiters(t *testing.T, f *Fanout, n int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.mediaWaitMu.Lock()
		got := f.mediaWaiting
		f.mediaWaitMu.Unlock()
		if got == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("media queue holds %d waiters, want %d", got, n)
		}
		time.Sleep(time.Millisecond)
	}
}

// The aggregate bound. A per-sender budget bounds ONE abuser; it does nothing
// about a flood of DISTINCT senders, each comfortably inside its own budget,
// all arriving at once. They used to queue on the media semaphore without
// limit — a goroutine and a held message each.
//
// Every sender here is distinct and every file is distinct, so neither the
// dedupe nor the per-sender budget can be what refuses them: this test fails
// if the ONLY thing bounding the queue is one of the other two guards.
func TestMediaBacklogIsBoundedAcrossDistinctSenders(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var reasons []string
	posted := make(chan struct{}, 256)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		if _, carries := p["media"]; carries {
			// The file-carrying POSTs block, holding every media slot, which
			// is what makes everything behind them queue.
			<-release
			w.WriteHeader(http.StatusOK)
			return
		}
		mu.Lock()
		reasons = append(reasons, fmt.Sprint(p["mediaDropped"]))
		mu.Unlock()
		posted <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	defer close(release)

	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	send := func(i int) {
		deliverEvent(f, uploadedImageEvent(fmt.Sprintf("2782000%04d", i),
			fmt.Sprintf("wamid.FLOOD%d", i), fmt.Sprintf("file-%d", i),
			fmt.Sprintf("/v/t62/f%d", i), time.Now()), dl)
	}

	// Fill every slot. These download and then block in their media POST.
	for i := 0; i < maxConcurrentMediaDeliveries; i++ {
		send(i)
	}
	// Fill the queue behind them.
	for i := maxConcurrentMediaDeliveries; i < maxConcurrentMediaDeliveries+maxMediaWaiting; i++ {
		send(i)
	}
	waitForWaiters(t, f, maxMediaWaiting)

	// Everything past the bound is refused at once, by name, without waiting
	// and without fetching.
	const overflow = 5
	base := maxConcurrentMediaDeliveries + maxMediaWaiting
	for i := base; i < base+overflow; i++ {
		send(i)
	}
	for i := 0; i < overflow; i++ {
		select {
		case <-posted:
		case <-time.After(3 * time.Second):
			t.Fatal("an overflow message never reached the consumer — it is queued, not refused")
		}
	}

	mu.Lock()
	got := append([]string(nil), reasons...)
	mu.Unlock()
	if len(got) != overflow {
		t.Fatalf("consumer saw %d refusals %v, want %d", len(got), got, overflow)
	}
	for _, r := range got {
		if r != mediaDroppedBacklog {
			t.Fatalf("refusal reason %q, want %q — the message was dropped by the wrong guard", r, mediaDroppedBacklog)
		}
	}
	// The queue never grew past the bound, and the overflow fetched nothing.
	f.mediaWaitMu.Lock()
	waiting := f.mediaWaiting
	f.mediaWaitMu.Unlock()
	if waiting > maxMediaWaiting {
		t.Fatalf("media queue grew to %d waiters, above the %d bound", waiting, maxMediaWaiting)
	}
	if dl.count() != maxConcurrentMediaDeliveries {
		t.Fatalf("downloads = %d; only the %d slot holders may have fetched — the queued and "+
			"refused deliveries must not have", dl.count(), maxConcurrentMediaDeliveries)
	}
}

// The queue must DRAIN. A waiter that takes a place and never gives it back
// wedges the bound permanently: after maxMediaWaiting deliveries in the whole
// life of the process every later file would be refused as backlog, which
// looks exactly like a working bound until you count.
func TestMediaQueueDrains(t *testing.T) {
	n := maxMediaWaiting + 2
	// Its own consumer rather than captureOne: this test posts more messages
	// than that helper's channels buffer, and a handler blocked writing to
	// one of them would hold the very delivery the assertion waits for.
	var mu sync.Mutex
	var missing []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		if _, ok := p["media"]; !ok {
			mu.Lock()
			missing = append(missing, fmt.Sprint(p["mediaDropped"]))
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	// More deliveries than the bound, one at a time so nothing legitimately
	// queues: every one of them must get its file.
	for i := 0; i < n; i++ {
		deliverEvent(f, uploadedImageEvent(fmt.Sprintf("2783000%04d", i),
			fmt.Sprintf("wamid.SEQ%d", i), fmt.Sprintf("seq-file-%d", i),
			fmt.Sprintf("/v/t62/s%d", i), time.Now()), dl)
		f.Wait()
	}

	mu.Lock()
	lost := append([]string(nil), missing...)
	mu.Unlock()
	if len(lost) != 0 {
		t.Fatalf("%d of %d deliveries carried no file (%v) — the media queue is not giving "+
			"places back", len(lost), n, lost)
	}
	if dl.count() != n {
		t.Fatalf("downloads = %d over %d sequential deliveries", dl.count(), n)
	}
	f.mediaWaitMu.Lock()
	waiting := f.mediaWaiting
	f.mediaWaitMu.Unlock()
	if waiting != 0 {
		t.Fatalf("media queue left holding %d waiters after everything drained", waiting)
	}
}

// Two customers forwarding the SAME file must both get it.
//
// This is the accidental half of the cross-sender bug, and it is the one that
// would have happened in normal use: WhatsApp forwards preserve the plaintext
// bytes, so one fault photo or price list forwarded by two customers carries
// ONE fileSHA256. With a global dedupe table the second customer's file would
// have vanished from the CRM, silently, as a "duplicate" of a file they never
// sent.
func TestTwoSendersForwardingOneFileBothGetIt(t *testing.T) {
	srv, body, _ := captureOne(t)
	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	const forwarded = "the-same-forwarded-photo"
	deliverEvent(f, uploadedImageEvent("27821111111", "wamid.FWD1", forwarded, "/v/t62/fwd", time.Now()), dl)
	f.Wait()
	deliverEvent(f, uploadedImageEvent("27832222222", "wamid.FWD2", forwarded, "/v/t62/fwd", time.Now()), dl)
	f.Wait()

	if dl.count() != 2 {
		t.Fatalf("downloads = %d; two DIFFERENT customers forwarding one file must each get it", dl.count())
	}
	if withFile, dropped := drainBodies(t, body, 2); withFile != 2 {
		t.Fatalf("%d of 2 payloads carried the file, dropped=%v — one customer's photo was "+
			"suppressed by another's", withFile, dropped)
	}
}

// failingDownloader fetches nothing and fails, as a sender citing a hash with
// no valid media behind it would.
type failingDownloader struct{}

func (failingDownloader) DownloadToFile(context.Context, whatsmeow.DownloadableMessage, whatsmeow.File) error {
	return errors.New("no such media")
}

// The adversarial half: one sender must not be able to suppress another's
// file. fileSHA256 is sender-supplied protobuf this bridge never verifies
// against any bytes, so knowing a file's plaintext hash is enough to claim it
// — and the claim used to be recorded before the fetch and never rolled back,
// so a failed fetch still poisoned the entry for everyone.
//
// Both halves of the fix are asserted here: the attacker's claim is scoped to
// the attacker, AND their failed fetch leaves no entry at all.
func TestOneSenderCannotSuppressAnothersFile(t *testing.T) {
	srv, body, _ := captureOne(t)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	const victimFile = "the-victims-real-file"
	// The attacker cites the victim's hash with nothing behind it.
	deliverEvent(f, uploadedImageEvent("27899999999", "wamid.ATK", victimFile, "/v/t62/atk", time.Now()),
		failingDownloader{})
	f.Wait()
	if p := awaitBody(t, body); p["mediaDropped"] != "fetch_failed" {
		t.Fatalf("setup: the attacker's fetch should have failed, got %v", p)
	}

	// The victim's genuine send must still arrive, with its bytes.
	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	deliverEvent(f, uploadedImageEvent("27821234567", "wamid.VICTIM", victimFile, "/v/t62/real", time.Now()), dl)
	f.Wait()

	if dl.count() != 1 {
		t.Fatalf("the victim's file was downloaded %d times, want 1 — another sender's claim "+
			"suppressed it", dl.count())
	}
	p := awaitBody(t, body)
	if _, ok := p["media"]; !ok {
		t.Fatalf("the victim's message arrived without its file (%v) — suppressed by another sender",
			p["mediaDropped"])
	}
}

// A fetch that failed must not suppress the SAME sender's later genuine send
// either. The entry is taken before the fetch, so without a rollback the
// customer resends the photo and the bridge answers "duplicate" for a file it
// never delivered.
func TestAFailedFetchDoesNotSuppressALaterSend(t *testing.T) {
	srv, body, _ := captureOne(t)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	const file = "one-file-two-attempts"
	deliverEvent(f, uploadedImageEvent("27821234567", "wamid.TRY1", file, "/v/t62/x", time.Now()),
		failingDownloader{})
	f.Wait()
	if p := awaitBody(t, body); p["mediaDropped"] != "fetch_failed" {
		t.Fatalf("setup: want fetch_failed, got %v", p)
	}

	dl := &countingDownloader{payload: []byte{1, 2, 3, 4}}
	deliverEvent(f, uploadedImageEvent("27821234567", "wamid.TRY2", file, "/v/t62/x", time.Now()), dl)
	f.Wait()

	if dl.count() != 1 {
		t.Fatalf("the resend was downloaded %d times, want 1 — the failed attempt is still "+
			"recorded as delivered", dl.count())
	}
	if p := awaitBody(t, body); p["mediaDropped"] == mediaDroppedDuplicate {
		t.Fatal("a resend after a FAILED fetch was answered \"duplicate\" for a file that never arrived")
	}
	// The budget, unlike the dedupe entry, is NOT refunded: two attempts cost
	// two. Otherwise a sender gets unlimited failed downloads.
	g := newMediaGate(2)
	now := time.Now()
	g.admit("jid@s.whatsapp.net", "k", now)
	g.forget("jid@s.whatsapp.net", "k", now)
	g.admit("jid@s.whatsapp.net", "k2", now)
	if r := g.admit("jid@s.whatsapp.net", "k3", now); r != mediaDroppedBudget {
		t.Fatalf("a failed fetch refunded the budget: third admit against a budget of 2 returned %q", r)
	}
}

// One human with several linked devices is ONE sender. whatsmeow reports
// "2782...:12@s.whatsapp.net" on a multi-device account, so keying on the raw
// string would hand them a fresh budget per device — and defeat the dedupe for
// the very repeats it exists to catch.
func TestDeviceSuffixDoesNotSplitTheSender(t *testing.T) {
	g := newMediaGate(1)
	now := time.Now()

	if r := g.admit("27821234567:12@s.whatsapp.net", "one-file", now); r != "" {
		t.Fatalf("first device refused: %q", r)
	}
	if r := g.admit("27821234567:47@s.whatsapp.net", "one-file", now); r != mediaDroppedDuplicate {
		t.Fatalf("the same file from another DEVICE of the same sender returned %q, want %q",
			r, mediaDroppedDuplicate)
	}
	if r := g.admit("27821234567@s.whatsapp.net", "another-file", now); r != mediaDroppedBudget {
		t.Fatalf("a second device got its own budget: returned %q, want %q", r, mediaDroppedBudget)
	}
}

// forget undoes THIS delivery's record and no other.
//
// No caller can reach that today — while an entry stands, a second delivery
// citing the same file from the same sender is refused as a duplicate and
// never rewrites it, so there is never a newer record for a late forget to
// destroy. The pin is a precondition of the method rather than a live guard,
// and it is asserted here so that a future caller which CAN reach it does not
// silently delete a newer sender's record and reopen the amplification.
func TestForgetOnlyUndoesItsOwnRecord(t *testing.T) {
	g := newMediaGate(10)
	now := time.Now()
	if r := g.admit("jid@s.whatsapp.net", "k", now); r != "" {
		t.Fatalf("setup: %q", r)
	}

	g.forget("jid@s.whatsapp.net", "k", now.Add(-time.Minute))
	if r := g.admit("jid@s.whatsapp.net", "k", now); r != mediaDroppedDuplicate {
		t.Fatalf("a forget carrying another delivery's timestamp deleted this record: admit returned %q", r)
	}

	// Its own timestamp does undo it.
	g.forget("jid@s.whatsapp.net", "k", now)
	if r := g.admit("jid@s.whatsapp.net", "k", now); r != "" {
		t.Fatalf("forget with the record's own timestamp did not undo it: %q", r)
	}
}
