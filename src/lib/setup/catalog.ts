/**
 * Typed TypeScript view over the framework-agnostic env catalog defined in
 * `env-schema.mjs`. The `.mjs` is the single source of truth (shared with the
 * `pnpm doctor` CLI, which runs under bare node); this module just gives the
 * Next.js side stable types and a couple of app-facing helpers.
 */

import {
  GROUPS as RAW_GROUPS,
  KNOWN_KEYS as RAW_KNOWN_KEYS,
  NON_WRITABLE_KEYS as RAW_NON_WRITABLE_KEYS,
  validateVar as rawValidateVar,
  isPresent as rawIsPresent,
  evaluateGroup as rawEvaluateGroup,
} from "./env-schema.mjs";

export type VarLevel = "req" | "rec" | "opt";
export type GroupTier = "boot" | "feature" | "preflight";

/** [name, level, optional shape validator]. */
export type VarTuple = [string, VarLevel, ((v: string) => string | null)?];

export interface EnvGroup {
  title: string;
  tier: GroupTier;
  off?: string;
  independent?: boolean;
  /**
   * When set, this group belongs to a single landing variant (e.g.
   * "leadstack") and is hidden from the setup form + doctor on any other
   * deployment. Undefined = shown everywhere. The catalog stays
   * variant-agnostic; the consumer that knows the active variant filters.
   */
  variant?: string;
  vars: VarTuple[];
  deep?: (
    add: (level: string, msg: string) => void,
    env: { has: (k: string) => boolean; val: (k: string) => string },
  ) => void;
}

export const GROUPS = RAW_GROUPS as unknown as EnvGroup[];
export const KNOWN_KEYS = RAW_KNOWN_KEYS as unknown as string[];
export const NON_WRITABLE_KEYS = RAW_NON_WRITABLE_KEYS as unknown as Set<string>;

/** Warning string when a value looks malformed for `name`, else null. */
export function validateVar(name: string, value: string): string | null {
  return rawValidateVar(name, value) as string | null;
}

/** True when a raw value is present, non-blank, and not a placeholder. */
export function isPresent(value: string | undefined): boolean {
  return rawIsPresent(value) as boolean;
}

/** A var is writable via the setup form unless it's a preflight prerequisite. */
export function isWritableKey(name: string): boolean {
  return KNOWN_KEYS.includes(name) && !NON_WRITABLE_KEYS.has(name);
}

/** Group status as computed by the shared doctor/setup-form logic. */
export type GroupStatus = "ok" | "check" | "off" | "error";

export interface GroupEvaluation {
  status: GroupStatus;
  notes: { level: string; msg: string }[];
  missingReq: string[];
  missingRec: string[];
  reqPresent: number;
  reqTotal: number;
}

/**
 * Evaluate one group's status against a value getter (typed view over the
 * shared implementation `pnpm doctor` uses, so both agree on ✓ / ⚠ / ○ / ✗).
 */
export function evaluateGroup(
  group: EnvGroup,
  getValue: (name: string) => string | undefined,
): GroupEvaluation {
  return rawEvaluateGroup(group, getValue) as GroupEvaluation;
}

/**
 * The landing variant a key is scoped to, or null when it's shown on every
 * deployment. Callers compare this against the active `LANDING_VARIANT` to
 * decide whether to surface / accept the key.
 */
export function keyVariant(name: string): string | null {
  for (const g of GROUPS) {
    if (g.vars.some((v) => v[0] === name)) return g.variant ?? null;
  }
  return null;
}
