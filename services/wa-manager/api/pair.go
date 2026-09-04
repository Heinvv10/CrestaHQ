package api

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
)

// maxPairBodyBytes bounds what is read back from a bridge. The real payload is
// a QR string and a timestamp; a bridge that answered with something enormous
// is not one to stream into memory.
const maxPairBodyBytes = 64 << 10

// bridgePairBody is the bridge's /v1/pair shape.
type bridgePairBody struct {
	Pairing   bool   `json:"pairing"`
	Connected bool   `json:"connected"`
	Code      string `json:"code"`
	ExpiresAt string `json:"expiresAt"`
}

// handlePair relays one tenant's live pairing QR.
//
// Two credentials meet here and neither may cross:
//
//   - The manager calls the bridge with the MANAGER's own admin token for that
//     tenant — the one it wrote into the instance's `.env`. The caller's
//     operator token is never proxied through: it opens every tenant on this
//     box, and a bridge has no business seeing it.
//   - The QR payload comes back the other way and is a WRITE-GRADE credential:
//     scanning it links a device to the number with every permission the number
//     has. It is returned to the authenticated caller and is never logged —
//     not in an error string, not in a debug line. Neither is the bridge's own
//     body, which is why a refusal below reports only a status code.
//
// The response is re-encoded field by field rather than piped through, so a
// field the bridge grows later cannot start relaying by itself.
func (s *server) handlePair(w http.ResponseWriter, r *http.Request) {
	id, ok := tenantIDFromPath(w, r)
	if !ok {
		return
	}
	t, ok := s.lookupTenant(w, id)
	if !ok {
		return
	}
	if s.deps.TenantToken == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "no tenant token source configured"})
		return
	}

	url := s.deps.BridgeBaseURL(t) + "/v1/pair"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not build the bridge request"})
		return
	}
	req.Header.Set("Authorization", "Bearer "+s.deps.TenantToken(id))

	resp, err := s.deps.HTTPClient.Do(req)
	if err != nil {
		// net/http errors carry the URL, which a misconfigured BaseURL could
		// have a token in. Report the fact, not the error.
		log.Printf("pair relay unreachable tenant=%s", id)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the bridge for this tenant is unreachable"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("pair relay refused tenant=%s status=%d", id, resp.StatusCode)
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": "the bridge refused the pairing request", "bridgeStatus": resp.StatusCode,
		})
		return
	}

	var body bridgePairBody
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxPairBodyBytes)).Decode(&body); err != nil {
		// The decode error can quote the body, and the body holds the QR.
		log.Printf("pair relay undecodable tenant=%s", id)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the bridge sent an unreadable pairing response"})
		return
	}

	out := map[string]any{"tenantId": id, "pairing": body.Pairing, "connected": body.Connected}
	if body.Pairing {
		out["code"] = body.Code
		out["expiresAt"] = body.ExpiresAt
	}
	writeJSON(w, http.StatusOK, out)
}
