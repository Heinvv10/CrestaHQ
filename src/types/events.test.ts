import { describe, expect, it } from "vitest";

import { eventStatusLabel, type EventStatus } from "./events";

describe("eventStatusLabel", () => {
  const cases: [EventStatus, string][] = [
    ["scheduled", "Confirmed"],
    ["awaiting_payment", "Unconfirmed (awaiting payment)"],
    ["completed", "Showed"],
    ["no_show", "No-show"],
    ["cancelled", "Cancelled"],
  ];

  it.each(cases)("%s -> %s", (status, label) => {
    expect(eventStatusLabel(status)).toBe(label);
  });
});
