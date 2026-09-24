import { describe, expect, it, vi } from "vitest";

/**
 * Locks the registry's exact contents, in order. The order is the tool order
 * the model sees, and the level / requiredRole / readonly columns are the
 * permission surface — so moving capabilities between files (or adding the
 * agent-surface seams) must leave this table untouched. Adding or removing a
 * capability means editing this table on purpose.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { AI_SUITE_CAPABILITIES } = await import("./capabilities");

// [name, level, requiredRole, readonly]
const EXPECTED: Array<[string, string, string, boolean]> = [
  ["list_sub_accounts",                         "agency",      "agencyOwner",      true],
  ["sub_account_stats",                         "agency",      "agencyOwner",      true],
  ["set_feature_gate",                          "agency",      "agencyOwner",      false],
  ["create_sub_account",                        "agency",      "agencyOwner",      false],
  ["list_billing_plans",                        "agency",      "agencyOwner",      true],
  ["create_billing_plan",                       "agency",      "agencyOwner",      false],
  ["assign_billing_plan",                       "agency",      "agencyOwner",      false],
  ["create_one_time_charge",                    "agency",      "agencyOwner",      false],
  ["my_access",                                 "sub-account", "subAccountMember", true],
  ["open_workspace",                            "sub-account", "subAccountMember", true],
  ["find_contacts",                             "sub-account", "subAccountMember", true],
  ["workspace_stats",                           "sub-account", "subAccountMember", true],
  ["find_deals",                                "sub-account", "subAccountMember", true],
  ["create_deal",                               "sub-account", "subAccountMember", false],
  ["move_deal_stage",                           "sub-account", "subAccountMember", false],
  ["list_webhooks",                             "sub-account", "subAccountAdmin",  true],
  ["create_webhook",                            "sub-account", "subAccountAdmin",  false],
  ["send_webhook_test",                         "sub-account", "subAccountAdmin",  false],
  ["update_webhook_url",                        "sub-account", "subAccountAdmin",  false],
  ["create_community",                          "sub-account", "subAccountAdmin",  false],
  ["create_workflow",                           "sub-account", "subAccountAdmin",  false],
  ["create_contact",                            "sub-account", "subAccountMember", false],
  ["create_task",                               "sub-account", "subAccountMember", false],
  ["find_tasks",                                "sub-account", "subAccountMember", true],
  ["complete_task",                             "sub-account", "subAccountMember", false],
  ["find_events",                               "sub-account", "subAccountMember", true],
  ["create_event",                              "sub-account", "subAccountMember", false],
  ["list_members",                              "sub-account", "subAccountAdmin",  true],
  ["invite_member",                             "sub-account", "subAccountAdmin",  false],
  ["research_website_reference",                "sub-account", "subAccountAdmin",  true],
  ["get_website_prefill",                       "sub-account", "subAccountAdmin",  true],
  ["create_website",                            "sub-account", "subAccountAdmin",  false],
  ["check_website_status",                      "sub-account", "subAccountMember", true],
  ["find_contacts_in_sub_account",              "agency",      "agencyOwner",      true],
  ["find_deals_in_sub_account",                 "agency",      "agencyOwner",      true],
  ["find_tasks_in_sub_account",                 "agency",      "agencyOwner",      true],
  ["find_events_in_sub_account",                "agency",      "agencyOwner",      true],
  ["workspace_stats_in_sub_account",            "agency",      "agencyOwner",      true],
  ["list_webhooks_in_sub_account",              "agency",      "agencyOwner",      true],
  ["list_members_in_sub_account",               "agency",      "agencyOwner",      true],
  ["create_contact_in_sub_account",             "agency",      "agencyOwner",      false],
  ["create_task_in_sub_account",                "agency",      "agencyOwner",      false],
  ["complete_task_in_sub_account",              "agency",      "agencyOwner",      false],
  ["create_deal_in_sub_account",                "agency",      "agencyOwner",      false],
  ["move_deal_stage_in_sub_account",            "agency",      "agencyOwner",      false],
  ["create_event_in_sub_account",               "agency",      "agencyOwner",      false],
  ["create_workflow_in_sub_account",            "agency",      "agencyOwner",      false],
  ["create_webhook_in_sub_account",             "agency",      "agencyOwner",      false],
  ["send_webhook_test_in_sub_account",          "agency",      "agencyOwner",      false],
  ["update_webhook_url_in_sub_account",         "agency",      "agencyOwner",      false],
  ["create_community_in_sub_account",           "agency",      "agencyOwner",      false],
  ["invite_member_in_sub_account",              "agency",      "agencyOwner",      false],
  ["get_website_prefill_in_sub_account",        "agency",      "agencyOwner",      true],
  ["research_website_reference_in_sub_account", "agency",      "agencyOwner",      true],
  ["create_website_in_sub_account",             "agency",      "agencyOwner",      false],
  ["check_website_status_in_sub_account",       "agency",      "agencyOwner",      true],
];

describe("AI Suite capability registry", () => {
  it("exposes exactly these capability names, in this order", () => {
    expect(AI_SUITE_CAPABILITIES.map((c) => c.name)).toEqual(
      EXPECTED.map(([name]) => name)
    );
  });

  it("keeps each capability's level, requiredRole and readonly", () => {
    expect(
      AI_SUITE_CAPABILITIES.map((c) => [
        c.name,
        c.level,
        c.requiredRole,
        c.readonly === true,
      ])
    ).toEqual(EXPECTED);
  });
});
