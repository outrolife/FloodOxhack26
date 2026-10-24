// Protect screen hero (#121): zoomed Osney/Botley map with the S3 flood-spread
// heatmap for the chosen hour, the recorded 2013/14 outline (replay only) and
// the top-5 S4 candidates as numbered pins. Leaflet only; all logic is in logic.ts.
import L from "leaflet";
import { useMemo } from "react";
import { GeoJSON, ImageOverlay, Marker, Pane } from "react-leaflet";
import type { GeoJsonObject } from "geojson";
import type { SpreadManifest } from "../../contracts";
import { BaseMap } from "../../ui/BaseMap";
import "../../components/spread/spread.css";
import type { Candidate, OutlineFeature } from "./logic";

export type Pin = { c: Candidate; n: number; wet: boolean; hours: number | null };

export function ProtectMap({
  manifest,
  frameUrl,
  pins,
  selected,
  onSelect,
  outline,
}: {
  manifest: SpreadManifest;
  /** PNG for the chosen hour, or null (no frame). */
  frameUrl: string | null;
  pins: Pin[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** Recorded outline to draw dashed (e2014 only). */
  outline: OutlineFeature | null;
}) {
  return (
    <BaseMap bounds={manifest.bounds} className="protect-map">
      {frameUrl && (
        // Above the vector basemap (overlay pane, z 400) so the heat shows over water and parks;
        // building outlines stay visible through it.
        <Pane name="rc-protect-spread" style={{ zIndex: 450 }}>
          <ImageOverlay
            url={frameUrl}
            bounds={manifest.bounds}
            opacity={0.75}
            interactive={false}
            className="spread-frame"
            attribution="Flood spread: experimental terrain fill on EA LiDAR (OGL v3.0)"
          />
        </Pane>
      )}
      {outline && (
        <Pane name="rc-protect-outline" style={{ zIndex: 460 }}>
          <GeoJSON
            key={outline.properties.label ?? "outline"}
            data={outline as unknown as GeoJsonObject}
            interactive={false}
            style={{ color: "#ffffff", weight: 2, dashArray: "6 5", fill: false, opacity: 0.9 }}
            attribution="Recorded Flood Outlines: Environment Agency (OGL v3.0)"
          />
        </Pane>
      )}
      {pins.map((p) => (
        <PinMarker key={p.c.id} pin={p} active={p.c.id === selected} onSelect={onSelect} />
      ))}
    </BaseMap>
  );
}

function PinMarker({ pin, active, onSelect }: { pin: Pin; active: boolean; onSelect: (id: string) => void }) {
  const { c, n, wet, hours } = pin;
  const icon = useMemo(
    () =>
      L.divIcon({
        className: `protect-pin${active ? " is-active" : ""}${wet ? " is-wet" : ""}`,
        html: `<span class="protect-pin-n">${n}</span>${hours !== null ? `<span class="protect-pin-h">${hours} h</span>` : ""}`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      }),
    [n, active, wet, hours],
  );
  const label = `${n}. ${hours !== null ? `water could reach it in about ${hours} h` : "not wet in half the runs"}`;
  return (
    <Marker
      position={[c.lat, c.lon]}
      icon={icon}
      title={label}
      alt={label}
      keyboard
      zIndexOffset={active ? 1000 : 0}
      eventHandlers={{ click: () => onSelect(c.id) }}
    />
  );
}
