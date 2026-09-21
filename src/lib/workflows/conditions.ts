import "server-only";

// The evaluator itself lives in `@/lib/contacts/conditions` so the contacts
// list can run it in the browser. This module keeps the server-only import
// surface every engine caller and test already uses.
export {
  REPLY_TEXT_FIELD,
  evalConditionGroup,
  type ConditionContext,
} from "@/lib/contacts/conditions";
