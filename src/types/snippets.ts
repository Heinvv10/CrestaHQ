import type { FieldValue, Timestamp } from "firebase/firestore";

export type SnippetType = "text" | "email";

/**
 * `snippets/{id}` — a sub-account's saved reply (GHL "Snippets", SP2 T3).
 * `body` (and an email snippet's `subject`) may carry merge tags; they are
 * rendered when the snippet is inserted into the composer. `folder` is a
 * free-text group label, like GHL's snippet folders; null = no folder.
 */
export interface Snippet {
  id: string;
  name: string;
  body: string;
  type: SnippetType;
  /** Email snippets only; null for text snippets. */
  subject: string | null;
  folder: string | null;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** What a client sends to create or replace a snippet. */
export interface SnippetInput {
  name: string;
  body: string;
  type: SnippetType;
  subject: string | null;
  folder: string | null;
}

/** A snippet as the API returns it: timestamps as epoch millis. */
export type SnippetDto = Omit<Snippet, "createdAt" | "updatedAt"> & {
  createdAt: number | null;
  updatedAt: number | null;
  /** The API key prefix of the agent that last wrote it (lastAgentEditKey),
   *  and when; null when no API agent has. */
  lastAgentEditKey: string | null;
  lastAgentEditAt: number | null;
};
