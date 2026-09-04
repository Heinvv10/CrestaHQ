package api

import (
	"bytes"
	"log"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

func TestSendRefusalReturns422WithMachineReadableCode(t *testing.T) {
	h, _, sender := testHandler(t)
	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(strangerJID, "hi", "k1"))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d body=%s", rec.Code, rec.Body.String())
	}
	out := decode(t, rec)
	if out["refusedBy"] != "reply_only" {
		t.Fatalf("want refusedBy reply_only, got %v", out)
	}
	if out["ok"] != false {
		t.Fatalf("a refusal must not report ok:true, got %v", out)
	}
	if sender.Calls() != 0 {
		t.Fatal("a refused send must never reach the transport")
	}
}

func TestSendHappyPathRecordsOutbound(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", "k1"))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	out := decode(t, rec)
	if out["messageId"] != "sent-1" {
		t.Fatalf("want the transport message id back, got %v", out)
	}
	if sender.Calls() != 1 {
		t.Fatalf("want 1 transport call, got %d", sender.Calls())
	}
	n, _ := st.OutboundCountForContact(knownJID, time.Time{})
	if n != 1 {
		t.Fatalf("outbound not recorded, count=%d", n)
	}
	// The completed send must be recorded under the SAME namespaced key the
	// reservation used, or a retry finds nothing and duplicates the message.
	id, found, _ := st.LookupIdempotency(rails.IdempotencyStorageKey("hermes", "k1"))
	if !found || id != "sent-1" {
		t.Fatalf("idempotency not saved under the namespaced key (found=%v id=%q); a retry would duplicate", found, id)
	}
}

func TestSendRejectsMissingFields(t *testing.T) {
	h, _, sender := testHandler(t)
	for name, body := range map[string]string{
		"no to":   `{"text":"hi","idempotencyKey":"k"}`,
		"no text": `{"to":"` + knownJID + `","idempotencyKey":"k"}`,
		"no key":  `{"to":"` + knownJID + `","text":"hi"}`,
		"garbage": `not json`,
	} {
		rec := post(h, "/v1/send", "tok-hermes", body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %d body=%s", name, rec.Code, rec.Body.String())
		}
	}
	if sender.Calls() != 0 {
		t.Fatal("an invalid request reached the transport")
	}
}

// Message bodies must never reach a log file: this service's logs are not
// access-controlled and the bodies belong in Firestore, where access control
// applies. Length is the only property logged.
func TestMessageBodiesAreNeverLogged(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	const secret = "the-customer-account-number-is-4471"

	post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, secret, "k1"))    // allowed
	post(h, "/v1/send", "tok-hermes", sendBodyJSON(strangerJID, secret, "k2")) // refused
	sender.err = errSendFailed
	post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, secret, "k3")) // failed

	if strings.Contains(buf.String(), secret) {
		t.Fatalf("a message body reached the log: %s", buf.String())
	}
	if !strings.Contains(buf.String(), redactedLen(secret)) {
		t.Fatalf("want the redacted length in the log, got: %s", buf.String())
	}
	// A token must never be logged either.
	if strings.Contains(buf.String(), "tok-hermes") {
		t.Fatalf("a bearer token reached the log: %s", buf.String())
	}
}
