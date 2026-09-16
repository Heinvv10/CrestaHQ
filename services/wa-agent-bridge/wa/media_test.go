package wa

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// failingUploader is the only way to reach Client.Send's upload-failure branch
// without a WhatsApp connection. It records the deadline it was handed, which
// is the other half of what that branch has to get right.
type failingUploader struct {
	err    error
	sawCtx context.Context
	calls  int
	block  time.Duration
}

func (u *failingUploader) Upload(ctx context.Context, _ []byte, _ whatsmeow.MediaType) (whatsmeow.UploadResponse, error) {
	u.calls++
	u.sawCtx = ctx
	if u.block > 0 {
		select {
		case <-time.After(u.block):
		case <-ctx.Done():
			return whatsmeow.UploadResponse{}, ctx.Err()
		}
	}
	return whatsmeow.UploadResponse{}, u.err
}

func TestIsImageMime(t *testing.T) {
	for mime, want := range map[string]bool{
		"image/png":                 true,
		"image/jpeg":                true,
		"IMAGE/PNG":                 true,
		" image/png ":               true,
		"image/png; charset=binary": true,
		"application/pdf":           false,
		"text/plain":                false,
		"":                          false,
		// Not an image type, and a naive Contains would say otherwise.
		"application/image-thing": false,
	} {
		if got := isImageMime(mime); got != want {
			t.Errorf("isImageMime(%q) = %v, want %v", mime, got, want)
		}
	}
}

// The upload class and the message shape are derived from the same predicate.
// If they ever disagree the media keys are derived under the wrong class and
// the recipient's phone cannot decrypt the file at all — which looks like a
// broken attachment, not like a routing bug.
func TestUploadKindMatchesMessageShape(t *testing.T) {
	up := whatsmeow.UploadResponse{
		URL: "https://mmg.whatsapp.net/x", DirectPath: "/x", FileLength: 10,
		MediaKey: []byte("k"), FileEncSHA256: []byte("e"), FileSHA256: []byte("p"),
	}

	img := &rails.Media{Filename: "report.png", MimeType: "image/png", Data: []byte("x")}
	if got := uploadKindFor(img.MimeType); got != whatsmeow.MediaImage {
		t.Fatalf("uploadKindFor(image/png) = %v, want MediaImage", got)
	}
	m := mediaMessage(up, "your report", img)
	if m.ImageMessage == nil {
		t.Fatal("an image must be sent as an ImageMessage so it renders inline")
	}
	if m.DocumentMessage != nil {
		t.Fatal("an image must not also carry a DocumentMessage")
	}
	if m.ImageMessage.GetCaption() != "your report" {
		t.Fatalf("caption lost: %q", m.ImageMessage.GetCaption())
	}
	if m.ImageMessage.GetMimetype() != "image/png" || m.ImageMessage.GetURL() != up.URL {
		t.Fatalf("upload response not copied onto the image message: %+v", m.ImageMessage)
	}

	doc := &rails.Media{Filename: "report.pdf", MimeType: "application/pdf", Data: []byte("x")}
	if got := uploadKindFor(doc.MimeType); got != whatsmeow.MediaDocument {
		t.Fatalf("uploadKindFor(application/pdf) = %v, want MediaDocument", got)
	}
	d := mediaMessage(up, "your report", doc)
	if d.DocumentMessage == nil {
		t.Fatal("a non-image must be sent as a DocumentMessage")
	}
	if d.ImageMessage != nil {
		t.Fatal("a document must not also carry an ImageMessage")
	}
	// The filename is the only thing that tells the recipient what the file
	// is; a document sent without it arrives as an unnamed blob.
	if d.DocumentMessage.GetFileName() != "report.pdf" {
		t.Fatalf("filename lost: %q", d.DocumentMessage.GetFileName())
	}
	if d.DocumentMessage.GetCaption() != "your report" {
		t.Fatalf("caption lost: %q", d.DocumentMessage.GetCaption())
	}
	if d.DocumentMessage.GetFileLength() != up.FileLength {
		t.Fatalf("file length lost: %d", d.DocumentMessage.GetFileLength())
	}
}

// An empty text sends the file with the Caption field UNSET, not an empty
// string — the shape a phone produces for a photo sent with no caption.
func TestMediaMessageWithoutTextHasNoCaption(t *testing.T) {
	up := whatsmeow.UploadResponse{URL: "https://mmg.whatsapp.net/x", DirectPath: "/x", FileLength: 10}
	img := mediaMessage(up, "", &rails.Media{Filename: "a.png", MimeType: "image/png", Data: []byte("x")})
	if img.ImageMessage == nil || img.ImageMessage.Caption != nil {
		t.Fatalf("image caption must be unset: %+v", img.ImageMessage)
	}
	doc := mediaMessage(up, "", &rails.Media{Filename: "a.pdf", MimeType: "application/pdf", Data: []byte("x")})
	if doc.DocumentMessage == nil || doc.DocumentMessage.Caption != nil {
		t.Fatalf("document caption must be unset: %+v", doc.DocumentMessage)
	}
	if doc.DocumentMessage.GetFileName() != "a.pdf" {
		t.Fatalf("filename lost: %q", doc.DocumentMessage.GetFileName())
	}
}

// The queue sits between the API and the socket. An attachment that does not
// survive the hop would send as bare text, which is exactly the failure this
// feature exists to remove.
func TestQueuePassesMediaToTheTransport(t *testing.T) {
	f := NewFake()
	q := NewQueue(f, QueueOpts{})
	media := &rails.Media{Filename: "report.png", MimeType: "image/png", Data: []byte("x")}

	if _, err := q.Send(t.Context(), "27821234567@s.whatsapp.net", "hi", media); err != nil {
		t.Fatalf("send: %v", err)
	}
	if f.LastMedia() != media {
		t.Fatalf("the queue dropped the attachment: got %+v", f.LastMedia())
	}

	if _, err := q.Send(t.Context(), "27821234567@s.whatsapp.net", "hi", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	if f.LastMedia() != nil {
		t.Fatal("the queue invented an attachment for a text send")
	}
}

// The invariant the whole media path rests on: an upload that fails returns
// BEFORE SendMessage. The client here has a nil *whatsmeow.Client, so a Send
// that reached the socket would panic rather than merely fail — which is the
// assertion, made structurally.
func TestUploadFailureReturnsBeforeTheSocket(t *testing.T) {
	up := &failingUploader{err: errors.New("media server said no")}
	c := &Client{uploader: up, connectedAt: time.Now()}

	_, err := c.Send(t.Context(), "27821234567@s.whatsapp.net", "your report",
		&rails.Media{Filename: "report.png", MimeType: "image/png", Data: []byte("x")})
	if !errors.Is(err, ErrMediaUpload) {
		t.Fatalf("Send = %v, want it to wrap ErrMediaUpload", err)
	}
	if up.calls != 1 {
		t.Fatalf("upload calls = %d, want 1", up.calls)
	}
	// ErrMediaUpload must NOT be one of the ambiguous errors: api.handleSendError
	// keys the release of the idempotency key and the cap slot on exactly that
	// distinction, and getting it wrong burns a contact's daily allowance on a
	// message that never existed.
	if errors.Is(err, ErrSendTimeout) || errors.Is(err, ErrSendCancelled) {
		t.Fatal("an upload failure must be definitive, not ambiguous")
	}
	// The filename is customer data on this rail and must not be in the error,
	// which is logged.
	if got := err.Error(); strings.Contains(got, "report.png") {
		t.Fatalf("the filename leaked into a logged error: %q", got)
	}
}

// A slow upload must die on its OWN deadline, inside the send budget, so it
// surfaces as a definitive upload failure rather than as the queue's ambiguous
// send timeout.
func TestUploadDeadlineIsStrictlyInsideTheSendDeadline(t *testing.T) {
	up := &failingUploader{block: time.Hour}
	c := &Client{uploader: up, connectedAt: time.Now()}

	sendCtx, cancel := context.WithTimeout(context.Background(), 90*time.Millisecond)
	defer cancel()
	sendDeadline, _ := sendCtx.Deadline()

	_, err := c.Send(sendCtx, "27821234567@s.whatsapp.net", "your report",
		&rails.Media{Filename: "report.png", MimeType: "image/png", Data: []byte("x")})
	if !errors.Is(err, ErrMediaUpload) {
		t.Fatalf("Send = %v, want it to wrap ErrMediaUpload", err)
	}
	uploadDeadline, ok := up.sawCtx.Deadline()
	if !ok {
		t.Fatal("the upload was given no deadline; a slow upload would run the send budget out")
	}
	if !uploadDeadline.Before(sendDeadline) {
		t.Fatalf("upload deadline %v is not before the send deadline %v", uploadDeadline, sendDeadline)
	}
}

// The branch with no test at all until now: a send context that is already out
// of time. The upload must be refused outright rather than started with a
// clamped floor, because a floor produces a deadline EQUAL to the send
// context's and the tie is resolved by whichever select case Go picks.
func TestUploadIsRefusedWhenTheSendBudgetIsGone(t *testing.T) {
	for name, budget := range map[string]time.Duration{
		"already expired": -time.Second,
		"one nanosecond":  time.Nanosecond,
	} {
		up := &failingUploader{}
		c := &Client{uploader: up, connectedAt: time.Now()}

		ctx, cancel := context.WithTimeout(context.Background(), budget)
		_, err := c.Send(ctx, "27821234567@s.whatsapp.net", "your report",
			&rails.Media{Filename: "report.png", MimeType: "image/png", Data: []byte("x")})
		cancel()

		if !errors.Is(err, ErrMediaUpload) {
			t.Fatalf("%s: Send = %v, want it to wrap ErrMediaUpload", name, err)
		}
		if up.calls != 0 {
			t.Fatalf("%s: an upload was started with no budget for it (calls=%d)", name, up.calls)
		}
	}
}

// The arithmetic behind that refusal, asserted directly: a spent context must
// yield a non-positive budget, never a clamped positive floor.
func TestUploadBudgetIsNonPositiveWhenTheContextIsSpent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), -time.Second)
	defer cancel()
	if got := mediaUploadBudget(ctx); got > 0 {
		t.Fatalf("mediaUploadBudget(expired) = %v, want <= 0", got)
	}
}

// Without a deadline on the send context there is nothing to take a share of,
// so the upload falls back to its own ceiling rather than running unbounded.
func TestUploadBudgetFallsBackWhenTheContextHasNoDeadline(t *testing.T) {
	if got := mediaUploadBudget(context.Background()); got != maxMediaUploadTimeout {
		t.Fatalf("mediaUploadBudget(no deadline) = %v, want %v", got, maxMediaUploadTimeout)
	}
	// And it never exceeds that ceiling even when the send budget is huge.
	ctx, cancel := context.WithTimeout(context.Background(), 24*time.Hour)
	defer cancel()
	if got := mediaUploadBudget(ctx); got > maxMediaUploadTimeout {
		t.Fatalf("mediaUploadBudget(24h) = %v, want at most %v", got, maxMediaUploadTimeout)
	}
}
