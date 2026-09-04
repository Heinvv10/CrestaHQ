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

// checkQuietHours refuses sends outside the configured local window. A 03:00
// message is both a bot signal to Meta and a customer-relations problem.
//
// The window may wrap midnight (21 -> 7), which is the normal configuration,
// so the comparison is written for both the wrapping and non-wrapping cases.
// start == end disables the rail rather than refusing every hour of the day —
// the alternative silently bricks the service on a zero-valued config.
func checkQuietHours(req SendRequest, cfg Config) Decision {
	if cfg.QuietStartHour == cfg.QuietEndHour {
		return Allow()
	}
	loc := cfg.Location
	if loc == nil {
		loc = time.UTC
	}
	h := req.Now.In(loc).Hour()

	quiet := false
	if cfg.QuietStartHour < cfg.QuietEndHour {
		quiet = h >= cfg.QuietStartHour && h < cfg.QuietEndHour
	} else {
		quiet = h >= cfg.QuietStartHour || h < cfg.QuietEndHour
	}
	if quiet {
		return Refuse(RefusedQuietHours,
			fmt.Sprintf("local time %02d:00 is inside quiet hours %02d:00-%02d:00",
				h, cfg.QuietStartHour, cfg.QuietEndHour))
	}
	return Allow()
}
