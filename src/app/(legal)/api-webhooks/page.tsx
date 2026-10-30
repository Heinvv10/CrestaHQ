"use client";

import Link from "next/link";
import { openCrispChat } from "@/lib/crisp";

export default function ApiWebhooksPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <Link
        href="/"
        className="text-sm text-muted-foreground hover:text-primary"
      >
        &larr; Back to home
      </Link>

      <article className="prose dark:prose-invert mt-8 max-w-none">
        <h1>API &amp; Webhooks</h1>
        <p className="text-sm text-muted-foreground">
          A high-level overview of how you connect LeadStack to the rest of
          your stack.
        </p>

        <p>
          LeadStack ships a REST API and signed webhooks so your workspace can
          talk to the tools you already use &mdash; sync contacts and deals,
          drive your own automations, and react to what happens in real time.
        </p>

        <h2>1. REST API</h2>
        <p>
          Versioned REST endpoints under <code>/api/v1/</code> give you
          read/write access to your core records:{" "}
          <strong>contacts, deals, tasks, calendar events, and form
          submissions</strong>.
        </p>
        <p>
          Requests authenticate with a workspace API key sent as a{" "}
          <code>Bearer</code> token. Each workspace mints its own keys in
          separate <strong>live</strong> and <strong>test</strong> modes, so
          you can build and verify against test data before switching anything
          on in production.
        </p>
        <p>
          It&rsquo;s built for real integrations, not just demos: idempotency
          keys make writes safe to retry, a versioned response envelope keeps
          your integration from breaking when we ship improvements, and every
          key has its own rate limit.
        </p>

        <h2>2. Webhooks</h2>
        <p>
          Subscribe an endpoint to the events you care about and LeadStack{" "}
          <strong>POSTs to it the moment they happen</strong> &mdash; no
          polling, no cron jobs on your side.
        </p>
        <p>
          Every payload is signed with <strong>HMAC-SHA256</strong> and carries{" "}
          <code>Webhook-Signature</code> and <code>Webhook-Timestamp</code>{" "}
          headers, so you can verify each request genuinely came from LeadStack
          and reject anything stale or replayed. Failed deliveries are retried
          automatically.
        </p>
        <p>Events you can subscribe to include:</p>
        <ul>
          <li>
            <code>contact.created</code> &mdash; a new contact enters the
            workspace
          </li>
          <li>
            <code>form.submission.created</code> &mdash; a hosted form is
            submitted
          </li>
          <li>Deal stage changes &mdash; a deal moves along your pipeline</li>
          <li>
            <code>event.booked</code> &mdash; someone books through a booking
            page
          </li>
          <li>
            <code>message.received</code> &mdash; an inbound SMS, WhatsApp, or
            social DM lands
          </li>
          <li>
            <code>call.missed</code> &mdash; a call goes unanswered
          </li>
        </ul>

        <h2>3. Keys &amp; security</h2>
        <p>
          API keys are scoped to a single workspace &mdash; a key only ever
          sees that workspace&rsquo;s data. Secrets are shown once at creation
          and stored hashed, so treat them like passwords. You can revoke and
          rotate keys at any time without disrupting the rest of your setup.
        </p>

        <h2>4. Getting connected</h2>
        <p>
          Ready-made recipes for <strong>Zapier, Make, n8n, and plain
          cURL</strong> are built in, so the most common integrations are
          copy-paste rather than a project.
        </p>

        <h2>5. Requesting new endpoints or events</h2>
        <p>
          The API and webhook catalog keeps growing. If you need an endpoint or
          an event that isn&rsquo;t listed yet, request it via the{" "}
          <a
            href="https://insigh.to/b/leadstackdev"
            target="_blank"
            rel="noopener noreferrer"
          >
            Feature Request
          </a>{" "}
          link in the footer &mdash; it&rsquo;s the fastest way to get it onto
          the roadmap and to see what others have already asked for.
        </p>

        <h2>6. Questions</h2>
        <p>
          Have a question about the API or webhooks before you build?{" "}
          <button
            type="button"
            onClick={openCrispChat}
            className="underline-offset-4 hover:underline"
          >
            Ask us via Chat
          </button>{" "}
          &mdash; we&rsquo;re happy to walk you through it.
        </p>
      </article>
    </div>
  );
}
