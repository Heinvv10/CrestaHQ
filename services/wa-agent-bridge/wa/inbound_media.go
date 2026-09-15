package wa

import (
	"context"
	"log"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/internal/redact"
)

// maxInboundMediaBytes caps ONE inbound attachment.
//
// It is enforced from the protobuf's own FileLength, before any bytes are
// pulled, so an oversize file costs this process nothing. 16MiB is above
// anything WhatsApp lets a phone send on the rails this bridge carries, so it
// refuses nothing real; it exists to bound the memory a hostile or broken
// sender can make this process hold.
//
// BE HONEST ABOUT THE EXPOSURE, as api/server.go's maxSendBodyBytes comment
// already is for outbound: a downloaded file and its base64 encoding are live
// at the same time, so the peak is ~37MiB per inbound attachment, and nothing
// here caps concurrency. The download happens on whatsmeow's event goroutine,
// which serialises inbound within one connection — that, not this constant, is
// what keeps the peak from multiplying.
const maxInboundMediaBytes = 16 << 20

// inboundMediaTimeout bounds one download. Longer than a send's budget because
// nothing is waiting on it — a slow download delays one consumer webhook, it
// does not hold the socket mutex or a caller's HTTP request.
const inboundMediaTimeout = 60 * time.Second

// InboundMedia is one file that arrived with an inbound message.
//
// Exactly one of Data and Dropped is meaningful: bytes, or the reason there are
// none. A nil *InboundMedia means the message carried no file at all, which is
// a different thing from a file that could not be fetched — consumers must not
// collapse the two, because only one of them is worth telling an operator
// about.
type InboundMedia struct {
	// Filename is the sender's own for a document, and a synthesised one
	// otherwise. It is customer-supplied data: a consumer must never put it in
	// a filesystem path or a header without sanitising it.
	Filename string
	MimeType string
	Data     []byte
	// Dropped is "too_large" or "fetch_failed" when the file did not survive,
	// and empty when Data is good. The MESSAGE is forwarded either way —
	// losing a file is a degradation, losing a customer's message is not
	// acceptable.
	Dropped string
}

// mediaDownloader is the narrow slice of the whatsmeow client the inbound
// media path uses. *whatsmeow.Client satisfies it.
//
// It exists for the same reason mediaUploader does on the outbound side: the
// two paths worth asserting are a download that FAILS and a download that is
// never attempted, and a concrete *whatsmeow.Client can be made to do neither.
type mediaDownloader interface {
	Download(ctx context.Context, msg whatsmeow.DownloadableMessage) ([]byte, error)
}

// attachment is the downloadable part of an inbound message, flattened to the
// handful of fields this bridge needs from five different protobuf types.
type attachment struct {
	msg      whatsmeow.DownloadableMessage
	caption  string
	mimeType string
	filename string
	// length is the sender's declared size. Trusted only to REFUSE — a lie in
	// the other direction is caught by the post-download check.
	length uint64
}

// attachmentFrom finds the one downloadable part of a message, or nil.
//
// The order matters only in that a message carries at most one of these; it is
// written as a chain rather than a type switch because each protobuf type has
// its own accessors and no common interface beyond DownloadableMessage, which
// exposes none of the metadata below.
func attachmentFrom(m *waE2E.Message) *attachment {
	if m == nil {
		return nil
	}
	if v := m.GetImageMessage(); v != nil {
		return &attachment{v, v.GetCaption(), v.GetMimetype(), synthName("photo", v.GetMimetype()), v.GetFileLength()}
	}
	if v := m.GetVideoMessage(); v != nil {
		return &attachment{v, v.GetCaption(), v.GetMimetype(), synthName("video", v.GetMimetype()), v.GetFileLength()}
	}
	if v := m.GetAudioMessage(); v != nil {
		// Audio has no caption field at all — a voice note arrives with nothing
		// but the file, which is why handleMessage must not require text.
		return &attachment{v, "", v.GetMimetype(), synthName("voice-note", v.GetMimetype()), v.GetFileLength()}
	}
	if v := m.GetDocumentMessage(); v != nil {
		name := v.GetFileName()
		if name == "" {
			name = synthName("document", v.GetMimetype())
		}
		return &attachment{v, v.GetCaption(), v.GetMimetype(), name, v.GetFileLength()}
	}
	if v := m.GetStickerMessage(); v != nil {
		return &attachment{v, "", v.GetMimetype(), synthName("sticker", v.GetMimetype()), v.GetFileLength()}
	}
	return nil
}

// mimeExtensions maps the types WhatsApp actually sends to a file extension.
// An unknown type gets ".bin" rather than no extension: a consumer that saves
// the file needs SOMETHING, and a wrong-but-present extension is easier to
// notice than a name that looks truncated.
var mimeExtensions = map[string]string{
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/webp":      ".webp",
	"image/gif":       ".gif",
	"audio/ogg":       ".ogg",
	"audio/mpeg":      ".mp3",
	"audio/mp4":       ".m4a",
	"audio/aac":       ".aac",
	"audio/amr":       ".amr",
	"video/mp4":       ".mp4",
	"video/3gpp":      ".3gp",
	"application/pdf": ".pdf",
}

// synthName builds a filename for the four message kinds that carry none.
// Parameters are stripped first because WhatsApp sends voice notes as
// "audio/ogg; codecs=opus", and a lookup on the raw string would miss it.
func synthName(base, mime string) string {
	m := strings.ToLower(strings.TrimSpace(mime))
	if i := strings.IndexByte(m, ';'); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	ext, ok := mimeExtensions[m]
	if !ok {
		ext = ".bin"
	}
	return base + ext
}

// fetchInboundMedia turns one attachment into the value the consumer receives.
// It never returns nil and never fails: every error becomes a Dropped reason,
// because the message it belongs to is forwarded regardless.
func (c *Client) fetchInboundMedia(jid string, a *attachment) *InboundMedia {
	m := &InboundMedia{Filename: a.filename, MimeType: a.mimeType}

	if a.length > maxInboundMediaBytes {
		log.Printf("inbound media too large jid=%s mime=%s bytes=%d — message forwarded without it",
			redact.JID(jid), a.mimeType, a.length)
		m.Dropped = "too_large"
		return m
	}

	c.mu.Lock()
	dl := c.downloader
	if dl == nil && c.wac != nil {
		dl = c.wac
	}
	c.mu.Unlock()
	if dl == nil {
		m.Dropped = "fetch_failed"
		return m
	}

	ctx, cancel := context.WithTimeout(context.Background(), inboundMediaTimeout)
	defer cancel()
	data, err := dl.Download(ctx, a.msg)
	if err != nil {
		// The mime type and the declared size, never the bytes and never the
		// filename — a filename is customer data on this rail.
		log.Printf("WARNING inbound media download failed jid=%s mime=%s bytes=%d: %v",
			redact.JID(jid), a.mimeType, a.length, err)
		m.Dropped = "fetch_failed"
		return m
	}
	if len(data) > maxInboundMediaBytes {
		// FileLength is the sender's claim; this is the measurement. A file that
		// understated itself is refused here rather than forwarded, so the cap
		// means the same thing whether or not the sender was honest.
		log.Printf("inbound media exceeded the cap after download jid=%s mime=%s bytes=%d",
			redact.JID(jid), a.mimeType, len(data))
		m.Dropped = "too_large"
		return m
	}
	m.Data = data
	return m
}
