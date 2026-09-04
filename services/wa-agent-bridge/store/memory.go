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

func (m *Memory) RecordOutbound(jid, consumer, messageID string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.append(jid, event{at: at, outbound: true, consumer: consumer})
	return nil
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

func (m *Memory) LookupIdempotency(key string) (string, string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.idem[key]
	return r.msgID, r.jid, ok, nil
}

// ReserveIdempotency claims a key if it is unclaimed, or reclaims one whose
// reservation has outlived ReservationLease without completing. The read and
// the write happen in ONE critical section: splitting them would reintroduce
// the very race the reservation exists to close.
//
// A key bound to a DIFFERENT recipient is never reclaimable either — see the
// jid guard below.
//
// A COMPLETED send (non-empty msgID) is never reclaimable at any age. That
// guard is the whole safety of the lease: expiry may only ever free a key
// whose message provably never got an id recorded, never a key whose message
// was actually sent.
func (m *Memory) ReserveIdempotency(storageKey, jid string, now time.Time) (string, string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.idem[storageKey]
	if ok {
		// A key bound to another recipient is never reclaimable, at any age.
		// Reclaiming it would hand this caller a row that belongs to a
		// different contact; refusing turns a caller bug into a loud error
		// instead of a message that is never sent.
		if r.jid != jid {
			return r.msgID, r.jid, false, nil
		}
		if !(r.msgID == "" && r.reservedAt.Before(now.Add(-ReservationLease))) {
			return r.msgID, r.jid, false, nil
		}
	}
	m.idem[storageKey] = reservation{jid: jid, reservedAt: now}
	return "", jid, true, nil
}

// ReleaseIdempotency drops a reservation whose send will never complete.
//
// Call this ONLY when the provider definitively rejected the request and the
// message never left — a validation error, an authentication failure, a
// refusal returned before anything went on the wire.
//
// NEVER call it on a timeout. A timed-out send may well have been delivered;
// releasing the key there is the one path that genuinely double-sends a real
// customer. Leave a timed-out reservation alone and let ReservationLease
// expire it, which is exactly why the lease exists.
//
// A completed reservation (one carrying a message id) is never released.
func (m *Memory) ReleaseIdempotency(storageKey string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.idem[storageKey]; ok && r.msgID == "" {
		delete(m.idem, storageKey)
	}
	return nil
}

// SaveIdempotency upgrades a reservation this caller owns into a replayable
// result. It refuses to write against a key holding no open reservation:
// otherwise a stray save could fabricate a completed send for a key nobody
// ever reserved.
func (m *Memory) SaveIdempotency(key, messageID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.idem[key]
	if !ok || r.msgID != "" {
		return ErrNoReservation
	}
	r.msgID = messageID
	m.idem[key] = r
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
