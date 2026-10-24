// S3 (SPEC §11): experimental flood-spread overlay.
//
// - <SpreadOverlay context="live" /> goes inside a react-leaflet <MapContainer>
//   (the River map). It loads spread/live/manifest.json, adds a toggle panel in
//   the map's bottom-left corner (off by default) and, when on, draws the PNG
//   frame for the chosen lead time under the spot markers. No manifest: nothing.
// - <SpreadMapCard eventId at /> is a self-contained card with its own compact
//   map, for the Time Machine (which has no map of its own).
// Everything is hidden when SHOW_S3 is false (web/src/stretch.ts).
import L from "leaflet";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ImageOverlay, MapContainer, Pane, TileLayer, useMap } from "react-leaflet";
import type { SpreadManifest } from "../../contracts";
import { useData } from "../../data";
import { SHOW_S3 } from "../../stretch";
import { DEFAULT_LEAD, type FramePick, frameUrl, manifestFile, pickFrame, usableManifest } from "./frames";
import { SpreadPanel } from "./SpreadPanel";

type SpreadState = {
  ready: boolean; // false while the manifest is loading
  manifest: SpreadManifest | null;
  on: boolean;
  setOn: (on: boolean) => void;
  tau: number;
  setTau: (tau: number) => void;
  pick: FramePick;
  url: string | null;
  imageMissing: boolean;
  onImage: (ok: boolean) => void;
};

/** Manifest, toggle, lead and the frame to draw, for "live" or an event id. */
function useSpread(context: string, at: string | undefined): SpreadState {
  const spread = useData<SpreadManifest>(SHOW_S3 ? manifestFile(context) : null);
  // Off by default (SPEC §11); ?spread=1 in the URL starts it on (demos, screenshots).
  const [on, setOn] = useState(() => new URLSearchParams(window.location.search).get("spread") === "1");
  const [tau, setTau] = useState<number>(DEFAULT_LEAD);
  const [failed, setFailed] = useState<string | null>(null);

  const manifest = usableManifest(spread);
  const pick: FramePick = manifest ? pickFrame(manifest.frames, tau, at) : { kind: "none" };
  const url = pick.kind === "frame" ? frameUrl(pick.frame.png, context) : null;
  return {
    ready: spread.status !== "loading",
    manifest,
    on,
    setOn,
    tau,
    setTau,
    pick,
    url,
    imageMissing: pick.kind === "frame" && (!url || failed === url),
    onImage: (ok) => setFailed(ok ? null : url),
  };
}

function panelProps(s: SpreadState, at: string | undefined) {
  return {
    manifest: s.manifest,
    on: s.on,
    onToggle: s.setOn,
    tau: s.tau,
    onTau: s.setTau,
    pick: s.pick,
    at,
    imageMissing: s.imageMissing,
  };
}

/** The PNG frame, in its own pane under the spot markers. */
function SpreadImage({ s }: { s: SpreadState }) {
  if (!s.on || !s.manifest || !s.url) return null;
  return (
    <Pane name="rc-spread" style={{ zIndex: 380 }}>
      <ImageOverlay
        url={s.url}
        bounds={s.manifest.bounds}
        opacity={0.7}
        interactive={false}
        attribution="Flood spread: experimental terrain fill on EA LiDAR (OGL v3.0)"
        eventHandlers={{ error: () => s.onImage(false), load: () => s.onImage(true) }}
      />
    </Pane>
  );
}

/** River map layer. Renders nothing unless a manifest exists for `context`. */
export function SpreadOverlay({ context, at }: { context: string; at?: string }) {
  const s = useSpread(context, at);
  if (!SHOW_S3 || !s.ready || !s.manifest) return null;
  return (
    <>
      <SpreadImage s={s} />
      <MapPanel>
        <SpreadPanel {...panelProps(s, at)} />
      </MapPanel>
    </>
  );
}

/**
 * Time Machine card: the toggle, and when it's on, a compact map of the
 * spread subarea for the frame issued at or before the slider time `at`.
 * Without a manifest for the event: a disabled toggle and a note.
 */
export function SpreadMapCard({ eventId, at }: { eventId: string; at: string }) {
  const s = useSpread(eventId, at);
  const [tilesFailed, setTilesFailed] = useState(!navigator.onLine);
  if (!SHOW_S3 || !s.ready) return null;
  return (
    <div className="card">
      <SpreadPanel {...panelProps(s, at)} wide />
      {s.on && s.manifest && (
        <div className="map-wrap" style={{ height: 260, marginTop: 8 }}>
          <MapContainer bounds={s.manifest.bounds} scrollWheelZoom={false}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              eventHandlers={{ tileerror: () => setTilesFailed(true), tileload: () => setTilesFailed(false) }}
            />
            <SpreadImage s={s} />
          </MapContainer>
          {tilesFailed && <div className="map-offline">Map tiles unavailable offline; overlay still shown.</div>}
        </div>
      )}
    </div>
  );
}

/** Renders children into a Leaflet control in the map's bottom-left corner. */
function MapPanel({ children }: { children: ReactNode }) {
  const map = useMap();
  const [el] = useState(() => {
    const div = L.DomUtil.create("div", "leaflet-bar");
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  });
  useEffect(() => {
    const ctl = new L.Control({ position: "bottomleft" });
    ctl.onAdd = () => el;
    ctl.addTo(map);
    return () => {
      ctl.remove();
    };
  }, [map, el]);
  return createPortal(children, el);
}
