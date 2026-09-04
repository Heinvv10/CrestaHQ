// Package api exposes the bridge over HTTP. Authentication is a per-consumer
// bearer token, which is only adequate because the listener binds to loopback
// or Tailscale — never to a public interface.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// Sender is the narrow slice of the transport the API needs. Taking the
// interface rather than *wa.Queue keeps the handlers testable with a stub.
type Sender interface {
	Send(ctx context.Context, jid, text string) (string, error)
}

type Deps struct {
	Engine    *rails.Engine
	Store     rails.Store
	Sender    Sender
	Consumers []config.Consumer
	Now       func() time.Time
}

type server struct {
	deps Deps
}

func New(deps Deps) http.Handler {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	s := &server{deps: deps}
	mux := http.NewServeMux()
	// Health is unauthenticated so an off-box monitor can poll it without
	// holding a send-capable token. It therefore discloses nothing but
	// operational counters — never a token, a JID or a message.
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("POST /v1/send", s.authed(s.handleSend))
	mux.HandleFunc("POST /v1/allowlist", s.authed(s.handleAllowlist))
	mux.HandleFunc("POST /v1/kill", s.authed(s.handleKill))
	return mux
}

type authedHandler func(w http.ResponseWriter, r *http.Request, consumer config.Consumer)

// authed resolves the bearer token to a registered consumer.
//
// Every candidate is compared, and the comparison is constant-time: these
// tokens are long-lived and the endpoint is reachable from anything on the
// Tailscale network, so an early return on the first byte mismatch would leak
// the token a byte at a time to a patient caller. The loop deliberately does
// not break on a match for the same reason.
func (s *server) authed(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		header := r.Header.Get("Authorization")
		if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing bearer token"})
			return
		}
		token := header[len(prefix):]

		matched := -1
		for i, c := range s.deps.Consumers {
			if subtle.ConstantTimeCompare([]byte(c.Token), []byte(token)) == 1 {
				matched = i
			}
		}
		if matched < 0 {
			// The token itself is never logged: a rejected token is often a
			// mistyped real one, and a log file is not the place for it.
			log.Printf("auth rejected path=%s", r.URL.Path)
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unknown token"})
			return
		}
		next(w, r, s.deps.Consumers[matched])
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("WARNING response encode failed status=%d err=%v", status, err)
	}
}
