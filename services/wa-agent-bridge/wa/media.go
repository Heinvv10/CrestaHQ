package wa

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// mediaUploader is the narrow slice of the whatsmeow client the media path
// uses. *whatsmeow.Client satisfies it.
//
// It exists for one reason: the upload-failure path is the path that must be a
// DEFINITIVE rejection — nothing reached the socket, so the caller's
// idempotency key and its cap slot are both released — and that invariant was
// previously a comment with no test behind it, because *whatsmeow.Client is a
// concrete type that cannot fail on demand.
type mediaUploader interface {
	Upload(ctx context.Context, plaintext []byte, appInfo whatsmeow.MediaType) (whatsmeow.UploadResponse, error)
}

// ErrMediaUpload is returned when the attachment could not be uploaded. It is
// DEFINITIVE: the upload happens strictly before SendMessage, so a send that
// fails here provably put nothing on the socket. Callers must treat it as a
// plain failure — released reservation, released cap slot — and NOT as one of
// the ambiguous errors in queue.go.
var ErrMediaUpload = errors.New("wa: media upload failed")

// maxMediaUploadTimeout bounds an upload whose context carries no deadline —
// only direct users of Client do that; every production send arrives through
// the queue, which always sets one.
const maxMediaUploadTimeout = 60 * time.Second

// mediaUploadShare is how much of a send's REMAINING budget the upload may
// spend. The rest is reserved for the SendMessage that follows.
//
// The split exists to guarantee the upload's own deadline fires FIRST. An
// upload that runs out of its own time returns ErrMediaUpload — definitive,
// nothing sent, key and cap slot released, safe to retry. A send that instead
// runs the QUEUE's clock out returns ErrSendTimeout, which is ambiguous by
// construction: the reservation is left to expire and the contact's cap slot
// is permanently spent for a message that never existed. An 8MiB upload is
// precisely the send most likely to exhaust a budget sized for text, so the
// worse of those two failures must be the one that cannot happen.
const mediaUploadShare = 2.0 / 3.0

// mediaUploadBudget is how long the upload gets, always STRICTLY less than
// what the send context has left. See mediaUploadShare.
//
// A non-positive result means there is not enough of the send budget left to
// start an upload at all, and the caller must refuse rather than try. That is
// not a nicety: clamping to some tiny positive floor instead would, with a
// nanosecond remaining, hand the upload a deadline EQUAL to the send
// context's, and the whole invariant here is that the upload's deadline
// arrives first. A tie is decided by whichever select case Go happens to
// pick — which is exactly the ambiguity this budget exists to remove.
func mediaUploadBudget(ctx context.Context) time.Duration {
	deadline, ok := ctx.Deadline()
	if !ok {
		return maxMediaUploadTimeout
	}
	budget := time.Duration(float64(time.Until(deadline)) * mediaUploadShare)
	if budget > maxMediaUploadTimeout {
		budget = maxMediaUploadTimeout
	}
	return budget
}

// isImageMime decides which of the two message shapes an attachment takes.
//
// image/* renders inline in the chat; everything else arrives as a file the
// recipient taps to open. A PNG audit report sent as a DocumentMessage is not
// broken, but a prospect who has to download an attachment to read it usually
// does not, so the distinction is worth making rather than sending everything
// as a document.
//
// The prefix is matched on a lowercased, parameter-free type. The API layer
// already normalises and allow-lists what reaches here, so this never sees
// "IMAGE/PNG; charset=binary" — but it is written not to depend on that, since
// a mis-shaped type here would silently downgrade an image to a document.
func isImageMime(mime string) bool {
	m := strings.ToLower(strings.TrimSpace(mime))
	if i := strings.IndexByte(m, ';'); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	return strings.HasPrefix(m, "image/")
}

// uploadKindFor is the whatsmeow media class an attachment is encrypted under.
// It MUST agree with the message shape mediaMessage builds: the media keys are
// derived from this constant, so an image uploaded as a document is undecryptable
// on the recipient's phone rather than merely mis-rendered.
func uploadKindFor(mime string) whatsmeow.MediaType {
	if isImageMime(mime) {
		return whatsmeow.MediaImage
	}
	return whatsmeow.MediaDocument
}

// mediaMessage assembles the protobuf from an upload response. Split out from
// Send so the shape decision is testable without a WhatsApp socket — the
// upload is the only part that genuinely needs one.
//
// caption carries the request's Text. The API requires a non-empty text on
// every send, media or not, so an attachment always arrives with a line of
// explanation rather than as a bare file from an unknown number.
func mediaMessage(up whatsmeow.UploadResponse, caption string, media *rails.Media) *waE2E.Message {
	if isImageMime(media.MimeType) {
		return &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Caption:       proto.String(caption),
			Mimetype:      proto.String(media.MimeType),
			URL:           proto.String(up.URL),
			DirectPath:    proto.String(up.DirectPath),
			MediaKey:      up.MediaKey,
			FileEncSHA256: up.FileEncSHA256,
			FileSHA256:    up.FileSHA256,
			FileLength:    proto.Uint64(up.FileLength),
		}}
	}
	return &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
		Caption:  proto.String(caption),
		Mimetype: proto.String(media.MimeType),
		// FileName is what the recipient sees on the file card; Title is what
		// some clients show above it. Both come from the caller's filename so
		// a report does not arrive as an unnamed blob.
		FileName:      proto.String(media.Filename),
		Title:         proto.String(media.Filename),
		URL:           proto.String(up.URL),
		DirectPath:    proto.String(up.DirectPath),
		MediaKey:      up.MediaKey,
		FileEncSHA256: up.FileEncSHA256,
		FileSHA256:    up.FileSHA256,
		FileLength:    proto.Uint64(up.FileLength),
	}}
}
