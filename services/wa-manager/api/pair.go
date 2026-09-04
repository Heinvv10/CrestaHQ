package api

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
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

// handlePair relays one tenant's live pairing QR to the authenticated caller
// as JSON. The credential handling that makes this safe lives in bridgePair.
func (s *server) handlePair(w http.ResponseWriter, r *http.Request) {
	id, ok := tenantIDFromPath(w, r)
	if !ok {
		return
	}
	t, ok := s.lookupTenant(w, id)
	if !ok {
		return
	}
	body, failure := s.bridgePair(r, id, t)
	if failure != nil {
		writeJSON(w, failure.status, failure.body)
		return
	}

	out := map[string]any{"tenantId": id, "pairing": body.Pairing, "connected": body.Connected}
	if body.Pairing {
		out["code"] = body.Code
		out["expiresAt"] = body.ExpiresAt
	}
	writeJSON(w, http.StatusOK, out)
}

// pairFailure is a refusal both the JSON relay and the PNG route can raise.
// They report it differently — one as a body, one as a status — so the failure
// travels as data rather than being written to the response here.
type pairFailure struct {
	status int
	body   map[string]any
}

// bridgePair fetches one tenant's live pairing state from its bridge.
//
// Two credentials meet here and neither may cross:
//
//   - The manager calls the bridge with the MANAGER's own admin token for that
//     tenant — the one it wrote into the instance's `.env`. The caller's
//     operator token is never proxied through: it opens every tenant on this
//     box, and a bridge has no business seeing it.
//   - The QR payload comes back the other way and is a WRITE-GRADE credential:
//     scanning it links a device to the number with every permission the number
//     has. It is never logged — not in an error string, not in a debug line.
//     Neither is the bridge”'s own body, which is why a refusal below reports
//     only a status code.
//
// The response is decoded field by field rather than piped through, so a field
// the bridge grows later cannot start relaying by itself.
func (s *server) bridgePair(r *http.Request, id string, t store.Tenant) (bridgePairBody, *pairFailure) {
	if s.deps.TenantToken == nil {
		return bridgePairBody{}, &pairFailure{http.StatusInternalServerError,
			map[string]any{"error": "no tenant token source configured"}}
	}

	url := s.deps.BridgeBaseURL(t) + "/v1/pair"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
	if err != nil {
		return bridgePairBody{}, &pairFailure{http.StatusInternalServerError,
			map[string]any{"error": "could not build the bridge request"}}
	}
	req.Header.Set("Authorization", "Bearer "+s.deps.TenantToken(id))

	resp, err := s.deps.HTTPClient.Do(req)
	if err != nil {
		// net/http errors carry the URL, which a misconfigured BaseURL could
		// have a token in. Report the fact, not the error.
		log.Printf("pair relay unreachable tenant=%s", id)
		return bridgePairBody{}, &pairFailure{http.StatusBadGateway,
			map[string]any{"error": "the bridge for this tenant is unreachable"}}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("pair relay refused tenant=%s status=%d", id, resp.StatusCode)
		return bridgePairBody{}, &pairFailure{http.StatusBadGateway, map[string]any{
			"error": "the bridge refused the pairing request", "bridgeStatus": resp.StatusCode,
		}}
	}

	var body bridgePairBody
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxPairBodyBytes)).Decode(&body); err != nil {
		// The decode error can quote the body, and the body holds the QR.
		log.Printf("pair relay undecodable tenant=%s", id)
		return bridgePairBody{}, &pairFailure{http.StatusBadGateway,
			map[string]any{"error": "the bridge sent an unreadable pairing response"}}
	}
	return body, nil
}
