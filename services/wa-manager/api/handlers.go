package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/provision"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// tenantView is what this API discloses about a tenant.
//
// It is an explicit projection rather than store.Tenant re-encoded, so that a
// field added to the row later cannot start appearing in an operator console
// by accident. Neither the app token nor the manager token has any
// representation here — the manager holds both and must never hand either back.
type tenantView struct {
	TenantID    string      `json:"tenantId"`
	DisplayName string      `json:"displayName"`
	Instance    string      `json:"instance"`
	Port        int         `json:"port"`
	State       string      `json:"state"`
	Phone       string      `json:"phone,omitempty"`
	Health      *healthView `json:"health"`
}

// healthView mirrors a health.Report. A tenant the poller could not see gets a
// nil Health rather than a zero-valued one: an unreachable bridge and a bridge
// reporting all-zeroes are different incidents, and collapsing them would
// render the manager's whole reason for existing useless.
type healthView struct {
	Reachable             bool `json:"reachable"`
	Connected             bool `json:"connected"`
	Killed                bool `json:"killed"`
	Degraded              bool `json:"degraded"`
	OutboundLast24h       int  `json:"outboundLast24h"`
	DailyCap              int  `json:"dailyCap"`
	LastInboundAgeSeconds *int `json:"lastInboundAgeSeconds"`
	// AllowlistCount is how many contacts have escaped the bridge's reply-only
	// rail. Never omitempty and never a plain int: null means the bridge could
	// not read its own allowlist, which is a rail gone blind and the opposite
	// fact from "nobody has escaped".
	AllowlistCount *int `json:"allowlisted"`
	// Incomplete says this tenant was never checked because the sweep hit its
	// deadline. Never omitempty: "we did not look" and "we looked and it is
	// down" are different facts, and a caller must be able to see which.
	Incomplete bool     `json:"incomplete"`
	Problems   []string `json:"problems,omitempty"`
	Error      string   `json:"error,omitempty"`
}

func viewOf(t store.Tenant, r *health.Report) tenantView {
	v := tenantView{
		TenantID:    t.ID,
		DisplayName: t.DisplayName,
		Instance:    t.Instance,
		Port:        t.Port,
		State:       string(t.State),
		Phone:       t.Phone,
	}
	if r != nil {
		v.Health = &healthView{
			Reachable:             r.Reachable,
			Connected:             r.Connected,
			Killed:                r.Killed,
			Degraded:              r.Degraded,
			OutboundLast24h:       r.OutboundLast24h,
			DailyCap:              r.DailyCap,
			LastInboundAgeSeconds: r.LastInboundAgeSeconds,
			AllowlistCount:        r.AllowlistCount,
			Incomplete:            r.Incomplete,
			Problems:              r.Problems,
			Error:                 r.Err,
		}
	}
	return v
}

func (s *server) handleList(w http.ResponseWriter, r *http.Request) {
	tenants, err := s.deps.Store.ListTenants()
	if err != nil {
		log.Printf("listing tenants failed err=%v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not list tenants"})
		return
	}

	reports, truncated := s.snapshot(r.Context(), tenants)

	out := make([]tenantView, 0, len(tenants))
	for _, t := range tenants {
		var rep *health.Report
		if got, ok := reports[t.ID]; ok {
			rep = &got
		}
		out = append(out, viewOf(t, rep))
	}
	body := map[string]any{"tenants": out}
	if truncated {
		// Said in the body, not only per-tenant, so a script polling this
		// endpoint cannot mistake a truncated sweep for a healthy one.
		body["healthSweepTruncated"] = true
	}
	writeJSON(w, http.StatusOK, body)
}

type createRequest struct {
	TenantID    string `json:"tenantId"`
	DisplayName string `json:"displayName"`
}

func (s *server) handleCreate(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil || len(body) > maxBodyBytes {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unreadable or oversized body"})
		return
	}
	var req createRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "body must be JSON"})
		return
	}
	// Validated BEFORE the provisioner is touched. Provisioning allocates a
	// port and writes a directory; an id that can never yield a safe unit name
	// must not get that far, even though the provisioner would refuse it too.
	if _, ok := checkTenantID(w, req.TenantID); !ok {
		return
	}

	t, err := s.deps.Provisioner.Create(req.TenantID, req.DisplayName)
	if err != nil {
		// Only a refusal the provisioner AUTHORED is relayed and called a
		// conflict. Create also surfaces os.MkdirAll / os.WriteFile
		// PathErrors and raw systemctl stderr, which would hand the install
		// layout to any token holder — and, worse, would report a read-only
		// disk as 409 "already exists", sending an operator to hunt a
		// duplicate tenant that does not exist. The real error goes to the
		// log, where an operator on the box can read it.
		log.Printf("provisioning failed tenant=%s err=%v", req.TenantID, err)
		var conflict *provision.ConflictError
		if errors.As(err, &conflict) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": conflict.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": "could not provision this tenant; check the manager log",
		})
		return
	}
	writeJSON(w, http.StatusCreated, viewOf(t, nil))
}

// handleDelete tears a tenant down completely: unit, files, WhatsApp session
// and port.
//
// It requires ?confirm=<tenant id> matching the path. The operator token
// proves WHO is calling; it does not prove they meant THIS tenant, and this is
// the one action in the API that cannot be undone — the session directory is
// gone and the customer must re-scan a QR on their phone to come back. Naming
// the tenant twice costs an operator nothing and makes a mistyped or
// copy-pasted path inert rather than destructive.
func (s *server) handleDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := tenantIDFromPath(w, r)
	if !ok {
		return
	}
	if r.URL.Query().Get("confirm") != id {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("destroying a tenant erases its WhatsApp session; repeat the id as ?confirm=%s to confirm", id),
		})
		return
	}
	if _, ok := s.lookupTenant(w, id); !ok {
		return
	}
	if err := s.deps.Provisioner.Destroy(id); err != nil {
		// Destroy's errors wrap RemoveAll and systemctl; neither is the
		// caller's business. The tenant is left visibly half-destroyed and
		// the operator can retry — see provision.Destroy on why that is the
		// safe direction.
		log.Printf("destroy failed tenant=%s err=%v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": "could not fully tear this tenant down; check the manager log and retry",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenantId": id, "destroyed": true})
}

// handleRestart bounces one tenant's unit. Stop failing aborts rather than
// pressing on to Start: an operator who asked for a bounce and got a 200 will
// walk away, and a bridge that never stopped is exactly the stuck process they
// were trying to clear.
func (s *server) handleRestart(w http.ResponseWriter, r *http.Request) {
	id, ok := tenantIDFromPath(w, r)
	if !ok {
		return
	}
	t, ok := s.lookupTenant(w, id)
	if !ok {
		return
	}
	if problem := s.restartUnit(id, t); problem != "" {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": problem})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenantId": id, "instance": t.Instance})
}

// restartUnit does the bounce, returning the operator-facing reason it failed
// or "" for success. Every failure is a 500 at both call sites, so the status
// does not travel with it.
//
// Shared by the JSON route and the UI's re-pair form so a bounce cannot come to
// mean two different things depending on which one an operator reached for —
// the UI form exists precisely because a logged-out bridge only issues a
// pairing code on a fresh start.
func (s *server) restartUnit(id string, t store.Tenant) string {
	if s.deps.Units == nil {
		return "no unit controller configured"
	}
	if err := s.deps.Units.Stop(t.Instance); err != nil {
		log.Printf("restart stop failed tenant=%s err=%v", id, err)
		return "could not stop the unit; check the manager log"
	}
	// Clear the start rate limit before starting. StartLimitBurst=5 in ten
	// minutes counts every start, clean exits included, and once it trips
	// systemd refuses the start — so the button offered for a bridge that
	// keeps dying would report "did not start again" for up to ten minutes,
	// with nothing telling the operator that `reset-failed` is the remedy.
	// A failure here is not fatal: the start below is still worth attempting,
	// and its error is the one the operator needs to see.
	if err := s.deps.Units.ResetFailed(t.Instance); err != nil {
		log.Printf("restart reset-failed did not take tenant=%s err=%v", id, err)
	}
	if err := s.deps.Units.Start(t.Instance); err != nil {
		log.Printf("restart start failed tenant=%s err=%v", id, err)
		return "the unit was stopped but did not start again; check the manager log"
	}
	// A support record, not part of the operation: losing the line must not
	// turn a successful bounce into a failure.
	_ = s.deps.Store.AppendEvent(id, "restarted", "operator requested a restart")
	return ""
}
