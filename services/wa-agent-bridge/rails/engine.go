package rails

// Engine runs the rails in a fixed order and returns the first refusal.
//
// The order is part of the contract, not an implementation detail:
//
//  1. kill switch    — an operator stopping an incident must not have to
//                      reason about which other rail fired first
//  2. idempotency    — a replay is answered before any counter is consulted,
//                      so a retry cannot consume budget
//  3. consumer budget— cheapest per-consumer gate
//  4. quiet hours    — time-of-day, no Store reads beyond this point are wasted
//  5. reply-only     — the core protection
//  6. caps           — volume, the most expensive reads
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

// Config returns the engine's configuration for the health endpoint.
func (e *Engine) Config() Config { return e.cfg }
