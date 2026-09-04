package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// Every volume rail counts rows written by RecordOutbound. If those writes keep
// failing, the caps drift toward unlimited while the API keeps answering 200 —
// the caps are silently gone and nothing says so. Failing the request is wrong
// (the message is already delivered; a retry double-messages), so the
// degradation is made loud and bounded instead: past a small number of
// CONSECUTIVE failures the service fails closed via its own kill switch.
func TestRepeatedOutboundRecordFailuresTripTheKillSwitch(t *testing.T) {
	mem := store.NewMemory()
	st := &faultyStore{Memory: mem, failRecordOutbound: true}
	sender := &stubSender{}
	h := newHandler(t, st, sender)
	mem.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	for i := 0; i < recordFailureLimit; i++ {
		if on, _ := mem.KillState(); on {
			t.Fatalf("tripped early, after %d failures", i)
		}
		rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", key(i)))
		// The message WAS delivered, so the caller is told the truth about it.
		if rec.Code != http.StatusOK {
			t.Fatalf("failure %d: the send succeeded, so it must report 200, got %d body=%s", i, rec.Code, rec.Body.String())
		}
	}
	if on, _ := mem.KillState(); !on {
		t.Fatalf("after %d consecutive unrecorded sends the caps are blind; the service must fail closed", recordFailureLimit)
	}

	// And it is actually enforced from here on.
	before := sender.Calls()
	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", "after"))
	if rec.Code != http.StatusUnprocessableEntity || sender.Calls() != before {
		t.Fatalf("outbound continued after the trip: code=%d calls=%d->%d", rec.Code, before, sender.Calls())
	}
}

// The counter measures CONSECUTIVE failures: a single blip amid healthy writes
// is not a blind cap, and tripping on it would turn a transient error into an
// outage.
func TestOneSuccessfulRecordResetsTheFailureCount(t *testing.T) {
	mem := store.NewMemory()
	st := &faultyStore{Memory: mem}
	h := newHandler(t, st, &stubSender{})
	mem.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	for round := 0; round < 3; round++ {
		for i := 0; i < recordFailureLimit-1; i++ {
			st.failRecordOutbound = true
			post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", key(round*100+i)))
		}
		st.failRecordOutbound = false
		post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", key(round*100+50)))
	}
	if on, _ := mem.KillState(); on {
		t.Fatal("isolated failures separated by successes tripped the switch; the counter is not consecutive")
	}
}

// Health is the endpoint whose entire job is catching silent failure. Returning
// ok:true when the store every cap depends on is unreadable reads to an off-box
// monitor as "quiet" rather than "blind".
func TestHealthReportsDegradedWhenTheStoreIsUnreadable(t *testing.T) {
	mem := store.NewMemory()
	st := &faultyStore{Memory: mem, failCountTotal: true}
	h := newHandler(t, st, &stubSender{})

	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("an unreadable store must not answer 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	out := decode(t, rec)
	if out["degraded"] != true || out["ok"] != false {
		t.Fatalf("health must say it is degraded, got %v", out)
	}
}

// The monitor needs the failure count itself, so a rising-but-not-yet-tripped
// store problem is visible before it fails closed.
func TestHealthSurfacesTheRecordFailureCount(t *testing.T) {
	mem := store.NewMemory()
	st := &faultyStore{Memory: mem, failRecordOutbound: true}
	h := newHandler(t, st, &stubSender{})
	mem.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", "k1"))

	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	out := decode(t, rec)
	if out["recordFailures"] != float64(1) {
		t.Fatalf("health must surface the consecutive record-failure count, got %v", out)
	}
}

// An oversized body must be refused rather than buffered: this listener is
// small, and an unbounded read is a free memory-exhaustion lever for anything
// holding a token.
func TestSendBodyIsBounded(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	huge := make([]byte, maxSendBodyBytes+1024)
	for i := range huge {
		huge[i] = 'a'
	}
	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, string(huge), "k1"))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("want 413 for an oversized body, got %d", rec.Code)
	}
	if sender.Calls() != 0 {
		t.Fatal("an oversized body reached the transport")
	}
}

func key(i int) string { return "k" + itoaTest(i) }
