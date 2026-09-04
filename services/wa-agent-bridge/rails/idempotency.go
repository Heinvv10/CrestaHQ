package rails

// checkIdempotency short-circuits a replayed send.
//
// An idempotency key is mandatory rather than optional. Callers retry — on a
// timeout, on a redeploy, on a queue redelivery — and a retry without a key is
// indistinguishable from a new message, which means the contact gets it twice.
// Requiring the key makes the safe path the only path.
func checkIdempotency(req SendRequest, s Store) Decision {
	if req.IdempotencyKey == "" {
		return Refuse(RefusedInternalError,
			"idempotencyKey is required; without it a retry would duplicate the message")
	}
	id, found, err := s.LookupIdempotency(req.IdempotencyKey)
	if err != nil {
		return Refuse(RefusedInternalError, "idempotency lookup failed")
	}
	if found {
		return Duplicate(id)
	}
	return Allow()
}
