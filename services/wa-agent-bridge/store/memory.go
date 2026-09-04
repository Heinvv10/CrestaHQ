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
