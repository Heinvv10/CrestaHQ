import type { WebhookEventType } from "@/types/webhooks";

/**
 * Representative sample payloads for synthetic ("send test event") webhook
 * deliveries — one builder per event type, Stripe-style realistic-but-
 * obviously-fake data. Shared by the manual "Send test event" route and
 * the AI Suite's create_webhook verification ping so the two can never
 * drift.
 */

export function sampleId(prefix: string): string {
  return `${prefix}_test_${Math.random().toString(36).slice(2, 10)}`;
}

export const SAMPLE_PAYLOADS: Record<WebhookEventType, () => unknown> = {
  "contact.created": () => ({
    contact: {
      id: sampleId("contact"),
      object: "contact",
      livemode: true,
      name: "Test Contact",
      email: "test@example.com",
      phone: "+15555550100",
      company: "Acme Test Co.",
      address: null,
      source: "test-event",
      tags: ["test"],
      pipeline_stage: null,
      territory_id: "global",
      email_opted_out: false,
      sms_opted_out: false,
      attribution: null,
      location: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  }),
  "contact.updated": () => ({
    contact: {
      id: sampleId("contact"),
      object: "contact",
      livemode: true,
      name: "Test Contact (updated)",
      email: "test@example.com",
      phone: "+15555550100",
      tags: ["test", "updated"],
      pipeline_stage: "qualified",
      created_at: new Date(Date.now() - 86400000).toISOString(),
      updated_at: new Date().toISOString(),
    },
  }),
  "contact.deleted": () => ({
    contact: { id: sampleId("contact"), object: "contact", deleted: true },
  }),
  "deal.created": () => {
    const contactId = sampleId("contact");
    return {
      deal: {
        id: sampleId("deal"),
        object: "deal",
        livemode: true,
        title: "Test Deal",
        value: 5000,
        currency: "USD",
        stage: "new",
        priority: "medium",
        contact_id: contactId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        stage_changed_at: new Date().toISOString(),
      },
      // Contact summary embedded so subscribers get the email inline.
      contact: {
        id: contactId,
        name: "Test Contact",
        email: "test@example.com",
        phone: "+15555550100",
      },
    };
  },
  "deal.updated": () => SAMPLE_PAYLOADS["deal.created"](),
  "deal.deleted": () => {
    const base = SAMPLE_PAYLOADS["deal.created"]() as {
      deal: Record<string, unknown>;
      contact: unknown;
    };
    return { deal: { ...base.deal, deleted: true }, contact: base.contact };
  },
  "deal.stage.changed": () => {
    const contactId = sampleId("contact");
    return {
      deal: {
        id: sampleId("deal"),
        object: "deal",
        livemode: true,
        title: "Test Deal",
        value: 5000,
        currency: "USD",
        stage: "qualified",
        priority: "medium",
        contact_id: contactId,
        created_at: new Date(Date.now() - 86400000).toISOString(),
        updated_at: new Date().toISOString(),
        stage_changed_at: new Date().toISOString(),
      },
      contact: {
        id: contactId,
        name: "Test Contact",
        email: "test@example.com",
        phone: "+15555550100",
      },
      previous_stage: "contacted",
    };
  },
  "deal.won": () => {
    const base = SAMPLE_PAYLOADS["deal.created"]() as {
      deal: Record<string, unknown>;
      contact: unknown;
    };
    return { deal: { ...base.deal, stage: "won" }, contact: base.contact };
  },
  "deal.lost": () => {
    const base = SAMPLE_PAYLOADS["deal.created"]() as {
      deal: Record<string, unknown>;
      contact: unknown;
    };
    return {
      deal: { ...base.deal, stage: "lost", lost_reason: "Test rejection" },
      contact: base.contact,
    };
  },
  "task.created": () => ({
    task: {
      id: sampleId("task"),
      object: "task",
      livemode: true,
      title: "Test task",
      notes: "Sample notes",
      due_at: new Date(Date.now() + 86400000).toISOString(),
      completed: false,
      completed_at: null,
      contact_id: sampleId("contact"),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  }),
  "task.completed": () => ({
    task: {
      id: sampleId("task"),
      object: "task",
      livemode: true,
      title: "Test task",
      completed: true,
      completed_at: new Date().toISOString(),
      contact_id: sampleId("contact"),
      created_at: new Date(Date.now() - 3600000).toISOString(),
      updated_at: new Date().toISOString(),
    },
  }),
  "event.created": () => ({
    event: {
      id: sampleId("event"),
      object: "event",
      livemode: true,
      title: "Test calendar event",
      start_at: new Date(Date.now() + 3600000).toISOString(),
      end_at: new Date(Date.now() + 7200000).toISOString(),
      contact_id: sampleId("contact"),
      status: "scheduled",
      source: "manual",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  }),
  "form.submitted": () => ({
    submission: {
      id: sampleId("sub"),
      object: "form_submission",
      form_id: sampleId("form"),
      contact: (SAMPLE_PAYLOADS["contact.created"]() as { contact: unknown }).contact,
      values: { name: "Test Contact", email: "test@example.com", phone: "+15555550100" },
    },
  }),
  "quote.sent": () => ({
    quote: {
      id: sampleId("quote"),
      object: "quote",
      number: "Q-2026-TEST",
      total: 5000,
      currency: "USD",
      status: "sent",
      contact_id: sampleId("contact"),
      sent_at: new Date().toISOString(),
    },
  }),
  "quote.viewed": () => SAMPLE_PAYLOADS["quote.sent"](),
  "quote.accepted": () => ({
    quote: { ...((SAMPLE_PAYLOADS["quote.sent"]() as { quote: unknown }).quote as Record<string, unknown>), status: "accepted", accepted_at: new Date().toISOString() },
  }),
  "quote.declined": () => ({
    quote: { ...((SAMPLE_PAYLOADS["quote.sent"]() as { quote: unknown }).quote as Record<string, unknown>), status: "declined", decline_reason: "Test rejection" },
  }),
  "quote.paid": () => ({
    quote: { ...((SAMPLE_PAYLOADS["quote.sent"]() as { quote: unknown }).quote as Record<string, unknown>), status: "paid", paid_at: new Date().toISOString() },
  }),
  "booking.created": () => ({
    booking: {
      id: sampleId("booking"),
      object: "booking",
      slug: "discovery-call",
      contact_id: sampleId("contact"),
      start_at: new Date(Date.now() + 86400000).toISOString(),
      end_at: new Date(Date.now() + 86400000 + 1800000).toISOString(),
      created_at: new Date().toISOString(),
    },
  }),
  "booking.cancelled": () => ({
    booking: {
      id: sampleId("booking"),
      object: "booking",
      cancelled_at: new Date().toISOString(),
      cancel_reason: "Test cancellation",
    },
  }),
  "voice.call.completed": () => ({
    call: {
      id: sampleId("call"),
      object: "voice_call",
      caller_phone: "+15555550100",
      duration_seconds: 142,
      summary: "Caller asked about pricing. Test event.",
      contact_id: sampleId("contact"),
      ended_at: new Date().toISOString(),
    },
  }),
  "voice.call.captured": () => ({
    call: {
      id: sampleId("call"),
      object: "voice_call",
      caller_phone: "+15555550100",
      summary: "Caller provided email + requested callback. Test event.",
      captured: { email: "test@example.com", callback_requested: true },
      contact: (SAMPLE_PAYLOADS["contact.created"]() as { contact: unknown }).contact,
    },
  }),
  "webchat.lead.captured": () => ({
    session: {
      id: sampleId("ses"),
      object: "webchat_session",
      page_url: "https://example.com/pricing",
      messages_count: 4,
    },
    contact: (SAMPLE_PAYLOADS["contact.created"]() as { contact: unknown }).contact,
  }),
  "member.invited": () => ({
    invite: {
      id: sampleId("inv"),
      object: "invite",
      email: "newteammate@example.com",
      role: "collaborator",
      invited_by_uid: "user_test_xxx",
      created_at: new Date().toISOString(),
    },
  }),
  "member.added": () => ({
    member: {
      uid: "user_test_xxx",
      object: "member",
      email: "existingteammate@example.com",
      role: "collaborator",
      added_by_uid: "user_test_yyy",
      assigned_territory_ids: [],
      already_member: false,
      added_at: new Date().toISOString(),
    },
  }),
  "automation.completed": () => ({
    execution: {
      id: sampleId("exec"),
      object: "automation_execution",
      recipe_type: "instant_response",
      automation_id: sampleId("auto"),
      contact_id: sampleId("contact"),
      steps_completed: 3,
      completed_at: new Date().toISOString(),
    },
  }),
  "community.member.joined": () => ({
    groupId: sampleId("grp"),
    memberId: sampleId("mbr"),
    via: "open",
  }),
  "community.member.approved": () => ({
    groupId: sampleId("grp"),
    memberId: sampleId("mbr"),
  }),
  "community.purchase.paid": () => ({
    purchaseId: sampleId("pur"),
    groupId: sampleId("grp"),
    memberId: sampleId("mbr"),
    scope: "course",
    targetId: sampleId("crs"),
    amountCents: 4900,
    currency: "USD",
  }),
  "community.lesson.completed": () => ({
    groupId: sampleId("grp"),
    courseId: sampleId("crs"),
    lessonId: sampleId("les"),
    memberId: sampleId("mbr"),
    progressPct: 50,
  }),
  "community.course.completed": () => ({
    groupId: sampleId("grp"),
    courseId: sampleId("crs"),
    memberId: sampleId("mbr"),
  }),
  "message.received": () => ({
    message: {
      object: "message",
      contact_id: sampleId("contact"),
      contact_name: "Test Contact",
      channel: "sms",
      preview: "Hi — is anyone available this afternoon?",
    },
  }),
  "call.missed": () => ({
    call: {
      object: "missed_call",
      contact_id: sampleId("contact"),
      contact_name: "Test Contact",
      from: "+15555550100",
      call_sid: sampleId("CA"),
    },
  }),
  "billing.plan.assigned": () => ({
    subAccountId: sampleId("sa"),
    planId: sampleId("plan"),
    planName: "Pro",
    priceCents: 29700,
    currency: "usd",
    status: "pending",
  }),
  "billing.activated": () => ({
    subAccountId: sampleId("sa"),
    planId: sampleId("plan"),
    planName: "Pro",
    priceCents: 29700,
    currency: "usd",
  }),
  "billing.past_due": () => ({
    subAccountId: sampleId("sa"),
    planId: sampleId("plan"),
    planName: "Pro",
    previousStatus: "active",
    status: "past_due",
  }),
  "billing.canceled": () => ({
    subAccountId: sampleId("sa"),
    planId: sampleId("plan"),
    planName: "Pro",
    previousStatus: "past_due",
    status: "canceled",
  }),
  "billing.charge.paid": () => ({
    chargeId: sampleId("charge"),
    subAccountId: sampleId("sa"),
    description: "Web design",
    amountCents: 50000,
    currency: "usd",
  }),
  "order.paid": () => ({
    order: {
      id: sampleId("order"),
      status: "paid",
      currency: "usd",
      subtotal_cents: 14700,
      total_cents: 14700,
      refunded_cents: 0,
      line_items: [
        {
          product_id: sampleId("prod"),
          name: "Starter package",
          unit_price_cents: 9900,
          quantity: 1,
          is_bump: false,
        },
        {
          product_id: sampleId("prod"),
          name: "Priority onboarding",
          unit_price_cents: 4800,
          quantity: 1,
          is_bump: true,
        },
      ],
      contact_id: sampleId("contact"),
      checkout_page_id: sampleId("page"),
      source: "checkout_page",
      livemode: true,
      buyer_email: "buyer@example.com",
      buyer_name: "Jordan Reyes",
      stripe_checkout_session_id: sampleId("cs"),
      stripe_payment_intent_id: sampleId("pi"),
    },
  }),
  "order.refunded": () => ({
    order: {
      id: sampleId("order"),
      status: "refunded",
      currency: "usd",
      subtotal_cents: 9900,
      total_cents: 9900,
      refunded_cents: 9900,
      line_items: [
        {
          product_id: sampleId("prod"),
          name: "Starter package",
          unit_price_cents: 9900,
          quantity: 1,
          is_bump: false,
        },
      ],
      contact_id: sampleId("contact"),
      checkout_page_id: sampleId("page"),
      source: "checkout_page",
      livemode: true,
      buyer_email: "buyer@example.com",
      buyer_name: "Jordan Reyes",
      stripe_checkout_session_id: sampleId("cs"),
      stripe_payment_intent_id: sampleId("pi"),
    },
  }),
};
