/** Stored quote / schedule docs and a connected SMTP account, for the PR11 agent tests. */

export const QUOTE = {
  subAccountId: "sa1", agencyId: "ag1", kind: "quote", status: "draft", contactId: "c1", quoteNumber: "Q-0001", currency: "ZAR",
  lineItems: [{ id: "l1", description: "Install", quantity: 1, unitPrice: 500, productId: null }],
  globalDiscount: null, globalTaxPercent: null, termsAndNotes: "", billedToOrganization: null, billingAddress: null,
  validUntil: null, paymentDueDays: null, recurringInvoiceId: null, autoCreateDealOnAccept: false, dealId: null, territoryId: "global",
};

export const SCHEDULE = {
  subAccountId: "sa1", agencyId: "ag1", contactId: "c1", name: "Retainer", status: "active", currency: "ZAR",
  lineItems: [{ id: "l1", description: "Support", quantity: 1, unitPrice: 1000, productId: null }],
  globalDiscount: null, globalTaxPercent: null, termsAndNotes: "", billedToOrganization: null, billingAddress: null, paymentDueDays: null,
  cadence: { unit: "month", interval: 1 }, anchorDay: 1, timezone: "UTC", startAt: new Date("2029-12-01T00:00:00Z"),
  nextRunAt: new Date("2030-01-01T00:00:00Z"), endMode: "never", endAt: null, maxCycles: null, reviewFirst: false, chargeMode: "invoice",
  unpaidEscalationThreshold: 2, cyclesGenerated: 0, lastRunAt: null, lastInvoiceId: null, outstandingInvoices: 0, lastError: null,
};

export const SMTP = {
  emailProvider: "smtp",
  smtpConfig: { verifiedAt: new Date("2026-01-01T00:00:00Z"), host: "smtp.example.com", fromEmail: "billing@acme.example", fromName: "Acme" },
};
