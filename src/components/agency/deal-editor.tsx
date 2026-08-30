"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Clock, Loader2, Store, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DealCountdown } from "@/components/landing/deal-countdown";
import { useCountdown } from "@/hooks/use-deal-urgency";
import { cn } from "@/lib/utils";
import {
  DEAL_NAME_MAX,
  DEAL_MEMBER_NOUN_MAX,
  DEAL_OFFER_LABEL_MAX,
  DEAL_SEATS_MIN,
  DEAL_SEATS_MAX,
  DEAL_TIME_ZONES,
  RETAIL_BANNER_MAX,
  detectTimeZone,
  isValidTimeZone,
  timeZoneAbbreviation,
  utcMsToWallClock,
  wallClockToUtcMs,
  type DealConfig,
  type DealType,
} from "@/lib/deal-config";

/**
 * Agency-owner editor for the live deal campaign. Two mutually-exclusive
 * urgency mechanics, picked by the Deal type toggle:
 *
 *   - "Spots counter" — name, scarcity noun, and seat count (today's
 *     behavior, unchanged).
 *   - "Countdown timer" — an offer label ("50% off") + an end date/time
 *     in a PICKED TIMEZONE (run a deal on AEST one month and Pacific the
 *     next without doing the arithmetic; the stored deadline is always an
 *     absolute UTC instant, so the zone only decides which wall clock
 *     "11:58 PM" means and which zone the public date is labelled with).
 *     While the deadline is in the future the landing shows a ticking
 *     timer; after it passes the page KEEPS SELLING at the same price and
 *     just hides the urgency UI (relaunch = save a new date).
 *
 * Edits PATCH to /api/agency/deal-config (writes appConfig/foundersCohort)
 * and flow to the public landing via useFoundersCohort's onSnapshot — no
 * redeploy. The sold counter is Stripe-webhook-owned and deliberately not
 * editable here.
 */

/**
 * ISO (UTC) → value for <input type="datetime-local">, read as a wall
 * clock in `timeZone` (the zone picked below the field, NOT the browser's).
 */
function isoToZonedInput(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return utcMsToWallClock(ms, timeZone);
}

/** <input type="datetime-local"> value, read in `timeZone` → ISO UTC. */
function zonedInputToIso(value: string, timeZone: string): string | null {
  if (!value) return null;
  const ms = wallClockToUtcMs(value, timeZone);
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function DealEditor({
  initialConfig,
  soldCount,
}: {
  initialConfig: DealConfig;
  soldCount: number;
}) {
  const [draft, setDraft] = useState<DealConfig>(initialConfig);
  const [saved, setSaved] = useState<DealConfig>(initialConfig);
  const [saving, setSaving] = useState(false);
  // The operator's own zone — the default when a deal has never had one
  // picked (every deal saved before the picker existed). Lazily read so
  // it's the BROWSER's zone on the client, not the server's.
  const [browserZone] = useState(detectTimeZone);
  // Guards the "End deals" switch so an accidental click can't silently
  // flip a live deal to retail — the operator confirms first, then Saves.
  const [confirmingRetail, setConfirmingRetail] = useState(false);

  const isCountdown = draft.dealType === "countdown";
  const retailMode = draft.retailMode;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const nameEmpty = draft.dealName.trim().length === 0;
  const nounEmpty = draft.memberNoun.trim().length === 0;
  const offerLabelEmpty = draft.offerLabel.trim().length === 0;
  const endsAtMissing = isCountdown && !draft.dealEndsAt;
  const retailBannerEmpty = draft.retailBannerMessage.trim().length === 0;
  // The deal fields are always sent on Save (so they stay valid for when
  // retail mode is switched back off), so they're validated regardless.
  // Retail mode adds the banner-message requirement on top.
  const canSave =
    dirty &&
    !saving &&
    !nameEmpty &&
    (isCountdown ? !offerLabelEmpty && !endsAtMissing : !nounEmpty) &&
    (!retailMode || !retailBannerEmpty);

  const belowSold = draft.slotsTotal < soldCount;
  const remaining = Math.max(0, draft.slotsTotal - soldCount);
  const progressPct =
    draft.slotsTotal > 0
      ? Math.min(100, Math.round((soldCount / draft.slotsTotal) * 100))
      : 0;

  // The zone the deadline's wall clock is read in. Unset on legacy deals —
  // fall back to the operator's own, which is exactly what the field did
  // before the picker existed. Always persisted on Save so the landing can
  // label the date with it.
  const zone = draft.dealEndsTimeZone ?? browserZone;
  const zoneOptions = [
    ...DEAL_TIME_ZONES,
    // Whatever the operator's browser reports (and any zone already saved)
    // must be selectable even when it's outside the curated shortlist.
    ...[browserZone, draft.dealEndsTimeZone]
      .filter(
        (id): id is string =>
          !!id &&
          isValidTimeZone(id) &&
          !DEAL_TIME_ZONES.some((z) => z.id === id),
      )
      .map((id) => ({ id, label: id.replace(/_/g, " ") })),
  ];

  const endsAtMs = draft.dealEndsAt ? Date.parse(draft.dealEndsAt) : null;
  const zoneAbbreviation = timeZoneAbbreviation(
    zone,
    endsAtMs !== null && Number.isFinite(endsAtMs) ? endsAtMs : Date.now(),
  );
  // What the landing will actually print, e.g. "31 July 2026 (AEST)".
  const deadlineDateText =
    endsAtMs !== null && Number.isFinite(endsAtMs)
      ? `${new Intl.DateTimeFormat(undefined, {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: zone,
        }).format(
          new Date(endsAtMs),
        )}${zoneAbbreviation ? ` (${zoneAbbreviation})` : ""}`
      : null;
  // The same instant in the operator's own clock — the sanity check that
  // matters when the deal is scheduled in a zone they don't live in.
  const deadlineLocalText =
    endsAtMs !== null && Number.isFinite(endsAtMs) && zone !== browserZone
      ? new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
          timeZone: browserZone,
        }).format(new Date(endsAtMs))
      : null;

  const { countdown, expired } = useCountdown(
    isCountdown && endsAtMs !== null && Number.isFinite(endsAtMs)
      ? endsAtMs
      : null,
  );

  function set<K extends keyof DealConfig>(key: K, value: DealConfig[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  /**
   * Switching zones KEEPS THE TYPED WALL CLOCK and moves the instant —
   * "11:58 PM" stays 11:58 PM, it just becomes 11:58 PM in the new zone.
   * (The alternative — holding the instant and rewriting the clock — would
   * silently turn a deliberate 11:58 PM deadline into 6:58 AM.)
   */
  function setTimeZone(nextZone: string) {
    setDraft((d) => {
      const wallClock = isoToZonedInput(
        d.dealEndsAt,
        d.dealEndsTimeZone ?? browserZone,
      );
      return {
        ...d,
        dealEndsTimeZone: nextZone,
        dealEndsAt: wallClock
          ? zonedInputToIso(wallClock, nextZone)
          : d.dealEndsAt,
      };
    });
  }

  function parseSeats(value: string): number {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < DEAL_SEATS_MIN) return DEAL_SEATS_MIN;
    return Math.min(n, DEAL_SEATS_MAX);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const committed: DealConfig = {
        dealName: draft.dealName.trim(),
        dealType: draft.dealType,
        memberNoun: draft.memberNoun.trim(),
        slotsTotal: draft.slotsTotal,
        dealEndsAt: draft.dealEndsAt,
        // Persist the EFFECTIVE zone (the browser's when none was ever
        // picked) so the landing labels the date with the same zone the
        // deadline was typed in.
        dealEndsTimeZone: zone,
        offerLabel: draft.offerLabel.trim(),
        fullPriceAfterEnd: draft.fullPriceAfterEnd,
        retailMode: draft.retailMode,
        retailBannerMessage: draft.retailBannerMessage.trim(),
      };
      const res = await fetch("/api/agency/deal-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(committed),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Save failed.");
      setDraft(committed);
      setSaved(committed);
      toast.success("Deal saved — live on the landing page.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="bg-muted/30 border-b px-5 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Deal</h2>
        <p className="text-muted-foreground mt-0.5 text-xs">
          The current campaign shown across the landing page — hero counter,
          pricing card, announcement bar, CTAs, and FAQ. Changes go live
          immediately, no deploy. Prices ($891 / $1,782) stay in code so the
          display can&apos;t drift from what Stripe charges.
        </p>
      </div>

      <div className="grid gap-6 p-5 lg:grid-cols-2">
        {/* Editor form */}
        <div className="space-y-4">
          {/* Master "end all deals" switch — sits above everything because
              it overrides the deal settings below. Turning it ON needs a
              confirm; turning it OFF is immediate. Either way it goes live
              on Save. */}
          <div
            className={cn(
              "space-y-2 rounded-lg border p-3",
              retailMode ? "border-amber-500/50 bg-amber-500/5" : "bg-muted/20",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Store className="h-3.5 w-3.5" />
                  End deals — sell at retail $1,782
                </p>
                <p className="text-muted-foreground text-xs">
                  Flips the whole landing page to the standard $1,782 price
                  right away — no waiting on a deadline or sell-out. Urgency
                  animations disappear, the banner shows your retail message,
                  and checkout charges $1,782. Everything after purchase
                  (emails, founder thank-you page) is unchanged.
                </p>
              </div>
              {retailMode ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => {
                    set("retailMode", false);
                    setConfirmingRetail(false);
                  }}
                >
                  Resume deal
                </Button>
              ) : (
                !confirmingRetail && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => setConfirmingRetail(true)}
                  >
                    End deals
                  </Button>
                )
              )}
            </div>

            {confirmingRetail && !retailMode && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5">
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  This ends the live deal and sells at $1,782 to everyone.
                  Confirm, then click <span className="font-medium">Save</span>{" "}
                  to go live.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      set("retailMode", true);
                      setConfirmingRetail(false);
                    }}
                  >
                    Yes, end the deal
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmingRetail(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {retailMode && (
              <div className="space-y-1.5 pt-1">
                <Label htmlFor="retail-banner">Retail banner message</Label>
                <Input
                  id="retail-banner"
                  value={draft.retailBannerMessage}
                  maxLength={RETAIL_BANNER_MAX}
                  onChange={(e) => set("retailBannerMessage", e.target.value)}
                  placeholder="Join the movement — stop renting your software."
                />
                <p className="text-muted-foreground text-xs">
                  Shown in the top announcement bar instead of the deal offer.{" "}
                  {draft.retailBannerMessage.trim().length}/{RETAIL_BANNER_MAX}
                </p>
                {retailBannerEmpty && (
                  <p className="text-destructive text-xs">
                    A retail banner message is required.
                  </p>
                )}
              </div>
            )}
          </div>

          {retailMode && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Retail mode is ON — the deal settings below are paused. They take
              over again the moment you resume deal pricing.
            </p>
          )}

          <div className="space-y-1.5">
            <Label>Deal type</Label>
            <div className="inline-flex rounded-lg border p-0.5">
              {(
                [
                  ["spots", "Spots counter", Zap],
                  ["countdown", "Countdown timer", Clock],
                ] as Array<[DealType, string, typeof Zap]>
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => set("dealType", value)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    draft.dealType === value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              {isCountdown
                ? "Deadline urgency: “50% off until 31 July” with a live timer. Only one mechanic shows at a time."
                : "Scarcity urgency: “7 of 25 spots claimed” with a progress bar. Only one mechanic shows at a time."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deal-name">Deal name</Label>
            <Input
              id="deal-name"
              value={draft.dealName}
              maxLength={DEAL_NAME_MAX}
              onChange={(e) => set("dealName", e.target.value)}
              placeholder="Founders X Deal"
            />
            {nameEmpty && (
              <p className="text-destructive text-xs">Deal name is required.</p>
            )}
          </div>

          {!isCountdown && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="deal-noun">Member noun (plural)</Label>
                <Input
                  id="deal-noun"
                  value={draft.memberNoun}
                  maxLength={DEAL_MEMBER_NOUN_MAX}
                  onChange={(e) => set("memberNoun", e.target.value)}
                  placeholder="spots"
                  className="w-48"
                />
                <p className="text-muted-foreground text-xs">
                  Used in the scarcity counter: &quot;7 of 25{" "}
                  <span className="font-medium">
                    {draft.memberNoun.trim() || "spots"}
                  </span>{" "}
                  claimed&quot;.
                </p>
                {nounEmpty && (
                  <p className="text-destructive text-xs">
                    Member noun is required.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="deal-seats">Total seats</Label>
                <Input
                  id="deal-seats"
                  type="number"
                  min={DEAL_SEATS_MIN}
                  max={DEAL_SEATS_MAX}
                  value={draft.slotsTotal}
                  onChange={(e) =>
                    set("slotsTotal", parseSeats(e.target.value))
                  }
                  className="w-32"
                />
                <p className="text-muted-foreground text-xs">
                  Sold so far:{" "}
                  <span className="text-foreground font-medium">
                    {soldCount}
                  </span>{" "}
                  — driven by Stripe purchases. Starting a fresh campaign? Reset{" "}
                  <code className="bg-muted rounded px-1 py-0.5 text-[11px]">
                    appConfig/foundersCohort.soldCount
                  </code>{" "}
                  in the Firebase console; this editor never touches it.
                </p>
                {belowSold && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    New total is below the current sold count — the landing page
                    will treat the deal as sold out (
                    {draft.fullPriceAfterEnd
                      ? "selling at the full $1,782 price"
                      : "counter hidden, buttons switch to “Buy Now” at the deal price"}
                    ).
                  </p>
                )}
              </div>
            </>
          )}

          {isCountdown && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="deal-offer-label">Offer label</Label>
                <Input
                  id="deal-offer-label"
                  value={draft.offerLabel}
                  maxLength={DEAL_OFFER_LABEL_MAX}
                  onChange={(e) => set("offerLabel", e.target.value)}
                  placeholder="50% off"
                  className="w-48"
                />
                <p className="text-muted-foreground text-xs">
                  Display copy only — shown as &quot;
                  <span className="font-medium">
                    {draft.offerLabel.trim() || "50% off"}
                  </span>{" "}
                  until [end date]&quot;. It never changes what Stripe charges.
                </p>
                {offerLabelEmpty && (
                  <p className="text-destructive text-xs">
                    Offer label is required.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="deal-ends-at">Deal ends</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="deal-ends-at"
                    type="datetime-local"
                    value={isoToZonedInput(draft.dealEndsAt, zone)}
                    onChange={(e) =>
                      set("dealEndsAt", zonedInputToIso(e.target.value, zone))
                    }
                    className="w-60"
                  />
                  <select
                    aria-label="Deal end timezone"
                    value={zone}
                    onChange={(e) => setTimeZone(e.target.value)}
                    className="border-input focus-visible:border-ring focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
                  >
                    {zoneOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-muted-foreground text-xs">
                  The time is read in the timezone you pick — switching zones
                  keeps the clock you typed and moves the actual deadline. Every
                  visitor still counts down to the same moment, and the page
                  reads &quot;
                  {draft.offerLabel.trim() || "50% off"} until{" "}
                  <span className="font-medium">
                    {deadlineDateText ?? "[end date]"}
                  </span>
                  &quot; worldwide.
                </p>
                {deadlineLocalText && (
                  <p className="text-muted-foreground text-xs">
                    That&apos;s{" "}
                    <span className="text-foreground font-medium">
                      {deadlineLocalText}
                    </span>{" "}
                    in your own timezone ({browserZone.replace(/_/g, " ")}).
                  </p>
                )}
                {endsAtMissing && (
                  <p className="text-destructive text-xs">
                    An end date is required for a countdown deal.
                  </p>
                )}
                {!endsAtMissing && expired && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {draft.fullPriceAfterEnd
                      ? "This date is in the past — the timer is hidden and the page is selling at full price ($1,782). Set a future date to relaunch the deal."
                      : "This date is in the past — the timer and urgency copy are hidden, but the landing page keeps selling at the deal price. Set a future date to relaunch."}
                  </p>
                )}
              </div>
            </>
          )}

          <div className="bg-muted/20 space-y-1.5 rounded-lg border p-3">
            <label
              htmlFor="deal-full-price-after-end"
              className="flex cursor-pointer items-start gap-2 text-sm font-medium"
            >
              <input
                id="deal-full-price-after-end"
                type="checkbox"
                checked={draft.fullPriceAfterEnd}
                onChange={(e) => set("fullPriceAfterEnd", e.target.checked)}
                className="accent-primary mt-0.5 h-4 w-4"
              />
              <span>When the deal ends, sell at full price ($1,782)</span>
            </label>
            <p className="text-muted-foreground pl-6 text-xs">
              {isCountdown
                ? "After the timer expires, CTAs switch to a $1,782 Stripe checkout with a coupon-code box. Unticked: the page keeps selling at the deal price with urgency hidden."
                : 'After the spots sell out, the pricing card\'s button opens a $1,782 Stripe checkout with a coupon-code box. Unticked: the page keeps selling at the deal price — the counter hides and buttons switch to "Buy Now".'}
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button onClick={handleSave} disabled={!canSave} size="sm">
              {saving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
            {dirty && !saving && (
              <span className="text-muted-foreground text-xs">
                Unsaved changes
              </span>
            )}
          </div>
        </div>

        {/* Preview — mirrors the pricing-card badge + urgency block */}
        <div>
          <p className="text-muted-foreground mb-2 text-xs tracking-wide uppercase">
            Live preview
          </p>
          <div className="bg-background ring-foreground/10 rounded-xl p-6 ring-1">
            {retailMode ? (
              <div className="mx-auto max-w-sm space-y-4">
                <div className="rounded-md bg-gradient-to-r from-indigo-600 via-violet-600 to-pink-600 px-3 py-2 text-center text-xs font-semibold text-white">
                  {draft.retailBannerMessage.trim() ||
                    "Join the movement — stop renting your software."}
                </div>
                <div className="flex justify-center">
                  <span className="bg-primary text-primary-foreground inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium">
                    <Zap className="h-3 w-3" />
                    {draft.dealName.trim() || "Deal name"}
                  </span>
                </div>
                <p className="text-center text-2xl font-semibold tracking-tight text-violet-600 dark:text-violet-400">
                  {draft.dealName.trim() || "Deal name"}
                </p>
                <p className="text-center">
                  <span className="text-3xl font-bold tracking-tight">
                    $1,782
                  </span>{" "}
                  <span className="text-muted-foreground text-xs">
                    one-time
                  </span>
                </p>
                <div className="bg-primary text-primary-foreground rounded-md py-2 text-center text-sm font-medium">
                  Buy Now — $1,782
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-sm space-y-5">
                <div className="flex justify-center">
                  <span className="bg-primary text-primary-foreground inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium">
                    <Zap className="h-3 w-3" />
                    {draft.dealName.trim() || "Deal name"} ·{" "}
                    {isCountdown
                      ? draft.offerLabel.trim() || "50% off"
                      : `${draft.slotsTotal} spots only`}
                  </span>
                </div>

                <p className="text-center text-2xl font-semibold tracking-tight text-violet-600 dark:text-violet-400">
                  {draft.dealName.trim() || "Deal name"}
                </p>

                {!isCountdown && (
                  <div>
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="font-medium">
                        {soldCount} of {draft.slotsTotal}{" "}
                        {draft.memberNoun.trim() || "spots"} claimed
                      </span>
                      {remaining > 0 && (
                        <span className="text-muted-foreground">
                          {remaining} left
                        </span>
                      )}
                    </div>
                    <div className="bg-foreground/10 mt-2 h-2 w-full overflow-hidden rounded-full">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-pink-500 transition-all duration-500"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  </div>
                )}

                {isCountdown &&
                  (countdown ? (
                    <div>
                      <p className="text-center text-xs font-medium">
                        {draft.offerLabel.trim() || "50% off"} — offer ends in
                      </p>
                      <DealCountdown
                        parts={countdown}
                        size="sm"
                        className="mt-2"
                      />
                      {deadlineDateText && (
                        <p className="text-muted-foreground mt-2 text-center text-[11px]">
                          {draft.offerLabel.trim() || "50% off"} until{" "}
                          {deadlineDateText}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-center text-xs">
                      {endsAtMissing
                        ? "Pick an end date to preview the timer."
                        : draft.fullPriceAfterEnd
                          ? "Timer hidden — the deadline has passed. The page is selling at full price ($1,782)."
                          : "Timer hidden — the deadline has passed. The page keeps selling without urgency."}
                    </p>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
