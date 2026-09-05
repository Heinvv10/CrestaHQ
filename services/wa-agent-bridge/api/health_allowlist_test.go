package api

import (
	"net/http"
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// The manager's operator screen renders "Reply-only on · N contacts
// allowlisted". It can only render that truthfully if health carries the
// number, and reply-only is the rail that keeps this number alive — an
// allowlisted JID has nothing but the global daily cap in front of it, so how
// many have escaped is safety state, not decoration.
func TestHealthReportsTheAllowlistCount(t *testing.T) {
	mem := store.NewMemory()
	h := newHandler(t, mem, &stubSender{})

	if got := decode(t, get(h, "/v1/health"))["allowlisted"]; got != float64(0) {
		t.Fatalf("an empty allowlist must report 0, got %#v", got)
	}

	if err := mem.AddAllowlist("27820000001@s.whatsapp.net"); err != nil {
		t.Fatal(err)
	}
	if err := mem.AddAllowlist("27820000002@s.whatsapp.net"); err != nil {
		t.Fatal(err)
	}
	if got := decode(t, get(h, "/v1/health"))["allowlisted"]; got != float64(2) {
		t.Fatalf("two allowlisted contacts must report 2, got %#v", got)
	}
}

// The count is a NUMBER, never the entries. Health is the one unauthenticated
// endpoint on this service, and the entries are JIDs — customer phone numbers.
func TestHealthDisclosesNoAllowlistedJIDs(t *testing.T) {
	mem := store.NewMemory()
	const jid = "27820000001@s.whatsapp.net"
	if err := mem.AddAllowlist(jid); err != nil {
		t.Fatal(err)
	}
	h := newHandler(t, mem, &stubSender{})

	body := get(h, "/v1/health").Body.String()
	if contains(body, "27820000001") {
		t.Fatalf("health leaked an allowlisted JID: %s", body)
	}
}

// A count of 0 and a count we could not read are different facts, and the
// screen above this must not draw them the same. An unreadable allowlist is
// the rail going blind, which is precisely what degraded means here.
func TestHealthDoesNotReportAnUnreadableAllowlistAsZero(t *testing.T) {
	mem := store.NewMemory()
	st := &faultyStore{Memory: mem, failListAllowlist: true}
	h := newHandler(t, st, &stubSender{})

	rec := get(h, "/v1/health")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("an unreadable allowlist must not answer 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	out := decode(t, rec)
	if out["degraded"] != true || out["ok"] != false {
		t.Fatalf("an unreadable allowlist must flip degraded, got %v", out)
	}
	if got, present := out["allowlisted"]; !present || got != nil {
		t.Fatalf("an unreadable allowlist must report null, never 0; got %#v (present=%v)", got, present)
	}
	var found bool
	for _, p := range out["problems"].([]any) {
		if p == "allowlist unreadable" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the problem must name the allowlist so an operator knows which rail went blind: %v", out["problems"])
	}
}
