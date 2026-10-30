# WhatsApp Manager (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WhatsApp bridge sellable — pair a number from a browser, run one bridge process per number, and see at a glance whether each number is safe.

**Architecture:** The existing bridge gains one authenticated endpoint that serves its pairing QR. A new `wa-manager` Go service provisions one bridge instance per number (templated systemd unit, own port, own SQLite, own session dir), drives their lifecycle through `systemctl --user`, aggregates their health, and serves the operator UI. The manager is a supervisor and a view — it is deliberately **not** in the message path.

**Tech Stack:** Go 1.26, `github.com/mattn/go-sqlite3` (cgo), stdlib `net/http` + `html/template`, `github.com/skip2/go-qrcode` for QR rendering, systemd user units.

**Spec:** `docs/superpowers/specs/2026-09-04-wa-manager-design.md` — read it first; it carries the reasoning behind every structural choice here.

## Global Constraints

- **Go 1.26.0**, matching `services/wa-agent-bridge/go.mod`.
- **Max 300 lines per non-test file.** Split rather than exceed, and say so.
- **Message bodies MUST NEVER be logged**, in either service. The bridge has `internal/redact`; the manager never handles a body at all.
- **The pairing QR is a credential** — anyone who scans it links a device to that number. Serve it only to an authenticated caller, never log it, and drop it from memory once pairing succeeds.
- **Fail closed.** Any error refuses; nothing reports healthy about a thing it cannot observe.
- **cgo is required** (`go-sqlite3`). `CGO_ENABLED=0 go build ./...` must FAIL, per the existing `store/requires_cgo.go` guard — replicate that guard in the manager.
- **Tests must run clean under `-race`.**
- **Every new test gets deliberately broken, observed RED, and restored** — see "Testing discipline" below. This is not optional.
- The manager binds loopback/CGNAT only, like the bridge. Its auth is load-bearing: an unauthenticated manager is remote code execution by way of `.env` writes.

## Testing discipline — read this before writing any test

Eight tests in phase 1 passed under the exact bugs they were written for: three concurrency tests whose goroutines never actually contended (single round, bare `go func`, no ready barrier), one whose property was true by accident, one masked by a graceful failure, and three first drafts in a single fix wave. Two more were caught in the final review.

**For every test: break the property deliberately, run it, confirm RED, restore, and report what you saw.** Reading a test proves nothing. If a property genuinely cannot be tested, say so plainly rather than writing a test that passes either way.

Concurrency tests specifically need a ready barrier and many rounds, and should be checked at `GOMAXPROCS=1` as well as higher — one phase-1 test detected its bug 20/20 at `GOMAXPROCS≥2` and 0/20 at 1.

---

## File Structure

| Path | Responsibility |
|---|---|
| `services/wa-agent-bridge/wa/whatsmeow.go` | **modify** — capture the pairing QR on `Client` |
| `services/wa-agent-bridge/api/pair.go` | **new** — `GET /v1/pair` handler |
| `services/wa-agent-bridge/deploy/wa-agent-bridge@.service` | **new** — templated unit |
| `services/wa-manager/go.mod` | new module |
| `services/wa-manager/store/sqlite.go` | tenants + ports + events tables |
| `services/wa-manager/store/ports.go` | atomic port allocation |
| `services/wa-manager/systemd/unit.go` | `systemctl --user` driver behind an interface |
| `services/wa-manager/systemd/fake.go` | test fake (in a `_test.go` file) |
| `services/wa-manager/provision/provision.go` | instance dir + `.env` + lifecycle orchestration |
| `services/wa-manager/health/poll.go` | fan-out poll of each bridge's `/v1/health` |
| `services/wa-manager/api/server.go` | routes + bearer auth |
| `services/wa-manager/api/handlers.go` | tenant CRUD, pair relay, health |
| `services/wa-manager/ui/templates/*.html` | numbers list + number card |
| `services/wa-manager/main.go` | wiring only |
| `.github/workflows/wa-manager.yml` | path-filtered CI |

---

## Task 1: Capture the pairing QR on the bridge's Client

**Files:**
- Modify: `services/wa-agent-bridge/wa/whatsmeow.go`
- Test: `services/wa-agent-bridge/wa/pairing_test.go`

**Interfaces:**
- Consumes: the existing `Client` struct (fields `mu`, `wac`, `connectedAt`, `loggedOut`, `onInbound`, `onLoggedOut`) and its `Connect(ctx)` method, whose goroutine already ranges over `qrChan` emitting `evt.Event == "code"` with `evt.Code` and `evt.Timeout`.
- Produces: `func (c *Client) PairingCode() (code string, expiresAt time.Time, pairing bool)` — `pairing` is false once paired or before any code arrives. Task 3's handler and Task 8's UI consume exactly this signature.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/wa/pairing_test.go`:

```go
package wa

import (
	"testing"
	"time"
)

func TestPairingCodeIsEmptyBeforeAnyCodeArrives(t *testing.T) {
	c := &Client{}
	if _, _, pairing := c.PairingCode(); pairing {
		t.Fatal("a client that has never emitted a code must not report pairing")
	}
}

func TestPairingCodeIsServedThenClearedOnSuccess(t *testing.T) {
	c := &Client{}
	exp := time.Now().Add(30 * time.Second)
	c.setPairingCode("2@abc123", exp)

	code, expiresAt, pairing := c.PairingCode()
	if !pairing || code != "2@abc123" || !expiresAt.Equal(exp) {
		t.Fatalf("want the live code back, got %q %v %v", code, expiresAt, pairing)
	}

	// Pairing succeeded: the code is a credential and must not outlive its use.
	c.clearPairingCode()
	if code, _, pairing := c.PairingCode(); pairing || code != "" {
		t.Fatalf("code survived pairing: %q %v", code, pairing)
	}
}

func TestExpiredPairingCodeIsNotServed(t *testing.T) {
	c := &Client{}
	c.setPairingCode("2@stale", time.Now().Add(-time.Second))
	if _, _, pairing := c.PairingCode(); pairing {
		t.Fatal("an expired code must not be served — a stale QR scans into nothing")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./wa/... -run Pairing
```
Expected: FAIL — `c.PairingCode undefined`.

- [ ] **Step 3: Add the fields and methods**

In `wa/whatsmeow.go`, add two fields to the `Client` struct, after `loggedOut`:

```go
	// pairCode is the live QR payload while a pairing is in flight. It is a
	// CREDENTIAL — anyone who scans it links a device to this number — so it is
	// never logged, is dropped the moment pairing succeeds, and is not served
	// once it expires (a stale QR scans into nothing and looks like our bug).
	pairCode   string
	pairExpiry time.Time
```

Then add, near `Connected()`:

```go
func (c *Client) setPairingCode(code string, expiresAt time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pairCode, c.pairExpiry = code, expiresAt
}

func (c *Client) clearPairingCode() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pairCode, c.pairExpiry = "", time.Time{}
}

// PairingCode returns the live QR payload, if one is in flight and unexpired.
func (c *Client) PairingCode() (string, time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pairCode == "" || time.Now().After(c.pairExpiry) {
		return "", time.Time{}, false
	}
	return c.pairCode, c.pairExpiry, true
}
```

- [ ] **Step 4: Wire it into the existing QR goroutine**

In `Connect`, inside the `for evt := range qrChan` switch, the `"code"` arm currently logs and calls `qrterminal.GenerateHalfBlock`. Add the capture as its FIRST statement, and clear on success:

```go
			case "code":
				c.setPairingCode(evt.Code, time.Now().Add(evt.Timeout))
				log.Printf("wa: scan this QR to pair (expires in %s)", evt.Timeout)
				qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, log.Writer())
			case "success":
				c.clearPairingCode()
				log.Printf("wa: paired successfully")
			default:
				c.clearPairingCode()
				log.Printf("wa: pairing ended: %s", evt.Event)
```

Note the `default` arm clears too: a pairing that ends in timeout or error must not leave a dead code being served.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd services/wa-agent-bridge && go test ./... -race -count=2
```
Expected: PASS, all packages.

- [ ] **Step 6: Deliberate-break verification**

Break each property, observe RED, restore. Report what you saw:
1. Make `PairingCode` ignore the expiry check → `TestExpiredPairingCodeIsNotServed` must fail.
2. Make `clearPairingCode` a no-op → `TestPairingCodeIsServedThenClearedOnSuccess` must fail.
3. Remove the `default` arm's clear → no test covers it; say so plainly and add one if you judge it worth it.

- [ ] **Step 7: Commit**

```bash
git add services/wa-agent-bridge/wa/whatsmeow.go services/wa-agent-bridge/wa/pairing_test.go
git commit -m "Keep the pairing QR in memory so it can be served, not just printed"
```

---

## Task 2: Serve the QR from `GET /v1/pair`

**Files:**
- Create: `services/wa-agent-bridge/api/pair.go`
- Modify: `services/wa-agent-bridge/api/server.go` (the `ConnectionState` interface, `Deps`, and the route table at ~line 135)
- Test: `services/wa-agent-bridge/api/pair_test.go`

**Interfaces:**
- Consumes: `(*wa.Client).PairingCode() (string, time.Time, bool)` from Task 1; the existing `s.authed(...)` wrapper and `writeJSON` helper in `api/server.go`.
- Produces: `GET /v1/pair` returning `{"pairing":bool, "code":string, "expiresAt":RFC3339, "connected":bool}`. Task 7's manager relays this; Task 8's UI renders `code` as a QR image.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/api/pair_test.go`:

```go
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type stubPairer struct {
	code      string
	expiresAt time.Time
	pairing   bool
	connected bool
}

func (s stubPairer) Connected() bool { return s.connected }
func (s stubPairer) PairingCode() (string, time.Time, bool) {
	return s.code, s.expiresAt, s.pairing
}

func TestPairRequiresAToken(t *testing.T) {
	h, _, _ := testHandlerWithConnection(t, stubPairer{})
	req := httptest.NewRequest(http.MethodGet, "/v1/pair", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("the QR is a credential and must not be public: got %d", rec.Code)
	}
}

func TestPairServesTheLiveCode(t *testing.T) {
	exp := time.Now().Add(30 * time.Second).UTC().Truncate(time.Second)
	h, _, _ := testHandlerWithConnection(t, stubPairer{code: "2@abc", expiresAt: exp, pairing: true})

	rec := get(h, "/v1/pair", "tok-operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["pairing"] != true || out["code"] != "2@abc" {
		t.Fatalf("live code not served: %v", out)
	}
}

func TestPairOmitsTheCodeWhenNotPairing(t *testing.T) {
	h, _, _ := testHandlerWithConnection(t, stubPairer{connected: true})
	rec := get(h, "/v1/pair", "tok-operator")

	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["pairing"] != false {
		t.Fatalf("want pairing false, got %v", out["pairing"])
	}
	if c, ok := out["code"]; ok && c != "" {
		t.Fatalf("a non-pairing bridge must not emit a code: %v", c)
	}
	if out["connected"] != true {
		t.Fatalf("want connected true, got %v", out["connected"])
	}
}
```

You will need two small helpers. Check whether `api`'s existing test files already provide a `get(handler, path, token)` and a way to build a handler with a custom `Connection`; the send/admin tests build handlers already. **Reuse them if they exist** — do not define a second `testHandler`. If they do not, add:

```go
func get(h http.Handler, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
```

and a `testHandlerWithConnection(t, conn ConnectionState)` mirroring the existing `testHandler` but setting `Deps.Connection`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./api/... -run Pair
```
Expected: FAIL — the route 404s, and `stubPairer` does not satisfy `ConnectionState`.

- [ ] **Step 3: Extend the ConnectionState interface**

In `api/server.go`, extend the interface (the doc comment above it explains why it is supplied after construction — keep that):

```go
type ConnectionState interface {
	Connected() bool
	// PairingCode returns the live QR payload while a pairing is in flight.
	// It is a credential: the handler serves it only to an authenticated
	// caller and never logs it.
	PairingCode() (code string, expiresAt time.Time, pairing bool)
}
```

Every existing implementer must gain the method. In production that is `main.go`'s `clientHolder`; in tests it is whatever fakes already satisfy `ConnectionState`. Find them with:

```bash
grep -rn "Connected() bool" services/wa-agent-bridge --include=*.go
```

For `clientHolder`, delegate to the client and fail closed when unset:

```go
func (h *clientHolder) PairingCode() (string, time.Time, bool) {
	c := h.ptr.Load()
	if c == nil {
		return "", time.Time{}, false
	}
	return c.PairingCode()
}
```

- [ ] **Step 4: Write the handler**

Create `services/wa-agent-bridge/api/pair.go`:

```go
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
```

- [ ] **Step 5: Register the route**

In `api/server.go`, beside the other routes (~line 135). The handler must also
call `requireAdmin` — `s.authed` alone only proves the caller holds *a* token,
and the QR is a write-grade credential that a send token must not reach:

```go
	mux.HandleFunc("GET /v1/pair", s.authed(s.handlePair))
```

- [ ] **Step 6: Run tests**

```bash
cd services/wa-agent-bridge && gofmt -l . && go vet ./... && go test ./... -race -count=2
```
Expected: clean, all packages PASS.

- [ ] **Step 7: Deliberate-break verification**

1. Register the route without `s.authed` → `TestPairRequiresAToken` must fail.
2. Always populate `code` regardless of `pairing` → `TestPairOmitsTheCodeWhenNotPairing` must fail.

Report both results.

- [ ] **Step 8: Commit**

```bash
git add services/wa-agent-bridge/api/pair.go services/wa-agent-bridge/api/pair_test.go services/wa-agent-bridge/api/server.go services/wa-agent-bridge/main.go
git commit -m "Serve the pairing QR to an authenticated caller"
```

---

## Task 3: Templated systemd unit

**Files:**
- Create: `services/wa-agent-bridge/deploy/wa-agent-bridge@.service`
- Modify: `services/wa-agent-bridge/README.md` (a short section on running N instances)

**Interfaces:**
- Consumes: nothing.
- Produces: a unit startable as `systemctl --user start wa-agent-bridge@<instance>`, reading `/opt/wa-agent-bridge/<instance>/.env`. Task 5's provisioner writes exactly that path.

- [ ] **Step 1: Write the templated unit**

Copy `deploy/wa-agent-bridge.service` to `deploy/wa-agent-bridge@.service` and change only the instance-dependent lines. `%i` is systemd's instance name.

```ini
WorkingDirectory=/opt/wa-agent-bridge/%i
EnvironmentFile=/opt/wa-agent-bridge/%i/.env
ExecStart=/opt/wa-agent-bridge/bin/wa-agent-bridge
StandardOutput=append:/opt/wa-agent-bridge/%i/bridge.log
StandardError=append:/opt/wa-agent-bridge/%i/bridge.log
ReadWritePaths=/opt/wa-agent-bridge/%i
```

Note the binary moves to a shared `bin/` — every instance runs the same build; only config differs.

**Keep `StartLimitBurst=5` and `StartLimitIntervalSec=600` in the `[Unit]` section, and keep `Restart=on-failure` with its comment.** They are ignored in `[Service]` on current systemd, and without them a failing connect retries forever against WhatsApp — the exact behaviour the code refuses to perform. That comment exists to stop a later reader "fixing" this by deleting `Restart=`.

Keep the single-instance unit in place: it is what phase 1's runbook documents and what the soak will use.

- [ ] **Step 2: Verify it parses**

```bash
systemd-analyze verify services/wa-agent-bridge/deploy/wa-agent-bridge@.service 2>&1 | head
```
Expected: no errors about the unit's own syntax. (Warnings about `ExecStart` not existing on this machine are fine.) If `systemd-analyze` is unavailable, say so rather than claiming it verified.

- [ ] **Step 3: Document running N instances**

Add a short section to `services/wa-agent-bridge/README.md` after the pairing material: each instance gets `/opt/wa-agent-bridge/<instance>/` holding `.env`, `session/` and the SQLite file; `LISTEN_ADDR` differs per instance; the binary is shared at `/opt/wa-agent-bridge/bin/`. State plainly that **two instances must never share a `DB_PATH`** — the cap serialisation is a process-local lock, so a shared database silently unserialises it.

- [ ] **Step 4: Commit**

```bash
git add services/wa-agent-bridge/deploy/wa-agent-bridge@.service services/wa-agent-bridge/README.md
git commit -m "Add a templated unit so one bridge per number is a config change"
```

---

## Task 4: Manager module, store schema, and the events log

**Files:**
- Create: `services/wa-manager/go.mod`, `store/sqlite.go`, `store/requires_cgo.go`
- Test: `services/wa-manager/store/sqlite_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `store.Open(path string) (*Store, error)`; `(*Store).Close() error`; the `Tenant` struct below; `(*Store).CreateTenant`, `GetTenant`, `ListTenants`, `SetTenantState`, `DeleteTenant`, `AppendEvent`, `ListEvents`. Tasks 5–8 consume these exact names.

- [ ] **Step 1: Write the failing test**

Create `services/wa-manager/store/sqlite_test.go`:

```go
package store

import (
	"path/filepath"
	"testing"
	"time"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "mgr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestTenantRoundTripSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mgr.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateTenant(Tenant{
		ID: "t1", DisplayName: "Blitz Fibre", Instance: "blitz", Port: 33101,
		State: StateProvisioned, CreatedAt: time.Unix(1000, 0),
	}); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()

	got, err := s2.GetTenant("t1")
	if err != nil {
		t.Fatal(err)
	}
	if got.DisplayName != "Blitz Fibre" || got.Port != 33101 || got.State != StateProvisioned {
		t.Fatalf("tenant did not survive reopen: %+v", got)
	}
}

func TestTenantIDIsUnique(t *testing.T) {
	s := openTemp(t)
	base := Tenant{ID: "t1", Instance: "a", Port: 1, State: StateProvisioned}
	if err := s.CreateTenant(base); err != nil {
		t.Fatal(err)
	}
	dup := base
	dup.Instance, dup.Port = "b", 2
	if err := s.CreateTenant(dup); err == nil {
		t.Fatal("a duplicate tenant id must be refused, not silently overwrite")
	}
}

func TestEventsAreAppendOnlyAndOrdered(t *testing.T) {
	s := openTemp(t)
	s.CreateTenant(Tenant{ID: "t1", Instance: "a", Port: 1, State: StateProvisioned})

	s.AppendEvent("t1", "provisioned", "port 1")
	s.AppendEvent("t1", "paired", "")
	s.AppendEvent("t1", "logged_out", "banned or unlinked")

	evts, err := s.ListEvents("t1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evts) != 3 {
		t.Fatalf("want 3 events, got %d", len(evts))
	}
	// Newest first: an operator opening a dead number wants the cause at the top.
	if evts[0].Kind != "logged_out" {
		t.Fatalf("want newest first, got %q", evts[0].Kind)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-manager && go test ./store/...
```
Expected: FAIL — no such package.

- [ ] **Step 3: Create the module and the cgo guard**

`services/wa-manager/go.mod`:

```
module github.com/Heinvv10/CrestaHQ/services/wa-manager

go 1.26.0
```

Then `go get github.com/mattn/go-sqlite3@v1.14.49` and `go mod tidy`.

`services/wa-manager/store/requires_cgo.go` — copy the shape of the bridge's guard so a `CGO_ENABLED=0` build fails loudly at compile time instead of producing a binary that cannot open its own store:

```go
//go:build !cgo

package store

// go-sqlite3 is a cgo package. Built with CGO_ENABLED=0 it compiles to a stub
// that fails only at RUNTIME, so the binary looks fine and cannot open its
// database. Referencing an undefined symbol turns that into a build error.
const _ = waManagerRequiresCGO_ENABLED_1_becauseGoSqlite3IsACgoPackage
```

- [ ] **Step 4: Write the store**

Create `services/wa-manager/store/sqlite.go`:

```go
// Package store persists the manager's own state: which tenants exist, which
// port each was allocated, and an append-only log of what happened to them.
//
// It holds NO message content. The manager is a supervisor and a view; it has
// even less reason than the bridge to see a message body, and the same POPIA
// constraint applies.
package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type State string

const (
	StateProvisioned State = "provisioned"
	StatePairing     State = "pairing"
	StateRunning     State = "running"
	StateLoggedOut   State = "logged_out"
	StateStopped     State = "stopped"
)

// Tenant is one WhatsApp number and the bridge instance that serves it.
//
// ID is OPAQUE — the manager deliberately does not know what a LeadStack
// sub-account is, so that a second consumer (a GHL listing, say) is a consumer
// rather than a rewrite.
type Tenant struct {
	ID          string
	DisplayName string
	Instance    string // systemd instance name, e.g. "blitz"
	Port        int
	State       State
	Phone       string // filled once paired; empty before
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type Event struct {
	Kind   string
	Detail string
	At     time.Time
}

type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  instance     TEXT NOT NULL UNIQUE,
  port         INTEGER NOT NULL UNIQUE,
  state        TEXT NOT NULL,
  phone        TEXT NOT NULL DEFAULT '',
  created_unix INTEGER NOT NULL,
  updated_unix INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  at_unix   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id, id DESC);
`

func Open(path string) (*Store, error) {
	// synchronous=FULL for the same reason the bridge uses it: a power loss
	// that loses the last write here loses a port allocation or a tenant, and
	// a tenant whose row vanished still has a running unit on disk.
	db, err := sql.Open("sqlite3", path+"?_busy_timeout=5000&_journal_mode=WAL&_synchronous=FULL")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) CreateTenant(t Tenant) error {
	now := t.CreatedAt
	if now.IsZero() {
		now = time.Now()
	}
	_, err := s.db.Exec(
		`INSERT INTO tenants (id, display_name, instance, port, state, phone, created_unix, updated_unix)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.DisplayName, t.Instance, t.Port, string(t.State), t.Phone, now.Unix(), now.Unix())
	return err
}

func (s *Store) GetTenant(id string) (Tenant, error) {
	var t Tenant
	var created, updated int64
	var state string
	err := s.db.QueryRow(
		`SELECT id, display_name, instance, port, state, phone, created_unix, updated_unix
		 FROM tenants WHERE id = ?`, id).
		Scan(&t.ID, &t.DisplayName, &t.Instance, &t.Port, &state, &t.Phone, &created, &updated)
	if err != nil {
		return Tenant{}, err
	}
	t.State = State(state)
	t.CreatedAt, t.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
	return t, nil
}

func (s *Store) ListTenants() ([]Tenant, error) {
	rows, err := s.db.Query(
		`SELECT id, display_name, instance, port, state, phone, created_unix, updated_unix
		 FROM tenants ORDER BY display_name, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Tenant
	for rows.Next() {
		var t Tenant
		var created, updated int64
		var state string
		if err := rows.Scan(&t.ID, &t.DisplayName, &t.Instance, &t.Port, &state,
			&t.Phone, &created, &updated); err != nil {
			return nil, err
		}
		t.State = State(state)
		t.CreatedAt, t.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) SetTenantState(id string, st State, phone string) error {
	res, err := s.db.Exec(
		`UPDATE tenants SET state = ?, phone = CASE WHEN ? != '' THEN ? ELSE phone END,
		 updated_unix = ? WHERE id = ?`,
		string(st), phone, phone, time.Now().Unix(), id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("store: no tenant %q", id)
	}
	return nil
}

func (s *Store) DeleteTenant(id string) error {
	_, err := s.db.Exec(`DELETE FROM tenants WHERE id = ?`, id)
	return err
}

func (s *Store) AppendEvent(tenantID, kind, detail string) error {
	_, err := s.db.Exec(
		`INSERT INTO events (tenant_id, kind, detail, at_unix) VALUES (?, ?, ?, ?)`,
		tenantID, kind, detail, time.Now().Unix())
	return err
}

// ListEvents returns the most recent events first — an operator opening a dead
// number wants the cause at the top, not the provisioning record.
func (s *Store) ListEvents(tenantID string, limit int) ([]Event, error) {
	rows, err := s.db.Query(
		`SELECT kind, detail, at_unix FROM events WHERE tenant_id = ?
		 ORDER BY id DESC LIMIT ?`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Event
	for rows.Next() {
		var e Event
		var at int64
		if err := rows.Scan(&e.Kind, &e.Detail, &at); err != nil {
			return nil, err
		}
		e.At = time.Unix(at, 0)
		out = append(out, e)
	}
	return out, rows.Err()
}
```

- [ ] **Step 5: Run tests**

```bash
cd services/wa-manager && gofmt -l . && go vet ./... && go test ./store/... -race -count=2
```
Expected: PASS. Also confirm `CGO_ENABLED=0 go build ./...` FAILS.

- [ ] **Step 6: Deliberate-break verification**

1. Drop `UNIQUE` from `tenants.id` (make it a plain column with a separate rowid PK) → `TestTenantIDIsUnique` must fail.
2. Change `ListEvents` to `ORDER BY id ASC` → `TestEventsAreAppendOnlyAndOrdered` must fail.

Report both.

- [ ] **Step 7: Commit**

```bash
git add services/wa-manager
git commit -m "Add the manager's own store: tenants, and why a number died"
```

---

## Task 5: Atomic port allocation

**Files:**
- Create: `services/wa-manager/store/ports.go`
- Test: `services/wa-manager/store/ports_test.go`

**Interfaces:**
- Consumes: `*Store` from Task 4.
- Produces: `(*Store).AllocatePort(tenantID string, base, count int) (int, error)` and `(*Store).ReleasePort(tenantID string) error`. Task 6's provisioner calls `AllocatePort` before writing any files.

- [ ] **Step 1: Write the failing test**

Create `services/wa-manager/store/ports_test.go`:

```go
package store

import (
	"runtime"
	"sync"
	"testing"
)

func TestAllocatePortIsUniquePerTenant(t *testing.T) {
	s := openTemp(t)
	a, err := s.AllocatePort("t1", 33100, 10)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.AllocatePort("t2", 33100, 10)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatalf("two tenants got the same port: %d", a)
	}
}

func TestAllocatePortIsIdempotentForOneTenant(t *testing.T) {
	s := openTemp(t)
	a, _ := s.AllocatePort("t1", 33100, 10)
	b, err := s.AllocatePort("t1", 33100, 10)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("re-allocating for one tenant moved its port %d -> %d", a, b)
	}
}

func TestAllocatePortExhaustionIsAnError(t *testing.T) {
	s := openTemp(t)
	for i := 0; i < 3; i++ {
		if _, err := s.AllocatePort(string(rune('a'+i)), 33100, 3); err != nil {
			t.Fatalf("allocation %d failed early: %v", i, err)
		}
	}
	if _, err := s.AllocatePort("overflow", 33100, 3); err == nil {
		t.Fatal("exhausting the range must be a loud error, not a silent reuse")
	}
}

// Concurrent provisioning must never hand two tenants the same port. A single
// round of goroutines does not reliably contend — three phase-1 tests passed
// under the exact bugs they targeted for that reason — so this uses a ready
// barrier and many rounds, and is worth running at GOMAXPROCS=1 too.
func TestAllocatePortIsAtomicUnderConcurrency(t *testing.T) {
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(4))

	const rounds, workers = 30, 16
	for r := 0; r < rounds; r++ {
		s := openTemp(t)
		var ready, done sync.WaitGroup
		start := make(chan struct{})
		ready.Add(workers)
		done.Add(workers)

		got := make([]int, workers)
		errs := make([]error, workers)
		for i := 0; i < workers; i++ {
			go func(i int) {
				defer done.Done()
				ready.Done()
				<-start
				got[i], errs[i] = s.AllocatePort(string(rune('a'+i)), 33100, workers)
			}(i)
		}
		ready.Wait()
		close(start)
		done.Wait()

		seen := map[int]int{}
		for i, p := range got {
			if errs[i] != nil {
				t.Fatalf("round %d worker %d: %v", r, i, errs[i])
			}
			if prev, dup := seen[p]; dup {
				t.Fatalf("round %d: port %d given to workers %d and %d", r, p, prev, i)
			}
			seen[p] = i
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-manager && go test ./store/... -run Port
```
Expected: FAIL — `AllocatePort undefined`.

- [ ] **Step 3: Write the implementation**

Create `services/wa-manager/store/ports.go`:

```go
package store

import (
	"database/sql"
	"fmt"
)

// AllocatePort assigns the lowest free port in [base, base+count) to tenantID
// and returns it. Re-allocating for a tenant that already holds one returns the
// same port rather than moving it — provisioning is retried after partial
// failures, and a retry that moved the port would orphan a running unit.
//
// Atomicity comes from the UNIQUE constraint on tenants.port, not from a lock:
// each candidate is an INSERT that either wins or violates the constraint, so
// two concurrent provisioners cannot both take one port however they interleave.
func (s *Store) AllocatePort(tenantID string, base, count int) (int, error) {
	var existing int
	err := s.db.QueryRow(`SELECT port FROM tenants WHERE id = ?`, tenantID).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}

	for p := base; p < base+count; p++ {
		res, err := s.db.Exec(
			`INSERT OR IGNORE INTO tenants (id, instance, port, state, created_unix, updated_unix)
			 VALUES (?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))`,
			tenantID, tenantID, p, string(StateProvisioned))
		if err != nil {
			return 0, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, err
		}
		if n == 1 {
			return p, nil
		}
	}
	return 0, fmt.Errorf("store: no free port in [%d,%d)", base, base+count)
}

// ReleasePort frees a tenant's port by removing its row. Teardown must call
// this LAST, after the unit is stopped and its files are gone: a freed port
// that a live process still holds would be handed to the next tenant, whose
// bridge would then fail to bind.
func (s *Store) ReleasePort(tenantID string) error {
	return s.DeleteTenant(tenantID)
}
```

Note this makes `AllocatePort` the row's creator. Task 6's provisioner therefore calls `AllocatePort` **first**, then fills in `display_name` and `instance` via a follow-up update — it must not call `CreateTenant` for a tenant that already has an allocated port.

- [ ] **Step 4: Run tests**

```bash
cd services/wa-manager && go test ./store/... -race -count=2
GOMAXPROCS=1 go test ./store/... -race -run Concurrency -count=3
```
Expected: PASS at both settings.

- [ ] **Step 5: Deliberate-break verification**

1. Replace the `INSERT OR IGNORE` + `RowsAffected` election with a `SELECT` for a free port followed by a separate `INSERT` → `TestAllocatePortIsAtomicUnderConcurrency` must fail. **Report the round it failed on and the GOMAXPROCS setting.** If it does NOT fail, the test does not bite — say so and strengthen it before moving on.
2. Remove the early "tenant already has a port" return → `TestAllocatePortIsIdempotentForOneTenant` must fail.

- [ ] **Step 6: Commit**

```bash
git add services/wa-manager/store
git commit -m "Allocate ports through a unique constraint, not a lock"
```

---

## Task 6: systemd driver behind an interface

**Files:**
- Create: `services/wa-manager/systemd/unit.go`, `services/wa-manager/systemd/fake_test.go`
- Test: `services/wa-manager/systemd/unit_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Controller interface { Enable(instance string) error; Start(instance string) error; Stop(instance string) error; Disable(instance string) error; IsActive(instance string) (bool, error) }`, plus `systemd.New(unit string) Controller` returning the real `systemctl --user` driver. Task 7's provisioner takes a `Controller`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-manager/systemd/unit_test.go`:

```go
package systemd

import (
	"strings"
	"testing"
)

func TestCommandsTargetTheTemplatedInstance(t *testing.T) {
	var got []string
	c := &systemctl{unit: "wa-agent-bridge", run: func(args ...string) (string, error) {
		got = append(got, strings.Join(args, " "))
		return "", nil
	}}

	c.Enable("blitz")
	c.Start("blitz")
	c.Stop("blitz")
	c.Disable("blitz")

	want := []string{
		"--user enable wa-agent-bridge@blitz",
		"--user start wa-agent-bridge@blitz",
		"--user stop wa-agent-bridge@blitz",
		"--user disable wa-agent-bridge@blitz",
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("step %d: want %q, got %q", i, want[i], got[i])
		}
	}
}

func TestInstanceNamesAreRefusedIfTheyCouldEscapeTheUnit(t *testing.T) {
	c := &systemctl{unit: "wa-agent-bridge", run: func(args ...string) (string, error) {
		t.Fatalf("a rejected instance name must never reach systemctl: %v", args)
		return "", nil
	}}
	for _, bad := range []string{"", "a b", "../etc", "a@b", "a/b", "a;rm -rf /"} {
		if err := c.Start(bad); err == nil {
			t.Fatalf("instance name %q must be refused", bad)
		}
	}
}

func TestIsActiveReadsSystemctlOutput(t *testing.T) {
	c := &systemctl{unit: "u", run: func(...string) (string, error) { return "active\n", nil }}
	if ok, err := c.IsActive("x"); err != nil || !ok {
		t.Fatalf("want active, got %v %v", ok, err)
	}
	// systemctl exits non-zero for an inactive unit; that is not an error.
	c.run = func(...string) (string, error) { return "inactive\n", errExit }
	if ok, err := c.IsActive("x"); err != nil || ok {
		t.Fatalf("inactive must be (false, nil), got %v %v", ok, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-manager && go test ./systemd/...
```
Expected: FAIL — no such package.

- [ ] **Step 3: Write the driver**

Create `services/wa-manager/systemd/unit.go`:

```go
// Package systemd drives templated user units. It is an interface so the
// provisioner can be tested without a systemd on the machine — and so a test
// can never accidentally start a real unit.
package systemd

import (
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

var errExit = errors.New("systemctl exited non-zero")

type Controller interface {
	Enable(instance string) error
	Start(instance string) error
	Stop(instance string) error
	Disable(instance string) error
	IsActive(instance string) (bool, error)
}

// safeInstance is deliberately strict. The instance name is interpolated into a
// unit name and into filesystem paths the provisioner writes, so anything that
// could traverse a directory or address a different unit is refused. This is
// the manager's sharpest edge: it runs privileged-ish work on behalf of a
// caller, and the instance name is the caller's input.
var safeInstance = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

func Validate(instance string) error {
	if !safeInstance.MatchString(instance) {
		return fmt.Errorf("systemd: unsafe instance name %q", instance)
	}
	return nil
}

type systemctl struct {
	unit string
	run  func(args ...string) (string, error)
}

func New(unit string) Controller {
	return &systemctl{unit: unit, run: func(args ...string) (string, error) {
		out, err := exec.Command("systemctl", args...).CombinedOutput()
		if err != nil {
			return string(out), errExit
		}
		return string(out), nil
	}}
}

func (c *systemctl) verb(v, instance string) error {
	if err := Validate(instance); err != nil {
		return err
	}
	out, err := c.run("--user", v, c.unit+"@"+instance)
	if err != nil {
		return fmt.Errorf("systemd: %s %s@%s: %s", v, c.unit, instance, strings.TrimSpace(out))
	}
	return nil
}

func (c *systemctl) Enable(i string) error  { return c.verb("enable", i) }
func (c *systemctl) Start(i string) error   { return c.verb("start", i) }
func (c *systemctl) Stop(i string) error    { return c.verb("stop", i) }
func (c *systemctl) Disable(i string) error { return c.verb("disable", i) }

// IsActive treats a non-zero exit as "not active" rather than an error:
// `systemctl is-active` exits 3 for an inactive unit, which is an answer, not a
// failure.
func (c *systemctl) IsActive(instance string) (bool, error) {
	if err := Validate(instance); err != nil {
		return false, err
	}
	out, _ := c.run("--user", "is-active", c.unit+"@"+instance)
	return strings.TrimSpace(out) == "active", nil
}
```

Create `services/wa-manager/systemd/fake_test.go` with a fake implementing `Controller` for this package's own tests — in a `_test.go` file so it cannot compile into a shipped binary (phase 1 shipped its `wa/fake.go` into the binary and had to move it).

**Note for Task 7:** a type declared in `systemd/fake_test.go` is visible only to this package's tests, so `provision`'s tests cannot import it. That is correct Go, not a limitation to work around by promoting the fake into a shipped file. Task 7 declares its own fake against the same interface, which is the idiomatic pattern — each package fakes what it consumes.

- [ ] **Step 4: Run tests**

```bash
cd services/wa-manager && go test ./systemd/... -race -count=2
```
Expected: PASS.

- [ ] **Step 5: Deliberate-break verification**

1. Loosen `safeInstance` to `.*` → `TestInstanceNamesAreRefusedIfTheyCouldEscapeTheUnit` must fail.
2. Make `IsActive` return the run error → its test must fail on the inactive case.

- [ ] **Step 6: Commit**

```bash
git add services/wa-manager/systemd
git commit -m "Drive templated units, and refuse an instance name that could escape one"
```

---

## Task 7: Provisioning

**Files:**
- Create: `services/wa-manager/provision/provision.go`
- Test: `services/wa-manager/provision/provision_test.go`

**Interfaces:**
- Consumes: `*store.Store` (Tasks 4–5), `systemd.Controller` (Task 6).
- Produces: `provision.New(st *store.Store, sc systemd.Controller, opts Opts) *Provisioner`; `(*Provisioner).Create(tenantID, displayName string) (store.Tenant, error)`; `(*Provisioner).Destroy(tenantID string) error`. `Opts` is `{Root string; PortBase, PortCount int; AppToken, ManagerToken func() string}`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-manager/provision/provision_test.go`:

```go
package provision

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// fakeCtl is declared HERE rather than imported from the systemd package: a
// fake in systemd/fake_test.go is visible only to that package's own tests, and
// promoting it into a shipped file so this package could import it would put a
// test double in the binary — the exact defect phase 1 had to correct.
type fakeCtl struct {
	mu                                   sync.Mutex
	enabled, started, stopped, disabled  map[string]bool
	FailStart                            bool
}

func newFakeCtl() *fakeCtl {
	return &fakeCtl{
		enabled: map[string]bool{}, started: map[string]bool{},
		stopped: map[string]bool{}, disabled: map[string]bool{},
	}
}

func (f *fakeCtl) mark(m map[string]bool, i string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m[i] = true
	return nil
}
func (f *fakeCtl) Enable(i string) error  { return f.mark(f.enabled, i) }
func (f *fakeCtl) Stop(i string) error    { return f.mark(f.stopped, i) }
func (f *fakeCtl) Disable(i string) error { return f.mark(f.disabled, i) }
func (f *fakeCtl) Start(i string) error {
	if f.FailStart {
		return errors.New("fake: start refused")
	}
	return f.mark(f.started, i)
}
func (f *fakeCtl) IsActive(i string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.started[i] && !f.stopped[i], nil
}
func (f *fakeCtl) did(m map[string]bool, i string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return m[i]
}
func (f *fakeCtl) Enabled(i string) bool  { return f.did(f.enabled, i) }
func (f *fakeCtl) Started(i string) bool  { return f.did(f.started, i) }
func (f *fakeCtl) Stopped(i string) bool  { return f.did(f.stopped, i) }
func (f *fakeCtl) Disabled(i string) bool { return f.did(f.disabled, i) }

func newTestProvisioner(t *testing.T) (*Provisioner, *store.Store, *fakeCtl, string) {
	t.Helper()
	root := t.TempDir()
	st, err := store.Open(filepath.Join(root, "mgr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sc := newFakeCtl()
	p := New(st, sc, Opts{
		Root: root, PortBase: 33100, PortCount: 20,
		AppToken:     func() string { return "app-token" },
		ManagerToken: func() string { return "mgr-token" },
	})
	return p, st, sc, root
}

func TestCreateWritesAnInstanceAndStartsIt(t *testing.T) {
	p, _, sc, root := newTestProvisioner(t)

	ten, err := p.Create("t1", "Blitz Fibre")
	if err != nil {
		t.Fatal(err)
	}

	envPath := filepath.Join(root, ten.Instance, ".env")
	raw, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatalf("no .env written: %v", err)
	}
	env := string(raw)
	for _, want := range []string{
		"LISTEN_ADDR=127.0.0.1:33100",
		"DB_PATH=" + filepath.Join(root, ten.Instance, "bridge.db"),
		"SESSION_DIR=" + filepath.Join(root, ten.Instance, "session"),
		"app-token", "mgr-token",
	} {
		if !strings.Contains(env, want) {
			t.Fatalf(".env missing %q:\n%s", want, env)
		}
	}
	if !sc.Enabled(ten.Instance) || !sc.Started(ten.Instance) {
		t.Fatal("instance was written but never enabled and started")
	}
}

// A tenant that fails midway must leave nothing behind — no half-written
// instance dir, and above all no consumed port. Provisioning is retried, and a
// leaked port would exhaust the range one failure at a time.
func TestFailedCreateLeavesNoTenantAndFreesThePort(t *testing.T) {
	p, st, sc, root := newTestProvisioner(t)
	sc.FailStart = true

	if _, err := p.Create("t1", "Blitz"); err == nil {
		t.Fatal("a failed start must fail the whole Create")
	}
	if _, err := st.GetTenant("t1"); err == nil {
		t.Fatal("a failed Create left a tenant row behind")
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "t1") {
			t.Fatalf("a failed Create left an instance dir: %s", e.Name())
		}
	}

	// The port must be reusable immediately.
	sc.FailStart = false
	if _, err := p.Create("t1", "Blitz"); err != nil {
		t.Fatalf("retry after a failed Create must succeed: %v", err)
	}
}

func TestDestroyRemovesTheSessionData(t *testing.T) {
	p, st, sc, root := newTestProvisioner(t)
	ten, _ := p.Create("t1", "Blitz")
	dir := filepath.Join(root, ten.Instance)

	if err := p.Destroy("t1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("a cancelled tenant's WhatsApp session must not survive on disk")
	}
	if !sc.Stopped(ten.Instance) || !sc.Disabled(ten.Instance) {
		t.Fatal("Destroy left the unit enabled")
	}
	if _, err := st.GetTenant("t1"); err == nil {
		t.Fatal("Destroy left the tenant row")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-manager && go test ./provision/...
```
Expected: FAIL — no such package.

- [ ] **Step 3: Write the provisioner**

Create `services/wa-manager/provision/provision.go`. Key requirements the code must satisfy:

- `Create` order: `Validate(instance)` → `AllocatePort` → `MkdirAll(root/instance/session)` → write `.env` with `0600` → `SetTenantState`/update display name → `Enable` → `Start`. Any failure after the port is allocated must unwind: stop and disable the unit if it got that far, `RemoveAll` the instance dir, and `ReleasePort`.
- The instance name is derived from the tenant id and **must** pass `systemd.Validate`. Lowercase it, replace anything outside `[a-z0-9-]` with `-`, and truncate to 63 characters.
- `.env` contents (each on its own line):

```
LISTEN_ADDR=127.0.0.1:<port>
DB_PATH=<root>/<instance>/bridge.db
SESSION_DIR=<root>/<instance>/session
QUIET_TZ=Africa/Johannesburg
CONSUMERS=app|<appToken>|<webhookURL>|100|500,manager|<managerToken>|||500|admin
```

The manager provisions **itself** as an admin consumer so it can read health and lift a kill switch after a re-pair; the app consumer is non-admin, so a compromised LeadStack token cannot allowlist a stranger or release the brakes. That asymmetry is deliberate — it mirrors phase 1's rule that anyone may stop sending and only an operator may resume.

Write `.env` with `os.WriteFile(path, data, 0o600)`: it holds bearer tokens.

- `Destroy` order: `Stop` → `Disable` → `RemoveAll(root/instance)` → `ReleasePort`. Port last, per the comment in Task 5 — freeing a port whose process is still bound hands it to the next tenant.

- [ ] **Step 4: Run tests**

```bash
cd services/wa-manager && gofmt -l . && go vet ./... && go test ./... -race -count=2
```
Expected: PASS.

- [ ] **Step 5: Deliberate-break verification**

1. Remove the unwind on a failed `Start` → `TestFailedCreateLeavesNoTenantAndFreesThePort` must fail.
2. Make `Destroy` skip `RemoveAll` → `TestDestroyRemovesTheSessionData` must fail.
3. Give the app consumer the `admin` flag → no test covers it. **Add one** asserting the app consumer is not admin and the manager consumer is; that asymmetry is a security property, not a detail.

- [ ] **Step 6: Commit**

```bash
git add services/wa-manager/provision
git commit -m "Provision an instance atomically, and leave nothing behind when it fails"
```

---

## Task 8: Health aggregation

**Files:**
- Create: `services/wa-manager/health/poll.go`
- Test: `services/wa-manager/health/poll_test.go`

**Interfaces:**
- Consumes: `store.Tenant` (Task 4).
- Produces: `health.Poller` with `Snapshot(ctx, tenants []store.Tenant) map[string]Report`, where `Report` is `{Reachable bool; Connected bool; Killed bool; Degraded bool; OutboundLast24h int; DailyCap int; LastInboundAgeSeconds *int; Problems []string; Err string}`. Task 9's handlers and Task 10's UI consume this.

- [ ] **Step 1: Write the failing test**

Create `services/wa-manager/health/poll_test.go`:

```go
package health

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

func TestSnapshotReadsEachBridge(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"connected":true,"killed":false,
			"outboundLast24h":18,"dailyCap":150,"lastInboundAgeSeconds":360}`))
	}))
	defer srv.Close()

	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	got := p.Snapshot(context.Background(), []store.Tenant{{ID: "t1"}})
	r := got["t1"]
	if !r.Reachable || !r.Connected || r.OutboundLast24h != 18 || r.DailyCap != 150 {
		t.Fatalf("bad report: %+v", r)
	}
	if r.LastInboundAgeSeconds == nil || *r.LastInboundAgeSeconds != 360 {
		t.Fatalf("lastInboundAge not carried: %+v", r.LastInboundAgeSeconds)
	}
}

// A bridge that is down must read as UNREACHABLE, never as healthy-with-zeros.
// The whole point of this view is catching a number that has quietly died.
func TestUnreachableBridgeIsNotReportedHealthy(t *testing.T) {
	p := New(&http.Client{Timeout: 100 * time.Millisecond},
		func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return "http://127.0.0.1:1" }

	r := p.Snapshot(context.Background(), []store.Tenant{{ID: "t1"}})["t1"]
	if r.Reachable || r.Connected {
		t.Fatalf("a dead bridge reported reachable/connected: %+v", r)
	}
	if r.Err == "" {
		t.Fatal("an unreachable bridge must carry the reason")
	}
}

func TestDegradedBridgeIsCarriedThrough(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"ok":false,"degraded":true,"connected":false,
			"problems":["whatsapp socket is not connected"]}`))
	}))
	defer srv.Close()

	p := New(srv.Client(), func(store.Tenant) string { return "tok" })
	p.BaseURL = func(store.Tenant) string { return srv.URL }

	r := p.Snapshot(context.Background(), []store.Tenant{{ID: "t1"}})["t1"]
	if !r.Reachable {
		t.Fatal("a 503 is an answer, not an unreachable bridge")
	}
	if !r.Degraded || r.Connected || len(r.Problems) != 1 {
		t.Fatalf("degraded detail lost: %+v", r)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-manager && go test ./health/...
```
Expected: FAIL — no such package.

- [ ] **Step 3: Write the poller**

Create `services/wa-manager/health/poll.go`. Requirements:

- Poll tenants concurrently with a bounded worker count, `wg.Add` before each `go`, and a per-request timeout from the passed `*http.Client`.
- `GET <baseURL>/v1/health` with `Authorization: Bearer <token(tenant)>`.
- **A 503 is an answer, not a failure**: `Reachable` is true whenever an HTTP response arrived, whatever its status. Only a transport error sets `Reachable=false`, and then `Err` carries the reason. This mirrors the monitor script's rule — conflating "degraded" with "unreachable" reports the wrong cause at the worst moment.
- Default `BaseURL` to `http://127.0.0.1:<tenant.Port>`; it is a field so tests can point elsewhere.
- Never log a token or a URL containing one.

- [ ] **Step 4: Run tests**

```bash
cd services/wa-manager && go test ./health/... -race -count=2
```
Expected: PASS.

- [ ] **Step 5: Reconcile observed health into tenant state**

The design doc's lifecycle (§3.2) has a `logged_out` state, but polling alone never writes it — a banned number would show a red card forever while its stored state still said `running`, and the events log would carry no record of when it died.

Add to this package:

```go
// Reconcile writes what the poll observed back into tenant state, and records
// the transition once. A bridge whose kill switch is set and whose socket is
// down has been logged out — banned, or unlinked from the phone — and that is
// the moment an operator needs dated, not inferred later from a red card.
//
// Transitions are recorded only on CHANGE. Polling runs continuously; an event
// per poll would bury the one line that matters under thousands of duplicates.
func Reconcile(st *store.Store, tenants []store.Tenant, reports map[string]Report) error
```

Rules it must implement:
- `Reachable && Connected` → `StateRunning`.
- `Reachable && Killed && !Connected` → `StateLoggedOut`, appending a `logged_out` event **only if the stored state was not already `logged_out`**.
- `!Reachable` → leave the state alone. A manager that cannot reach a bridge does not know the number is dead; it knows it cannot see it. Overwriting state on unreachability would mark every number logged-out during a manager restart.

Test all three, and specifically that a second identical poll appends no second event.

- [ ] **Step 6: Deliberate-break verification**

1. Treat a non-2xx status as a transport failure → `TestDegradedBridgeIsCarriedThrough` must fail.
2. Return a zero-valued `Report` on a transport error instead of setting `Err` → `TestUnreachableBridgeIsNotReportedHealthy` must fail.
3. Make `Reconcile` write state on `!Reachable` → its test must fail.
4. Drop the already-`logged_out` guard → the duplicate-event test must fail.

- [ ] **Step 7: Commit**

```bash
git add services/wa-manager/health
git commit -m "Aggregate bridge health, and date the moment a number died"
```

---

## Task 9: Manager HTTP API

**Files:**
- Create: `services/wa-manager/api/server.go`, `services/wa-manager/api/handlers.go`
- Test: `services/wa-manager/api/handlers_test.go`

**Interfaces:**
- Consumes: `*store.Store`, `*provision.Provisioner`, `health.Poller`.
- Produces: `api.New(deps Deps) http.Handler` with `Deps{Store, Provisioner, Poller, OperatorToken string, TenantToken func(tenantID string) string}`. Routes: `GET /api/tenants`, `POST /api/tenants`, `DELETE /api/tenants/{id}`, `GET /api/tenants/{id}/pair`, `POST /api/tenants/{id}/restart`.

- [ ] **Step 1: Write the failing test**

Cover, at minimum: every route refuses without the operator token (401); creating a tenant returns 201 and the allocated port; `GET .../pair` relays the bridge's `/v1/pair` body; a tenant id that is not safe as an instance name is refused with 400 and never reaches the provisioner; and `DELETE` calls `Destroy`.

Write these as table-driven tests against `httptest` fakes for the provisioner and poller — do not stand up a real bridge.

- [ ] **Step 2: Run to verify failure**

```bash
cd services/wa-manager && go test ./api/...
```
Expected: FAIL — no such package.

- [ ] **Step 3: Implement**

Mirror the bridge's `api` package conventions: a `server` struct holding `Deps`, an `authed` wrapper doing a constant-time token comparison (`subtle.ConstantTimeCompare`), `writeJSON`, and Go 1.22 route patterns (`mux.HandleFunc("GET /api/tenants", ...)`).

Two things this API must get right, both of them security properties rather than niceties:

- **The operator token is the only credential**, and it is checked in constant time. Note in a comment that timing is not unit-observable, so this property is code-review-only — phase 1 found exactly this when a deliberate break stayed green.
- **The pair relay must not leak the bridge's consumer token.** The manager calls the bridge with its own manager token and returns only the QR payload; it never proxies the caller's credentials through, and never logs the code.

- [ ] **Step 4: Run tests + gates**

```bash
cd services/wa-manager && gofmt -l . && go vet ./... && go test ./... -race -count=2
```

- [ ] **Step 5: Deliberate-break verification**

Break the auth wrapper on one route; break the instance-name validation so a traversing id reaches the provisioner. Both must go RED. Report what you saw.

- [ ] **Step 6: Commit**

```bash
git add services/wa-manager/api
git commit -m "Expose tenant lifecycle and pairing behind one operator token"
```

---

## Task 10: The numbers UI

**Files:**
- Create: `services/wa-manager/ui/templates/numbers.html`, `services/wa-manager/ui/render.go`
- Modify: `services/wa-manager/api/server.go` (mount `GET /` and `GET /tenants/{id}`)
- Test: `services/wa-manager/ui/render_test.go`

**Interfaces:**
- Consumes: `store.Tenant`, `health.Report`.
- Produces: server-rendered HTML. No build step, no JS framework; `html/template` and a `<meta http-equiv="refresh">` or a small inline `fetch` poll are sufficient.

- [ ] **Step 1: Write the failing test**

Assert the rendered card contains: the phone number once paired (not the label) — or the display name plus "not paired" before that; a single status line; `18 / 150` style volume against the cap; the last-inbound age; and the kill state. Assert it does **not** contain the QR payload or any token.

- [ ] **Step 2: Run to verify failure, then implement**

Render QR images server-side with `github.com/skip2/go-qrcode` as a PNG served from `GET /tenants/{id}/qr.png` (authenticated, `Cache-Control: no-store`). Do not put the QR payload in the HTML — it is a credential, and HTML lands in browser history, proxies and screenshots more readily than an image does.

The card content is specified in the design doc §5. Deliberately: **one** status line, not three. The competitor renders "Standby / [Not Connected] / Ready to launch" simultaneously and a user cannot tell what state they are in.

- [ ] **Step 3: Gates and commit**

```bash
cd services/wa-manager && gofmt -l . && go vet ./... && go test ./... -race -count=2
git add services/wa-manager/ui services/wa-manager/api
git commit -m "Show whether each number is safe, not just that messages moved"
```

---

## Task 11: Wire main, CI, and the runbook

**Files:**
- Create: `services/wa-manager/main.go`, `services/wa-manager/deploy/wa-manager.service`, `services/wa-manager/README.md`, `.github/workflows/wa-manager.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: a runnable binary.

- [ ] **Step 1: Write main.go — wiring only, under 150 lines**

Config from the environment, matching the bridge's style: `LISTEN_ADDR` (loopback/CGNAT enforced — copy the bridge's `config/bind.go` check rather than reimplementing it), `DB_PATH`, `INSTANCE_ROOT`, `PORT_BASE`, `PORT_COUNT`, `OPERATOR_TOKEN`, `UNIT_NAME`.

Refuse to start with an empty `OPERATOR_TOKEN`. An unauthenticated manager writes `.env` files and starts units — that is remote code execution, and it must not be reachable by forgetting a variable.

- [ ] **Step 2: CI**

Copy `.github/workflows/wa-agent-bridge.yml` and change the paths filter to `services/wa-manager/**`. Keep `CGO_ENABLED: 1`, keep the step that asserts `CGO_ENABLED=0 go build` **fails**, keep `gofmt -l` as a real gate. Do not add it to `pnpm ci:check`.

- [ ] **Step 3: README**

Cover: what the manager is and is not (a supervisor and a view; **not** in the message path), the env table, provisioning a tenant, pairing, what a `logged_out` state means and how an operator re-pairs, and teardown. State plainly that two bridge instances must never share a `DB_PATH`.

- [ ] **Step 4: Verify by running it**

Build and start the manager with a temp root, create a tenant against a **fake** systemd controller, and confirm: the instance dir and `.env` appear with mode `0600`; `GET /api/tenants` lists it; an unauthenticated request is refused. Report what you verified by execution versus by reading — this technique caught a real README bug in phase 1 that no test did.

- [ ] **Step 5: Commit**

```bash
git add services/wa-manager .github/workflows/wa-manager.yml
git commit -m "Wire the manager binary, its CI and its runbook"
```

---

## Definition of done

- [ ] `gofmt -l .`, `go vet ./...`, `go test ./... -race -count=2`, `go build ./...` clean in **both** services.
- [ ] `CGO_ENABLED=0 go build ./...` FAILS in both.
- [ ] `pnpm ci:check` still clean at the repo root (this plan touches no TypeScript).
- [ ] Every deliberate-break result recorded in the PR description, including any that did **not** go red.
- [ ] Blind `/review` dispatched and its findings addressed.

## Deliberately not in this plan

Named so a reader does not mistake absence for oversight:

- **Pushing a ban outward to the customer.** Design §2.4 requires the event reach them automatically rather than waiting for a complaint. Plan A detects it (Task 8's `Reconcile`) and shows it (Task 10), but the webhook to LeadStack and the resulting in-app banner and email are Plan B — they need LeadStack's notification surfaces, which this service does not know about.
- **The LeadStack integration itself** — the connection doc, the three stub `bridge` arms in `send-dispatch.ts` / `readiness.ts` / `template-dispatch.ts`, the inbound webhook receiver, and the signed link-in. All Plan B, written once this service exists so it is planned against something real.
- **No new feature gate.** `whatsappEnabledByAgency` already exists and is already in `PLAN_GATE_KEYS`, so the capability is already sellable. Adding a gate would be duplicate machinery.
- **Multi-host.** One box holds a few hundred numbers. Beyond that the port registry becomes a scheduler and `BaseURL` stops being loopback — a different design, not an extension of this one.
- **Number sourcing.** BYO SIM.

## The gate this plan does not remove

**The soak has still not happened.** No number has yet survived a pair-restart-repair cycle. Phase 1's README carries the procedure; its third check — the consumer receives **zero** deliveries for pre-restart messages — is the one that catches the failure nothing in either service can prove is absent.

Run it before any of this is pointed at a customer's number. If it fails, this plan is void and the concept goes with it.
