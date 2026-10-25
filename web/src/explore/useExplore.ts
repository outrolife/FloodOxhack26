// The Explore state (#118), lifted to the map screen: the selected point (from
// a search or a map click), its address lookup, the risk zones and the risk at
// the point. One hook so ClockScreen needs only a few lines of wiring.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import type { Forecast, Spot } from "../contracts";
import { useData } from "../data";
import { bandAt, describePoint, geocoder as defaultGeocoder, nearbySpot } from "./logic";
import { lookupFailure } from "./SearchBox";
import type { Geocoder, Place, PointRisk } from "./types";

export const ZONES_FILE = "geo/risk-zones.geojson";

export type Selection = {
  /** Increases with every new point, so the pin re-drops and stale lookups are ignored. */
  id: number;
  lat: number;
  lon: number;
  source: "search" | "click";
  /** The address; null while it is being looked up. */
  place: Place | null;
  status: "loading" | "ready" | "error";
  error?: { text: string; retry: boolean };
};

export type ZonesState = { status: "loading" } | { status: "ready"; data: FeatureCollection } | { status: "error" };

export type RiskState = { status: "loading" } | { status: "ready"; risk: PointRisk } | { status: "unavailable" };

export type FlyTarget = { id: number; lat: number; lon: number; zoom: number };

export function useExplore({
  spots,
  forecast,
  geocoder = defaultGeocoder,
}: {
  spots: Spot[];
  forecast: Forecast | null;
  geocoder?: Geocoder;
}) {
  const raw = useData<FeatureCollection>(ZONES_FILE);
  const zones: ZonesState = useMemo(
    () =>
      raw.status === "ready" && Array.isArray(raw.data?.features)
        ? { status: "ready", data: raw.data }
        : raw.status === "loading"
          ? { status: "loading" }
          : { status: "error" },
    [raw],
  );
  const [showZones, setShowZones] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const nextId = useRef(0);
  const lookup = useRef<AbortController | null>(null);

  useEffect(() => () => lookup.current?.abort(), []);

  /** Look up the address at a point (map click, or Retry). */
  const reverse = useCallback(
    (id: number, lat: number, lon: number) => {
      lookup.current?.abort();
      const ctrl = new AbortController();
      lookup.current = ctrl;
      geocoder.reverse(lat, lon, ctrl.signal).then(
        (place) => {
          if (ctrl.signal.aborted) return;
          setSelection((s) => (s && s.id === id ? { ...s, place, status: "ready", error: undefined } : s));
        },
        (e: unknown) => {
          if (ctrl.signal.aborted) return;
          setSelection((s) => (s && s.id === id ? { ...s, status: "error", error: lookupFailure(e) } : s));
        },
      );
    },
    [geocoder],
  );

  const onMapClick = useCallback(
    (lat: number, lon: number) => {
      const id = ++nextId.current;
      setSelection({ id, lat, lon, source: "click", place: null, status: "loading" });
      reverse(id, lat, lon);
    },
    [reverse],
  );

  const onPick = useCallback((place: Place) => {
    lookup.current?.abort();
    const id = ++nextId.current;
    setSelection({ id, lat: place.lat, lon: place.lon, source: "search", place, status: "ready" });
    setFly({ id, lat: place.lat, lon: place.lon, zoom: place.kind === "place" ? 14 : 16 });
  }, []);

  const current = useRef<Selection | null>(null);
  current.current = selection;
  const retry = useCallback(() => {
    const s = current.current;
    if (!s) return;
    setSelection({ ...s, status: "loading", error: undefined });
    reverse(s.id, s.lat, s.lon);
  }, [reverse]);

  const close = useCallback(() => {
    lookup.current?.abort();
    setSelection(null);
  }, []);

  const risk: RiskState = useMemo(() => {
    if (!selection) return { status: "loading" };
    if (zones.status === "loading") return { status: "loading" };
    if (zones.status === "error") return { status: "unavailable" };
    try {
      const nearby = nearbySpot(selection.lat, selection.lon, spots, forecast) ?? undefined;
      return { status: "ready", risk: describePoint(bandAt(zones.data, selection.lat, selection.lon), nearby) };
    } catch {
      return { status: "unavailable" };
    }
  }, [selection, zones, spots, forecast]);

  return {
    zones,
    showZones,
    setShowZones,
    selection,
    risk,
    fly,
    onMapClick,
    onPick,
    retry,
    close,
    /** Props for <ExploreLayer/> inside the map. */
    layer: {
      zones: zones.status === "ready" ? zones.data : null,
      showZones,
      pin: selection ? { id: selection.id, lat: selection.lat, lon: selection.lon } : null,
      fly,
      onMapClick,
      panelOpen: selection != null,
    },
  };
}

export type Explore = ReturnType<typeof useExplore>;
