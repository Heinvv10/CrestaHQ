"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

interface PickableModel {
  id: string;
  name: string;
  promptPerM: number | null;
  completionPerM: number | null;
}

interface Pickable {
  defaultModel: string;
  models: PickableModel[];
  /** channel → stored model OpenRouter last refused on a live reply. */
  rejected: Record<string, string>;
}

const NATIVE_SELECT_CLASSES =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_option]:bg-background [&_option]:text-foreground";

function price(m: PickableModel): string {
  if (m.promptPerM === null || m.completionPerM === null) return " — price unknown";
  return ` — $${m.promptPerM}/$${m.completionPerM} per 1M in/out`;
}

/**
 * Model override picker for an AI Agents channel. Lists only the models the
 * agency allows (and OpenRouter still offers). A stored pick that is no
 * longer listed stays selected with a warning, so saving other settings
 * doesn't silently change it. If OpenRouter refused it on a live reply, the
 * warning says replies are on the default.
 */
export function ModelOverrideSelect({
  id,
  subAccountId,
  channel,
  value,
  onChange,
}: {
  id: string;
  subAccountId: string;
  /** aiAgent channel doc id — for the "OpenRouter refused it" flag. */
  channel: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [pickable, setPickable] = useState<Pickable | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/sub-accounts/${subAccountId}/ai-agent/models`);
        if (!res.ok) throw new Error(`models ${res.status}`);
        const d = (await res.json()) as Pickable;
        if (alive) setPickable(d);
      } catch (err) {
        console.warn("[model-override-select] load failed", err);
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [subAccountId]);

  const current = value.trim();
  // Keep the stored value visible even when the list couldn't load.
  const unlisted =
    !!current &&
    current !== pickable?.defaultModel &&
    !pickable?.models.some((m) => m.id === current);
  const unavailable = !!pickable && unlisted;
  const refused = !!current && pickable?.rejected?.[channel] === current;

  return (
    <div className="space-y-1.5">
      <select
        id={id}
        value={current}
        onChange={(e) => onChange(e.target.value)}
        disabled={!pickable}
        className={NATIVE_SELECT_CLASSES}
      >
        <option value="">
          {pickable ? `Default (${pickable.defaultModel})` : "Default"}
        </option>
        {unlisted && (
          <option value={current}>
            {current}
            {unavailable ? " (unavailable)" : ""}
          </option>
        )}
        {pickable?.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {price(m)}
          </option>
        ))}
      </select>
      {failed && (
        <p className="text-[11px] text-muted-foreground">
          Couldn&rsquo;t load the allowed models. Reload to try again.
        </p>
      )}
      {(unavailable || refused) && pickable && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {refused ? (
              <>
                OpenRouter refused <code>{current}</code> on a live reply, so
                replies are falling back to the default (
                {pickable.defaultModel}). Pick another model.
              </>
            ) : (
              <>
                <code>{current}</code> is no longer on the list — retired by
                OpenRouter or not allowed by your agency. Pick another model
                before OpenRouter stops accepting it.
              </>
            )}
          </span>
        </p>
      )}
    </div>
  );
}
