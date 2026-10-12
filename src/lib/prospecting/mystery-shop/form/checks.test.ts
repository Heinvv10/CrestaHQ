import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { waitForSignal } from "./checks";
import { newGuardState, type GuardState } from "./network";

/**
 * waitForSignal's last look. What changes between the top of a poll and its
 * answer, or during the final wait before the window closes, cannot be timed
 * against a real browser — so the page here is a stub, and the clock only
 * moves when the engine waits. What a real page produces: confirm-wait.test.ts.
 */

const FORM = "https://www.acme.co.za/contact";
const ENQUIRY = "https://www.acme.co.za/api/enquiry";
const CAPTCHA = "captcha element: div.g-recaptcha";

interface Stub {
  captcha: string | null;
  thanks: number;
  /** As the page's text is read for thank-you wording (after the poll's own CAPTCHA check). */
  onRead?: () => void;
  /** As a wait between two polls ends. */
  onWait?: () => void;
}
function stubPage(stub: Stub): Page {
  return {
    frames: () => [{ url: () => FORM, evaluate: async () => stub.captcha }],
    evaluate: async () => {
      stub.onRead?.();
      return stub.thanks;
    },
    url: () => FORM,
    waitForTimeout: async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
      stub.onWait?.();
    },
  } as unknown as Page;
}
/** After the click, the enquiry answered 2xx by the form's own site. */
const taken = (): GuardState => ({ ...newGuardState(), formUrl: FORM, clickedAt: 0, postsOut: 1, carrierOk: ENQUIRY, postOk: ENQUIRY });
const BARE = { signal: "post_2xx", finalUrl: FORM };

beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: 0 }));
afterEach(() => void vi.useRealTimers());

describe("a bare 2xx", () => {
  it("is reported 1.5 s after it was first seen, not at the end of the window", async () => {
    expect(await waitForSignal(stubPage({ captcha: null, thanks: 0 }), taken(), 0, 10_000)).toEqual(BARE);
    expect(Date.now()).toBe(1_500);
  });

  it("is reported when the window closes first", async () => {
    expect(await waitForSignal(stubPage({ captcha: null, thanks: 0 }), taken(), 0, 1_000)).toEqual(BARE);
    expect(Date.now()).toBe(1_000);
  });
});

describe("the last look before the answer", () => {
  it("a CAPTCHA that appears as the page is read for the deciding time: captcha, not post_2xx", async () => {
    const stub: Stub = { captcha: null, thanks: 0 };
    stub.onRead = () => {
      if (Date.now() >= 1_500) stub.captcha = CAPTCHA;
    };
    expect(await waitForSignal(stubPage(stub), taken(), 0, 10_000)).toEqual({ captcha: CAPTCHA });
  });

  it("a CAPTCHA that appears with the thank-you text: captcha, not thank_you", async () => {
    const stub: Stub = { captcha: null, thanks: 0 };
    stub.onRead = () => {
      stub.thanks = 1;
      stub.captcha = CAPTCHA;
    };
    expect(await waitForSignal(stubPage(stub), taken(), 0, 10_000)).toEqual({ captcha: CAPTCHA });
  });

  it("the form's own site refuses the enquiry as thank-you text shows (only another site had answered): rejected", async () => {
    const state = { ...taken(), postOk: null };
    const stub: Stub = { captcha: null, thanks: 0 };
    stub.onRead = () => {
      stub.thanks = 1;
      state.rejected = "spam";
    };
    expect(await waitForSignal(stubPage(stub), state, 0, 10_000)).toEqual({ rejected: "spam" });
  });

  it("a refusal while the message went out twice: no signal, not rejected", async () => {
    const state = { ...taken(), postOk: null, messagesOut: 2, rejected: "success:false" };
    expect(await waitForSignal(stubPage({ captcha: null, thanks: 0 }), state, 0, 10_000)).toBeNull();
  });

  it("such a refusal as thank-you text shows (the message went out twice): no signal, not rejected", async () => {
    const state = { ...taken(), postOk: null, messagesOut: 2 };
    const stub: Stub = { captcha: null, thanks: 0 };
    stub.onRead = () => {
      stub.thanks = 1;
      state.rejected = "spam";
    };
    expect(await waitForSignal(stubPage(stub), state, 0, 10_000)).toBeNull();
  });

  it("the site refuses a later request as the page is read for the deciding time: refusedLate, not post_2xx", async () => {
    const state = taken();
    const stub: Stub = { captcha: null, thanks: 0 };
    stub.onRead = () => {
      if (Date.now() >= 1_500) state.refusedLate = "ok:false";
    };
    expect(await waitForSignal(stubPage(stub), state, 0, 10_000)).toEqual({ refusedLate: "ok:false" });
  });

  it("a refusal after the enquiry was taken stops a post-redirect-get page from confirming it", async () => {
    const state = { ...taken(), refusedLate: "ok:false", prgPage: "https://www.acme.co.za/thanks" };
    expect(await waitForSignal(stubPage({ captcha: null, thanks: 1 }), state, 0, 10_000)).toEqual({ refusedLate: "ok:false" });
  });

  it("a CAPTCHA that appears during the final wait, as the window closes: captcha, not post_2xx", async () => {
    const stub: Stub = { captcha: null, thanks: 0 };
    stub.onWait = () => {
      if (Date.now() >= 1_000) stub.captcha = CAPTCHA;
    };
    expect(await waitForSignal(stubPage(stub), taken(), 0, 1_000)).toEqual({ captcha: CAPTCHA });
  });

  it("the page outgrows its budget during the final wait: no signal, not post_2xx", async () => {
    const state = taken();
    const stub: Stub = { captcha: null, thanks: 0 };
    stub.onWait = () => {
      if (Date.now() >= 1_000) state.tooHeavy = true;
    };
    expect(await waitForSignal(stubPage(stub), state, 0, 1_000)).toBeNull();
  });

  it("another request carrying the message was answered 4xx/5xx: no signal, not post_2xx", async () => {
    const state = { ...taken(), carrierFailed: `500 ${ENQUIRY}` };
    expect(await waitForSignal(stubPage({ captcha: null, thanks: 0 }), state, 0, 10_000)).toBeNull();
  });

  it("such a 4xx/5xx stops a post-redirect-get page from confirming it", async () => {
    const state = { ...taken(), carrierFailed: `500 ${ENQUIRY}`, prgPage: "https://www.acme.co.za/thanks" };
    expect(await waitForSignal(stubPage({ captcha: null, thanks: 1 }), state, 0, 10_000)).toBeNull();
  });

  it("such a 4xx/5xx with the window closing first: no signal, not post_2xx", async () => {
    const state = { ...taken(), carrierFailed: `500 ${ENQUIRY}` };
    expect(await waitForSignal(stubPage({ captcha: null, thanks: 0 }), state, 0, 1_000)).toBeNull();
  });
});

describe("a refusal is held until the message goes quiet", () => {
  const refused = (): GuardState => ({ ...taken(), messagesOut: 1, messagesAnswered: 1, rejected: "spam" });

  it("one request carried the message: rejected once RENDER_MS passed with no other", async () => {
    expect(await waitForSignal(stubPage({ captcha: null, thanks: 0 }), refused(), 0, 10_000)).toEqual({ rejected: "spam" });
    expect(Date.now()).toBe(1_500);
  });

  it("the enquiry goes out while the refusal is held (thank-you text showing): no signal, not rejected", async () => {
    const state = refused();
    const stub: Stub = { captcha: null, thanks: 1 };
    stub.onWait = () => {
      if (Date.now() === 1_000) state.messagesOut++;
    };
    expect(await waitForSignal(stubPage(stub), state, 0, 10_000)).toBeNull();
  });

  it("the window closes while it is held: rejected", async () => {
    expect(await waitForSignal(stubPage({ captcha: null, thanks: 0 }), refused(), 0, 1_000)).toEqual({ rejected: "spam" });
  });
});

describe("a request carrying the message still unanswered", () => {
  it("holds the bare 2xx until it is answered, then the 2xx stands", async () => {
    const state = { ...taken(), messagesOut: 2, messagesAnswered: 1 };
    const stub: Stub = { captcha: null, thanks: 0 };
    stub.onWait = () => {
      if (Date.now() >= 3_000) state.messagesAnswered = 2;
    };
    expect(await waitForSignal(stubPage(stub), state, 0, 10_000)).toEqual(BARE);
    expect(Date.now()).toBeGreaterThanOrEqual(3_000);
  });

  it("one that goes out after the 2xx and is still unanswered as the window closes: no signal, not post_2xx", async () => {
    const state = { ...taken(), messagesOut: 1, messagesAnswered: 1 };
    const stub: Stub = { captcha: null, thanks: 0 };
    stub.onWait = () => {
      if (Date.now() === 250) state.messagesOut++;
    };
    expect(await waitForSignal(stubPage(stub), state, 0, 1_000)).toBeNull();
  });
});
