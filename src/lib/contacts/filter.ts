import { evalConditionGroup } from "@/lib/contacts/conditions";
import type { Contact } from "@/types/contacts";
import type { ConditionGroup } from "@/types/workflows";

export const EMPTY_FILTERS: ConditionGroup = { all: [] };

/**
 * Client-side filter for the contacts list. Runs the workflow evaluator over
 * the live contact array; an empty (or absent) group returns the input
 * untouched so "All" costs nothing.
 */
export function applyFilters(
  contacts: Contact[],
  group: ConditionGroup | undefined,
): Contact[] {
  if (!group?.all?.length) return contacts;
  return contacts.filter((c) => evalConditionGroup(group, c));
}

const digitsOf = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/**
 * Quick-search matcher: name / email / company by substring, plus phone by
 * digits only so "082 123" finds "+27 82 123 4567". A query with no digits
 * never matches on phone — an empty needle would match every contact.
 */
export function matchesSearch(c: Contact, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (
    c.name?.toLowerCase().includes(q) ||
    c.email?.toLowerCase().includes(q) ||
    c.company?.toLowerCase().includes(q)
  ) {
    return true;
  }
  const qDigits = digitsOf(q);
  return qDigits.length > 0 && digitsOf(c.phone).includes(qDigits);
}
