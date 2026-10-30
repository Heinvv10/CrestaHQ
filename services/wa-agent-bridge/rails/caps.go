package rails

import (
	"fmt"
	"time"
)

// checkCaps enforces the three volume limits.
//
// Ordering inside this rail matters for the operator, not the outcome: the
// per-contact checks come first because "you are talking at one person too
// much" is a more actionable message than "the account is at its daily
// ceiling".
//
// Every count is read from the Store on each call rather than cached, so the
// limits survive a restart. That is not an optimisation detail: a cap that
// resets when the process dies converts a crash-loop into a send-loop.
func checkCaps(req SendRequest, s Store, cfg Config) Decision {
	dayAgo := req.Now.Add(-24 * time.Hour)

	perContact, err := s.OutboundCountForContact(req.To, dayAgo)
	if err != nil {
		return Refuse(RefusedInternalError, "per-contact count failed")
	}
	if perContact >= cfg.PerContactPerDay {
		return Refuse(RefusedPerContactCap,
			fmt.Sprintf("already sent %d messages to this contact in 24h (cap %d)",
				perContact, cfg.PerContactPerDay))
	}

	consecutive, err := s.ConsecutiveOutbound(req.To)
	if err != nil {
		return Refuse(RefusedInternalError, "consecutive count failed")
	}
	if consecutive >= cfg.ConsecutiveMax {
		return Refuse(RefusedConsecutiveCap,
			fmt.Sprintf("%d unanswered messages already sent to this contact (cap %d)",
				consecutive, cfg.ConsecutiveMax))
	}

	total, err := s.OutboundCountTotal(dayAgo)
	if err != nil {
		return Refuse(RefusedInternalError, "daily total count failed")
	}
	if total >= cfg.GlobalDailyCap {
		return Refuse(RefusedDailyCap,
			fmt.Sprintf("account sent %d messages in 24h (cap %d)", total, cfg.GlobalDailyCap))
	}

	return Allow()
}
