package wa

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

// stubDownloader stands in for *whatsmeow.Client on the inbound media path,
// for the same reason mediaUploader exists on the outbound one: the concrete
// client cannot be made to fail, or to record that it was never called, and
// both of those are the properties worth asserting here.
type stubDownloader struct {
	calls int
	data  []byte
	err   error
}

func (s *stubDownloader) Download(_ context.Context, _ whatsmeow.DownloadableMessage) ([]byte, error) {
	s.calls++
	return s.data, s.err
}

type inboundCall struct {
	jid, text string
	media     *InboundMedia
}

// recordingClient wires a Client whose onInbound appends to the returned slice
// pointer, with dl as its downloader.
func recordingClient(dl mediaDownloader) (*Client, *[]inboundCall) {
	var seen []inboundCall
	c := &Client{
		downloader: dl,
		onInbound: func(jid, text, _ string, _ time.Time, media *InboundMedia) {
			seen = append(seen, inboundCall{jid, text, media})
		},
	}
	return c, &seen
}

func imageEvent(caption string, length uint64) *waE2E.Message {
	return &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption:    proto.String(caption),
		Mimetype:   proto.String("image/jpeg"),
		FileLength: proto.Uint64(length),
	}}
}

// An image with a caption must reach the consumer as the caption PLUS the
// bytes. Today handleMessage returns early on anything that is not
// Conversation or ExtendedTextMessage, so this is the whole feature.
func TestImageMessageForwardsCaptionAndBytes(t *testing.T) {
	dl := &stubDownloader{data: []byte("jpeg-bytes")}
	c, seen := recordingClient(dl)

	e := msgEvent("27831234567", "", false, false)
	e.Message = imageEvent("look at this", 10)
	c.handleEvent(e)

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1", len(*seen))
	}
	got := (*seen)[0]
	if got.text != "look at this" {
		t.Fatalf("text = %q, want the image caption", got.text)
	}
	if got.media == nil {
		t.Fatal("media is nil; the file never reached the consumer")
	}
	if string(got.media.Data) != "jpeg-bytes" {
		t.Fatalf("media.Data = %q", got.media.Data)
	}
	if got.media.MimeType != "image/jpeg" {
		t.Fatalf("media.MimeType = %q", got.media.MimeType)
	}
	if got.media.Filename != "photo.jpg" {
		t.Fatalf("media.Filename = %q; an unnamed blob is what the consumer would store", got.media.Filename)
	}
	if got.media.Dropped != "" {
		t.Fatalf("media.Dropped = %q on a successful download", got.media.Dropped)
	}
}

// A voice note has no caption at all. The early return on empty text is
// exactly what makes the bridge deaf to it today, so this is the regression
// the "non-text events are out of scope" line encodes.
func TestCaptionlessAudioMessageIsForwarded(t *testing.T) {
	dl := &stubDownloader{data: []byte("opus-bytes")}
	c, seen := recordingClient(dl)

	e := msgEvent("27831234567", "", false, false)
	e.Message = &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
		Mimetype:   proto.String("audio/ogg; codecs=opus"),
		FileLength: proto.Uint64(10),
	}}
	c.handleEvent(e)

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1 — a caption-less voice note is still a message", len(*seen))
	}
	got := (*seen)[0]
	if got.text != "" {
		t.Fatalf("text = %q, want empty", got.text)
	}
	if got.media == nil || got.media.MimeType != "audio/ogg; codecs=opus" {
		t.Fatalf("media = %+v", got.media)
	}
	if got.media.Filename != "voice-note.ogg" {
		t.Fatalf("media.Filename = %q", got.media.Filename)
	}
}

// The size cap is enforced from the protobuf's own FileLength, BEFORE the
// download runs. Checking it afterwards would mean pulling 60MiB into the
// process to discover it was too big.
func TestOversizeMediaIsNotDownloaded(t *testing.T) {
	dl := &stubDownloader{data: []byte("never-used")}
	c, seen := recordingClient(dl)

	e := msgEvent("27831234567", "", false, false)
	e.Message = imageEvent("huge", maxInboundMediaBytes+1)
	c.handleEvent(e)

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1 — the MESSAGE is never dropped, only the file", len(*seen))
	}
	got := (*seen)[0]
	if got.text != "huge" {
		t.Fatalf("text = %q; the caption must survive", got.text)
	}
	if got.media == nil || got.media.Dropped != "too_large" {
		t.Fatalf("media = %+v, want Dropped=too_large", got.media)
	}
	if got.media.Data != nil {
		t.Fatalf("dropped media must carry no bytes, got %d", len(got.media.Data))
	}
	if dl.calls != 0 {
		t.Fatalf("downloader ran %d times for an oversize file; the cap must be checked from FileLength first", dl.calls)
	}
}

// FileLength is the SENDER's claim. A file that understated itself must be
// refused on measurement too, or the cap means nothing against anyone who
// would actually try to exceed it.
func TestUnderstatedMediaIsRefusedAfterDownload(t *testing.T) {
	dl := &stubDownloader{data: make([]byte, maxInboundMediaBytes+1)}
	c, seen := recordingClient(dl)

	e := msgEvent("27831234567", "", false, false)
	e.Message = imageEvent("claims to be small", 10)
	c.handleEvent(e)

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1", len(*seen))
	}
	// Asserted on the fields, never with %+v: this media's Data is 16MiB and
	// printing it would make the failure unreadable.
	got := (*seen)[0]
	if got.media == nil || got.media.Dropped != "too_large" {
		t.Fatalf("Dropped = %q, want too_large", got.media.Dropped)
	}
	if got.media.Data != nil {
		t.Fatalf("an over-cap download must not be forwarded; %d bytes came through", len(got.media.Data))
	}
}

// A download that fails must still forward the message. Losing the file is a
// degradation; losing a real customer's message is not acceptable.
func TestFailedDownloadStillForwardsTheMessage(t *testing.T) {
	dl := &stubDownloader{err: errors.New("media server said no")}
	c, seen := recordingClient(dl)

	e := msgEvent("27831234567", "", false, false)
	e.Message = imageEvent("caption survives", 10)
	c.handleEvent(e)

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1", len(*seen))
	}
	got := (*seen)[0]
	if got.text != "caption survives" {
		t.Fatalf("text = %q", got.text)
	}
	if got.media == nil || got.media.Dropped != "fetch_failed" {
		t.Fatalf("media = %+v, want Dropped=fetch_failed", got.media)
	}
	if got.media.Data != nil {
		t.Fatal("a failed download must carry no bytes")
	}
}

// A document keeps the sender's own filename — a synthesised "document.pdf"
// for every attachment would make a thread of quotes unreadable.
func TestDocumentKeepsItsSenderFilename(t *testing.T) {
	dl := &stubDownloader{data: []byte("%PDF")}
	c, seen := recordingClient(dl)

	e := msgEvent("27831234567", "", false, false)
	e.Message = &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
		Caption:    proto.String("the quote"),
		Mimetype:   proto.String("application/pdf"),
		FileName:   proto.String("Quote-1042.pdf"),
		FileLength: proto.Uint64(4),
	}}
	c.handleEvent(e)

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1", len(*seen))
	}
	if got := (*seen)[0]; got.media == nil || got.media.Filename != "Quote-1042.pdf" {
		t.Fatalf("media = %+v", got.media)
	}
}

// Plain text must keep its exact pre-media behaviour: dispatched, with a nil
// media, and without consulting the downloader at all.
func TestTextMessageStillCarriesNoMedia(t *testing.T) {
	dl := &stubDownloader{data: []byte("never-used")}
	c, seen := recordingClient(dl)

	c.handleEvent(msgEvent("27831234567", "just text", false, false))

	if len(*seen) != 1 {
		t.Fatalf("dispatched %d inbound, want 1", len(*seen))
	}
	if (*seen)[0].media != nil {
		t.Fatalf("a text message must carry nil media, got %+v", (*seen)[0].media)
	}
	if dl.calls != 0 {
		t.Fatalf("downloader ran %d times for a text message", dl.calls)
	}
}

// An event with neither text nor an attachment is still out of scope — a
// reaction or a receipt must not wake a consumer with an empty message.
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
