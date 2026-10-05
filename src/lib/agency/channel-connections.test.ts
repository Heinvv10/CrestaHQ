import { describe, expect, it } from "vitest";
import { CHANNEL_CONNECTION_FIELDS, hasChannelConnection } from "./channel-connections";

/**
 * `hasChannelConnection` (AGENCY_AGENT_API_PLAN.md D3, A4a-1): one predicate
 * over every channel / payment connection stored on the sub-account doc,
 * shared by "key-created" and the A6 teardown guard. A doc as creation
 * writes it has none; each field alone is a connection.
 */

/** The connection fields exactly as `createSubAccountForAgency` writes them. */
const FRESH = {
  twilioConfig: null,
  resendConfig: null,
  stripeConnectionMeta: null,
  webinar1ConnectionMeta: null,
  metaConfig: null,
  agentApiEnabledByAgency: true,
  apiAccessEnabledByAgency: true,
};

const CONNECTED: Record<string, unknown> = {
  twilioConfig: { accountSid: "AC1", phoneNumber: "+27100000000" },
  resendConfig: { domainId: "d1", domain: "mail.example.com", status: "pending" },
  smtpConfig: { host: "smtp.example.com", port: 587, fromEmail: "a@example.com" },
  metaConfig: { pageId: "p1" },
  whatsappCloudMeta: { phoneNumberId: "pn1" },
  whatsappBridgeMeta: { jid: "27100000000@s.whatsapp.net" },
  whatsappSenders: [{ phoneNumber: "+27100000000" }],
  googleConnectionMeta: { email: "owner@example.com" },
  stripeConnectionMeta: { accountId: "acct_1" },
  paystackConnectionMeta: { mode: "live" },
  paypalConfig: { clientId: "pp1" },
  webinar1ConnectionMeta: { baseUrl: "https://webinar.example.com" },
  apexgeoConnected: true,
  mailboxConfig: { host: "imap.example.com", port: 993, username: "a@example.com" },
  ghlImportConfig: { locationId: "loc1", connectedByUid: "owner1" },
};

describe("hasChannelConnection", () => {
  it("a sub-account as creation writes it (and an empty doc) has none", () => {
    expect(hasChannelConnection(FRESH)).toBe(false);
    expect(hasChannelConnection({})).toBe(false);
    expect(hasChannelConnection(undefined)).toBe(false);
  });

  it("every named field is covered by a case below, and no case names an unlisted field", () => {
    expect(Object.keys(CONNECTED).sort()).toEqual([...CHANNEL_CONNECTION_FIELDS].sort());
  });

  it.each(Object.entries(CONNECTED))("%s alone is a connection", (field, value) => {
    expect(hasChannelConnection({ ...FRESH, [field]: value })).toBe(true);
  });

  it("an emptied sender list and a disconnected ApexGEO flag are not", () => {
    expect(hasChannelConnection({ ...FRESH, whatsappSenders: [] })).toBe(false);
    expect(hasChannelConnection({ ...FRESH, apexgeoConnected: false })).toBe(false);
    expect(hasChannelConnection({ ...FRESH, smtpConfig: null, paypalConfig: null })).toBe(false);
  });
});
