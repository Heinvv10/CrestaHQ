import { describe, expect, it } from "vitest";
import { carriesEnquiry, carriesMessage, enquiryMarkers, rejectionOf } from "./evidence";

/** What proves a request carried OUR enquiry, and a 2xx that says the site refused it (fix round 1, V1). */

const markers = enquiryMarkers({
  email: "info@crestahq.com",
  message: "Hi,\n\nDo you do plumber in Gqeberha? What's your earliest availability?\n\nThanks,\nCresta HQ",
});

describe("carriesEnquiry", () => {
  it.each([
    ["urlencoded", "your-name=Cresta+HQ&email=info%40crestahq.com&message=Hi"],
    ["raw email", '{"email":"info@crestahq.com"}'],
    ["JSON message (escaped newlines)", '{"m":"Hi,\\n\\nDo you do plumber in Gqeberha? What\'s your earliest availability?"}'],
    ["urlencoded message only", "m=Do+you+do+plumber+in+Gqeberha%3F+What%27s+your+earliest+availability%3F"],
    ["multipart", '------x\r\nContent-Disposition: form-data; name="email"\r\n\r\ninfo@crestahq.com\r\n------x--'],
    ["a GET query", "https://acme.co.za/send?email=info%40crestahq.com"],
  ])("%s", (_name, text) => {
    expect(carriesEnquiry(text, markers)).toBe(true);
  });

  it.each([["analytics", "pv=1&page=%2Fcontact"], ["empty", ""], ["another address", "email=info%40crestahq.co"], ["bad encoding", "%E0%A4%A"]])(
    "%s is not the enquiry",
    (_name, text) => {
      expect(carriesEnquiry(text, markers)).toBe(false);
    },
  );
});

describe("carriesMessage", () => {
  it("needs the message's longest line: our email alone is not the enquiry", () => {
    expect(carriesMessage("email=info%40crestahq.com", markers)).toBe(false);
    expect(carriesMessage("email=info%40crestahq.com&m=Do+you+do+plumber+in+Gqeberha%3F+What%27s+your+earliest+availability%3F", markers)).toBe(true);
  });

  it("matches a line the browser hard-wrapped as it submitted (CR LF where a space was), encoded or JSON-escaped", () => {
    expect(carriesMessage("message=Do+you+do+plumber+in%0D%0AGqeberha%3F+What%27s+your%0D%0Aearliest+availability%3F", markers)).toBe(true);
    expect(carriesMessage('{"m":"Do you do plumber in\\r\\nGqeberha? What\'s your earliest availability?"}', markers)).toBe(true);
    expect(carriesMessage("message=Do+you+do+plumber+in%0D%0AGqeberha%3F", markers)).toBe(false);
  });

  it("matches a line hard-wrapped inside its words (a narrow textarea)", () => {
    expect(carriesMessage("message=Do+you%0D%0Ado+plu%0D%0Amber+in+Gqe%0D%0Aberha%3F+What%27s+your+earliest+availa%0D%0Ability%3F", markers)).toBe(true);
  });

  it("a short line padded with spaces is short once they are removed: our email stands for it, not a phone number", () => {
    const spaced = enquiryMarkers({ email: "info@crestahq.com", message: "1 2 3 4 5 6 7" });
    expect(carriesMessage("phone=%2B27831234567", spaced)).toBe(false);
    expect(carriesMessage("email=info%40crestahq.com", spaced)).toBe(true);
  });

  it("a page holding the message's words in another order is not the message", () => {
    expect(carriesMessage("What's your earliest availability? Do you do plumber in Gqeberha?", markers)).toBe(false);
    expect(carriesMessage("q=Gqeberha+plumber+availability+earliest+your+What%27s+in+do+you+Do", markers)).toBe(false);
  });

  it("a message line with runs of spaces or tabs matches as the browser sends it", () => {
    const spaced = enquiryMarkers({ email: "info@crestahq.com", message: "Do you  do plumber\tin Gqeberha?" });
    expect(carriesMessage("m=Do+you++do+plumber%09in+Gqeberha%3F", spaced)).toBe(true);
  });

  it("falls back to our email when no line of the message is long enough to be ours alone", () => {
    const short = enquiryMarkers({ email: "info@crestahq.com", message: "Hi,\nQuote?" });
    expect(carriesMessage("email=info%40crestahq.com", short)).toBe(true);
    expect(carriesMessage("m=Hi%2C+Quote%3F", short)).toBe(false);
  });
});

describe("rejectionOf", () => {
  it.each([
    ['{"status":"validation_failed","message":"One or more fields have an error."}', "validation_failed"],
    ['{"status":"spam"}', "spam"],
    ['{"status":"mail_failed"}', "mail_failed"],
    ['{"status":"aborted"}', "aborted"],
    ['{"status":"invalid"}', "invalid"],
    ['{"success":false,"error":"x"}', "success:false"],
    ['{"ok":false}', "ok:false"],
    [' {"data":{"status":"spam"}} ', null],
  ])("%s → %s", (body, reason) => {
    expect(rejectionOf(body)).toBe(reason);
  });

  it("a success, HTML or non-JSON body is not a rejection", () => {
    expect(rejectionOf('{"status":"mail_sent","message":"Thank you"}')).toBeNull();
    expect(rejectionOf('{"success":true}')).toBeNull();
    expect(rejectionOf("<h1>Thank you</h1>")).toBeNull();
    expect(rejectionOf("{not json")).toBeNull();
    expect(rejectionOf("[]")).toBeNull();
  });
});
