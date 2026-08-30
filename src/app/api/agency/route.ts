import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { invalidateAgencyPolicyCache } from "@/lib/agency/policy";
import type { MemberStatus, Role } from "@/types";

/**
 * Agency-level updates. PATCH allows the owner to update name + logoUrl
 * plus the public-landing brand fields (supportEmail, primaryDomain).
 * Custom domains, theme tokens, and SaaS Mode rebilling are explicitly
 * out of scope here.
 */

interface CallerClaims {
  role?: Role;
  status?: MemberStatus;
  agencyRole?: "owner" | "staff" | null;
  agencyId?: string | null;
}

interface PatchBody {
  name?: string;
  logoUrl?: string | null;
  supportEmail?: string | null;
  primaryDomain?: string | null;
  sharedSmsAllowed?: boolean;
  appTheme?: string | null;
  agencyAssistantEnabled?: boolean;
  agencyAssistantModel?: "opus" | "sonnet";
}

const APP_THEMES = new Set(["leadstack", "green", "neutral"]);

const URL_RE = /^https?:\/\/.+/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

async function requireAgencyOwner(request: Request): Promise<
  { uid: string; agencyId: string } | NextResponse
> {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const record = await getAdminAuth().getUser(uid).catch(() => null);
  if (!record) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const claims = (record.customClaims ?? {}) as CallerClaims;
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }
  if (claims.agencyRole !== "owner" || !claims.agencyId) {
    return NextResponse.json(
      { error: "Only the agency owner can update agency settings." },
      { status: 403 },
    );
  }
  return { uid, agencyId: claims.agencyId };
}

export async function PATCH(request: Request) {
  const access = await requireAgencyOwner(request);
  if (access instanceof NextResponse) return access;

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json(
        { error: "Agency name cannot be empty." },
        { status: 400 },
      );
    }
    if (name.length > 80) {
      return NextResponse.json(
        { error: "Agency name must be 80 characters or fewer." },
        { status: 400 },
      );
    }
    update.name = name;
  }

  if (body.logoUrl !== undefined) {
    if (body.logoUrl === null || body.logoUrl === "") {
      update.logoUrl = null;
    } else if (typeof body.logoUrl !== "string") {
      return NextResponse.json(
        { error: "Logo URL must be a string or null." },
        { status: 400 },
      );
    } else {
      const trimmed = body.logoUrl.trim();
      if (!URL_RE.test(trimmed)) {
        return NextResponse.json(
          { error: "Logo URL must start with http:// or https://." },
          { status: 400 },
        );
      }
      update.logoUrl = trimmed;
    }
  }

  if (body.supportEmail !== undefined) {
    if (body.supportEmail === null || body.supportEmail === "") {
      update.supportEmail = null;
    } else if (typeof body.supportEmail !== "string") {
      return NextResponse.json(
        { error: "Support email must be a string or null." },
        { status: 400 },
      );
    } else {
      const trimmed = body.supportEmail.trim().toLowerCase();
      if (!EMAIL_RE.test(trimmed)) {
        return NextResponse.json(
          { error: "Support email must be a valid email address." },
          { status: 400 },
        );
      }
      update.supportEmail = trimmed;
    }
  }

  if (body.primaryDomain !== undefined) {
    if (body.primaryDomain === null || body.primaryDomain === "") {
      update.primaryDomain = null;
    } else if (typeof body.primaryDomain !== "string") {
      return NextResponse.json(
        { error: "Primary domain must be a string or null." },
        { status: 400 },
      );
    } else {
      const trimmed = body.primaryDomain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
      if (!DOMAIN_RE.test(trimmed)) {
        return NextResponse.json(
          { error: "Primary domain must be a bare domain like example.com (no scheme, no slashes)." },
          { status: 400 },
        );
      }
      update.primaryDomain = trimmed;
    }
  }

  if (body.sharedSmsAllowed !== undefined) {
    if (typeof body.sharedSmsAllowed !== "boolean") {
      return NextResponse.json(
        { error: "sharedSmsAllowed must be a boolean." },
        { status: 400 },
      );
    }
    update.sharedSmsAllowed = body.sharedSmsAllowed;
  }

  // Agency Assistant master switch (off by default; read `=== true`).
  if (body.agencyAssistantEnabled !== undefined) {
    if (typeof body.agencyAssistantEnabled !== "boolean") {
      return NextResponse.json(
        { error: "agencyAssistantEnabled must be a boolean." },
        { status: 400 },
      );
    }
    update.agencyAssistantEnabled = body.agencyAssistantEnabled;
  }

  // Agency Assistant model tier ("opus" | "sonnet"; unset docs read as
  // opus — matching pre-picker behavior).
  if (body.agencyAssistantModel !== undefined) {
    if (
      body.agencyAssistantModel !== "opus" &&
      body.agencyAssistantModel !== "sonnet"
    ) {
      return NextResponse.json(
        { error: "agencyAssistantModel must be 'opus' or 'sonnet'." },
        { status: 400 },
      );
    }
    update.agencyAssistantModel = body.agencyAssistantModel;
  }

  if (body.appTheme !== undefined) {
    if (body.appTheme === null) {
      // Back to the deployment-mode default.
      update.appTheme = null;
    } else if (
      typeof body.appTheme !== "string" ||
      !APP_THEMES.has(body.appTheme)
    ) {
      return NextResponse.json(
        { error: "appTheme must be one of: leadstack, green, neutral." },
        { status: 400 },
      );
    } else {
      update.appTheme = body.appTheme;
    }
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json(
      { error: "No fields to update." },
      { status: 400 },
    );
  }

  await getAdminDb().doc(`agencies/${access.agencyId}`).update(update);

  // Drop the cached policy so send paths pick up the new value immediately on
  // this instance (other serverless instances expire via the 60s TTL).
  if (body.sharedSmsAllowed !== undefined) {
    invalidateAgencyPolicyCache(access.agencyId);
  }

  return NextResponse.json({ ok: true });
}
