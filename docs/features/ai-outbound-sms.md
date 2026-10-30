# AI texts — the "Send AI text" workflow step

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md).*

**NOT runtime-verified.** Merged dark: the agency gate `aiOutboundSmsEnabledByAgency` defaults off, and no tenant with a dedicated Twilio number has walked it live. Ported from upstream 1.0.54 (unit J1), SMS only.

A workflow step (`send_ai_sms`) that sends a first text the OPERATOR writes, with one short line the AI writes into it, from the workspace's own Twilio number. When the contact replies, the existing SMS AI agent carries on the conversation.

**Why a template.** An earlier version let the model write the whole text and filtered it. A filter over free text did not converge: spelled-out numbers, handles and spelled domains still got through, and it refused half of normal openers. So the operator's words go out as written, and the model fills one slot held to a tiny alphabet.

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

1. No instruction → `error:no_instruction`; a template that fails `templateProblem` → `error:template_invalid`.
2. Gate off → `skipped:ai_sms_gate_off`; automations paused for the workspace → `skipped:automations_paused`.
3. SMS opt-out or declined SMS consent (`smsSendBlock`) → `skipped:opt_out`. A WhatsApp opt-out does not apply.
4. No phone → `skipped:no_phone`.
5. The workflow was deleted, its status changed since the step began, or the step's instruction, template or "send without the AI line" setting changed → `skipped:workflow_changed`; the run is no longer running or waiting → `skipped:run_ended`.
6. Not ready → `skipped:not_ready:<check>`.
7. Conversation bot off or paused (a person took over) → `skipped:bot_paused`.
8. The contact had an AI text in the last 30 days → `skipped:ai_sms_cooldown`.
9. Quiet hours → held and re-run at the window's end (nothing spent).
10. Monthly `aiTokens` or `smsSegments` quota reached → `skipped:quota`.

Then:

- The model writes the `{{ai}}` line (see below). A model failure → `error:ai_failed:<reason>`; a line refused twice with "send without the AI line" off → `error:ai_failed:slot_invalid:<reason>`; a message over two segments even without the line → `error:ai_too_long`; the template sent without the line → `ok:without_ai_line`.
- **The contact and sub-account are read again and the check re-runs** (quota aside), because the contact may opt out, the agency switch AI texts off, a person take over, automations be paused, the run end, or the workflow, its step config or status change while the AI writes. A stop here logs `<reason>:after_generation`. A changed phone number → `skipped:phone_changed:after_generation`.
- The 30-day cooldown is claimed in a transaction (`subAccounts/{id}/aiSmsCooldowns/{contactId}`, `lib/workflows/ai-sms-cooldown.ts`); it is handed back if nothing goes out.
- Conversation on Suggest → saved as an inbox draft for a person to approve (`drafted:suggest_mode`).
- Sent through `sendSmsForSubAccount({ origin: "automated" })`, which holds it again if quiet hours began meanwhile.
- Once tokens are spent, a throw is recorded (`error:ai_after_generation:<reason>`, the run fails) instead of releasing the claim for a paid retry.

The step is in `AT_MOST_ONCE_NODES`, so a QStash redelivery never texts twice. The prospecting approach guard applies as on any send; the stamp records the run and step that made it (`approachedRunId`, `approachedNodeId`), and a later send of the same workflow takes it over. A first touch this delivery stamped is **handed back** (stamp cleared, the day's cap slot returned, `releaseApproach`) only on an outcome that produced and queued nothing — gate off, not ready, bot paused, quota (each also `:after_generation`), `error:ai_failed`, `error:ai_too_long` — and only while the stamp is still this run and step's. A draft, a quiet-hours hold, an opt-out during generation or a failure mid-way keeps it.

## The text

Template, slot and assembly live in [src/lib/comms/ai/outbound-sms-text.ts](../../src/lib/comms/ai/outbound-sms-text.ts) (pure; the node dialog uses it too).

- **The template** (step config `template`) is the operator's message, sent verbatim. It has exactly one `{{ai}}` and may use `{{firstName}}` and `{{business}}`; any other `{{…}}` is refused. `templateProblem` refuses a template that isn't a string (step configs are client JSON), a missing, doubled or unknown placeholder, and a template whose fixed text alone (plus the opt-out line) can't fit two segments. It runs in the node dialog (Save disabled), when the workflow is saved (400 for a non-empty invalid template, even on a draft), at activation (`aiSmsActivationBlock`, an empty template included) and before every send.
- **The AI's line** (`normaliseSlot` then `slotProblem`). The model's reply is NFKD-normalised with accents dropped ("stóp" is "stop"), dashes made "-", format characters removed. The charset then does the heavy lifting: only ASCII letters, spaces and `' , . ! ? : ) -`, so no digit, symbol, small-caps or other-script trick fits. On top of it:
  - at most 80 characters and two sentences; `:` and `)` only as `:)`; no `.` `!` `?` inside a word;
  - no three single letters in a row ("d o t");
  - fewer than three number words (zero–nine, oh, double, triple, hundred, thousand), so a phone number can't be spelled out;
  - no opt-out word as a whole word — stop, quit, cancel, unsubscribe, unsub, optout, opt-out, remove — or "opt out" as a phrase ("option", "optical" and "adopt" pass);
  - no channel or destination word — whatsapp, facebook, instagram, insta, telegram, tiktok, twitter, linkedin, messenger, snapchat, viber, wechat, skype, discord, signal, email, e-mail, dm, inbox, www, http, https, com, co, za, net, org, dot, slash, url, link, website — checked on the whole word and on its parts split at `-` and `'`. Verbs (call, text, visit…) are allowed: with digits and number words refused, no destination can follow them.
  The model is told the template (with the slot marked), the instruction, the persona, the business name and the contact's first name — nothing else about the contact.
- **One retry.** A line that breaks a rule, or makes the filled-in message longer than two segments, is asked for again once with the reason. If that fails too: with "send without the AI line if it fails" (`sendWithoutAiLine`, default on) the template goes without the line; otherwise nothing goes.
- **Assembly**, in one pass so nothing put in is read as a placeholder again: the slot filled (or removed), `{{firstName}}` (the contact's first word, normalised as above, Latin letters only, 2–20, and passing the line's word checks; "there" otherwise), `{{business}}` (the agent's business name, else the workspace name, braces dropped), then " Reply STOP to opt out.". Segments are counted as the carrier bills them (UCS-2 in UTF-16 units); over two refuses the send.
- No booking block is put in the prompt. The shared contact context block (`context.ts`, used by the reply agents) runs every free-text field and deal title through `promptSafe`.

## Accepted residual risk

The line can still be phishing-style prose without any route: "your payment failed, please update your card details", "download our app and log in", "send us your id number", or a lowercase handle with nothing around it ("find velocitydealsza"). It can't carry a number, address, link or channel name. The operator owns the template and the instruction; the only free input is the contact's first name, which is held to the same rules. Accepted by the lead on the 1.0.54 port (J1).

## Metering

- `smsSegments` is recorded by `sendSmsForSubAccount`.
- `aiTokens` is recorded through `incrementChannelTokens(…, "sms", …)` whenever the model was called, including a text that was refused afterwards.

## Not ported from upstream

- **Upstream's agent-hours retry** (`secondsUntilAiCanConverse` plus the `retry` step result). Our workspace quiet hours hold the send instead. A text can therefore go out inside the send window while the AI agent's own hours are closed; a reply then gets no AI answer until they open.
- **The `appendOptOut` switch.** The opt-out line is always added.
- **The AI writing the whole message.** Replaced by the template and slot above.
- **WhatsApp.** SMS only (Decision 5 of the 1.0.54 plan).
