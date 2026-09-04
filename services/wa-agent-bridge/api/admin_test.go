package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
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
