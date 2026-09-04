package rails

import "strconv"

// IdempotencyStorageKey composes the key a Store actually persists under.
//
// It exists because keys are per-consumer, not global. The documented caller
// convention is to derive keys like "turn-<conversationId>-<turnIndex>", so two
// consumers WILL eventually produce the same raw key. Sharing a key space then
// makes the second consumer's send return Duplicate() carrying the FIRST
// consumer's message id: a real customer reply is silently never sent while the
// caller is told its original stands. Silent non-delivery is worse than a loud
// failure, so the consumer is folded into the stored key.
//
// The composition is length-prefixed rather than separator-joined. A separator
// (even a NUL byte) is only unambiguous while no consumer name can contain it,
// which is an assumption about caller data rather than a property of the code.
// A length prefix is injective for ALL inputs: the prefix says exactly where
// the consumer ends, so ("a","bc") and ("ab","c") cannot collide no matter what
// bytes either string holds.
//
// Exported because the HTTP handler must record the completed send under
// exactly this key. Two call sites composing it independently is how the
// collision bug returns.
func IdempotencyStorageKey(consumer, key string) string {
	return strconv.Itoa(len(consumer)) + ":" + consumer + ":" + key
}

// checkIdempotency short-circuits a replayed send.
//
// An idempotency key is mandatory rather than optional. Callers retry — on a
// timeout, on a redeploy, on a queue redelivery — and a retry without a key is
// indistinguishable from a new message, which means the contact gets it twice.
// Requiring the key makes the safe path the only path.
//
// This is the cheap early reject on the read path, NOT the gate. Store.
// ReserveIdempotency is the gate: a read-only check cannot prevent two
// concurrent requests from both passing and both sending.
func checkIdempotency(req SendRequest, s Store) Decision {
	if req.IdempotencyKey == "" {
		return Refuse(RefusedInternalError,
			"idempotencyKey is required; without it a retry would duplicate the message")
	}
	if req.Consumer == "" {
		return Refuse(RefusedInternalError,
			"consumer is required; an unnamespaced idempotency key collides across consumers")
	}
	id, found, err := s.LookupIdempotency(IdempotencyStorageKey(req.Consumer, req.IdempotencyKey))
	if err != nil {
		return Refuse(RefusedInternalError, "idempotency lookup failed")
	}
	if found {
		if id == "" {
			// A reservation exists but no message id has been recorded yet: another
			// request holds this key and is still sending. We cannot return
			// Duplicate("") — an empty DuplicateOf is indistinguishable from a plain
			// refusal — and we must not send. Refuse loudly; the caller may retry.
			// RefusedInFlight, not RefusedInternalError: nothing is broken. A
			// concurrent retry landing here is the gate working as designed,
			// and the caller may retry shortly.
			return Refuse(RefusedInFlight,
				"a send for this idempotency key is already in flight")
		}
		return Duplicate(id)
	}
	return Allow()
}
