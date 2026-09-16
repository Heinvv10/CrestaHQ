import { describe, expect, it } from "vitest";
import { mediaDroppedLabel } from "./whatsapp-media";

describe("mediaDroppedLabel", () => {
  it("names the three reasons this app produces itself", () => {
    expect(mediaDroppedLabel("too_large")).toBe("Attachment not saved — too large");
    expect(mediaDroppedLabel("unsupported_type")).toBe(
      "Attachment not saved — unsupported file type",
    );
    expect(mediaDroppedLabel("fetch_failed")).toBe("Attachment not saved — download failed");
  });

  it("never renders blank for a reason it has not heard of", () => {
    // The bridge writes its own reasons (`delivery_failed`, `shutdown`) and the
    // webhook stores them verbatim. A switch with no default returned
    // undefined here, and the thread showed an empty line.
    for (const reason of ["delivery_failed", "shutdown", "", "anything-else"]) {
      expect(mediaDroppedLabel(reason), reason).toBe("Attachment not saved");
    }
  });
});
