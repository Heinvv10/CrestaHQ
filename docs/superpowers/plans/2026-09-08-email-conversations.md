# Email conversations for every sub-account

Goal: Incoming mailbox mail, external Sent-folder mail, and Leadstack SMTP sends appear in each sub-account's Conversations, with an email reply composer.

Architecture: Reuse each tenant's SMTP provider for sending. Add separately verified IMAPS mailbox settings (with explicit reuse of that tenant's saved SMTP credentials), read-only INBOX/Sent polling, and an atomic tenant-scoped email message/conversation store. Register a five-minute QStash sweep. No DNS changes or provider migration. No Resend setup. User has explicitly approved implementing this behavior for all sub-accounts.

Tech stack: Existing Next.js/Firebase/Nodemailer; ImapFlow and mailparser for bounded MIME imports. Follow CLAUDE.md checks, tenancy rules, isolated worktree, TDD and blind review.

## Global constraints and interfaces

- Secrets stay under subAccounts/{id}/private, never returned/logged. Validate public DNS and pin connections with TLS certificate checks. IMAPS port 993 only. Never alter mailbox flags or delete mail.
- Feature applies to all accounts; only enable live sync on mailboxes with verified credentials. Never copy one account's password to another. Initial import is 30 days, bounded per run; show progress/failures truthfully.
- Message store: contacts/{contactId}/emailMessages/{stableHash}. Export EmailMessageDoc from src/types/email.ts with id, agencyId, subAccountId, contactId, direction, subject, body (plain text), from, to (string[]), messageId (RFC id or stable fallback), inReplyTo (nullable string), references (string[]), status (sent/received), createdAt, sentByUid (nullable), attachments (filename/contentType/size metadata only). Render plain text; metadata-only attachments are labelled and originals remain in mailbox.
- Server module src/lib/server/email-conversations.ts exports recordEmailMessage(input): Promise<{contactId:string; inserted:boolean}>. Input: subAccountId, optional contactId, direction inbound/outbound, subject, body, from, to:string[], messageId, optional inReplyTo, references, sentByUid, attachments, occurredAt:Date, historical:boolean. Resolve correspondent within tenant, create unknown contact safely with no workflow enrollment; reject mismatched explicit contacts. Atomic dedupe/message/index updates; preserve newer previews, don't mark historical imports unread, don't trigger automated replies. Stable RFC id dedupes local sends vs Sent imports. Support multiple outbound recipients without leaking cross-tenant data.
- Mailbox API: GET/POST/DELETE /api/sub-accounts/{id}/mailbox (admin only). GET returns {config: MailboxMeta|null}; POST accepts {host,port:993,username,password,useSmtpCredentials:boolean,sentFolder?:string}; reuse only saved credentials belonging to this sub-account (and require matching host/username). Meta: host, port, username, sentFolder:string|null, verifiedAt, lastSyncAt:string|null, lastError:string|null, enabled:boolean. POST verifies, saves private config, returns {config}. POST /mailbox/sync returns summary imported/skipped/hasMore; admin only. Config changes invalidate old cursors/workers; per-account lock prevents concurrent sync, cursor only advances after durable ingestion.
- UI adds email channel badges/filter/thread subscription and subject/reply fields. POST /api/comms/email/send extends {contactId,subject,body,inReplyTo?,references?}; sendEmail central SMTP capture covers manual/broadcast/workflow/transactional metered sends. Surface sent-but-save-failed distinctly; never tell user to retry SMTP delivery after acceptance.

## Task 1: Message persistence and SMTP capture

Own types/email.ts, types/conversations.ts, lib/server/email-conversations.ts and tests, lib/comms/resend.ts and smtp.ts/tests, api/comms/email/send and tests, firestore.rules and email rule tests if available. Implement above store and central capture, thread headers. Test tenant isolation, dedupe, historical ordering/unread, unknown contacts, accepted-send persistence failure.

## Task 2: Mailbox polling and settings APIs

Own new lib/comms/imap.ts, lib/server/mailbox-sync.ts and tests, api/sub-accounts/[id]/mailbox routes/tests, api/cron/email-sync, qstash register-schedules, middleware allowlist, package.json/lock. Implement interfaces above with independently mocked recordEmailMessage contract. Verify ImapFlow primary docs before use. Bound search/fetch size/time, UIDVALIDITY/UID cursor, per-account lease and config version; exclude own addresses, preserve failed items for retry. Tests for auth, SSRF, MIME, folder detection, duplicate/retry/cursor and multi-account sweep.

## Task 3: Conversations and mailbox UI

Own components/conversations, dashboard conversations pages, new components/settings/sub-account-mailbox-section.tsx and settings page insertion. Implement agreed interfaces without changing backend-owned types. Email available when SMTP configured, subject and reply headers, plain-text body with sent/received status and attachment metadata, realtime subscription, email filter. Mailbox settings available all subs, clear verification/sync progress and connect controls including explicit tenant SMTP reuse. Match current components/styles; no unrelated visual redesign. Tests for relevant behavior.

## Task 4: Integration and acceptance

Run lint/typecheck/tests/build/gitleaks and fresh blind review team. Resolve findings, PR and merge/deploy under existing authorization. Deploy Firestore rules/indexes when changed. Verify Cresta IMAP using saved connection, enable/sync under authorized setup; verify production UI incoming/sent. Other accounts require own mailbox credentials, report accurately if unconnected. Preserve unrelated work.
