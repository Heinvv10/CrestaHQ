import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Download, Layers } from "lucide-react";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { previewSharedSnapshot } from "@/lib/snapshots/share-redeem";

export const dynamic = "force-dynamic";

// The token is in this page's URL: never index it, never send it onward.
export const metadata: Metadata = {
  title: "Shared snapshot",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

interface PageProps {
  params: Promise<{ token: string }>;
}

const actionClass =
  "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors";

/**
 * True when the visitor has a verified session as an active agency owner on
 * THIS deployment. Middleware sets `x-user-uid` only from a verified session
 * cookie, and strips it from public paths when there is none.
 */
async function viewerIsOwner(): Promise<boolean> {
  const uid = (await headers()).get("x-user-uid");
  if (!uid) return false;
  const record = await getAdminAuth().getUser(uid).catch(() => null);
  const claims = record?.customClaims ?? {};
  return claims.status === "active" && claims.agencyRole === "owner";
}

/**
 * Public landing page for a snapshot share link. Anyone holding the link can
 * download the snapshot as a portable file and import it on their own
 * deployment; an owner signed in here can import it directly instead.
 */
export default async function SharedSnapshotPage({ params }: PageProps) {
  const { token } = await params;
  const preview = await previewSharedSnapshot(getAdminDb(), token);

  if (!preview) {
    return (
      <main className="min-h-screen bg-background px-4 py-16">
        <div
          data-testid="snapshot-link-invalid"
          className="mx-auto max-w-3xl rounded-2xl border bg-card p-8 text-center"
        >
          <h1 className="text-lg font-semibold">Invalid or expired link</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This snapshot link has expired, was revoked, or has already been
            used. Ask whoever shared it for a new one.
          </p>
        </div>
      </main>
    );
  }

  const owner = await viewerIsOwner();
  const c = preview.counts;
  const contents = [
    `${c.forms} forms`,
    `${c.workflows} workflows`,
    `${c.messageTemplates} message templates`,
    `${c.products} products`,
    `${c.customFields} custom fields`,
    ...(c.aiProfile ? ["AI persona"] : []),
  ];
  const expires = new Date(preview.expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <main className="min-h-screen bg-background px-4 py-16">
      <div className="mx-auto max-w-3xl rounded-2xl border bg-card p-6">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Layers className="h-4 w-4" />
          </span>
          <div>
            <p className="text-xs text-muted-foreground">Shared snapshot</p>
            <h1 data-testid="snapshot-share-name" className="text-lg font-semibold">
              {preview.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              {contents.join(" · ")}
            </p>
          </div>
        </div>

        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Download the snapshot file, then import it from your own CRM:
            Agency → Sub-accounts → Snapshots → Import from file. It carries no
            customer data or credentials. Workflow destinations — notification
            recipients and webhook URLs — are cleared, so reconfigure them
            before activating an imported workflow.
          </p>
          <p>
            Link expires {expires}.{" "}
            {preview.singleUse
              ? "It works once: downloading or importing uses it up."
              : "Until then, anyone holding it can download the snapshot."}
          </p>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <a
            href={`/api/public/snapshots/${encodeURIComponent(token)}`}
            data-testid="snapshot-download-button"
            className={`${actionClass} bg-primary text-primary-foreground hover:bg-primary/90`}
          >
            <Download className="h-4 w-4" />
            Download snapshot file
          </a>
          {owner && (
            <Link
              href={`/agency/snapshots/import?token=${encodeURIComponent(token)}`}
              data-testid="snapshot-share-import-link"
              className={`${actionClass} border hover:bg-muted`}
            >
              Import into my agency
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
