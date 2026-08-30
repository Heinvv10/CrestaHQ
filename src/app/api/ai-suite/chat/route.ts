import "server-only";

import { NextResponse } from "next/server";
import {
  requireAgencyOwnerAny,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  aiSuiteIsConfigured,
  aiSuiteModel,
  normalizeAiSuiteModelChoice,
  runAiSuiteTurn,
  type AiSuiteLlmMessage,
} from "@/lib/ai-suite/model";
import { recordAiSuiteUsage } from "@/lib/ai-suite/usage";
import { retrieveKnowledge } from "@/lib/ai-suite/retrieve";
import { buildAiSuiteSystemPrompt } from "@/lib/ai-suite/prompt";
import {
  CapabilityUserError,
  capabilityNamesForLevel,
  getCapability,
  roleSatisfies,
  toolsForLevel,
  type AiSuiteActionContext,
} from "@/lib/ai-suite/capabilities";
import { CUSTOM_BRAND } from "@/config/landing";
import type {
  AiSuiteChatMessage,
  AiSuiteChatRequest,
  AiSuiteChatResponse,
  AiSuiteLevel,
} from "@/types/ai-suite";

export const dynamic = "force-dynamic";

const MAX_HISTORY_TURNS = 12;
const MAX_MESSAGE_CHARS = 4000;
/** Max read-only lookups the model may chain in one user turn. */
const MAX_LOOKUP_HOPS = 3;
/**
 * Max self-correction rounds when the model proposes a write with invalid
 * args (e.g. a hero statement over the 80-char cap). The validation error
 * goes back as a tool result so the model can fix the args itself instead
 * of bouncing a constraint the user never typed back at them.
 */
const MAX_VALIDATION_RETRIES = 2;

function sanitizeMessages(input: unknown): AiSuiteChatMessage[] | null {
  if (!Array.isArray(input)) return null;
  const cleaned: AiSuiteChatMessage[] = [];
  for (const m of input) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    cleaned.push({ role, content: trimmed.slice(0, MAX_MESSAGE_CHARS) });
  }
  return cleaned.slice(-MAX_HISTORY_TURNS);
}

type RoleCtx = { agencyRoleIsOwner: boolean; subAccountRole?: string };

export async function POST(request: Request) {
  let body: AiSuiteChatRequest;
  try {
    body = (await request.json()) as AiSuiteChatRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const level = body.level;
  if (level !== "agency" && level !== "sub-account") {
    return NextResponse.json(
      { error: "`level` must be 'agency' or 'sub-account'." },
      { status: 400 },
    );
  }

  // ── Auth + (for sub-accounts) the agency gate. The route decides who can
  // act here — never the model.
  let roleCtx: RoleCtx;
  let actionCtx: AiSuiteActionContext;
  let usageAgencyId = "";
  let workspaceName = "";
  // OpenRouter slug for this conversation. Each level carries its own
  // agency-owner-picked tier ("opus" | "sonnet", default opus) on the doc
  // we already load for the gate check — resolved once here, used every turn.
  let turnModel = aiSuiteModel();
  if (level === "sub-account") {
    if (!body.subAccountId || typeof body.subAccountId !== "string") {
      return NextResponse.json(
        { error: "`subAccountId` is required for sub-account level." },
        { status: 400 },
      );
    }
    const access = await requireSubAccountMember(request, body.subAccountId);
    if (access instanceof NextResponse) return access;

    const subSnap = await getAdminDb()
      .doc(`subAccounts/${body.subAccountId}`)
      .get();
    // Opt-in gate: the Workspace Assistant is OFF unless the agency owner
    // explicitly enabled it for this sub-account (legacy/unset reads as off).
    if (subSnap.data()?.aiSuiteEnabledByAgency !== true) {
      return NextResponse.json(
        {
          error:
            "The AI Suite is disabled for this sub-account. Ask your agency owner to enable it.",
        },
        { status: 403 },
      );
    }
    workspaceName =
      typeof subSnap.data()?.name === "string" ? subSnap.data()!.name : "";
    turnModel = aiSuiteModel(
      normalizeAiSuiteModelChoice(subSnap.data()?.aiSuiteModel),
    );
    roleCtx = {
      agencyRoleIsOwner: access.subAccountRole === "agencyOwner",
      subAccountRole: access.subAccountRole,
    };
    actionCtx = {
      uid: access.uid,
      email: access.email,
      displayName: "",
      agencyId: access.agencyId ?? "",
      subAccountId: body.subAccountId,
      subAccountRole: access.subAccountRole,
    };
    usageAgencyId = access.agencyId ?? "";
  } else {
    const owner = await requireAgencyOwnerAny(request);
    if (owner instanceof NextResponse) return owner;
    // Master switch: the Agency Assistant is OFF unless the owner enabled it
    // under Agency → Settings (legacy/unset reads as off).
    const agencySnap = await getAdminDb()
      .doc(`agencies/${owner.agencyId}`)
      .get();
    if (agencySnap.data()?.agencyAssistantEnabled !== true) {
      return NextResponse.json(
        {
          error:
            "The Agency Assistant is turned off. Enable it under Agency → Settings.",
        },
        { status: 403 },
      );
    }
    turnModel = aiSuiteModel(
      normalizeAiSuiteModelChoice(agencySnap.data()?.agencyAssistantModel),
    );
    roleCtx = { agencyRoleIsOwner: true };
    actionCtx = {
      uid: owner.uid,
      email: owner.email,
      displayName: "",
      agencyId: owner.agencyId ?? "",
    };
    usageAgencyId = owner.agencyId ?? "";
  }

  if (!aiSuiteIsConfigured()) {
    return NextResponse.json(
      {
        error:
          "The AI Suite isn't configured on this deployment. Set OPENROUTER_API_KEY to enable it.",
      },
      { status: 503 },
    );
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages || messages.length === 0) {
    return NextResponse.json(
      { error: "At least one message is required." },
      { status: 400 },
    );
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return NextResponse.json(
      { error: "The latest turn must include a user message." },
      { status: 400 },
    );
  }

  const lvl = level as AiSuiteLevel;
  const tools = toolsForLevel(lvl, roleCtx);
  const { actions: actionNames, lookups: lookupNames } =
    capabilityNamesForLevel(lvl, roleCtx);

  // Retrieve over the recent turns, not just the last message, so a
  // follow-up like "how do I turn that on?" still pulls the cards for the
  // feature named earlier. The latest question is included twice so it
  // dominates the keyword scoring.
  const recentUsers = messages.filter((m) => m.role === "user").slice(-2);
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const retrievalQuery = [
    ...recentUsers.map((m) => m.content),
    lastAssistant?.content ?? "",
    lastUser.content,
  ]
    .filter(Boolean)
    .join("\n");
  const cards = retrieveKnowledge(retrievalQuery, lvl);

  const systemPrompt = buildAiSuiteSystemPrompt({
    level: lvl,
    brandName: CUSTOM_BRAND.name || "your CRM",
    cards,
    actionNames,
    lookupNames,
    todayIso: new Date().toISOString().slice(0, 10),
    caller: {
      email: actionCtx.email,
      isAgencyOwner: roleCtx.agencyRoleIsOwner,
      ...(lvl === "sub-account"
        ? { workspaceName, workspaceRole: actionCtx.subAccountRole }
        : {}),
    },
    deployment: {
      // Push notifications need BOTH VAPID keys — the public one (client
      // subscribes) and the private one (server sends). Missing either means
      // notifications can't work, so the assistant should say so honestly.
      pushNotificationsConfigured: Boolean(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() &&
          process.env.VAPID_PRIVATE_KEY?.trim(),
      ),
    },
  });

  const llmMessages: AiSuiteLlmMessage[] = [
    // Stable half carries the prompt-cache breakpoint; the per-turn half
    // (cards + date) rides behind it so retrieval changes don't bust the
    // cached prefix. See buildAiSuiteSystemPrompt / runAiSuiteTurn.
    {
      role: "system",
      content: systemPrompt.stable,
      dynamicTail: systemPrompt.dynamic,
    },
    ...messages,
  ];

  // Run the turn, executing read-only lookups inline (their results go back
  // to the model as tool messages) until the model produces either text or a
  // confirm-gated write proposal. Writes are NEVER executed here — but a
  // write whose args fail validation gets the error back as a tool result
  // so the model can self-correct (shorten an over-limit field, run a
  // lookup it skipped, or ask the user in its own words).
  let turn;
  try {
    let lookupHops = 0;
    let fixAttempts = 0;
    for (;;) {
      turn = await runAiSuiteTurn({
        messages: llmMessages,
        tools,
        model: turnModel,
      });
      const call = turn.toolCall;
      if (!call) break;
      const cap = getCapability(call.name);
      if (!cap || cap.level !== lvl) break;

      // ── Write action: validate only. Valid → fall through to the proposal
      // path below. Invalid → bounce the error back to the model (capped).
      if (!cap.readonly) {
        const check = cap.validate(call.args);
        if (check.ok || fixAttempts >= MAX_VALIDATION_RETRIES) break;
        fixAttempts++;
        llmMessages.push(
          {
            role: "assistant",
            content: turn.text,
            tool_calls: [
              {
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: call.id,
            content: `Invalid arguments — nothing was proposed to the user: ${check.error}. Fix the arguments and call the tool again. Only ask the user when the fix needs information you don't have.`,
          },
        );
        continue;
      }

      // ── Read-only lookup: execute inline (capped).
      if (
        lookupHops >= MAX_LOOKUP_HOPS ||
        !roleSatisfies(cap.requiredRole, roleCtx)
      ) {
        break; // over budget / not allowed — fall through, treated as text
      }
      lookupHops++;
      const validated = cap.validate(call.args);
      let lookupResult: string;
      if (!validated.ok) {
        lookupResult = `Invalid arguments: ${validated.error}.`;
      } else {
        try {
          const execResult = await cap.execute(actionCtx, validated.args);
          // A lookup that resolved a navigation target short-circuits: show
          // the user the message + button directly (no final model turn).
          if (execResult.navigate) {
            void recordAiSuiteUsage({
              level: lvl,
              agencyId: usageAgencyId,
              subAccountId:
                level === "sub-account" ? body.subAccountId : undefined,
              kind: "message",
            });
            const response: AiSuiteChatResponse = {
              type: "navigate",
              text: execResult.resultText,
              href: execResult.navigate.href,
              label: execResult.navigate.label,
            };
            return NextResponse.json(response);
          }
          lookupResult = execResult.resultText;
        } catch (err) {
          console.error(
            `[ai-suite/chat] lookup ${cap.name} failed:`,
            err instanceof Error ? err.message : err,
          );
          lookupResult =
            err instanceof CapabilityUserError
              ? `The lookup couldn't run: ${err.message}`
              : "The lookup failed. Answer without it, and say the data couldn't be checked.";
        }
      }
      llmMessages.push(
        {
          role: "assistant",
          content: turn.text,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        },
        { role: "tool", tool_call_id: call.id, content: lookupResult },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[ai-suite/chat] model call failed:", msg);
    return NextResponse.json(
      { error: "The assistant couldn't reach the model. Please try again." },
      { status: 502 },
    );
  }

  // Count this turn toward daily usage (best-effort; never blocks the reply).
  void recordAiSuiteUsage({
    level: lvl,
    agencyId: usageAgencyId,
    subAccountId: level === "sub-account" ? body.subAccountId : undefined,
    kind: "message",
  });

  // Did the model request a write action? Validate it and surface a
  // proposal — nothing executes here. (A readonly call landing here means
  // the lookup hop cap was hit — treat it as text, never as a proposal.)
  if (turn.toolCall) {
    const cap = getCapability(turn.toolCall.name);
    if (cap && !cap.readonly && cap.level === lvl) {
      const validated = cap.validate(turn.toolCall.args);
      if (validated.ok) {
        const response: AiSuiteChatResponse = {
          type: "proposal",
          proposal: {
            id: turn.toolCall.id,
            capability: cap.name,
            // The RAW model args, not validated.args — the confirm route
            // re-runs validate() on whatever the client sends back, and a
            // validate() that transforms keys (create_website reads
            // snake_case, returns camelCase) would reject its own output.
            // Carrying the raw shape makes the round-trip idempotent by
            // construction for every capability.
            args: turn.toolCall.args,
            summary: cap.summarize(validated.args),
          },
        };
        return NextResponse.json(response);
      }
      // Still invalid after the self-correction rounds — ask, don't propose.
      const response: AiSuiteChatResponse = {
        type: "message",
        text: `I can help with that, but ${validated.error}. Could you tell me?`,
      };
      return NextResponse.json(response);
    }
  }

  const response: AiSuiteChatResponse = {
    type: "message",
    text:
      turn.text ||
      "I'm not sure how to help with that — could you rephrase, or ask how a feature works?",
  };
  return NextResponse.json(response);
}
