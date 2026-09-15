package wa

import (
	"context"
	"errors"
	"io"
	"log"
	"os"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/internal/redact"
)

// maxInboundMediaBytes caps ONE inbound attachment, measured on the decrypted
// file. 16MiB is above anything the rails this bridge carries legitimately
// send and is therefore a bound on abuse, not a product limit.
const maxInboundMediaBytes = 16 << 20

// maxInboundCiphertextBytes is what the DOWNLOAD is allowed to write to disk,
// and it is the number that actually bounds anything.
//
// It is larger than maxInboundMediaBytes because what arrives on the wire is
// the AES-CBC ciphertext: the plaintext rounded up to a 16-byte block, plus a
// 10-byte MAC appended by WhatsApp. 4KiB of slack covers both many times over
// while staying far below any size worth worrying about.
const maxInboundCiphertextBytes = maxInboundMediaBytes + 4096

// errMediaTooLarge aborts a download the moment it grows past the cap.
//
// It is returned from cappedFile.Write, so it surfaces out of whatsmeow's
// io.Copy. whatsmeow's shouldRetryMediaDownload does not match it (it is
// neither a net.Error nor an HTTP error), so the download fails immediately
// rather than being retried five times against the same oversize file.
var errMediaTooLarge = errors.New("wa: inbound media exceeded the cap mid-download")

// errMediaCorruptOverflow refuses growth past the cap that was caused by
// whatsmeow appending a second media host's response after the first, not by
// any one response being too large.
//
// DownloadMediaWithPathToFile moves to the next host after a non-retryable
// error (hash mismatch, bad MAC, too short) WITHOUT rewinding the file, so two
// normal-sized responses can cross the cap between them. The result is a
// corrupt download whatsmeow would reject anyway. It is refused for the same
// disk reason, but deliberately does NOT wrap errMediaTooLarge: that label
// tells an operator the customer sent something big, which is false.
var errMediaCorruptOverflow = errors.New("wa: inbound media host retry appended past the cap")

// inboundMediaTimeout bounds one download.
//
// It does NOT bound anything the socket is waiting on: the download runs on
// the fanout's delivery goroutine, deliberately off whatsmeow's node-handler
// goroutine (see ParseInbound). What it bounds is how long one delivery may
// occupy a media slot, and therefore how long a stalled CDN can keep the next
// customer's attachment waiting. The caller's context can end it sooner — the
// fanout cancels every in-flight download on shutdown so the MESSAGE can
// still be posted text-only before systemd's stop timeout.
const inboundMediaTimeout = 120 * time.Second

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
	// Dropped is "too_large", "fetch_failed" or "shutdown" when the file did
	// not survive, and empty when Data is good. "shutdown" means the bridge was
	// stopping and abandoned the download deliberately, so the message could go
	// out text-only in the time it had left. The MESSAGE is forwarded either way —
	// losing a file is a degradation, losing a customer's message is not.
	Dropped string
}

// MediaDownloader is the narrow slice of the whatsmeow client the inbound
// media path uses. *whatsmeow.Client satisfies it.
//
// It is DownloadToFile, not Download, and that is the whole safety property of
// this file. whatsmeow's Download ends in a plain io.ReadAll over the response
// body (download.go:384) with no LimitReader and no Content-Length check, and
// downloadAndDecrypt holds the ciphertext and the decrypted copy at once — so
// a sender who declares FileLength 10 and ships 100MB allocates ~200MB in this
// process, and WhatsApp's own 2GB document ceiling makes that ~4GB. A declared
// length cannot defend against a sender who lies about it. DownloadToFile
// streams through io.Copy into a file we supply, which lets cappedFile stop it
// at a fixed number of bytes no matter what the sender declared or sends.
type MediaDownloader interface {
	DownloadToFile(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error
}

// cappedFile is the temp file whatsmeow streams a download into, refusing to
// grow past limit by ANY route.
//
// It holds an *os.File and does NOT embed it. Embedding was the first version
// of this type and it did not bound anything: an embedded *os.File promotes
// its ReadFrom, io.Copy prefers a destination's ReadFrom over its Write
// (download-to-file.go:194 is `io.Copy(file, io.TeeReader(resp.Body, hasher))`),
// and (*os.File).ReadFrom wrote 64MiB straight past a Write override that was
// never called. Go also promotes WriteTo and whatever the next release adds.
// Every method whatsmeow.File requires is therefore written out below, and
// each one that can make the file longer — Write, WriteAt, ReadFrom, Truncate
// — goes through grow. Nothing is promoted, so nothing can be bypassed.
//
// The cap is on the file's high-water OFFSET, not a count of bytes written,
// so a retry that rewinds and re-downloads (whatsmeow does, on a transient
// network error) is measured against the same limit as the first attempt, and
// the decrypt's in-place WriteAt over already-admitted bytes is free.
//
// Not being an *os.File has one more consequence worth pinning: whatsmeow's
// downloadMediaToFile does `file.(*os.File)` to preallocate resp.ContentLength
// with fallocate. That assertion is false for this type, so a hostile
// Content-Length can no longer reserve 2GB of disk before a single byte is
// checked. TestCappedFileIsNotAnOsFile keeps it that way.
type cappedFile struct {
	f     *os.File
	limit int64
	pos   int64
	// runStart is the offset the current ReadFrom began at. whatsmeow makes
	// exactly one io.Copy — so exactly one ReadFrom — per media host attempt,
	// which makes this the one place a response boundary is observable. It is
	// -1 outside a ReadFrom.
	runStart int64
}

var _ whatsmeow.File = (*cappedFile)(nil)

func (c *cappedFile) grow(end int64) error {
	if end <= c.limit {
		return nil
	}
	// Refused either way — the disk bound does not care why. The label does:
	// only a single response that is itself over the cap is "too large".
	if c.runStart > 0 && end-c.runStart <= c.limit {
		return errMediaCorruptOverflow
	}
	return errMediaTooLarge
}

func (c *cappedFile) Read(p []byte) (int, error) {
	n, err := c.f.Read(p)
	c.pos += int64(n)
	return n, err
}

func (c *cappedFile) Write(p []byte) (int, error) {
	if err := c.grow(c.pos + int64(len(p))); err != nil {
		return 0, err
	}
	n, err := c.f.Write(p)
	c.pos += int64(n)
	return n, err
}

// ReadFrom is what io.Copy actually calls. It exists so that the choice is
// made HERE rather than inherited: it funnels the source through Write in
// fixed chunks, so the cap is checked before each one lands.
func (c *cappedFile) ReadFrom(r io.Reader) (int64, error) {
	c.runStart = c.pos
	defer func() { c.runStart = -1 }()
	return io.Copy(writeOnly{c}, r)
}

// writeOnly hides ReadFrom from io.Copy so it falls back to the Write loop.
type writeOnly struct{ w io.Writer }

func (w writeOnly) Write(p []byte) (int, error) { return w.w.Write(p) }

func (c *cappedFile) ReadAt(p []byte, off int64) (int, error) { return c.f.ReadAt(p, off) }

func (c *cappedFile) WriteAt(p []byte, off int64) (int, error) {
	if err := c.grow(off + int64(len(p))); err != nil {
		return 0, err
	}
	return c.f.WriteAt(p, off)
}

func (c *cappedFile) Seek(offset int64, whence int) (int64, error) {
	pos, err := c.f.Seek(offset, whence)
	if err == nil {
		c.pos = pos
	}
	return pos, err
}

func (c *cappedFile) Truncate(size int64) error {
	if err := c.grow(size); err != nil {
		return err
	}
	return c.f.Truncate(size)
}

func (c *cappedFile) Stat() (os.FileInfo, error) { return c.f.Stat() }

// attachment is the downloadable part of an inbound message, flattened to the
// handful of fields this bridge needs from five different protobuf types.
type attachment struct {
	msg      whatsmeow.DownloadableMessage
	caption  string
	mimeType string
	filename string
	// length is the sender's DECLARED size. It is used only to refuse early and
	// cheaply; it is never trusted to admit anything, because the real bound is
	// cappedFile.
	length uint64
}

// attachmentFrom finds the one downloadable part of a message, or nil.
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
		// but the file, which is why dispatch must not require text.
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

// Inbound is one message ready to be handed to a consumer.
//
// Media is a THUNK, not a value, and that is the point of this type. Calling
// it performs the download; not calling it performs none. Its context ends
// the download early — the fanout cancels it on shutdown. The rails that
// decide whether a message may be forwarded at all — the owner filter, the
// replay watermark, the catch-up cap — live above this package and run before
// the thunk is called, so a sender the bridge is configured to ignore cannot
// make it fetch anything, and a reconnect does not re-download a day of
// replayed history only to discard it.
//
// It is nil when the message carried no attachment.
type Inbound struct {
	JID   string
	Text  string
	MsgID string
	At    time.Time
	Media func(ctx context.Context) *InboundMedia
}

// ParseInbound turns one whatsmeow message event into the values a consumer
// receives, or nil when the event is out of scope.
//
// It is exported, and pure apart from the thunk it builds, so that the seam
// between "what the socket delivered" and "what the fanout posts" can be
// tested in ONE test rather than two halves that meet nowhere — this bridge's
// recorded failure mode. Production reaches it through handleMessage.
//
// It performs NO download. See Inbound.Media.
func ParseInbound(v *events.Message, dl MediaDownloader) *Inbound {
	if v == nil || v.Info.IsFromMe || v.Info.IsGroup {
		return nil
	}
	text := v.Message.GetConversation()
	if text == "" {
		if ext := v.Message.GetExtendedTextMessage(); ext != nil {
			text = ext.GetText()
		}
	}

	// An attachment is a message in its own right. A voice note and a sticker
	// carry no text at all, so requiring text is what used to make this bridge
	// deaf to them; everything else — reactions, receipts, protocol traffic —
	// is still out of scope and still returns here.
	//
	// VIEW-ONCE MEDIA IS DOWNLOADED AND STORED, DELIBERATELY. By the time this
	// runs, whatsmeow's UnwrapRaw has already flattened a ViewOnceMessage /
	// V2 / V2Extension into the plain ImageMessage (etc.) below and set
	// v.IsViewOnce. Nothing here branches on that flag, so a photo the sender
	// meant to disappear is forwarded and kept exactly like any other. That
	// is a deliberate product and POPIA decision (2026-09-15), not whatsmeow's
	// accident: pinned by TestViewOnceMediaIsStoredLikeAnyOther, and
	// stated to consumers in docs/hermes-consumer.md because a buyer of this
	// template inherits the obligation with the bytes.
	att := attachmentFrom(v.Message)
	if text == "" && att == nil {
		return nil
	}

	in := &Inbound{
		JID:   senderAddress(v.Info.MessageSource),
		Text:  text,
		MsgID: v.Info.ID,
		At:    v.Info.Timestamp,
	}
	if att != nil {
		if in.Text == "" {
			in.Text = att.caption
		}
		jid := in.JID
		in.Media = func(ctx context.Context) *InboundMedia { return fetchInboundMedia(ctx, jid, att, dl) }
	}
	return in
}

// fetchInboundMedia downloads one attachment. It never returns nil and never
// fails: every error becomes a Dropped reason, because the message it belongs
// to is forwarded regardless.
func fetchInboundMedia(ctx context.Context, jid string, a *attachment, dl MediaDownloader) *InboundMedia {
	m := &InboundMedia{Filename: a.filename, MimeType: a.mimeType}

	// The declared length is a cheap early refusal, not a defence — see
	// cappedFile for the one that holds against a sender who lies.
	if a.length > maxInboundMediaBytes {
		log.Printf("inbound media declared too large jid=%s mime=%s bytes=%d — message forwarded without it",
			redact.JID(jid), a.mimeType, a.length)
		m.Dropped = "too_large"
		return m
	}
	if dl == nil {
		log.Printf("WARNING inbound media has no downloader jid=%s mime=%s", redact.JID(jid), a.mimeType)
		m.Dropped = "fetch_failed"
		return m
	}

	// Streamed to disk rather than held in memory, so the peak during a
	// download is whatsmeow's copy buffer, not the file.
	f, err := os.CreateTemp("", "wa-inbound-media-*")
	if err != nil {
		log.Printf("WARNING inbound media temp file failed jid=%s: %v", redact.JID(jid), err)
		m.Dropped = "fetch_failed"
		return m
	}
	defer func() {
		_ = f.Close()
		_ = os.Remove(f.Name())
	}()

	ctx, cancel := context.WithTimeout(ctx, inboundMediaTimeout)
	defer cancel()

	capped := &cappedFile{f: f, limit: maxInboundCiphertextBytes, runStart: -1}
	if err := dl.DownloadToFile(ctx, a.msg, capped); err != nil {
		// The mime type and the declared size, never the bytes and never the
		// filename — a filename is customer data on this rail.
		if errors.Is(err, errMediaTooLarge) {
			log.Printf("inbound media exceeded the cap mid-download jid=%s mime=%s declared=%d",
				redact.JID(jid), a.mimeType, a.length)
			m.Dropped = "too_large"
			return m
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			// Not a failure of the download but a decision by the bridge: it is
			// stopping, and the message matters more than the file.
			log.Printf("inbound media abandoned for shutdown jid=%s mime=%s declared=%d",
				redact.JID(jid), a.mimeType, a.length)
			m.Dropped = "shutdown"
			return m
		}
		log.Printf("WARNING inbound media download failed jid=%s mime=%s declared=%d: %v",
			redact.JID(jid), a.mimeType, a.length, err)
		m.Dropped = "fetch_failed"
		return m
	}

	// Measured, not declared. Reading only after this check is what keeps the
	// in-memory copy bounded by the constant rather than by the sender.
	st, err := f.Stat()
	if err != nil {
		log.Printf("WARNING inbound media stat failed jid=%s: %v", redact.JID(jid), err)
		m.Dropped = "fetch_failed"
		return m
	}
	if st.Size() > maxInboundMediaBytes {
		log.Printf("inbound media over the cap after decrypt jid=%s mime=%s bytes=%d",
			redact.JID(jid), a.mimeType, st.Size())
		m.Dropped = "too_large"
		return m
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		log.Printf("WARNING inbound media rewind failed jid=%s: %v", redact.JID(jid), err)
		m.Dropped = "fetch_failed"
		return m
	}
	data, err := io.ReadAll(f)
	if err != nil {
		log.Printf("WARNING inbound media read failed jid=%s: %v", redact.JID(jid), err)
		m.Dropped = "fetch_failed"
		return m
	}
	m.Data = data
	return m
}
