package api

import (
	"fmt"
	"net/http"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// The volume caps have to bind ACROSS idempotency keys, not just within one.
//
// The idempotency reservation serialises requests that share a key. Nothing
// serialised requests that do not — and rails 3 and 5-7 are limits on volume,
// which is a property of all of them together. While cap budget was only
// consumed by the outbound row written AFTER a delivered send, every concurrent
// request read the same pre-send counts and every one of them passed: measured,
// 40 concurrent sends to one contact under a per-contact cap of 10 delivered
// 40 of 40. That is the traffic shape that got a sibling bridge's number banned,
// and it is the entire reason rails 5-7 exist.
//
// The invariant, stated once and asserted below for each cap and each store:
// with a cap of N, X concurrent requests carrying DISTINCT keys deliver AT
// MOST N — and still exactly N, so a fix that refuses everything does not pass.
//
// Verified by breaking it: reverting to budget-after-send fails on round 0 of
// every case, reporting the reviewer's 40-of-40, at GOMAXPROCS=1 and 4.
// Removing only the lock leaves a window too narrow for this test to catch
// reliably — TestEvaluateAndReserveIsOneCriticalSection in the rails package
// is the deterministic guard for that half.
func TestVolumeCapsBindAcrossConcurrentRequests(t *testing.T) {
	// Real parallelism where the machine has it; the assertions do not depend
	// on it. The setter returns the previous value.
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(4))

	const (
		requests = 40 // the reviewer's probe shape
		rounds   = 5  // one round can pass by scheduling luck; five do not
	)

	cases := []struct {
		name string
		cfg  rails.Config
		// jid picks the recipient for request i, so the global-cap case can
		// spread across contacts no per-contact cap would stop first.
		jid  func(i int) string
		want int
	}{
		{
			name: "per-contact",
			cfg:  capsConfig(rails.Config{PerContactPerDay: 10, ConsecutiveMax: 1000, GlobalDailyCap: 1000}),
			jid:  func(int) string { return knownJID },
			want: 10,
		},
		{
			name: "consecutive",
			cfg:  capsConfig(rails.Config{PerContactPerDay: 1000, ConsecutiveMax: 3, GlobalDailyCap: 1000}),
			jid:  func(int) string { return knownJID },
			want: 3,
		},
		{
			name: "global-daily",
			cfg:  capsConfig(rails.Config{PerContactPerDay: 1000, ConsecutiveMax: 1000, GlobalDailyCap: 5}),
			// One contact each, so only the account-wide cap can refuse.
			jid:  func(i int) string { return fmt.Sprintf("2782000%04d@s.whatsapp.net", i) },
			want: 5,
		},
	}

	for _, tc := range cases {
		for _, impl := range storeImpls {
			t.Run(tc.name+"/"+impl.name, func(t *testing.T) {
				for round := 0; round < rounds; round++ {
					probeOneRound(t, round, impl.open(t), tc.cfg, tc.jid, tc.want, requests)
				}
			})
		}
	}
}

// storeImpls runs the whole probe against BOTH stores. Memory alone would leave
// the implementation that actually runs in production untested, and "the caps
// bind" is a claim about SQLite or it is worth nothing.
var storeImpls = []struct {
	name string
	open func(t *testing.T) rails.Store
}{
	{"Memory", func(*testing.T) rails.Store { return store.NewMemory() }},
	{"SQLite", func(t *testing.T) rails.Store {
		s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "bridge.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.Close() })
		return s
	}},
}

func probeOneRound(t *testing.T, round int, st rails.Store, cfg rails.Config,
	jidFor func(int) string, want, requests int) {
	t.Helper()

	// delay widens the window between reading the counts and recording the
	// send. Under the bug that is where all 40 requests pile up.
	sender := &stubSender{delay: 2 * time.Millisecond}
	h := newHandlerWithConfig(t, st, sender, cfg)

	seen := map[string]bool{}
	for i := 0; i < requests; i++ {
		if jid := jidFor(i); !seen[jid] {
			seen[jid] = true
			// Reply-only is rail 5; this test is about 3 and 6-7.
			if err := st.RecordInbound(jid, fixedNow.Add(-time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
	}

	var (
		ready sync.WaitGroup // all spawned and parked before any runs
		done  sync.WaitGroup
		start = make(chan struct{})
		mu    sync.Mutex
		codes = map[int]int{}
	)
	ready.Add(requests)
	done.Add(requests)
	for i := 0; i < requests; i++ {
		go func() {
			defer done.Done()
			ready.Done()
			<-start // released together, so they actually contend
			rec := post(h, "/v1/send", "tok-hermes",
				sendBodyJSON(jidFor(i), "hi", fmt.Sprintf("r%d-k%d", round, i)))
			mu.Lock()
			codes[rec.Code]++
			mu.Unlock()
		}()
	}
	ready.Wait()
	close(start)
	done.Wait()

	got := sender.Calls()
	if got > want {
		t.Fatalf("round %d: cap is %d, %d concurrent requests with distinct keys delivered %d (codes %v)",
			round, want, requests, got, codes)
	}
	// Not merely "few enough": the cap must still let its full allowance
	// through, or a fix that refuses everything passes this test.
	if got != want {
		t.Fatalf("round %d: cap is %d but only %d were delivered; the cap must bind, not throttle to zero (codes %v)",
			round, want, got, codes)
	}
	if codes[http.StatusUnprocessableEntity] == 0 {
		t.Fatalf("round %d: nothing was refused by a rail, so nothing proves the cap fired (codes %v)",
			round, codes)
	}
}

// capsConfig fills in the parts of a rails.Config these tests do not vary.
func capsConfig(c rails.Config) rails.Config {
	c.Location = time.UTC
	c.Budgets = map[string]rails.ConsumerBudget{"hermes": {PerHour: 10000, PerDay: 10000}}
	return c
}

func newHandlerWithConfig(t *testing.T, st rails.Store, sender Sender, cfg rails.Config) http.Handler {
	t.Helper()
	return New(Deps{
		Engine:     rails.NewEngine(st, cfg),
		Store:      st,
		Sender:     sender,
		Consumers:  []config.Consumer{{Name: "hermes", Token: "tok-hermes"}},
		Now:        func() time.Time { return fixedNow },
		Connection: &stubConnection{up: true},
	})
}
