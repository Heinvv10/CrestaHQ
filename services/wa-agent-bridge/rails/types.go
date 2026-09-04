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
	// RefusedInFlight means another request holds this idempotency key and is
	// still sending. It is a normal outcome of a concurrent retry, not a
	// broken Store, and the caller may safely retry shortly — which is exactly
	// why it must not share a code with RefusedInternalError. Added before any
	// consumer exists, because RefusalCode values are stable API surface and
	// splitting one later would be a breaking change.
	RefusedInFlight RefusalCode = "in_flight"
	// RefusedIdempotencyKeyReused means this idempotency key is already bound
	// to a DIFFERENT recipient. It is a caller bug, not a rail refusing a
	// message on its merits, and it must not be answered with a duplicate:
	// returning the other contact's message id would tell the caller its
	// original stands while this message is never sent to anyone. Silent
	// non-delivery is worse than a loud failure, so this is loud.
	RefusedIdempotencyKeyReused RefusalCode = "idempotency_key_reused"
)

// Decision is the chain's verdict. DuplicateOf is set when rail 2 (idempotency) recognised
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

// QuietWindow is one consumer's quiet hours, in the deployment's local time.
// Start == End disables the rail for that consumer.
type QuietWindow struct {
	StartHour int // inclusive, e.g. 21
	EndHour   int // exclusive, e.g. 7
}

type Config struct {
	PerContactPerDay int // default 10
	ConsecutiveMax   int // default 3
	GlobalDailyCap   int // default 150
	QuietStartHour   int // inclusive, local time, e.g. 21
	QuietEndHour     int // exclusive, local time, e.g. 7
	Location         *time.Location
	Budgets          map[string]ConsumerBudget
	// QuietHours overrides the deployment-wide window for named consumers.
	// The design has always specified quiet hours "per consumer": an internal
	// ops consumer legitimately needs to page a human at 03:00, while a
	// customer-facing one must not. A consumer with no entry here falls back
	// to QuietStartHour/QuietEndHour, so every existing deployment keeps
	// exactly the behaviour it has.
	QuietHours map[string]QuietWindow
}

// Store is the persisted state the rails consult. Every counter lives on disk:
// an in-memory counter resets on restart, which turns a crash-loop into a
// send-loop. The sibling bridge shipped that bug and had to fix it in PR #2687.
type Store interface {
	HasInboundFrom(jid string) (bool, error)
	IsAllowlisted(jid string) (bool, error)
	AddAllowlist(jid string) error
	RemoveAllowlist(jid string) error
	// ListAllowlist returns every allowlisted JID, sorted. "Who has escaped
	// reply-only right now" is the question an operator asks first during an
	// incident, and answering it by grepping logs for past AddAllowlist calls
	// misses every entry added before the current log file.
	ListAllowlist() ([]string, error)

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

	// ReserveOutboundSlot writes the outbound row that CONSUMES cap budget,
	// at reservation time rather than after the send returns.
	//
	// This is what makes the volume caps bind under concurrency. When budget
	// was only consumed by RecordOutbound after a delivered send, every
	// request carrying a DIFFERENT idempotency key read the same pre-send
	// counts: the idempotency reservation serialises same-key requests and
	// nothing serialised the rest. Measured, 40 concurrent sends to one
	// contact under a cap of 10 delivered 40. Writing the row while the caps
	// are still being held (see Engine.EvaluateAndReserve) means the next
	// caller's count already includes this one.
	//
	// The row is written with an empty message id and stamped with storageKey
	// so exactly one of the three outcomes below can find it again. It counts
	// toward every volume rail from the moment it lands — which is the point.
	ReserveOutboundSlot(storageKey, jid, consumer string, at time.Time) error

	// ReleaseOutboundSlot removes the reserved row, returning its budget.
	//
	// Call it ONLY alongside ReleaseIdempotency, on a DEFINITIVE provider
	// rejection where the message provably never left. A message that was
	// never sent must not permanently occupy a contact's daily allowance.
	//
	// NEVER on a timeout. A timed-out send may already have been delivered,
	// so its budget stays spent — the same asymmetry ReleaseIdempotency
	// documents, for the same reason. A slot stranded by a crash likewise
	// stays spent: over-counting refuses a send that could have gone, which
	// is the direction every rail here errs in.
	ReleaseOutboundSlot(storageKey string) error

	// ConfirmOutboundSlot stamps the real message id on a reserved row once
	// the send has returned. It changes no count — the row was already
	// counted — so a failure here is cosmetic, not a blind cap.
	ConfirmOutboundSlot(storageKey, messageID string) error

	// LastInboundAt is the timestamp of the most recent inbound message from
	// anyone, zero when none has ever arrived. The health endpoint reports its
	// age: a bridge whose socket has quietly died still answers HTTP, and an
	// inbound age that keeps climbing is the only externally visible symptom.
	LastInboundAt() (time.Time, error)

	// LookupIdempotency is the cheap read-path check for a replay. It is NOT the
	// gate — see ReserveIdempotency. A found row with an empty messageID is a
	// reservation whose send has not completed yet.
	// It also returns the JID the key is bound to, so a caller reusing one
	// key for two different recipients is caught rather than answered with
	// the other contact's message id.
	LookupIdempotency(key string) (messageID, jid string, found bool, err error)

	// ReserveIdempotency atomically claims storageKey. reserved == true means
	// this caller won the race and owns the send; reserved == false means a
	// live reservation already existed and existingMessageID carries whatever
	// id was recorded for it (empty while the winner is still sending).
	//
	// THIS is the gate, not LookupIdempotency. A read-only check is a
	// time-of-check/time-of-use hole: two concurrent requests carrying the same
	// key both read "not found", both proceed, and the contact receives two
	// messages — precisely what this rail exists to prevent. A caller MUST
	// reserve, and win, BEFORE sending. Use Engine.EvaluateAndReserve rather
	// than calling this directly; it is the one path that cannot skip the gate.
	//
	// now is injected for the same reason every other clock here is: an
	// implementation reclaims a reservation left stranded for longer than
	// store.ReservationLease, and a test must be able to drive that boundary
	// without sleeping. A reservation carrying a message id is a COMPLETED
	// send and is never reclaimable at any age.
	//
	// Keys passed here are storage keys from IdempotencyStorageKey, never raw
	// caller keys.
	// jid binds the reservation to ONE recipient. An existing row for another
	// recipient is never reclaimable at any age, and comes back with
	// reserved == false and existingJID naming the other contact so the
	// caller can be refused loudly instead of silently not sending.
	ReserveIdempotency(storageKey, jid string, now time.Time) (existingMessageID, existingJID string, reserved bool, err error)

	// ReleaseIdempotency drops a reservation whose send will never complete,
	// so the key is usable again immediately rather than after the lease.
	//
	// Call it ONLY on a definitive rejection: the provider returned an error
	// and the request never left. NEVER on a timeout — a timed-out send may
	// have been delivered, and releasing the key there is the one path that
	// genuinely double-sends a real customer. A timed-out reservation must be
	// left to expire under store.ReservationLease instead.
	ReleaseIdempotency(storageKey string) error

	// SaveIdempotency records the real message id against a key once the send has
	// returned, upgrading a reservation into a replayable result. It writes only
	// against an open reservation the caller owns, so a stray save cannot
	// fabricate a completed send for a key nobody reserved.
	SaveIdempotency(key, messageID string) error

	KillState() (bool, error)
	SetKill(on bool) error
}
