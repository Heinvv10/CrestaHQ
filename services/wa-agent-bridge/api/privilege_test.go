package api

import (
	"net/http"
	"testing"
)

// Allowlisting is the ONLY escape from reply-only. Past it, the sole remaining
// limit on cold DMs is the 150/day global cap — which is the ~120-cold-DM
// pattern that got the sibling number banned. A consumer token is a bot
// credential held by a program; it must not be able to open that door.
func TestAllowlistAddRequiresAnOperator(t *testing.T) {
	h, st, _ := testHandler(t)
	rec := post(h, "/v1/allowlist", "tok-hermes", `{"jid":"`+strangerJID+`"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403 for a non-operator allowlist add, got %d body=%s", rec.Code, rec.Body.String())
	}
	if ok, _ := st.IsAllowlisted(strangerJID); ok {
		t.Fatal("a consumer token opened the only door out of reply-only")
	}
	if rec := post(h, "/v1/allowlist", "tok-operator", `{"jid":"`+strangerJID+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("an operator must still be able to allowlist, got %d", rec.Code)
	}
}

// Removing from the allowlist only ever makes things safer, so it stays
// available to every consumer — a fail-safe action must never be gated behind
// a credential nobody has to hand during an incident.
func TestAllowlistRemoveIsOpenToEveryConsumer(t *testing.T) {
	h, st, _ := testHandler(t)
	st.AddAllowlist(strangerJID)
	if rec := post(h, "/v1/allowlist", "tok-hermes", `{"jid":"`+strangerJID+`","remove":true}`); rec.Code != http.StatusOK {
		t.Fatalf("removing must stay open to every consumer, got %d body=%s", rec.Code, rec.Body.String())
	}
	if ok, _ := st.IsAllowlisted(strangerJID); ok {
		t.Fatal("the jid was not removed")
	}
}

// Anyone may slam the brakes. This is deliberate: during an incident the
// operator credential may be exactly what nobody can lay hands on, and a stop
// button that needs a privilege is a stop button that gets pressed too late.
func TestAnyConsumerCanSetTheKillSwitch(t *testing.T) {
	h, st, _ := testHandler(t)
	if rec := post(h, "/v1/kill", "tok-leadstack", `{"on":true}`); rec.Code != http.StatusOK {
		t.Fatalf("every consumer must be able to stop outbound, got %d body=%s", rec.Code, rec.Body.String())
	}
	if on, _ := st.KillState(); !on {
		t.Fatal("the kill switch was not set")
	}
}

// Only an operator releases them. A consumer token that could lift the switch
// could silently undo an operator's incident stop.
func TestLiftingTheKillSwitchRequiresAnOperator(t *testing.T) {
	h, st, _ := testHandler(t)
	st.SetKill(true)

	rec := post(h, "/v1/kill", "tok-hermes", `{"on":false}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403 when a consumer lifts the kill switch, got %d body=%s", rec.Code, rec.Body.String())
	}
	if on, _ := st.KillState(); !on {
		t.Fatal("a consumer token undid an operator's incident stop")
	}
	if rec := post(h, "/v1/kill", "tok-operator", `{"on":false}`); rec.Code != http.StatusOK {
		t.Fatalf("an operator must be able to lift the switch, got %d", rec.Code)
	}
	if on, _ := st.KillState(); on {
		t.Fatal("the operator's lift did not take effect")
	}
}
