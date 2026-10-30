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
