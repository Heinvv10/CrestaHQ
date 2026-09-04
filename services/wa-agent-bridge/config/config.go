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
	// Admin marks an operator credential. It is required for the two actions
	// that can only make things WORSE — adding to the allowlist, and lifting
	// the kill switch — while every consumer keeps the fail-safe directions
	// (removing from the allowlist, setting the kill switch), so anyone can
	// slam the brakes during an incident and only an operator releases them.
	//
	// Attribution is not authorisation: logging which consumer allowlisted a
	// stranger does not undo the cold DMs that follow, and an allowlisted JID
	// has nothing left but the global daily cap standing in front of it.
	Admin bool
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
// CONSUMERS format: "name|token|webhookURL|perHour|perDay|admin", comma-separated.
// Pipe-separated rather than colon-separated because a webhook URL carries a
// scheme and a port, and splitting a URL on ":" mangles it into fragments.
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
	if err := checkBindAddr(cfg.ListenAddr); err != nil {
		return Config{}, err
	}

	raw := os.Getenv("CONSUMERS")
	if strings.TrimSpace(raw) == "" {
		return Config{}, fmt.Errorf("CONSUMERS is required")
	}
	seenName, seenToken := map[string]bool{}, map[string]bool{}
	for _, entry := range strings.Split(raw, ",") {
		c, err := parseConsumer(entry)
		if err != nil {
			return Config{}, err
		}
		// A duplicate NAME is the dangerous one: two consumers then share an
		// idempotency namespace, and one's genuine reply is silently swallowed
		// as the other's duplicate. A duplicate TOKEN destroys attribution and
		// hands over the first entry's budget and privileges.
		if seenName[c.Name] {
			return Config{}, fmt.Errorf(
				"duplicate consumer name %q: two consumers sharing a name share an idempotency namespace, and one's genuine replies would be silently dropped as duplicates", c.Name)
		}
		if seenToken[c.Token] {
			return Config{}, fmt.Errorf("consumer %q reuses another consumer's token", c.Name)
		}
		seenName[c.Name], seenToken[c.Token] = true, true
		cfg.Consumers = append(cfg.Consumers, c)
		cfg.Rails.Budgets[c.Name] = rails.ConsumerBudget{PerHour: c.PerHour, PerDay: c.PerDay}
	}
	return cfg, nil
}

// parseConsumer reads one "name|token|webhook|perHour|perDay|admin" entry.
//
// Every field error is returned rather than defaulted. A typo'd budget parses
// to zero, which fails closed and then silently mutes a consumer nobody will
// think to look at; a typo'd privilege silently downgrades an operator, who
// discovers it mid-incident when they cannot lift the kill switch.
func parseConsumer(entry string) (Consumer, error) {
	parts := strings.Split(strings.TrimSpace(entry), "|")
	if len(parts) < 2 {
		return Consumer{}, fmt.Errorf(
			"bad CONSUMERS entry %q (want name|token|webhook|perHour|perDay|admin)", entry)
	}
	c := Consumer{Name: parts[0], Token: parts[1], PerHour: 100, PerDay: 500}
	if c.Name == "" {
		return Consumer{}, fmt.Errorf("a consumer entry has an empty name; the name namespaces its idempotency keys")
	}
	if c.Token == "" {
		return Consumer{}, fmt.Errorf("consumer %q has an empty token", c.Name)
	}
	if len(parts) >= 3 {
		c.WebhookURL = parts[2]
	}
	var err error
	if len(parts) >= 4 && parts[3] != "" {
		if c.PerHour, err = strconv.Atoi(parts[3]); err != nil {
			return Consumer{}, fmt.Errorf("consumer %q has an unparseable perHour %q: %w", c.Name, parts[3], err)
		}
	}
	if len(parts) >= 5 && parts[4] != "" {
		if c.PerDay, err = strconv.Atoi(parts[4]); err != nil {
			return Consumer{}, fmt.Errorf("consumer %q has an unparseable perDay %q: %w", c.Name, parts[4], err)
		}
	}
	if len(parts) >= 6 && parts[5] != "" {
		if parts[5] != "admin" {
			return Consumer{}, fmt.Errorf(
				"consumer %q has an unknown privilege %q (the only accepted value is \"admin\")", c.Name, parts[5])
		}
		c.Admin = true
	}
	return c, nil
}
