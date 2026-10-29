# AI texts — the "Send AI text" workflow step

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md).*

**NOT runtime-verified.** Merged dark: the agency gate `aiOutboundSmsEnabledByAgency` defaults off, and no tenant with a dedicated Twilio number has walked it live. Ported from upstream 1.0.54 (unit J1), SMS only.

A workflow step (`send_ai_sms`) in which the AI writes the contact a short first text from the agent persona, the website knowledge base and the contact's details, then sends it from the workspace's own Twilio number. When the contact replies, the existing SMS AI agent carries on the conversation.

## Gate and readiness

- **Gate.** `aiOutboundSmsEnabledByAgency` (agency owner, Manage dialog → "AI texts"). Standalone, not a plan gate, `assistantMayEnable: false`. See [feature-gates.md](../architecture/feature-gates.md).
- **Readiness** (`aiOutboundSmsReadiness`, [src/lib/comms/ai/outbound-sms.ts](../../src/lib/comms/ai/outbound-sms.ts)). Every check must pass:
  - `OPENROUTER_API_KEY` set;
  - QStash configured;
  - the workspace's own Twilio number, with the auth token readable from `private/twilioCredentials` (`readSubAccountSecret`). The shared sender never counts: a reply to it can't reach this workspace's AI;
  - SMS AI auto-reply allowed by the agency (`smsAgentEnabledByAgency`);
  - the SMS AI agent switched on;
  - a persona prompt.
- **Where it is checked.**
  - Enabling the gate: `PATCH …/feature-gates` answers 409 with the first unmet check (`aiOutboundSmsEnableBlock`). An SMS AI gate switched off in the same request counts as off. Disabling is always allowed.
  - Checklist: `GET /api/agency/sub-accounts/[id]/ai-outbound-sms-readiness` (agency owner only), shown under the toggle.
  - Activating a workflow that contains the step, or saving the step into an active one: the workflow PATCH answers 400 (`aiSmsActivationBlock`). The Agent API's `set_workflow_status` (active) and `update_workflow` on an active workflow refuse the same way, in the preview (so no proposal is made, and the approve-time re-check refuses one) and again in execute. The builder hides the step from the add menu while the gate is off, flags a step that can't run, and warns when the workflow can reach a contact repeatedly (a `message.received` trigger or re-entry "every time").
  - **Every send**: the step re-reads the gate and readiness, so anything switched off later skips the step with its reason in the run history (`skipped:ai_sms_gate_off`, `skipped:not_ready:<check>`).

## What one step does

One check (`aiSmsCheck` in `engine.ts`) decides whether the step may go ahead. `runStep` runs it **before the prospecting approach stamp**, so a step that can't send never stamps or counts. Its results, in order:

1. No instruction → `error:no_instruction`.
2. Gate off → `skipped:ai_sms_gate_off`.
3. SMS opt-out or declined SMS consent (`smsSendBlock`) → `skipped:opt_out`. A WhatsApp opt-out does not apply.
4. No phone → `skipped:no_phone`.
5. The workflow was deleted or its status changed since the step began → `skipped:workflow_changed`.
6. Not ready → `skipped:not_ready:<check>`.
7. Conversation bot off or paused (a person took over) → `skipped:bot_paused`.
8. The contact had an AI text in the last 30 days → `skipped:ai_sms_cooldown`.
9. Quiet hours → held and re-run at the window's end (nothing spent).
10. Monthly `aiTokens` or `smsSegments` quota reached → `skipped:quota`.

Then:

- The model writes the text. A model failure → `error:ai_failed:<reason>`; a text the output check refuses → `error:ai_link_not_allowed` or `error:ai_empty`.
- **The contact and sub-account are read again and the check re-runs** (quota aside), because the contact may opt out, the agency switch AI texts off, a person take over or the workflow be paused while the AI writes. A stop here logs `<reason>:after_generation`. A changed phone number → `skipped:phone_changed:after_generation`.
- The 30-day cooldown is claimed in a transaction (`subAccounts/{id}/aiSmsCooldowns/{contactId}`, `lib/workflows/ai-sms-cooldown.ts`); it is handed back if nothing goes out.
- Conversation on Suggest → saved as an inbox draft for a person to approve (`drafted:suggest_mode`).
- Sent through `sendSmsForSubAccount({ origin: "automated" })`, which holds it again if quiet hours began meanwhile.
- Once tokens are spent, a throw is recorded (`error:ai_after_generation:<reason>`, the run fails) instead of releasing the claim for a paid retry.

The step is in `AT_MOST_ONCE_NODES`, so a QStash redelivery never texts twice. The prospecting approach guard applies as on any send; the stamp records the run and step that made it (`approachedRunId`, `approachedNodeId`), and a later send of the same workflow takes it over. A first touch this delivery stamped is **handed back** (stamp cleared, the day's cap slot returned, `releaseApproach`) only on an outcome that produced and queued nothing — gate off, not ready, bot paused, quota (each also `:after_generation`), `error:ai_failed`, `error:ai_link_not_allowed`, `error:ai_empty` — and only while the stamp is still this run and step's. A draft, a quiet-hours hold, an opt-out during generation or a failure mid-way keeps it.

## The text

Shaping and the output check live in [src/lib/comms/ai/outbound-sms-text.ts](../../src/lib/comms/ai/outbound-sms-text.ts).

- **Normalised before anything else**: NFKC, format characters (zero-width, bidi, soft hyphen) and astral characters (emoji) removed, look-alike dots, colons, slashes and at signs turned into the real ones, smart quotes and dashes made GSM-friendly. The normalised text is what is sent.
- **Output check is an allow-list.** The text is refused (`error:ai_link_not_allowed`) if it contains a run of 7+ digits (whatever non-letters sit between them), 7+ digits spelled out ("oh eight two…", words and digits mixed), any digit other than 0-9, any non-Latin letter outside the exact business and first name, `tel:`, `@`, a dot, colon or slash inside or spaced around a word, "dot" between words, bracketed `(.)` / `[at]` forms or `hxxp` — unless the business wrote that exact token sequence in the instruction (or it is the business name). Exact whole-token equality, never a substring; scheme and host compare case-insensitively, the path and query exactly as the instruction has them. Tokens are never folded: since any non-Latin letter outside the exact business and first name already refuses the text, a look-alike of an allowed link can neither match it nor slip through. Checked on the final trimmed body. A consequence: times, decimals, `24/7` or `e.g.` refuse the text unless the instruction has them; the prompt tells the model to avoid them.
- **Opt-out**: whole sentences that are an opt-out instruction ("Reply STOP to opt out.", "To opt out, reply STOP.") are removed; any stop, opt-out or unsubscribe wording left refuses the text (`error:ai_empty`), so " Reply STOP to opt out." — always appended — is the only one. Hyphenated words ("stop-gap") are not opt-out wording.
- At most two SMS segments, opt-out line included, counted as the carrier bills them (UCS-2 in UTF-16 units).
- It always names the business: when the model didn't, the name is put first.
- No booking block is put in the prompt.
- **The prompt knows only the contact's first name** (letters, apostrophes, hyphens, max 40 characters; anything else is left out) and the business name — no company, source, campaign or deals. The shared contact context block (`context.ts`, used by the reply agents) runs every free-text field and deal title through `promptSafe` (one line, capped, no control/format/separator characters, no `---` or heading runs).

## Metering

- `smsSegments` is recorded by `sendSmsForSubAccount`.
- `aiTokens` is recorded through `incrementChannelTokens(…, "sms", …)` whenever the model was called, including a text that was refused afterwards.

## Not ported from upstream

- **Upstream's agent-hours retry** (`secondsUntilAiCanConverse` plus the `retry` step result). Our workspace quiet hours hold the send instead. A text can therefore go out inside the send window while the AI agent's own hours are closed; a reply then gets no AI answer until they open.
- **The `appendOptOut` switch.** The opt-out line is always added.
- **WhatsApp.** SMS only (Decision 5 of the 1.0.54 plan).
