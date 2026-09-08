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
	"sync"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// Sender is the narrow slice of the transport the API needs. Taking the
// interface rather than *wa.Queue keeps the handlers testable with a stub.
type Sender interface {
	// media is nil for a plain text message; when set, text is its caption.
	// See wa.Transport, which this is the API-side half of.
	Send(ctx context.Context, jid, text string, media *rails.Media) (string, error)
}

// ConnectionState is the narrow slice of the WhatsApp client the health
// endpoint needs. It is an interface, and it is supplied AFTER construction in
// production, for the same reason the replay predicate is: the client cannot
// exist until the fanout does, and the fanout cannot exist until the API's
// dependencies do. main.go holds it behind the same atomic pointer the replay
// gate uses rather than inventing a second handoff — a plain shared *wa.Client
// variable would be a data race between main and the whatsmeow goroutine.
type ConnectionState interface {
	Connected() bool
	// PairingCode returns the live QR payload while a pairing is in flight.
	// It is a credential: the handler serves it only to an authenticated
	// caller and never logs it.
	PairingCode() (code string, expiresAt time.Time, pairing bool)
	// Number is the phone number this session is linked to, digits only, and
	// empty until it is paired.
	Number() string
}

type Deps struct {
	Engine    *rails.Engine
	Store     rails.Store
	Sender    Sender
	Consumers []config.Consumer
	Now       func() time.Time
	// Connection reports whether the WhatsApp socket is up. A nil Connection
	// makes health report degraded rather than healthy: an endpoint whose whole
	// job is catching silent failure must not answer "ok" about a thing it
	// cannot see.
	Connection ConnectionState

	// InboundSuppression reports what the fanout did not forward on the current
	// connection: history it recognised, and NEW messages it dropped because
	// the catch-up cap was reached. The second number is data loss with no
	// other trace — the bridge stores no message body — so it belongs on the
	// endpoint an off-box monitor already watches. Nil is tolerated: health
	// must degrade rather than fail when a dependency is unwired.
	InboundSuppression func() (history, capped int)

	// InboundDropAge is how long ago the most recent drop happened, and false
	// when this connection has dropped nothing.
	//
	// It exists so a drop can alert LOUDLY and then stop. The counter only
	// resets on a new connection, so treating any non-zero count as a problem
	// latches the bridge into degraded/503 for the whole connection — hours
	// after one lost message, on a number that is otherwise perfectly healthy.
	// An alert that never clears is one an operator learns to ignore, which is
	// the same reasoning this endpoint already applies to suppressed history.
	InboundDropAge func() (age time.Duration, ok bool)

	// Version is the build this process is running, stamped by the deploy
	// script with -ldflags. A plain `go build` leaves it "dev"; it is empty
	// only in tests that construct Deps directly.
	//
	// It exists so the manager can tell which bridges are still on the old
	// binary after a deploy. That question has to be answered by the running
	// PROCESS, not by a file on disk: the binary is shared by every instance
	// and is replaced before any of them restart, so the file says "new" for
	// forty bridges that are all still running the old code.
	Version string
}

// recordFailureLimit is how many CONSECUTIVE RecordOutbound failures are
// tolerated before the service stops itself.
//
// Every volume rail counts rows RecordOutbound writes, so while those writes
// are failing the caps drift toward unlimited — the safety layer is gone and
// the API is still answering 200. Failing the request instead is not available:
// the message is already delivered by then, and a caller retry would
// double-message a real person. So the degradation is made loud and bounded.
// Three is small enough that a genuinely broken store trips within seconds,
// and large enough that one transient write error is not an outage.
const recordFailureLimit = 3

// maxSendBodyBytes bounds the /v1/send request body. An unbounded read is a
// free memory-exhaustion lever for anything holding a token.
//
// It was 64KiB while every send was text. An attachment arrives base64-encoded
// inside the same JSON body, which costs 4 bytes on the wire per 3 bytes of
// file, so this has to clear maxMediaBytes * 4/3 or the cap that reports
// "attachment too large" would never be reached — the body reader would cut
// the request off first and the caller would get a bare 413 with no code. The
// headroom above that is for the JSON envelope and the caption.
const maxSendBodyBytes = 12 << 20

// maxTextRunes caps the message body, in runes.
//
// It exists because maxSendBodyBytes used to be the only thing bounding Text,
// and raising that to make room for base64 raised this by the same factor. The
// bound has to be its own constant: the queue paces sends at a per-rune delay
// (20ms in production) and does it while HOLDING the single socket mutex, so
// message length converts directly into how long every OTHER send is blocked.
// At 12MiB of text that is days, on a slot whose cap budget is already spent.
//
// 4096 is far above anything this rail legitimately carries — a WhatsApp
// message a person will read is a few hundred characters — and well under
// WhatsApp's own limit, so it refuses nothing real. Counted in runes, not
// bytes, because that is what the pacing counts.
const maxTextRunes = 4096

// maxMediaFilenameBytes caps the attachment filename.
//
// Without it a 3-byte PNG can arrive with an 11MiB name, which passes the size
// cap (that measures the payload) and is then copied into BOTH FileName and
// Title on the outgoing message. 255 is the conventional filename limit and is
// far more than a report needs.
const maxMediaFilenameBytes = 255

// maxMediaBytes caps ONE decoded attachment.
//
// 8MiB is far above the ~500KiB audit reports this exists to carry and far
// below anything WhatsApp itself would reject, so it bounds memory without
// being a limit an operator ever has to think about. Enforced on the DECODED
// length, not the encoded one: base64 is the transport, and a cap measured in
// transport bytes would move whenever the encoding did.
const maxMediaBytes = 8 << 20

// allowedMediaMimeTypes is what this bridge will put on the socket, as an
// allow-list rather than a deny-list. The rail sends from a real, un-bannable-
// by-us WhatsApp number; the set of file types worth that risk is small and
// known, and a deny-list would admit every type nobody thought to name.
var allowedMediaMimeTypes = map[string]bool{
	"image/png":       true,
	"image/jpeg":      true,
	"application/pdf": true,
}

// maxAdminBodyBytes bounds the admin bodies, which are a JID or a boolean. The
// lever is the same one and the token holders are the same people, so leaving
// these unbounded while /v1/send is capped protected nothing. Smaller than the
// send cap because nothing legitimate here approaches even this.
const maxAdminBodyBytes = 4 << 10

type server struct {
	deps Deps

	mu             sync.Mutex
	recordFailures int // consecutive RecordOutbound failures
}

// noteRecordOutbound tracks consecutive bookkeeping failures and fails the
// whole service closed once they pass the limit — the same direction every
// rail takes when it cannot verify its own precondition.
func (s *server) noteRecordOutbound(err error) {
	s.mu.Lock()
	if err == nil {
		s.recordFailures = 0
		s.mu.Unlock()
		return
	}
	s.recordFailures++
	n := s.recordFailures
	s.mu.Unlock()

	log.Printf("WARNING outbound not recorded (%d consecutive) err=%v", n, err)
	if n < recordFailureLimit {
		return
	}
	// The caps count rows that are not being written. Rather than keep sending
	// against counters that can no longer see anything, stop.
	log.Printf("KILL SWITCH set automatically: %d consecutive RecordOutbound failures, every volume cap is now blind", n)
	if err := s.deps.Store.SetKill(true); err != nil {
		log.Printf("BUG could not set the kill switch after repeated record failures err=%v", err)
	}
}

func (s *server) recordFailureCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recordFailures
}

// requireAdmin gates the actions that can only make things worse. It returns
// false having already written the response when the caller is not privileged.
func requireAdmin(w http.ResponseWriter, c config.Consumer, action string) bool {
	if c.Admin {
		return true
	}
	log.Printf("privilege refused consumer=%s action=%s", c.Name, action)
	writeJSON(w, http.StatusForbidden, map[string]any{
		"ok":    false,
		"error": action + " requires an operator token",
	})
	return false
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
	// Reading the allowlist is admin-gated like adding to it: the list names
	// every contact that has escaped reply-only, which is exactly the set an
	// attacker holding a consumer token would want.
	mux.HandleFunc("GET /v1/allowlist", s.authed(s.handleListAllowlist))
	mux.HandleFunc("POST /v1/kill", s.authed(s.handleKill))
	mux.HandleFunc("GET /v1/pair", s.authed(s.handlePair))
	return mux
}

// bearerToken pulls the token out of an Authorization header. One function,
// because handleHealth asks the same question `authed` does and two copies of
// a credential parse are two things that have to stay in step.
func bearerToken(r *http.Request) (string, bool) {
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	return header[len(prefix):], true
}

// consumerIndex resolves a bearer token to a registered consumer, or -1.
//
// Every candidate is compared and the comparison is constant-time; the loop
// deliberately does not break on a match. See authed, which is its caller for
// every gated route — handleHealth is the one place that asks the question
// without gating on the answer, because that endpoint stays reachable to an
// unauthenticated monitor and only WIDENS what it reports for a caller that
// holds a token.
func (s *server) consumerIndex(token string) int {
	matched := -1
	for i, c := range s.deps.Consumers {
		if subtle.ConstantTimeCompare([]byte(c.Token), []byte(token)) == 1 {
			matched = i
		}
	}
	return matched
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
		token, ok := bearerToken(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing bearer token"})
			return
		}
		matched := s.consumerIndex(token)
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
