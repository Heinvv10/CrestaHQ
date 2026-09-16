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
	// QuietStartHour/QuietEndHour override the deployment-wide quiet window
	// for this consumer, and are only read when QuietSet is true. An internal
	// ops consumer legitimately pages a human at 03:00; a customer-facing one
	// must not. Unset (the default, and every pre-existing entry) inherits the
	// deployment window — inheriting the restriction, never escaping it.
	QuietSet       bool
	QuietStartHour int
	QuietEndHour   int
	// WebhookSecret, when set, signs every webhook POST to this consumer with
	// an HMAC (see api.Fanout.post) so the receiver can verify the request
	// really came from the bridge and reject a replay. Empty is the default
	// and the safe one: a bridge deployed from an old config keeps delivering,
	// it just doesn't sign — nothing about signing is required for the
	// fanout to work.
	WebhookSecret string
}

type Config struct {
	ListenAddr string
	DBPath     string
	SessionDir string
	OwnerJID   string
	Consumers  []Consumer
	Rails      rails.Config
	// InboundMediaPerSenderPerHour caps how many DISTINCT attachments one
	// sender can make the bridge download in a rolling hour
	// (CAP_INBOUND_MEDIA_PER_SENDER_PER_HOUR). It sits here rather than in
	// rails.Config because rails.Config is the OUTBOUND engine's — this bounds
	// what arrives, and nothing in rails ever consults it. Zero or unset takes
	// the api package's default; see api.mediaGate for why there is no
	// unlimited setting.
	InboundMediaPerSenderPerHour int
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
// CONSUMERS format:
// "name|token|webhookURL|perHour|perDay|admin|quietStartHour|quietEndHour|webhookSecret",
// comma-separated. Every field after `token` is optional and the list is only
// ever appended to, so the 5-, 6- and 8-field forms that predate the webhook
// secret parse exactly as they did.
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
		// 0 means "unset", which api resolves to its own default. Not
		// defaulted here, so the number lives in one place next to the gate
		// that enforces it rather than in two that can drift.
		InboundMediaPerSenderPerHour: envInt("CAP_INBOUND_MEDIA_PER_SENDER_PER_HOUR", 0),
		Rails: rails.Config{
			PerContactPerDay: envInt("CAP_PER_CONTACT_PER_DAY", 10),
			ConsecutiveMax:   envInt("CAP_CONSECUTIVE", 3),
			GlobalDailyCap:   envInt("CAP_GLOBAL_DAILY", 150),
			// A human reply only escapes quiet hours while the contact is
			// still waiting on one. 24h matches the session window every
			// WhatsApp rail already reasons in, so an operator does not have
			// to hold two different definitions of "recent" in their head.
			HumanReplySessionWindow: time.Duration(envInt("HUMAN_REPLY_SESSION_HOURS", 24)) * time.Hour,
			QuietStartHour:          envInt("QUIET_START_HOUR", 21),
			QuietEndHour:            envInt("QUIET_END_HOUR", 7),
			Location:                loc,
			Budgets:                 map[string]rails.ConsumerBudget{},
			QuietHours:              map[string]rails.QuietWindow{},
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
		// Only consumers that declared a window get an entry; the rest fall
		// back to the deployment-wide QUIET_START_HOUR/QUIET_END_HOUR.
		if c.QuietSet {
			cfg.Rails.QuietHours[c.Name] = rails.QuietWindow{
				StartHour: c.QuietStartHour, EndHour: c.QuietEndHour}
		}
	}
	return cfg, nil
}

// parseConsumer reads one
// "name|token|webhook|perHour|perDay|admin|quietStart|quietEnd|webhookSecret"
// entry.
//
// Every field error is returned rather than defaulted. A typo'd budget parses
// to zero, which fails closed and then silently mutes a consumer nobody will
// think to look at; a typo'd privilege silently downgrades an operator, who
// discovers it mid-incident when they cannot lift the kill switch.
func parseConsumer(entry string) (Consumer, error) {
	parts := strings.Split(strings.TrimSpace(entry), "|")
	if len(parts) < 2 {
		return Consumer{}, fmt.Errorf(
			"bad CONSUMERS entry %q (want name|token|webhook|perHour|perDay|admin|quietStart|quietEnd|webhookSecret)", entry)
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
	// Quiet hours are declared as a PAIR or not at all. One half alone is
	// ambiguous — is the missing half the deployment default or midnight? —
	// and guessing either way silently gives the consumer a window nobody
	// wrote down.
	startRaw, endRaw := fieldAt(parts, 6), fieldAt(parts, 7)
	if (startRaw == "") != (endRaw == "") {
		return Consumer{}, fmt.Errorf(
			"consumer %q sets only one half of its quiet window; give both quietStartHour and quietEndHour, or neither", c.Name)
	}
	if startRaw != "" {
		if c.QuietStartHour, err = parseHour(c.Name, "quietStartHour", startRaw); err != nil {
			return Consumer{}, err
		}
		if c.QuietEndHour, err = parseHour(c.Name, "quietEndHour", endRaw); err != nil {
			return Consumer{}, err
		}
		c.QuietSet = true
	}
	c.WebhookSecret = strings.TrimSpace(fieldAt(parts, 8))
	return c, nil
}

func fieldAt(parts []string, i int) string {
	if i >= len(parts) {
		return ""
	}
	return parts[i]
}

// parseHour refuses anything outside 0-23 rather than defaulting. A typo'd
// hour that silently becomes 0 hands a consumer a quiet window it never asked
// for, and nobody looks at a rail that is quietly wrong in the safe direction
// until it is quietly wrong in the other one.
func parseHour(consumer, field, raw string) (int, error) {
	h, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("consumer %q has an unparseable %s %q: %w", consumer, field, raw, err)
	}
	if h < 0 || h > 23 {
		return 0, fmt.Errorf("consumer %q has %s %d, which is not an hour of the day (0-23)", consumer, field, h)
	}
	return h, nil
}
