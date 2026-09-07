# Per-sub-account SMTP Implementation Plan

> Use superpowers:subagent-driven-development for independent implementation tasks and blind review.

**Goal:** Let each workspace connect its own SMTP provider and route its email consistently.
**Architecture:** Private SMTP connection plus public display metadata, shared sendEmail provider selection, existing Resend default.
**Tech Stack:** Next.js, Firestore Admin SDK, Nodemailer, Vitest.
**Spec:** ../specs/2026-09-07-sub-account-smtp-design.md

## Tasks
- [x] SMTP transport/settings API: src/types/email.ts, src/lib/comms/smtp.ts,
  /api/sub-accounts/[id]/smtp/route.ts and smtp/test/route.ts, corresponding tests.
  Test public-host validation, TLS/auth, redaction, authorization, no save on failed
  verification, password preservation, atomic disconnect and admin-recipient test.
- [x] Settings UI: sub-account-smtp-section.tsx, dashboard settings insertion,
  SMTP component tests. Match existing cards and inputs. Clear password after save,
  fetch authoritative metadata, distinguish server acceptance from delivery.
- [x] Provider routing: resend.ts plus every workspace email gate/send caller,
  tenancy types and workflow readiness. Test SMTP without Resend, shared default,
  no SMTP-to-Resend fallback, sender override and metering.
- [ ] Integration: run ci:check, gitleaks, blind reviews for transport/security
  and whole-branch behavior. Fix findings, create PR, verify CI and live UI after
  authorized merge/deploy. Preserve shared checkout and handoffs.

## Decisions
Use existing private collection (no new index or access rule required).
Maintain existing platform-level Resend mail behavior. Credential provisioning is
an operator action through the UI; no copying credentials out of GHL.
