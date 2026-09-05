package api

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func TestKillEndpointStopsSends(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))

	if rec := post(h, "/v1/kill", "tok-hermes", `{"on":true}`); rec.Code != http.StatusOK {
		t.Fatalf("kill failed: %d", rec.Code)
	}
	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", "k2"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 after kill, got %d body=%s", rec.Code, rec.Body.String())
	}
	if decode(t, rec)["refusedBy"] != "kill_switch" {
		t.Fatalf("want refusedBy kill_switch, got %v", decode(t, rec))
	}
	if sender.Calls() != 0 {
		t.Fatal("kill switch did not stop the transport")
	}
}

// A kill-switched send must not consume the idempotency key either: once the
// operator lifts the switch, the caller's retry has to be able to go through.
func TestKilledSendLeavesTheKeyUsable(t *testing.T) {
	h, st, sender := testHandler(t)
	st.RecordInbound(knownJID, fixedNow.Add(-time.Hour))
	post(h, "/v1/kill", "tok-hermes", `{"on":true}`)
	post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", "k2"))
	post(h, "/v1/kill", "tok-operator", `{"on":false}`)

	rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(knownJID, "hi", "k2"))
	if rec.Code != http.StatusOK {
		t.Fatalf("retry after the kill switch lifted must send, got %d body=%s", rec.Code, rec.Body.String())
	}
	if sender.Calls() != 1 {
		t.Fatalf("want 1 send, got %d", sender.Calls())
	}
}

func TestAllowlistAddAndRemove(t *testing.T) {
	h, st, _ := testHandler(t)
	if rec := post(h, "/v1/allowlist", "tok-operator", `{"jid":"`+strangerJID+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("add failed: %d %s", rec.Code, rec.Body.String())
	}
	if ok, _ := st.IsAllowlisted(strangerJID); !ok {
		t.Fatal("jid was not allowlisted")
	}
	if rec := post(h, "/v1/allowlist", "tok-operator", `{"jid":"`+strangerJID+`","remove":true}`); rec.Code != http.StatusOK {
		t.Fatalf("remove failed: %d", rec.Code)
	}
	if ok, _ := st.IsAllowlisted(strangerJID); ok {
		t.Fatal("jid was not removed from the allowlist")
	}
}

func TestAllowlistRequiresAJID(t *testing.T) {
	h, _, _ := testHandler(t)
	if rec := post(h, "/v1/allowlist", "tok-operator", `{}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for a missing jid, got %d", rec.Code)
	}
}

// Allowlisting a stranger is the documented escape hatch from reply-only, so
// the two have to actually connect.
func TestAllowlistedStrangerCanBeMessaged(t *testing.T) {
	h, _, sender := testHandler(t)
	if rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(strangerJID, "hi", "a1")); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("a stranger must be refused before allowlisting, got %d", rec.Code)
	}
	post(h, "/v1/allowlist", "tok-operator", `{"jid":"`+strangerJID+`"}`)
	if rec := post(h, "/v1/send", "tok-hermes", sendBodyJSON(strangerJID, "hi", "a2")); rec.Code != http.StatusOK {
		t.Fatalf("an allowlisted jid must be sendable, got %d %s", rec.Code, rec.Body.String())
	}
	if sender.Calls() != 1 {
		t.Fatalf("want 1 send, got %d", sender.Calls())
	}
}

func TestHealthNeedsNoAuthAndReportsKillState(t *testing.T) {
	h, st, _ := testHandler(t)
	st.SetKill(true)
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	out := decode(t, rec)
	if out["killed"] != true {
		t.Fatalf("health must report kill state, got %v", out)
	}
}

// Health is unauthenticated, so it must never disclose a token or any other
// secret to an unauthenticated poller.
func TestHealthDisclosesNoSecrets(t *testing.T) {
	h, _, _ := testHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	for _, secret := range []string{"tok-hermes", "tok-leadstack"} {
		if contains(rec.Body.String(), secret) {
			t.Fatalf("health leaked %q: %s", secret, rec.Body.String())
		}
	}
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		}()
}

// TestHealthReportsADisconnectedSocket is the regression guard for the failure
// the off-box monitor exists to catch: a bridge that is ALIVE but whose
// WhatsApp connection has quietly died. It still accepts HTTP and still
// answers every store counter, so a payload built only from the store says
// "ok" about a number that can neither send nor receive.
func TestHealthReportsADisconnectedSocket(t *testing.T) {
	st := store.NewMemory()
	conn := &stubConnection{up: false}
	h := newHandlerWithConnection(t, st, &stubSender{}, conn)

	rec := get(h, "/v1/health")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("a disconnected bridge must not answer 200; got %d %s", rec.Code, rec.Body.String())
	}
	out := decode(t, rec)
	if out["connected"] != false {
		t.Fatalf("health must report connected=false, got %v", out)
	}
	if out["ok"] != false {
		t.Fatalf("a disconnected bridge is not ok, got %v", out)
	}

	conn.set(true)
	rec = get(h, "/v1/health")
	if rec.Code != http.StatusOK || decode(t, rec)["connected"] != true {
		t.Fatalf("a connected bridge must answer 200 connected=true, got %d %s", rec.Code, rec.Body.String())
	}
}

// TestHealthReportsInboundAge: an inbound age that keeps climbing is the only
// externally visible symptom of a socket that is up but no longer delivering.
// nil, not 0, when nobody has ever messaged the number — a fresh bridge is not
// a bridge that last heard from someone at the epoch.
func TestHealthReportsInboundAge(t *testing.T) {
	st := store.NewMemory()
	h := newHandlerWithConnection(t, st, &stubSender{}, &stubConnection{up: true})

	if age := decode(t, get(h, "/v1/health"))["lastInboundAgeSeconds"]; age != nil {
		t.Fatalf("with no inbound ever, age must be null rather than 0, got %v", age)
	}

	st.RecordInbound(knownJID, fixedNow.Add(-90*time.Second))
	age, ok := decode(t, get(h, "/v1/health"))["lastInboundAgeSeconds"].(float64)
	if !ok || int(age) != 90 {
		t.Fatalf("want lastInboundAgeSeconds 90, got %v (ok=%v)", age, ok)
	}
}

// TestHealthFailsClosedWithoutConnectionState: an unwired Connection must
// degrade, not report a healthy socket. The endpoint whose whole job is
// catching silent failure must not become one over its own wiring.
func TestHealthFailsClosedWithoutConnectionState(t *testing.T) {
	h := newHandlerWithConnection(t, store.NewMemory(), &stubSender{}, nil)
	rec := get(h, "/v1/health")
	if rec.Code != http.StatusServiceUnavailable || decode(t, rec)["connected"] != false {
		t.Fatalf("an unwired connection must degrade, got %d %s", rec.Code, rec.Body.String())
	}
}

// TestListAllowlistIsAdminGated: the list names every contact that has escaped
// reply-only, which is exactly the set a leaked consumer token would want. It
// is gated like ADDING, not like removing.
func TestListAllowlistIsAdminGated(t *testing.T) {
	h, st, _ := testHandler(t)
	st.AddAllowlist(strangerJID)

	if rec := getAuthed(h, "/v1/allowlist", "tok-hermes"); rec.Code != http.StatusForbidden {
		t.Fatalf("a non-admin consumer must not read the allowlist, got %d %s", rec.Code, rec.Body.String())
	}

	rec := getAuthed(h, "/v1/allowlist", "tok-operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("an operator must be able to read it, got %d %s", rec.Code, rec.Body.String())
	}
	out := decode(t, rec)
	jids, ok := out["jids"].([]any)
	if !ok || len(jids) != 1 || jids[0] != strangerJID {
		t.Fatalf("want the one allowlisted jid back, got %v", out)
	}
}

// TestAdminBodiesAreBounded: /v1/send caps its body at 64 KiB because an
// unbounded read is a free memory-exhaustion lever for anything holding a
// token. The admin routes are reachable by the same token holders, so leaving
// them unbounded protected nothing.
func TestAdminBodiesAreBounded(t *testing.T) {
	h, _, _ := testHandler(t)
	huge := `{"jid":"` + strings.Repeat("x", maxAdminBodyBytes+1) + `"}`

	for _, path := range []string{"/v1/allowlist", "/v1/kill"} {
		rec := post(h, path, "tok-operator", huge)
		if rec.Code == http.StatusOK {
			t.Fatalf("%s accepted a %d-byte body; admin bodies must be bounded", path, len(huge))
		}
	}
}

// TestHealthReportsTheNumberOnlyToAnAuthenticatedCaller.
//
// The manager's operator screen showed "not paired" beside a number that was
// connected and taking messages, because nothing ever told it which number the
// bridge holds. Health is where it now learns that — but health is the only
// ungated surface this service has, so the number is reported to a caller
// holding a consumer token and to nobody else. The same reasoning already puts
// the allowlist COUNT in this body and keeps its entries out.
func TestHealthReportsTheNumberOnlyToAnAuthenticatedCaller(t *testing.T) {
	st := store.NewMemory()
	conn := &stubConnection{up: true, number: "27821234567"}
	h := newHandlerWithConnection(t, st, &stubSender{}, conn)

	if got, present := decode(t, get(h, "/v1/health"))["number"]; present {
		t.Fatalf("an unauthenticated caller must not learn the number, got %v", got)
	}
	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	if got, present := decode(t, getAuthed(h, "/v1/health", "not-a-real-token"))["number"]; present {
		t.Fatalf("an unknown token must not learn the number, got %v", got)
	}
	// And the refusal is LOGGED. Health needs no credential, so without this
	// line it would answer "is this token valid?" — the number key appears or
	// it does not — silently, while the same grind against any other route
	// writes a line per attempt.
	if !strings.Contains(logged.String(), "auth rejected path=/v1/health") {
		t.Fatalf("a rejected token on the ungated endpoint was not logged, got %q", logged.String())
	}
	if strings.Contains(logged.String(), "not-a-real-token") {
		t.Fatal("the rejected token was written to the log")
	}
	logged.Reset()
	if got := decode(t, getAuthed(h, "/v1/health", "tok-operator"))["number"]; got != "27821234567" {
		t.Fatalf("an authenticated caller must be told the number, got %v", got)
	}
}

// An unpaired bridge has no number, and the field is then absent rather than
// empty: the manager writes what it is told, and "" written over a number
// already known would erase it on the first sweep after a restart.
func TestHealthOmitsTheNumberBeforePairing(t *testing.T) {
	h := newHandlerWithConnection(t, store.NewMemory(), &stubSender{}, &stubConnection{up: true})
	if got, present := decode(t, getAuthed(h, "/v1/health", "tok-operator"))["number"]; present {
		t.Fatalf("an unpaired bridge must not report a number, got %v", got)
	}
}
