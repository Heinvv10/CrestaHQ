# SP13 — production walk on #1000 (2026-09-21)

Captured on crm.crestahq.com, running `13dab87` (deployed 2026-09-20; it contains the SP13 merges `152f44f` and `490e4f0`). Signed in as the agency owner, 1568×757 viewport.

The walk was read-only: nothing was uploaded, captured, shared, pushed or saved. The Manage dialog was opened and then closed with ×. Screens with no data therefore show their empty states. For the populated versions of the same screens, see the local-fixture captures one level up (`../`).

| File | Screen | What it shows |
| --- | --- | --- |
| `launchpad.png` | `/sa/54vPI0BS1zDMcxMyMAyA/launchpad` | Real connection state: 6 of 7 complete (86%); WhatsApp is the only open item, with a Set up button |
| `media.png` | `/sa/54vPI0BS1zDMcxMyMAyA/media` | Media library: 25 MB limit, type filters, New folder, Upload; empty on #1000 |
| `templates.png` | `/agency/templates` | Template library with Workflows/Emails/Forms tabs, tag filter and search; empty ("Save to library" hint) |
| `sub-accounts.png` | `/agency/sub-accounts` | Sub-account list plus the Snapshots panel: Capture, Import from file, My snapshots / Imported / Shared tabs |
| `snapshots.png` | same page, scrolled | Snapshots panel, My snapshots (0) |
| `snapshots-shared.png` | same page, Shared tab | "No share links yet" |
| `manage-dialog.png` | Manage → #1000 | Agency-level billing (Comped), usage for the month and past months, per-feature gate checkboxes |
| `reselling.png` | `/agency/billing` | Plans, the clients table (all Comped), and the Reselling overview, which reads "Plans need a payment provider configured" |

## Redactions

Sub-accounts #1001–#1005 are real client workspaces. Their names are covered with a grey box in `sub-accounts.png`, `snapshots.png`, `snapshots-shared.png` and `reselling.png`. #1000 is CrestaHQ's own account.

## Not captured

- **Public snapshot share page (`/s/snapshot/<token>`).** Production has no snapshots and no share links. Capturing a snapshot and minting a share link would be a production write, so it was not done. The local-fixture capture `../n4-public-share-page.png` covers this screen.
- **Media file menu and template push dialog.** Both need data that #1000 does not have. See `../m4-media-file-menu.png` and `../t2-template-push-dialog.png`.

## Observed on production

- Client billing shows "Stripe isn't configured on this deployment" and the Reselling overview shows no plans. This deployment has no payment provider configured for plans. This is the known state, not an SP13 defect.
