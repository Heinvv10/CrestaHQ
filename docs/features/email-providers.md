# Email setup per sub-account

Open **Settings → Messaging → Email provider** as a workspace admin or agency owner.
Every existing and new sub-account has the setup card; credentials are configured
separately for each business.

1. Enter the provider's SMTP host, username, password/app password, authorized From
   email and optional From name.
2. Select **465 — TLS**, **587 — STARTTLS required**, or **2525 — STARTTLS required**.
3. Click **Verify & save**. This checks TLS and login before selecting SMTP.
4. Click **Send test email** to send a fixed test to your signed-in admin email.
   Check your inbox: provider acceptance is not proof of inbox delivery.

SMTP credentials are private server-only records. Passwords are never returned
to the browser. Leave the password blank on subsequent saves only if host, port,
security and username are unchanged. Changing those fields requires a password.

Workspace emails (contacts, workflows including internal notifications, broadcasts,
quotes, booking messages, AI escalation and community sign-in) use that workspace's
SMTP provider. Existing opt-out checks and usage quotas remain in place.
Each SMTP provider sets its own sending limits; setup does not increase them.

The workspace Reply-To setting applies. Without an override, SMTP replies go to
the configured From mailbox. Connect that mailbox below to receive replies in
Conversations. A Reply-To pointing to another mailbox needs that mailbox connected
instead; SMTP alone does not import incoming mail.

## Email in Conversations

Every sub-account has mailbox connection controls in Messaging settings. Connect
an IMAP mailbox using its server hostname, port **993 (TLS)**, username and password.
For providers such as xneelo where SMTP and IMAP use the same host and login,
explicitly reuse the **same sub-account's** saved SMTP credentials. Verification
discovers the Inbox and Sent folder before saving the connection.

Connected mailboxes import the last 30 days initially, in bounded batches, then
check for newer messages automatically every five minutes through QStash. An admin
can also run a manual sync. Check the displayed last-sync time and errors; a saved
connection alone does not prove the scheduler is running.

Incoming messages and messages saved by other mail apps in the Sent folder appear
under the correspondent in Conversations. Leadstack SMTP sends are recorded
directly, including their subject and body. The message ID prevents a Sent-folder
copy from appearing twice. Select an email to reply with the original thread
headers, or compose a new email with a subject.

**How threads are grouped.** A conversation belongs to a contact, and an email
joins the contact whose email address matches the correspondent (the sender of
incoming mail, each recipient of sent mail). Reply headers (`In-Reply-To`,
`References`) are kept on every message and sent on every reply, so mail apps
thread them, but they do not move mail between contacts: a reply from a different
address — an alias, a colleague, a forward — appears under that address's own
contact. Headers only choose between contacts that share one address, so a reply
lands with the contact whose message it answers. Replying to "Quote" sends
"Re: Quote"; an existing "Re:" is not repeated.

Authentication emails such as community sign-in links are excluded from automatic
CRM archiving so their login tokens are not exposed to other workspace members.

Message bodies are shown as plain text. Attachments show their names and sizes;
open the original mailbox to download them. Sync reads mail without changing flags
or deleting it. Imported history does not trigger automated replies. Disconnecting
sync preserves messages already imported into the CRM.

Each sub-account requires its own verified credentials; enabling this feature
does not automatically connect unconfigured accounts. A mail app that never saves
a Sent copy has no historical Sent messages for IMAP to retrieve.

### Deployment

Deploy the new conversation territory index and wait for it to be ready, then
deploy the application. Run `node --env-file=.env.local --experimental-strip-types
scripts/backfill-conversation-territories.ts` to preview existing conversation
territory metadata and repeat with `--apply` to update it. Deploy
`firestore:rules,firestore:indexes` before connecting any mailbox. This preserves
territory-based access for email previews as well as full messages. The backfill
does not change message bodies or contacts and is safe to rerun.

**Disconnect SMTP** removes its credentials and returns to Resend. If shared
Resend is not configured, email becomes unavailable until a provider is connected.
Existing verified Resend domains are preserved while SMTP is selected.
Platform billing, invitations and platform alerts still require shared Resend.

Do not paste credentials into support chats or copy another business's connection.
Use the provider's actual credentials in that workspace's settings.
