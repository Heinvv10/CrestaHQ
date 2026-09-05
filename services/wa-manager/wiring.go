// Wiring helpers for main.go. They live here rather than inline so main stays
// a readable list of what is connected to what — and so the two that make a
// real decision can be tested, which nothing calling net.Listen or systemctl
// can be.
package main

import (
	"log"
	"net"
	"net/http"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/provision"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// newPoller builds the health poller with its fan-out bound SET EXPLICITLY.
//
// health.Poller defaults a zero Concurrency to 8, so leaving it unset would
// work — which is exactly the problem. This fan-out was once unbounded and
// nothing set it: an unlimited poll of 200 tenants opens 200 simultaneous
// connections every cycle, a thundering herd this box aims at itself. The bound
// living at the wiring site, in a function a test can call, is what stops that
// recurring; a default relied upon is one nobody notices when it changes.
func newPoller(client *http.Client, tokens provision.TokenSource) *health.Poller {
	p := health.New(client, func(t store.Tenant) string {
		return tokenFor(tokens, t.Instance)
	})
	p.Concurrency = pollConcurrency
	return p
}

// listenValidated binds the address config.Load already validated.
//
// cfg.ListenAddr is the ONLY source. config.Load refuses anything that is not
// loopback or tailnet (unless ALLOW_PUBLIC_BIND=1), and that check is worth
// nothing unless the process binds what was checked — so this must never
// re-derive an address, consult the environment a second time, or fall back to
// a default. The listener is handed to http.Server.Serve with the server's own
// Addr left empty, so there is no second address in the program for a typo to
// hide in.
func listenValidated(cfg config.Config) (net.Listener, error) {
	return net.Listen("tcp", cfg.ListenAddr)
}

// tokenFor resolves one bridge's admin token, logging rather than returning the
// failure because both callers take a plain string.
//
// An empty token fails CLOSED: the bridge answers 401, the poll reports the
// tenant unreachable and the pair relay reports a refusal. The log line is what
// keeps that from being a mystery — it names the instance, never the token.
func tokenFor(ts provision.TokenSource, instance string) string {
	tok, err := ts.ForInstance(instance)
	if err != nil {
		log.Printf("WARNING could not read the manager token for instance %q: %v", instance, err)
		return ""
	}
	return tok
}

// webhookURL builds the per-tenant inbound webhook, or nil when no base is
// configured.
//
// nil rather than a function returning "" so the provisioner writes no webhook
// field at all. A bridge with no webhook still receives and records inbound; it
// simply forwards nowhere — which is exactly a number provisioned before its
// consumer exists.
func webhookURL(base string) func(string) string {
	if base == "" {
		return nil
	}
	return func(tenantID string) string { return base + "/" + tenantID }
}
