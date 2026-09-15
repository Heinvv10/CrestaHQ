package wa

import (
	"context"
	"errors"
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
	hold, err, payload := s.hold, s.err, s.payload
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.inFlight--
		s.mu.Unlock()
	}()

	if hold != nil {
		<-hold
	}
	if err != nil {
		return err
	}

	// Written in chunks, exactly as io.Copy would, so the cap is exercised
	// mid-stream rather than on one giant Write the real client never makes.
	const chunk = 1 << 20
	written := 0
	for written < len(payload) {
		end := written + chunk
		if end > len(payload) {
			end = len(payload)
		}
		n, werr := file.Write(payload[written:end])
		written += n
		if werr != nil {
			s.mu.Lock()
			s.accepted, s.writeErr = written, werr
			s.mu.Unlock()
			return werr
		}
	}
	s.mu.Lock()
	s.accepted = written
	s.mu.Unlock()
	return nil
}

func (s *stubDownloader) stats() (calls, accepted int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls, s.accepted
}

type inboundCall struct {
	jid, text string
	media     func() *InboundMedia
}

func recordingClient(dl MediaDownloader) (*Client, *[]inboundCall) {
	var seen []inboundCall
	c := &Client{
		downloader: dl,
		onInbound: func(jid, text, _ string, _ time.Time, media func() *InboundMedia) {
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
	return got.text, got.media()
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
	if media := (*seen)[0].media(); media == nil || string(media.Data) != "bytes" {
		t.Fatalf("resolving the thunk must download, got %+v", media)
	}
	if calls, _ := dl.stats(); calls != 1 {
		t.Fatalf("downloader calls = %d, want 1", calls)
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
