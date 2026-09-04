package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSendRequiresBearerToken(t *testing.T) {
	h, _, sender := testHandler(t)
	rec := post(h, "/v1/send", "", sendBodyJSON(knownJID, "hi", "k1"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d body=%s", rec.Code, rec.Body.String())
	}
	if sender.Calls() != 0 {
		t.Fatal("an unauthenticated request reached the transport")
	}
}

func TestSendRejectsUnknownToken(t *testing.T) {
	h, _, sender := testHandler(t)
	rec := post(h, "/v1/send", "nope", sendBodyJSON(knownJID, "hi", "k1"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d body=%s", rec.Code, rec.Body.String())
	}
	if sender.Calls() != 0 {
		t.Fatal("an unknown token reached the transport")
	}
}

// A token that is a prefix of a real one, and one that merely contains it, must
// both fail: only a whole-value match authenticates.
func TestSendRejectsNearMissTokens(t *testing.T) {
	h, _, _ := testHandler(t)
	for _, tok := range []string{"tok-herme", "tok-hermes-extra", "TOK-HERMES", " tok-hermes"} {
		rec := post(h, "/v1/send", tok, sendBodyJSON(knownJID, "hi", "k1"))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("token %q must not authenticate, got %d", tok, rec.Code)
		}
	}
}

// A malformed Authorization header is rejected, not parsed leniently.
func TestSendRejectsNonBearerScheme(t *testing.T) {
	h, _, _ := testHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/send", nil)
	req.Header.Set("Authorization", "Basic tok-hermes")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 for a non-bearer scheme, got %d", rec.Code)
	}
}

// The admin endpoints carry the same auth as /v1/send: an unauthenticated
// caller must not be able to allowlist a stranger or lift the kill switch.
func TestAdminEndpointsRequireAuth(t *testing.T) {
	h, st, _ := testHandler(t)
	if rec := post(h, "/v1/allowlist", "", `{"jid":"`+strangerJID+`"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("allowlist want 401, got %d", rec.Code)
	}
	if ok, _ := st.IsAllowlisted(strangerJID); ok {
		t.Fatal("an unauthenticated request mutated the allowlist")
	}
	st.SetKill(true)
	if rec := post(h, "/v1/kill", "", `{"on":false}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("kill want 401, got %d", rec.Code)
	}
	if on, _ := st.KillState(); !on {
		t.Fatal("an unauthenticated request lifted the kill switch")
	}
}
