# Agent API: capability table

<!-- Generated from the registry by src/lib/ai-suite/agent-api-doc.test.ts. Do not edit by hand:
     rerun with `UPDATE_AGENT_API_DOCS=1 pnpm exec vitest run src/lib/ai-suite/agent-api-doc.test.ts`. -->

Every tool an `agent` key can call, in the order `tools/list` returns them. **Kind**: `read`, `write`
(direct; workflow enrolments it causes are still held for approval), or an approval class, meaning a
person approves each call on the Approvals page. **Role**: what the key's calls need, and what the
approver must hold. See [agent-api.md](agent-api.md) for the model.

| Tool | Kind | Role | What it does | What the approval preview shows |
|---|---|---|---|---|
| `find_contacts` | read | member | Search this sub-account's contacts by name, email, phone, or company. |  |
| `workspace_stats` | read | member | Get a snapshot of this workspace: deal counts + values per pipeline stage, total contacts, open and overdue tasks, upcoming calendar events, and quotes. |  |
| `find_deals` | read | member | Search this sub-account's deals by title fragment and/or pipeline stage. |  |
| `create_deal` | write | member | Create a deal on the pipeline for an existing contact. |  |
| `move_deal_stage` | write | member | Move an existing deal to a different pipeline stage. |  |
| `update_deal` | write | member | Change a deal's title, value, currency or priority. |  |
| `delete_deal` | `hard_delete` | member | Delete a deal permanently. | the deal (value, stage, contact), its id and creation time, a warning if an agent created it |
| `mark_deal_completed` | `outbound` | member | Mark a Won deal completed, as the deal card's tick does. | the deal, its Won stage and value, a warning if an agent last edited the pipeline; the exact review request or why none |
| `list_pipelines` | read | member | List the sub-account's pipelines with their stages (label, id, won/lost). |  |
| `get_pipeline` | read | member | Read one pipeline: its name and full stage list (as JSON). |  |
| `create_pipeline` | write | admin | Create a pipeline with its stages. |  |
| `update_pipeline` | write | admin | Rename a pipeline and/or replace its stage list (read get_pipeline first). |  |
| `delete_pipeline` | `hard_delete` | admin | Delete a pipeline. | the pipeline, its stages, how many deals are in it; it will fail while any are |
| `list_custom_fields` | read | member | List the sub-account's custom fields: id, key (the name to use in customFields), label, entity, type, options and folder. |  |
| `create_custom_field` | write | admin | Create a custom field. |  |
| `update_custom_field` | write | admin | Edit a custom field. |  |
| `delete_custom_field` | `hard_delete` | admin | Delete a custom field. | the field and its key, what uses it (workflows, templates), its stored values, reuse of the key later |
| `list_custom_field_folders` | read | member | List the custom-field folders (id, name, entity), in display order. |  |
| `create_custom_field_folder` | write | admin | Create a folder for contact or deal custom fields (added last). |  |
| `update_custom_field_folder` | write | admin | Rename a custom-field folder. |  |
| `reorder_custom_field_folders` | write | admin | Set the order of one entity's folders: `ids` must list every folder of that entity exactly once, in the order wanted. |  |
| `delete_custom_field_folder` | `hard_delete` | admin | Delete a custom-field folder; its fields move to General (none are deleted). | the folder; its fields move to General |
| `list_products` | read | member | List the sub-account's products: id, name, price, currency and whether each is active. |  |
| `create_product` | write | member | Add a product (name and unitPriceCents required). |  |
| `update_product` | write; `spend` when the product is sold by a checkout page or funnel, or is on sale online | member | Edit a product's name, description, price, currency, active flag or order-bump settings. | every asked field old -> new, what sells the product (checkout pages, funnels, its buy link) and what buyers then see |
| `delete_product` | `hard_delete` | member | Delete a product permanently. | the product, its price and the open quotes / invoices using it; refused while a checkout page or funnel sells it or it is on sale online |
| `list_snippets` | read | member | List the sub-account's snippets (saved replies): id, name, type, folder, subject and body. |  |
| `create_snippet` | write | member | Create a snippet (a saved reply people insert into messages). |  |
| `update_snippet` | write | member | Replace a snippet's name, type, body, subject and folder (send them all, as list_snippets shows them). |  |
| `delete_snippet` | `hard_delete` | member | Delete a snippet. | the snippet's subject and body |
| `list_whatsapp_templates` | read | member | List the sub-account's WhatsApp templates for send_whatsapp_template: id, name, language, approval per rail, body and variables. |  |
| `create_whatsapp_template` | write | admin | Create a DRAFT WhatsApp template. |  |
| `submit_whatsapp_template` | write | admin | Submit a draft, rejected or failed WhatsApp template to Meta for review, on the WhatsApp rail this workspace sends on. |  |
| `list_quotes` | read | member | List quotes and invoices, newest first: id, number, kind, status, contact and total. |  |
| `get_quote` | read | member | Read one quote or invoice: status, contact, lines, totals, terms, dates and linked deal. |  |
| `create_quote` | write | member | Draft a quote (or invoice, kind:"invoice") for a contact, with at least one line. |  |
| `update_quote` | write; `spend` when the quote or invoice is no longer a draft | member | Edit a quote's or invoice's lines, currency, discount, tax, terms, billing details, dates or linked deal. | every asked field old -> new, the line items before and after, and the total |
| `send_quote` | `outbound` | member | Email a quote or invoice to its contact with a link to view (and for an invoice, pay) it, as the Send button does. | to, from, reply-to, channel (email), payment rail, exact subject and message (links as placeholders), what happens next |
| `mark_quote_paid` | `outbound` | member | Record that an accepted quote or a sent invoice was paid, as its Mark as paid button does. | amount and currency, how it is recorded, the quote.paid workflows it starts (their steps pinned), the exact review request or why none |
| `list_recurring_schedules` | read | admin | List recurring invoice schedules: id, name, status, contact, frequency and next billing date. |  |
| `create_recurring_schedule` | `spend` | admin | Set up a schedule that raises and emails (or card-charges) an invoice to a contact every cycle. | the whole schedule, where invoices go, whether a card is charged |
| `update_recurring_schedule` | `spend` | admin | Change a recurring schedule's name, lines, amounts, frequency, billing day, ending, review or card settings. | the schedule old -> new, the card outcome, any pro-rata |
| `pause_recurring_schedule` | `spend` | admin | Pause a recurring schedule. | the schedule old -> new and the card outcome |
| `resume_recurring_schedule` | `spend` | admin | Resume a paused recurring schedule: it bills again from the next cycle due today or later (cycles missed while paused are not billed). | the schedule old -> new and the card outcome |
| `cancel_recurring_schedule` | `spend` | admin | Cancel a recurring schedule for good (it can't be resumed). | the schedule old -> new and the card outcome |
| `list_webhooks` | read | admin | List this sub-account's outbound webhook subscriptions (id, URL, events, status, last delivery). |  |
| `list_communities` | read | member | List this workspace's community groups (name, status, mode, slug, group id) and the courses inside each (title, published or not, course id). |  |
| `create_workflow` | write | admin | Create a new automation workflow (as a draft) from a starter template in this sub-account. |  |
| `list_workflows` | read | admin | List the sub-account's automation workflows: name, id, status and trigger. |  |
| `get_workflow` | read | admin | Read one workflow: status, trigger, re-entry, start step and every step (as JSON). |  |
| `list_workflow_runs` | read | admin | List a workflow's most recent runs (up to 100): the contact, status, whether it was a test, when it started, and its last step. |  |
| `update_workflow` | write; `workflow_activate` when the workflow is active, or the edit changes its steps while runs are in progress | admin | Change a workflow's name, trigger, re-entry, steps (`nodes` replaces them all; read get_workflow first) or start step. | which fields change, and that later enrolments and runs in progress take the new steps |
| `set_workflow_status` | write; `workflow_activate` when status=active | admin | Set a workflow's status: `paused` or `draft` stop it at once; `active` is queued for a sub-account admin to approve, showing the exact trigger and steps that will run. | activating: the exact trigger and steps (pinned) and what runs from approval on |
| `delete_workflow` | `hard_delete` | admin | Delete a workflow permanently. | the workflow, its id and creation time, its trigger and steps |
| `list_forms` | read | member | List this workspace's forms with id, name, enabled flag, submission count, public URL, and iframe embed snippet. |  |
| `create_form` | write | admin | Create a new public lead-capture form in this workspace from a preset. |  |
| `create_contact` | write | member | Add a new contact to this sub-account. |  |
| `get_contact` | read | member | Read one contact's details: name, phone, email, company, address, tags, custom fields and messaging opt-outs. |  |
| `update_contact` | write | member | Edit a contact's name, company, address, custom fields (merged into the existing ones) or tags (replaces the tag list; prefer add_tags / remove_tags). |  |
| `add_tags` | write | member | Add tags to a contact, keeping its existing tags. |  |
| `remove_tags` | write | member | Remove tags from a contact (exact match); tags it doesn't have are ignored. |  |
| `update_contact_channels` | `channel_change` | member | Change a contact's phone number and/or email address. | the contact and its phone / email old -> new (pinned) |
| `delete_contact` | `hard_delete` | admin | Permanently delete a contact with its notes, activities and messages. | the contact, its phone and email, what is deleted with it; it will fail while still linked |
| `list_companies` | read | member | List the companies in this sub-account (name, id, phone, email, website), optionally filtered by a name fragment. |  |
| `create_company` | write | member | Add a company to this sub-account. |  |
| `update_company` | write | member | Edit a company's name, phone, email, website or address. |  |
| `delete_company` | `hard_delete` | admin | Delete a company. | the company and how many contacts it unlinks (they keep the name as text) |
| `find_conversations` | read | member | List this sub-account's most recent conversations (newest first), optionally filtered by status or by a contact name / phone / email fragment. |  |
| `get_conversation` | read | member | Read one conversation: its status, AI mode, channels, and its 20 most recent messages across every channel (email, SMS, WhatsApp, Messenger / Instagram, or the web-chat transcript). |  |
| `list_scheduled_messages` | read | member | List the messages scheduled for a contact (soonest first), with their status. |  |
| `set_bot_mode` | write; `outbound` when mode≠off | member | Set a conversation's AI mode: off, suggest (drafts for a person to send) or auto (the AI replies on its own). | the conversation, the AI mode, its effect and any held replies |
| `cancel_scheduled_message` | write | member | Cancel a pending scheduled message (or dismiss a failed one). |  |
| `add_conversation_note` | write | member | Add an internal note to a contact's conversation thread: staff see it, the customer never does and nothing is sent. |  |
| `send_message` | `outbound` | member | Send a message to a conversation's contact on sms, whatsapp, email (needs a subject), messenger or instagram. | to, from, channel, consent, the exact text (subject and reply-to for email), when |
| `schedule_message` | `outbound` | member | Schedule a message to a conversation's contact for a later time (at least a minute and at most 7 days ahead), on sms, whatsapp, email (needs a subject), messenger or instagram. | to, from, channel, consent, the exact text, when it sends and what then happens |
| `send_whatsapp_template` | `outbound` | member | Send one of the sub-account's approved WhatsApp templates to a conversation's contact; the only WhatsApp message allowed after the contact's 24-hour reply window has closed. | to, from (the sending number), template, language, the filled text and buttons, when |
| `create_task` | write | member | Create a task (to-do) in this sub-account, optionally with a due date and linked to a contact. |  |
| `find_tasks` | read | member | List this workspace's open (incomplete) tasks, filtered to today / overdue / upcoming, or everything open. |  |
| `complete_task` | write | member | Mark one of this workspace's tasks as completed. |  |
| `update_task` | write | member | Edit a task's title, notes, due date (YYYY-MM-DD, or null to clear) or linked contact / deal / appointment (null unlinks). |  |
| `delete_task` | `hard_delete` | member | Delete a task permanently. | the task: due, done, assignee, what it links to, notes |
| `find_events` | read | member | List this workspace's upcoming calendar events (today / next 7 days / everything upcoming), in the workspace's timezone. |  |
| `create_event` | write | member | Create a calendar event in this workspace. |  |
| `set_event_status` | write; `outbound` when status=cancelled | member | Set an appointment's status, as the calendar's status buttons do: completed or no_show (only once it has started) or cancelled. | cancelling: the appointment, the timeline reason, the exact notice or why none, the workflows that start (their steps pinned) |
| `list_booking_pages` | read | member | List the sub-account's booking pages: slug, name, status (draft or published) and meeting length. |  |
| `get_booking_page` | read | member | Read a booking page's settings: times, questions, hosts, reminders, payment and confirmation text. |  |
| `create_booking_page` | write; `public_change` when status=published | admin | Create a booking page with the booking editor's fields (slug, name, workingHours, timezone... | every field of the page to be published |
| `delete_booking_page` | `hard_delete` | admin | Delete a booking page permanently. | the page and that its link stops working; refused while bookings are upcoming |
| `update_booking_page` | write; `public_change` when the page is published, the edit publishes it, or bookings on it are upcoming | admin | Change a booking page's fields (as get_booking_page shows them; the slug can't change). | changed fields old -> new (the whole page when it goes public or has upcoming bookings) |
| `find_awaiting_payment_bookings` | read | member | List this workspace's booking-page appointments that are 'awaiting payment' (a deposit was required and hasn't been confirmed), soonest first, with each one's event id. |  |
| `mark_booking_paid` | `outbound` | member | Mark an 'awaiting payment' booking as paid, as the calendar's Mark paid button does: the booking is confirmed, the customer is emailed their confirmation, its reminders are scheduled and the booking.confirmed workflows start, so it is queued for a person to approve. | the booking and its deposit, who the confirmation email goes to or why none, the reminders, the booking.confirmed workflows that start (their steps pinned) |
| `list_members` | read | admin | List this sub-account's members (name, email, role, status) and any pending invites. |  |
| `invite_member` | `outbound` | admin | Add someone (by email) to this sub-account as 'admin' (manages members + settings) or 'collaborator' (works the data, no member management). | the email, the role (admin's powers named), what happens: a new invite, added at once with nothing to accept, a member's role old -> new, or that approving will refuse (a disabled or another agency's account); territories kept or cleared; whether an email goes out. The proposing agent is shown only the sub-account, email and role |
| `list_social_posts` | read | member | List the Social Planner's posts: id, status, platforms, when scheduled, and the start of each caption. |  |
| `create_social_post` | write | admin | Draft a Facebook / Instagram post (caption, optional https image URL, platforms). |  |
| `delete_social_post` | `hard_delete` | admin | Delete a Social Planner post. | the post, its id and creation time, whether a published one stays on the platform |
| `schedule_social_post` | `public_change` | admin | Publish a draft post to its platforms at a time (ISO 8601). | the exact post (caption, image), the Facebook Page / Instagram account, when it publishes |
| `reputation_overview` | read | member | The connected Google listing's average rating and review count, when it last synced, and how many synced reviews are unanswered. |  |
| `list_reviews` | read | member | The listing's synced Google reviews, newest first: stars, reviewer, date, text and whether it has a reply. |  |
| `send_review_request` | `outbound` | member | Text a contact the Google review request (SMS or WhatsApp, as set up in Reputation settings). | the exact text, recipient, channel and template, or why none would send |
| `list_broadcasts` | read | member | List the sub-account's email broadcasts, newest first: template, audience, status and totals. |  |
| `create_broadcast` | `outbound` | admin | Send an email template to every contact matching an audience (all; a tag; or a pipeline stage), skipping opted-out contacts. | channel, audience and matched count, exact subject and message, merge tags, what is checked at send |
| `start_voice_call` | `outbound` | member | Have the Voice channel's AI assistant phone a contact now, as the contact card's Call button does. | the number, assistant, the number it rings from, first words, greeting name, the script, consent, cost, what is checked at dial time |
| `watchdog_status` | read | admin | Show the Labs Inbox Follow-up Watchdog's settings (on/off, waiting threshold, quiet hours, extra criteria) and its recent runs: how many conversations it scanned, which contacts it flagged and why. |  |
| `slack_status` | read | admin | Show whether this workspace posts notifications to a Slack channel (Settings Sub-Account → Admin tab → Slack notifications): connected or not, the channel name the admin noted, which events are ticked, whether inbound-message posts carry the message text, when the last post went out, and any error (e.g. a revoked webhook URL that needs reconnecting). |  |

## Agency-key tools

Only an agency key calls these, besides every tool above (where it adds a required `subAccountId`). A tool
that acts in a sub-account names it in its own `subAccountId`, and the key's reach applies to it. Their
approval rows are agency-level (`subAccountId: null`): only the agency owner approves them, on
`/agency/approvals`. See [agent-api.md](agent-api.md#agency-keys).

| Tool | Kind | Role | What it does | What the approval preview shows |
|---|---|---|---|---|
| `list_sub_accounts` | read | agency owner | List this agency's sub-accounts with their ids and which feature gates are enabled. |  |
| `sub_account_stats` | read | agency owner | Count the records inside one of your sub-accounts — contacts, deals, tasks, calendar events, and quotes. |  |
| `create_sub_account` | write | agency owner | Create a new sub-account (an isolated client workspace) in this agency. |  |
| `set_sub_account_gate` | write; `gate_change` when the gate is not a direct one, or the sub-account is not one this key created in the last 72 h with no contacts and no channel connection | agency owner | Switch one feature gate on or off for a sub-account this key can reach (ids from list_sub_accounts). | the sub-account, the gate, its state now, on or off, and the side effect (e.g. Google off deletes the synced review cache) |
| `list_snapshots` | read | agency owner | List this agency's snapshots (saved sub-account setups), newest first, at most 50: each one's id, name, when it was made, whether it was imported from outside the agency, the sub-account it was captured from, and how many forms, message templates, products, workflows and custom fields it holds and whether it has an AI persona. |  |
| `apply_snapshot` | write; `public_change` when the snapshot was imported, or the sub-account is not one this key created in the last 72 h with no contacts and no channel connection | agency owner | Apply one of this agency's snapshots (ids from list_snapshots) to a sub-account this key can reach (ids from list_sub_accounts): copies its forms (with their status), message templates, products, workflows (always as drafts), custom fields and, when the sub-account has none, its AI persona. | the sub-account, the snapshot (captured in this agency, or imported), what it creates and what it skips as already there, workflows arriving as drafts, which forms accept submissions at once, the AI persona written (with its hours) or kept; the snapshot's payload hash is pinned |
| `list_billing_plans` | read | agency owner | List this agency's Client-Billing plans with their id, price, feature count, and status. |  |
| `create_billing_plan` | write | agency owner | Create a Client-Billing plan (a monthly price + an optional annual price + a bundle of features) that the agency can charge sub-accounts for. |  |
| `assign_billing_plan` | `spend` | agency owner | Assign a Client-Billing plan to one sub-account and start the checkout/subscription. | the sub-account, the plan and price (a special price only if proposed), every feature switching on and off, monthly quotas and overage rates, when features change (now, or when the client pays) and what billing does; price and gates are pinned |
| `create_one_time_charge` | `spend` | agency owner | Create a ONE-TIME charge for a sub-account's client (e.g. a web design fee) and get a payment link to send them (on the deployment's own payment provider). | the sub-account, the charge description and amount as the client sees them, and that it is one payment link, nothing charged until paid (pinned) |
| `billing_overview` | read | agency owner | List this agency's sub-accounts with their Client-billing state: comped (not billed), pending (plan assigned, checkout not completed), active, grace (renewal failed, inside the grace window), or lapsed (paywalled). |  |
| `resend_checkout_link` | `outbound` | agency owner | Mint a new secure checkout link for a sub-account whose plan is assigned but not paid (pending, or a lapsed renewal), for you to send the client; the agency owner approves it first. | the sub-account, its plan and price, its billing status, and that every earlier link stops working; the plan, price and status are pinned |
| `sub_account_usage` | read | agency owner | Show one sub-account's current-month usage — emails, SMS segments, WhatsApp messages, AI tokens, voice minutes — against its effective limits (workspace override → plan → unlimited), plus any accrued overage at the plan's rates. |  |
