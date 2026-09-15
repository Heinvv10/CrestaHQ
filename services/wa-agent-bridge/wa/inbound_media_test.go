package wa

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

// stubDownloader stands in for *whatsmeow.Client on the inbound media path,
// for the same reason mediaUploader exists on the outbound one: the concrete
// client cannot be made to fail, cannot be made to ship more bytes than it
// declared, and cannot record that it was never called — and all three are
// properties worth asserting.
//
// It streams through the file whatsmeow would stream through, so a test that
// hands it 64MiB genuinely exercises the cap rather than describing it.
type stubDownloader struct {
	mu sync.Mutex

	payload []byte // what it tries to write
	err     error  // returned instead of writing anything

	calls    int
	accepted int   // bytes the file actually took before refusing
	deadline bool  // whether the ctx carried one
	writeErr error // what the file refused with

	// hold, when non-nil, blocks inside the download until closed, so
	// concurrency can be observed.
	hold                    chan struct{}
	inFlight, maxConcurrent int
}

func (s *stubDownloader) DownloadToFile(ctx context.Context, _ whatsmeow.DownloadableMessage, file whatsmeow.File) error {
	s.mu.Lock()
	s.calls++
	_, s.deadline = ctx.Deadline()
	s.inFlight++
	if s.inFlight > s.maxConcurrent {
		s.maxConcurrent = s.inFlight
	}
	hold := s.hold
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.inFlight--
		s.mu.Unlock()
	}()

	if hold != nil {
		<-hold
	}
	// Read AFTER hold, not before: a test that sets err while this is blocked
	// must see it. Reading it at call time made the shutdown test flake
	// whenever the goroutine reached here before the test set the error.
	s.mu.Lock()
	err, payload := s.err, s.payload
	s.mu.Unlock()
	if err != nil {
		return err
	}

	// Driven EXACTLY as whatsmeow drives it — download-to-file.go:194 is
	// `io.Copy(file, io.TeeReader(resp.Body, hasher))`. That matters: io.Copy
	// prefers dst's ReadFrom when it has one, and a wrapper that embeds
	// *os.File silently inherits (*os.File).ReadFrom, which writes straight to
	// the inner file and bypasses any Write override. A stub that called
	// file.Write in a loop was green against exactly that bug.
	n, cerr := io.Copy(file, io.TeeReader(bytes.NewReader(payload), sha256.New()))
	s.mu.Lock()
	s.accepted = int(n)
	s.writeErr = cerr
	s.mu.Unlock()
	return cerr
}

func (s *stubDownloader) stats() (calls, accepted int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls, s.accepted
}

type inboundCall struct {
	jid, text string
	media     func(context.Context) *InboundMedia
}

func recordingClient(dl MediaDownloader) (*Client, *[]inboundCall) {
	var seen []inboundCall
	c := &Client{
		downloader: dl,
		onInbound: func(jid, text, _ string, _ time.Time, media func(context.Context) *InboundMedia) {
			seen = append(seen, inboundCall{jid, text, media})
		},
	}
	return c, &seen
}

// deliver drives one event through handleMessage and RESOLVES the attachment,
// which is what the fanout does once its rails have admitted the message.
func deliver(t *testing.T, c *Client, seen *[]inboundCall, e *waE2E.Message) (text string, media *InboundMedia) {
	t.Helper()
	evt := msgEvent("27831234567", "", false, false)
	evt.Message = e
	c.handleEvent(evt)
	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want exactly 1", len(*seen))
	}
	got := (*seen)[0]
	if got.media == nil {
		return got.text, nil
	}
	return got.text, got.media(context.Background())
}

func imageMsg(caption string, declared uint64) *waE2E.Message {
	return &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption:    proto.String(caption),
		Mimetype:   proto.String("image/jpeg"),
		FileLength: proto.Uint64(declared),
	}}
}

func TestImageMessageForwardsCaptionAndBytes(t *testing.T) {
	dl := &stubDownloader{payload: []byte("jpeg-bytes")}
	c, seen := recordingClient(dl)

	text, media := deliver(t, c, seen, imageMsg("look at this", 10))

	if text != "look at this" {
		t.Fatalf("text = %q, want the image caption", text)
	}
	if media == nil {
		t.Fatal("media is nil; the file never reached the consumer")
	}
	if string(media.Data) != "jpeg-bytes" {
		t.Fatalf("media.Data = %q", media.Data)
	}
	if media.MimeType != "image/jpeg" || media.Filename != "photo.jpg" {
		t.Fatalf("media descriptor = %q / %q", media.MimeType, media.Filename)
	}
	if media.Dropped != "" {
		t.Fatalf("media.Dropped = %q on a successful download", media.Dropped)
	}
}

// A voice note has no caption at all. Requiring text is what made this bridge
// deaf to it, and the empty-text early return is the regression the
// "non-text events are out of scope" line used to encode.
func TestCaptionlessAudioMessageIsForwarded(t *testing.T) {
	dl := &stubDownloader{payload: []byte("opus-bytes")}
	c, seen := recordingClient(dl)

	text, media := deliver(t, c, seen, &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
		Mimetype:   proto.String("audio/ogg; codecs=opus"),
		FileLength: proto.Uint64(10),
	}})

	if text != "" {
		t.Fatalf("text = %q, want empty", text)
	}
	if media == nil || media.MimeType != "audio/ogg; codecs=opus" {
		t.Fatalf("media = %+v", media)
	}
	if media.Filename != "voice-note.ogg" {
		t.Fatalf("media.Filename = %q", media.Filename)
	}
}

// THE cap test.
//
// FileLength is the SENDER's claim, and whatsmeow's Download ends in a plain
// io.ReadAll with no LimitReader (download.go:384), so a sender who declares
// 10 bytes and ships 64MiB would allocate all of it. The bound therefore has
// to sit in the file the download streams THROUGH, not in a check afterwards:
// a check afterwards runs when the memory is already gone.
//
// This test fails if the read is unbounded. It asserts on what the downloader
// was ALLOWED TO WRITE, which a post-hoc length check cannot change.
func TestDownloadIsBoundedRegardlessOfDeclaredLength(t *testing.T) {
	dl := &stubDownloader{payload: make([]byte, 64<<20)} // 64MiB, declared as 10
	c, seen := recordingClient(dl)

	_, media := deliver(t, c, seen, imageMsg("trust me", 10))

	_, accepted := dl.stats()
	if accepted > maxInboundCiphertextBytes {
		t.Fatalf("the download wrote %d bytes; the cap is %d — the read is UNBOUNDED and a "+
			"large enough file OOMs a service carrying live customer traffic",
			accepted, maxInboundCiphertextBytes)
	}
	if media == nil || media.Dropped != "too_large" {
		t.Fatalf("Dropped = %+v, want too_large", media)
	}
	if media.Data != nil {
		t.Fatalf("an over-cap download must carry no bytes, got %d", len(media.Data))
	}
}

// cappedFile must not BE an *os.File. whatsmeow's downloadMediaToFile does
// `file.(*os.File)` and, when true, fallocates resp.ContentLength before a
// byte is checked — so a hostile Content-Length would reserve 2GB of disk.
// It must also own its ReadFrom (io.Copy's preferred path) rather than
// inherit one, and must not pick up WriteTo either.
func TestCappedFileIsNotAnOsFile(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "capped-*")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var file whatsmeow.File = &cappedFile{f: f, limit: 10}

	if _, isOSFile := file.(*os.File); isOSFile {
		t.Fatal("cappedFile is an *os.File; whatsmeow will fallocate the sender's Content-Length")
	}
	if _, ok := file.(io.ReaderFrom); !ok {
		t.Fatal("cappedFile must implement ReadFrom itself, or io.Copy's behaviour is whatever Go promotes")
	}
	if _, ok := file.(io.WriterTo); ok {
		t.Fatal("cappedFile picked up a WriteTo; something is being promoted")
	}
}

// Every route by which the file can get longer is capped: the download's
// io.Copy (ReadFrom), a plain Write, the decrypt's WriteAt, and Truncate.
// In-place rewrites of already-admitted bytes are not refused — the decrypt
// depends on that — and a rewind-and-retry is measured against the same cap.
func TestCappedFileRefusesGrowthByEveryRoute(t *testing.T) {
	newCapped := func(t *testing.T) *cappedFile {
		f, err := os.CreateTemp(t.TempDir(), "capped-*")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { f.Close() })
		return &cappedFile{f: f, limit: 8}
	}

	t.Run("ReadFrom via io.Copy", func(t *testing.T) {
		c := newCapped(t)
		n, err := io.Copy(c, whatsmeowBody(make([]byte, 64)))
		if !errors.Is(err, errMediaTooLarge) {
			t.Fatalf("io.Copy of 64 bytes into an 8-byte cap: n=%d err=%v, want errMediaTooLarge", n, err)
		}
		if st, _ := c.Stat(); st.Size() > 8 {
			t.Fatalf("file grew to %d on disk past the cap", st.Size())
		}
	})
	t.Run("Write", func(t *testing.T) {
		c := newCapped(t)
		if _, err := c.Write(make([]byte, 8)); err != nil {
			t.Fatalf("a write exactly at the cap must succeed: %v", err)
		}
		if _, err := c.Write([]byte{1}); !errors.Is(err, errMediaTooLarge) {
			t.Fatalf("one byte past the cap: %v", err)
		}
	})
	t.Run("WriteAt", func(t *testing.T) {
		c := newCapped(t)
		if _, err := c.Write(make([]byte, 8)); err != nil {
			t.Fatal(err)
		}
		if _, err := c.WriteAt([]byte{1, 2, 3, 4}, 4); err != nil {
			t.Fatalf("an in-place WriteAt inside the admitted region must succeed (the decrypt needs it): %v", err)
		}
		if _, err := c.WriteAt([]byte{1}, 8); !errors.Is(err, errMediaTooLarge) {
			t.Fatalf("WriteAt extending past the cap: %v", err)
		}
	})
	t.Run("Truncate", func(t *testing.T) {
		c := newCapped(t)
		if err := c.Truncate(4); err != nil {
			t.Fatalf("shrinking or growing within the cap must succeed: %v", err)
		}
		if err := c.Truncate(9); !errors.Is(err, errMediaTooLarge) {
			t.Fatalf("Truncate past the cap: %v", err)
		}
	})
	t.Run("rewind and retry is measured afresh", func(t *testing.T) {
		c := newCapped(t)
		if _, err := c.Write(make([]byte, 6)); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Seek(0, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Write(make([]byte, 8)); err != nil {
			t.Fatalf("a retry from offset 0 of a file within the cap must succeed: %v", err)
		}
	})
}

// The declared length is still worth checking: it refuses the honest oversize
// sender without opening a connection at all.
func TestDeclaredOversizeMediaIsNotDownloaded(t *testing.T) {
	dl := &stubDownloader{payload: []byte("never-used")}
	c, seen := recordingClient(dl)

	text, media := deliver(t, c, seen, imageMsg("huge", maxInboundMediaBytes+1))

	if text != "huge" {
		t.Fatalf("text = %q; the caption must survive", text)
	}
	if media == nil || media.Dropped != "too_large" {
		t.Fatalf("media = %+v, want Dropped=too_large", media)
	}
	if calls, _ := dl.stats(); calls != 0 {
		t.Fatalf("downloader ran %d times for a declared-oversize file", calls)
	}
}

// The cap is a number an operator sizes systemd limits against, so it is
// pinned rather than computed — every other test here works off ±1 and would
// stay green if this became 2GB.
func TestInboundMediaCapIsSixteenMiB(t *testing.T) {
	if maxInboundMediaBytes != 16*1024*1024 {
		t.Fatalf("maxInboundMediaBytes = %d, want 16MiB", maxInboundMediaBytes)
	}
	// The on-disk allowance must exceed it (AES-CBC padding plus the 10-byte
	// MAC) but must not be a second, looser cap.
	if maxInboundCiphertextBytes <= maxInboundMediaBytes ||
		maxInboundCiphertextBytes > maxInboundMediaBytes+(64<<10) {
		t.Fatalf("maxInboundCiphertextBytes = %d is not a thin allowance over %d",
			maxInboundCiphertextBytes, maxInboundMediaBytes)
	}
}

func TestFailedDownloadStillForwardsTheMessage(t *testing.T) {
	dl := &stubDownloader{err: errors.New("media server said no")}
	c, seen := recordingClient(dl)

	text, media := deliver(t, c, seen, imageMsg("caption survives", 10))

	if text != "caption survives" {
		t.Fatalf("text = %q", text)
	}
	if media == nil || media.Dropped != "fetch_failed" {
		t.Fatalf("media = %+v, want Dropped=fetch_failed", media)
	}
	if media.Data != nil {
		t.Fatal("a failed download must carry no bytes")
	}
}

// Without a downloader the file cannot be fetched, but the message is still a
// message. A nil interface must degrade, not panic.
func TestMissingDownloaderDropsOnlyTheFile(t *testing.T) {
	c, seen := recordingClient(nil)

	text, media := deliver(t, c, seen, imageMsg("no client", 10))

	if text != "no client" {
		t.Fatalf("text = %q", text)
	}
	if media == nil || media.Dropped != "fetch_failed" {
		t.Fatalf("media = %+v, want Dropped=fetch_failed", media)
	}
}

// The download must carry its own deadline: it holds one of a small number of
// media slots, so a stalled CDN would otherwise keep the next customer's
// attachment waiting forever.
func TestDownloadCarriesADeadline(t *testing.T) {
	dl := &stubDownloader{payload: []byte("bytes")}
	c, seen := recordingClient(dl)

	deliver(t, c, seen, imageMsg("x", 5))

	dl.mu.Lock()
	defer dl.mu.Unlock()
	if !dl.deadline {
		t.Fatal("the download context carried no deadline; a stalled download would hold a media slot forever")
	}
}

func TestDocumentKeepsItsSenderFilename(t *testing.T) {
	dl := &stubDownloader{payload: []byte("%PDF")}
	c, seen := recordingClient(dl)

	_, media := deliver(t, c, seen, &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
		Caption:    proto.String("the quote"),
		Mimetype:   proto.String("application/pdf"),
		FileName:   proto.String("Quote-1042.pdf"),
		FileLength: proto.Uint64(4),
	}})

	if media == nil || media.Filename != "Quote-1042.pdf" {
		t.Fatalf("media = %+v", media)
	}
}

// Video and sticker are the two branches nothing else here reaches. Deleting
// either from attachmentFrom left the suite green before this test existed.
func TestVideoAndStickerAreDownloadedToo(t *testing.T) {
	t.Run("video", func(t *testing.T) {
		dl := &stubDownloader{payload: []byte("mp4")}
		c, seen := recordingClient(dl)
		text, media := deliver(t, c, seen, &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
			Caption:    proto.String("clip"),
			Mimetype:   proto.String("video/mp4"),
			FileLength: proto.Uint64(3),
		}})
		if text != "clip" {
			t.Fatalf("text = %q", text)
		}
		if media == nil || string(media.Data) != "mp4" || media.Filename != "video.mp4" {
			t.Fatalf("media = %+v", media)
		}
	})

	t.Run("sticker", func(t *testing.T) {
		dl := &stubDownloader{payload: []byte("webp")}
		c, seen := recordingClient(dl)
		text, media := deliver(t, c, seen, &waE2E.Message{StickerMessage: &waE2E.StickerMessage{
			Mimetype:   proto.String("image/webp"),
			FileLength: proto.Uint64(4),
		}})
		if text != "" {
			t.Fatalf("a sticker carries no caption, got %q", text)
		}
		if media == nil || string(media.Data) != "webp" || media.Filename != "sticker.webp" {
			t.Fatalf("media = %+v", media)
		}
	})
}

// An unknown mime must still produce a usable name. A consumer that saves the
// file needs an extension, and ".bin" is honest about not knowing.
func TestSynthNameFallsBackToBin(t *testing.T) {
	if got := synthName("photo", "image/heic"); got != "photo.bin" {
		t.Fatalf("synthName for an unknown type = %q, want photo.bin", got)
	}
	if got := synthName("voice-note", "audio/ogg; codecs=opus"); got != "voice-note.ogg" {
		t.Fatalf("mime parameters must be stripped before lookup, got %q", got)
	}
}

func TestTextMessageStillCarriesNoMedia(t *testing.T) {
	dl := &stubDownloader{payload: []byte("never-used")}
	c, seen := recordingClient(dl)

	c.handleEvent(msgEvent("27831234567", "just text", false, false))

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1", len(*seen))
	}
	if (*seen)[0].media != nil {
		t.Fatal("a text message must carry no media thunk at all")
	}
	if calls, _ := dl.stats(); calls != 0 {
		t.Fatalf("downloader ran %d times for a text message", calls)
	}
}

// handleMessage runs on whatsmeow's node-handler goroutine. It must hand the
// attachment on as an UNRESOLVED thunk: holding that goroutine for a download
// makes whatsmeow log the node — customer JID included — at WARN past five
// seconds, and lets a sender the rails would refuse dictate our network use.
func TestHandleMessageDownloadsNothing(t *testing.T) {
	dl := &stubDownloader{payload: []byte("bytes")}
	c, seen := recordingClient(dl)

	evt := msgEvent("27831234567", "", false, false)
	evt.Message = imageMsg("a photo", 5)
	c.handleEvent(evt)

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1", len(*seen))
	}
	if (*seen)[0].media == nil {
		t.Fatal("an attachment must be offered as a thunk, not omitted")
	}
	if calls, _ := dl.stats(); calls != 0 {
		t.Fatalf("handleMessage downloaded %d times; the download must happen only "+
			"after the fanout's rails admit the message", calls)
	}

	// And resolving it is what downloads.
	if media := (*seen)[0].media(context.Background()); media == nil || string(media.Data) != "bytes" {
		t.Fatalf("resolving the thunk must download, got %+v", media)
	}
	if calls, _ := dl.stats(); calls != 1 {
		t.Fatalf("downloader calls = %d, want 1", calls)
	}
}

// View-once media is stored like any other — a deliberate product and POPIA
// decision (2026-09-15), not whatsmeow's accident. This test starts from
// the RAW wrapped message and runs whatsmeow's own UnwrapRaw, so it pins both
// halves: that whatsmeow still flattens ViewOnceMessageV2 into an
// ImageMessage, and that this bridge still forwards the bytes when it does.
// A whatsmeow bump that changes UnwrapRaw fails here instead of flipping the
// behaviour silently.
func TestViewOnceMediaIsStoredLikeAnyOther(t *testing.T) {
	dl := &stubDownloader{payload: []byte("disappearing-photo")}
	c, seen := recordingClient(dl)

	evt := msgEvent("27831234567", "", false, false)
	evt.RawMessage = &waE2E.Message{ViewOnceMessageV2: &waE2E.FutureProofMessage{
		Message: imageMsg("for your eyes only", 18),
	}}
	evt.Message = nil
	evt.UnwrapRaw()
	if !evt.IsViewOnce {
		t.Fatal("whatsmeow no longer flags the unwrapped message as view-once; re-read the decision in ParseInbound")
	}
	c.handleEvent(evt)

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1", len(*seen))
	}
	got := (*seen)[0]
	if got.text != "for your eyes only" || got.media == nil {
		t.Fatalf("view-once must be forwarded like any other media, got text=%q media=%v", got.text, got.media != nil)
	}
	if media := got.media(context.Background()); media == nil || string(media.Data) != "disappearing-photo" {
		t.Fatalf("view-once bytes must be downloaded and forwarded, got %+v", media)
	}
}

func TestNonTextNonMediaEventIsStillDropped(t *testing.T) {
	c, seen := recordingClient(&stubDownloader{})

	e := msgEvent("27831234567", "", false, false)
	e.Message = &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
		Text: proto.String("👍"),
	}}
	c.handleEvent(e)

	if len(*seen) != 0 {
		t.Fatalf("dispatched %d inbound for a reaction, want 0", len(*seen))
	}
}

// A download the BRIDGE cancels — shutdown — is not a download that failed.
// The reason on the wire must say so, or an operator reading "fetch_failed"
// after every deploy goes hunting a media-server problem that does not exist.
func TestCancelledDownloadIsReportedAsShutdown(t *testing.T) {
	dl := &stubDownloader{hold: make(chan struct{})}
	c, seen := recordingClient(dl)

	evt := msgEvent("27831234567", "", false, false)
	evt.Message = imageMsg("caption", 5)
	c.handleEvent(evt)
	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1", len(*seen))
	}

	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan *InboundMedia, 1)
	go func() { got <- (*seen)[0].media(ctx) }()

	// The stub blocks on hold and ignores ctx, as a real HTTP body read would
	// until the transport notices; cancel, then release, and the fetch must
	// attribute the resulting error to the cancellation.
	cancel()
	dl.mu.Lock()
	dl.err = context.Canceled
	dl.mu.Unlock()
	close(dl.hold)

	select {
	case media := <-got:
		if media == nil || media.Dropped != "shutdown" {
			t.Fatalf("Dropped = %+v, want shutdown", media)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fetch did not return after cancellation")
	}
}

// Read must move the offset the cap measures from. validateMediaFile rewinds
// and reads the whole file before the decrypt writes back, so a Read that did
// not advance pos would let a following Write start from 0 and extend the file
// past the cap unrefused.
func TestCappedFileReadAdvancesTheOffset(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "capped-*")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	c := &cappedFile{f: f, limit: 8}

	if _, err := c.Write(make([]byte, 8)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(c, make([]byte, 8)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte{1}); !errors.Is(err, errMediaTooLarge) {
		t.Fatalf("a write after reading to the cap must be refused; got %v — Read did not advance the offset", err)
	}
}

// whatsmeow's DownloadMediaWithPathToFile tries the next media host after a
// non-retryable error WITHOUT rewinding the file, so the second host's bytes
// land after the first host's. Two normal-sized responses can therefore
// cross the cap between them. That is a corrupt download (whatsmeow's hash
// check would fail it), not an oversize FILE, and must not be labelled one:
// "too_large" tells an operator and a consumer that the customer sent
// something big.
//
// The disk bound still holds — the write is still refused — only the label
// changes.
func TestHostSwitchOverflowIsNotReportedAsTooLarge(t *testing.T) {
	t.Run("cappedFile", func(t *testing.T) {
		f, err := os.CreateTemp(t.TempDir(), "capped-*")
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		c := &cappedFile{f: f, limit: 16}

		// Host 1: 10 bytes, then whatsmeow gives up on it.
		if _, err := io.Copy(c, whatsmeowBody(make([]byte, 10))); err != nil {
			t.Fatalf("first host within the cap: %v", err)
		}
		// Host 2: 10 more bytes from offset 10, no rewind.
		_, err = io.Copy(c, whatsmeowBody(make([]byte, 10)))
		if err == nil {
			t.Fatal("the combined write crossed the cap and was not refused; the disk bound is gone")
		}
		if errors.Is(err, errMediaTooLarge) {
			t.Fatalf("two 10-byte responses against a 16-byte cap were labelled too large: %v", err)
		}
		if st, _ := c.Stat(); st.Size() > 16 {
			t.Fatalf("file grew to %d past the cap", st.Size())
		}
	})

	t.Run("one response over the cap is still too large", func(t *testing.T) {
		f, err := os.CreateTemp(t.TempDir(), "capped-*")
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		c := &cappedFile{f: f, limit: 16}
		if _, err := io.Copy(c, whatsmeowBody(make([]byte, 10))); err != nil {
			t.Fatal(err)
		}
		// Host 2 alone ships more than the cap.
		if _, err := io.Copy(c, whatsmeowBody(make([]byte, 20))); !errors.Is(err, errMediaTooLarge) {
			t.Fatalf("a single response over the cap must be too large, got %v", err)
		}
	})

	t.Run("through the fetch", func(t *testing.T) {
		dl := &twoHostDownloader{perHost: 10 << 20} // 10MiB from each of two hosts
		c, seen := recordingClient(dl)
		_, media := deliver(t, c, seen, imageMsg("normal photo", 10<<20))
		if media == nil || media.Dropped != "fetch_failed" {
			t.Fatalf("Dropped = %q, want fetch_failed for a host-switch overflow", media.Dropped)
		}
	})
}

// twoHostDownloader reproduces whatsmeow's host loop: io.Copy one response,
// fail it, io.Copy the next into the same file with no rewind.
type twoHostDownloader struct{ perHost int }

func (d *twoHostDownloader) DownloadToFile(_ context.Context, _ whatsmeow.DownloadableMessage, file whatsmeow.File) error {
	var err error
	for host := 0; host < 2; host++ {
		_, err = io.Copy(file, io.TeeReader(bytes.NewReader(make([]byte, d.perHost)), sha256.New()))
		if err != nil {
			return err
		}
	}
	return errors.New("hash of media ciphertext doesn't match")
}

// whatsmeowBody is a source shaped like whatsmeow's: an io.TeeReader, which
// does NOT implement io.WriterTo. That matters for any test of io.Copy into
// cappedFile — io.Copy checks the SOURCE's WriteTo before the destination's
// ReadFrom, so a bytes.Reader source silently takes the Write path and a
// "ReadFrom" test never calls ReadFrom.
func whatsmeowBody(b []byte) io.Reader {
	return io.TeeReader(bytes.NewReader(b), sha256.New())
}

// Guard on the helper itself: if it ever gains WriteTo, every ReadFrom test
// above silently stops testing ReadFrom.
func TestWhatsmeowBodyForcesReadFrom(t *testing.T) {
	if _, ok := whatsmeowBody(nil).(io.WriterTo); ok {
		t.Fatal("whatsmeowBody implements io.WriterTo; io.Copy would bypass cappedFile.ReadFrom in every test using it")
	}
}

// The whatsmeow sequence that makes Read's offset load-bearing: host 1's
// response is written, validateMediaFile rewinds and reads the whole file to
// check the MAC, fails, and host 2 writes on from where that read left the
// file — with no rewind. If Read did not advance the offset the cap measures,
// host 2 would be checked from 0 while the OS writes from the end, and the cap
// would become per HOST (times however many hosts) instead of per FILE. The
// host-switch relabelling (errMediaCorruptOverflow) must not loosen that
// either: only the label changes, never whether the write is refused.
func TestCapIsPerFileAcrossAValidatedHostSwitch(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "capped-*")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	c := &cappedFile{f: f, limit: 16, runStart: -1}

	if _, err := io.Copy(c, whatsmeowBody(make([]byte, 10))); err != nil {
		t.Fatalf("host 1: %v", err)
	}
	if _, err := c.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, c); err != nil { // validateMediaFile's read
		t.Fatal(err)
	}
	_, err = io.Copy(c, whatsmeowBody(make([]byte, 10))) // host 2, no rewind
	if err == nil {
		t.Fatal("host 2 crossed the per-file cap unrefused")
	}
	if st, _ := c.Stat(); st.Size() > 16 {
		t.Fatalf("file is %d bytes against a 16-byte cap — the cap is per host, not per file", st.Size())
	}
}
