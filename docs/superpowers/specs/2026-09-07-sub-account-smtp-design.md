# Per-sub-account SMTP email setup

User authorized per-sub-account email setup after discussing GHL custom SMTP.
Each workspace admin can connect its own provider under Settings > Messaging.
Existing Resend is the default for workspaces without SMTP.

## Contract
Public SubAccountDoc adds emailProvider?: "resend" | "smtp", smtpConfig?: SmtpMeta | null.
SmtpMeta: host, port, secure, username, fromEmail, fromName, verifiedAt (ISO string).
Credentials (same fields plus password) live at subAccounts/{id}/private/smtpConnection,
covered by existing deny-all client rules. Never return the password in APIs or logs.
No new agency feature gate: tenant-funded SMTP is available to workspace admins.
The existing agency gate continues to govern Resend dedicated-domain registration.

Settings API /api/sub-accounts/[id]/smtp:
GET returns {config:SmtpMeta|null, provider, resendReady:boolean}.
POST accepts {host,port,secure,username,password,fromEmail,fromName}.
Blank password preserves the existing one only for identical host/port/security/username.
Validate and verify TLS/auth before atomically saving secret + metadata + provider.
DELETE atomically removes credentials and selects Resend again.
POST /smtp/test sends a fixed test email to the authenticated admin's own email,
using saved SMTP settings. UI explicit Send test email action authorizes that send.
No automated test messages to live customers.

SMTP supports implicit TLS on 465 and required STARTTLS on 587/2525.
Validate fields, lengths and addresses. Resolve DNS, reject non-public addresses,
pin the validated address for the connection, and retain TLS hostname verification.
Disable URL/file attachment access and provider debug logging. Bound timeouts.
Errors return actionable categories without echoing provider responses or credentials.

Email sending selects SMTP explicitly for the owning workspace and never falls
back after an SMTP failure. All workspace email call sites pass subAccount and
meter.subAccountId; platform mail continues using shared Resend.
emailIsConfigured(sub?) reflects the chosen provider. Builder and API checks use
workspace configuration. SMTP's from address wins over Resend tenantFrom headers.
Keep opt-outs, quotas, usage and activity recording unchanged.

## Acceptance
Tenant isolation, admin-only setup, no secret exposure, TLS/SSRF checks, verify
before save, password update rules, no fallback, metering and SMTP without Resend
covered by tests. Existing Resend suite and full ci:check remain green.
Blind review required before merge. Live setup UI verified without storing fake
credentials or activating campaigns. Real SMTP delivery awaits customer credentials.
