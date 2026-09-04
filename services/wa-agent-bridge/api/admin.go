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
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.JID == "" {
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

type killBody struct {
	On bool `json:"on"`
}

func (s *server) handleKill(w http.ResponseWriter, r *http.Request, consumer config.Consumer) {
	var body killBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
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
func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	body := map[string]any{
		"killed":         false,
		"dailyCap":       s.deps.Engine.Config().GlobalDailyCap,
		"recordFailures": s.recordFailureCount(),
	}
	var problems []string

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
