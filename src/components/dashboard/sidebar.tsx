"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import {
  ClipboardCheck,
  Home,
  Users,
  GitBranch,
  Calendar,
  CalendarClock,
  CheckSquare,
  FileText,
  FileSignature,
  BarChart3,
  Settings,
  LogOut,
  Building2,
  Workflow,
  Globe,
  Images,
  Compass,
  Lock,
  Send,
  Bot,
  Package,
  Link2,
  ScrollText,
  MessagesSquare,
  Radar,
  Target,
  Share2,
  GraduationCap,
  Sparkles,
  CreditCard,
  FlaskConical,
  MonitorPlay,
  Star,
  Rocket,
  Library,
} from "lucide-react";
import { getFirebaseDb } from "@/lib/firebase/client";
import { GET_LEADS_PARKED } from "@/lib/get-leads/business-types";
import { signOutUser } from "@/lib/firebase/auth";
import { useIsStandalone } from "@/hooks/use-standalone";
import { useDueTodayCount } from "@/hooks/use-due-today";
import { useUnreadConversationsCount } from "@/hooks/use-unread-conversations";
import { useOpenApprovalsCount } from "@/hooks/use-open-approvals";
import { useActiveSubAccountId } from "@/hooks/use-active-sub-account-id";
import { useAuth } from "@/hooks/use-auth";
import { useAgency } from "@/hooks/use-agency";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/logo-mark";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Home;
  enabled: boolean;
  badgeKey?: "dueToday" | "unreadConversations" | "openApprovals";
  matchPrefix?: string;
}

// Per-sub-account nav. `href` is templated with the active sub-account id at
// render time; `matchPrefix` is the stem used to highlight the active link.
const SUB_ACCOUNT_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: Home, enabled: true },
  { href: "/launchpad", label: "Launchpad", icon: Rocket, enabled: true },
  {
    href: "/ai-suite",
    label: "Workspace Assistant",
    icon: Sparkles,
    enabled: true,
  },
  {
    href: "/conversations",
    label: "Conversations",
    icon: MessagesSquare,
    enabled: true,
    badgeKey: "unreadConversations",
  },
  { href: "/contacts", label: "Contacts", icon: Users, enabled: true },
  { href: "/companies", label: "Companies", icon: Building2, enabled: true },
  // Get Leads is PARKED — entry hidden while the flag is on.
  ...(GET_LEADS_PARKED
    ? []
    : [{ href: "/get-leads", label: "Get Leads", icon: Radar, enabled: true }]),
  { href: "/prospecting", label: "Prospecting", icon: Target, enabled: true },
  { href: "/pipeline", label: "Pipeline", icon: GitBranch, enabled: true },
  { href: "/calendar", label: "Calendar", icon: Calendar, enabled: true },
  {
    href: "/booking",
    label: "Booking",
    icon: CalendarClock,
    enabled: true,
  },
  {
    href: "/tasks",
    label: "Tasks",
    icon: CheckSquare,
    enabled: true,
    badgeKey: "dueToday",
  },
  { href: "/forms", label: "Forms", icon: FileText, enabled: true },
  { href: "/tracked-links", label: "Tracked Links", icon: Link2, enabled: true },
  { href: "/products", label: "Products", icon: Package, enabled: true },
  { href: "/quotes", label: "Quotes", icon: FileSignature, enabled: true },
  { href: "/checkout", label: "Checkout", icon: CreditCard, enabled: true },
  { href: "/website", label: "Website", icon: Globe, enabled: true },
  { href: "/media", label: "Media", icon: Images, enabled: true },
  { href: "/workflows", label: "Workflows", icon: Workflow, enabled: true },
  {
    href: "/approvals",
    label: "Approvals",
    icon: ClipboardCheck,
    enabled: true,
    badgeKey: "openApprovals",
  },
  { href: "/ai-agents", label: "AI Agents", icon: Bot, enabled: true },
  { href: "/broadcasts", label: "Broadcasts", icon: Send, enabled: true },
  { href: "/webinars", label: "Webinars", icon: MonitorPlay, enabled: true },
  { href: "/templates", label: "Templates", icon: FileText, enabled: true },
  { href: "/social", label: "Social Planner", icon: Share2, enabled: true },
  {
    href: "/community",
    label: "Community",
    icon: GraduationCap,
    enabled: true,
  },
  { href: "/reputation", label: "Reputation", icon: Star, enabled: true },
  { href: "/reports", label: "Reports", icon: BarChart3, enabled: true },
  // Labs — the gated container for PRE-RELEASE features (agency opt-in per
  // sub-account via labsEnabledByAgency; hidden-by-default when off).
  { href: "/labs", label: "Labs", icon: FlaskConical, enabled: true },
  { href: "/logs", label: "Logs", icon: ScrollText, enabled: true },
  {
    href: "/dashboard/settings",
    label: "Settings Sub-Account",
    icon: Settings,
    enabled: true,
  },
];

/**
 * The drawer menu inside the INSTALLED PWA trims to on-the-go essentials —
 * the bottom tab bar already covers Dashboard/Conversations/Contacts/
 * Pipeline, and builder/config surfaces (Forms, Website, Workflows, …) are
 * desktop work. Browser use (mobile or desktop) always shows the full nav.
 */
const PWA_CORE_HREFS = new Set([
  "/calendar",
  "/booking",
  "/tasks",
  "/quotes",
  "/reports",
  "/dashboard/settings",
]);

interface SidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function activeSubAccountFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/sa\/([^/]+)/);
  return match ? match[1] : null;
}

function SidebarContent({ trimmed = false }: { trimmed?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  // Resolve the active sub-account from the URL — the Sidebar renders above the
  // SubAccountProvider, so the count hooks can't read it from context.
  const { subAccountId: badgeSubId, agencyId: badgeAgencyId } =
    useActiveSubAccountId();
  const dueToday = useDueTodayCount(badgeSubId, badgeAgencyId);
  const unreadConversations = useUnreadConversationsCount(badgeSubId);
  const { agencyRole, memberships, loading } = useAuth();
  const agency = useAgency();
  const activeSubId = activeSubAccountFromPath(pathname);
  const subRoot = activeSubId ? `/sa/${activeSubId}` : null;

  // Subscribe to the active sub-account's agency-level feature gates so
  // the sidebar can render locked entries when the agency owner has
  // disabled a feature. `null` = unknown (still loading) — we optimistic-
  // render as enabled until we hear back. Tracking just `broadcasts`
  // for now; other gates (api, email) lock their own sections rather
  // than the sidebar entry.
  const [broadcastsGate, setBroadcastsGate] = useState<boolean | null>(null);
  const [websiteGate, setWebsiteGate] = useState<boolean | null>(null);
  const [socialGate, setSocialGate] = useState<boolean | null>(null);
  const [communityGate, setCommunityGate] = useState<boolean | null>(null);
  const [aiSuiteGate, setAiSuiteGate] = useState<boolean | null>(null);
  const [getLeadsGate, setGetLeadsGate] = useState<boolean | null>(null);
  const [prospectingGate, setProspectingGate] = useState<boolean | null>(
    null
  );
  const [labsGate, setLabsGate] = useState<boolean | null>(null);
  const [paymentsGate, setPaymentsGate] = useState<boolean | null>(null);
  const [paymentsHidden, setPaymentsHidden] = useState(true);
  const [webinar1Gate, setWebinar1Gate] = useState<boolean | null>(null);
  const [webinar1Hidden, setWebinar1Hidden] = useState(true);
  // Agent API approvals: shown only while the agency enabled the Agent API.
  const [agentApiGate, setAgentApiGate] = useState<boolean | null>(null);
  // Gate off: still surface rows whose outcome is unknown — a person must
  // settle them even though nothing new can be approved.
  const openApprovals = useOpenApprovalsCount(
    badgeSubId,
    agentApiGate === true ? "open" : agentApiGate === false ? "unsettled" : null
  );
  // Per-feature "hide vs. show as Locked" flag. Only consulted when the
  // matching gate is off. HIDDEN IS THE DEFAULT — a disabled feature is omitted
  // entirely so the tenant never knows it exists; the agency owner has to opt a
  // feature into the greyed "Locked" row (by setting the field to `false`).
  const [broadcastsHidden, setBroadcastsHidden] = useState(false);
  const [websiteHidden, setWebsiteHidden] = useState(false);
  const [socialHidden, setSocialHidden] = useState(false);
  const [communityHidden, setCommunityHidden] = useState(false);
  const [getLeadsHidden, setGetLeadsHidden] = useState(false);
  const [prospectingHidden, setProspectingHidden] = useState(false);
  const [aiSuiteHidden, setAiSuiteHidden] = useState(false);
  const [labsHidden, setLabsHidden] = useState(false);
  useEffect(() => {
    const linkSubIdLocal = activeSubId ?? memberships[0]?.subAccountId ?? null;
    if (!linkSubIdLocal) {
      setBroadcastsGate(null);
      setWebsiteGate(null);
      setSocialGate(null);
      setCommunityGate(null);
      setAiSuiteGate(null);
      setGetLeadsGate(null);
      setProspectingGate(null);
      setLabsGate(null);
      setPaymentsGate(null);
      setWebinar1Gate(null);
      setAgentApiGate(null);
      return;
    }
    return onSnapshot(
      doc(getFirebaseDb(), "subAccounts", linkSubIdLocal),
      (snap) => {
        const data = snap.data();
        setBroadcastsGate(data?.broadcastsEnabledByAgency === true);
        setWebsiteGate(data?.websiteEnabledByAgency === true);
        setSocialGate(data?.socialPlannerEnabledByAgency === true);
        setCommunityGate(data?.communityEnabledByAgency === true);
        // Workspace Assistant is opt-in like the other gates — off unless the
        // agency owner explicitly enabled it (legacy/unset reads as off).
        setAiSuiteGate(data?.aiSuiteEnabledByAgency === true);
        setGetLeadsGate(data?.getLeadsEnabledByAgency === true);
        setProspectingGate(data?.prospectingEnabledByAgency === true);
        setLabsGate(data?.labsEnabledByAgency === true);
        setPaymentsGate(data?.paymentsEnabledByAgency === true);
        setWebinar1Gate(data?.webinar1EnabledByAgency === true);
        setAgentApiGate(data?.agentApiEnabledByAgency === true);
        // Default (unset) → hidden. Only an explicit `false` shows the Locked row.
        setBroadcastsHidden(data?.broadcastsHiddenWhenDisabled !== false);
        setWebsiteHidden(data?.websiteHiddenWhenDisabled !== false);
        setSocialHidden(data?.socialPlannerHiddenWhenDisabled !== false);
        setCommunityHidden(data?.communityHiddenWhenDisabled !== false);
        setGetLeadsHidden(data?.getLeadsHiddenWhenDisabled !== false);
        setProspectingHidden(data?.prospectingHiddenWhenDisabled !== false);
        setAiSuiteHidden(data?.aiSuiteHiddenWhenDisabled !== false);
        setLabsHidden(data?.labsHiddenWhenDisabled !== false);
        setPaymentsHidden(data?.paymentsHiddenWhenDisabled !== false);
        setWebinar1Hidden(data?.webinar1HiddenWhenDisabled !== false);
      },
      () => {
        setBroadcastsGate(null);
        setWebsiteGate(null);
        setSocialGate(null);
        setCommunityGate(null);
        setAiSuiteGate(null);
        setGetLeadsGate(null);
        setProspectingGate(null);
        setLabsGate(null);
        setPaymentsGate(null);
        setWebinar1Gate(null);
        setAgentApiGate(null);
      }
    );
  }, [activeSubId, memberships]);

  // When no sub-account is active (agency-level pages), fall back to the
  // user's first membership for sub-account-scoped link templating.
  const fallbackSub = memberships[0]?.subAccountId ?? null;
  const linkSubId = activeSubId ?? fallbackSub;
  const showSubNav = !!linkSubId;
  const activeMembership = activeSubId
    ? memberships.find((m) => m.subAccountId === activeSubId)
    : null;
  // Header label for the SUB-ACCOUNT nav section. Reinforces which workspace
  // the user is operating inside, e.g. "SUB-ACCOUNT-1001 · SLACK INC".
  const subSectionLabel = activeMembership
    ? activeMembership.accountNumber !== undefined
      ? `Sub-account-${activeMembership.accountNumber} · ${activeMembership.name || ""}`.trim()
      : (activeMembership.name ?? "Sub-account")
    : "Sub-account";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center border-b px-6">
        <Link href="/" className="flex items-center gap-2 text-xl font-bold">
          {agency.logoUrl ? (
            // Custom agency logo. Constrained to 24px tall, auto width;
            // the agency hosts the asset so we render whatever they paste.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={agency.logoUrl}
              alt={agency.name}
              className="h-6 w-auto max-w-[120px] object-contain"
            />
          ) : (
            <LogoMark size={20} idSuffix="-sidebar" />
          )}
          <span className="truncate">{agency.name}</span>
        </Link>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-4">
        {/* Agency-level nav — visible to agency owners always; everyone with
            access to /agency sees the entry. */}
        {(agencyRole === "owner" || memberships.length > 1) && (
          <div className="mb-3">
            <p className="text-muted-foreground mb-1 px-3 text-[10px] tracking-wider uppercase">
              Agency
            </p>
            {agencyRole === "owner" && !trimmed && (
              <Link
                href="/agency/get-started"
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  pathname.startsWith("/agency/get-started")
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Compass className="h-4 w-4" />
                Get started
              </Link>
            )}
            <Link
              href="/agency"
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === "/agency"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Building2 className="h-4 w-4" />
              Agency home
            </Link>
            {agencyRole === "owner" && (
              <Link
                href="/agency/sub-accounts"
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  pathname.startsWith("/agency/sub-accounts")
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Users className="h-4 w-4" />
                Sub-accounts
              </Link>
            )}
            {agencyRole === "owner" && (
              <Link
                href="/agency/templates"
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  pathname.startsWith("/agency/templates")
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Library className="h-4 w-4" />
                Template library
              </Link>
            )}
            {agencyRole === "owner" && !trimmed && (
              <Link
                href="/agency/billing"
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  pathname.startsWith("/agency/billing")
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <CreditCard className="h-4 w-4" />
                Client billing
              </Link>
            )}
            {/* Hidden until the owner enables it under Agency → Settings —
                the Agency Assistant ships OFF by default. */}
            {agencyRole === "owner" && agency.agencyAssistantEnabled && (
              <Link
                href="/agency/ai-suite"
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  pathname.startsWith("/agency/ai-suite")
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Sparkles className="h-4 w-4" />
                Agency Assistant
              </Link>
            )}
            {agencyRole === "owner" && !trimmed && (
              <Link
                href="/agency/settings"
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  pathname.startsWith("/agency/settings")
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Settings className="h-4 w-4" />
                Settings Agency
              </Link>
            )}
          </div>
        )}

        {showSubNav && (
          <div>
            {(agencyRole === "owner" || memberships.length > 1) && (
              <p
                className="text-muted-foreground mb-1 truncate px-3 text-[10px] tracking-wider uppercase"
                title={subSectionLabel}
              >
                {subSectionLabel}
              </p>
            )}
            {SUB_ACCOUNT_NAV.filter(
              (item) => !trimmed || PWA_CORE_HREFS.has(item.href)
            ).map((item) => {
              const fullHref = `${subRoot ?? `/sa/${linkSubId}`}${item.href}`;
              const isActive =
                pathname === fullHref ||
                (item.href !== "/dashboard" && pathname.startsWith(fullHref));
              // Agency-level gate lock for Broadcasts. We DO render it
              // when the gate is unknown (broadcastsGate === null) —
              // assumption: legitimate sub-accounts are enabled, and
              // flashing "Locked" → "Enabled" is worse UX than a brief
              // window where a disabled tenant can click. The send route
              // returns 403 either way.
              const gateLocked =
                (item.href === "/broadcasts" && broadcastsGate === false) ||
                (item.href === "/website" && websiteGate === false) ||
                (item.href === "/social" && socialGate === false) ||
                (item.href === "/community" && communityGate === false) ||
                (item.href === "/ai-suite" && aiSuiteGate === false) ||
                (item.href === "/get-leads" && getLeadsGate === false) ||
                (item.href === "/prospecting" && prospectingGate === false) ||
                (item.href === "/labs" && labsGate === false) ||
                (item.href === "/checkout" && paymentsGate === false) ||
                (item.href === "/webinars" && webinar1Gate === false);
              // When the agency owner opted to hide (not just lock) a disabled
              // feature, omit the entry entirely so the tenant never sees it.
              const gateHidden =
                (item.href === "/broadcasts" &&
                  broadcastsGate === false &&
                  broadcastsHidden) ||
                (item.href === "/website" &&
                  websiteGate === false &&
                  websiteHidden) ||
                (item.href === "/social" &&
                  socialGate === false &&
                  socialHidden) ||
                (item.href === "/community" &&
                  communityGate === false &&
                  communityHidden) ||
                (item.href === "/get-leads" &&
                  getLeadsGate === false &&
                  getLeadsHidden) ||
                (item.href === "/prospecting" &&
                  prospectingGate === false &&
                  prospectingHidden) ||
                (item.href === "/ai-suite" &&
                  aiSuiteGate === false &&
                  aiSuiteHidden) ||
                (item.href === "/labs" && labsGate === false && labsHidden) ||
                (item.href === "/checkout" &&
                  paymentsGate === false &&
                  paymentsHidden) ||
                (item.href === "/webinars" &&
                  webinar1Gate === false &&
                  webinar1Hidden) ||
                // No "Locked" row: with the Agent API off the entry shows only
                // while unsettled rows still need settling.
                (item.href === "/approvals" &&
                  agentApiGate !== true &&
                  openApprovals === 0);
              if (gateHidden) return null;
              if (!item.enabled || gateLocked) {
                const lockedByGate = gateLocked;
                return (
                  <div
                    key={item.href}
                    className="text-muted-foreground/50 flex cursor-not-allowed items-center justify-between gap-3 rounded-md px-3 py-2 text-sm font-medium"
                    title={
                      lockedByGate
                        ? "Disabled by your agency administrator"
                        : "Coming soon"
                    }
                  >
                    <span className="flex items-center gap-3">
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </span>
                    <span className="flex items-center gap-1 rounded-full border px-1.5 text-[10px] tracking-wide uppercase">
                      {lockedByGate && <Lock className="h-2.5 w-2.5" />}
                      {lockedByGate ? "Locked" : "Soon"}
                    </span>
                  </div>
                );
              }
              const badge =
                item.badgeKey === "dueToday" && dueToday > 0
                  ? dueToday
                  : item.badgeKey === "unreadConversations" &&
                      unreadConversations > 0
                    ? unreadConversations
                    : item.badgeKey === "openApprovals" && openApprovals > 0
                      ? openApprovals
                      : null;
              return (
                <Link
                  key={item.href}
                  href={fullHref}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <span className="flex items-center gap-3">
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </span>
                  {badge !== null && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                        isActive
                          ? "bg-primary text-primary-foreground"
                          : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      )}
                    >
                      {badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}

        {!showSubNav && !loading && (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-xs">
            Pick a sub-account from{" "}
            <Link href="/agency" className="text-primary underline">
              Agency home
            </Link>{" "}
            to see its data.
          </p>
        )}
      </nav>

      <div className="border-t p-4">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3"
          onClick={async () => {
            // Navigate after the session is cleared — without this the
            // protected page stays on screen (most visible in the installed
            // PWA, where there's no URL bar to escape from).
            await signOutUser();
            router.push("/");
          }}
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </Button>
      </div>
    </div>
  );
}

export function Sidebar({ open, onOpenChange }: SidebarProps) {
  const pathname = usePathname();
  const standalone = useIsStandalone();

  // Close the mobile drawer whenever navigation happens — tapping a menu
  // item should reveal the destination, not leave the sheet covering it.
  // No-op when already closed; the desktop <aside> isn't affected.
  useEffect(() => {
    onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <>
      <aside className="bg-background hidden w-64 shrink-0 border-r md:block">
        <SidebarContent />
      </aside>

      {/* The drawer trims to PWA core items ONLY when running installed
          (standalone) — regular mobile-browser use keeps the full menu. */}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <SidebarContent trimmed={standalone} />
        </SheetContent>
      </Sheet>
    </>
  );
}
