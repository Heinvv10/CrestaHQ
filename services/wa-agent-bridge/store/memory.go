// Package store persists the state the rails consult. Two implementations:
// Memory for tests, SQLite for production.
package store

import (
	"errors"
	"sort"
	"sync"
	"time"
)

type event struct {
	at       time.Time
	outbound bool
	consumer string
	msgID    string
	// slotKey ties a reserved outbound row back to the idempotency key that
	// reserved it, so exactly that row can be released or confirmed later.
	// Empty on inbound rows and on rows written directly by RecordOutbound.
	slotKey string
}

// ReservationLease is how long an idempotency reservation may sit with no
// message id recorded against it before another caller may reclaim the key.
//
// It is three times the 30s per-send ceiling the bridge allows a provider
// call. A send that has not returned within three of its own timeouts is not
// slow, it is gone: the process was killed, the container was rescheduled, or
// the goroutine panicked. Without a lease that key is dead forever and the
// only recovery is hand-editing SQLite on a production box.
//
// It must stay comfortably ABOVE the send ceiling. Set it below and a merely
// slow send gets its key stolen by a retry while it is still in flight, which
// is a double-send — the exact failure this whole rail exists to prevent.
const ReservationLease = 90 * time.Second

// ErrNoReservation is returned by SaveIdempotency when the key holds no
// reservation the caller owns. A save without a won reservation would
// fabricate a completed send out of nothing, so it fails loudly instead.
var ErrNoReservation = errors.New("store: no owned reservation for this idempotency key")

// reservation is one idempotency row. An empty msgID means the send is still
// in flight; reservedAt is when it was claimed, which is what makes a stranded
// reservation reclaimable rather than permanent.
type reservation struct {
	msgID      string
	jid        string // the ONE recipient this key is bound to
	reservedAt time.Time
}

// Memory is a test double. It is NOT suitable for production: everything it
// knows dies with the process, which is exactly the bug the SQLite store
// exists to avoid.
type Memory struct {
	mu        sync.Mutex
	events    map[string][]event
	allowlist map[string]bool
	idem      map[string]reservation
	kill      bool
}

func NewMemory() *Memory {
	return &Memory{
		events:    map[string][]event{},
		allowlist: map[string]bool{},
		idem:      map[string]reservation{},
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

// RecordOutbound is test-only seeding; see the Store interface doc in
// rails/types.go. It must not be called on a send path.
func (m *Memory) RecordOutbound(jid, consumer, messageID string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.append(jid, event{at: at, outbound: true, consumer: consumer, msgID: messageID})
	return nil
}

// ReserveOutboundSlot writes the counted outbound row at reservation time.
// It is an ordinary outbound event, so every volume rail sees it immediately —
// which is the entire point: budget spent at reservation binds across callers,
// budget spent after the send does not.
func (m *Memory) ReserveOutboundSlot(storageKey, jid, consumer string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.append(jid, event{at: at, outbound: true, consumer: consumer, slotKey: storageKey})
	return nil
}

// ReleaseOutboundSlot returns the budget of a send that provably never left.
// It removes the MOST RECENT unconfirmed row for the key: a slot stranded by
// an earlier timeout belongs to a message that may have been delivered, and
// must keep its budget.
func (m *Memory) ReleaseOutboundSlot(storageKey string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	jid, i, ok := m.findSlot(storageKey)
	if !ok {
		return nil
	}
	m.events[jid] = append(m.events[jid][:i], m.events[jid][i+1:]...)
	return nil
}

// ConfirmOutboundSlot stamps the message id on a reserved row. No count moves:
// the row was already counted at reservation.
func (m *Memory) ConfirmOutboundSlot(storageKey, messageID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	jid, i, ok := m.findSlot(storageKey)
	if !ok {
		return nil
	}
	m.events[jid][i].slotKey = ""
	m.events[jid][i].msgID = messageID
	return nil
}

// findSlot locates the newest still-unconfirmed slot row for a key. Callers
// must hold m.mu.
func (m *Memory) findSlot(storageKey string) (string, int, bool) {
	for jid, evts := range m.events {
		for i := len(evts) - 1; i >= 0; i-- {
			if evts[i].slotKey == storageKey {
				return jid, i, true
			}
		}
	}
	return "", 0, false
}

func (m *Memory) LastInboundAt() (time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var last time.Time
	for _, evts := range m.events {
		for _, e := range evts {
			if !e.outbound && e.at.After(last) {
				last = e.at
			}
		}
	}
	return last, nil
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

func (m *Memory) ListAllowlist() ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.allowlist))
	for jid := range m.allowlist {
		out = append(out, jid)
	}
	sort.Strings(out)
	return out, nil
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
