import { oneLine } from "@/lib/ai-suite/capabilities/text-safety";
import type { OrderDeliverySnapshot } from "@/types/orders";

/**
 * The two delivery emails of a paid product order: a community sign-in link,
 * and a download link (sent when the order confirmation didn't carry it).
 * Pure renderers; entitlements-service.ts sends them.
 */

type Delivery = OrderDeliverySnapshot["delivery"];

/** Header text: one line, no control characters, whatever the seller named the product. */
const subjectName = (name: string) => oneLine(name) || "your purchase";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderCommunityAccessEmail(input: {
  productName: string;
  business: string;
  what: string;
  link: string;
  loginUrl: string;
}): { subject: string; text: string; html: string } {
  const { productName, business, what, link, loginUrl } = input;
  return {
    subject: `Your access to ${subjectName(productName)}`,
    text: `Thanks for buying ${productName} from ${business}.

You now have access to ${what}. Use this link to sign in:

${link}

The link works once, for up to 24 hours. After that, sign in at ${loginUrl} with this email address and we'll send you a fresh link.
`,
    html: `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#202124;line-height:1.6;">
  <h1 style="font-size:20px;font-weight:600;margin:0 0 16px;">You're in</h1>
  <p style="margin:0 0 16px;color:#3a3a44;">Thanks for buying <strong>${esc(productName)}</strong> from ${esc(business)}. You now have access to ${esc(what)}.</p>
  <p style="margin:0 0 24px;">
    <a href="${esc(link)}" style="display:inline-block;background:#202124;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:500;">Sign in</a>
  </p>
  <p style="margin:0;font-size:13px;color:#606068;">The button works once, for up to 24 hours. After that, sign in at <a href="${esc(loginUrl)}" style="color:#606068;">${esc(loginUrl)}</a> with this email address and we'll send you a fresh link.</p>
</body></html>`,
  };
}

export function renderDownloadEmail(input: {
  productName: string;
  business: string;
  delivery: Extract<Delivery, { type: "download" }>;
}): { subject: string; text: string; html: string } {
  const { productName, business, delivery } = input;
  const label = delivery.label?.trim() || "Download";
  return {
    subject: `Your download: ${subjectName(productName)}`,
    text: `Thanks for buying ${productName} from ${business}.

${label}: ${delivery.url}

Keep this email so you can download it again later.
`,
    html: `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#202124;line-height:1.6;">
  <h1 style="font-size:20px;font-weight:600;margin:0 0 16px;">Your download is ready</h1>
  <p style="margin:0 0 24px;color:#3a3a44;">Thanks for buying <strong>${esc(productName)}</strong> from ${esc(business)}.</p>
  <p style="margin:0 0 24px;">
    <a href="${esc(delivery.url)}" style="display:inline-block;background:#202124;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:500;">${esc(label)}</a>
  </p>
  <p style="margin:0;font-size:13px;color:#606068;">Keep this email so you can download it again later.</p>
</body></html>`,
  };
}
