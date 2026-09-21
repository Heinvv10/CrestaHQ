# qcontact-import

Velocity Fibre only. Pulls new-installation requests out of Fibertime's
QContact (`fibertime.qcontact.com`) and upserts them as contacts into the
Velocity sub-account, where a workflow on the `qcontact-install` tag sends the
customer comms. Not a LeadStack product feature — nothing under `src/` knows
this exists.

This is **separate from FibreFlow's maintenance-ticket sync** against the same
QContact tenant. Different login, different view, different consumer.

## What it reads

The saved Case list view `my-bucket-growth-view` (category "New Installation",
assigned to the "Velocity New Installations" group). The phone lives on the
case's linked Contact (`telephone`, `e164:27…`); the case's own
`c__contact_number` is empty on most rows, so it is only the fallback.

## What it writes

`POST /api/v1/contacts/upsert` on LeadStack with a Velocity API key, per case:

| upsert field | from |
|---|---|
| `phone` | Contact `telephone` → `+27…` |
| `name` | Contact `first_name` + `last_name`, else case `c__contact_name` |
| `address` | Contact `addressline_1` |
| `source` | `qcontact` |
| `tags_add` | `["qcontact-install"]` — this is the workflow trigger |
| `custom_fields.qcontact_case_id` | case id |
| `custom_fields.qcontact_case_ref` | case `reference` (`FT…`) |
| `custom_fields.qcontact_location_pin` | case `c__location_pin` |
| `custom_fields.qcontact_location_gps` | resolved from `c__location_pin`, see below |
| `custom_fields.velocity_dr_number` | Contact `c__drop_number` |

The upsert refuses unknown custom-field keys, so every key above must exist
as a contact custom field on the Velocity sub-account before the first real
run. A case whose contact has no phone or name is skipped and logged.

### Location pin → coordinates

`c__location_pin` on a case is **not** coordinates — it is the id of a
separate `c__contactlocation` entity, resolved via
`GET /api/v2/entities/c__contactlocation/{pin}` (`QContactClient#getLocation`
in `qcontact.ts`). That record's `c__latitude`/`c__longitude` are the
customer's real coordinates; `qcontact_location_pin` keeps storing the raw id
as-is (other tooling may already rely on it), while `qcontact_location_gps`
gets the parsed `"<lat>,<lng>"` — a **dedicated** field, not
`velocity_install_gps`. That field is populated later, from a field worker's
install-completion flow, and can legitimately differ from the pin's
coordinates (an install can happen at a different spot than the case's
initial pin, e.g. a different sub-unit on the same property); overwriting it
with a pre-install pin value would conflate two distinct,
independently-sourced facts. `qcontact_location_gps` must be created as a
contact custom field on the Velocity sub-account the same way the others are
(see above) before it will start being written.

Coordinates are only written when both `c__latitude` and `c__longitude`
parse as finite numbers inside South Africa's bounding box (lat -35..-22,
lng 16..33) — see `gpsFromLocationFields` in `map.ts`. Anything else (out of
bounds, non-numeric, missing) is dropped silently from the upsert and
counted under `summary.locationsSkippedInvalid`.

Each pin is resolved **at most once per run**, cached by pin id, even when
multiple fresh cases share it. A failed lookup (404, 500, etc.) does not
fail the case import — the case still imports without coordinates, and it's
counted under `summary.locationsLookupFailed` with a log line naming the
case ref (never a phone number). Successful resolutions are counted under
`summary.locationsResolved`.

## Deals

When `QCONTACT_DEAL_PIPELINE_ID` is set, a successful upsert is followed by
`GET /api/v1/deals?contact_id=` — if the contact already has a deal in that
pipeline, nothing more happens; otherwise `POST /api/v1/deals` opens one at
`QCONTACT_DEAL_STAGE` (default `new_request`), titled `Install request —
<contact name> (<case ref or case id>)`, with `value: 0` and `currency:
"ZAR"` (the deals API requires both; this service is Velocity Fibre only).
The `Idempotency-Key` is `qcontact-deal-<caseId>`.

A case is marked seen only once **both** the upsert and the deal step
succeed — a deal failure alone leaves the case unseen (counted in
`summary.failed`) so the next run retries just the deal step; the upsert
already succeeded and won't be repeated pointlessly since it's idempotent
anyway.

`QCONTACT_DEAL_OWNER_UID`, when set, is sent as `assigned_to_uid` on the
deal create — it must be the uid of an *active* sub-account member, or the
create 400s. This requires the `POST /api/v1/deals` support landing on
`feat/workflow-task-assignee-deal-stage`; keep this env var unset until that
ships.

When `QCONTACT_DEAL_PIPELINE_ID` is unset (the default), none of the above
runs — behaviour is unchanged from before deals existed.

## Deal stage sync

When `QCONTACT_DEAL_PIPELINE_ID` **and** `QCONTACT_SYNC_STAGES` (any value
other than unset/`"0"`) are both set, every run also moves each case's deal
to the pipeline stage matching its current QContact status — for every case
in the view, not just newly-seen ones, since a case keeps moving through
statuses long after its deal was created.

This does **not** re-derive the contact or deal from the case. The state
file's `deals` map (case id → deal id, recorded when `ensureDeal` creates or
finds the deal — see Deals above) is the only source of a case's deal id; a
case with no entry is left alone and counted (`stageUnmapped`), never looked
up another way. Re-deriving it via the contact-upsert flow used for creation
was the first design and was rejected: it would re-fire the enrolment-gated
`POST /api/v1/contacts/upsert` for ~670 already-seen cases every 15 minutes
(well past the 50/hour enrolment fuse on the API key) and re-write QContact's
copy of the contact's name/address over any manual edit made in the CRM.

For a mapped case, the only call is `PATCH /api/v1/deals/:id` with the
mapped stage — no lookup first. "Only when the stage actually differs" is
decided locally against `dealStages` (case id → the stage last set, also in
the state file), not by fetching the deal, so this never does a `GET`. A
404 on the PATCH means the deal is gone: both map entries are dropped and it
counts under `skipped.deal_not_found`, without failing the run.

Status → stage mapping (see `stage-sync.ts`): New→`new`, Assigned→`assigned`,
Upcoming→`upcoming`, Pending Customer→`pending_customer`,
In Progress→`in_progress`, Escalated→`escalated`,
PON Not Live→`pon_not_live`, Solved→`solved`,
Solved - No Response→`solved_no_response`,
Unsolved - No Response→`unsolved_no_response`,
Closed - No response→`closed_no_response` (QContact renders this last one
with an en dash on some rows and a hyphen on others — both are accepted).
An unrecognised status is left alone, never guessed, and counted under
`skipped.unknown_status`.

A failed PATCH counts in `summary.failed` (case id + HTTP status, no phone
numbers in logs) and never stops the run or changes any case's seen state —
stage syncing never marks a case seen or unseen, that's still decided purely
by the upsert + deal-create step above.

`QCONTACT_SYNC_STAGES` unset or `"0"` (the default) makes this file dead
code: zero extra reads or writes, byte-identical behaviour to before it
existed. Deals created before this feature existed have no `deals` map
entry and won't be stage-synced until backfilled separately.

## Forward-only, by design

State is a JSON file of every case id already handled
(`QCONTACT_IMPORT_STATE`). **When the file does not exist, the run seeds it
with every case in the view and sends nothing.** The backlog (670 cases on
2026-09-11, many "In Progress" since January) is a separate, approved campaign,
never a side effect of the first run. A case is marked seen only after
LeadStack accepted it, so a failed upsert is retried next run; the
`Idempotency-Key` is the case id, so a retry can never create a duplicate.

## Running

```
node --env-file=.env.local --experimental-strip-types services/qcontact-import/run.ts [--dry-run]
```

`--dry-run` reads QContact and prints what it would send without calling
LeadStack or touching the state file. Exit code 1 when any upsert failed.

Env: `QCONTACT_IMPORT_EMAIL`, `QCONTACT_IMPORT_PASSWORD` (the dedicated
`activations@velocityfibre.co.za` user), `LEADSTACK_API_URL`,
`LEADSTACK_API_KEY`; optional `QCONTACT_BASE_URL`, `QCONTACT_IMPORT_VIEW`,
`QCONTACT_IMPORT_STATE`, `QCONTACT_DEAL_PIPELINE_ID`, `QCONTACT_DEAL_STAGE`
(default `new_request`), `QCONTACT_DEAL_OWNER_UID` (currently a no-op — see
Deals below), `QCONTACT_SYNC_STAGES` (default off — see Deal stage sync
above). QContact tokens expire after ~12 h; the client re-signs-in on a
401.

The code is erasable-syntax TypeScript (no parameter properties, enums or
namespaces) because Node strips types rather than compiling them. `tsc` and
vitest will not catch a violation — run the dry-run after touching a file.
