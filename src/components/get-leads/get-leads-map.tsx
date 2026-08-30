"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Globe2 } from "lucide-react";
import {
  Map as MapboxMap,
  Layer,
  Popup,
  Source,
  type MapMouseEvent,
  type MapRef,
} from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GetLeadsBusiness } from "@/types/get-leads";

/**
 * Get Leads results map — clustered pins for one search's businesses,
 * centered on the search origin. Amber pins = no website listed (a useful
 * signal for many services); indigo ring = selected for import. Clicking a
 * pin toggles its selection, same as the list tab's checkboxes.
 *
 * Follows the dashboard LeadsMap patterns (same clustering + imperative
 * hover wiring); kept separate because the data model and interactions
 * differ (ephemeral search results + selection, not contacts).
 */

interface PopupState {
  lat: number;
  lng: number;
  name: string;
  category: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
}

const CLUSTER_LAYER = "get-leads-clusters";
const CLUSTER_COUNT_LAYER = "get-leads-cluster-count";
const PIN_LAYER = "get-leads-pins";

/** Rough zoom so the picked radius fills the viewport. */
function zoomForRadius(radiusKm: number): number {
  if (radiusKm <= 1) return 13.5;
  if (radiusKm <= 5) return 11.5;
  if (radiusKm <= 10) return 10.7;
  if (radiusKm <= 25) return 9.5;
  return 8.5;
}

export function GetLeadsMap({
  businesses,
  origin,
  radiusKm,
  selected,
  onToggle,
}: {
  businesses: GetLeadsBusiness[];
  origin: { latitude: number; longitude: number };
  radiusKm: number;
  selected: Set<string>;
  onToggle: (placeId: string) => void;
}) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const { resolvedTheme } = useTheme();
  const mapRef = useRef<MapRef | null>(null);
  const [popup, setPopup] = useState<PopupState | null>(null);

  const located = useMemo(
    () =>
      businesses.filter(
        (b) => b.latitude !== null && b.longitude !== null,
      ),
    [businesses],
  );

  const geojson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: located.map((b) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [b.longitude as number, b.latitude as number],
        },
        properties: {
          placeId: b.placeId,
          name: b.name,
          category: b.category,
          phone: b.phone,
          website: b.website,
          email: b.email,
          noWebsite: !b.website,
          selected: selected.has(b.placeId),
        },
      })),
    }),
    [located, selected],
  );

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const setPointer = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const clearPointer = () => {
      map.getCanvas().style.cursor = "";
    };

    const onPinEnter = (e: MapMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const [lng, lat] = feature.geometry.coordinates as [number, number];
      const p = feature.properties ?? {};
      setPopup({
        lng,
        lat,
        name: String(p.name ?? "Unknown"),
        category: p.category ? String(p.category) : null,
        phone: p.phone ? String(p.phone) : null,
        website: p.website ? String(p.website) : null,
        email: p.email ? String(p.email) : null,
      });
      setPointer();
    };
    const onPinLeave = () => {
      setPopup(null);
      clearPointer();
    };

    map.on("mouseenter", PIN_LAYER, onPinEnter);
    map.on("mouseleave", PIN_LAYER, onPinLeave);
    map.on("mouseenter", CLUSTER_LAYER, setPointer);
    map.on("mouseleave", CLUSTER_LAYER, clearPointer);

    return () => {
      map.off("mouseenter", PIN_LAYER, onPinEnter);
      map.off("mouseleave", PIN_LAYER, onPinLeave);
      map.off("mouseenter", CLUSTER_LAYER, setPointer);
      map.off("mouseleave", CLUSTER_LAYER, clearPointer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, located.length > 0]);

  if (!token) {
    return (
      <div className="flex aspect-[16/9] items-center justify-center rounded-lg border border-dashed bg-background p-6 text-center text-sm text-muted-foreground">
        <div className="max-w-md space-y-2">
          <Globe2 className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <p>
            Add{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              NEXT_PUBLIC_MAPBOX_TOKEN
            </code>{" "}
            to render the map. The list tab works without it.
          </p>
        </div>
      </div>
    );
  }

  const styleUrl =
    resolvedTheme === "dark"
      ? "mapbox://styles/mapbox/dark-v11"
      : "mapbox://styles/mapbox/light-v11";

  function handleClick(e: MapMouseEvent) {
    const feature = e.features?.[0];
    if (!feature || !feature.properties) return;
    const coords =
      feature.geometry.type === "Point"
        ? (feature.geometry.coordinates as [number, number])
        : null;
    if (!coords) return;

    if (feature.properties.cluster) {
      const currentZoom = mapRef.current?.getZoom() ?? 2;
      mapRef.current?.flyTo({
        center: coords,
        zoom: Math.min(currentZoom + 2, 16),
        duration: 500,
      });
      return;
    }
    const placeId = feature.properties.placeId;
    if (placeId) onToggle(String(placeId));
  }

  return (
    <div className="aspect-[16/9] overflow-hidden rounded-lg border">
      <MapboxMap
        ref={mapRef}
        mapboxAccessToken={token}
        initialViewState={{
          longitude: origin.longitude,
          latitude: origin.latitude,
          zoom: zoomForRadius(radiusKm),
        }}
        mapStyle={styleUrl}
        interactiveLayerIds={[CLUSTER_LAYER, PIN_LAYER]}
        onClick={handleClick}
        reuseMaps
      >
        <Source
          id="get-leads"
          type="geojson"
          data={geojson}
          cluster
          clusterRadius={40}
          clusterMaxZoom={13}
        >
          <Layer
            id={CLUSTER_LAYER}
            type="circle"
            filter={["has", "point_count"]}
            paint={{
              "circle-color": [
                "step",
                ["get", "point_count"],
                "#6366f1",
                10,
                "#8b5cf6",
                25,
                "#ec4899",
              ],
              "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 25, 28],
              "circle-stroke-width": 2,
              "circle-stroke-color": "rgba(255,255,255,0.9)",
            }}
          />
          <Layer
            id={CLUSTER_COUNT_LAYER}
            type="symbol"
            filter={["has", "point_count"]}
            layout={{
              "text-field": ["get", "point_count_abbreviated"],
              "text-size": 12,
              "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
            }}
            paint={{ "text-color": "#ffffff" }}
          />
          <Layer
            id={PIN_LAYER}
            type="circle"
            filter={["!", ["has", "point_count"]]}
            paint={{
              // Amber = no website (prime web-services lead); emerald = has one.
              "circle-color": [
                "case",
                ["get", "noWebsite"],
                "#f59e0b",
                "#10b981",
              ],
              "circle-radius": 7,
              // Indigo ring marks pins selected for import.
              "circle-stroke-width": ["case", ["get", "selected"], 3, 2],
              "circle-stroke-color": [
                "case",
                ["get", "selected"],
                "#6366f1",
                "rgba(255,255,255,0.95)",
              ],
            }}
          />
        </Source>

        {popup && (
          <Popup
            longitude={popup.lng}
            latitude={popup.lat}
            anchor="bottom"
            closeButton={false}
            closeOnClick={false}
            offset={12}
          >
            <div className="space-y-1 text-xs">
              <p className="font-semibold text-foreground">{popup.name}</p>
              {popup.category && (
                <p className="text-muted-foreground">{popup.category}</p>
              )}
              {popup.phone && <p className="tabular-nums">{popup.phone}</p>}
              {popup.email && <p className="break-all">{popup.email}</p>}
              <p
                className={
                  popup.website
                    ? "text-muted-foreground"
                    : "font-medium text-amber-600 dark:text-amber-400"
                }
              >
                {popup.website ? "Has website" : "No website listed"}
              </p>
              <p className="border-t pt-1 text-[11px] italic text-muted-foreground">
                Click pin to select for import
              </p>
            </div>
          </Popup>
        )}
      </MapboxMap>
    </div>
  );
}
