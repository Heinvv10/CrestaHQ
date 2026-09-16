package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/wa"
)

// A one-pixel PNG is enough: nothing in this service parses the bytes, and a
// real file in a test fixture would only make the diff unreadable.
var tinyPNG = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01}

func mediaBodyJSON(jid, text, key, filename, mime string, data []byte) string {
	b, _ := json.Marshal(map[string]any{
		"to": jid, "text": text, "idempotencyKey": key,
		"media": map[string]string{
			"filename":   filename,
			"mimeType":   mime,
			"dataBase64": base64.StdEncoding.EncodeToString(data),
		},
	})
	return string(b)
}

// rawMediaBodyJSON builds a body whose dataBase64 is passed through verbatim,
// for the cases that are about a malformed encoding rather than a file.
func rawMediaBodyJSON(jid, key, filename, mime, dataBase64 string) string {
	b, _ := json.Marshal(map[string]any{
		"to": jid, "text": "here it is", "idempotencyKey": key,
		"media": map[string]string{
			"filename": filename, "mimeType": mime, "dataBase64": dataBase64,
		},
	})
	return string(b)
}

func TestSendMediaReachesTheTransport(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "your report", "m1", "report.png", "image/png", tinyPNG))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	got := sender.LastMedia()
	if got == nil {
		t.Fatal("the attachment never reached the transport; the send would arrive as bare text")
	}
	if got.Filename != "report.png" || got.MimeType != "image/png" {
		t.Fatalf("attachment descriptor mangled: %+v", *got)
	}
	if !bytes.Equal(got.Data, tinyPNG) {
		t.Fatalf("attachment bytes mangled: got %d bytes, want %d", len(got.Data), len(tinyPNG))
	}
}

// A photo or document may go without a caption, as it can from a phone.
func TestSendMediaWithEmptyTextIsAccepted(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "", "m-nocap", "report.png", "image/png", tinyPNG))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := sender.LastMedia(); got == nil || got.Filename != "report.png" {
		t.Fatalf("the caption-less attachment never reached the transport: %+v", got)
	}
}

// ...but a send with neither text nor a file is still empty.
func TestSendEmptyTextWithoutMediaIsRejected(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "", "t-empty"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if sender.Calls() != 0 {
		t.Fatalf("an empty send reached the transport")
	}
}

// The text path must be untouched by the media path existing. A handler that
// synthesised an empty Media for every send would pass every test above and
// turn every existing text message into a zero-byte document.
func TestSendWithoutMediaSendsNoAttachment(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", "t1"))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if sender.LastMedia() != nil {
		t.Fatalf("a text send handed an attachment to the transport: %+v", sender.LastMedia())
	}
}

// The property this whole feature is judged on: an attachment is not a way
// around the rails. A media send to a contact who has never messaged us must
// be refused by reply-only exactly as text is.
func TestSendMediaIsStillSubjectToReplyOnly(t *testing.T) {
	h, _, sender := testHandler(t)

	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(strangerJID, "your report", "m1", "report.png", "image/png", tinyPNG))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d body=%s", rec.Code, rec.Body.String())
	}
	if out := decode(t, rec); out["refusedBy"] != "reply_only" {
		t.Fatalf("want refusedBy reply_only, got %v", out)
	}
	if sender.Calls() != 0 {
		t.Fatal("a refused media send reached the transport")
	}
}

// And the volume rails: an attachment spends the same budget a text message
// does, so a run of unanswered media hits the consecutive cap on schedule.
func TestSendMediaSpendsTheConsecutiveCap(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	// ConsecutiveMax is 3 in the test config, so the fourth must be refused.
	for i, key := range []string{"m1", "m2", "m3"} {
		rec := post(h, "/v1/send", "tok-hermes",
			mediaBodyJSON(knownJID, "report", key, "report.png", "image/png", tinyPNG))
		if rec.Code != http.StatusOK {
			t.Fatalf("media send %d: want 200, got %d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "report", "m4", "report.png", "image/png", tinyPNG))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on the 4th unanswered media send, got %d body=%s", rec.Code, rec.Body.String())
	}
	if out := decode(t, rec); out["refusedBy"] != "consecutive_cap" {
		t.Fatalf("want refusedBy consecutive_cap, got %v", out)
	}
	if sender.Calls() != 3 {
		t.Fatalf("want 3 transport calls, got %d", sender.Calls())
	}
}

func TestSendMediaOverTheSizeCapIsRejected(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	oversize := bytes.Repeat([]byte{0x41}, maxMediaBytes+1)
	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "report", "m1", "huge.pdf", "application/pdf", oversize))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("want 413, got %d body=%s", rec.Code, rec.Body.String())
	}
	if out := decode(t, rec); out["code"] != "media_too_large" {
		t.Fatalf("want code media_too_large, got %v", out)
	}
	if sender.Calls() != 0 {
		t.Fatal("an oversize attachment reached the transport")
	}
	// Rejected before the rails, so it must not have eaten a cap slot: a
	// caller retrying with a smaller file would otherwise find the contact's
	// allowance already spent on a message nobody received.
	if n, _ := st.OutboundCountForContact(knownJID, time.Time{}); n != 0 {
		t.Fatalf("a rejected attachment consumed %d cap slots, want 0", n)
	}
}

// One byte under the cap must still go. A test that only proves the reject
// side passes just as happily against a cap of zero.
func TestSendMediaAtTheSizeCapIsAccepted(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	atCap := bytes.Repeat([]byte{0x41}, maxMediaBytes)
	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "report", "m1", "big.pdf", "application/pdf", atCap))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 at exactly the cap, got %d body=%s", rec.Code, rec.Body.String())
	}
	if sender.Calls() != 1 {
		t.Fatalf("want 1 transport call, got %d", sender.Calls())
	}
}

func TestSendMediaUnsupportedTypeIsRejected(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	for _, mime := range []string{"text/html", "application/x-msdownload", ""} {
		rec := post(h, "/v1/send", "tok-hermes",
			mediaBodyJSON(knownJID, "report", "m1", "thing", mime, tinyPNG))
		if rec.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("%q: want 415, got %d body=%s", mime, rec.Code, rec.Body.String())
		}
		if out := decode(t, rec); out["code"] != "media_unsupported_type" {
			t.Fatalf("%q: want code media_unsupported_type, got %v", mime, out)
		}
	}
	if sender.Calls() != 0 {
		t.Fatal("an unsupported attachment reached the transport")
	}
}

// Every type on the allow-list must actually be sendable, or the list is
// decorative and the feature works only for whichever one has a happy-path test.
func TestSendMediaAllowedTypesAreAccepted(t *testing.T) {
	for _, mime := range []string{"image/png", "image/jpeg", "application/pdf"} {
		h, st, sender := testHandler(t)
		st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
		rec := post(h, "/v1/send", "tok-hermes",
			mediaBodyJSON(knownJID, "report", "m1", "f", mime, tinyPNG))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: want 200, got %d body=%s", mime, rec.Code, rec.Body.String())
		}
		if got := sender.LastMedia(); got == nil || got.MimeType != mime {
			t.Fatalf("%s: attachment did not reach the transport intact: %+v", mime, got)
		}
	}
}

// A content type carrying a parameter is the same type. Matching the raw
// string against the allow-list would refuse it, and — worse, if the check
// were ever loosened to a prefix — admit "application/pdf-and-then-some".
func TestSendMediaMimeTypeIsNormalisedBeforeTheAllowList(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "report", "m1", "report.png", " IMAGE/PNG; charset=binary ", tinyPNG))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := sender.LastMedia(); got == nil || got.MimeType != "image/png" {
		t.Fatalf("want the normalised type on the wire, got %+v", got)
	}
}

func TestSendMediaMalformedIsRejected(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	cases := map[string]string{
		"not base64":  rawMediaBodyJSON(knownJID, "m1", "r.png", "image/png", "!!!not base64!!!"),
		"empty bytes": rawMediaBodyJSON(knownJID, "m2", "r.png", "image/png", ""),
		"no filename": rawMediaBodyJSON(knownJID, "m3", "  ", "image/png", base64.StdEncoding.EncodeToString(tinyPNG)),
	}
	for name, body := range cases {
		rec := post(h, "/v1/send", "tok-hermes", body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %d body=%s", name, rec.Code, rec.Body.String())
		}
		if out := decode(t, rec); out["code"] != "media_invalid" {
			t.Fatalf("%s: want code media_invalid, got %v", name, out)
		}
	}
	if sender.Calls() != 0 {
		t.Fatal("a malformed attachment reached the transport")
	}
}

func TestSendRejectsTextOverTheLengthCap(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	// The queue paces at a per-rune delay while holding the single socket
	// mutex, so an unbounded body is an unbounded stall for every other send.
	long := strings.Repeat("a", maxTextRunes+1)
	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, long, "t1"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if out := decode(t, rec); out["code"] != "text_too_long" {
		t.Fatalf("want code text_too_long, got %v", out)
	}
	if sender.Calls() != 0 {
		t.Fatal("an over-length message reached the transport")
	}
	// Refused before the rails, so no cap slot was spent on it.
	if n, _ := st.OutboundCountForContact(knownJID, time.Time{}); n != 0 {
		t.Fatalf("a rejected message consumed %d cap slots, want 0", n)
	}
}

// Multi-byte text must be measured the way the pacing measures it. Counting
// bytes would refuse a 1366-character message written in any script that does
// not fit in one byte.
func TestSendTextCapCountsRunesNotBytes(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	long := strings.Repeat("é", maxTextRunes)
	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, long, "t1"))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 at exactly the cap, got %d body=%s", rec.Code, rec.Body.String())
	}
	if sender.Calls() != 1 {
		t.Fatalf("want 1 transport call, got %d", sender.Calls())
	}
}

func TestSendMediaOverLongFilenameIsRejected(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	// A tiny payload with a huge name passes the size cap, which measures the
	// payload, and is then copied onto the message twice.
	name := strings.Repeat("n", maxMediaFilenameBytes+1) + ".png"
	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "report", "m1", name, "image/png", tinyPNG))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if out := decode(t, rec); out["code"] != "media_invalid" {
		t.Fatalf("want code media_invalid, got %v", out)
	}
	if sender.Calls() != 0 {
		t.Fatal("an over-long filename reached the transport")
	}
}

// The invariant behind wa.ErrMediaUpload: an upload that fails put nothing on
// the socket, so BOTH the idempotency key and the cap slot must come back. A
// definitive failure that kept either would block the caller's legitimate
// retry, or silently shrink the contact's daily allowance.
func TestMediaSendThatFailsDefinitivelyReleasesKeyAndCapSlot(t *testing.T) {
	st := store.NewMemory()
	// The REAL sentinel, wrapped exactly as wa.Client.upload wraps it. A
	// lookalike string would leave this test green if ErrMediaUpload were ever
	// added to the ambiguous branch of handleSendError — which is precisely
	// the regression this test exists to catch.
	sender := &stubSender{err: fmt.Errorf("%w (image/png, 10 bytes): connection reset", wa.ErrMediaUpload)}
	h := newHandler(t, st, sender)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "report", "m1", "report.png", "image/png", tinyPNG))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d body=%s", rec.Code, rec.Body.String())
	}
	if out := decode(t, rec); out["outcome"] != "failed" {
		t.Fatalf("an upload failure must be definitive, not ambiguous: %v", out)
	}
	if n, _ := st.OutboundCountForContact(knownJID, time.Time{}); n != 0 {
		t.Fatalf("the cap slot was not released: count=%d", n)
	}
	if _, _, found, _ := st.LookupIdempotency(rails.IdempotencyStorageKey("hermes", "m1")); found {
		t.Fatal("the idempotency key was not released; the caller cannot retry for 90s")
	}
}

// And the other half: a TIMEOUT stays ambiguous and keeps both, because a
// timed-out send may already have been delivered. A media path that released
// on every error would double-message a real contact.
func TestMediaSendThatTimesOutKeepsKeyAndCapSlot(t *testing.T) {
	st := store.NewMemory()
	sender := &stubSender{err: wa.ErrSendTimeout}
	h := newHandler(t, st, sender)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	rec := post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "report", "m1", "report.png", "image/png", tinyPNG))
	if out := decode(t, rec); out["outcome"] != "ambiguous" {
		t.Fatalf("want ambiguous, got %v", out)
	}
	if n, _ := st.OutboundCountForContact(knownJID, time.Time{}); n != 1 {
		t.Fatalf("a possibly-delivered send must keep its cap slot: count=%d", n)
	}
	if _, _, found, _ := st.LookupIdempotency(rails.IdempotencyStorageKey("hermes", "m1")); !found {
		t.Fatal("a possibly-delivered send must keep its idempotency key")
	}
}

// Mirrors TestMessageBodiesAreNeverLogged for the attachment path. A filename
// on this rail is customer data — "audit-for-<company>.pdf" names a prospect —
// and this service's logs are not access-controlled.
func TestFilenamesAreNeverLogged(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	h, st, _ := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	const secret = "audit-for-ap-repair-centre.png"

	// One rejection of each kind that names the filename in its log line.
	post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "report", "k1", secret, "text/html", tinyPNG))
	post(h, "/v1/send", "tok-hermes",
		rawMediaBodyJSON(knownJID, "k2", secret, "image/png", "!!!not base64!!!"))
	post(h, "/v1/send", "tok-hermes",
		mediaBodyJSON(knownJID, "report", "k3", secret, "application/pdf",
			bytes.Repeat([]byte{0x41}, maxMediaBytes+1)))

	if strings.Contains(buf.String(), secret) {
		t.Fatalf("a filename reached the log: %s", buf.String())
	}
	// The length still has to be there, or the log cannot tell an operator
	// whether the filename was the problem.
	if !strings.Contains(buf.String(), redactedLen(secret)) {
		t.Fatalf("want the redacted filename length in the log, got: %s", buf.String())
	}
}
