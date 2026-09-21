import "server-only";

import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getPairingQrPng } from "@/lib/comms/whatsapp/manager-client";
import { requireWhatsappEnabledByAgency } from "@/lib/comms/whatsapp/bridge-agency-gate";
import { managerFailureResponse } from "@/lib/comms/whatsapp/manager-failure";

/**
 * The pairing QR, as an image the settings card can put in an `<img>`.
 *
 * WHY AN IMAGE ROUTE EXISTS AT ALL. The pairing payload is a write-grade
 * credential, and the sibling `../pairing` JSON route deliberately does not
 * carry it. Encoding it into a PNG server-side is what lets the admin scan it
 * without the string ever existing in the browser: not in a JSON body, not in
 * a React state value, not in a devtools network tab as text, not in anything
 * a support screenshot or a copy-paste can carry off.
 *
 * TENANCY — `params.id`, validated by requireSubAccountAdmin. The manager
 * renders the QR of whatever tenant the path names and holds one global
 * operator token, so an id taken from a query parameter here would hand any
 * workspace admin a code that links a device to another customer's number.
 *
 * `no-store` on EVERY answer, the failures included. A cached pairing QR is a
 * credential sitting in a disk cache and a proxy long after it expired, and
 * `<img>` responses are exactly what an intermediary caches by default.
 * `nosniff` because the browser must not be talked into treating these bytes
 * as anything but an image.
 *
 * Nothing here reads or logs the body. The bytes ARE the credential.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  // The agency feature gate, same check and same refusal as ../provision. A
  // workspace whose agency has switched WhatsApp off must not be able to pull
  // a live pairing credential or mint fresh ones; without this the gate only
  // stops NEW bridges and leaves every existing one fully operable.
  const gate = await requireWhatsappEnabledByAgency(subAccountId);
  if (!gate.ok) return gate.response;

  const result = await getPairingQrPng(subAccountId);
  if (!result.ok) {
    const res = managerFailureResponse(result);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  return new NextResponse(result.data, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
