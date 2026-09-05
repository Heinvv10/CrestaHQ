// Command wa-manager provisions and supervises one wa-agent-bridge instance per
// WhatsApp number, and renders one screen showing whether each number is safe.
//
// It is NOT in the message path. Nothing here sends, receives, stores or logs
// message content; the bridges do that, and this process only reads their
// counters and drives their units.
//
// This file is wiring only. Decisions live in config/, provision/, health/,
// systemd/ and api/. Keeping main small is deliberate, for the reason the
// sibling bridge's main.go records: it reached 118 KB and became the reason
// nothing in it could be tested.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/api"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/provision"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/systemd"
)

const (
	// pollEvery paces the background reconcile sweep. Fifteen seconds matches
	// the UI's own meta-refresh, so the screen and the store never disagree by
	// more than one interval.
	pollEvery = 15 * time.Second

	// pollConcurrency bounds how many bridges are polled at once.
	//
	// Set EXPLICITLY, at the wiring site, rather than left to the zero value.
	// health.Poller defaults a zero to 8, but this fan-out was once unbounded
	// and nothing set it: an unlimited poll of 200 tenants opens 200
	// simultaneous connections every cycle, a thundering herd this box aims at
	// itself. A number written here is a number a reviewer can see; a default
	// relied upon is one nobody notices when it changes.
	pollConcurrency = 8

	// bridgeTimeout bounds every call to a tenant's bridge — the health poll
	// and the pairing relay both. A hung bridge must not pin an operator's
	// request, and with pollConcurrency workers a long timeout would stall the
	// whole sweep behind a handful of dead instances.
	bridgeTimeout = 5 * time.Second

	// shutdownBudget bounds the HTTP graceful drain on SIGTERM. Requests here
	// are short — the longest is a pairing relay bounded by bridgeTimeout — so
	// this only has to outlast that, with headroom.
	shutdownBudget = 15 * time.Second
)

func main() {
	// Load refuses an empty OPERATOR_TOKEN and a publicly routable bind. Both
	// are fatal here rather than degraded: every route this process serves
	// writes an .env holding bearer tokens or starts a systemd unit.
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	units := systemd.New(cfg.UnitName)
	tokens := provision.TokenSource{Root: cfg.InstanceRoot}

	prov := provision.New(st, units, provision.Opts{
		Root:      cfg.InstanceRoot,
		PortBase:  cfg.PortBase,
		PortCount: cfg.PortCount,
		// A fresh pair per tenant, minted here and never reused: one token
		// shared across tenants would let a compromised consumer of one number
		// send as every other.
		AppToken:     provision.NewToken,
		ManagerToken: provision.NewToken,
		WebhookURL:   webhookURL(cfg.WebhookBaseURL),
		QuietTZ:      cfg.QuietTZ,
	})

	bridges := &http.Client{Timeout: bridgeTimeout}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Builds the poller AND starts the background sweep — the only caller of
	// health.Reconcile. Without that sweep a number's death is dated whenever
	// an operator next opens the screen, not when it happened. The two are one
	// call so that a poller cannot exist here unstarted; see startPoller.
	poller := startPoller(ctx, bridges, tokens, st)

	handler := api.New(api.Deps{
		Store:         st,
		Provisioner:   prov,
		Poller:        poller,
		Units:         units,
		OperatorToken: cfg.OperatorToken,
		HTTPClient:    bridges,
		// The MANAGER's admin token for that tenant's bridge — never the
		// caller's operator token, which opens every tenant on this box.
		TenantToken: func(tenantID string) string {
			t, err := st.GetTenant(tenantID)
			if err != nil {
				log.Printf("WARNING no tenant row for %q while resolving its bridge token", tenantID)
				return ""
			}
			return tokenFor(tokens, t.Instance)
		},
	})

	ln, err := listenValidated(cfg)
	if err != nil {
		log.Fatalf("listen %s: %v", cfg.ListenAddr, err)
	}
	srv := &http.Server{Handler: handler}
	go func() {
		log.Printf("listening on %s", ln.Addr())
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down")

	cancel() // stop the poll loop before the store closes under it
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownBudget)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("WARNING http shutdown: %v", err)
	}
}
