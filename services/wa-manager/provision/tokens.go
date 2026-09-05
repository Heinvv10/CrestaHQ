package provision

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/systemd"
)

// tokenBytes is 32 bytes of entropy — 256 bits. These tokens authenticate
// sending as a real WhatsApp number, and a number is not re-issuable once it
// is banned, so they are sized to be brute-force-proof rather than tidy.
const tokenBytes = 32

// NewToken mints one bearer token.
//
// base64url, not standard base64: the token is written into an `.env` line
// whose format uses "|" between fields, "," between consumers and "=" after
// the key. A "+" or "/" is harmless, but "=" padding is not — an unpadded,
// URL-safe alphabet keeps a token from ever splitting itself into two fields.
//
// It panics on a rand failure rather than returning a fallback. There is no
// safe degraded token: a predictable one hands an attacker the ability to send
// as the customer's number, so refusing to run is the only correct outcome.
func NewToken() string {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		panic("provision: no entropy for a bearer token: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// TokenSource recovers the MANAGER's admin token for a tenant's bridge — the
// one renderEnv wrote into that instance's `.env`.
//
// The `.env` is the single source of truth, deliberately. The alternative,
// keeping a copy in the manager's registry, would put the same secret in two
// files that can disagree: an operator who rotates a token by editing the
// `.env` and restarting the unit would leave the manager presenting a
// credential the bridge no longer accepts, and the manager would report every
// tenant unreachable while every tenant was fine. Reading the file the bridge
// itself loaded cannot drift from it.
//
// It lives beside renderEnv, in the same package, so the writer and the reader
// of that CONSUMERS line are edited together.
type TokenSource struct {
	// Root is the parent of every instance dir — the same value as Opts.Root.
	Root string
}

// managerConsumer is the name renderEnv gives the manager's own consumer entry.
const managerConsumer = "manager"

// ForInstance returns the manager's admin token for one instance.
//
// It returns an ERROR, never an empty string, because an empty bearer token
// presented to a bridge produces a 401 that reads exactly like the bridge
// refusing a legitimate operator — sending whoever is debugging at the wrong
// service entirely.
func (ts TokenSource) ForInstance(instance string) (string, error) {
	// Validated even though the API validates too: this is callable from
	// anywhere in the process, the name is interpolated into a path, and a
	// guard that only exists at one caller is one refactor from not existing.
	if err := systemd.Validate(instance); err != nil {
		return "", err
	}
	path := filepath.Join(ts.Root, instance, ".env")
	f, err := os.Open(path)
	if err != nil {
		// The error is not wrapped with os.Open's message, which quotes the
		// path; the path is not a secret, but the file it names holds two.
		return "", fmt.Errorf("provision: no readable .env for instance %q", instance)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		rest, ok := strings.CutPrefix(line, "CONSUMERS=")
		if !ok {
			continue
		}
		// Split exactly as the bridge's own config.Load does — on "," between
		// consumers, then "|" between fields. Parsing it any other way than
		// the process that consumes it is the drift this whole type exists to
		// avoid.
		for _, entry := range strings.Split(rest, ",") {
			fields := strings.Split(strings.TrimSpace(entry), "|")
			if len(fields) >= 2 && fields[0] == managerConsumer && fields[1] != "" {
				return fields[1], nil
			}
		}
	}
	if err := sc.Err(); err != nil {
		return "", fmt.Errorf("provision: could not read the .env for instance %q", instance)
	}
	return "", fmt.Errorf(
		"provision: the .env for instance %q has no %q consumer; the manager has no admin credential for this bridge",
		instance, managerConsumer)
}
