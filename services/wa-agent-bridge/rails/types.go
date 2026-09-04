// Package rails holds every decision about whether an outbound WhatsApp
// message may be sent. It is deliberately pure: no network, no whatsmeow, no
// HTTP. Everything it needs arrives as a SendRequest, a Store, and a clock,
// which is what makes the whole safety layer testable without a WhatsApp
// connection.
//
// The rails live here rather than in the consumers because a consumer holding
// an unmediated socket is exactly how the sibling bridge's number was banned
// on 2026-09-04. Placing them below every consumer makes the unsafe action
// unrepresentable rather than merely discouraged.
package rails

import "time"

// SendRequest is one outbound attempt, fully described. Now is injected so
// rail logic never calls time.Now() — tests depend on controlling it.
type SendRequest struct {
	To             string // full JID, e.g. "27821234567@s.whatsapp.net"
	Text           string
	IdempotencyKey string
	Consumer       string // registry key: "hermes", "leadstack"
	Now            time.Time
}

// RefusalCode is machine-readable so a consumer can render a real reason
// instead of a generic failure. Values are stable API surface.
type RefusalCode string

const (
	RefusedKillSwitch     RefusalCode = "kill_switch"
	RefusedConsumerBudget RefusalCode = "consumer_budget"
	RefusedReplyOnly      RefusalCode = "reply_only"
	RefusedPerContactCap  RefusalCode = "per_contact_cap"
	RefusedConsecutiveCap RefusalCode = "consecutive_cap"
	RefusedDailyCap       RefusalCode = "daily_cap"
	RefusedQuietHours     RefusalCode = "quiet_hours"
	RefusedInternalError  RefusalCode = "internal_error"
)

// Decision is the chain's verdict. DuplicateOf is set when rail 9 recognised
// the idempotency key: the caller must return the original result rather than
// send again.
type Decision struct {
	Allow       bool
	RefusedBy   RefusalCode
	Reason      string
	DuplicateOf string
}

func Allow() Decision { return Decision{Allow: true} }

func Refuse(code RefusalCode, reason string) Decision {
	return Decision{Allow: false, RefusedBy: code, Reason: reason}
}

// Duplicate short-circuits the chain when an idempotency key has already been
// used. It is a success with no send attached, not a refusal. Callers MUST test
// DuplicateOf != "" BEFORE checking !Allow, because a replay and a genuine refusal
// both set Allow to false. The distinction matters: a replay means the original
// message stands; a refusal means the send was rejected and should not be retried.
func Duplicate(messageID string) Decision {
	return Decision{Allow: false, RefusedBy: "", DuplicateOf: messageID}
}

// ConsumerBudget caps one consumer independently of the others, so LeadStack
// can be throttled to zero without silencing Hermes.
type ConsumerBudget struct {
	PerHour int
	PerDay  int
}

type Config struct {
	PerContactPerDay int // default 10
	ConsecutiveMax   int // default 3
	GlobalDailyCap   int // default 150
	QuietStartHour   int // inclusive, local time, e.g. 21
	QuietEndHour     int // exclusive, local time, e.g. 7
	Location         *time.Location
	Budgets          map[string]ConsumerBudget
}

// Store is the persisted state the rails consult. Every counter lives on disk:
// an in-memory counter resets on restart, which turns a crash-loop into a
// send-loop. The sibling bridge shipped that bug and had to fix it in PR #2687.
type Store interface {
	HasInboundFrom(jid string) (bool, error)
	IsAllowlisted(jid string) (bool, error)
	AddAllowlist(jid string) error
	RemoveAllowlist(jid string) error

	OutboundCountForContact(jid string, since time.Time) (int, error)
	// ConsecutiveOutbound returns the number of outbound messages sent to this
	// JID since that contact's most recent inbound message. An inbound resets the
	// count to zero. A contact with no inbound at all counts every outbound ever
	// sent. This measures how long we have been talking at someone without an answer.
	ConsecutiveOutbound(jid string) (int, error)
	OutboundCountTotal(since time.Time) (int, error)
	OutboundCountForConsumer(consumer string, since time.Time) (int, error)

	RecordOutbound(jid, consumer, messageID string, at time.Time) error
	RecordInbound(jid string, at time.Time) error

	// LookupIdempotency is the cheap read-path check for a replay. It is NOT the
	// gate — see ReserveIdempotency. A found row with an empty messageID is a
	// reservation whose send has not completed yet.
	LookupIdempotency(key string) (messageID string, found bool, err error)

	// ReserveIdempotency atomically inserts a reservation for storageKey if none
	// exists. reserved == true means this caller won the race and owns the send;
	// reserved == false means a reservation already existed and existingMessageID
	// carries whatever id was recorded for it (empty while the winner is still
	// sending).
	//
	// THIS is the gate, not LookupIdempotency. A read-only check is a
	// time-of-check/time-of-use hole: two concurrent requests carrying the same
	// key both read "not found", both proceed, and the contact receives two
	// messages — precisely what this rail exists to prevent. A caller MUST
	// reserve, and win, BEFORE sending.
	//
	// Keys passed here are storage keys from IdempotencyStorageKey, never raw
	// caller keys.
	ReserveIdempotency(storageKey string) (existingMessageID string, reserved bool, err error)

	// SaveIdempotency records the real message id against a key once the send has
	// returned, upgrading a reservation into a replayable result.
	SaveIdempotency(key, messageID string) error

	KillState() (bool, error)
	SetKill(on bool) error
}
