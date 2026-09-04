package api

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/internal/redact"
)

type allowlistBody struct {
	JID    string `json:"jid"`
	Remove bool   `json:"remove"`
}

func (s *server) handleAllowlist(w http.ResponseWriter, r *http.Request, consumer config.Consumer) {
	var body allowlistBody
	if err := json.NewDecoder(
		http.MaxBytesReader(w, r.Body, maxAdminBodyBytes)).Decode(&body); err != nil || body.JID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "jid is required"})
		return
	}
	// ADDING is the fail-unsafe direction: an allowlisted JID has escaped
	// reply-only, and the only thing left in front of a cold DM is the global
	// daily cap. REMOVING only ever makes things safer, so it stays available
	// to every consumer.
	var err error
	if body.Remove {
		err = s.deps.Store.RemoveAllowlist(body.JID)
	} else {
		if !requireAdmin(w, consumer, "adding to the allowlist") {
			return
		}
		err = s.deps.Store.AddAllowlist(body.JID)
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	// Logged with the consumer: allowlisting is the documented escape hatch
	// from reply-only, so "who opened this door" must be answerable afterwards.
	log.Printf("allowlist jid=%s remove=%v by=%s", redact.JID(body.JID), body.Remove, consumer.Name)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleListAllowlist answers "who has escaped reply-only right now". Until
// this existed the only way to ask was grepping the log for past AddAllowlist
// lines, which misses everything added before the current log file — and an
// allowlisted JID has nothing but the global daily cap in front of it.
func (s *server) handleListAllowlist(w http.ResponseWriter, _ *http.Request, consumer config.Consumer) {
	if !requireAdmin(w, consumer, "reading the allowlist") {
		return
	}
	jids, err := s.deps.Store.ListAllowlist()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "jids": jids, "count": len(jids)})
}

type killBody struct {
	On bool `json:"on"`
}

func (s *server) handleKill(w http.ResponseWriter, r *http.Request, consumer config.Consumer) {
	var body killBody
	if err := json.NewDecoder(
		http.MaxBytesReader(w, r.Body, maxAdminBodyBytes)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	// Anyone may slam the brakes; only an operator releases them. During an
	// incident the operator credential may be exactly what nobody can lay hands
	// on, and a stop button behind a privilege is one that gets pressed too
	// late — while a consumer token able to LIFT the switch could silently undo
	// an operator's stop.
	if !body.On && !requireAdmin(w, consumer, "lifting the kill switch") {
		return
	}
	if err := s.deps.Store.SetKill(body.On); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	log.Printf("KILL SWITCH set on=%v by=%s", body.On, consumer.Name)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "killed": body.On})
}

// handleHealth is the endpoint whose whole job is catching silent failure, so
// it must not become one. A store it cannot read means every cap is blind —
// that is "degraded", not "quiet", and it answers 503 so an off-box monitor
// alerts on it without having to parse a body.
//
// It reports the SOCKET too. A bridge whose WhatsApp connection has quietly
// died still accepts HTTP and still answers every counter, so a payload built
// only from the store says "ok" about a number that can neither send nor
// receive — the historical worst case, and the one the off-box monitor exists
// for. connected and lastInboundAgeSeconds are the two fields that make it
// visible from outside.
func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	body := map[string]any{
		"killed":         false,
		"dailyCap":       s.deps.Engine.Config().GlobalDailyCap,
		"recordFailures": s.recordFailureCount(),
	}
	var problems []string

	// Fail closed on an unwired Connection: reporting "connected" for something
	// we cannot observe is exactly the silent failure this endpoint answers.
	connected := false
	if s.deps.Connection == nil {
		problems = append(problems, "connection state unavailable")
	} else {
		connected = s.deps.Connection.Connected()
		if !connected {
			problems = append(problems, "whatsapp socket is not connected")
		}
	}
	body["connected"] = connected

	// nil rather than 0 when nobody has ever messaged the number: a fresh
	// bridge is not a bridge that last heard from someone at the epoch, and a
	// monitor thresholding on this must be able to tell those apart.
	body["lastInboundAgeSeconds"] = nil
	if at, err := s.deps.Store.LastInboundAt(); err != nil {
		problems = append(problems, "last inbound unreadable")
		log.Printf("WARNING health last inbound failed err=%v", err)
	} else if !at.IsZero() {
		body["lastInboundAgeSeconds"] = int(s.deps.Now().Sub(at) / time.Second)
	}

	killed, err := s.deps.Store.KillState()
	if err != nil {
		problems = append(problems, "kill state unreadable")
		log.Printf("WARNING health kill state failed err=%v", err)
	}
	body["killed"] = killed

	total, err := s.deps.Store.OutboundCountTotal(s.deps.Now().Add(-24 * time.Hour))
	if err != nil {
		problems = append(problems, "outbound counters unreadable")
		log.Printf("WARNING health outbound count failed err=%v", err)
	} else {
		body["outboundLast24h"] = total
	}

	if len(problems) > 0 {
		body["ok"], body["degraded"], body["problems"] = false, true, problems
		writeJSON(w, http.StatusServiceUnavailable, body)
		return
	}
	body["ok"], body["degraded"] = true, false
	writeJSON(w, http.StatusOK, body)
}
