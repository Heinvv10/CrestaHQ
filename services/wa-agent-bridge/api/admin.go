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
	var err error
	if body.Remove {
		err = s.deps.Store.RemoveAllowlist(body.JID)
	} else {
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
	if err := s.deps.Store.SetKill(body.On); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	log.Printf("KILL SWITCH set on=%v by=%s", body.On, consumer.Name)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "killed": body.On})
}

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	killed, err := s.deps.Store.KillState()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	now := s.deps.Now()
	total, err := s.deps.Store.OutboundCountTotal(now.Add(-24 * time.Hour))
	if err != nil {
		log.Printf("WARNING health outbound count failed err=%v", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":              true,
		"killed":          killed,
		"outboundLast24h": total,
		"dailyCap":        s.deps.Engine.Config().GlobalDailyCap,
	})
}
