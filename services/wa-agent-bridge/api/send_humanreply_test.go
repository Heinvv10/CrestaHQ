package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// The HTTP wire is where the narrow exemption can quietly become a blanket
// one. Hardcoding `HumanReply: true` in api/send.go — a one-token edit —
// passed all seven packages: every automated send would then escape quiet
// hours, which on this rail means customers' phones at 03:00.
//
// These drive the real handler over HTTP, inside the quiet window, so the
// field's journey from JSON to the rail decision is covered end to end.
func humanReplyHandler(t *testing.T, st rails.Store) http.Handler {
	t.Helper()
	return New(Deps{
		Engine: rails.NewEngine(st, rails.Config{
			PerContactPerDay: 10, ConsecutiveMax: 3, GlobalDailyCap: 150,
			Location: time.UTC,
			// Quiet all day, so the only thing that can admit a send is the
			// human-reply exemption.
			QuietStartHour: 0, QuietEndHour: 23,
			HumanReplySessionWindow: 24 * time.Hour,
			Budgets:                 map[string]rails.ConsumerBudget{"app": {PerHour: 100, PerDay: 500}},
		}),
		Store:      st,
		Sender:     &stubSender{},
		Consumers:  []config.Consumer{{Name: "app", Token: "tok-app"}},
		Now:        func() time.Time { return fixedNow },
		Connection: &stubConnection{up: true},
	})
}

func postSend(t *testing.T, h http.Handler, body string) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/v1/send", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer tok-app")
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

const hrJID = "27821234567@s.whatsapp.net"

func TestSendWithoutHumanReplyIsRefusedInQuietHours(t *testing.T) {
	st := store.NewMemory()
	if err := st.RecordInbound(hrJID, fixedNow.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	code, body := postSend(t, humanReplyHandler(t, st),
		`{"to":"`+hrJID+`","text":"automated","idempotencyKey":"k-auto"}`)

	if body["refusedBy"] != string(rails.RefusedQuietHours) {
		t.Fatalf("an unmarked send must be refused by quiet hours, got %d %v", code, body)
	}
}

func TestSendMarkedHumanReplyIsAdmittedInQuietHours(t *testing.T) {
	st := store.NewMemory()
	if err := st.RecordInbound(hrJID, fixedNow.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	code, body := postSend(t, humanReplyHandler(t, st),
		`{"to":"`+hrJID+`","text":"operator typed this","idempotencyKey":"k-human","humanReply":true}`)

	if code != http.StatusOK {
		t.Fatalf("a human reply inside an open session must be admitted, got %d %v", code, body)
	}
}

// The field must be read from the request, not assumed. This is the one that
// dies when api/send.go hardcodes it.
func TestHumanReplyIsReadFromTheRequestNotAssumed(t *testing.T) {
	st := store.NewMemory()
	if err := st.RecordInbound(hrJID, fixedNow.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	h := humanReplyHandler(t, st)

	_, marked := postSend(t, h, `{"to":"`+hrJID+`","text":"a","idempotencyKey":"k1","humanReply":true}`)
	_, unmarked := postSend(t, h, `{"to":"`+hrJID+`","text":"b","idempotencyKey":"k2","humanReply":false}`)

	if marked["refusedBy"] == string(rails.RefusedQuietHours) {
		t.Fatalf("humanReply:true was ignored on the way in: %v", marked)
	}
	if unmarked["refusedBy"] != string(rails.RefusedQuietHours) {
		t.Fatalf("humanReply:false was treated as true — every automated send would escape quiet hours: %v", unmarked)
	}
}

// Marked human, but the contact has not messaged in days: still an outreach.
func TestHumanReplyOutsideTheSessionIsStillRefusedOverHTTP(t *testing.T) {
	st := store.NewMemory()
	if err := st.RecordInbound(hrJID, fixedNow.Add(-72*time.Hour)); err != nil {
		t.Fatal(err)
	}
	_, body := postSend(t, humanReplyHandler(t, st),
		`{"to":"`+hrJID+`","text":"reaching out","idempotencyKey":"k-old","humanReply":true}`)

	if body["refusedBy"] != string(rails.RefusedQuietHours) {
		t.Fatalf("a human reply outside the session must still be refused: %v", body)
	}
}
