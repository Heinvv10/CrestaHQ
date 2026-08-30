import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  webinar1ConnectionSecretPath,
  type Webinar1ConnectionSecret,
  type Webinar1Video,
  type Webinar1Webinar,
} from "@/types/webinar1";

/**
 * THE chokepoint for talking to a sub-account's connected Webinar1
 * deployment — the only code path that reads the stored API key (same rule
 * as lib/stripe/sub-account-client.ts for the restricted key). Every
 * Webinar1 API call made on behalf of a sub-account goes through
 * `getWebinar1Client()`; never fetch `${baseUrl}/api/launchcast/v1/...`
 * inline in a route.
 *
 * Wire contract (Webinar1's docs/api.md): all endpoints under
 * `${baseUrl}/api/launchcast/v1`, authenticated with
 * `Authorization: Bearer wbk_…`. Errors come back as `{error}` JSON.
 */

export class Webinar1ConnectionError extends Error {
  readonly code: "not_connected" | "request_failed";
  /** HTTP status from the remote deployment, when there was a response. */
  readonly status: number | null;

  constructor(
    code: "not_connected" | "request_failed",
    message: string,
    status: number | null = null
  ) {
    super(message);
    this.name = "Webinar1ConnectionError";
    this.code = code;
    this.status = status;
  }
}

/** Read the server-only secret doc. Returns null when never connected. */
export async function readWebinar1ConnectionSecret(
  subAccountId: string
): Promise<Webinar1ConnectionSecret | null> {
  const snap = await getAdminDb()
    .doc(webinar1ConnectionSecretPath(subAccountId))
    .get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<Webinar1ConnectionSecret> | undefined;
  if (!data?.baseUrl || !data.apiKey) return null;
  return {
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    webhookSecret: data.webhookSecret ?? "",
    webhookEndpointId: data.webhookEndpointId ?? null,
  };
}

interface RawClient {
  request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T>;
}

/** Bare client from explicit credentials — used by the connect route's probe
 *  (before anything is stored) and by `getWebinar1Client` after reading the
 *  secret doc. 15s timeout; remote `{error}` bodies surface verbatim. */
export function webinar1Fetcher(baseUrl: string, apiKey: string): RawClient {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async request<T>(
      method: "GET" | "POST" | "DELETE",
      path: string,
      body?: unknown
    ): Promise<T> {
      let res: Response;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        res = await fetch(`${base}/api/launchcast/v1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout));
      } catch {
        throw new Webinar1ConnectionError(
          "request_failed",
          "Couldn't reach the webinar platform. Check the base URL and that the deployment is up."
        );
      }
      const data = (await res.json().catch(() => null)) as
        | (T & { error?: string })
        | null;
      if (!res.ok) {
        throw new Webinar1ConnectionError(
          "request_failed",
          data?.error ?? `The webinar platform returned HTTP ${res.status}.`,
          res.status
        );
      }
      return (data ?? {}) as T;
    },
  };
}

export interface Webinar1Client {
  listVideos(): Promise<Webinar1Video[]>;
  listWebinars(): Promise<Webinar1Webinar[]>;
  createWebinar(input: {
    title: string;
    slug: string;
    videoId?: string | null;
    scheduleMode?: string;
    description?: string;
    ctaLabel?: string;
    ctaUrl?: string;
  }): Promise<Webinar1Webinar>;
  registerContact(
    webinarId: string,
    input: { email: string; name?: string | null }
  ): Promise<{
    registrationId: string;
    scheduledSlotAt: string;
    alreadyRegistered: boolean;
  }>;
  createWebhookEndpoint(input: {
    url: string;
    events: readonly string[];
    description: string;
  }): Promise<{ id: string; secret: string }>;
  deleteWebhookEndpoint(id: string): Promise<void>;
}

function buildClient(raw: RawClient): Webinar1Client {
  return {
    async listVideos() {
      const data = await raw.request<{ videos: Webinar1Video[] }>(
        "GET",
        "/videos"
      );
      return data.videos ?? [];
    },
    async listWebinars() {
      const data = await raw.request<{ webinars: Webinar1Webinar[] }>(
        "GET",
        "/webinars"
      );
      return data.webinars ?? [];
    },
    async createWebinar(input) {
      return raw.request<Webinar1Webinar>("POST", "/webinars", input);
    },
    async registerContact(webinarId, input) {
      try {
        const data = await raw.request<{
          registrationId: string;
          scheduledSlotAt: string;
        }>("POST", `/webinars/${webinarId}/registrations`, input);
        return { ...data, alreadyRegistered: false };
      } catch (err) {
        // 409 = already registered — for a CRM push that's success-shaped
        // (the contact IS on the list), so normalize it instead of failing.
        if (err instanceof Webinar1ConnectionError && err.status === 409) {
          return {
            registrationId: "",
            scheduledSlotAt: "",
            alreadyRegistered: true,
          };
        }
        throw err;
      }
    },
    async createWebhookEndpoint(input) {
      return raw.request<{ id: string; secret: string }>(
        "POST",
        "/webhook-endpoints",
        { ...input, events: [...input.events] }
      );
    },
    async deleteWebhookEndpoint(id) {
      await raw.request<{ ok: boolean }>("DELETE", `/webhook-endpoints/${id}`);
    },
  };
}

/** Client from explicit credentials — the connect route's probe path. */
export function getWebinar1ClientForCredentials(
  baseUrl: string,
  apiKey: string
): Webinar1Client {
  return buildClient(webinar1Fetcher(baseUrl, apiKey));
}

/**
 * Client bound to one sub-account's stored connection. Throws
 * `Webinar1ConnectionError("not_connected")` rather than returning null so a
 * caller can't accidentally proceed unconnected.
 */
export async function getWebinar1Client(
  subAccountId: string
): Promise<{ client: Webinar1Client; secret: Webinar1ConnectionSecret }> {
  const secret = await readWebinar1ConnectionSecret(subAccountId);
  if (!secret) {
    throw new Webinar1ConnectionError(
      "not_connected",
      "This workspace hasn't connected a webinar platform yet. Connect one in Settings → Admin → Webinars."
    );
  }
  return {
    client: buildClient(webinar1Fetcher(secret.baseUrl, secret.apiKey)),
    secret,
  };
}
