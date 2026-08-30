"use client";

import Link from "next/link";
import { CUSTOM_BRAND } from "@/config/landing";
import { openCrispChat } from "@/lib/crisp";

/**
 * Public security page — the "receipts" for how the platform protects data.
 * Deliberately vendor-generic ("best-in-class managed services") so it
 * white-labels cleanly, and deliberately honest: it includes a "what's on
 * you" section, because credibility requires conceding the operator's own
 * responsibilities. Every claim on this page is verifiable in the codebase.
 */
export default function SecurityPage() {
  const brand = CUSTOM_BRAND.name;
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <Link
        href="/"
        className="text-sm text-muted-foreground hover:text-primary"
      >
        &larr; Back to home
      </Link>

      <article className="prose dark:prose-invert mt-8 max-w-none">
        <h1>Security</h1>
        <p className="text-sm text-muted-foreground">
          Last updated: July 01, 2026
        </p>

        <div className="not-prose my-6 rounded-xl border bg-muted/30 p-5">
          <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            TL;DR
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
            <li>
              Runs entirely on best-in-class managed cloud infrastructure —
              there is no server to patch and no exposed database to breach.
            </li>
            <li>
              Card data never touches the platform — payments are handled
              end-to-end by a PCI DSS Level 1 provider.
            </li>
            <li>
              Setup mistakes <strong>fail closed</strong>: the database denies
              everything by default, so an incomplete setup breaks features —
              it doesn&apos;t leak data.
            </li>
            <li>
              Every client workspace is isolated at three independent layers,
              and every AI action requires human confirmation before it can
              change anything.
            </li>
            <li>
              Single-tenant by design: your deployment holds only{" "}
              <em>your</em> business&apos;s data — never pooled with other
              companies.
            </li>
            <li>
              No black box: the owner holds the complete source code, so every
              claim on this page can be independently audited.
            </li>
          </ul>
        </div>

        <h2>How {brand} works — context first</h2>
        <p>
          {brand} isn&apos;t a shared platform you sign up to. When you
          purchase {brand}, you — the owner — spin up your{" "}
          <strong>own private CRM</strong>, under your own brand
          (&ldquo;YourCRM&rdquo;), running on accounts <em>you</em> control
          with best-in-class providers for data, payments, and hosting. One
          deployment, one owner. Your client workspaces live inside your
          deployment and nowhere else. Everything below describes how that
          deployment protects the data inside it.
        </p>

        <p>
          Security claims are easy to make and hard to check. This page
          explains, in specific terms, how {brand} protects the data inside
          it — the architecture, the defaults, and, honestly, the parts that
          are your responsibility as an operator.
        </p>

        <h2>1. Built on best-in-class managed services</h2>
        <p>
          {brand} does not run on hand-managed servers. Data storage,
          payments, and hosting are each delegated to best-in-class managed
          cloud platforms — the same infrastructure providers trusted by
          banks, healthcare companies, and Fortune 500 enterprises.
        </p>
        <p>That means there is:</p>
        <ul>
          <li>
            <strong>No server to patch.</strong> The hosting platform manages
            the operating system, network, and runtime — security updates are
            its job, applied continuously.
          </li>
          <li>
            <strong>No exposed database.</strong> The data layer has no open
            port, no connection string to leak, and no direct network access.
            It is reachable only through authenticated, permission-checked
            paths.
          </li>
          <li>
            <strong>No card data in the platform, ever.</strong> Payments are
            processed end-to-end by a certified payment provider (PCI DSS
            Level 1). Card numbers never touch {brand}&apos;s code or
            database.
          </li>
        </ul>
        <p>
          The most common causes of real-world data leaks — unpatched
          servers, exposed database ports, default credentials — are not
          risks this architecture merely mitigates. They are categories of
          mistake that <em>cannot happen</em>, because the components they
          apply to don&apos;t exist here.
        </p>

        <h2>2. Fail-closed by default</h2>
        <p>
          A fair question about any self-managed software: &ldquo;what if the
          operator sets it up wrong?&rdquo; The answer here is that the
          platform is designed to <strong>fail closed</strong>:
        </p>
        <ul>
          <li>
            The database denies <em>all</em> access by default. Access rules
            must be explicitly deployed before anything can be read — a
            skipped setup step produces a broken feature, not exposed data.
          </li>
          <li>
            Sign-up is locked. The first administrator account is restricted
            to a pre-configured email address, and every subsequent user must
            be explicitly invited. There is no open registration.
          </li>
          <li>
            Optional features ship <strong>off</strong> and must be
            deliberately enabled per workspace by the account owner.
          </li>
        </ul>
        <p>
          In other words: the failure mode of an incomplete or incorrect
          setup is an app that doesn&apos;t work yet — not an app that leaks.
        </p>

        <h2>3. Workspace isolation, enforced three times</h2>
        <p>
          {brand} is multi-workspace: each client workspace holds its own
          contacts, deals, conversations, and records. Isolation between
          workspaces is enforced at three independent layers, so a failure
          in any one layer is caught by the others:
        </p>
        <ol>
          <li>
            <strong>Database-level security rules</strong> — every read and
            write is checked against the caller&apos;s verified workspace
            membership, at the data layer itself, before any data moves.
          </li>
          <li>
            <strong>Server-side permission checks</strong> — every API
            endpoint independently re-verifies the caller&apos;s identity,
            role, and workspace membership from their authenticated session.
            Nothing is trusted from the browser.
          </li>
          <li>
            <strong>Record-level re-anchoring</strong> — whenever one record
            references another (a deal&apos;s contact, a task&apos;s owner),
            the platform re-verifies the referenced record belongs to the
            same workspace before acting. A crafted or mistaken ID cannot
            reach another workspace&apos;s data.
          </li>
        </ol>

        <h2>4. Roles and access control</h2>
        <ul>
          <li>
            Authentication uses secure, signed session cookies managed by an
            enterprise-grade identity service — not home-rolled password
            handling.
          </li>
          <li>
            Access is role-based: account owners, workspace administrators,
            and collaborators each see and do only what their role allows.
          </li>
          <li>
            Feature availability is controlled per workspace by the account
            owner — a workspace cannot switch on capabilities it hasn&apos;t
            been granted.
          </li>
          <li>
            Removing a member takes effect immediately: their access is
            revoked, their sessions are invalidated, and their sign-in is
            disabled if they hold no other access.
          </li>
        </ul>

        <h2>5. Secrets and credentials</h2>
        <ul>
          <li>
            <strong>The codebase ships with zero embedded credentials.</strong>{" "}
            Every service key is supplied by the operator and stored in the
            hosting platform&apos;s encrypted configuration — never in source
            code.
          </li>
          <li>
            API keys are stored as <strong>one-way cryptographic hashes</strong>{" "}
            only. The full key is shown exactly once at creation. Even a
            complete copy of the database cannot recover a working key.
          </li>
          <li>
            Keys are revocable and scoped: each API key belongs to one
            workspace and can only ever see that workspace&apos;s data.
          </li>
          <li>
            Secrets are masked in logs, so an accidental debug line
            can&apos;t leak a credential.
          </li>
        </ul>

        <h2>6. Public links that can&apos;t be forged</h2>
        <p>
          Some pages are deliberately public — a quote sent to a customer, a
          booking page, an unsubscribe link, a payment link. Every one of
          them is protected by a <strong>cryptographically signed token</strong>:
        </p>
        <ul>
          <li>Tokens are signed (HMAC) and cannot be guessed or forged.</li>
          <li>
            Only a one-way hash of each token is stored — the working link
            exists solely in the recipient&apos;s email.
          </li>
          <li>
            Re-sending rotates the token, which instantly invalidates every
            older copy of the link.
          </li>
        </ul>

        <h2>7. Verified integrations</h2>
        <p>
          Every inbound webhook — payment events, inbound messages, call
          events, scheduled jobs — is <strong>signature-verified</strong>{" "}
          before a single byte is processed. A request that doesn&apos;t
          carry a valid cryptographic signature from the expected service is
          rejected. There is no unauthenticated write path into the platform.
          Outbound webhooks are signed too, so your own integrations can
          verify that events genuinely came from your deployment.
        </p>

        <h2>8. AI, with a human in the loop</h2>
        <p>
          {brand} includes AI assistants and AI conversation agents. They are
          governed by strict, structural limits:
        </p>
        <ul>
          <li>
            The assistant can only invoke a fixed, audited list of
            capabilities — it has no general access to the database and no
            way to compose its own queries.
          </li>
          <li>
            <strong>
              No AI action can modify data without a human explicitly
              confirming it first.
            </strong>{" "}
            Reads run instantly; every write requires a click.
          </li>
          <li>
            Every AI capability is anchored to the caller&apos;s own
            workspace, and an automated check runs on every code change to
            enforce that rule — it is a build failure, not a code-review
            hope.
          </li>
          <li>
            Every AI action — proposed, executed, or failed — is written to
            an append-only audit trail.
          </li>
        </ul>

        <h2>9. One deployment, one owner — a smaller blast radius</h2>
        <p>
          Unlike a traditional SaaS platform, where thousands of
          companies&apos; data sits in one shared system and a single breach
          exposes everyone, each {brand} deployment is{" "}
          <strong>single-tenant</strong>: it holds one business&apos;s data,
          in accounts that business controls. Your data is not pooled with
          anyone else&apos;s, is not mined or resold, and can be exported or
          deleted by you at any time.
        </p>

        <h2>10. No black box</h2>
        <p>
          Perhaps the most important difference: {brand} is not a black box
          you have to take on faith. The operator of a deployment owns the
          complete source code. Every claim on this page is verifiable by
          reading it — or by having any security professional of your
          choosing read it. Closed platforms ask for trust; this one can be
          audited.
        </p>

        <h2>11. What&apos;s on you (honesty matters)</h2>
        <p>
          No architecture removes every responsibility. If you operate a
          deployment, the platform&apos;s security assumes you will:
        </p>
        <ul>
          <li>
            Protect the accounts behind your deployment — use strong, unique
            passwords and enable two-factor authentication on your hosting,
            data, and payment provider accounts.
          </li>
          <li>
            Treat your service keys and environment configuration as secrets
            — never commit them to a public repository or share them in
            chat/screenshots.
          </li>
          <li>
            Apply updates when they&apos;re published, and complete the
            documented setup steps (the built-in setup checker verifies the
            important ones for you).
          </li>
        </ul>
        <p>
          These are the same obligations you&apos;d have with any business
          software — including SaaS, where your team&apos;s passwords are
          just as much the weakest link.
        </p>

        <h2>12. Reporting a security concern</h2>
        <p>
          If you believe you&apos;ve found a vulnerability, we want to hear
          about it — please report it privately rather than publicly, so it
          can be fixed before details circulate.{" "}
          <button
            type="button"
            onClick={openCrispChat}
            className="cursor-pointer border-none bg-transparent p-0 font-medium text-primary underline underline-offset-2"
          >
            Chat with us
          </button>{" "}
          and we&apos;ll take it from there. Good-faith reports are always
          welcome and never punished.
        </p>
      </article>
    </div>
  );
}
