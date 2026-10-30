import "server-only";

import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { ensureMember } from "@/lib/community/member-account";
import { signMemberMagicLinkToken } from "@/lib/community/member-auth";
import { getCourse } from "@/lib/server/community-classroom-service";
import { getGroupById, getMembership } from "@/lib/server/community-service";
import {
  createPurchaseForOrderServerSide,
  markPurchasePaidServerSide,
} from "@/lib/server/community-purchase-service";
import {
  renderCommunityAccessEmail,
  renderDownloadEmail,
} from "@/lib/server/entitlement-emails";
import { isSafeSocialUrl } from "@/lib/website/premium";
import type { Order, OrderDeliverySnapshot } from "@/types/orders";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The two ways a paid product order is delivered (see entitlements-service.ts
 * for the claim, roll-up and activity around them). A `DeliveryError` carries
 * a message that is safe to show staff; anything else is logged and replaced
 * by a generic one.
 */

/** Written to `purchase.grantedByUid`: the order paid, not a staff member. */
export const PRODUCT_GRANTOR = "system:product-order";
/**
 * Purchase emails are often opened hours later, so the link outlives the usual
 * 15 minutes. Links aren't single use, so keep this short.
 */
const DELIVERY_LINK_TTL_MS = 24 * 60 * 60 * 1000;

type Delivery = OrderDeliverySnapshot["delivery"];

export class DeliveryError extends Error {}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export async function deliverCommunity(input: {
  order: Order;
  sub: Partial<SubAccountDoc>;
  delivery: Extract<Delivery, { type: "community" }>;
  email: string;
  productName: string;
  productId: string;
}): Promise<{ memberId: string; problem?: string }> {
  const { order, sub, delivery, email, productName, productId } = input;
  const saId = order.subAccountId;
  const group = await getGroupById(saId, delivery.communityGroupId);
  if (!group) throw new DeliveryError("The community group no longer exists.");
  const course = delivery.courseId ? await getCourse(saId, group.id, delivery.courseId) : null;
  if (delivery.courseId && !course) {
    throw new DeliveryError("The course no longer exists in that group.");
  }

  const member = await ensureMember({
    subAccountId: saId,
    email,
    displayName: order.buyerName,
  });
  if (member.status !== "active") {
    throw new DeliveryError("This buyer's community account is deactivated.");
  }
  const membership = await getMembership(saId, group.id, member.id);
  if (membership?.status === "banned") {
    throw new DeliveryError("This buyer is banned from the group, so access wasn't granted.");
  }

  // A course product grants its group as well, so the buyer can reach it. An
  // active member keeps their membership as is (a re-grant would reset a
  // moderator to member).
  const grants: { scope: "group" | "course"; targetId: string; suffix: string }[] = [];
  if (membership?.status !== "active") {
    grants.push({ scope: "group", targetId: group.id, suffix: "g" });
  }
  if (course) grants.push({ scope: "course", targetId: course.id, suffix: "c" });
  for (const g of grants) {
    const purchaseId = await createPurchaseForOrderServerSide({
      subAccountId: saId,
      agencyId: order.agencyId,
      groupId: group.id,
      scope: g.scope,
      targetId: g.targetId,
      memberId: member.id,
      currency: order.currency,
      orderId: order.id,
      purchaseId: `order_${order.id}_${productId}_${g.suffix}`,
    });
    await markPurchasePaidServerSide({
      subAccountId: saId,
      groupId: group.id,
      purchaseId,
      grantedByUid: PRODUCT_GRANTOR,
      paidOrderId: order.id,
    });
  }

  if (sub.communityEnabledByAgency !== true) {
    return {
      memberId: member.id,
      problem:
        "Access was granted, but Community is turned off for this workspace, so no sign-in email was sent.",
    };
  }
  if (!emailIsConfigured(sub)) {
    return {
      memberId: member.id,
      problem: "Access was granted, but email isn't set up, so no sign-in email was sent.",
    };
  }

  const token = signMemberMagicLinkToken(saId, email, group.id, DELIVERY_LINK_TTL_MS);
  const link = `${appUrl()}/api/community/${saId}/login/verify?token=${encodeURIComponent(token)}`;
  const mail = renderCommunityAccessEmail({
    productName,
    business: sub.name || "us",
    what: course ? `the ${course.title} course in ${group.name}` : group.name,
    link,
    loginUrl: `${appUrl()}/c/${saId}/login`,
  });
  await sendEmail({
    to: email,
    from: tenantFrom(sub),
    subAccount: sub,
    meter: { subAccountId: saId },
    contactId: order.contactId ?? undefined,
    ...mail,
  });
  return { memberId: member.id };
}

export async function deliverDownload(input: {
  order: Order;
  sub: Partial<SubAccountDoc>;
  delivery: Extract<Delivery, { type: "download" }>;
  email: string;
  productName: string;
  skipEmail: boolean;
}): Promise<void> {
  const { order, sub, delivery, email, productName } = input;
  if (!isSafeSocialUrl(delivery.url)) {
    throw new DeliveryError("The download link isn't a valid https link.");
  }
  if (input.skipEmail) return;
  if (!emailIsConfigured(sub)) {
    throw new DeliveryError(
      "Email isn't set up, so the link wasn't emailed. The buyer saw it on the thank-you page.",
    );
  }
  const mail = renderDownloadEmail({ productName, business: sub.name || "us", delivery });
  await sendEmail({
    to: email,
    from: tenantFrom(sub),
    subAccount: sub,
    meter: { subAccountId: order.subAccountId },
    contactId: order.contactId ?? undefined,
    ...mail,
  });
}
