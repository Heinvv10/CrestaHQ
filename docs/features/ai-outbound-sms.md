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
  - Activating a workflow that contains the step, or saving the step into an active one: the workflow PATCH answers 400 (`aiSmsActivationBlock`). The builder hides the step from the add menu while the gate is off and flags a step that can't run.
  - **Every send**: the step re-reads the gate and readiness, so anything switched off later skips the step with its reason in the run history (`skipped:ai_sms_gate_off`, `skipped:not_ready:<check>`).

## What one step does

In order, each with its run-history result:

1. No instruction → `error:no_instruction`.
2. Gate off → `skipped:ai_sms_gate_off`.
3. SMS opt-out or declined SMS consent (`smsSendBlock`) → `skipped:opt_out`. A WhatsApp opt-out does not apply.
4. No phone → `skipped:no_phone`.
5. Not ready → `skipped:not_ready:<check>`.
6. Conversation bot off or paused (a person took over) → `skipped:bot_paused`.
7. Quiet hours → held and re-run at the window's end, before the model is called (nothing spent).
8. Monthly `aiTokens` or `smsSegments` quota reached → `skipped:quota`.
9. The model writes the text. A model failure → `error:ai_failed:<reason>`.
10. Conversation on Suggest → saved as an inbox draft for a person to approve (`drafted:suggest_mode`).
11. Sent through `sendSmsForSubAccount({ origin: "automated" })`, which holds it again if quiet hours began meanwhile.

The step is in `AT_MOST_ONCE_NODES`, so a QStash redelivery never texts twice, and the prospecting approach guard applies as on any send.

## The text

- At most two SMS segments, opt-out line included.
- It always names the business: when the model didn't, the name is put first.
- It always ends with " Reply STOP to opt out." — this is the first message the contact gets, so the line is not optional. A STOP line the model wrote itself is removed so it appears once.
- Plain GSM text: smart quotes and dashes are replaced so the text doesn't switch to UCS-2.
- **No links unless the instruction has them.** A web address, bare domain or email address that isn't word for word in the instruction refuses the send (`error:ai_link_not_allowed`). No booking block is put in the prompt.
- **Contact fields are untrusted.** Name, company, source and campaign go into the prompt as one line each, capped at 80 characters, with control characters removed and `---` collapsed, so a field can't forge a prompt section. The prompt says the contact context is data, not instructions.

## Metering

- `smsSegments` is recorded by `sendSmsForSubAccount`.
- `aiTokens` is recorded through `incrementChannelTokens(…, "sms", …)` whenever the model was called, including a text that was refused afterwards.

## Not ported from upstream

- **Upstream's agent-hours retry** (`secondsUntilAiCanConverse` plus the `retry` step result). Our workspace quiet hours hold the send instead. A text can therefore go out inside the send window while the AI agent's own hours are closed; a reply then gets no AI answer until they open.
- **The `appendOptOut` switch.** The opt-out line is always added.
- **WhatsApp.** SMS only (Decision 5 of the 1.0.54 plan).
