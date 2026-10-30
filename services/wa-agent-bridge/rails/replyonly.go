package rails

// checkReplyOnly is the core protection. An outbound to a JID that has never
// sent us a message is refused.
//
// This is the rail that replaces Meta's 24-hour service window. On the Twilio
// and Cloud rails that window is doing double duty: a compliance rule and an
// accidental rate limiter that makes cold bulk outbound impossible. This rail
// runs with enforcesWindow:false, so without this check the failure mode
// returns immediately.
//
// The evidence is direct: the same number, on the same library, ran a
// reply-only group path for months without incident and was banned within days
// of sending cold DMs.
//
// The allowlist is the only override, and it is deliberately one-JID-at-a-time
// so that using it at volume is painful.
func checkReplyOnly(req SendRequest, s Store) Decision {
	allowed, err := s.IsAllowlisted(req.To)
	if err != nil {
		return Refuse(RefusedInternalError, "allowlist lookup failed")
	}
	if allowed {
		return Allow()
	}

	hasInbound, err := s.HasInboundFrom(req.To)
	if err != nil {
		return Refuse(RefusedInternalError, "inbound history lookup failed")
	}
	if !hasInbound {
		return Refuse(RefusedReplyOnly,
			"this contact has never messaged this number; add them to the allowlist to override")
	}
	return Allow()
}
