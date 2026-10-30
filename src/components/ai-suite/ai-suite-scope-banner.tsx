import { Building2, Globe2 } from "lucide-react";

/** Same Beta pill as the beta feature gates in the agency Manage dialog. */
function BetaPill() {
  return (
    <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
      Beta
    </span>
  );
}

/**
 * Scope banner shown above each assistant. Its whole job is to make the
 * assistant's *blast radius* obvious at a glance, so an agency owner who
 * moves between the two surfaces all day always knows whether they're acting
 * on one client or on the whole agency:
 *
 *  - **Workspace Assistant** — scoped to one sub-account; reassures that
 *    actions stay inside that client's workspace.
 *  - **Agency Assistant** — agency-wide reach; warns that actions can affect
 *    every client (create sub-accounts, change feature gates).
 *
 * Deliberately visually distinct per level (icon + accent) so the two never
 * read as the same tool.
 */
export function AiSuiteScopeBanner({
  level,
  subAccountName,
}: {
  level: "agency" | "sub-account";
  subAccountName?: string;
}) {
  if (level === "agency") {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <Globe2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            Agency Assistant
            <BetaPill />
          </p>
          <p className="text-xs text-muted-foreground">
            Agency level — actions here can affect every client (create
            sub-accounts, change feature gates).
          </p>
        </div>
      </div>
    );
  }

  const name = subAccountName?.trim() || "this client";
  return (
    <div className="flex items-start gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/5 px-4 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">
        <Building2 className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <span className="truncate">Workspace Assistant · {name}</span>
          <BetaPill />
        </p>
        <p className="text-xs text-muted-foreground">
          Scoped to this client — everything here stays inside {name}.
        </p>
      </div>
    </div>
  );
}
