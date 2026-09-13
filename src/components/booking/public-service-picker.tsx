"use client";

import { Clock } from "lucide-react";
import type { BookingService } from "@/types/booking";

/** Service pages on the public booking view: the visitor picks one first. */
export function PublicServicePicker({
  services,
  selectedId,
  onPick,
  accentStyle,
}: {
  services: BookingService[];
  selectedId: string | null;
  onPick: (id: string) => void;
  accentStyle: React.CSSProperties;
}) {
  return (
    <section className="space-y-2" aria-label="Services">
      <h2 className="text-center text-sm font-semibold">Choose a service</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {services.map((s) => {
          const selected = s.id === selectedId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s.id)}
              aria-pressed={selected}
              className={`rounded-xl border p-3 text-left transition ${
                selected
                  ? "text-white shadow-sm"
                  : "border-input bg-background hover:bg-muted"
              }`}
              style={selected ? { backgroundColor: "#0F766E", ...accentStyle } : undefined}
            >
              <span className="block text-sm font-medium">{s.name}</span>
              <span className="mt-0.5 inline-flex items-center gap-1 text-xs opacity-80">
                <Clock className="h-3 w-3" />
                {s.durationMinutes} minutes
              </span>
              {s.description && (
                <span className="mt-1 block text-xs opacity-80">{s.description}</span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
