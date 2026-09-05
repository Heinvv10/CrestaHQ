package api

import (
	"net/http"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
)

// handlePair serves the live pairing QR.
//
// This is a read route that returns a WRITE-GRADE credential: scanning the
// payload links a device to this number, with every permission the number has.
// A send token therefore is not enough — it is admin-gated for the same reason
// reading the allowlist is, and more so, because the QR grants the allowlist
// rather than merely disclosing it. A consumer token held by an off-box caller
// must not be able to poll a re-pair window and link itself.
//
// The code is never logged, and is omitted entirely when no pairing is in
// flight rather than returned empty — a caller polling this endpoint should not
// have to distinguish "" from absent.
func (s *server) handlePair(w http.ResponseWriter, _ *http.Request, consumer config.Consumer) {
	if !requireAdmin(w, consumer, "reading the pairing code") {
		return
	}
	w.Header().Set("Cache-Control", "no-store, max-age=0")

	connected := false
	if s.deps.Connection != nil {
		connected = s.deps.Connection.Connected()
	}

	body := map[string]any{"pairing": false, "connected": connected}
	if s.deps.Connection == nil {
		writeJSON(w, http.StatusOK, body)
		return
	}

	code, expiresAt, pairing := s.deps.Connection.PairingCode()
	if pairing {
		body["pairing"] = true
		body["code"] = code
		body["expiresAt"] = expiresAt.UTC().Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, body)
}
