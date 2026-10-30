# WhatsApp Agent Bridge (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `services/wa-agent-bridge`, a self-hosted Go service that pairs to a dedicated WhatsApp number, enforces nine ban-avoidance safety rails on every outbound message, and exposes it to Hermes as an agent control surface.

**Architecture:** A Go daemon using `whatsmeow` as a WhatsApp linked device. All safety logic lives in a pure `rails` package operating over `(request, state, clock)` with no network dependency, so every refusal is unit-testable offline. A thin `wa` package wraps the socket behind an interface a fake can implement. An HTTP API authenticates per-consumer bearer tokens and fans inbound messages out to registered consumer webhooks. State persists to local SQLite — no shared database, no network dependency beyond the internet.

**Tech Stack:** Go 1.26, `go.mau.fi/whatsmeow`, `github.com/mattn/go-sqlite3`, `github.com/mdp/qrterminal`, stdlib `net/http` and `testing`.

**Spec:** `docs/superpowers/specs/2026-09-04-whatsapp-bridge-rail-design.md`

## Global Constraints

- **Go 1.26.0** — matches the sibling bridge in `FF_Next.js/services/whatsapp-bridge/go.mod`.
- **Max 300 lines per file** (CLAUDE.md). The sibling bridge's 118 KB `main.go` is an anti-pattern; do not imitate it.
- **No `console.log`-equivalent debug prints; use the injected logger.** (CLAUDE.md zero-tolerance.)
- **Message bodies MUST NEVER be written to logs.** POPIA. Log JIDs, lengths, and message ids only.
- **Counters and dedup persist to SQLite, never memory only.** A rail that resets on restart turns a crash-loop into a send-loop.
- **Fail closed.** Any error evaluating a rail refuses the send; it never falls through to allow.
- **All time comparisons take an injected `time.Time`,** never `time.Now()` inside rail logic. Tests depend on this.
- **The Go service is NOT part of `pnpm ci:check`.** It gets its own CI job.
- **Default caps:** global 150 outbound/day; per-contact 10/day; max 3 consecutive outbound with no inbound between.
- **Module path:** `github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge`.
- **Package layout:** `rails/` (pure decisions), `store/` (SQLite), `wa/` (transport), `api/` (HTTP), `main.go` (wiring only, < 150 lines).

---

## File Structure

| Path | Responsibility |
|---|---|
| `services/wa-agent-bridge/go.mod` | Module definition |
| `services/wa-agent-bridge/main.go` | Wiring only: config load, construct store/rails/transport/api, signal handling |
| `services/wa-agent-bridge/config/config.go` | Env parsing into a typed `Config`; consumer registry |
| `services/wa-agent-bridge/rails/types.go` | `SendRequest`, `Decision`, `RefusalCode`, `Config`, `Store` interface |
| `services/wa-agent-bridge/rails/engine.go` | The ordered chain — the single `Evaluate` entry point |
| `services/wa-agent-bridge/rails/replyonly.go` | Rails 3 + 4 (reply-only, allowlist) |
| `services/wa-agent-bridge/rails/caps.go` | Rails 5 + 6 (per-contact, consecutive, global daily) |
| `services/wa-agent-bridge/rails/window.go` | Rails 1, 2, 8 (kill switch, consumer budget, quiet hours) |
| `services/wa-agent-bridge/rails/idempotency.go` | Rail 9 |
| `services/wa-agent-bridge/store/sqlite.go` | Schema + `Store` implementation |
| `services/wa-agent-bridge/store/memory.go` | In-memory `Store` for tests |
| `services/wa-agent-bridge/wa/transport.go` | `Transport` interface + `whatsmeow` implementation |
| `services/wa-agent-bridge/wa/fake.go` | Fake transport for tests |
| `services/wa-agent-bridge/wa/queue.go` | Serialised send queue with pacing + jitter + timeout |
| `services/wa-agent-bridge/api/server.go` | Routes, bearer auth |
| `services/wa-agent-bridge/api/handlers.go` | `/v1/send`, `/v1/allowlist`, `/v1/health`, `/v1/kill` |
| `services/wa-agent-bridge/api/webhook.go` | Outbound fan-out to consumer webhooks + replay grace window |
| `services/wa-agent-bridge/redact.go` | Body-free log helpers |
| `services/wa-agent-bridge/README.md` | Runbook: pairing, re-pair, number swap, backup |
| `.github/workflows/wa-agent-bridge.yml` | Go CI job, path-filtered |

---

## Task 1: Module scaffold and CI

**Files:**
- Create: `services/wa-agent-bridge/go.mod`
- Create: `services/wa-agent-bridge/redact.go`
- Test: `services/wa-agent-bridge/redact_test.go`
- Create: `.github/workflows/wa-agent-bridge.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `redact.Body(s string) string` returning `"<n chars>"`; `redact.JID(j string) string` returning the JID unchanged (JIDs are safe to log, the function exists so call sites are uniform and greppable).

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/redact_test.go`:

```go
package main

import "testing"

func TestBodyNeverLeaksContent(t *testing.T) {
	got := redactBody("hello Sipho, your install is booked")
	if got != "<35 chars>" {
		t.Fatalf("redactBody leaked content or miscounted: %q", got)
	}
}

func TestBodyEmpty(t *testing.T) {
	if got := redactBody(""); got != "<0 chars>" {
		t.Fatalf("want <0 chars>, got %q", got)
	}
}

func TestBodyCountsRunesNotBytes(t *testing.T) {
	// A body-length figure that jumps because of an emoji is a bug report
	// waiting to happen, and rune count is what an operator expects.
	if got := redactBody("hé🎉"); got != "<3 chars>" {
		t.Fatalf("want <3 chars>, got %q", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./...
```
Expected: FAIL — `undefined: redactBody`.

- [ ] **Step 3: Write go.mod and the implementation**

Create `services/wa-agent-bridge/go.mod`:

```
module github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge

go 1.26.0
```

Create `services/wa-agent-bridge/redact.go`:

```go
package main

import (
	"fmt"
	"unicode/utf8"
)

// redactBody returns a loggable stand-in for a WhatsApp message body.
//
// Message bodies must never reach a log file: this service runs on a VPS
// whose logs are not access-controlled, while the bodies themselves belong in
// Firestore where they are. Length is kept because it is the one property
// worth debugging with (a zero-length send is a real bug class) and it
// discloses nothing.
func redactBody(s string) string {
	return fmt.Sprintf("<%d chars>", utf8.RuneCountInString(s))
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/wa-agent-bridge && go test ./...
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the CI job**

Create `.github/workflows/wa-agent-bridge.yml`:

```yaml
name: wa-agent-bridge

on:
  push:
    paths:
      - 'services/wa-agent-bridge/**'
      - '.github/workflows/wa-agent-bridge.yml'
  pull_request:
    paths:
      - 'services/wa-agent-bridge/**'
      - '.github/workflows/wa-agent-bridge.yml'

jobs:
  go:
    runs-on: [self-hosted, linux, velo, crestahq]
    defaults:
      run:
        working-directory: services/wa-agent-bridge
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.26.0'
          cache-dependency-path: services/wa-agent-bridge/go.sum
      - run: go vet ./...
      - run: go test ./... -race
      - run: go build ./...
```

The `paths:` filter is the whole point — a Go failure must never block a
Next.js PR that did not touch this directory.

- [ ] **Step 6: Commit**

```bash
git add services/wa-agent-bridge .github/workflows/wa-agent-bridge.yml
git commit -m "Scaffold wa-agent-bridge with body redaction and its own CI job"
```

---

## Task 2: Rail types and the Store interface

**Files:**
- Create: `services/wa-agent-bridge/rails/types.go`
- Test: `services/wa-agent-bridge/rails/types_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `rails.SendRequest`, `rails.Decision`, `rails.RefusalCode` constants, `rails.Config`, `rails.Store` interface, `rails.Allow()`, `rails.Refuse(code, reason)`. Every later rail task consumes these exact names.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/rails/types_test.go`:

```go
package rails

import "testing"

func TestRefuseCarriesCodeAndReason(t *testing.T) {
	d := Refuse(RefusedReplyOnly, "no inbound history")
	if d.Allow {
		t.Fatal("Refuse must not allow")
	}
	if d.RefusedBy != RefusedReplyOnly {
		t.Fatalf("want %q, got %q", RefusedReplyOnly, d.RefusedBy)
	}
	if d.Reason != "no inbound history" {
		t.Fatalf("reason lost: %q", d.Reason)
	}
}

func TestAllowHasNoRefusalCode(t *testing.T) {
	d := Allow()
	if !d.Allow {
		t.Fatal("Allow must allow")
	}
	if d.RefusedBy != "" {
		t.Fatalf("allowed decision carried a refusal code: %q", d.RefusedBy)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./rails/...
```
Expected: FAIL — `undefined: Refuse`.

- [ ] **Step 3: Write the implementation**

Create `services/wa-agent-bridge/rails/types.go`:

```go
// Package rails holds every decision about whether an outbound WhatsApp
// message may be sent. It is deliberately pure: no network, no whatsmeow, no
// HTTP. Everything it needs arrives as a SendRequest, a Store, and a clock,
// which is what makes the whole safety layer testable without a WhatsApp
// connection.
//
// The rails live here rather than in the consumers because a consumer holding
// an unmediated socket is exactly how the sibling bridge's number was banned
// on 2026-09-04. Placing them below every consumer makes the unsafe action
// unrepresentable rather than merely discouraged.
package rails

import "time"

// SendRequest is one outbound attempt, fully described. Now is injected so
// rail logic never calls time.Now() — tests depend on controlling it.
type SendRequest struct {
	To             string // full JID, e.g. "27821234567@s.whatsapp.net"
	Text           string
	IdempotencyKey string
	Consumer       string // registry key: "hermes", "leadstack"
	Now            time.Time
}

// RefusalCode is machine-readable so a consumer can render a real reason
// instead of a generic failure. Values are stable API surface.
type RefusalCode string

const (
	RefusedKillSwitch     RefusalCode = "kill_switch"
	RefusedConsumerBudget RefusalCode = "consumer_budget"
	RefusedReplyOnly      RefusalCode = "reply_only"
	RefusedPerContactCap  RefusalCode = "per_contact_cap"
	RefusedConsecutiveCap RefusalCode = "consecutive_cap"
	RefusedDailyCap       RefusalCode = "daily_cap"
	RefusedQuietHours     RefusalCode = "quiet_hours"
	RefusedInternalError  RefusalCode = "internal_error"
)

// Decision is the chain's verdict. DuplicateOf is set when rail 9 recognised
// the idempotency key: the caller must return the original result rather than
// send again.
type Decision struct {
	Allow       bool
	RefusedBy   RefusalCode
	Reason      string
	DuplicateOf string
}

func Allow() Decision { return Decision{Allow: true} }

func Refuse(code RefusalCode, reason string) Decision {
	return Decision{Allow: false, RefusedBy: code, Reason: reason}
}

// Duplicate short-circuits the chain when an idempotency key has already been
// used. It is an allow-shaped answer with no send attached.
func Duplicate(messageID string) Decision {
	return Decision{Allow: false, RefusedBy: "", DuplicateOf: messageID}
}

// ConsumerBudget caps one consumer independently of the others, so LeadStack
// can be throttled to zero without silencing Hermes.
type ConsumerBudget struct {
	PerHour int
	PerDay  int
}

type Config struct {
	PerContactPerDay int // default 10
	ConsecutiveMax   int // default 3
	GlobalDailyCap   int // default 150
	QuietStartHour   int // inclusive, local time, e.g. 21
	QuietEndHour     int // exclusive, local time, e.g. 7
	Location         *time.Location
	Budgets          map[string]ConsumerBudget
}

// Store is the persisted state the rails consult. Every counter lives on disk:
// an in-memory counter resets on restart, which turns a crash-loop into a
// send-loop. The sibling bridge shipped that bug and had to fix it in PR #2687.
type Store interface {
	HasInboundFrom(jid string) (bool, error)
	IsAllowlisted(jid string) (bool, error)
	AddAllowlist(jid string) error
	RemoveAllowlist(jid string) error

	OutboundCountForContact(jid string, since time.Time) (int, error)
	ConsecutiveOutbound(jid string) (int, error)
	OutboundCountTotal(since time.Time) (int, error)
	OutboundCountForConsumer(consumer string, since time.Time) (int, error)

	RecordOutbound(jid, consumer, messageID string, at time.Time) error
	RecordInbound(jid string, at time.Time) error

	LookupIdempotency(key string) (messageID string, found bool, err error)
	SaveIdempotency(key, messageID string) error

	KillState() (bool, error)
	SetKill(on bool) error
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/wa-agent-bridge && go test ./rails/...
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add services/wa-agent-bridge/rails
git commit -m "Define the rail decision types and the persisted Store contract"
```

---

## Task 3: In-memory Store for tests

**Files:**
- Create: `services/wa-agent-bridge/store/memory.go`
- Test: `services/wa-agent-bridge/store/memory_test.go`

**Interfaces:**
- Consumes: `rails.Store`.
- Produces: `store.NewMemory() *Memory` implementing `rails.Store`. Every rail test uses this.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/store/memory_test.go`:

```go
package store

import (
	"testing"
	"time"
)

func TestMemoryRecordsInboundAndOutbound(t *testing.T) {
	s := NewMemory()
	jid := "27821234567@s.whatsapp.net"
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	ok, err := s.HasInboundFrom(jid)
	if err != nil || ok {
		t.Fatalf("fresh store must have no inbound: ok=%v err=%v", ok, err)
	}

	if err := s.RecordInbound(jid, base); err != nil {
		t.Fatal(err)
	}
	ok, _ = s.HasInboundFrom(jid)
	if !ok {
		t.Fatal("inbound not recorded")
	}

	if err := s.RecordOutbound(jid, "hermes", "msg-1", base.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	n, _ := s.OutboundCountForContact(jid, base)
	if n != 1 {
		t.Fatalf("want 1 outbound, got %d", n)
	}
}

func TestConsecutiveOutboundResetsOnInbound(t *testing.T) {
	s := NewMemory()
	jid := "27821234567@s.whatsapp.net"
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	s.RecordInbound(jid, base)
	s.RecordOutbound(jid, "hermes", "a", base.Add(1*time.Minute))
	s.RecordOutbound(jid, "hermes", "b", base.Add(2*time.Minute))

	n, _ := s.ConsecutiveOutbound(jid)
	if n != 2 {
		t.Fatalf("want 2 consecutive, got %d", n)
	}

	// A reply from the contact resets the streak — that is the whole point of
	// the counter: it measures how long we have been talking at someone.
	s.RecordInbound(jid, base.Add(3*time.Minute))
	n, _ = s.ConsecutiveOutbound(jid)
	if n != 0 {
		t.Fatalf("inbound must reset the streak, got %d", n)
	}
}

func TestIdempotencyRoundTrip(t *testing.T) {
	s := NewMemory()
	if _, found, _ := s.LookupIdempotency("k1"); found {
		t.Fatal("unknown key must not be found")
	}
	if err := s.SaveIdempotency("k1", "msg-9"); err != nil {
		t.Fatal(err)
	}
	id, found, _ := s.LookupIdempotency("k1")
	if !found || id != "msg-9" {
		t.Fatalf("want msg-9/true, got %q/%v", id, found)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./store/...
```
Expected: FAIL — `undefined: NewMemory`.

- [ ] **Step 3: Write the implementation**

Create `services/wa-agent-bridge/store/memory.go`:

```go
// Package store persists the state the rails consult. Two implementations:
// Memory for tests, SQLite for production.
package store

import (
	"sort"
	"sync"
	"time"
)

type event struct {
	at       time.Time
	outbound bool
	consumer string
}

// Memory is a test double. It is NOT suitable for production: everything it
// knows dies with the process, which is exactly the bug the SQLite store
// exists to avoid.
type Memory struct {
	mu        sync.Mutex
	events    map[string][]event
	allowlist map[string]bool
	idem      map[string]string
	kill      bool
}

func NewMemory() *Memory {
	return &Memory{
		events:    map[string][]event{},
		allowlist: map[string]bool{},
		idem:      map[string]string{},
	}
}

func (m *Memory) append(jid string, e event) {
	m.events[jid] = append(m.events[jid], e)
	sort.SliceStable(m.events[jid], func(i, j int) bool {
		return m.events[jid][i].at.Before(m.events[jid][j].at)
	})
}

func (m *Memory) RecordInbound(jid string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.append(jid, event{at: at, outbound: false})
	return nil
}

func (m *Memory) RecordOutbound(jid, consumer, messageID string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.append(jid, event{at: at, outbound: true, consumer: consumer})
	return nil
}

func (m *Memory) HasInboundFrom(jid string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.events[jid] {
		if !e.outbound {
			return true, nil
		}
	}
	return false, nil
}

func (m *Memory) IsAllowlisted(jid string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.allowlist[jid], nil
}

func (m *Memory) AddAllowlist(jid string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.allowlist[jid] = true
	return nil
}

func (m *Memory) RemoveAllowlist(jid string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.allowlist, jid)
	return nil
}

func (m *Memory) OutboundCountForContact(jid string, since time.Time) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, e := range m.events[jid] {
		if e.outbound && !e.at.Before(since) {
			n++
		}
	}
	return n, nil
}

func (m *Memory) ConsecutiveOutbound(jid string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	evts := m.events[jid]
	n := 0
	for i := len(evts) - 1; i >= 0; i-- {
		if !evts[i].outbound {
			break
		}
		n++
	}
	return n, nil
}

func (m *Memory) OutboundCountTotal(since time.Time) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, evts := range m.events {
		for _, e := range evts {
			if e.outbound && !e.at.Before(since) {
				n++
			}
		}
	}
	return n, nil
}

func (m *Memory) OutboundCountForConsumer(consumer string, since time.Time) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, evts := range m.events {
		for _, e := range evts {
			if e.outbound && e.consumer == consumer && !e.at.Before(since) {
				n++
			}
		}
	}
	return n, nil
}

func (m *Memory) LookupIdempotency(key string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.idem[key]
	return id, ok, nil
}

func (m *Memory) SaveIdempotency(key, messageID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.idem[key] = messageID
	return nil
}

func (m *Memory) KillState() (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.kill, nil
}

func (m *Memory) SetKill(on bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.kill = on
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/wa-agent-bridge && go test ./store/... -race
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add services/wa-agent-bridge/store
git commit -m "Add an in-memory Store so rails can be tested without SQLite"
```

---

## Task 4: Reply-only and allowlist rails

**Files:**
- Create: `services/wa-agent-bridge/rails/replyonly.go`
- Test: `services/wa-agent-bridge/rails/replyonly_test.go`

**Interfaces:**
- Consumes: `rails.SendRequest`, `rails.Store`, `rails.Decision`.
- Produces: `rails.checkReplyOnly(req SendRequest, s Store) Decision` (unexported; called only by the engine).

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/rails/replyonly_test.go`:

```go
package rails

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

const stranger = "27829999999@s.whatsapp.net"
const known = "27821234567@s.whatsapp.net"

func TestReplyOnlyRefusesContactWhoNeverMessaged(t *testing.T) {
	s := store.NewMemory()
	d := checkReplyOnly(SendRequest{To: stranger, Consumer: "leadstack"}, s)
	if d.Allow {
		t.Fatal("outbound to a JID with no inbound history must be refused")
	}
	if d.RefusedBy != RefusedReplyOnly {
		t.Fatalf("want %q, got %q", RefusedReplyOnly, d.RefusedBy)
	}
}

func TestReplyOnlyAllowsContactWhoMessagedIn(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, time.Now())
	if d := checkReplyOnly(SendRequest{To: known}, s); !d.Allow {
		t.Fatalf("inbound history must open the contact, got %+v", d)
	}
}

func TestAllowlistOverridesReplyOnly(t *testing.T) {
	s := store.NewMemory()
	s.AddAllowlist(stranger)
	if d := checkReplyOnly(SendRequest{To: stranger}, s); !d.Allow {
		t.Fatalf("allowlist must override reply-only, got %+v", d)
	}
}

// The incident this whole service exists to prevent: on 2026-09-04 the sibling
// bridge's number was logged out 12 times in one window after ~120 outbound
// DMs to people who had never messaged it. Every one of those must refuse.
func TestColdDMToNonContactRefused(t *testing.T) {
	s := store.NewMemory()
	for i := 0; i < 120; i++ {
		jid := "2782000" + string(rune('0'+i%10)) + "00@s.whatsapp.net"
		d := checkReplyOnly(SendRequest{To: jid, Consumer: "leadstack"}, s)
		if d.Allow {
			t.Fatalf("cold DM %d to %s was allowed; this is the ban pattern", i, jid)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./rails/...
```
Expected: FAIL — `undefined: checkReplyOnly`.

- [ ] **Step 3: Write the implementation**

Create `services/wa-agent-bridge/rails/replyonly.go`:

```go
package rails

// checkReplyOnly is the core protection. An outbound to a JID that has never
// sent us a message is refused.
//
// This is the rail that replaces Meta's 24-hour service window. On the Twilio
// and Cloud rails that window is doing double duty: a compliance rule and an
// accidental rate limiter that makes cold bulk outbound impossible. This rail
// runs with enforcesWindow:false, so without this check the failure mode
// returns immediately.
//
// The evidence is direct: the same number, on the same library, ran a
// reply-only group path for months without incident and was banned within days
// of sending cold DMs.
//
// The allowlist is the only override, and it is deliberately one-JID-at-a-time
// so that using it at volume is painful.
func checkReplyOnly(req SendRequest, s Store) Decision {
	allowed, err := s.IsAllowlisted(req.To)
	if err != nil {
		return Refuse(RefusedInternalError, "allowlist lookup failed")
	}
	if allowed {
		return Allow()
	}

	hasInbound, err := s.HasInboundFrom(req.To)
	if err != nil {
		return Refuse(RefusedInternalError, "inbound history lookup failed")
	}
	if !hasInbound {
		return Refuse(RefusedReplyOnly,
			"this contact has never messaged this number; add them to the allowlist to override")
	}
	return Allow()
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/wa-agent-bridge && go test ./rails/... -race -run 'ReplyOnly|Allowlist|ColdDM' -v
```
Expected: PASS, 4 tests, including `TestColdDMToNonContactRefused`.

- [ ] **Step 5: Commit**

```bash
git add services/wa-agent-bridge/rails
git commit -m "Add the reply-only rail that replaces the missing service window"
```

---

## Task 5: Volume cap rails

**Files:**
- Create: `services/wa-agent-bridge/rails/caps.go`
- Test: `services/wa-agent-bridge/rails/caps_test.go`

**Interfaces:**
- Consumes: `rails.SendRequest`, `rails.Store`, `rails.Config`.
- Produces: `rails.checkCaps(req SendRequest, s Store, cfg Config) Decision`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/rails/caps_test.go`:

```go
package rails

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func testConfig() Config {
	return Config{
		PerContactPerDay: 10,
		ConsecutiveMax:   3,
		GlobalDailyCap:   150,
		Location:         time.UTC,
	}
}

var now = time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)

func TestPerContactCapRefusesTheEleventh(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-2*time.Hour))
	for i := 0; i < 10; i++ {
		s.RecordOutbound(known, "hermes", "m", now.Add(-time.Duration(i)*time.Minute))
		s.RecordInbound(known, now.Add(-time.Duration(i)*time.Minute+time.Second))
	}
	d := checkCaps(SendRequest{To: known, Now: now}, s, testConfig())
	if d.Allow {
		t.Fatal("11th outbound in a day to one contact must be refused")
	}
	if d.RefusedBy != RefusedPerContactCap {
		t.Fatalf("want %q, got %q", RefusedPerContactCap, d.RefusedBy)
	}
}

func TestConsecutiveCapRefusesFourthUnansweredMessage(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Hour))
	for i := 0; i < 3; i++ {
		s.RecordOutbound(known, "hermes", "m", now.Add(-time.Duration(3-i)*time.Minute))
	}
	d := checkCaps(SendRequest{To: known, Now: now}, s, testConfig())
	if d.Allow {
		t.Fatal("4th consecutive unanswered outbound must be refused")
	}
	if d.RefusedBy != RefusedConsecutiveCap {
		t.Fatalf("want %q, got %q", RefusedConsecutiveCap, d.RefusedBy)
	}
}

func TestGlobalDailyCapRefusesAt150(t *testing.T) {
	s := store.NewMemory()
	for i := 0; i < 150; i++ {
		jid := "27820000000@s.whatsapp.net"
		s.RecordInbound(jid, now.Add(-23*time.Hour))
		s.RecordOutbound(jid, "leadstack", "m", now.Add(-time.Duration(i)*time.Second))
	}
	d := checkCaps(SendRequest{To: known, Now: now}, s, testConfig())
	if d.Allow {
		t.Fatal("151st send in a day must be refused")
	}
	if d.RefusedBy != RefusedDailyCap {
		t.Fatalf("want %q, got %q", RefusedDailyCap, d.RefusedBy)
	}
}

// The counters are only worth anything if they outlive the process. An
// in-memory counter turns a crash-loop into a send-loop; the sibling bridge
// shipped exactly that bug (fixed in its PR #2687). This test asserts the rail
// reads through the Store rather than caching in the engine.
func TestCapsSurviveRestart(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Hour))
	for i := 0; i < 10; i++ {
		s.RecordOutbound(known, "hermes", "m", now.Add(-time.Duration(i)*time.Minute))
		s.RecordInbound(known, now.Add(-time.Duration(i)*time.Minute+time.Second))
	}
	// Simulate a restart: brand new Config and no engine state, same Store.
	freshCfg := testConfig()
	d := checkCaps(SendRequest{To: known, Now: now}, s, freshCfg)
	if d.Allow {
		t.Fatal("cap must still bind after a restart — counters live in the Store")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./rails/...
```
Expected: FAIL — `undefined: checkCaps`.

- [ ] **Step 3: Write the implementation**

Create `services/wa-agent-bridge/rails/caps.go`:

```go
package rails

import (
	"fmt"
	"time"
)

// checkCaps enforces the three volume limits.
//
// Ordering inside this rail matters for the operator, not the outcome: the
// per-contact checks come first because "you are talking at one person too
// much" is a more actionable message than "the account is at its daily
// ceiling".
//
// Every count is read from the Store on each call rather than cached, so the
// limits survive a restart. That is not an optimisation detail: a cap that
// resets when the process dies converts a crash-loop into a send-loop.
func checkCaps(req SendRequest, s Store, cfg Config) Decision {
	dayAgo := req.Now.Add(-24 * time.Hour)

	perContact, err := s.OutboundCountForContact(req.To, dayAgo)
	if err != nil {
		return Refuse(RefusedInternalError, "per-contact count failed")
	}
	if perContact >= cfg.PerContactPerDay {
		return Refuse(RefusedPerContactCap,
			fmt.Sprintf("already sent %d messages to this contact in 24h (cap %d)",
				perContact, cfg.PerContactPerDay))
	}

	consecutive, err := s.ConsecutiveOutbound(req.To)
	if err != nil {
		return Refuse(RefusedInternalError, "consecutive count failed")
	}
	if consecutive >= cfg.ConsecutiveMax {
		return Refuse(RefusedConsecutiveCap,
			fmt.Sprintf("%d unanswered messages already sent to this contact (cap %d)",
				consecutive, cfg.ConsecutiveMax))
	}

	total, err := s.OutboundCountTotal(dayAgo)
	if err != nil {
		return Refuse(RefusedInternalError, "daily total count failed")
	}
	if total >= cfg.GlobalDailyCap {
		return Refuse(RefusedDailyCap,
			fmt.Sprintf("account sent %d messages in 24h (cap %d)", total, cfg.GlobalDailyCap))
	}

	return Allow()
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/wa-agent-bridge && go test ./rails/... -race -v
```
Expected: PASS, all rail tests including `TestCapsSurviveRestart`.

- [ ] **Step 5: Commit**

```bash
git add services/wa-agent-bridge/rails
git commit -m "Add per-contact, consecutive and daily volume caps"
```

---

## Task 6: Kill switch, consumer budget and quiet hours

**Files:**
- Create: `services/wa-agent-bridge/rails/window.go`
- Test: `services/wa-agent-bridge/rails/window_test.go`

**Interfaces:**
- Consumes: `rails.SendRequest`, `rails.Store`, `rails.Config`.
- Produces: `rails.checkKill(s Store) Decision`, `rails.checkBudget(req SendRequest, s Store, cfg Config) Decision`, `rails.checkQuietHours(req SendRequest, cfg Config) Decision`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/rails/window_test.go`:

```go
package rails

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func TestKillSwitchRefusesEverything(t *testing.T) {
	s := store.NewMemory()
	if d := checkKill(s); !d.Allow {
		t.Fatal("kill switch off must allow")
	}
	s.SetKill(true)
	d := checkKill(s)
	if d.Allow {
		t.Fatal("kill switch on must refuse")
	}
	if d.RefusedBy != RefusedKillSwitch {
		t.Fatalf("want %q, got %q", RefusedKillSwitch, d.RefusedBy)
	}
}

func TestConsumerBudgetIsPerConsumer(t *testing.T) {
	s := store.NewMemory()
	cfg := testConfig()
	cfg.Budgets = map[string]ConsumerBudget{
		"leadstack": {PerHour: 2, PerDay: 10},
		"hermes":    {PerHour: 100, PerDay: 500},
	}
	jid := "27821111111@s.whatsapp.net"
	s.RecordOutbound(jid, "leadstack", "a", now.Add(-10*time.Minute))
	s.RecordOutbound(jid, "leadstack", "b", now.Add(-5*time.Minute))

	if d := checkBudget(SendRequest{Consumer: "leadstack", Now: now}, s, cfg); d.Allow {
		t.Fatal("leadstack is over its hourly budget and must be refused")
	}
	// The whole point of per-consumer budgets: throttling one must not
	// silence the other.
	if d := checkBudget(SendRequest{Consumer: "hermes", Now: now}, s, cfg); !d.Allow {
		t.Fatalf("hermes must be unaffected by leadstack's budget, got %+v", d)
	}
}

func TestUnknownConsumerIsRefused(t *testing.T) {
	s := store.NewMemory()
	cfg := testConfig()
	cfg.Budgets = map[string]ConsumerBudget{"hermes": {PerHour: 10, PerDay: 50}}
	d := checkBudget(SendRequest{Consumer: "mystery", Now: now}, s, cfg)
	if d.Allow {
		t.Fatal("a consumer with no registered budget must fail closed")
	}
}

func TestQuietHoursRefusesOvernight(t *testing.T) {
	cfg := testConfig()
	cfg.QuietStartHour = 21
	cfg.QuietEndHour = 7

	at := func(h int) SendRequest {
		return SendRequest{Now: time.Date(2026, 9, 4, h, 30, 0, 0, time.UTC)}
	}

	if d := checkQuietHours(at(22), cfg); d.Allow {
		t.Fatal("22:30 is inside quiet hours and must be refused")
	}
	if d := checkQuietHours(at(3), cfg); d.Allow {
		t.Fatal("03:30 is inside quiet hours and must be refused")
	}
	if d := checkQuietHours(at(10), cfg); !d.Allow {
		t.Fatal("10:30 is outside quiet hours and must be allowed")
	}
}

func TestQuietHoursDisabledWhenEqual(t *testing.T) {
	cfg := testConfig()
	cfg.QuietStartHour = 0
	cfg.QuietEndHour = 0
	req := SendRequest{Now: time.Date(2026, 9, 4, 3, 0, 0, 0, time.UTC)}
	if d := checkQuietHours(req, cfg); !d.Allow {
		t.Fatal("start == end must disable the rail, not refuse all day")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./rails/...
```
Expected: FAIL — `undefined: checkKill`.

- [ ] **Step 3: Write the implementation**

Create `services/wa-agent-bridge/rails/window.go`:

```go
package rails

import (
	"fmt"
	"time"
)

// checkKill is the incident-response stop button. It refuses outbound while
// leaving the connection up, so the operator keeps receiving messages and
// keeps seeing health data. Killing the process would do neither.
func checkKill(s Store) Decision {
	on, err := s.KillState()
	if err != nil {
		return Refuse(RefusedInternalError, "kill state lookup failed")
	}
	if on {
		return Refuse(RefusedKillSwitch, "outbound is stopped by the kill switch")
	}
	return Allow()
}

// checkBudget caps each consumer independently so one can be throttled to zero
// without silencing the other. An unregistered consumer fails closed: a typo in
// a token's consumer name must not inherit somebody else's allowance.
func checkBudget(req SendRequest, s Store, cfg Config) Decision {
	budget, ok := cfg.Budgets[req.Consumer]
	if !ok {
		return Refuse(RefusedConsumerBudget,
			fmt.Sprintf("consumer %q has no registered budget", req.Consumer))
	}

	hourly, err := s.OutboundCountForConsumer(req.Consumer, req.Now.Add(-time.Hour))
	if err != nil {
		return Refuse(RefusedInternalError, "hourly consumer count failed")
	}
	if hourly >= budget.PerHour {
		return Refuse(RefusedConsumerBudget,
			fmt.Sprintf("%s sent %d messages this hour (cap %d)", req.Consumer, hourly, budget.PerHour))
	}

	daily, err := s.OutboundCountForConsumer(req.Consumer, req.Now.Add(-24*time.Hour))
	if err != nil {
		return Refuse(RefusedInternalError, "daily consumer count failed")
	}
	if daily >= budget.PerDay {
		return Refuse(RefusedConsumerBudget,
			fmt.Sprintf("%s sent %d messages today (cap %d)", req.Consumer, daily, budget.PerDay))
	}
	return Allow()
}

// checkQuietHours refuses sends outside the configured local window. A 03:00
// message is both a bot signal to Meta and a customer-relations problem.
//
// The window may wrap midnight (21 -> 7), which is the normal configuration,
// so the comparison is written for both the wrapping and non-wrapping cases.
// start == end disables the rail rather than refusing every hour of the day —
// the alternative silently bricks the service on a zero-valued config.
func checkQuietHours(req SendRequest, cfg Config) Decision {
	if cfg.QuietStartHour == cfg.QuietEndHour {
		return Allow()
	}
	loc := cfg.Location
	if loc == nil {
		loc = time.UTC
	}
	h := req.Now.In(loc).Hour()

	quiet := false
	if cfg.QuietStartHour < cfg.QuietEndHour {
		quiet = h >= cfg.QuietStartHour && h < cfg.QuietEndHour
	} else {
		quiet = h >= cfg.QuietStartHour || h < cfg.QuietEndHour
	}
	if quiet {
		return Refuse(RefusedQuietHours,
			fmt.Sprintf("local time %02d:00 is inside quiet hours %02d:00-%02d:00",
				h, cfg.QuietStartHour, cfg.QuietEndHour))
	}
	return Allow()
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/wa-agent-bridge && go test ./rails/... -race -v
```
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add services/wa-agent-bridge/rails
git commit -m "Add kill switch, per-consumer budgets and quiet hours"
```

---

## Task 7: Idempotency rail and the ordered engine

**Files:**
- Create: `services/wa-agent-bridge/rails/idempotency.go`
- Create: `services/wa-agent-bridge/rails/engine.go`
- Test: `services/wa-agent-bridge/rails/engine_test.go`

**Interfaces:**
- Consumes: every `check*` function from Tasks 4–6.
- Produces: `rails.NewEngine(s Store, cfg Config) *Engine` and `(*Engine).Evaluate(req SendRequest) Decision`. The API layer in Task 10 calls only `Evaluate`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/rails/engine_test.go`:

```go
package rails

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func engineConfig() Config {
	c := testConfig()
	c.QuietStartHour, c.QuietEndHour = 0, 0 // disabled for these tests
	c.Budgets = map[string]ConsumerBudget{"hermes": {PerHour: 100, PerDay: 500}}
	return c
}

func TestEngineAllowsAValidReply(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Minute))
	e := NewEngine(s, engineConfig())
	d := e.Evaluate(SendRequest{To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k1"})
	if !d.Allow {
		t.Fatalf("valid reply must be allowed, got %+v", d)
	}
}

// Rail order is observable: the kill switch must win over everything, so an
// operator hitting stop during an incident does not have to reason about which
// other rail might have refused first.
func TestKillSwitchWinsOverReplyOnly(t *testing.T) {
	s := store.NewMemory()
	s.SetKill(true)
	e := NewEngine(s, engineConfig())
	d := e.Evaluate(SendRequest{To: stranger, Consumer: "hermes", Now: now})
	if d.RefusedBy != RefusedKillSwitch {
		t.Fatalf("kill switch must be checked first, got %q", d.RefusedBy)
	}
}

func TestIdempotentSendReturnsOriginal(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Minute))
	s.SaveIdempotency("k-dup", "msg-original")
	e := NewEngine(s, engineConfig())

	d := e.Evaluate(SendRequest{To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k-dup"})
	if d.Allow {
		t.Fatal("a replayed idempotency key must not produce a second send")
	}
	if d.DuplicateOf != "msg-original" {
		t.Fatalf("want the original message id back, got %q", d.DuplicateOf)
	}
}

func TestMissingIdempotencyKeyIsRefused(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Minute))
	e := NewEngine(s, engineConfig())
	d := e.Evaluate(SendRequest{To: known, Consumer: "hermes", Now: now})
	if d.Allow {
		t.Fatal("a send with no idempotency key must be refused; retries would duplicate")
	}
}

// A rail that errors must never fall through to allow.
func TestStoreErrorFailsClosed(t *testing.T) {
	e := NewEngine(errStore{store.NewMemory()}, engineConfig())
	d := e.Evaluate(SendRequest{To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k"})
	if d.Allow {
		t.Fatal("a Store error must refuse, never allow")
	}
}

// errStore embeds a *pointer* to Memory: Memory's methods have pointer
// receivers, so embedding the value would not satisfy rails.Store and the
// test would fail to compile.
type errStore struct{ *store.Memory }

func (errStore) KillState() (bool, error) { return false, errBoom }
```

The file's import block must also carry `"errors"`, and the sentinel goes
beside the other package-level vars:

```go
var errBoom = errors.New("boom")
```

Construct it in the test as `errStore{store.NewMemory()}`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./rails/...
```
Expected: FAIL — `undefined: NewEngine`.

- [ ] **Step 3: Write the implementations**

Create `services/wa-agent-bridge/rails/idempotency.go`:

```go
package rails

// checkIdempotency short-circuits a replayed send.
//
// An idempotency key is mandatory rather than optional. Callers retry — on a
// timeout, on a redeploy, on a queue redelivery — and a retry without a key is
// indistinguishable from a new message, which means the contact gets it twice.
// Requiring the key makes the safe path the only path.
func checkIdempotency(req SendRequest, s Store) Decision {
	if req.IdempotencyKey == "" {
		return Refuse(RefusedInternalError,
			"idempotencyKey is required; without it a retry would duplicate the message")
	}
	id, found, err := s.LookupIdempotency(req.IdempotencyKey)
	if err != nil {
		return Refuse(RefusedInternalError, "idempotency lookup failed")
	}
	if found {
		return Duplicate(id)
	}
	return Allow()
}
```

Create `services/wa-agent-bridge/rails/engine.go`:

```go
package rails

// Engine runs the rails in a fixed order and returns the first refusal.
//
// The order is part of the contract, not an implementation detail:
//
//  1. kill switch    — an operator stopping an incident must not have to
//                      reason about which other rail fired first
//  2. idempotency    — a replay is answered before any counter is consulted,
//                      so a retry cannot consume budget
//  3. consumer budget— cheapest per-consumer gate
//  4. quiet hours    — time-of-day, no Store reads beyond this point are wasted
//  5. reply-only     — the core protection
//  6. caps           — volume, the most expensive reads
//
// Every rail fails closed: an error refuses. There is no path through this
// function that allows a send because something went wrong.
type Engine struct {
	store Store
	cfg   Config
}

func NewEngine(s Store, cfg Config) *Engine {
	return &Engine{store: s, cfg: cfg}
}

func (e *Engine) Evaluate(req SendRequest) Decision {
	for _, d := range []Decision{
		checkKill(e.store),
		checkIdempotency(req, e.store),
		checkBudget(req, e.store, e.cfg),
		checkQuietHours(req, e.cfg),
		checkReplyOnly(req, e.store),
		checkCaps(req, e.store, e.cfg),
	} {
		if !d.Allow {
			return d
		}
	}
	return Allow()
}

// Config returns the engine's configuration for the health endpoint.
func (e *Engine) Config() Config { return e.cfg }
```

Note: `Evaluate` builds the slice eagerly, which runs every rail even after one
refuses. That is intentional at this size — the checks are local reads, and
short-circuiting would hide ordering bugs from the tests. If profiling ever
shows it matters, convert to a slice of funcs and loop.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/wa-agent-bridge && go test ./rails/... -race -v
```
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add services/wa-agent-bridge/rails
git commit -m "Assemble the rails into an ordered, fail-closed engine"
```

---

## Task 8: SQLite store

**Files:**
- Create: `services/wa-agent-bridge/store/sqlite.go`
- Test: `services/wa-agent-bridge/store/sqlite_test.go`

**Interfaces:**
- Consumes: `rails.Store`.
- Produces: `store.OpenSQLite(path string) (*SQLite, error)` implementing `rails.Store`, plus `(*SQLite).Close() error`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/store/sqlite_test.go`:

```go
package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.db")
	jid := "27821234567@s.whatsapp.net"
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RecordInbound(jid, base); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if err := s.RecordOutbound(jid, "hermes", "m", base.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	s.Close()

	// The restart. This is the assertion that matters: counters written before
	// the process died must still bind after it comes back.
	s2, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()

	n, err := s2.OutboundCountForContact(jid, base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Fatalf("counters did not survive reopen: want 5, got %d", n)
	}
}

func TestSQLiteIdempotencyAndKillPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.db")
	s, _ := OpenSQLite(path)
	s.SaveIdempotency("k1", "msg-1")
	s.SetKill(true)
	s.Close()

	s2, _ := OpenSQLite(path)
	defer s2.Close()
	id, found, _ := s2.LookupIdempotency("k1")
	if !found || id != "msg-1" {
		t.Fatalf("idempotency lost across restart: %q %v", id, found)
	}
	on, _ := s2.KillState()
	if !on {
		t.Fatal("kill state lost across restart; a killed bridge must stay killed")
	}
}

func TestSQLiteConsecutiveResetsOnInbound(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.db")
	s, _ := OpenSQLite(path)
	defer s.Close()
	jid := "27821234567@s.whatsapp.net"
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	s.RecordOutbound(jid, "hermes", "a", base)
	s.RecordOutbound(jid, "hermes", "b", base.Add(time.Minute))
	n, _ := s.ConsecutiveOutbound(jid)
	if n != 2 {
		t.Fatalf("want 2, got %d", n)
	}
	s.RecordInbound(jid, base.Add(2*time.Minute))
	n, _ = s.ConsecutiveOutbound(jid)
	if n != 0 {
		t.Fatalf("inbound must reset the streak, got %d", n)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go get github.com/mattn/go-sqlite3@v1.14.49 && go test ./store/...
```
Expected: FAIL — `undefined: OpenSQLite`.

- [ ] **Step 3: Write the implementation**

Create `services/wa-agent-bridge/store/sqlite.go`:

```go
package store

import (
	"database/sql"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// SQLite is the production Store. Local disk only: the bridge must not depend
// on a shared database or a network path. Three of the sibling bridge's eight
// documented outages had nothing to do with WhatsApp — they were a shared
// Postgres running out of connection slots and a Tailscale session dropping.
// Depending on nothing but this file removes that entire class.
type SQLite struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  jid       TEXT    NOT NULL,
  outbound  INTEGER NOT NULL,
  consumer  TEXT    NOT NULL DEFAULT '',
  msg_id    TEXT    NOT NULL DEFAULT '',
  at_unix   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_jid_at ON messages(jid, at_unix);
CREATE INDEX IF NOT EXISTS idx_messages_at     ON messages(at_unix);

CREATE TABLE IF NOT EXISTS allowlist (
  jid TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS idempotency (
  key    TEXT PRIMARY KEY,
  msg_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flags (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`

func OpenSQLite(path string) (*SQLite, error) {
	db, err := sql.Open("sqlite3", path+"?_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &SQLite{db: db}, nil
}

func (s *SQLite) Close() error { return s.db.Close() }

func (s *SQLite) record(jid string, outbound bool, consumer, msgID string, at time.Time) error {
	flag := 0
	if outbound {
		flag = 1
	}
	_, err := s.db.Exec(
		`INSERT INTO messages (jid, outbound, consumer, msg_id, at_unix) VALUES (?, ?, ?, ?, ?)`,
		jid, flag, consumer, msgID, at.Unix())
	return err
}

func (s *SQLite) RecordInbound(jid string, at time.Time) error {
	return s.record(jid, false, "", "", at)
}

func (s *SQLite) RecordOutbound(jid, consumer, messageID string, at time.Time) error {
	return s.record(jid, true, consumer, messageID, at)
}

func (s *SQLite) HasInboundFrom(jid string) (bool, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE jid = ? AND outbound = 0`, jid).Scan(&n)
	return n > 0, err
}

func (s *SQLite) IsAllowlisted(jid string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(1) FROM allowlist WHERE jid = ?`, jid).Scan(&n)
	return n > 0, err
}

func (s *SQLite) AddAllowlist(jid string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO allowlist (jid) VALUES (?)`, jid)
	return err
}

func (s *SQLite) RemoveAllowlist(jid string) error {
	_, err := s.db.Exec(`DELETE FROM allowlist WHERE jid = ?`, jid)
	return err
}

func (s *SQLite) OutboundCountForContact(jid string, since time.Time) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE jid = ? AND outbound = 1 AND at_unix >= ?`,
		jid, since.Unix()).Scan(&n)
	return n, err
}

func (s *SQLite) OutboundCountTotal(since time.Time) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE outbound = 1 AND at_unix >= ?`,
		since.Unix()).Scan(&n)
	return n, err
}

func (s *SQLite) OutboundCountForConsumer(consumer string, since time.Time) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE outbound = 1 AND consumer = ? AND at_unix >= ?`,
		consumer, since.Unix()).Scan(&n)
	return n, err
}

// ConsecutiveOutbound counts outbound messages since the contact's most recent
// inbound. Written as one query rather than a scan so the count stays correct
// on a thread with a long history.
func (s *SQLite) ConsecutiveOutbound(jid string) (int, error) {
	var lastInbound sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT MAX(at_unix) FROM messages WHERE jid = ? AND outbound = 0`, jid,
	).Scan(&lastInbound); err != nil {
		return 0, err
	}
	since := int64(0)
	if lastInbound.Valid {
		since = lastInbound.Int64
	}
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(1) FROM messages WHERE jid = ? AND outbound = 1 AND at_unix >= ?`,
		jid, since).Scan(&n)
	return n, err
}

func (s *SQLite) LookupIdempotency(key string) (string, bool, error) {
	var id string
	err := s.db.QueryRow(`SELECT msg_id FROM idempotency WHERE key = ?`, key).Scan(&id)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

func (s *SQLite) SaveIdempotency(key, messageID string) error {
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO idempotency (key, msg_id) VALUES (?, ?)`, key, messageID)
	return err
}

func (s *SQLite) KillState() (bool, error) {
	var v int
	err := s.db.QueryRow(`SELECT value FROM flags WHERE name = 'kill'`).Scan(&v)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return v != 0, err
}

func (s *SQLite) SetKill(on bool) error {
	v := 0
	if on {
		v = 1
	}
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO flags (name, value) VALUES ('kill', ?)`, v)
	return err
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/wa-agent-bridge && go test ./store/... -race -v
```
Expected: PASS, all store tests including `TestSQLiteSurvivesReopen`.

- [ ] **Step 5: Verify the engine works against the real store**

Add to `services/wa-agent-bridge/rails/engine_test.go` is not possible (import
cycle risk is nil but the rails package should not depend on sqlite in tests).
Instead create `services/wa-agent-bridge/store/engine_integration_test.go`:

```go
package store_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func TestEngineAgainstSQLiteRefusesColdDM(t *testing.T) {
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	e := rails.NewEngine(s, rails.Config{
		PerContactPerDay: 10, ConsecutiveMax: 3, GlobalDailyCap: 150,
		Location: time.UTC,
		Budgets:  map[string]rails.ConsumerBudget{"leadstack": {PerHour: 60, PerDay: 500}},
	})

	d := e.Evaluate(rails.SendRequest{
		To: "27829999999@s.whatsapp.net", Consumer: "leadstack",
		Now: time.Now(), IdempotencyKey: "k1",
	})
	if d.Allow {
		t.Fatal("cold DM allowed against the real store")
	}
	if d.RefusedBy != rails.RefusedReplyOnly {
		t.Fatalf("want reply_only, got %q", d.RefusedBy)
	}
}
```

Run: `go test ./store/... -race -v`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/wa-agent-bridge/store services/wa-agent-bridge/go.mod services/wa-agent-bridge/go.sum
git commit -m "Add the SQLite store so rail counters survive restarts"
```

---

## Task 9: Transport interface, fake, and paced send queue

**Files:**
- Create: `services/wa-agent-bridge/wa/transport.go`
- Create: `services/wa-agent-bridge/wa/fake.go`
- Create: `services/wa-agent-bridge/wa/queue.go`
- Test: `services/wa-agent-bridge/wa/queue_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `wa.Transport` interface (`Send(ctx, jid, text) (string, error)`, `Connected() bool`), `wa.NewFake()`, `wa.NewQueue(t Transport, opts QueueOpts) *Queue`, `(*Queue).Send(ctx, jid, text) (string, error)`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/wa/queue_test.go`:

```go
package wa

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestQueueSerialisesSends(t *testing.T) {
	f := NewFake()
	// Concurrent sends on one socket race in whatsmeow; the queue exists to
	// make that impossible. The fake records overlap if any occurs.
	q := NewQueue(f, QueueOpts{MinGap: 0, PerRuneDelay: 0, Timeout: time.Second})

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			q.Send(context.Background(), "27821234567@s.whatsapp.net", "hi")
		}()
	}
	wg.Wait()

	if f.MaxConcurrent() > 1 {
		t.Fatalf("queue allowed %d concurrent sends; must be 1", f.MaxConcurrent())
	}
	if got := len(f.Sent()); got != 20 {
		t.Fatalf("want 20 sends, got %d", got)
	}
}

func TestQueueAppliesMinimumGap(t *testing.T) {
	f := NewFake()
	q := NewQueue(f, QueueOpts{MinGap: 50 * time.Millisecond, Timeout: time.Second})

	start := time.Now()
	for i := 0; i < 3; i++ {
		q.Send(context.Background(), "27821234567@s.whatsapp.net", "hi")
	}
	// Three sends with a 50ms floor means at least two gaps.
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Fatalf("pacing not applied: 3 sends took %v", elapsed)
	}
}

func TestQueueTimesOutRatherThanHanging(t *testing.T) {
	f := NewFake()
	f.BlockForever = true
	q := NewQueue(f, QueueOpts{Timeout: 30 * time.Millisecond})

	_, err := q.Send(context.Background(), "27821234567@s.whatsapp.net", "hi")
	if !errors.Is(err, ErrSendTimeout) {
		t.Fatalf("want ErrSendTimeout, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./wa/...
```
Expected: FAIL — `undefined: NewFake`.

- [ ] **Step 3: Write the implementations**

Create `services/wa-agent-bridge/wa/transport.go`:

```go
// Package wa wraps the WhatsApp socket. The interface exists so that every
// layer above it — the queue, the API, the rails — is testable without a
// WhatsApp connection.
package wa

import "context"

type Transport interface {
	// Send delivers text to jid and returns the provider message id.
	Send(ctx context.Context, jid, text string) (string, error)
	Connected() bool
}
```

Create `services/wa-agent-bridge/wa/fake.go`:

```go
package wa

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Fake is the test transport. MaxConcurrent is the assertion that matters:
// it proves the queue actually serialises.
type Fake struct {
	mu            sync.Mutex
	sent          []string
	inFlight      int
	maxConcurrent int
	BlockForever  bool
}

func NewFake() *Fake { return &Fake{} }

func (f *Fake) Send(ctx context.Context, jid, text string) (string, error) {
	f.mu.Lock()
	f.inFlight++
	if f.inFlight > f.maxConcurrent {
		f.maxConcurrent = f.inFlight
	}
	f.mu.Unlock()

	defer func() {
		f.mu.Lock()
		f.inFlight--
		f.mu.Unlock()
	}()

	if f.BlockForever {
		<-ctx.Done()
		return "", ctx.Err()
	}
	time.Sleep(time.Millisecond)

	f.mu.Lock()
	id := fmt.Sprintf("fake-%d", len(f.sent))
	f.sent = append(f.sent, jid)
	f.mu.Unlock()
	return id, nil
}

func (f *Fake) Connected() bool { return !f.BlockForever }

func (f *Fake) Sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.sent))
	copy(out, f.sent)
	return out
}

func (f *Fake) MaxConcurrent() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.maxConcurrent
}
```

Create `services/wa-agent-bridge/wa/queue.go`:

```go
package wa

import (
	"context"
	"errors"
	"math/rand"
	"sync"
	"time"
)

var ErrSendTimeout = errors.New("send timed out")

// QueueOpts controls pacing. The delay is length-proportional plus jitter so
// the traffic pattern resembles a person typing rather than a loop emitting.
// This is the one genuine benefit browser automation was supposed to provide,
// obtained here without a browser.
type QueueOpts struct {
	MinGap       time.Duration // floor between consecutive sends
	PerRuneDelay time.Duration // added per rune of the message
	Jitter       time.Duration // uniform random extra, 0 disables
	Timeout      time.Duration // per-send ceiling
}

// Queue serialises every send onto one socket.
//
// Two independent reasons. Concurrent sendMessage calls race inside the
// underlying library, and unpaced bursts are a bot signal. One queue solves
// both, and a timeout means a hung send surfaces as an ambiguous result rather
// than blocking the service forever.
type Queue struct {
	mu       sync.Mutex
	t        Transport
	opts     QueueOpts
	lastSent time.Time
}

func NewQueue(t Transport, opts QueueOpts) *Queue {
	return &Queue{t: t, opts: opts}
}

func (q *Queue) Send(ctx context.Context, jid, text string) (string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if wait := q.waitFor(text); wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}

	timeout := q.opts.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	sendCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	type result struct {
		id  string
		err error
	}
	done := make(chan result, 1)
	go func() {
		id, err := q.t.Send(sendCtx, jid, text)
		done <- result{id, err}
	}()

	select {
	case r := <-done:
		q.lastSent = time.Now()
		return r.id, r.err
	case <-sendCtx.Done():
		q.lastSent = time.Now()
		// Deliberately NOT retried here. A timed-out send may or may not have
		// been delivered; retrying risks messaging the contact twice. The
		// caller reports this as ambiguous.
		return "", ErrSendTimeout
	}
}

func (q *Queue) waitFor(text string) time.Duration {
	delay := q.opts.MinGap
	delay += time.Duration(len([]rune(text))) * q.opts.PerRuneDelay
	if q.opts.Jitter > 0 {
		delay += time.Duration(rand.Int63n(int64(q.opts.Jitter)))
	}
	if q.lastSent.IsZero() {
		return 0
	}
	elapsed := time.Since(q.lastSent)
	if elapsed >= delay {
		return 0
	}
	return delay - elapsed
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/wa-agent-bridge && go test ./wa/... -race -v
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add services/wa-agent-bridge/wa
git commit -m "Add the transport interface and a paced, serialised send queue"
```

---

## Task 10: HTTP API with per-consumer bearer auth

**Files:**
- Create: `services/wa-agent-bridge/config/config.go`
- Create: `services/wa-agent-bridge/api/server.go`
- Create: `services/wa-agent-bridge/api/handlers.go`
- Test: `services/wa-agent-bridge/api/handlers_test.go`

**Interfaces:**
- Consumes: `rails.Engine`, `rails.Store`, `wa.Queue`.
- Produces: `config.Consumer{Name, Token, WebhookURL}`, `config.Load() (Config, error)`, `api.New(deps Deps) http.Handler`, `api.Deps{Engine, Store, Sender, Consumers, Now}`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/api/handlers_test.go`:

```go
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

type stubSender struct{ calls int }

func (s *stubSender) Send(ctx context.Context, jid, text string) (string, error) {
	s.calls++
	return "sent-1", nil
}

func testHandler(t *testing.T) (http.Handler, *store.Memory, *stubSender) {
	t.Helper()
	st := store.NewMemory()
	sender := &stubSender{}
	h := New(Deps{
		Engine: rails.NewEngine(st, rails.Config{
			PerContactPerDay: 10, ConsecutiveMax: 3, GlobalDailyCap: 150,
			Location: time.UTC,
			Budgets:  map[string]rails.ConsumerBudget{"hermes": {PerHour: 100, PerDay: 500}},
		}),
		Store:  st,
		Sender: sender,
		Consumers: []config.Consumer{
			{Name: "hermes", Token: "tok-hermes"},
		},
		Now: func() time.Time { return time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC) },
	})
	return h, st, sender
}

func post(h http.Handler, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSendRequiresBearerToken(t *testing.T) {
	h, _, _ := testHandler(t)
	rec := post(h, "/v1/send", "", `{"to":"27821234567@s.whatsapp.net","text":"hi"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestSendRejectsUnknownToken(t *testing.T) {
	h, _, _ := testHandler(t)
	rec := post(h, "/v1/send", "nope", `{"to":"27821234567@s.whatsapp.net","text":"hi"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestSendRefusalReturns422WithMachineReadableCode(t *testing.T) {
	h, _, sender := testHandler(t)
	rec := post(h, "/v1/send", "tok-hermes",
		`{"to":"27829999999@s.whatsapp.net","text":"hi","idempotencyKey":"k1"}`)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["refusedBy"] != "reply_only" {
		t.Fatalf("want refusedBy reply_only, got %v", out["refusedBy"])
	}
	if sender.calls != 0 {
		t.Fatal("a refused send must never reach the transport")
	}
}

func TestSendHappyPathRecordsOutbound(t *testing.T) {
	h, st, sender := testHandler(t)
	jid := "27821234567@s.whatsapp.net"
	st.RecordInbound(jid, time.Date(2026, 9, 4, 11, 0, 0, 0, time.UTC))

	rec := post(h, "/v1/send", "tok-hermes",
		`{"to":"`+jid+`","text":"hi","idempotencyKey":"k1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if sender.calls != 1 {
		t.Fatalf("want 1 transport call, got %d", sender.calls)
	}
	n, _ := st.OutboundCountForContact(jid, time.Time{})
	if n != 1 {
		t.Fatalf("outbound not recorded, count=%d", n)
	}
	if _, found, _ := st.LookupIdempotency("k1"); !found {
		t.Fatal("idempotency key not saved; a retry would duplicate")
	}
}

func TestReplayedKeyDoesNotSendTwice(t *testing.T) {
	h, st, sender := testHandler(t)
	jid := "27821234567@s.whatsapp.net"
	st.RecordInbound(jid, time.Date(2026, 9, 4, 11, 0, 0, 0, time.UTC))
	body := `{"to":"` + jid + `","text":"hi","idempotencyKey":"same"}`

	post(h, "/v1/send", "tok-hermes", body)
	rec := post(h, "/v1/send", "tok-hermes", body)

	if rec.Code != http.StatusOK {
		t.Fatalf("replay must succeed idempotently, got %d", rec.Code)
	}
	if sender.calls != 1 {
		t.Fatalf("replay sent again: %d transport calls", sender.calls)
	}
}

func TestKillEndpointStopsSends(t *testing.T) {
	h, st, sender := testHandler(t)
	jid := "27821234567@s.whatsapp.net"
	st.RecordInbound(jid, time.Date(2026, 9, 4, 11, 0, 0, 0, time.UTC))

	if rec := post(h, "/v1/kill", "tok-hermes", `{"on":true}`); rec.Code != http.StatusOK {
		t.Fatalf("kill failed: %d", rec.Code)
	}
	rec := post(h, "/v1/send", "tok-hermes",
		`{"to":"`+jid+`","text":"hi","idempotencyKey":"k2"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 after kill, got %d", rec.Code)
	}
	if sender.calls != 0 {
		t.Fatal("kill switch did not stop the transport")
	}
}

func TestHealthNeedsNoAuthAndReportsKillState(t *testing.T) {
	h, st, _ := testHandler(t)
	st.SetKill(true)
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["killed"] != true {
		t.Fatalf("health must report kill state, got %v", out)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./api/...
```
Expected: FAIL — `undefined: New`.

- [ ] **Step 3: Write the config package**

Create `services/wa-agent-bridge/config/config.go`:

```go
// Package config turns environment variables into typed configuration.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// Consumer is one registered caller. Each holds its own token, budget and
// inbound webhook, which is what allows one to be throttled or killed without
// silencing the other — and what makes "which consumer caused this" answerable
// from the logs.
type Consumer struct {
	Name       string
	Token      string
	WebhookURL string
	PerHour    int
	PerDay     int
}

type Config struct {
	ListenAddr string
	DBPath     string
	SessionDir string
	OwnerJID   string
	Consumers  []Consumer
	Rails      rails.Config
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Load reads configuration from the environment.
//
// CONSUMERS format: "name|token|webhookURL|perHour|perDay", comma-separated.
// Pipe-separated rather than colon-separated because a webhook URL carries a
// port, and splitting a URL on ":" mangles it.
//
//	CONSUMERS=hermes|tok-abc|http://127.0.0.1:8787/wa-inbound|100|500
func Load() (Config, error) {
	tz := os.Getenv("QUIET_TZ")
	if tz == "" {
		tz = "Africa/Johannesburg"
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return Config{}, fmt.Errorf("bad QUIET_TZ %q: %w", tz, err)
	}

	cfg := Config{
		ListenAddr: os.Getenv("LISTEN_ADDR"),
		DBPath:     os.Getenv("DB_PATH"),
		SessionDir: os.Getenv("SESSION_DIR"),
		OwnerJID:   os.Getenv("OWNER_JID"),
		Rails: rails.Config{
			PerContactPerDay: envInt("CAP_PER_CONTACT_PER_DAY", 10),
			ConsecutiveMax:   envInt("CAP_CONSECUTIVE", 3),
			GlobalDailyCap:   envInt("CAP_GLOBAL_DAILY", 150),
			QuietStartHour:   envInt("QUIET_START_HOUR", 21),
			QuietEndHour:     envInt("QUIET_END_HOUR", 7),
			Location:         loc,
			Budgets:          map[string]rails.ConsumerBudget{},
		},
	}
	if cfg.ListenAddr == "" {
		// Loopback by default. This service must never be publicly routable:
		// its only authentication is a bearer token.
		cfg.ListenAddr = "127.0.0.1:33020"
	}
	if cfg.DBPath == "" {
		cfg.DBPath = "./wa-agent-bridge.db"
	}
	if cfg.SessionDir == "" {
		cfg.SessionDir = "./session"
	}

	raw := os.Getenv("CONSUMERS")
	if strings.TrimSpace(raw) == "" {
		return Config{}, fmt.Errorf("CONSUMERS is required")
	}
	for _, entry := range strings.Split(raw, ",") {
		parts := strings.Split(strings.TrimSpace(entry), "|")
		if len(parts) < 2 {
			return Config{}, fmt.Errorf(
				"bad CONSUMERS entry %q (want name|token|webhook|perHour|perDay)", entry)
		}
		c := Consumer{Name: parts[0], Token: parts[1], PerHour: 100, PerDay: 500}
		if len(parts) >= 3 {
			c.WebhookURL = parts[2]
		}
		if len(parts) >= 4 {
			c.PerHour, _ = strconv.Atoi(parts[3])
		}
		if len(parts) >= 5 {
			c.PerDay, _ = strconv.Atoi(parts[4])
		}
		if c.Token == "" {
			return Config{}, fmt.Errorf("consumer %q has an empty token", c.Name)
		}
		cfg.Consumers = append(cfg.Consumers, c)
		cfg.Rails.Budgets[c.Name] = rails.ConsumerBudget{PerHour: c.PerHour, PerDay: c.PerDay}
	}
	return cfg, nil
}
```

- [ ] **Step 4: Write the API**

Create `services/wa-agent-bridge/api/server.go`:

```go
// Package api exposes the bridge over HTTP. Authentication is a per-consumer
// bearer token, which is only adequate because the listener binds to loopback
// or Tailscale — never to a public interface.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
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
	// holding a send-capable token.
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("POST /v1/send", s.authed(s.handleSend))
	mux.HandleFunc("POST /v1/allowlist", s.authed(s.handleAllowlist))
	mux.HandleFunc("POST /v1/kill", s.authed(s.handleKill))
	return mux
}

type authedHandler func(w http.ResponseWriter, r *http.Request, consumer config.Consumer)

// authed resolves the bearer token to a registered consumer. Comparison is
// constant-time: these tokens are long-lived and the endpoint is reachable
// from anything on the Tailscale network.
func (s *server) authed(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if len(header) <= len(prefix) || header[:len(prefix)] != prefix {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing bearer token"})
			return
		}
		token := header[len(prefix):]
		for _, c := range s.deps.Consumers {
			if subtle.ConstantTimeCompare([]byte(c.Token), []byte(token)) == 1 {
				next(w, r, c)
				return
			}
		}
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unknown token"})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}
```

Create `services/wa-agent-bridge/api/handlers.go`:

```go
package api

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

type sendBody struct {
	To             string `json:"to"`
	Text           string `json:"text"`
	IdempotencyKey string `json:"idempotencyKey"`
}

func (s *server) handleSend(w http.ResponseWriter, r *http.Request, consumer config.Consumer) {
	var body sendBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if body.To == "" || body.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "to and text are required"})
		return
	}

	req := rails.SendRequest{
		To:             body.To,
		Text:           body.Text,
		IdempotencyKey: body.IdempotencyKey,
		Consumer:       consumer.Name,
		Now:            s.deps.Now(),
	}

	decision := s.deps.Engine.Evaluate(req)

	// A replayed key is a success with no send: the caller gets the original
	// message id back so retries converge instead of duplicating.
	if decision.DuplicateOf != "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "messageId": decision.DuplicateOf, "duplicate": true,
		})
		return
	}
	if !decision.Allow {
		// 422 rather than 403: the request was understood and authorised, the
		// rails simply refuse it. refusedBy is machine-readable so the caller
		// can render a real reason.
		log.Printf("send refused consumer=%s to=%s len=%s by=%s",
			consumer.Name, body.To, redactLen(body.Text), decision.RefusedBy)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"ok": false, "refusedBy": string(decision.RefusedBy), "reason": decision.Reason,
		})
		return
	}

	msgID, err := s.deps.Sender.Send(r.Context(), body.To, body.Text)
	if err != nil {
		// Never retried here: a failed or timed-out send may still have been
		// delivered, and a retry would message the contact twice.
		log.Printf("send failed consumer=%s to=%s len=%s err=%v",
			consumer.Name, body.To, redactLen(body.Text), err)
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok": false, "error": err.Error(), "outcome": "ambiguous",
		})
		return
	}

	if err := s.deps.Store.RecordOutbound(body.To, consumer.Name, msgID, req.Now); err != nil {
		log.Printf("WARNING outbound not recorded to=%s err=%v", body.To, err)
	}
	if err := s.deps.Store.SaveIdempotency(body.IdempotencyKey, msgID); err != nil {
		log.Printf("WARNING idempotency not saved key=%s err=%v", body.IdempotencyKey, err)
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "messageId": msgID})
}

type allowlistBody struct {
	JID    string `json:"jid"`
	Remove bool   `json:"remove"`
}

func (s *server) handleAllowlist(w http.ResponseWriter, r *http.Request, _ config.Consumer) {
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
	log.Printf("allowlist jid=%s remove=%v", body.JID, body.Remove)
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

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	killed, err := s.deps.Store.KillState()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	now := s.deps.Now()
	total, _ := s.deps.Store.OutboundCountTotal(now.Add(-24 * time.Hour))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":              true,
		"killed":          killed,
		"outboundLast24h": total,
		"caps":            s.deps.Engine.Config().GlobalDailyCap,
	})
}

// redactLen keeps message bodies out of the log. Bodies belong in Firestore
// where access control applies, not in a plaintext file on a VPS.
func redactLen(s string) string {
	return "" + itoa(len([]rune(s))) + " chars"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd services/wa-agent-bridge && go test ./... -race -v
```
Expected: PASS, all packages.

- [ ] **Step 6: Commit**

```bash
git add services/wa-agent-bridge
git commit -m "Expose the bridge over HTTP with per-consumer bearer auth"
```

---

## Task 11: whatsmeow transport, pairing, and LoggedOut handling

**Files:**
- Modify: `services/wa-agent-bridge/wa/transport.go`
- Create: `services/wa-agent-bridge/wa/whatsmeow.go`
- Test: `services/wa-agent-bridge/wa/whatsmeow_test.go`

**Interfaces:**
- Consumes: `wa.Transport`.
- Produces: `wa.NewClient(sessionDir string, onInbound func(jid, text string, at time.Time), onLoggedOut func()) (*Client, error)` implementing `wa.Transport`, plus `(*Client).Connect(ctx) error` and `(*Client).InReplayWindow() bool`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/wa/whatsmeow_test.go`:

```go
package wa

import (
	"testing"
	"time"
)

// After a reconnect whatsmeow replays recent history. The sibling bridge sent
// duplicate acks for hours because of exactly this. Recording replayed inbound
// is correct; acting on it is not, so the first few minutes after connect are
// receive-only.
func TestReplayWindowSuppressesOutbound(t *testing.T) {
	c := &Client{connectedAt: time.Now()}
	if !c.InReplayWindow() {
		t.Fatal("must be in the replay window immediately after connect")
	}

	c.connectedAt = time.Now().Add(-ReplayWindow - time.Second)
	if c.InReplayWindow() {
		t.Fatal("replay window must expire")
	}
}

func TestNotConnectedIsNotInReplayWindow(t *testing.T) {
	c := &Client{}
	if c.InReplayWindow() {
		t.Fatal("a client that never connected is not replaying")
	}
}

func TestLoggedOutRefusesImmediately(t *testing.T) {
	called := false
	c := &Client{onLoggedOut: func() { called = true }}
	c.connectedAt = time.Now()

	c.handleLoggedOut()

	if c.Connected() {
		t.Fatal("a logged-out client must report disconnected immediately")
	}
	if !called {
		t.Fatal("onLoggedOut callback not fired; the alert would never be sent")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./wa/...
```
Expected: FAIL — `undefined: Client`.

- [ ] **Step 3: Write the implementation**

```bash
cd services/wa-agent-bridge && go get go.mau.fi/whatsmeow@latest
```

Create `services/wa-agent-bridge/wa/whatsmeow.go`:

```go
package wa

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/mdp/qrterminal"
	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

// ReplayWindow is how long after connecting the bridge records inbound without
// letting anything act on it. The sibling bridge's runbook observes that
// history replay finishes within about five minutes of a re-pair; this makes
// that observation a rule rather than advice to wait.
const ReplayWindow = 5 * time.Minute

type Client struct {
	mu          sync.Mutex
	wac         *whatsmeow.Client
	connectedAt time.Time
	loggedOut   bool

	onInbound   func(jid, text string, at time.Time)
	onLoggedOut func()
}

func NewClient(
	sessionDir string,
	onInbound func(jid, text string, at time.Time),
	onLoggedOut func(),
) (*Client, error) {
	logger := waLog.Stdout("wa", "INFO", true)
	container, err := sqlstore.New(
		context.Background(),
		"sqlite3",
		fmt.Sprintf("file:%s/session.db?_foreign_keys=on&_busy_timeout=5000", sessionDir),
		logger,
	)
	if err != nil {
		return nil, fmt.Errorf("open session store: %w", err)
	}
	device, err := container.GetFirstDevice(context.Background())
	if err != nil {
		return nil, fmt.Errorf("get device: %w", err)
	}

	c := &Client{onInbound: onInbound, onLoggedOut: onLoggedOut}
	c.wac = whatsmeow.NewClient(device, logger)
	c.wac.AddEventHandler(c.handleEvent)
	return c, nil
}

// Connect pairs if needed (printing a QR to the terminal) and connects.
func (c *Client) Connect(ctx context.Context) error {
	if c.wac.Store.ID == nil {
		qrChan, _ := c.wac.GetQRChannel(ctx)
		if err := c.wac.Connect(); err != nil {
			return err
		}
		for evt := range qrChan {
			switch evt.Event {
			case "code":
				qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, log.Writer())
			case "success":
				log.Printf("paired successfully")
			}
		}
		return nil
	}
	return c.wac.Connect()
}

func (c *Client) handleEvent(evt any) {
	switch v := evt.(type) {
	case *events.Connected:
		c.mu.Lock()
		c.connectedAt = time.Now()
		c.loggedOut = false
		c.mu.Unlock()
		log.Printf("connected; suppressing outbound for %s while history replays", ReplayWindow)

	case *events.LoggedOut:
		c.handleLoggedOut()

	case *events.Message:
		if v.Info.IsFromMe || v.Info.IsGroup {
			return
		}
		text := v.Message.GetConversation()
		if text == "" {
			if ext := v.Message.GetExtendedTextMessage(); ext != nil {
				text = ext.GetText()
			}
		}
		if text == "" {
			return // non-text events are out of scope
		}
		if c.onInbound != nil {
			c.onInbound(v.Info.Sender.String(), text, v.Info.Timestamp)
		}
	}
}

// handleLoggedOut marks the client dead immediately.
//
// It deliberately does NOT reconnect. A LoggedOut event means the number was
// flagged or manually unlinked; retrying in a loop turns a soft flag into a
// harder block. It also does not queue: a queue that drains after a re-pair
// delivers stale messages to customers.
func (c *Client) handleLoggedOut() {
	c.mu.Lock()
	c.loggedOut = true
	c.connectedAt = time.Time{}
	cb := c.onLoggedOut
	c.mu.Unlock()

	log.Printf("ALERT LoggedOut — outbound stopped, human re-pair required")
	if cb != nil {
		cb()
	}
}

func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loggedOut {
		return false
	}
	return !c.connectedAt.IsZero()
}

func (c *Client) InReplayWindow() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.connectedAt.IsZero() {
		return false
	}
	return time.Since(c.connectedAt) < ReplayWindow
}

func (c *Client) Send(ctx context.Context, jid, text string) (string, error) {
	if !c.Connected() {
		return "", fmt.Errorf("not connected")
	}
	target, err := types.ParseJID(jid)
	if err != nil {
		return "", fmt.Errorf("bad jid: %w", err)
	}
	resp, err := c.wac.SendMessage(ctx, target, &waProto.Message{
		Conversation: proto.String(text),
	})
	if err != nil {
		return "", err
	}
	return resp.ID, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd services/wa-agent-bridge && go test ./wa/... -race -v && go build ./...
```
Expected: PASS, 6 tests in `wa`, clean build.

If the whatsmeow API has drifted (`sqlstore.New` signature, `waE2E` import
path), fix the call sites against `go doc go.mau.fi/whatsmeow` rather than
pinning an older version — recovery speed on protocol changes is why this
library was chosen.

- [ ] **Step 5: Commit**

```bash
git add services/wa-agent-bridge
git commit -m "Add the whatsmeow transport with replay window and LoggedOut handling"
```

---

## Task 12: Inbound webhook fan-out

**Files:**
- Create: `services/wa-agent-bridge/api/webhook.go`
- Test: `services/wa-agent-bridge/api/webhook_test.go`

**Interfaces:**
- Consumes: `config.Consumer`, `rails.Store`.
- Produces: `api.NewFanout(consumers []config.Consumer, st rails.Store, inReplayWindow func() bool) *Fanout` and `(*Fanout).Deliver(jid, text string, at time.Time)`.

- [ ] **Step 1: Write the failing test**

Create `services/wa-agent-bridge/api/webhook_test.go`:

```go
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func TestFanoutRecordsInboundAndPostsToConsumers(t *testing.T) {
	var mu sync.Mutex
	var got []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		st,
		func() bool { return false },
	)

	jid := "27821234567@s.whatsapp.net"
	f.Deliver(jid, "hello", time.Now())
	f.Wait()

	ok, _ := st.HasInboundFrom(jid)
	if !ok {
		t.Fatal("inbound must be recorded — reply-only depends on it")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("want 1 webhook delivery, got %d", len(got))
	}
	if got[0]["from"] != jid {
		t.Fatalf("wrong from: %v", got[0])
	}
}

// During history replay the inbound must still be recorded (so reply-only
// stays accurate) but must NOT wake a consumer, or a reconnect re-answers
// every message from the last day.
func TestFanoutRecordsButDoesNotNotifyDuringReplay(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
	}))
	defer srv.Close()

	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "hermes", Token: "t", WebhookURL: srv.URL}},
		st,
		func() bool { return true }, // in replay window
	)

	jid := "27821234567@s.whatsapp.net"
	f.Deliver(jid, "hello", time.Now())
	f.Wait()

	ok, _ := st.HasInboundFrom(jid)
	if !ok {
		t.Fatal("replayed inbound must still be recorded")
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 0 {
		t.Fatalf("replayed inbound must not notify consumers, got %d calls", calls)
	}
}

func TestFanoutSkipsConsumersWithNoWebhook(t *testing.T) {
	st := store.NewMemory()
	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "t"}}, // no WebhookURL
		st,
		func() bool { return false },
	)
	f.Deliver("27821234567@s.whatsapp.net", "hi", time.Now())
	f.Wait() // must not panic or block
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/wa-agent-bridge && go test ./api/...
```
Expected: FAIL — `undefined: NewFanout`.

- [ ] **Step 3: Write the implementation**

Create `services/wa-agent-bridge/api/webhook.go`:

```go
package api

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// Fanout records every inbound message and forwards it to each registered
// consumer's webhook.
//
// Recording happens unconditionally; forwarding does not. During the replay
// window after a reconnect, whatsmeow re-delivers recent history — recording
// it keeps reply-only accurate, but waking a consumer would have it answer a
// day's worth of old messages. That is a real incident from the sibling
// bridge, not a hypothetical.
type Fanout struct {
	consumers      []config.Consumer
	store          rails.Store
	inReplayWindow func() bool
	client         *http.Client
	wg             sync.WaitGroup
}

func NewFanout(consumers []config.Consumer, st rails.Store, inReplayWindow func() bool) *Fanout {
	return &Fanout{
		consumers:      consumers,
		store:          st,
		inReplayWindow: inReplayWindow,
		client:         &http.Client{Timeout: 10 * time.Second},
	}
}

func (f *Fanout) Deliver(jid, text string, at time.Time) {
	if err := f.store.RecordInbound(jid, at); err != nil {
		log.Printf("WARNING inbound not recorded jid=%s err=%v", jid, err)
	}

	if f.inReplayWindow() {
		log.Printf("inbound during replay window jid=%s len=%s — recorded, not forwarded",
			jid, redactLen(text))
		return
	}

	payload, err := json.Marshal(map[string]any{
		"from": jid,
		"text": text,
		"at":   at.UTC().Format(time.RFC3339),
	})
	if err != nil {
		log.Printf("WARNING inbound payload marshal failed jid=%s err=%v", jid, err)
		return
	}

	for _, c := range f.consumers {
		if c.WebhookURL == "" {
			continue
		}
		f.wg.Add(1)
		go func(c config.Consumer) {
			defer f.wg.Done()
			req, err := http.NewRequest(http.MethodPost, c.WebhookURL, bytes.NewReader(payload))
			if err != nil {
				log.Printf("WARNING webhook request build failed consumer=%s err=%v", c.Name, err)
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+c.Token)
			resp, err := f.client.Do(req)
			if err != nil {
				log.Printf("WARNING webhook delivery failed consumer=%s err=%v", c.Name, err)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode >= 300 {
				log.Printf("WARNING webhook consumer=%s status=%d", c.Name, resp.StatusCode)
			}
		}(c)
	}
}

// Wait blocks until in-flight deliveries finish. Used by tests and by shutdown.
func (f *Fanout) Wait() { f.wg.Wait() }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd services/wa-agent-bridge && go test ./api/... -race -v
```
Expected: PASS, all API tests.

- [ ] **Step 5: Commit**

```bash
git add services/wa-agent-bridge/api
git commit -m "Fan inbound messages out to consumers, muted during history replay"
```

---

## Task 13: Wire main, systemd unit, backup, and the runbook

**Files:**
- Create: `services/wa-agent-bridge/main.go`
- Create: `services/wa-agent-bridge/deploy/wa-agent-bridge.service`
- Create: `services/wa-agent-bridge/deploy/backup.sh`
- Create: `services/wa-agent-bridge/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a runnable binary.

- [ ] **Step 1: Write main.go**

Create `services/wa-agent-bridge/main.go`:

```go
// Command wa-agent-bridge pairs to a dedicated WhatsApp number and exposes it
// to registered consumers behind a set of safety rails.
//
// This file is wiring only. Decisions live in rails/, persistence in store/,
// the socket in wa/, and HTTP in api/. Keeping main small is deliberate: the
// sibling bridge's main.go reached 118 KB and became the reason nothing in it
// could be tested.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/api"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/wa"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	st, err := store.OpenSQLite(cfg.DBPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	engine := rails.NewEngine(st, cfg.Rails)

	var client *wa.Client
	fanout := api.NewFanout(cfg.Consumers, st, func() bool {
		return client != nil && client.InReplayWindow()
	})

	client, err = wa.NewClient(
		cfg.SessionDir,
		func(jid, text string, at time.Time) { fanout.Deliver(jid, text, at) },
		func() {
			// The number is gone. Refuse outbound until a human re-pairs, and
			// make sure the state survives a restart.
			if err := st.SetKill(true); err != nil {
				log.Printf("WARNING could not set kill after LoggedOut: %v", err)
			}
		},
	)
	if err != nil {
		log.Fatalf("whatsapp client: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := client.Connect(ctx); err != nil {
		log.Fatalf("connect: %v", err)
	}

	queue := wa.NewQueue(client, wa.QueueOpts{
		MinGap:       2 * time.Second,
		PerRuneDelay: 20 * time.Millisecond,
		Jitter:       1500 * time.Millisecond,
		Timeout:      30 * time.Second,
	})

	handler := api.New(api.Deps{
		Engine:    engine,
		Store:     st,
		Sender:    queue,
		Consumers: cfg.Consumers,
		Now:       time.Now,
	})

	srv := &http.Server{Addr: cfg.ListenAddr, Handler: handler}
	go func() {
		log.Printf("listening on %s", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	srv.Shutdown(shutdownCtx)
	fanout.Wait()
}
```

- [ ] **Step 2: Verify it builds and the whole suite passes**

```bash
cd services/wa-agent-bridge && go vet ./... && go test ./... -race && go build -o /tmp/wa-agent-bridge ./...
```
Expected: clean vet, all tests PASS, binary produced.

- [ ] **Step 3: Write the systemd unit**

Create `services/wa-agent-bridge/deploy/wa-agent-bridge.service`:

```ini
[Unit]
Description=WhatsApp agent bridge (rails-guarded)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wabridge
WorkingDirectory=/opt/wa-agent-bridge
EnvironmentFile=/opt/wa-agent-bridge/.env
ExecStart=/opt/wa-agent-bridge/wa-agent-bridge
Restart=on-failure
RestartSec=15
StandardOutput=append:/opt/wa-agent-bridge/bridge.log
StandardError=append:/opt/wa-agent-bridge/bridge.log

# The bridge holds a WhatsApp session and a token file; nothing else on the box
# needs to read them.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/wa-agent-bridge

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Write the backup script**

Create `services/wa-agent-bridge/deploy/backup.sh`:

```bash
#!/usr/bin/env bash
# Nightly off-box backup of the session and rail state.
#
# A corrupted session store otherwise costs a re-pair and the message history
# that reply-only depends on — which would silently open the number to every
# contact whose inbound history was lost.
set -euo pipefail

SRC=/opt/wa-agent-bridge
DEST=${1:?usage: backup.sh user@host:/path}
STAMP=$(date -u +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# sqlite3 .backup is safe against a live writer; cp is not.
sqlite3 "$SRC/wa-agent-bridge.db" ".backup '$TMP/rails-$STAMP.db'"
sqlite3 "$SRC/session/session.db" ".backup '$TMP/session-$STAMP.db'"

rsync -a "$TMP/" "$DEST/"
echo "backed up rails+session at $STAMP"
```

Make it executable: `chmod +x services/wa-agent-bridge/deploy/backup.sh`

- [ ] **Step 5: Write the runbook**

Create `services/wa-agent-bridge/README.md`:

````markdown
# wa-agent-bridge

A dedicated WhatsApp number, guarded by safety rails, exposed to registered
consumers over HTTP.

**This is an unofficial rail.** It pairs as a linked device via `whatsmeow` and
violates WhatsApp's terms of service. It exists because the official rails
cannot support conversational agent replies without templates. Read
`docs/superpowers/specs/2026-09-04-whatsapp-bridge-rail-design.md` before
changing anything in `rails/`.

## Why the rails exist

On 2026-09-04 the sibling bridge's number was logged out 12 times in one window
after roughly 120 outbound DMs to people who had never messaged it. The same
number, on the same library, had run a reply-only path for months without
incident. The ban signal is behavioural. Every rail in `rails/` encodes one
lesson from that.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `LISTEN_ADDR` | `127.0.0.1:33020` | Never bind this publicly |
| `DB_PATH` | `./wa-agent-bridge.db` | Rail state |
| `SESSION_DIR` | `./session` | whatsmeow session store |
| `OWNER_JID` | — | The owner's JID (phase 1) |
| `CONSUMERS` | — | `name\|token\|webhookURL\|perHour\|perDay`, comma-separated |
| `CAP_PER_CONTACT_PER_DAY` | `10` | Rail 5 |
| `CAP_CONSECUTIVE` | `3` | Rail 5 |
| `CAP_GLOBAL_DAILY` | `150` | Rail 6 |
| `QUIET_START_HOUR` / `QUIET_END_HOUR` | `21` / `7` | Rail 8; equal values disable |
| `QUIET_TZ` | `Africa/Johannesburg` | Local time for quiet hours |

## First pairing

1. `systemctl stop wa-agent-bridge` (if running).
2. Run in the foreground: `cd /opt/wa-agent-bridge && ./wa-agent-bridge`
3. A QR appears. On the phone holding the dedicated number:
   **WhatsApp → Settings → Linked Devices → Link a device**, scan it.
4. Wait for `paired successfully`, then `connected`.
5. Ctrl-C, `systemctl start wa-agent-bridge`.

## Re-pairing after a LoggedOut

A `LoggedOut` sets the kill switch and stops outbound. It does **not**
auto-reconnect: retrying in a loop turns a soft flag into a harder block.

1. Read the log: `grep LoggedOut /opt/wa-agent-bridge/bridge.log | tail`.
2. Establish *why* before re-pairing. If rail refusals were spiking beforehand,
   a consumer was looping — fix that first or the new number goes the same way.
3. On the phone: **Linked Devices** → remove the dead session. WhatsApp allows
   only four; stale ones make a new scan fail with "can't link device right now".
4. Re-pair as above.
5. Clear the kill switch:
   `curl -XPOST -H "Authorization: Bearer $TOKEN" -d '{"on":false}' localhost:33020/v1/kill`

## Number swap

No external system stores the phone number as an identity key, so a swap is:
pair the new number, update nothing else. The rail state in `wa-agent-bridge.db`
carries inbound history per JID and stays valid — contacts keep their
reply-only status.

## Health and alerting

`GET /v1/health` needs no auth so an off-box monitor can poll it. Alert on:

1. `killed: true` unexpectedly (a `LoggedOut` sets it).
2. No inbound for N hours while connected — the silent-failure class.
3. Rail refusals spiking — a looping consumer, the early warning that used to
   arrive as a ban.

Alerts must **not** route over WhatsApp. An alerting path that runs over the
failing transport is not an alerting path.

## What this service must never do

- Log message bodies. Use `redactLen`.
- Retry a failed or timed-out send. It may already have been delivered.
- Auto-reconnect after `LoggedOut`.
- Queue messages while disconnected.
- Bind to a public interface.
````

- [ ] **Step 6: Commit**

```bash
git add services/wa-agent-bridge
git commit -m "Wire the bridge binary and ship its deploy unit, backup and runbook"
```

---

## Task 14: Hermes control-surface consumer

**Files:**
- Create: `~/.hermes/scripts/wa-agent-consumer.mjs` (outside the repo — Hermes-local)
- Create: `services/wa-agent-bridge/docs/hermes-consumer.md` (the contract, in-repo)

**Interfaces:**
- Consumes: the bridge's `POST /v1/send` and inbound webhook payload `{from, text, at}`.
- Produces: nothing other code imports.

- [ ] **Step 1: Document the consumer contract in-repo**

Create `services/wa-agent-bridge/docs/hermes-consumer.md`:

````markdown
# Hermes control-surface consumer

Phase 1's only consumer. Hermes receives the owner's WhatsApp messages and
replies as the agent.

## Registration

```
CONSUMERS=hermes|<token>|http://127.0.0.1:8787/wa-inbound|100|500
```

## Inbound contract

The bridge POSTs, with `Authorization: Bearer <token>`:

```json
{ "from": "27821234567@s.whatsapp.net", "text": "check the velo inbox", "at": "2026-09-04T12:00:00Z" }
```

The consumer MUST verify the bearer token before acting.

## Owner gate

Phase 1's number is unpublished. The consumer replies **only** when `from`
equals `OWNER_JID`; anything else is logged and dropped. The bridge's rails
would still refuse an outbound to a stranger, but relying on that would mean an
unknown sender could burn budget and fill the logs.

## Outbound contract

```
POST /v1/send
Authorization: Bearer <token>
{ "to": "<jid>", "text": "...", "idempotencyKey": "<stable per logical message>" }
```

Responses:

| Status | Meaning | Action |
|---|---|---|
| 200 `{ok:true, messageId}` | sent | done |
| 200 `{ok:true, duplicate:true}` | replay of a key already used | done, do not resend |
| 422 `{refusedBy, reason}` | a rail refused | surface `reason`; never retry |
| 502 `{outcome:"ambiguous"}` | may or may not have been delivered | **do not retry** — reuse the same key if you must |

`idempotencyKey` is mandatory. Derive it from the logical message
(e.g. `turn-<conversationId>-<turnIndex>`), never from a timestamp, or a retry
produces a new key and duplicates the message.

## Required consumer behaviour

**Immediate ack.** An agent turn can take minutes. Send a short ack first, then
the result. Two minutes of silence reads as broken and provokes a re-send that
duplicates the work.

**Length budget.** Terminal output pasted into WhatsApp is unreadable. Cap
replies at ~1200 characters, truncate, and offer `reply MORE`.

**Quoted-reply correlation.** Every outbound carries a `messageId`. When the
owner long-press-replies, the inbound carries `quotedMessageId`. That is the
correlation key: it attaches an answer to a *specific* prior message rather than
the most recent one. Phase 2's approval gate depends on this, so it must work
before phase 2 begins.

> Note: the phase-1 bridge does not yet forward `quotedMessageId` — the inbound
> payload above carries `from`, `text`, `at`. Adding it is the first task of the
> phase-2 plan, alongside the LeadStack provider. Phase 1 proves the ergonomics
> with unquoted replies.
````

- [ ] **Step 2: Write the Hermes consumer**

Create `~/.hermes/scripts/wa-agent-consumer.mjs`:

```javascript
// Phase 1 control surface: the owner's WhatsApp messages reach Hermes, and
// Hermes replies. Registered with the bridge as consumer "hermes".
//
// Deliberately small. All safety lives in the bridge; this file's only
// security responsibility is the owner gate and the shared token.
import http from 'node:http';

const PORT = Number(process.env.WA_CONSUMER_PORT || 8787);
const BRIDGE = process.env.WA_BRIDGE_URL || 'http://127.0.0.1:33020';
const TOKEN = process.env.WA_BRIDGE_TOKEN;
const OWNER_JID = process.env.OWNER_JID;
const MAX_REPLY_CHARS = 1200;

if (!TOKEN || !OWNER_JID) {
  console.error('WA_BRIDGE_TOKEN and OWNER_JID are required');
  process.exit(1);
}

async function send(to, text, idempotencyKey) {
  const body = text.length > MAX_REPLY_CHARS
    ? `${text.slice(0, MAX_REPLY_CHARS)}\n\n[truncated — reply MORE]`
    : text;

  const res = await fetch(`${BRIDGE}/v1/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ to, text: body, idempotencyKey }),
  });
  const json = await res.json().catch(() => ({}));

  if (res.status === 422) {
    // A rail refused. Never retry — the refusal is deliberate.
    console.warn(`[wa] refused by=${json.refusedBy} reason=${json.reason}`);
  } else if (!res.ok) {
    console.warn(`[wa] send failed status=${res.status} outcome=${json.outcome ?? 'unknown'}`);
  }
  return json;
}

let turn = 0;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/wa-inbound')) {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end();
    return;
  }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    // Always 200 quickly: the bridge should never block on agent work.
    res.writeHead(200).end();

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn('[wa] bad inbound payload');
      return;
    }

    // Owner gate. The number is unpublished in phase 1; anything else is noise
    // or a probe.
    if (msg.from !== OWNER_JID) {
      console.warn(`[wa] dropped non-owner inbound from=${msg.from}`);
      return;
    }

    const id = ++turn;
    // Immediate ack — silence for minutes reads as broken.
    await send(msg.from, 'on it…', `ack-${id}`);

    try {
      const answer = await runHermesTurn(msg.text);
      await send(msg.from, answer, `turn-${id}`);
    } catch (err) {
      await send(msg.from, `that failed: ${err.message}`, `err-${id}`);
    }
  });
});

// Replace with the real Hermes agent entry point. Kept as a named seam so the
// transport can be tested independently of the agent.
async function runHermesTurn(text) {
  const { runTurn } = await import('../lib/agent.mjs');
  return runTurn(text);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[wa] consumer listening on 127.0.0.1:${PORT}`);
});
```

- [ ] **Step 3: Manual end-to-end verification**

This cannot be unit-tested — it needs two real phones. Run through it and record
the result in the PR description:

1. Start the bridge, pair the dedicated number.
2. Start the consumer with `OWNER_JID` set to your personal number's JID.
3. DM the dedicated number from your phone. Confirm: `on it…` arrives within
   seconds, then the answer.
4. Restart the bridge mid-conversation. Confirm no duplicate replies in the five
   minutes after reconnect (the replay window).
5. From a *different* phone, DM the dedicated number. Confirm it is dropped and
   logged, with no reply.
6. `POST /v1/kill {"on":true}`. Confirm the next agent reply is refused with
   `kill_switch` and nothing is delivered. Set it back to `false`.
7. Send 4 messages in a row without replying from the phone. Confirm the 4th is
   refused with `consecutive_cap`.

- [ ] **Step 4: Commit**

```bash
git add services/wa-agent-bridge/docs
git commit -m "Document the Hermes consumer contract and its owner gate"
```

The `.mjs` file lives in `~/.hermes` and is not committed to this repo.

---

## Task 15: Off-box health monitor

**Files:**
- Create: `services/wa-agent-bridge/deploy/monitor.sh`

**Interfaces:**
- Consumes: `GET /v1/health`.
- Produces: nothing.

- [ ] **Step 1: Write the monitor**

Create `services/wa-agent-bridge/deploy/monitor.sh`:

```bash
#!/usr/bin/env bash
# Off-box health monitor. Run from cron on a DIFFERENT machine to the bridge —
# a monitor on the same box dies with the thing it monitors.
#
# Alerts go to Bugsink, never over WhatsApp: an alerting path that runs over
# the failing transport is not an alerting path.
set -euo pipefail

HEALTH_URL=${HEALTH_URL:?set HEALTH_URL, e.g. http://bridge-host:33020/v1/health}
BUGSINK_DSN=${BUGSINK_DSN:?set BUGSINK_DSN}
MAX_INBOUND_SILENCE_HOURS=${MAX_INBOUND_SILENCE_HOURS:-12}

alert() {
  local msg="$1"
  echo "ALERT: $msg" >&2
  curl -sS -m 10 -X POST "$BUGSINK_DSN" \
    -H 'content-type: application/json' \
    -d "$(printf '{"message":%s,"level":"error","logger":"wa-agent-bridge-monitor"}' \
          "$(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    >/dev/null || echo "WARNING: could not reach Bugsink" >&2
}

if ! body=$(curl -sS -m 10 "$HEALTH_URL"); then
  alert "wa-agent-bridge health endpoint unreachable at $HEALTH_URL"
  exit 1
fi

killed=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("killed"))')
if [ "$killed" = "True" ]; then
  alert "wa-agent-bridge kill switch is ON — outbound stopped (a LoggedOut sets this)"
fi

echo "ok: $body"
```

Make it executable: `chmod +x services/wa-agent-bridge/deploy/monitor.sh`

Cron entry, on a different host:

```
*/5 * * * * HEALTH_URL=http://bridge-host:33020/v1/health BUGSINK_DSN=... /path/to/monitor.sh
```

- [ ] **Step 2: Verify it runs against a live bridge**

```bash
cd services/wa-agent-bridge && go build -o /tmp/wab ./... && \
  CONSUMERS='hermes|t|http://127.0.0.1:9/x|10|50' DB_PATH=/tmp/wab.db SESSION_DIR=/tmp/wabsess \
  /tmp/wab &
sleep 2
curl -sS localhost:33020/v1/health
```
Expected: `{"caps":150,"killed":false,"ok":true,"outboundLast24h":0}`.

Kill the background process afterwards by PID — never `pkill -f`.

- [ ] **Step 3: Commit**

```bash
git add services/wa-agent-bridge/deploy
git commit -m "Add an off-box health monitor that alerts to Bugsink, not WhatsApp"
```

---

## Definition of done for Phase 1

- [ ] `go vet ./... && go test ./... -race && go build ./...` clean in `services/wa-agent-bridge`.
- [ ] `pnpm ci:check` still clean at the repo root (this plan touches no TypeScript).
- [ ] The CI workflow runs on a PR touching `services/wa-agent-bridge/**` and does NOT run on one that does not.
- [ ] Manual end-to-end checklist in Task 14 Step 3 completed, results recorded in the PR description.
- [ ] Blind `/review` dispatched and its findings addressed.
- [ ] Off-box monitor installed on a different host, alerting verified by killing the bridge once.
- [ ] Nightly backup cron installed, and one restore rehearsed from the backup.

**Merge gate:** Phase 1 is inside the Level-3 boundary — greenfield, not
customer-facing, no live client data, verified by tests that fail when the code
is wrong. Green CI plus an approved blind `/review` is sufficient.

**Soak before Phase 2:** run this alone for at least two weeks. Confirm the
session survives restarts and a re-pair, reconnects produce no duplicate sends,
rails refuse correctly under real traffic, pacing feels human, and the
approval-by-reply ergonomics are comfortable. If the number is flagged doing
only this, stop — the concept is invalid and Phase 2 must not begin.
