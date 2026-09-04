package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

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
	if body.IdempotencyKey == "" {
		// Rejected here rather than left to the rails so the caller gets a
		// client-error status for what is a client mistake. Callers retry — on
		// a timeout, on a redeploy, on a queue redelivery — and a retry with no
		// key is indistinguishable from a new message.
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "idempotencyKey is required; without it a retry would duplicate the message"})
		return
	}

	req := rails.SendRequest{
		To:             body.To,
		Text:           body.Text,
		IdempotencyKey: body.IdempotencyKey,
		Consumer:       consumer.Name,
		Now:            s.deps.Now(),
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
		log.Printf("send aborted consumer=%s to=%s len=%s err=%v",
			consumer.Name, redact.JID(body.To), redact.Body(body.Text), err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "idempotency reservation failed", "outcome": "not_sent"})
		return
	}

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

	msgID, sendErr := s.deps.Sender.Send(r.Context(), body.To, body.Text)
	if sendErr != nil {
		s.handleSendError(w, consumer, body, storageKey, sendErr)
		return
	}

	// The message is delivered, so the caller is told so regardless — but an
	// unrecorded send is one no cap will ever count, and enough of them in a
	// row means the caps are blind. noteRecordOutbound trips the kill switch at
	// that point rather than letting the volume rails erode toward unlimited
	// behind a wall of 200s.
	s.noteRecordOutbound(s.deps.Store.RecordOutbound(body.To, consumer.Name, msgID, req.Now))
	if err := s.deps.Store.SaveIdempotency(storageKey, msgID); err != nil {
		level := "WARNING"
		if errors.Is(err, store.ErrNoReservation) {
			// We reserved this key moments ago and nothing else may take it, so
			// reaching here means the reserve/save pair drifted apart in code —
			// a bug in this handler, not a caller error. A retry would now send
			// the same message again.
			level = "BUG"
		}
		log.Printf("%s idempotency not saved consumer=%s err=%v", level, consumer.Name, err)
	}

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
// duplicate message to a customer is not.
func (s *server) handleSendError(w http.ResponseWriter, consumer config.Consumer, body sendBody, storageKey string, sendErr error) {
	outcome := "failed"
	if errors.Is(sendErr, wa.ErrSendTimeout) {
		outcome = "ambiguous"
	} else if err := s.deps.Store.ReleaseIdempotency(storageKey); err != nil {
		log.Printf("WARNING reservation not released consumer=%s err=%v", consumer.Name, err)
	}

	// Never retried here: see above.
	log.Printf("send %s consumer=%s to=%s len=%s err=%v",
		outcome, consumer.Name, redact.JID(body.To), redact.Body(body.Text), sendErr)
	writeJSON(w, http.StatusBadGateway, map[string]any{
		"ok": false, "error": sendErr.Error(), "outcome": outcome,
	})
}
