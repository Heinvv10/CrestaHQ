import { expect, it } from "vitest";
import { countsAsRevenue } from "./payments-report";
import type { Order } from "@/types/orders";

/** Revenue counts paid money that stands: a held buy-link order (its payment
 *  didn't match it) never does, even once part of it is refunded. */
const order = (over: Partial<Order>) => ({ status: "paid", ...over }) as Order;

it("paid and partly refunded count; pending, expired and held don't", () => {
  expect(countsAsRevenue(order({}))).toBe(true);
  expect(countsAsRevenue(order({ status: "partially_refunded" }))).toBe(true);
  for (const status of ["pending", "expired", "failed", "refunded"] as const) {
    expect(countsAsRevenue(order({ status }))).toBe(false);
  }
  expect(countsAsRevenue(order({ status: "partially_refunded", heldAt: new Date() }))).toBe(false);
  expect(countsAsRevenue(order({ heldAt: new Date() }))).toBe(false);
});
