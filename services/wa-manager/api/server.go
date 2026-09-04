// Package api exposes the manager over HTTP: create a tenant, tear one down,
// read its pairing QR, bounce its unit, and list what exists.
//
// Every route here is privileged. The manager writes `.env` files containing
// bearer tokens and starts systemd units, so an unauthenticated caller
// reaching ANY handler is remote code execution — which is why this package
// exposes no public endpoint at all, health included. The bridge can afford an
// unauthenticated /v1/health because the worst it discloses is a counter; the
// manager cannot, because its cheapest handler still names every tenant.
//
// Like the bridge, the single bearer token is only adequate because the
// listener binds to loopback or Tailscale, never to a public interface.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/provision"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// Provisioner is the narrow slice of *provision.Provisioner this API drives.
// Taking the interface keeps the handlers testable without a systemd on the
// machine — a test that could start a real unit is not a test.
type Provisioner interface {
	Create(tenantID, displayName string) (store.Tenant, error)
	Destroy(tenantID string) error
}

// Poller is the narrow slice of *health.Poller the list endpoint needs.
type Poller interface {
	Snapshot(ctx context.Context, tenants []store.Tenant) map[string]health.Report
}

// Units is the narrow slice of systemd.Controller the restart route needs.
// The provisioner owns creation and teardown; a bounce is neither, and
// reaching for the controller directly is cheaper than widening the
// provisioner's surface for one verb pair.
type Units interface {
	Stop(instance string) error
	Start(instance string) error
}

type Deps struct {
	Store       *store.Store
	Provisioner Provisioner
	Poller      Poller
	Units       Units

	// OperatorToken is the ONLY credential this API accepts. There is no
	// second, lesser role: everything reachable here is destructive or
	// discloses a device-linking credential.
	OperatorToken string

	// TenantToken returns the MANAGER's admin token for one tenant's bridge —
	// the one the provisioner wrote into that instance's `.env`. The pair
	// relay authenticates with this, never with the caller's token.
	TenantToken func(tenantID string) string

	// BridgeBaseURL addresses a tenant's bridge. Defaults to loopback on the
	// tenant's allocated port, which is the only interface a bridge listens on.
	BridgeBaseURL func(store.Tenant) string

	// HTTPClient talks to the bridges. Defaults to a short timeout: a hung
	// bridge must not pin an operator's request open indefinitely.
	HTTPClient *http.Client
}

// maxBodyBytes bounds every request body. Nothing this API accepts is larger
// than a tenant id and a display name; an unbounded read is a free
// memory-exhaustion lever for anything holding the operator token.
const maxBodyBytes = 4 << 10

type server struct{ deps Deps }

func New(deps Deps) http.Handler {
	if deps.HTTPClient == nil {
		deps.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	if deps.BridgeBaseURL == nil {
		deps.BridgeBaseURL = func(t store.Tenant) string {
			return fmt.Sprintf("http://127.0.0.1:%d", t.Port)
		}
	}
	s := &server{deps: deps}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/tenants", s.authed(s.handleList))
	mux.HandleFunc("POST /api/tenants", s.authed(s.handleCreate))
	mux.HandleFunc("DELETE /api/tenants/{id}", s.authed(s.handleDelete))
	mux.HandleFunc("GET /api/tenants/{id}/pair", s.authed(s.handlePair))
	mux.HandleFunc("POST /api/tenants/{id}/restart", s.authed(s.handleRestart))

	// The operator UI. Authenticated exactly like everything else here — it
	// is a view onto the same privileged surface, and an unauthenticated
	// manager is remote code execution — but via authedUI, which additionally
	// accepts the token as HTTP Basic because a browser cannot attach a
	// bearer header to a navigation or to an <img src>.
	mux.HandleFunc("GET /{$}", s.authedUI(s.handleUIIndex))
	mux.HandleFunc("GET /tenants/{id}", s.authedUI(s.handleUITenant))
	mux.HandleFunc("GET /tenants/{id}/qr.png", s.authedUI(s.handleQRPNG))
	return mux
}

// authed admits exactly one token.
//
// The comparison is constant-time. The token is long-lived and the endpoint is
// reachable from anything on the Tailscale network, so an early return on the
// first byte mismatch would leak it a byte at a time to a patient caller.
//
// NOTE: this property is NOT unit-observable — a test cannot see the
// difference between subtle.ConstantTimeCompare and `==` without a timing
// harness far more flaky than the bug it would catch. Phase 1 confirmed
// exactly this: a deliberate break of the same property on the bridge stayed
// green. It is therefore maintained by code review, and the tests below
// deliberately do not pretend otherwise — they cover WHICH tokens are
// admitted, not how long the comparison took.
func (s *server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing bearer token"})
			return
		}
		if !s.tokenOK(token) {
			// The presented token is never logged: a rejected token is often a
			// mistyped real one, and a log file is not the place for it.
			log.Printf("auth rejected path=%s", r.URL.Path)
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unknown token"})
			return
		}
		next(w, r)
	}
}

// bearerToken pulls the token out of an Authorization header, or reports that
// there was not one to pull.
func bearerToken(r *http.Request) (string, bool) {
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	return header[len(prefix):], true
}

// tokenOK is the single admission decision, shared by the API and the UI so
// the two cannot drift into disagreeing about who gets in.
//
// A misconfigured deployment with no token must admit nobody. That guard is
// deliberately unobservable today: ConstantTimeCompare already returns 0 on a
// length mismatch, so the only token that could match an empty one is "",
// which both carriers already refuse (the bearer prefix check needs a
// non-empty remainder, and Basic with an empty password is refused here).
// Breaking that line does NOT turn a test red, and no test pretends it does —
// it is here so that a future relaxation of the header parsing cannot quietly
// turn a missing config into an open door.
func (s *server) tokenOK(token string) bool {
	if s.deps.OperatorToken == "" || token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(s.deps.OperatorToken), []byte(token)) == 1
}

// tenantIDFromPath validates a caller-supplied id before it can address
// anything. The id becomes a filesystem path and a systemd unit name, so one
// that cannot yield a safe instance name is refused here rather than deeper.
func tenantIDFromPath(w http.ResponseWriter, r *http.Request) (string, bool) {
	return checkTenantID(w, r.PathValue("id"))
}

// checkTenantID admits only ids that are ALREADY their own instance name.
//
// provision.InstanceName is the shared authority on what is safe — one copy,
// so the API and the provisioner cannot drift into disagreeing — but this
// boundary is deliberately stricter than it. InstanceName is a best-effort
// COERCION: it maps "../../etc" to "etc" and "Blitz Fibre" to "blitz-fibre".
// Neither can traverse a directory, so neither is dangerous, but both are a
// silent rename: the operator asked for one tenant and got another, and two
// different ids can collapse onto one instance whose collision is then
// reported as a conflict with a name nobody typed. Refusing anything
// non-canonical costs an operator one retry and makes the id they see in the
// API the id on the unit, the directory and the port row.
func checkTenantID(w http.ResponseWriter, id string) (string, bool) {
	name, err := provision.InstanceName(id)
	if err != nil || name != id {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("tenant id %q is not usable as an instance name; "+
				"use lowercase letters, digits and dashes, starting with a letter or digit", id),
		})
		return "", false
	}
	return id, true
}

// lookupTenant resolves a validated id to its row, distinguishing "you
// mistyped" from "this broke": an operator chasing a dead number needs to know
// which of the two they are looking at.
func (s *server) lookupTenant(w http.ResponseWriter, id string) (store.Tenant, bool) {
	t, err := s.deps.Store.GetTenant(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such tenant"})
		return store.Tenant{}, false
	}
	return t, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("WARNING response encode failed status=%d err=%v", status, err)
	}
}
