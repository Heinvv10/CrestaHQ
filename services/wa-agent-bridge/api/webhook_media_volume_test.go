package api

import (
	"fmt"
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

// The per-sender table is bounded too, and it must NOT be bounded by evicting
// a live sender: eviction REFUNDS that sender's budget, which is exactly what
// an attacker holding many numbers would be buying. A full table refuses the
// new sender's file instead — fail-safe, and it still forwards the message.
func TestSenderBudgetTableIsBoundedWithoutRefunding(t *testing.T) {
	g := newMediaGate(1)
	now := time.Now()
	for i := 0; i < maxMediaSenders; i++ {
		if r := g.admit(fmt.Sprintf("jid-%d", i), "", now); r != "" {
			t.Fatalf("jid-%d refused while the table had room: %q", i, r)
		}
	}
	if r := g.admit("jid-overflow", "", now); r != mediaDroppedBudget {
		t.Fatalf("a new sender arriving at a full table must be refused, got %q", r)
	}
	g.mu.Lock()
	n := len(g.spent)
	g.mu.Unlock()
	if n > maxMediaSenders {
		t.Fatalf("sender budget table holds %d entries, above the %d bound", n, maxMediaSenders)
	}
	// Nobody already in the table was refunded.
	for i := 0; i < maxMediaSenders; i++ {
		jid := fmt.Sprintf("jid-%d", i)
		if r := g.admit(jid, "", now); r != mediaDroppedBudget {
			t.Fatalf("%s was refunded its budget: admit returned %q", jid, r)
		}
	}
	// And the table empties as windows roll over, rather than staying wedged.
	later := now.Add(inboundMediaBudgetWindow + time.Minute)
	if r := g.admit("jid-overflow", "", later); r != "" {
		t.Fatalf("once the windows expired a new sender must be admitted, got %q", r)
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
