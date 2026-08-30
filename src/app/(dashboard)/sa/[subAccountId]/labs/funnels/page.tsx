"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Lock,
  Plus,
  Route,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToFunnels } from "@/lib/firestore/funnels";
import { subscribeToCheckoutPages } from "@/lib/firestore/checkout-pages";
import { subscribeToProducts } from "@/lib/firestore/products";
import { SectionEditor } from "@/components/funnels/section-editor";
import {
  sectionsFromLegacyLanding,
  templateSections,
  emptySection,
} from "@/lib/funnels/sections";
import { formatCurrency } from "@/lib/format";
import { FONT_PRESETS } from "@/lib/funnels/typography";
import {
  applyAiEditOps,
  type AiEditOp,
  type AiEditPageState,
} from "@/lib/funnels/ai-edit-apply";
import { FUNNEL_TEMPLATES, funnelTemplate } from "@/lib/funnels/templates";
import {
  defaultFunnelStyle,
  slugifyFunnelSlug,
  type Funnel,
  type FunnelSection,
  type FunnelTemplateKey,
} from "@/types/funnels";
import type { CheckoutPage } from "@/types/checkout-pages";
import type { Product } from "@/types/products";

/**
 * Funnel builder — Labs experiment.
 *
 * A sectioned form, not a canvas. Same deliberate choice as the website
 * builder: a free-canvas editor invites comparison with ClickFunnels on their
 * strongest axis, and a template-plus-form actually ships.
 *
 * The offer step REFERENCES a checkout page rather than defining a price, so
 * there's exactly one money path in the codebase.
 */

export default function FunnelsPage() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, subAccount, isAdmin, saPath } = useSubAccount();

  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [checkoutPages, setCheckoutPages] = useState<CheckoutPage[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const labsOn = subAccount?.labsEnabledByAgency === true;
  // App root host for vanity-subdomain display (NEXT_PUBLIC_* is inlined
  // client-side). Null on localhost / unset, which simply hides the links.
  const rootHost = (() => {
    try {
      const h = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").hostname;
      const stripped = h.replace(/^www\./, "");
      return stripped === "localhost" ? null : stripped;
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    if (authLoading || !user || !subAccountId || !labsOn) return;
    const unsubF = subscribeToFunnels(subAccountId, setFunnels);
    const unsubC = subscribeToCheckoutPages(subAccountId, setCheckoutPages);
    const unsubP = subAccount?.agencyId
      ? subscribeToProducts(
          { agencyId: subAccount.agencyId, subAccountId },
          setProducts,
        )
      : () => {};
    return () => {
      unsubF();
      unsubC();
      unsubP();
    };
  }, [authLoading, user, subAccountId, labsOn, subAccount?.agencyId]);

  if (!labsOn) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <section className="rounded-2xl border border-dashed bg-card/50 p-8 text-center">
          <Lock className="mx-auto h-5 w-5 text-muted-foreground" />
          <h1 className="mt-3 text-lg font-semibold">Quick Funnels</h1>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Labs is locked for this workspace. Ask your agency owner to enable
            it from the sub-account&apos;s Manage panel.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <Link
          href={saPath("/labs")}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Labs
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Quick Funnels</h1>
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
              Experimental
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            A pitch page, your checkout, and a thank-you — on a hosted link. Fill
            the form, pick a template, publish.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New funnel
          </Button>
        )}
      </div>

      {(creating || editingId) && (
        <FunnelEditor
          subAccountId={subAccountId}
          checkoutPages={checkoutPages}
          products={products}
          funnel={funnels.find((f) => f.id === editingId) ?? null}
          onDone={() => {
            setCreating(false);
            setEditingId(null);
          }}
        />
      )}

      {funnels.length === 0 && !creating ? (
        <div className="rounded-2xl border border-dashed p-10 text-center">
          <Route className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No funnels yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one to get a hosted offer page you can send traffic to.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {funnels.map((f) => (
            <div key={f.id} className="rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{f.name}</span>
                    <span
                      className={
                        f.status === "published"
                          ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400"
                          : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                      }
                    >
                      {f.status}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {funnelTemplate(f.template).label}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    /fn/{subAccountId}/{f.slug}
                  </p>
                  {/* The vanity URL is shown as its own link rather than
                      replacing the path link above — the path URL always
                      works, while the subdomain depends on the one-time
                      wildcard DNS record being in place. */}
                  {f.subdomain && rootHost && (
                    <a
                      href={`https://${f.subdomain}.${rootHost}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 block truncate text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      https://{f.subdomain}.{rootHost}
                    </a>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {f.status === "published" && (
                    <a
                      href={`/fn/${subAccountId}/${f.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                      title="Open funnel"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                  {isAdmin && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setCreating(false);
                        setEditingId(f.id);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FunnelEditor({
  subAccountId,
  checkoutPages,
  products,
  funnel,
  onDone,
}: {
  subAccountId: string;
  checkoutPages: CheckoutPage[];
  products: Product[];
  funnel: Funnel | null;
  onDone: () => void;
}) {
  const editing = !!funnel;
  const tpl = funnelTemplate(funnel?.template ?? "simple_offer");

  const [template, setTemplate] = useState<FunnelTemplateKey>(tpl.key);
  const [name, setName] = useState(funnel?.name ?? "");
  const [slug, setSlug] = useState(funnel?.slug ?? "");
  // Sections replace the old flat landing fields. Existing funnels are
  // migrated on open so nothing is lost.
  const [sections, setSections] = useState<FunnelSection[]>(() => {
    if (funnel?.sections?.length) return funnel.sections;
    if (funnel) return sectionsFromLegacyLanding(funnel.landing);
    return templateSections(tpl.key).map((t, i) => emptySection(t, `s${i}`));
  });
  const [productId, setProductId] = useState(funnel?.productId ?? "");
  const [style, setStyle] = useState(funnel?.style ?? defaultFunnelStyle());
  const [ctaSubtitle, setCtaSubtitle] = useState(funnel?.ctaSubtitle ?? "");
  const [topBanner, setTopBanner] = useState(funnel?.topBanner ?? "");
  const [stickyCta, setStickyCta] = useState(funnel?.stickyCta !== false);
  const [subdomain, setSubdomain] = useState(funnel?.subdomain ?? "");
  const [subCheck, setSubCheck] = useState<string | null>(null);

  /** Live availability probe — same validation the save enforces. */
  async function checkSubdomain() {
    if (!subdomain.trim() || !funnel) return;
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/funnels/subdomain-check?name=${encodeURIComponent(subdomain)}&funnelId=${funnel.id}`,
      );
      const d = (await res.json().catch(() => ({}))) as {
        valid?: boolean;
        available?: boolean;
        hostname?: string | null;
        reason?: string | null;
      };
      if (!d.valid) setSubCheck(d.reason ?? "Invalid name.");
      else if (!d.available) setSubCheck(d.reason ?? "Taken.");
      else
        setSubCheck(
          d.hostname
            ? `Available — will publish at https://${d.hostname}`
            : "Available.",
        );
    } catch {
      setSubCheck("Couldn't check right now.");
    }
  }

  const [checkoutPageId, setCheckoutPageId] = useState(
    funnel?.checkoutPageId ?? "",
  );
  const [ctaUrl, setCtaUrl] = useState(funnel?.ctaUrl ?? "");
  const [thanksHeadline, setThanksHeadline] = useState(
    funnel?.thanks.headline ?? tpl.thanks.headline,
  );
  const [thanksBody, setThanksBody] = useState(
    funnel?.thanks.body ?? tpl.thanks.body,
  );
  const [redirectUrl, setRedirectUrl] = useState(
    funnel?.thanks.redirectUrl ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ── AI drafter ("magic wand") ─────────────────────────────────────
  const [wandOpen, setWandOpen] = useState(false);
  const [wandWhat, setWandWhat] = useState("");
  const [wandUrl, setWandUrl] = useState("");
  const [wandBusy, setWandBusy] = useState(false);
  const [wandNote, setWandNote] = useState<string | null>(null);

  // ── Prompt-based AI editing ───────────────────────────────────────
  // Ops applied to LOCAL form state only — review, then Save. One-level
  // undo restores the snapshot taken just before the ops were applied.
  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditText, setAiEditText] = useState("");
  const [aiEditBusy, setAiEditBusy] = useState(false);
  const [aiUndo, setAiUndo] = useState<AiEditPageState | null>(null);

  function pageState(): AiEditPageState {
    return {
      sections,
      thanksHeadline,
      thanksBody,
      ctaSubtitle,
      topBanner,
      stickyCta,
      style,
    };
  }

  function restoreState(st: AiEditPageState) {
    setSections(st.sections);
    setThanksHeadline(st.thanksHeadline);
    setThanksBody(st.thanksBody);
    setCtaSubtitle(st.ctaSubtitle);
    setTopBanner(st.topBanner);
    setStickyCta(st.stickyCta);
    setStyle(st.style);
  }

  async function runAiEdit() {
    if (!aiEditText.trim()) return;
    setAiEditBusy(true);
    try {
      const before = pageState();
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/funnels/edit-draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: aiEditText.trim(),
            state: before,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        ops?: AiEditOp[];
        note?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.ops) {
        throw new Error(data.error ?? "Couldn't apply the edit.");
      }
      const { state: nextState, summary } = applyAiEditOps(before, data.ops);
      restoreState(nextState);
      setAiUndo(before);
      setAiEditText("");
      toast.success(
        [data.note, ...summary].filter(Boolean).join(" ") ||
          "Applied — review, then save.",
        { duration: 8000 },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't apply.");
    } finally {
      setAiEditBusy(false);
    }
  }

  /**
   * Fills the form in place. Deliberately does NOT save or publish — this copy
   * goes on a public page under the client's brand, so a human reviews it
   * first.
   */
  async function runWand() {
    if (!wandWhat.trim()) {
      toast.error("Tell it what you're selling first.");
      return;
    }
    setWandBusy(true);
    setWandNote(null);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/funnels/draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: wandWhat.trim(),
            url: wandUrl.trim() || null,
            template,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        draft?: {
          name: string;
          ctaSubtitle?: string;
          topBanner?: string;
          sections: unknown[];
          thanksHeadline: string;
          thanksBody: string;
          researchNote: string;
        };
      };
      if (!res.ok || !data.ok || !data.draft) {
        throw new Error(data.error ?? "Couldn't draft the funnel.");
      }
      const d = data.draft;
      if (!name.trim()) setName(d.name);
      if (d.sections?.length) setSections(d.sections as FunnelSection[]);
      if (d.ctaSubtitle) setCtaSubtitle(d.ctaSubtitle);
      if (d.topBanner) setTopBanner(d.topBanner);
      setThanksHeadline(d.thanksHeadline);
      setThanksBody(d.thanksBody);
      setWandNote(d.researchNote);
      toast.success("Draft written — review and edit before publishing.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't draft.");
    } finally {
      setWandBusy(false);
    }
  }

  const effectiveSlug = slug || slugifyFunnelSlug(name);
  const activeTpl = funnelTemplate(template);
  const publishedCheckouts = useMemo(
    () => checkoutPages.filter((p) => p.status === "published"),
    [checkoutPages],
  );


  /** Swapping template on a NEW funnel re-seeds the copy; on an existing one
   *  it only changes the label, so edits aren't silently destroyed. */
  function applyTemplate(key: FunnelTemplateKey) {
    setTemplate(key);
    if (editing) return;
    const t = funnelTemplate(key);
    setSections(templateSections(key).map((x, i) => emptySection(x, `s${i}`)));
    setThanksHeadline(t.thanks.headline);
    setThanksBody(t.thanks.body);
  }

  async function save(e: FormEvent, publish?: boolean) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim() || activeTpl.label,
        slug: effectiveSlug,
        template,
        sections,
        ...(editing ? { subdomain: subdomain.trim() || null } : {}),
        style,
        ctaSubtitle: ctaSubtitle.trim(),
        topBanner: topBanner.trim(),
        stickyCta,
        productId: productId || null,
        // A product wins: the server creates/reuses a checkout page for it and
        // overwrites checkoutPageId, so don't fight it from here.
        checkoutPageId: productId ? null : checkoutPageId || null,
        ctaUrl: ctaUrl.trim() || null,
        thanks: {
          headline: thanksHeadline.trim(),
          body: thanksBody.trim(),
          redirectUrl: redirectUrl.trim() || null,
        },
      };
      if (publish !== undefined) {
        payload.status = publish ? "published" : "draft";
      }
      const res = await fetch(
        editing
          ? `/api/sub-accounts/${subAccountId}/funnels/${funnel!.id}`
          : `/api/sub-accounts/${subAccountId}/funnels`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        id?: string;
        error?: string;
        domainStatus?: string | null;
      };
      if (!res.ok || (!data.ok && !data.id)) {
        throw new Error(data.error ?? "Couldn't save the funnel.");
      }
      if (data.domainStatus) toast.info(data.domainStatus, { duration: 9000 });
      toast.success(
        publish === true
          ? "Funnel published."
          : editing
            ? "Saved."
            : "Funnel created as a draft.",
      );
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!funnel) return;
    if (!confirm(`Delete "${funnel.name}"? The public link stops working immediately. Your checkout page and any orders are untouched.`)) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/funnels/${funnel.id}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Couldn't delete.");
      toast.success("Funnel deleted.");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <form
      onSubmit={(e) => save(e)}
      className="space-y-6 rounded-2xl border bg-card p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">
          {editing ? "Edit funnel" : "New funnel"}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setWandOpen((v) => !v)}
          >
            <Wand2 className="h-3.5 w-3.5" />
            Write it for me
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAiEditOpen((v) => !v)}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Edit with AI
          </Button>
        </div>
      </div>

      {wandOpen && (
        <div className="space-y-3 rounded-lg border border-violet-500/30 bg-violet-500/5 p-4">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Draft the copy for me</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Answer these and the assistant fills the form below. It never
                saves or publishes — you review everything first.
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wand-what">
              What are you marketing and selling?
            </Label>
            <Textarea
              id="wand-what"
              rows={2}
              value={wandWhat}
              onChange={(e) => setWandWhat(e.target.value)}
              placeholder="e.g. LeadStack CRM — a white-label CRM agencies buy once and own"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wand-url">Website to research (optional)</Label>
            <Input
              id="wand-url"
              value={wandUrl}
              onChange={(e) => setWandUrl(e.target.value)}
              placeholder="leadstack.dev"
            />
            <p className="text-[11px] text-muted-foreground">
              It reads the page for real facts and tone, and pulls its photos
              into your image sections. Use a site you own or have the rights
              to — its images will appear on your funnel.
            </p>
          </div>
          {wandNote && (
            <p className="rounded-md border bg-background px-3 py-2 text-[11px] text-muted-foreground">
              {wandNote}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">
              Check every line before publishing — it writes copy, it
              can&apos;t verify claims.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={runWand}
              disabled={wandBusy || !wandWhat.trim()}
            >
              {wandBusy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Writing…
                </>
              ) : (
                <>
                  <Wand2 className="h-3.5 w-3.5" />
                  Write draft
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* ── Template ─────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Label>Template</Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {FUNNEL_TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => applyTemplate(t.key)}
              className={`rounded-lg border p-3 text-left transition ${
                template === t.key
                  ? "border-primary bg-primary/5"
                  : "hover:bg-muted/50"
              }`}
            >
              <span className="block text-sm font-medium">{t.label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                {t.description}
              </span>
            </button>
          ))}
        </div>
        {editing && (
          <p className="text-[11px] text-muted-foreground">
            Changing the template on an existing funnel won&apos;t overwrite
            your copy.
          </p>
        )}
      </div>

      {/* ── Basics ───────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="fn-name">Funnel name</Label>
          <Input
            id="fn-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Spring offer"
          />
          <p className="text-[11px] text-muted-foreground">Internal only.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fn-slug">URL slug</Label>
          <Input
            id="fn-slug"
            value={slug}
            onChange={(e) => setSlug(slugifyFunnelSlug(e.target.value))}
            placeholder="spring-offer"
          />
          <p className="truncate text-[11px] text-muted-foreground">
            /fn/{subAccountId}/{effectiveSlug || "…"}
          </p>
        </div>
      </div>

      {editing && (
        <div className="space-y-1.5">
          <Label htmlFor="fn-subdomain">Subdomain (optional)</Label>
          <div className="flex gap-2">
            <Input
              id="fn-subdomain"
              value={subdomain}
              onChange={(e) => {
                setSubdomain(
                  e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                );
                setSubCheck(null);
              }}
              placeholder="e.g. 7dsummer"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={checkSubdomain}
              disabled={!subdomain.trim()}
            >
              Check
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {subCheck ??
              "Serves this funnel at its own address (e.g. 7dsummer.yourdomain.com) instead of the long path URL. One name per funnel, first come first served. Clear the field to release it."}
          </p>
        </div>
      )}

      {aiEditOpen && (
        <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
          <div>
            <p className="text-sm font-medium">Tell it what to change</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              e.g. &ldquo;add a second features section after the steps&rdquo;,
              &ldquo;change every button to Start Today&rdquo;, &ldquo;shorten
              the story&rdquo;. Changes apply to the form below — nothing is
              saved until you save.
            </p>
          </div>
          <Textarea
            rows={2}
            value={aiEditText}
            onChange={(e) => setAiEditText(e.target.value)}
            placeholder="What should change?"
          />
          <div className="flex items-center justify-between gap-3">
            {aiUndo ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  restoreState(aiUndo);
                  setAiUndo(null);
                  toast.success("Reverted the last AI edit.");
                }}
              >
                Undo last AI edit
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              size="sm"
              onClick={runAiEdit}
              disabled={aiEditBusy || !aiEditText.trim()}
            >
              {aiEditBusy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Applying…
                </>
              ) : (
                "Apply"
              )}
            </Button>
          </div>
        </div>
      )}

      {/* ── Look ─────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
        <div>
          <p className="text-sm font-semibold">Look</p>
          <p className="text-xs text-muted-foreground">
            Type and scale do more for how a funnel reads than any single
            section. Big condensed headings are what sales pages actually use.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Font pairing</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {FONT_PRESETS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setStyle({ ...style, fontPair: f.key })}
                className={
                  style.fontPair === f.key
                    ? "rounded-lg border border-primary bg-primary/5 p-2.5 text-left"
                    : "rounded-lg border p-2.5 text-left hover:bg-muted/50"
                }
              >
                <span className="block text-sm font-medium">{f.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {f.hint}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="fn-scale">Heading size</Label>
            <input
              id="fn-scale"
              type="range"
              min={0.8}
              max={1.6}
              step={0.05}
              value={style.headingScale}
              onChange={(e) =>
                setStyle({ ...style, headingScale: Number(e.target.value) })
              }
              className="w-full"
            />
            <p className="text-[11px] text-muted-foreground">
              {Math.round(46 * style.headingScale)}px headline
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fn-width">Page width</Label>
            <input
              id="fn-width"
              type="range"
              min={600}
              max={1040}
              step={20}
              value={style.contentWidth}
              onChange={(e) =>
                setStyle({ ...style, contentWidth: Number(e.target.value) })
              }
              className="w-full"
            />
            <p className="text-[11px] text-muted-foreground">
              {style.contentWidth}px
            </p>
          </div>
          <label className="flex items-start gap-2 pt-6 text-sm">
            <input
              type="checkbox"
              checked={style.uppercaseHeadings}
              onChange={(e) =>
                setStyle({ ...style, uppercaseHeadings: e.target.checked })
              }
              className="mt-0.5"
            />
            <span>UPPERCASE headings</span>
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="fn-banner">Top banner</Label>
            <Input
              id="fn-banner"
              value={topBanner}
              onChange={(e) => setTopBanner(e.target.value)}
              placeholder="e.g. Doors close Friday — leave empty for no banner"
            />
            <p className="text-[11px] text-muted-foreground">
              Thin accent strip above the page. Clearing the text removes it.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fn-ctasub">Button subtitle</Label>
            <Input
              id="fn-ctasub"
              value={ctaSubtitle}
              onChange={(e) => setCtaSubtitle(e.target.value)}
              placeholder="e.g. Starts Monday · 12 spots"
            />
            <p className="text-[11px] text-muted-foreground">
              Second line inside every button. Only say something true.
            </p>
          </div>
          <label className="flex items-start gap-2 pt-7 text-sm">
            <input
              type="checkbox"
              checked={stickyCta}
              onChange={(e) => setStickyCta(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Sticky button bar
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                Always-visible CTA pinned to the bottom of the page.
              </span>
            </span>
          </label>
        </div>
      </div>

      {/* ── Step 1: the page ─────────────────────────────────────── */}
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold">Step 1 · The page</p>
          <p className="text-xs text-muted-foreground">
            Add, reorder and remove sections. This is what visitors see before
            they click through to checkout.
          </p>
        </div>
        <SectionEditor
            sections={sections}
            onChange={setSections}
            subAccountId={subAccountId}
          />
      </div>

      {/* ── Step 2: the offer ────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
        <p className="text-sm font-semibold">Step 2 · Where the button goes</p>

        <div className="space-y-1.5">
          <Label htmlFor="fn-product">Sell a product</Label>
          <select
            id="fn-product"
            value={productId}
            onChange={(e) => {
              setProductId(e.target.value);
              if (e.target.value) setCheckoutPageId("");
            }}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm [&_option]:bg-background [&_option]:text-foreground"
          >
            <option value="">Choose a product…</option>
            {products
              .filter((pr) => pr.active)
              .map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name} —{" "}
                  {formatCurrency(pr.unitPriceCents / 100, pr.currency)}
                </option>
              ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            Simplest option. Saving creates a checkout page for this product
            (you&apos;ll find it under Checkout, where you can add order bumps
            later).
          </p>
        </div>

        {!productId && (
        <div className="space-y-1.5">
          <Label htmlFor="fn-checkout">…or an existing checkout page</Label>
          <select
            id="fn-checkout"
            value={checkoutPageId}
            onChange={(e) => setCheckoutPageId(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm [&_option]:bg-background [&_option]:text-foreground"
          >
            <option value="">None — use a link instead</option>
            {publishedCheckouts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            Only published checkout pages appear here. Order bumps, payment and
            reporting all come from the checkout page — this funnel just points
            at it.
          </p>
        </div>
        )}
        {!checkoutPageId && !productId && (
          <div className="space-y-1.5">
            <Label htmlFor="fn-ctaurl">CTA link</Label>
            <Input
              id="fn-ctaurl"
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="https://… (booking page, form, download)"
            />
          </div>
        )}
      </div>

      {/* ── Step 3: thank you ────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
        <p className="text-sm font-semibold">Step 3 · Thank you</p>
        <div className="space-y-1.5">
          <Label htmlFor="fn-th">Headline</Label>
          <Input
            id="fn-th"
            value={thanksHeadline}
            onChange={(e) => setThanksHeadline(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fn-tb">Message</Label>
          <Textarea
            id="fn-tb"
            rows={3}
            value={thanksBody}
            onChange={(e) => setThanksBody(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fn-redirect">Redirect after 5s (optional)</Label>
          <Input
            id="fn-redirect"
            value={redirectUrl}
            onChange={(e) => setRedirectUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {editing && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-destructive"
            onClick={remove}
            disabled={deleting || saving}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="outline" disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            "Save draft"
          )}
        </Button>
        {editing && funnel!.status !== "published" && (
          <Button type="button" onClick={(e) => save(e, true)} disabled={saving}>
            Publish
          </Button>
        )}
        {editing && funnel!.status === "published" && (
          <Button
            type="button"
            variant="outline"
            onClick={(e) => save(e, false)}
            disabled={saving}
          >
            Unpublish
          </Button>
        )}
      </div>
    </form>
  );
}
