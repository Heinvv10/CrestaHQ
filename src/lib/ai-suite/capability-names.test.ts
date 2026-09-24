import { describe, expect, it, vi } from "vitest";

/**
 * Locks the registry's exact contents, in order. The order is the tool order
 * the model sees, and the level / requiredRole / readonly / surfaces columns
 * are the permission surface — so moving capabilities between files must
 * leave this table untouched. Adding or removing a capability, or changing
 * where one is offered, means editing this table on purpose.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { AI_SUITE_CAPABILITIES } = await import("./capabilities");

// [name, level, requiredRole, readonly, surfaces (null = every surface)]
const EXPECTED: Array<[string, string, string, boolean, string[] | null]> = [
  ["list_sub_accounts",                         "agency",      "agencyOwner",      true, null],
  ["sub_account_stats",                         "agency",      "agencyOwner",      true, null],
  ["set_feature_gate",                          "agency",      "agencyOwner",      false, null],
  ["create_sub_account",                        "agency",      "agencyOwner",      false, null],
  ["list_billing_plans",                        "agency",      "agencyOwner",      true, null],
  ["create_billing_plan",                       "agency",      "agencyOwner",      false, null],
  ["assign_billing_plan",                       "agency",      "agencyOwner",      false, null],
  ["create_one_time_charge",                    "agency",      "agencyOwner",      false, null],
  ["my_access",                                 "sub-account", "subAccountMember", true, ["chat"]],
  ["open_workspace",                            "sub-account", "subAccountMember", true, ["chat"]],
  ["find_contacts",                             "sub-account", "subAccountMember", true, null],
  ["workspace_stats",                           "sub-account", "subAccountMember", true, null],
  ["find_deals",                                "sub-account", "subAccountMember", true, null],
  ["create_deal",                               "sub-account", "subAccountMember", false, null],
  ["move_deal_stage",                           "sub-account", "subAccountMember", false, null],
  ["list_webhooks",                             "sub-account", "subAccountAdmin",  true, null],
  ["create_webhook",                            "sub-account", "subAccountAdmin",  false, ["chat"]],
  ["send_webhook_test",                         "sub-account", "subAccountAdmin",  false, ["chat"]],
  ["update_webhook_url",                        "sub-account", "subAccountAdmin",  false, ["chat"]],
  ["create_community",                          "sub-account", "subAccountAdmin",  false, ["chat"]],
  ["create_workflow",                           "sub-account", "subAccountAdmin",  false, null],
  ["create_contact",                            "sub-account", "subAccountMember", false, null],
  ["create_task",                               "sub-account", "subAccountMember", false, null],
  ["find_tasks",                                "sub-account", "subAccountMember", true, null],
  ["complete_task",                             "sub-account", "subAccountMember", false, null],
  ["find_events",                               "sub-account", "subAccountMember", true, null],
  ["create_event",                              "sub-account", "subAccountMember", false, null],
  ["list_members",                              "sub-account", "subAccountAdmin",  true, null],
  ["invite_member",                             "sub-account", "subAccountAdmin",  false, ["chat"]],
  ["research_website_reference",                "sub-account", "subAccountAdmin",  true, ["chat"]],
  ["get_website_prefill",                       "sub-account", "subAccountAdmin",  true, ["chat"]],
  ["create_website",                            "sub-account", "subAccountAdmin",  false, ["chat"]],
  ["check_website_status",                      "sub-account", "subAccountMember", true, ["chat"]],
  ["find_contacts_in_sub_account",              "agency",      "agencyOwner",      true, null],
  ["find_deals_in_sub_account",                 "agency",      "agencyOwner",      true, null],
  ["find_tasks_in_sub_account",                 "agency",      "agencyOwner",      true, null],
  ["find_events_in_sub_account",                "agency",      "agencyOwner",      true, null],
  ["workspace_stats_in_sub_account",            "agency",      "agencyOwner",      true, null],
  ["list_webhooks_in_sub_account",              "agency",      "agencyOwner",      true, null],
  ["list_members_in_sub_account",               "agency",      "agencyOwner",      true, null],
  ["create_contact_in_sub_account",             "agency",      "agencyOwner",      false, null],
  ["create_task_in_sub_account",                "agency",      "agencyOwner",      false, null],
  ["complete_task_in_sub_account",              "agency",      "agencyOwner",      false, null],
  ["create_deal_in_sub_account",                "agency",      "agencyOwner",      false, null],
  ["move_deal_stage_in_sub_account",            "agency",      "agencyOwner",      false, null],
  ["create_event_in_sub_account",               "agency",      "agencyOwner",      false, null],
  ["create_workflow_in_sub_account",            "agency",      "agencyOwner",      false, null],
  ["create_webhook_in_sub_account",             "agency",      "agencyOwner",      false, ["chat"]],
  ["send_webhook_test_in_sub_account",          "agency",      "agencyOwner",      false, ["chat"]],
  ["update_webhook_url_in_sub_account",         "agency",      "agencyOwner",      false, ["chat"]],
  ["create_community_in_sub_account",           "agency",      "agencyOwner",      false, ["chat"]],
  ["invite_member_in_sub_account",              "agency",      "agencyOwner",      false, ["chat"]],
  ["get_website_prefill_in_sub_account",        "agency",      "agencyOwner",      true, ["chat"]],
  ["research_website_reference_in_sub_account", "agency",      "agencyOwner",      true, ["chat"]],
  ["create_website_in_sub_account",             "agency",      "agencyOwner",      false, ["chat"]],
  ["check_website_status_in_sub_account",       "agency",      "agencyOwner",      true, ["chat"]],
];

describe("AI Suite capability registry", () => {
  it("exposes exactly these capability names, in this order", () => {
    expect(AI_SUITE_CAPABILITIES.map((c) => c.name)).toEqual(
      EXPECTED.map(([name]) => name)
    );
  });

  it("keeps each capability's level, requiredRole, readonly and surfaces", () => {
    expect(
      AI_SUITE_CAPABILITIES.map((c) => [
        c.name,
        c.level,
        c.requiredRole,
        c.readonly === true,
        c.surfaces ?? null,
      ])
    ).toEqual(EXPECTED);
  });
});
