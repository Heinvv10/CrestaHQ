package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/internal/redact"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/wa"
)

type sendBody struct {
	To             string `json:"to"`
	Text           string `json:"text"`
	IdempotencyKey string `json:"idempotencyKey"`
	// HumanReply marks a message an operator typed in a thread. It relaxes
	// quiet hours, and only while the contact is still inside an open session
	// — see rails.checkQuietHours. Absent means false, which is the safe
	// default: a consumer that forgets the field gets the full guard.
	HumanReply bool `json:"humanReply"`
	// Media is an optional attachment. Absent means a plain text message, which
	// is byte-for-byte the request every existing consumer already sends.
	Media *mediaBody `json:"media"`
}

// mediaBody is the wire form of an attachment: base64 because the send body is
// JSON and always has been, and a multipart variant of this endpoint would be a
// second send path with its own copy of the rails wiring.
type mediaBody struct {
	Filename   string `json:"filename"`
	MimeType   string `json:"mimeType"`
	DataBase64 string `json:"dataBase64"`
}

// mediaError is a rejected attachment: an HTTP status and a stable machine
// code, so a consumer can tell "this file is too big" from "we do not send
// this type" from "your base64 is broken" without matching on prose.
type mediaError struct {
	status int
	code   string
	msg    string
}

// decodeMedia validates and decodes an attachment, or explains why it will not.
//
// It runs BEFORE the rails are consulted, deliberately. An unsupported file is
// a caller bug, and evaluating it first would spend an idempotency reservation
// and a cap slot on a message that was never going to be sent — the contact's
// daily allowance would shrink every time somebody attached the wrong thing.
func decodeMedia(m *mediaBody) (*rails.Media, *mediaError) {
	if m == nil {
		return nil, nil
	}
	filename := strings.TrimSpace(m.Filename)
	if filename == "" {
		return nil, &mediaError{http.StatusBadRequest, "media_invalid",
			"media.filename is required; a document with no name arrives as an unnamed blob"}
	}
	// The name is not the payload and is not covered by the size cap, but it
	// is copied onto the outgoing message twice, so it needs its own bound.
	if len(filename) > maxMediaFilenameBytes {
		return nil, &mediaError{http.StatusBadRequest, "media_invalid",
			fmt.Sprintf("media.filename is %d bytes; the limit is %d", len(filename), maxMediaFilenameBytes)}
	}
	// Lowercased and stripped of any "; charset=" parameter before the
	// allow-list is consulted, so "IMAGE/PNG" is admitted and — more to the
	// point — "image/png; x=y" cannot slip past a map lookup that only ever
	// saw the bare type.
	mime := strings.ToLower(strings.TrimSpace(m.MimeType))
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	if !allowedMediaMimeTypes[mime] {
		return nil, &mediaError{http.StatusUnsupportedMediaType, "media_unsupported_type",
			"media.mimeType is not one this bridge sends"}
	}
	data, err := base64.StdEncoding.DecodeString(m.DataBase64)
	if err != nil {
		return nil, &mediaError{http.StatusBadRequest, "media_invalid",
			"media.dataBase64 is not valid base64"}
	}
	if len(data) == 0 {
		return nil, &mediaError{http.StatusBadRequest, "media_invalid",
			"media.dataBase64 decoded to nothing"}
	}
	if len(data) > maxMediaBytes {
		return nil, &mediaError{http.StatusRequestEntityTooLarge, "media_too_large",
			fmt.Sprintf("attachment is %d bytes; the limit is %d", len(data), maxMediaBytes)}
	}
	return &rails.Media{Filename: filename, MimeType: mime, Data: data}, nil
}

func (s *server) handleSend(w http.ResponseWriter, r *http.Request, consumer config.Consumer) {
	var body sendBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSendBodyBytes)).Decode(&body); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
				"error": "request body exceeds the limit"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if body.To == "" || body.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "to and text are required"})
		return
	}
	// Bounded here rather than left to the body cap. The body cap is sized for
	// base64 attachments and says nothing about how long the queue will hold
	// the socket mutex pacing this message out — see maxTextRunes.
	if n := utf8.RuneCountInString(body.Text); n > maxTextRunes {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"code":  "text_too_long",
			"error": fmt.Sprintf("text is %d characters; the limit is %d", n, maxTextRunes)})
		return
	}
	if body.IdempotencyKey == "" {
		// Rejected here rather than left to the rails so the caller gets a
		// client-error status for what is a client mistake. Callers retry — on
		// a timeout, on a redeploy, on a queue redelivery — and a retry with no
		// key is indistinguishable from a new message.
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "idempotencyKey is required; without it a retry would duplicate the message"})
		return
	}

	media, mediaErr := decodeMedia(body.Media)
	if mediaErr != nil {
		// The bytes are never logged; the filename and the reason are what an
		// operator needs to fix the caller.
		log.Printf("send rejected consumer=%s to=%s media=%q code=%s",
			consumer.Name, redact.JID(body.To), body.Media.Filename, mediaErr.code)
		writeJSON(w, mediaErr.status, map[string]any{
			"ok": false, "error": mediaErr.msg, "code": mediaErr.code})
		return
	}

	req := rails.SendRequest{
		To:             body.To,
		Text:           body.Text,
		IdempotencyKey: body.IdempotencyKey,
		Consumer:       consumer.Name,
		Now:            s.deps.Now(),
		HumanReply:     body.HumanReply,
		// Carried on the evaluated request, so what the rails permitted and
		// what reaches the socket are the same value. Every rail — reply-only,
		// the allowlist, the per-contact and consecutive and daily caps, quiet
		// hours, the kill switch — runs on this request exactly as it does for
		// text, because none of them reads Media.
		Media: media,
	}
	// Composed ONCE and reused for the reserve, the save and the release. Two
	// call sites composing it independently is how the raw key sneaks back in
	// and two consumers start colliding on "turn-1".
	storageKey := rails.IdempotencyStorageKey(consumer.Name, body.IdempotencyKey)

	// EvaluateAndReserve, never Evaluate: the read-only path cannot stop two
	// concurrent requests carrying one key from both passing and both sending.
	// A returned Allow means both "the rails permit this" and "this caller owns
	// the key".
	decision, err := s.deps.Engine.EvaluateAndReserve(req)
	if err != nil {
		// Nothing was sent, so this one is failed closed at the request level
		// rather than degraded: the caller may retry. But a store that cannot
		// record an outbound is a store the volume caps cannot read either, so
		// consecutive failures still trip the kill switch.
		s.noteRecordOutbound(err)
		log.Printf("send aborted consumer=%s to=%s len=%s err=%v",
			consumer.Name, redact.JID(body.To), redact.Body(body.Text), err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "reservation failed", "outcome": "not_sent"})
		return
	}
	// The reservation succeeded, so the store is writable.
	s.noteRecordOutbound(nil)

	// A replayed key is a success with no send: the caller gets the original
	// message id back so retries converge instead of duplicating. Checked
	// BEFORE !Allow, because a replay and a refusal both leave Allow false.
	if decision.DuplicateOf != "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "messageId": decision.DuplicateOf, "duplicate": true,
		})
		return
	}
	if !decision.Allow {
		s.writeRefusal(w, consumer, body, decision)
		return
	}

	// req.Media, not the raw body: the value that passed the rails is the value
	// that goes on the wire.
	msgID, sendErr := s.deps.Sender.Send(r.Context(), body.To, body.Text, req.Media)
	if sendErr != nil {
		s.handleSendError(w, consumer, body, storageKey, sendErr)
		return
	}

	// The outbound row was already written — and already counted — when the
	// reservation was won. All that is left is stamping the real message id on
	// it, which moves no counter, so a failure here cannot blind a cap.
	if err := s.deps.Store.ConfirmOutboundSlot(storageKey, msgID); err != nil {
		log.Printf("WARNING message id not stamped on a counted outbound row consumer=%s err=%v",
			consumer.Name, err)
	}
	s.saveIdempotency(storageKey, msgID, consumer)

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "messageId": msgID})
}

func (s *server) writeRefusal(w http.ResponseWriter, consumer config.Consumer, body sendBody, d rails.Decision) {
	// 409 rather than 422 for an in-flight key: another request holds it and is
	// still sending. That is a normal concurrent-retry outcome the caller may
	// retry shortly, not a rail rejecting the message, and certainly not a
	// server fault.
	status := http.StatusUnprocessableEntity
	if d.RefusedBy == rails.RefusedInFlight {
		status = http.StatusConflict
	}
	// 422 otherwise: the request was understood and authorised, the rails
	// simply refuse it. refusedBy is machine-readable so the caller can render
	// a real reason instead of a generic failure.
	log.Printf("send refused consumer=%s to=%s len=%s by=%s",
		consumer.Name, redact.JID(body.To), redact.Body(body.Text), d.RefusedBy)
	writeJSON(w, status, map[string]any{
		"ok": false, "refusedBy": string(d.RefusedBy), "reason": d.Reason,
	})
}

// handleSendError decides the fate of the reservation after a failed send, and
// the two branches are NOT interchangeable.
//
// A DEFINITIVE rejection means the provider refused the request and nothing
// went on the wire. Holding the key would then block the caller's legitimate
// retry for the whole 90-second lease over a message that provably was never
// delivered, so the reservation is released immediately.
//
// A TIMEOUT means we do not know. The send may already have reached the
// contact. Releasing the key there is the one path that genuinely double-
// messages a real person, so the reservation is deliberately left alone to
// expire under store.ReservationLease. Silence for 90 seconds is cheap; a
// duplicate message to a customer is not. The cap budget follows the same
// split for the same reason: a possibly-delivered message keeps its slot.
func (s *server) handleSendError(w http.ResponseWriter, consumer config.Consumer, body sendBody, storageKey string, sendErr error) {
	// ErrSendCancelled joins ErrSendTimeout on the ambiguous side: a send we
	// stopped waiting for may already have been delivered, so its reservation
	// must NOT be released either. Only a definitive provider rejection is
	// "failed".
	outcome := "failed"
	if errors.Is(sendErr, wa.ErrSendTimeout) || errors.Is(sendErr, wa.ErrSendCancelled) {
		outcome = "ambiguous"
	} else {
		if err := s.deps.Store.ReleaseIdempotency(storageKey); err != nil {
			log.Printf("WARNING reservation not released consumer=%s err=%v", consumer.Name, err)
		}
		// And its cap budget: a message that provably never left must not
		// occupy a contact's daily allowance. Released ONLY here, on the
		// definitive branch — a timed-out send may have been delivered, so its
		// budget stays spent for exactly the reason its key does.
		if err := s.deps.Store.ReleaseOutboundSlot(storageKey); err != nil {
			log.Printf("WARNING outbound slot not released consumer=%s err=%v", consumer.Name, err)
		}
	}

	// Never retried here: see above.
	log.Printf("send %s consumer=%s to=%s len=%s err=%v",
		outcome, consumer.Name, redact.JID(body.To), redact.Body(body.Text), sendErr)
	writeJSON(w, http.StatusBadGateway, map[string]any{
		"ok": false, "error": sendErr.Error(), "outcome": outcome,
	})
}

// saveIdempotency upgrades this caller's reservation into a replayable result.
//
// It runs AFTER a message has been delivered, so there is no failure response
// available: the contact already has the message. What is at stake is the
// reservation. A failure here leaves the key OPEN, and an open key is reclaimed
// once store.ReservationLease (90s) passes — so a caller retrying more than 90
// seconds later would win the key again and re-send a message that was
// delivered. That is the one window this whole rail exists to close, and it
// cannot be closed from here: the send is already done.
//
// The cheap safety that IS available is one retry. Every plausible cause of a
// transient failure — SQLite busy under a concurrent write, a momentary I/O
// error — clears on a second attempt, and a second attempt costs one statement.
// It does not make the window impossible, it makes it rare, and the remaining
// case is logged loudly enough to be found.
//
// Not retried in a loop, and never on ErrNoReservation: that error means the
// reserve/save pair drifted apart in code, and repeating a save that cannot
// succeed only delays the delivered response.
func (s *server) saveIdempotency(storageKey, msgID string, consumer config.Consumer) {
	err := s.deps.Store.SaveIdempotency(storageKey, msgID)
	if err != nil && !errors.Is(err, store.ErrNoReservation) {
		log.Printf("WARNING idempotency save failed, retrying once consumer=%s err=%v", consumer.Name, err)
		err = s.deps.Store.SaveIdempotency(storageKey, msgID)
	}
	if err == nil {
		return
	}
	level := "ALERT"
	if errors.Is(err, store.ErrNoReservation) {
		// We reserved this key moments ago and nothing else may take it, so
		// reaching here means the reserve/save pair drifted apart in code — a
		// bug in this handler, not a caller error.
		level = "BUG"
	}
	log.Printf("%s idempotency NOT saved after a DELIVERED send consumer=%s err=%v"+
		" — the reservation stays open and is reclaimable in %s, so a caller retry"+
		" after that would re-send a message the contact already has",
		level, consumer.Name, err, store.ReservationLease)
}
