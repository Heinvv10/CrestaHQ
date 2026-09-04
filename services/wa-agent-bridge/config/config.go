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
		if c.Name == "" {
			return Config{}, fmt.Errorf("a consumer entry has an empty name; the name namespaces its idempotency keys")
		}
		if c.Token == "" {
			return Config{}, fmt.Errorf("consumer %q has an empty token", c.Name)
		}
		cfg.Consumers = append(cfg.Consumers, c)
		cfg.Rails.Budgets[c.Name] = rails.ConsumerBudget{PerHour: c.PerHour, PerDay: c.PerDay}
	}
	return cfg, nil
}
