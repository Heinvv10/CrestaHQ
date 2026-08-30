"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ImageIcon,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SECTION_META, sectionMeta } from "@/lib/funnels/sections";
import { normaliseVideoUrl } from "@/lib/funnels/video";
import {
  MAX_SECTION_ITEMS,
  type FunnelSection,
  type FunnelSectionBackground,
  type FunnelSectionType,
} from "@/types/funnels";

const BANDS: { id: FunnelSectionBackground; label: string }[] = [
  { id: "default", label: "Plain" },
  { id: "muted", label: "Grey" },
  { id: "dark", label: "Dark" },
  { id: "accent", label: "Accent" },
  { id: "accentSoft", label: "Tint" },
];

/**
 * Section list editor for the funnel builder.
 *
 * Reorder is up/down buttons, not drag-and-drop — keyboard-accessible, works
 * on touch, and no dependency. On a 6-10 section page it's no slower to use.
 *
 * Field visibility is driven by SECTION_META.uses, so a section only shows the
 * inputs it actually renders. That's what stops this becoming fourteen
 * bespoke forms.
 */

const ITEM_LABELS: Record<
  NonNullable<ReturnType<typeof sectionMeta>["uses"]["items"]>,
  { title: string; body?: string; meta?: string; add: string }
> = {
  bullets: { title: "Bullet", add: "Add bullet" },
  features: { title: "Feature", body: "Description", add: "Add feature" },
  testimonials: {
    title: "Quote",
    body: "Name",
    meta: "Role / company",
    add: "Add testimonial",
  },
  faq: { title: "Question", body: "Answer", add: "Add question" },
  logos: { title: "Name", meta: "Logo image URL (optional)", add: "Add name" },
  steps: { title: "Step title", body: "What happens", add: "Add step" },
  stats: { title: "Number (e.g. 4 weeks)", body: "What it means", add: "Add number" },
  comparison: {
    title: "Without this",
    body: "With this",
    add: "Add comparison row",
  },
  pricing: {
    title: "Tier name",
    body: "What's included (one per line)",
    meta: "Price, e.g. $497",
    add: "Add tier",
  },
};

export function SectionEditor({
  sections,
  onChange,
  subAccountId,
}: {
  sections: FunnelSection[];
  onChange: (next: FunnelSection[]) => void;
  subAccountId: string;
}) {
  function update(i: number, patch: Partial<FunnelSection>) {
    onChange(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  function remove(i: number) {
    onChange(sections.filter((_, j) => j !== i));
  }
  function add(type: FunnelSectionType) {
    const meta = sectionMeta(type);
    onChange([
      ...sections,
      {
        id: `s${Date.now().toString(36)}`,
        type,
        heading: "",
        subheading: "",
        body: "",
        items: meta.uses.items ? [{ title: "", body: "", meta: "" }] : [],
        mediaUrl: null,
        ctaLabel: meta.uses.cta ? "Get started" : "",
        deadline: null,
      },
    ]);
  }

  return (
    <div className="space-y-3">
      {sections.map((s, i) => {
        const meta = sectionMeta(s.type);
        const itemCfg = meta.uses.items ? ITEM_LABELS[meta.uses.items] : null;
        const videoBad =
          meta.uses.media === "video" &&
          !!s.mediaUrl &&
          !normaliseVideoUrl(s.mediaUrl);

        return (
          <div key={s.id} className="rounded-lg border bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{meta.label}</p>
                <p className="text-[11px] text-muted-foreground">{meta.hint}</p>
                {/* Band picker. The contrast BETWEEN sections is what makes a
                    funnel page read as designed rather than as a document. */}
                <div className="mt-2 flex flex-wrap gap-1">
                  {BANDS.map((bnd) => (
                    <button
                      key={bnd.id}
                      type="button"
                      onClick={() => update(i, { background: bnd.id })}
                      className={
                        (s.background ?? "default") === bnd.id
                          ? "rounded px-1.5 py-0.5 text-[10px] font-medium bg-primary text-primary-foreground ring-1 ring-primary"
                          : "rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-muted"
                      }
                    >
                      {bnd.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => move(i, 1)}
                  disabled={i === sections.length - 1}
                  title="Move down"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => remove(i)}
                  title="Remove section"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="space-y-2.5">
              {meta.uses.heading && (
                <Input
                  value={s.heading}
                  onChange={(e) => update(i, { heading: e.target.value })}
                  placeholder="Heading"
                />
              )}
              {meta.uses.subheading && (
                <Input
                  value={s.subheading}
                  onChange={(e) => update(i, { subheading: e.target.value })}
                  placeholder="Subheading"
                />
              )}
              {meta.uses.body && (
                <Textarea
                  rows={3}
                  value={s.body}
                  onChange={(e) => update(i, { body: e.target.value })}
                  placeholder="Text"
                />
              )}
              {meta.uses.media && (
                <div className="space-y-1">
                  <Input
                    value={s.mediaUrl ?? ""}
                    onChange={(e) =>
                      update(i, { mediaUrl: e.target.value || null })
                    }
                    placeholder={
                      meta.uses.media === "video"
                        ? "https://youtube.com/watch?v=…"
                        : "https://… image URL"
                    }
                  />
                  {videoBad && (
                    <p className="text-[11px] text-destructive">
                      Not a supported video link — use YouTube, Vimeo, Loom or
                      Wistia. It will be dropped on save.
                    </p>
                  )}
                </div>
              )}
              {meta.uses.media === "image" && (
                <StockPicker
                  subAccountId={subAccountId}
                  query={s.imageQuery ?? ""}
                  onQuery={(q) => update(i, { imageQuery: q })}
                  onPick={(url) => update(i, { mediaUrl: url })}
                />
              )}
              {(s.type === "hero" || s.type === "cta") && (
                <Input
                  value={s.badge ?? ""}
                  onChange={(e) => update(i, { badge: e.target.value })}
                  placeholder="Eyebrow pill above the heading — keep it short and true (optional)"
                />
              )}
              {(s.type === "hero" || s.type === "image") && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={s.mediaAsBackground === true}
                    onChange={(e) =>
                      update(i, { mediaAsBackground: e.target.checked })
                    }
                    className="mt-0.5"
                  />
                  <span className="text-xs text-muted-foreground">
                    Use the image as a full-width background — a dark overlay
                    keeps the text readable on any photo.
                  </span>
                </label>
              )}
              {s.type === "story" && (
                <Input
                  value={s.attribution ?? ""}
                  onChange={(e) => update(i, { attribution: e.target.value })}
                  placeholder="Byline — e.g. From: Sam, head coach"
                />
              )}
              {s.type === "pricing" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={s.compareAt ?? ""}
                    onChange={(e) => update(i, { compareAt: e.target.value })}
                    placeholder="Anchor price — e.g. Normally $1,997"
                  />
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={s.scarcityPercent ?? ""}
                    onChange={(e) =>
                      update(i, {
                        scarcityPercent: e.target.value
                          ? Number(e.target.value)
                          : null,
                      })
                    }
                    placeholder="% claimed (real numbers only)"
                  />
                </div>
              )}
              {meta.uses.deadline && (
                <div className="space-y-1">
                  <Label className="text-xs">Deadline</Label>
                  <Input
                    type="datetime-local"
                    value={s.deadline ?? ""}
                    onChange={(e) =>
                      update(i, { deadline: e.target.value || null })
                    }
                  />
                </div>
              )}
              {meta.uses.cta && (
                <Input
                  value={s.ctaLabel}
                  onChange={(e) => update(i, { ctaLabel: e.target.value })}
                  placeholder="Button label"
                />
              )}

              {itemCfg && (
                <div className="space-y-2">
                  {s.items.map((it, k) => (
                    <div
                      key={k}
                      className="space-y-1.5 rounded-md border bg-background p-2.5"
                    >
                      <div className="flex gap-2">
                        <Input
                          value={it.title}
                          onChange={(e) =>
                            update(i, {
                              items: s.items.map((x, m) =>
                                m === k ? { ...x, title: e.target.value } : x,
                              ),
                            })
                          }
                          placeholder={itemCfg.title}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            update(i, {
                              items: s.items.filter((_, m) => m !== k),
                            })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {itemCfg.body && (
                        <Textarea
                          rows={2}
                          value={it.body}
                          onChange={(e) =>
                            update(i, {
                              items: s.items.map((x, m) =>
                                m === k ? { ...x, body: e.target.value } : x,
                              ),
                            })
                          }
                          placeholder={itemCfg.body}
                        />
                      )}
                      {itemCfg.meta && (
                        <Input
                          value={it.meta}
                          onChange={(e) =>
                            update(i, {
                              items: s.items.map((x, m) =>
                                m === k ? { ...x, meta: e.target.value } : x,
                              ),
                            })
                          }
                          placeholder={itemCfg.meta}
                        />
                      )}
                      {(s.type === "testimonials" || s.type === "pricing") && (
                        <div className="grid gap-2 sm:grid-cols-3">
                          {s.type === "testimonials" && (
                            <Input
                              type="number"
                              min={1}
                              max={5}
                              value={it.rating ?? ""}
                              onChange={(e) =>
                                update(i, {
                                  items: s.items.map((x, m) =>
                                    m === k
                                      ? {
                                          ...x,
                                          rating: e.target.value
                                            ? Number(e.target.value)
                                            : null,
                                        }
                                      : x,
                                  ),
                                })
                              }
                              placeholder="Stars 1-5"
                            />
                          )}
                          <Input
                            value={it.result ?? ""}
                            onChange={(e) =>
                              update(i, {
                                items: s.items.map((x, m) =>
                                  m === k ? { ...x, result: e.target.value } : x,
                                ),
                              })
                            }
                            placeholder={
                              s.type === "pricing"
                                ? "Was — e.g. $997"
                                : "Result — e.g. +12kg in 8 weeks"
                            }
                          />
                          {s.type === "testimonials" && (
                            <Input
                              value={it.imageUrl ?? ""}
                              onChange={(e) =>
                                update(i, {
                                  items: s.items.map((x, m) =>
                                    m === k
                                      ? { ...x, imageUrl: e.target.value || null }
                                      : x,
                                  ),
                                })
                              }
                              placeholder="Photo URL (https)"
                            />
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {s.items.length < MAX_SECTION_ITEMS && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        update(i, {
                          items: [...s.items, { title: "", body: "", meta: "" }],
                        })
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {itemCfg.add}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}

      <div className="rounded-lg border border-dashed p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Add a section
        </p>
        <div className="flex flex-wrap gap-1.5">
          {SECTION_META.map((m) => (
            <Button
              key={m.type}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => add(m.type)}
            >
              <Plus className="h-3 w-3" />
              {m.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-section stock photo picker.
 *
 * The brief ("gym barbell training") stays on the section after a photo is
 * chosen, so re-rolling the image later is one click rather than re-deciding
 * what it should show. With no provider key configured the server returns an
 * empty list and a note — shown as guidance, not an error, because stock
 * search is an optional integration.
 */
function StockPicker({
  subAccountId,
  query,
  onQuery,
  onPick,
}: {
  subAccountId: string;
  query: string;
  onQuery: (q: string) => void;
  onPick: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<{ url: string; credit: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);

  async function search() {
    if (!query.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/funnels/stock-images?q=${encodeURIComponent(query)}`,
      );
      const d = (await res.json().catch(() => ({}))) as {
        images?: { url: string; credit: string }[];
        configured?: boolean;
      };
      setHits(d.images ?? []);
      if (!d.images?.length) {
        setNote(
          d.configured
            ? "No matches — try different words."
            : "Stock search isn't set up on this deployment. Paste an image URL above instead.",
        );
      }
    } catch {
      setNote("Couldn't search right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5 rounded-md border border-dashed p-2.5">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Photo idea — e.g. gym barbell training"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={search}
          disabled={busy || !query.trim()}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ImageIcon className="h-3.5 w-3.5" />
          )}
          Find
        </Button>
      </div>
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
      {hits.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5">
          {hits.map((h) => (
            <button
              key={h.url}
              type="button"
              onClick={() => onPick(h.url)}
              title={h.credit}
              className="overflow-hidden rounded border hover:ring-2 hover:ring-primary"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={h.url}
                alt={h.credit}
                className="h-16 w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
