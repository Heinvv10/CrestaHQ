package rails

import (
	"fmt"
	"time"
)

// checkKill is the incident-response stop button. It refuses outbound while
// leaving the connection up, so the operator keeps receiving messages and
// keeps seeing health data. Killing the process would do neither.
func checkKill(s Store) Decision {
	on, err := s.KillState()
	if err != nil {
		return Refuse(RefusedInternalError, "kill state lookup failed")
	}
	if on {
		return Refuse(RefusedKillSwitch, "outbound is stopped by the kill switch")
	}
	return Allow()
}

// checkBudget caps each consumer independently so one can be throttled to zero
// without silencing the other. An unregistered consumer fails closed: a typo in
// a token's consumer name must not inherit somebody else's allowance.
func checkBudget(req SendRequest, s Store, cfg Config) Decision {
	budget, ok := cfg.Budgets[req.Consumer]
	if !ok {
		return Refuse(RefusedConsumerBudget,
			fmt.Sprintf("consumer %q has no registered budget", req.Consumer))
	}

	hourly, err := s.OutboundCountForConsumer(req.Consumer, req.Now.Add(-time.Hour))
	if err != nil {
		return Refuse(RefusedInternalError, "hourly consumer count failed")
	}
	if hourly >= budget.PerHour {
		return Refuse(RefusedConsumerBudget,
			fmt.Sprintf("%s sent %d messages this hour (cap %d)", req.Consumer, hourly, budget.PerHour))
	}

	daily, err := s.OutboundCountForConsumer(req.Consumer, req.Now.Add(-24*time.Hour))
	if err != nil {
		return Refuse(RefusedInternalError, "daily consumer count failed")
	}
	if daily >= budget.PerDay {
		return Refuse(RefusedConsumerBudget,
			fmt.Sprintf("%s sent %d messages today (cap %d)", req.Consumer, daily, budget.PerDay))
	}
	return Allow()
}

// quietWindowFor resolves the window that applies to one consumer: its own if
// it declared one, otherwise the deployment-wide default. Falling back rather
// than defaulting to "no quiet hours" matters — a consumer that forgot to
// declare a window must inherit the restriction, not escape it.
func quietWindowFor(consumer string, cfg Config) QuietWindow {
	if w, ok := cfg.QuietHours[consumer]; ok {
		return w
	}
	return QuietWindow{StartHour: cfg.QuietStartHour, EndHour: cfg.QuietEndHour}
}

// checkQuietHours refuses sends outside the configured local window. A 03:00
// message is both a bot signal to Meta and a customer-relations problem.
//
// The window is PER CONSUMER, with the deployment-wide setting as the
// fallback: an internal ops consumer paging a human at 03:00 and a
// customer-facing one messaging strangers at 03:00 are not the same act, and
// one deployment runs both.
//
// The window may wrap midnight (21 -> 7), which is the normal configuration,
// so the comparison is written for both the wrapping and non-wrapping cases.
// start == end disables the rail rather than refusing every hour of the day —
// the alternative silently bricks the service on a zero-valued config.
func checkQuietHours(req SendRequest, s Store, cfg Config) Decision {
	w := quietWindowFor(req.Consumer, cfg)
	if w.StartHour == w.EndHour {
		return Allow()
	}
	loc := cfg.Location
	if loc == nil {
		loc = time.UTC
	}
	h := req.Now.In(loc).Hour()

	quiet := false
	if w.StartHour < w.EndHour {
		quiet = h >= w.StartHour && h < w.EndHour
	} else {
		quiet = h >= w.StartHour || h < w.EndHour
	}
	if quiet && humanReplyInOpenSession(req, s, cfg) {
		return Allow()
	}
	if quiet {
		return Refuse(RefusedQuietHours,
			fmt.Sprintf("local time %02d:00 is inside quiet hours %02d:00-%02d:00 for consumer %q",
				h, w.StartHour, w.EndHour, req.Consumer))
	}
	return Allow()
}

// humanReplyInOpenSession reports whether this send is an operator answering a
// contact who is still waiting on them.
//
// Quiet hours exist to stop this number looking like a 03:00 bulk sender. A
// person replying to someone who messaged an hour ago is the opposite signal —
// it is what a real business does — and refusing it is what pushes an operator
// to disable the window for the whole number, which strips the protection from
// the automated sends too. That is the failure this narrow exemption prevents.
//
// Both conditions are required and neither is sufficient. The flag alone would
// make "human" a blanket pass, and reaching for a contact who last wrote days
// ago is an outreach at 06:00 however it was typed. A store error refuses,
// because an exemption that cannot verify its own precondition is not one.
func humanReplyInOpenSession(req SendRequest, s Store, cfg Config) bool {
	if !req.HumanReply || cfg.HumanReplySessionWindow <= 0 || s == nil {
		return false
	}
	last, ok, err := s.LastInboundFrom(req.To)
	if err != nil {
		// An exemption that cannot verify its own precondition is not one.
		return false
	}
	if !ok {
		// Never messaged us, so there is no session to be inside. Checked
		// separately from the error: collapsed into one condition, a test for
		// this case passes even when the branch is gone, because the zero time
		// makes req.Now.Sub(last) about two thousand years — comfortably
		// outside any window, for entirely the wrong reason.
		return false
	}
	return req.Now.Sub(last) < cfg.HumanReplySessionWindow
}
