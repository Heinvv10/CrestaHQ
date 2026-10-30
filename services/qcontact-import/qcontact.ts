/**
 * Minimal QContact (devise_token_auth) client for the Velocity new-install
 * importer. Signs in with email + password, re-signs-in once on a 401, and
 * reads the Case list view, a Case, and a Contact. Read-only.
 */

import { FETCH_TIMEOUT_MS } from "./fetch-timeout.ts";

export type QContactAuth = { uid: string; client: string; accessToken: string };

export type CaseRow = {
  id: number;
  label: string;
  created_at: string;
  status: string | null;
  category: string | null;
};

export type CaseDetail = {
  id: number;
  label: string;
  lookup_contact_id: number | null;
  fields: Record<string, unknown>;
};

export type ContactDetail = {
  id: number;
  label: string;
  fields: Record<string, unknown>;
};

/**
 * A `c__contactlocation` entity — what a case's `c__location_pin` id
 * resolves to. Carries `c__latitude`/`c__longitude` plus
 * `c__google_maps_url`, `c__pop_id`, `c__community_name`,
 * `c__address_line_1`/`c__address_line_2`, `c__locationtype`,
 * `c__installrequest` (only lat/lng are read today).
 */
export type LocationDetail = {
  id: number;
  label: string;
  fields: Record<string, unknown>;
};

export type QContactConfig = { baseUrl: string; email: string; password: string };

// Erasable-syntax only (node --experimental-strip-types): no parameter
// properties, no enums, no namespaces anywhere in this service.
export class QContactClient {
  private auth: QContactAuth | null = null;
  private readonly cfg: QContactConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: QContactConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  async signIn(): Promise<QContactAuth> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/api/v2/auth/sign_in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.cfg.email, password: this.cfg.password }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`QContact sign-in failed: HTTP ${res.status}`);
    const uid = res.headers.get("uid");
    const client = res.headers.get("client");
    const accessToken = res.headers.get("access-token");
    if (!uid || !client || !accessToken) {
      throw new Error("QContact sign-in returned no token headers");
    }
    this.auth = { uid, client, accessToken };
    return this.auth;
  }

  private async get<T>(path: string, retried = false): Promise<T> {
    if (!this.auth) await this.signIn();
    const a = this.auth!;
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      headers: { uid: a.uid, client: a.client, "access-token": a.accessToken },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 && !retried) {
      this.auth = null;
      return this.get<T>(path, true);
    }
    if (!res.ok) throw new Error(`QContact GET ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Every row of a saved Case list view. Sending `page=` switches the
   * endpoint into 20-per-page mode with a `pagination.next` cursor; without
   * it the response is capped silently (1000 seen), and `per_page` is
   * ignored. So: walk `next` until it is null.
   */
  async listView(view: string): Promise<CaseRow[]> {
    const rows: CaseRow[] = [];
    for (let page: number | null = 1; page !== null; ) {
      const q = `view=${encodeURIComponent(view)}&page=${page}`;
      const body: { results?: CaseRow[]; pagination?: { next?: number | null } } =
        await this.get(`/api/v2/entities/Case?${q}`);
      rows.push(...(body.results ?? []));
      page = body.pagination?.next ?? null;
    }
    return rows;
  }

  getCase(id: number): Promise<CaseDetail> {
    return this.get<CaseDetail>(`/api/v2/entities/Case/${id}`);
  }

  getContact(id: number): Promise<ContactDetail> {
    return this.get<ContactDetail>(`/api/v2/entities/Contact/${id}`);
  }

  getLocation(id: number): Promise<LocationDetail> {
    return this.get<LocationDetail>(`/api/v2/entities/c__contactlocation/${id}`);
  }
}
