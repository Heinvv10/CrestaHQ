package api

import (
	"net/http"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
)

// handlePair serves the live pairing QR.
//
// The payload is a CREDENTIAL: scanning it links a device to this number, with
// every permission the number has. So it is authenticated like every other
// write route, it is never logged, and it is omitted entirely when no pairing
// is in flight rather than returned empty — a caller polling this endpoint
// should not have to distinguish "" from absent.
func (s *server) handlePair(w http.ResponseWriter, _ *http.Request, _ config.Consumer) {
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
