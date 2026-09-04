package rails

// Engine runs the rails in a fixed order and returns the first refusal.
//
// The order is part of the contract, not an implementation detail:
//
//  1. kill switch     — an operator stopping an incident must not have to reason
//     about which other rail fired first
//  2. idempotency     — a replay is answered before any counter is consulted, so
//     a retry cannot consume budget
//  3. consumer budget — cheapest per-consumer gate
//  4. quiet hours     — time-of-day, no Store reads beyond this point are wasted
//  5. reply-only      — the core protection
//  6. caps            — volume, the most expensive reads
//
// Every rail fails closed: an error refuses. There is no path through this
// function that allows a send because something went wrong.
type Engine struct {
	store Store
	cfg   Config
}

func NewEngine(s Store, cfg Config) *Engine {
	return &Engine{store: s, cfg: cfg}
}

// Evaluate runs the rail chain and reports the verdict. It is READ-ONLY.
//
// It DOES NOT reserve the idempotency key, and it MUST NOT be used on a send
// path. Its idempotency check is a cheap read: two concurrent requests carrying
// the same key both see "not found", both get Allow, and the contact receives
// the message twice. Every caller that is about to actually send must use
// EvaluateAndReserve instead.
//
// This exists for callers that genuinely only want to ask — a dry-run endpoint,
// a preflight check in an operator tool, a test.
func (e *Engine) Evaluate(req SendRequest) Decision {
	for _, d := range []Decision{
		checkKill(e.store),
		checkIdempotency(req, e.store),
		checkBudget(req, e.store, e.cfg),
		checkQuietHours(req, e.cfg),
		checkReplyOnly(req, e.store),
		checkCaps(req, e.store, e.cfg),
	} {
		if !d.Allow {
			return d
		}
	}
	return Allow()
}

// EvaluateAndReserve is the ONLY function a send path may call. It runs the
// full chain and then, only if every rail allowed, atomically claims the
// idempotency key. A returned Allow therefore means two things at once: the
// rails permit this send, and this caller — uniquely — owns it.
//
// The split exists because a read-only check cannot close a time-of-check/
// time-of-use hole. Evaluate alone would let two concurrent requests with one
// key both pass. Folding the reservation into the allow makes the unsafe
// sequence unrepresentable rather than merely discouraged: there is no ordering
// of these calls that sends without having won the key first.
//
// Losing the reservation returns a REFUSAL, never an allow — either
// Duplicate(id) when the winner already finished, or RefusedInFlight while it
// is still sending. Fail closed, as everywhere else here.
//
// On success the caller owns the key and MUST, after the send returns, either
// Store.SaveIdempotency the resulting message id, or — on a definitive
// provider rejection only, never on a timeout — Store.ReleaseIdempotency it.
//
// err is non-nil only when the Store failed. The Decision is safe to act on
// regardless: it is a refusal in that case.
func (e *Engine) EvaluateAndReserve(req SendRequest) (Decision, error) {
	if d := e.Evaluate(req); !d.Allow {
		return d, nil
	}

	key := IdempotencyStorageKey(req.Consumer, req.IdempotencyKey)
	existing, reserved, err := e.store.ReserveIdempotency(key, req.Now)
	if err != nil {
		return Refuse(RefusedInternalError, "idempotency reservation failed"), err
	}
	if !reserved {
		// Another request won the key between Evaluate's read and this write —
		// exactly the race Evaluate cannot see.
		if existing != "" {
			return Duplicate(existing), nil
		}
		return Refuse(RefusedInFlight,
			"another request won this idempotency key and is still sending"), nil
	}
	return Allow(), nil
}

// Config returns the engine's configuration for the health endpoint.
func (e *Engine) Config() Config { return e.cfg }
