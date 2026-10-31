// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The settings page's contacts export reads the layout's shared contacts
 * list. A territory-scoped collaborator's filter must reach that listener
 * (the unfiltered query the page used to run is refused by the rules), and a
 * failed load must never read as "0 contacts".
 */
const state = vi.hoisted(() => ({
  territory: { ready: true, filter: null as string[] | null },
  subs: [] as Array<{
    opts: { territoryFilter?: string[] | null };
    deliver: (l: unknown[]) => void;
    fail: (e: Error) => void;
  }>,
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, role: "member", loading: false }),
}));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccountId: "sa1", agencyId: "ag1", subAccount: { name: "Fixture" } }),
}));
vi.mock("@/hooks/use-effective-territory-filter", () => ({
  useEffectiveTerritoryFilter: () => state.territory,
}));
vi.mock("@/lib/firestore/users", () => ({ getUserDoc: async () => null }));
vi.mock("@/lib/firestore/contacts", () => ({
  subscribeToContacts: (
    _scope: unknown,
    opts: (typeof state.subs)[number]["opts"],
    deliver: (l: unknown[]) => void,
    fail: (e: Error) => void,
  ) => {
    state.subs.push({ opts, deliver, fail });
    return () => undefined;
  },
}));
// The page's other sections are unrelated to the export.
vi.mock("@/components/settings/sub-account-name-section", () => ({ SubAccountNameSection: () => null }));
vi.mock("@/components/settings/sub-account-branding-section", () => ({ SubAccountBrandingSection: () => null }));
vi.mock("@/components/settings/sub-account-contact-section", () => ({ SubAccountContactSection: () => null }));
vi.mock("@/components/settings/sub-account-phone-region-section", () => ({ SubAccountPhoneRegionSection: () => null }));
vi.mock("@/components/settings/sub-account-members-section", () => ({ SubAccountMembersSection: () => null }));
vi.mock("@/components/settings/sub-account-territories-section", () => ({ SubAccountTerritoriesSection: () => null }));
vi.mock("@/components/settings/sub-account-custom-fields-section", () => ({ SubAccountCustomFieldsSection: () => null }));
vi.mock("@/components/settings/sub-account-pipeline-section", () => ({ SubAccountPipelineSection: () => null }));
vi.mock("@/components/import/ghl-import-wizard", () => ({ GhlImportWizard: () => null }));
vi.mock("@/components/settings/sub-account-sms-section", () => ({ SubAccountSmsSection: () => null }));
vi.mock("@/components/settings/sub-account-meta-section", () => ({ SubAccountMetaSection: () => null }));
vi.mock("@/components/settings/sub-account-google-section", () => ({ SubAccountGoogleSection: () => null }));
vi.mock("@/components/settings/sub-account-whatsapp-cloud-section", () => ({ SubAccountWhatsappCloudSection: () => null }));
vi.mock("@/components/settings/sub-account-whatsapp-senders-section", () => ({ SubAccountWhatsappSendersSection: () => null }));
vi.mock("@/components/settings/sub-account-whatsapp-bridge-section", () => ({ SubAccountWhatsappBridgeSection: () => null }));
vi.mock("@/components/settings/sub-account-mailbox-section", () => ({ SubAccountMailboxSection: () => null }));
vi.mock("@/components/settings/sub-account-email-suppression-section", () => ({ SubAccountEmailSuppressionSection: () => null }));
vi.mock("@/components/settings/sub-account-email-tracking-section", () => ({ SubAccountEmailTrackingSection: () => null }));
vi.mock("@/components/settings/sub-account-smtp-section", () => ({ SubAccountSmtpSection: () => null }));
vi.mock("@/components/settings/sub-account-email-domain-section", () => ({ SubAccountEmailDomainSection: () => null }));
vi.mock("@/components/settings/sub-account-paypal-section", () => ({ SubAccountPayPalSection: () => null }));
vi.mock("@/components/settings/sub-account-plan-billing-section", () => ({ SubAccountPlanBillingSection: () => null }));
vi.mock("@/components/settings/sub-account-sending-preferences-section", () => ({ SubAccountSendingPreferencesSection: () => null }));
vi.mock("@/components/settings/sub-account-google-review-section", () => ({ SubAccountGoogleReviewSection: () => null }));
vi.mock("@/components/settings/sub-account-stripe-section", () => ({ SubAccountStripeSection: () => null }));
vi.mock("@/components/settings/sub-account-paystack-section", () => ({ SubAccountPaystackSection: () => null }));
vi.mock("@/components/settings/sub-account-webinar1-section", () => ({ SubAccountWebinar1Section: () => null }));
vi.mock("@/components/settings/sub-account-api-keys-section", () => ({ SubAccountApiKeysSection: () => null }));
vi.mock("@/components/settings/sub-account-api-recipes-section", () => ({ SubAccountApiRecipesSection: () => null }));
vi.mock("@/components/settings/sub-account-calendar-sync-section", () => ({ SubAccountCalendarSyncSection: () => null }));
vi.mock("@/components/settings/sub-account-webhooks-section", () => ({ SubAccountWebhooksSection: () => null }));

import SettingsPage from "./page";
import { ContactsProvider } from "@/context/contacts-context";

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.territory = { ready: true, filter: null };
  state.subs = [];
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const render = () =>
  act(async () =>
    root.render(createElement(ContactsProvider, null, createElement(SettingsPage))),
  );

it("a territory-scoped collaborator's filter reaches the contacts listener", async () => {
  state.territory = { ready: true, filter: ["global", "t1"] };
  await render();
  expect(state.subs).toHaveLength(1);
  expect(state.subs[0].opts.territoryFilter).toEqual(["global", "t1"]);
  await act(async () => state.subs[0].deliver([{ id: "c1" }, { id: "c2" }]));
  expect(el.textContent).toContain("2 contacts");
});

it("says contacts are loading rather than 0 contacts", async () => {
  await render();
  expect(el.textContent).toContain("Loading contacts");
  expect(el.textContent).not.toContain("0 contacts");
});

it("a failed load says so rather than 0 contacts", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await render();
  await act(async () => state.subs[0].fail(new Error("permission-denied")));
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    "Contacts could not be loaded",
  );
  expect(el.textContent).not.toContain("0 contacts");
});
