import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * A company (GHL "Business") — an organisation several contacts belong to.
 * Sub-account scoped, top-level collection so the "contacts at this company"
 * query stays a single-collection read. Contacts point at it via
 * `Contact.companyId`; the legacy free-text `Contact.company` string is kept
 * equal to `name` on link so CSV export, quotes and webhooks are unchanged.
 */
export interface Company {
  id: string;
  name: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | Date;
  updatedAt: Timestamp | FieldValue | Date;
}

export type CompanyFormData = Pick<
  Company,
  "name" | "phone" | "email" | "website" | "address"
>;
