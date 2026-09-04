package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/wa"
)

var errSendFailed = errors.New("provider rejected the request")

func redactedLen(s string) string { return "<" + itoaTest(len([]rune(s))) + " chars>" }

func itoaTest(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func TestReplayedKeyDoesNotSendTwice(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	body := sendBodyJSON(knownJID, "hi", "same")

	first := post(h, "/v1/send", "tok-hermes", body)
	if first.Code != http.StatusOK {
		t.Fatalf("first send failed: %d %s", first.Code, first.Body.String())
	}
	rec := post(h, "/v1/send", "tok-hermes", body)

	if rec.Code != http.StatusOK {
		t.Fatalf("replay must succeed idempotently, got %d %s", rec.Code, rec.Body.String())
	}
	out := decode(t, rec)
	if out["duplicate"] != true || out["messageId"] != "sent-1" {
		t.Fatalf("a replay must return the original message id, got %v", out)
	}
	if sender.Calls() != 1 {
		t.Fatalf("replay sent again: %d transport calls", sender.Calls())
	}
}

// THE reserve-before-send guard. A handler written against Engine.Evaluate —
// the read-only path — passes every sequential test above and still sends
// twice, because both requests read "no such key" before either writes one.
// Only EvaluateAndReserve closes that window, and this is what proves it was
// used.
func TestConcurrentSameKeySendsExactlyOnce(t *testing.T) {
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(4))
	const goroutines = 24

	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	// A slow transport widens the race window so a missing reservation is
	// caught by design rather than by scheduling luck.
	sender.delay = 20 * time.Millisecond
	body := sendBodyJSON(knownJID, "hi", "contended")

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		codes   = map[int]int{}
		sentIDs = map[string]bool{}
		start   = make(chan struct{})
	)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			rec := post(h, "/v1/send", "tok-hermes", body)
			mu.Lock()
			codes[rec.Code]++
			if rec.Code == http.StatusOK {
				var out map[string]any
				_ = json.Unmarshal(rec.Body.Bytes(), &out)
				if out["duplicate"] != true {
					sentIDs[out["messageId"].(string)] = true
				}
			}
			mu.Unlock()
		}()
	}
	close(start)
	wg.Wait()

	if sender.Calls() != 1 {
		t.Fatalf("the same idempotency key reached the transport %d times; the reservation was skipped", sender.Calls())
	}
	if len(sentIDs) != 1 {
		t.Fatalf("want exactly one owning send, got %d (codes=%v)", len(sentIDs), codes)
	}
	for code := range codes {
		if code != http.StatusOK && code != http.StatusConflict {
			t.Fatalf("unexpected status %d among %v; a concurrent retry is not a server fault", code, codes)
		}
	}
}

// A send still in flight is a normal concurrent-retry outcome, not a server
// fault and not a rail refusal: 409, so the caller knows to retry shortly.
func TestInFlightKeyReturns409(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	// Simulate a peer that has claimed the key and not yet finished sending.
	if _, ok, err := st.ReserveIdempotency(rails.IdempotencyStorageKey("hermes", "held"), fixedNow); !ok || err != nil {
		t.Fatalf("setup reservation failed ok=%v err=%v", ok, err)
	}

	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", "held"))
	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409 while another request holds the key, got %d body=%s", rec.Code, rec.Body.String())
	}
	if decode(t, rec)["refusedBy"] != string(rails.RefusedInFlight) {
		t.Fatalf("want refusedBy in_flight, got %v", decode(t, rec))
	}
	if sender.Calls() != 0 {
		t.Fatal("an in-flight key reached the transport")
	}
}

// Keys are namespaced per consumer. Callers derive keys like "turn-1", so two
// consumers WILL collide on the raw value; if the handler recorded the raw key,
// the second consumer's real reply would be silently never sent.
func TestSameRawKeyFromTwoConsumersBothSend(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	body := sendBodyJSON(knownJID, "hi", "turn-1")

	if rec := post(h, "/v1/send", "tok-hermes", body); rec.Code != http.StatusOK {
		t.Fatalf("hermes send failed: %d", rec.Code)
	}
	rec := post(h, "/v1/send", "tok-leadstack", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("leadstack send failed: %d %s", rec.Code, rec.Body.String())
	}
	if decode(t, rec)["duplicate"] == true {
		t.Fatal("a second consumer's key collided with the first's; its reply would never be sent")
	}
	if sender.Calls() != 2 {
		t.Fatalf("want 2 sends across 2 consumers, got %d", sender.Calls())
	}
}

// A DEFINITIVE provider rejection never left the wire, so the key must be
// released immediately — otherwise the caller's retry is refused for the 90s
// lease over a message that provably was not delivered.
func TestDefinitiveSendFailureReleasesTheKey(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	sender.err = errSendFailed
	body := sendBodyJSON(knownJID, "hi", "k1")

	rec := post(h, "/v1/send", "tok-hermes", body)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d body=%s", rec.Code, rec.Body.String())
	}
	if decode(t, rec)["outcome"] != "failed" {
		t.Fatalf("a definitive rejection must be reported as failed, got %v", decode(t, rec))
	}
	if _, found, _ := st.LookupIdempotency(rails.IdempotencyStorageKey("hermes", "k1")); found {
		t.Fatal("the reservation was not released; the caller's retry is blocked for the whole lease")
	}

	sender.err = nil
	retry := post(h, "/v1/send", "tok-hermes", body)
	if retry.Code != http.StatusOK {
		t.Fatalf("the retry after a definitive failure must go through, got %d %s", retry.Code, retry.Body.String())
	}
	if sender.Calls() != 2 {
		t.Fatalf("want 2 attempts, got %d", sender.Calls())
	}
}

// A TIMED-OUT send may already have been delivered. Releasing the key here is
// the one path that genuinely double-messages a real customer, so the
// reservation must be left to expire on its lease instead.
func TestTimedOutSendDoesNotReleaseTheKey(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	sender.err = wa.ErrSendTimeout
	body := sendBodyJSON(knownJID, "hi", "k1")

	rec := post(h, "/v1/send", "tok-hermes", body)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d body=%s", rec.Code, rec.Body.String())
	}
	if decode(t, rec)["outcome"] != "ambiguous" {
		t.Fatalf("a timeout must be reported as ambiguous, got %v", decode(t, rec))
	}
	if _, found, _ := st.LookupIdempotency(rails.IdempotencyStorageKey("hermes", "k1")); !found {
		t.Fatal("a timed-out reservation was released; an immediate retry would double-message the contact")
	}

	sender.err = nil
	retry := post(h, "/v1/send", "tok-hermes", body)
	if retry.Code != http.StatusConflict {
		t.Fatalf("a retry inside the lease must be refused as in-flight, got %d %s", retry.Code, retry.Body.String())
	}
	if sender.Calls() != 1 {
		t.Fatalf("the ambiguous message was sent again: %d attempts", sender.Calls())
	}
}
