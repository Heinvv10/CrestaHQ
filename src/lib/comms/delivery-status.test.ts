import { describe, expect, it } from "vitest";
import { deliveryStatusPart } from "./delivery-status";

/** The message/delivery-status MIME part of a bounce, read from the raw source. */

const REPORT = 'multipart/report; report-type=delivery-status; boundary="r"';
const part = (headers: string, body: string) => `--r\r\n${headers}\r\n\r\n${body}\r\n`;
const report = (ds: string, dsHeaders = "Content-Type: message/delivery-status") =>
  part("Content-Type: text/plain", "Could not deliver.") + part(dsHeaders, ds) + "--r--\r\n";

describe("deliveryStatusPart", () => {
  it("returns the delivery-status part of a delivery-status report", () => {
    expect(deliveryStatusPart(report("Final-Recipient: rfc822; a@b.co\r\nAction: failed"), REPORT)).toBe(
      "Final-Recipient: rfc822; a@b.co\r\nAction: failed",
    );
  });

  it("decodes a quoted-printable part (soft line breaks and =XX)", () => {
    const qp = "Final-Recipient: rfc822; a@b.co\r\nAction: fa=\r\niled\r\nDiagnostic-Code: smtp; 550 =3D no such user";
    expect(deliveryStatusPart(report(qp, "Content-Type: message/delivery-status\r\nContent-Transfer-Encoding: quoted-printable"), REPORT)).toBe(
      "Final-Recipient: rfc822; a@b.co\r\nAction: failed\r\nDiagnostic-Code: smtp; 550 = no such user",
    );
  });

  it("finds a report nested inside multipart/mixed", () => {
    const inner = report("Final-Recipient: rfc822; a@b.co\r\nAction: failed");
    const outer = `--m\r\nContent-Type: text/plain\r\n\r\nSee below.\r\n--m\r\nContent-Type: ${REPORT}\r\n\r\n${inner}\r\n--m--\r\n`;
    expect(deliveryStatusPart(outer, 'multipart/mixed; boundary="m"')).toBe("Final-Recipient: rfc822; a@b.co\r\nAction: failed");
  });

  it("splits on whole boundary lines only: boundary b1 does not split inside --b10", () => {
    const inner = `--b10\r\nContent-Type: text/plain\r\n\r\nCould not deliver.\r\n--b10\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; a@b.co\r\nAction: failed\r\n--b10--\r\n`;
    // The body starts with the first boundary (no preamble line before it).
    const outer = `--b1\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="b10"\r\n\r\n${inner}\r\n--b1--\r\n`;
    expect(deliveryStatusPart(outer, 'multipart/mixed; boundary="b1"')).toBe("Final-Recipient: rfc822; a@b.co\r\nAction: failed");
  });

  it("a boundary with regex characters is matched literally", () => {
    const b = "=_part.1+(x)";
    const body = `--${b}\r\nContent-Type: message/delivery-status\r\n\r\nAction: failed\r\n--${b}--\r\n`;
    expect(deliveryStatusPart(body, `multipart/report; report-type=delivery-status; boundary="${b}"`)).toBe("Action: failed");
  });

  it("is empty for a read receipt, a plain message or a report with no delivery-status part", () => {
    const receipt = report("Final-Recipient: rfc822; a@b.co\r\nDisposition: manual-action/MDN-sent-manually; displayed", "Content-Type: message/disposition-notification");
    expect(deliveryStatusPart(receipt, 'multipart/report; report-type=disposition-notification; boundary="r"')).toBe("");
    expect(deliveryStatusPart(report("Action: failed"), 'multipart/report; report-type=disposition-notification; boundary="r"')).toBe("");
    expect(deliveryStatusPart("Action: failed", "text/plain")).toBe("");
    expect(deliveryStatusPart("Action: failed", null)).toBe("");
  });
});
