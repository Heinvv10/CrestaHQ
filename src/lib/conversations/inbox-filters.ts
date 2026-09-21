import { toDate } from "@/lib/format";
import type {
  ConversationChannel,
  ConversationDoc,
} from "@/types/conversations";

/**
 * Pure inbox filtering for the Conversations list (SP2 I2–I4, I8). The list
 * is the sub-account's full live conversation index, so every filter here is
 * client-side over rows already in memory — no new query shapes.
 *
 * Filter state (minus the free-text search) round-trips through the URL
 * query, so it survives opening a thread and a reload.
 */

export type InboxTab = "unread" | "all" | "starred";
/** Keyed on `conversation.assigneeUid` vs the signed-in user's uid. */
export type InboxScope = "all" | "mine" | "unassigned";
export type InboxSort = "newest" | "oldest";
export type InboxDirection = "inbound" | "outbound";

export interface InboxFilters {
  tab: InboxTab;
  scope: InboxScope;
  /** Matches `lastChannel`; null = any channel. */
  channel: ConversationChannel | null;
  /** Matches `lastDirection` ("inbound" = awaiting reply); null = any. */
  direction: InboxDirection | null;
  sort: InboxSort;
}

export const INBOX_TABS: InboxTab[] = ["unread", "all", "starred"];
export const INBOX_SCOPES: InboxScope[] = ["all", "mine", "unassigned"];
export const INBOX_CHANNELS: ConversationChannel[] = [
  "email",
  "sms",
  "whatsapp",
  "messenger",
  "instagram",
  "web-chat",
];
const DIRECTIONS: InboxDirection[] = ["inbound", "outbound"];
const SORTS: InboxSort[] = ["newest", "oldest"];

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  tab: "all",
  scope: "all",
  channel: null,
  direction: null,
  sort: "newest",
};

function pick<T extends string>(value: string | null, allowed: T[]): T | null {
  return value !== null && (allowed as string[]).includes(value)
    ? (value as T)
    : null;
}

/** Read filters from a URL query. Unknown values fall back to the default. */
export function parseInboxFilters(params: {
  get(key: string): string | null;
}): InboxFilters {
  return {
    tab: pick(params.get("tab"), INBOX_TABS) ?? DEFAULT_INBOX_FILTERS.tab,
    scope:
      pick(params.get("scope"), INBOX_SCOPES) ?? DEFAULT_INBOX_FILTERS.scope,
    channel: pick(params.get("channel"), INBOX_CHANNELS),
    direction: pick(params.get("direction"), DIRECTIONS),
    sort: pick(params.get("sort"), SORTS) ?? DEFAULT_INBOX_FILTERS.sort,
  };
}

/** Serialize filters to a query string, omitting defaults ("" when all default). */
export function inboxFiltersToQuery(f: InboxFilters): string {
  const q = new URLSearchParams();
  if (f.tab !== DEFAULT_INBOX_FILTERS.tab) q.set("tab", f.tab);
  if (f.scope !== DEFAULT_INBOX_FILTERS.scope) q.set("scope", f.scope);
  if (f.channel) q.set("channel", f.channel);
  if (f.direction) q.set("direction", f.direction);
  if (f.sort !== DEFAULT_INBOX_FILTERS.sort) q.set("sort", f.sort);
  return q.toString();
}

/**
 * Decide whether a URL query the pane observes is an echo of its own write or
 * a navigation from outside (sidebar link, notification, manual edit).
 * `pending` is every query the pane has written that the URL has not yet
 * caught up with, oldest first. An echo drops itself and everything older (a
 * router may skip intermediate replaces); anything else is external and is
 * adopted, discarding the pending writes it overrides. Adopting a stale echo
 * would revert the operator's newer change — the race this exists to avoid.
 */
export function reconcileUrlQuery(
  urlQuery: string,
  pending: string[]
): { adopt: boolean; pending: string[] } {
  const idx = pending.indexOf(urlQuery);
  if (idx >= 0) return { adopt: false, pending: pending.slice(idx + 1) };
  return { adopt: true, pending: [] };
}

/**
 * Whether a filter change needs a URL write. The comparison is against where
 * the URL is heading — the newest pending write, else the current query. A
 * write equal to it causes no searchParams change, so its pending entry would
 * never be consumed and a later external navigation to that same query would
 * be mistaken for an echo and dropped.
 */
export function planQueryWrite(
  qs: string,
  urlQuery: string,
  pending: string[]
): { write: boolean; pending: string[] } {
  const target = pending.length > 0 ? pending[pending.length - 1] : urlQuery;
  if (qs === target) return { write: false, pending };
  return { write: true, pending: [...pending, qs] };
}

function isUnread(c: ConversationDoc): boolean {
  return (c.unreadCount ?? 0) > 0;
}

function matchesTab(c: ConversationDoc, tab: InboxTab): boolean {
  if (tab === "unread") return isUnread(c);
  if (tab === "starred") return c.starred === true;
  return true;
}

/**
 * Every filter except the tab: scope, channel, direction and search. The tab
 * badge counts are taken over this set, so "Unread 3" means three of the rows
 * the operator is currently scoped to.
 */
function applyNonTabFilters(
  list: ConversationDoc[],
  f: InboxFilters,
  uid: string | null,
  search: string
): ConversationDoc[] {
  const q = search.trim().toLowerCase();
  return list.filter((c) => {
    if (f.scope === "mine" && (!uid || c.assigneeUid !== uid)) return false;
    if (f.scope === "unassigned" && c.assigneeUid) return false;
    if (f.channel && c.lastChannel !== f.channel) return false;
    if (f.direction && c.lastDirection !== f.direction) return false;
    if (!q) return true;
    return (
      (c.contactName ?? "").toLowerCase().includes(q) ||
      (c.contactPhone ?? "").toLowerCase().includes(q) ||
      // I9: the address, mirrored onto the row by the upserts.
      (c.contactEmail ?? "").toLowerCase().includes(q)
    );
  });
}

function millis(c: ConversationDoc): number {
  return toDate(c.lastMessageAt)?.getTime() ?? 0;
}

export function sortConversations(
  list: ConversationDoc[],
  sort: InboxSort
): ConversationDoc[] {
  const sign = sort === "oldest" ? 1 : -1;
  return [...list].sort((a, b) => sign * (millis(a) - millis(b)));
}

export interface InboxView {
  rows: ConversationDoc[];
  counts: Record<InboxTab, number>;
}

/**
 * Filtered + sorted rows for the active tab, plus a count per tab. The open
 * conversation (`activeId`) is exempt from the TAB test only: opening a row
 * from Unread marks it read, and without the exemption it would vanish from
 * under the operator. Scope / channel / direction / search still apply.
 */
export function buildInboxView(
  list: ConversationDoc[],
  f: InboxFilters,
  uid: string | null,
  search: string,
  activeId: string | null = null
): InboxView {
  const scoped = applyNonTabFilters(list, f, uid, search);
  const counts = {
    unread: scoped.filter((c) => matchesTab(c, "unread")).length,
    all: scoped.length,
    starred: scoped.filter((c) => matchesTab(c, "starred")).length,
  };
  const rows = sortConversations(
    scoped.filter((c) => matchesTab(c, f.tab) || c.id === activeId),
    f.sort
  );
  return { rows, counts };
}
