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
| `custom_fields.velocity_dr_number` | Contact `c__drop_number` |

The upsert refuses unknown custom-field keys, so every key above must exist
as a contact custom field on the Velocity sub-account before the first real
run. A case whose contact has no phone or name is skipped and logged.

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

`QCONTACT_DEAL_OWNER_UID` is accepted but currently has **no effect**:
`POST /api/v1/deals` does not read `assigned_to_uid` — assignment is
read-only over the public API. Setting it only prints a startup warning.
It's kept so the wiring is ready once the API supports it.

When `QCONTACT_DEAL_PIPELINE_ID` is unset (the default), none of the above
runs — behaviour is unchanged from before deals existed.

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
Deals below). QContact tokens expire after ~12 h; the client re-signs-in on
a 401.

The code is erasable-syntax TypeScript (no parameter properties, enums or
namespaces) because Node strips types rather than compiling them. `tsc` and
vitest will not catch a violation — run the dry-run after touching a file.
