# Hermes control-surface consumer

Phase 1's only consumer. Hermes receives the owner's WhatsApp messages and
replies as the agent.

> This document describes the bridge as it actually ships today, not the
> original phase-1 brief. Three things changed under review: the `CONSUMERS`
> format grew an `admin` field and then a per-consumer quiet-hours pair, and
> health/refusal responses settled into a different shape than first drafted.
> Verify against `config/config.go`, `api/send.go`, `api/admin.go` and
> `api/webhook.go` if this drifts again.

## Registration

`CONSUMERS` is a comma-separated list of pipe-separated entries with **eight**
fields:

```
name|token|webhookURL|perHour|perDay|admin|quietStartHour|quietEndHour
```

```
CONSUMERS=hermes|<token>|http://127.0.0.1:8787/wa-inbound|100|500
```

Pipes, not colons — a webhook URL carries a scheme and a port, and splitting
on `:` mangles it.

Only `name` and `token` are required; `perHour`/`perDay` default to 100/500
if omitted, and the `admin` field defaults to false (an ordinary consumer)
when omitted or left empty. The **only** accepted value in that slot is the
literal string `admin` — anything else fails config load at startup with an
"unknown privilege" error, so a typo here is loud, not silent.

Putting an unintended value in the admin slot doesn't just misconfigure —
it either silently downgrades an operator credential (if `admin` was meant
but a field shifted) or refuses to boot (if garbage lands there). Count your
pipes before deploying. A normal, non-admin Hermes registration has five
fields and a trailing empty slot; write it as either
`hermes|<token>|<url>|100|500` (five fields, admin omitted) or
`hermes|<token>|<url>|100|500|` (six fields, sixth left blank) — both parse
identically. Only add `|admin` on the end for a credential that should be
allowed to add allowlist entries and lift the kill switch.

The last two fields are `quietStartHour`/`quietEndHour`, and they only exist
as a pair: give both or neither. Left off entirely (Hermes's registration
above does this), the consumer inherits the deployment-wide
`QUIET_START_HOUR`/`QUIET_END_HOUR` window — inheriting the restriction,
never escaping it. `hermes|<token>|<url>|100|500||0|0` would disable quiet
hours for Hermes specifically (start == end); half a pair
(`…|admin|21` with no end hour) is refused at startup rather than guessed,
because guessing either direction hands a consumer a window nobody wrote
down. Hours outside `0-23` are refused too. Since every field is
positional, disabling quiet hours without also granting admin needs the
admin slot left empty but present: `hermes|<token>|<url>|100|500||0|0`.

## Inbound contract

The bridge POSTs, with `Authorization: Bearer <token>`:

```json
{ "from": "27821234567@s.whatsapp.net", "text": "check the velo inbox",
  "messageId": "3EB0...", "at": "2026-09-04T12:00:00Z" }
```

That is the complete payload shape today — **`from`, `text`, `messageId`,
`at`, nothing else.** In particular there is no `quotedMessageId` (see "Not
yet built" below).

`messageId` is WhatsApp's own id for the INBOUND message. Use it to dedupe a
redelivery on the id rather than on the body. It can be an empty string when
the transport supplied none — treat empty as unknown, never as a value to key
on.

The consumer MUST verify the bearer token before acting.

Delivery is fire-and-forget per consumer: a failed or slow webhook is logged
by the bridge and does not block delivery to other consumers, and the bridge
has nothing to retry against once an inbound message has been recorded. Treat
each POST as best-effort, at-most-once from the bridge's side — build any
retry/backfill you need on the consumer side, not by expecting the bridge to
redeliver.

## Owner gate

Phase 1's number is unpublished. The bridge itself enforces this — not just
the consumer. When `OWNER_JID` is set, the bridge's inbound fanout
(`api/webhook.go`) forwards a message to registered consumer webhooks **only**
when it comes from that JID; everything else is recorded (so reply-only
history stays accurate) but never forwarded, and never reaches the consumer at
all. An unset `OWNER_JID` accepts every sender — that is the deliberate
default, because empty-meaning-reject-all would brick a deployment that
forgot to set it, silently.

JID matching normalises the device suffix (`27821234567:12@s.whatsapp.net`
matches `27821234567@s.whatsapp.net`) and allows `OWNER_JID` to be written
either as a bare user id (`27821234567`, matches any server) or the full
`user@server` form.

Because the bridge already filters at the source, the consumer does not need
to re-implement an owner check to be safe — but should still treat `from` as
untrusted input and not assume every payload it ever receives is the owner,
in case `OWNER_JID` is ever unset on a shared deployment or a future consumer
is registered without the same guarantee.

## Outbound contract

```
POST /v1/send
Authorization: Bearer <token>
{ "to": "<jid>", "text": "...", "idempotencyKey": "<stable per logical message>" }
```

Both `to` and `text` are required, and so is `idempotencyKey` — its absence is
a 400, not silently accepted, because a client retry with no key is
indistinguishable from a new message. Request bodies over 64 KiB are rejected
with 413.

Responses:

| Status | Body shape | Meaning | Action |
|---|---|---|---|
| 200 | `{ok:true, messageId}` | sent | done |
| 200 | `{ok:true, messageId, duplicate:true}` | replay of a key already used — `messageId` is the ORIGINAL send's id | done, do not resend |
| 409 | `{ok:false, refusedBy:"in_flight", reason}` | another request already holds this idempotency key and is still sending (normal concurrent-retry outcome) | safe to retry shortly |
| 422 | `{ok:false, refusedBy:"idempotency_key_reused", reason}` | this key is already bound to a DIFFERENT recipient — a bug in your key derivation, not a rail refusal | fix the key (include the recipient); **never** retry unchanged, and do not read it as a duplicate |
| 422 | `{ok:false, refusedBy, reason}` | a rail refused for any other reason (`kill_switch`, `consumer_budget`, `reply_only`, `per_contact_cap`, `consecutive_cap`, `daily_cap`, `quiet_hours` (which may be configured per consumer — yours can differ from another consumer's), `internal_error`) | surface `reason`; never retry |
| 401 | `{error}` | missing bearer token, or a token no registered consumer holds — the FIRST status a mis-registered consumer sees | fix `CONSUMERS`/the token; retrying unchanged never helps |
| 400 | `{error}` | malformed request (missing `to`/`text`/`idempotencyKey`, or invalid JSON) | fix the request; do not retry unchanged |
| 413 | `{error}` | body over 64 KiB | fix the request |
| 500 | `{ok:false, error, outcome:"not_sent"}` | the reservation itself failed — the idempotency key or the outbound row could not be written (store problem). Nothing was attempted and no cap budget was spent | may retry with the SAME key once the store is healthy |
| 502 | `{ok:false, error, outcome:"failed"}` | the provider definitively rejected the send; nothing reached WhatsApp | safe to retry (the reservation and its cap budget were both released) |
| 502 | `{ok:false, error, outcome:"ambiguous"}` | timed out — it may or may not have been delivered | **do not retry** — reuse the same key if you must; the reservation is deliberately left in place to expire, not released, and its cap budget stays spent for the same reason |

`idempotencyKey` is mandatory. Derive it from the logical message
(e.g. `turn-<conversationId>-<turnIndex>`), never from a timestamp, or a retry
produces a new key and duplicates the message. The key is namespaced by
consumer server-side, so two different consumers may reuse the same literal
key string without colliding.

A key is bound to **one recipient**. The same literal key sent to a second
contact is refused with `idempotency_key_reused` rather than answered as a
duplicate — because answering it as a duplicate would hand back the first
contact's `messageId` while the second message was never sent to anyone, and a
silent non-delivery is worse than a loud failure. Derive keys that include the
recipient (or a conversation id that already implies one).

## Required consumer behaviour

**Immediate ack.** An agent turn can take minutes. Send a short ack first, then
the result. Two minutes of silence reads as broken and provokes a re-send that
duplicates the work.

**Length budget.** Terminal output pasted into WhatsApp is unreadable. Cap
replies at ~1200 characters, truncate, and offer `reply MORE`.

**Quoted-reply correlation — not yet built.** Inbound now carries its own
`messageId` (added after review), and every outbound carries one in its
`/v1/send` response — but the phase-1 bridge still does **not** forward a
`quotedMessageId`, i.e. which of OUR messages an inbound is replying to. That
is a different lookup, into whatsmeow's `ContextInfo`. So a consumer can
dedupe an inbound, but cannot yet attach a reply to a *specific* prior message
versus "whatever was most recently sent."
**Adding inbound `quotedMessageId` forwarding is the first task of the
phase-2 plan**, alongside the LeadStack provider. Phase 1 proves the
ergonomics with unquoted replies only; do not build phase-2's approval-gate
correlation logic against a field that does not exist yet.

## Manual end-to-end verification (cannot be unit-tested)

This needs two real phones. Record the result in the PR description:

1. Start the bridge, pair the dedicated number.
2. Start the consumer with `OWNER_JID` set to your personal number's JID.
3. DM the dedicated number from your phone. Confirm: an ack arrives within
   seconds, then the answer.
4. Restart the bridge mid-conversation. Confirm no duplicate replies in the
   five minutes after reconnect (the replay window).
5. From a *different* phone, DM the dedicated number. Confirm it is dropped
   and logged, with no reply, and no webhook delivery to the consumer at all.
6. `POST /v1/kill {"on":true}` (any consumer may do this). Confirm the next
   agent reply is refused with `kill_switch` and nothing is delivered.
   Lifting it back to `false` requires an **admin** consumer token — a
   non-admin token gets 403.
7. Send enough messages in a row without replying from the phone to exceed
   `CAP_CONSECUTIVE` (default 3). Confirm the next send is refused with
   `consecutive_cap`.
