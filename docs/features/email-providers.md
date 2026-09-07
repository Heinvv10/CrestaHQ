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
the configured From mailbox. SMTP provides outbound delivery only: replies are
read in that mailbox, not synchronized into CrestaHQ Conversations.

**Disconnect SMTP** removes its credentials and returns to Resend. If shared
Resend is not configured, email becomes unavailable until a provider is connected.
Existing verified Resend domains are preserved while SMTP is selected.
Platform billing, invitations and platform alerts still require shared Resend.

Do not paste credentials into support chats or copy another business's connection.
Use the provider's actual credentials in that workspace's settings.
