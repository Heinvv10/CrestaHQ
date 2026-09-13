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
      (c.contactPhone ?? "").toLowerCase().includes(q)
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

/** Filtered + sorted rows for the active tab, plus a count per tab. */
export function buildInboxView(
  list: ConversationDoc[],
  f: InboxFilters,
  uid: string | null,
  search: string
): InboxView {
  const scoped = applyNonTabFilters(list, f, uid, search);
  const counts = {
    unread: scoped.filter((c) => matchesTab(c, "unread")).length,
    all: scoped.length,
    starred: scoped.filter((c) => matchesTab(c, "starred")).length,
  };
  const rows = sortConversations(
    scoped.filter((c) => matchesTab(c, f.tab)),
    f.sort
  );
  return { rows, counts };
}
