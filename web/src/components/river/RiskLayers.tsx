// S1 (SPEC §11): official Environment Agency flood-risk layers on the River map.
//
// Render inside a react-leaflet <MapContainer>. Self-contained: it reads geo/risk_layers.json,
// adds a small toggle panel in the map's top-right corner, and draws the chosen layers under the
// spot markers.
//
// - "wms" layers (RoFRS, RoFSW) come live from the EA map service, so they need the internet.
//   The WMS layer name travels in the url's `layers` query parameter.
// - "geojson" layers (recorded flood outlines) are committed under web/public/data/, so they
//   work offline. They are only fetched once switched on.
import L from "leaflet";
import type { FeatureCollection } from "geojson";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GeoJSON, Pane, useMap, useMapEvent } from "react-leaflet";
import type { RiskLayers as RiskLayersFile } from "../../contracts";
import { useData } from "../../data";

type Layer = RiskLayersFile["layers"][number];

const LEGEND_TEXT = "Annual chance from EA long-term risk maps. Not a forecast.";
const RECORDED_TEXT = "Recorded outlines show where past floods reached. Not a forecast.";

// The EA only draws RoFRS/RoFSW at 1:50,000 or closer, which a 256 px Leaflet tile reaches at
// zoom 14. Below that we ask for a bigger image per tile (512 px at z13, 1024 px at z12) so the
// layer still shows; below zoom 12 the panel asks the user to zoom in.
const WMS_NATIVE_ZOOM = 14;
const WMS_MIN_ZOOM = 12;

export function RiskLayers() {
  const file = useData<RiskLayersFile>("geo/risk_layers.json");
  const map = useMap();
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(true);
  const [zoom, setZoom] = useState(() => map.getZoom());
  const [wmsFailed, setWmsFailed] = useState(false);
  useMapEvent("zoomend", () => setZoom(map.getZoom()));

  if (file.status !== "ready") return null; // S1 is optional: no file, no panel
  const layers = file.data.layers;
  const active = layers.filter((l) => on[l.id]);
  const wmsOn = active.some((l) => l.type === "wms");

  return (
    <>
      {active.map((l) =>
        l.type === "wms" ? (
          <WmsLayer key={l.id} layer={l} onStatus={setWmsFailed} />
        ) : (
          <GeoJsonLayer key={l.id} layer={l} />
        ),
      )}
      <MapPanel>
        <button type="button" onClick={() => setOpen(!open)} style={S.head} aria-expanded={open}>
          Official flood maps {open ? "▾" : "▸"}
        </button>
        {open && (
          <div style={S.body}>
            {layers.map((l) => (
              <label key={l.id} style={S.toggle}>
                <input
                  type="checkbox"
                  checked={!!on[l.id]}
                  onChange={(e) => setOn({ ...on, [l.id]: e.target.checked })}
                />
                {l.name}
              </label>
            ))}
            {active.length > 0 && (
              <div style={S.legend}>
                {active.map((l) => (
                  <div key={l.id} style={{ marginTop: 6 }}>
                    <div style={{ fontWeight: 600 }}>{l.name}</div>
                    {l.legend.map((item) => (
                      <div key={item.label}>
                        <span style={{ ...S.swatch, background: item.colour }} />
                        {item.label}
                      </div>
                    ))}
                  </div>
                ))}
                {wmsOn && <p style={S.note}>{LEGEND_TEXT}</p>}
                {active.some((l) => l.type === "geojson") && <p style={S.note}>{RECORDED_TEXT}</p>}
                {wmsOn && zoom < WMS_MIN_ZOOM && <p style={S.warn}>Zoom in to see the EA risk maps.</p>}
                {wmsOn && wmsFailed && (
                  <p style={S.warn}>EA map service unreachable: the risk maps need the internet.</p>
                )}
                <p style={S.note}>Source: Environment Agency, Open Government Licence v3.0.</p>
              </div>
            )}
          </div>
        )}
      </MapPanel>
    </>
  );
}

/** EA WMS as a Leaflet tile layer, oversampled below zoom 14 (see WMS_NATIVE_ZOOM). */
function WmsLayer({ layer, onStatus }: { layer: Layer; onStatus: (failed: boolean) => void }) {
  const map = useMap();
  useEffect(() => {
    const u = new URL(layer.url);
    const name = u.searchParams.get("layers") ?? "";
    u.searchParams.delete("layers");
    const wms = L.tileLayer.wms(u.toString(), {
      layers: name,
      format: "image/png",
      transparent: true,
      version: "1.3.0",
      opacity: 0.7,
      zIndex: 2, // above the OSM base tiles
      attribution: layer.attribution,
    });
    const baseUrl = wms.getTileUrl.bind(wms);
    wms.getTileUrl = (coords) => {
      const px = 256 * Math.min(4, 2 ** Math.max(0, WMS_NATIVE_ZOOM - coords.z));
      wms.wmsParams.width = px;
      wms.wmsParams.height = px;
      return baseUrl(coords);
    };
    wms.on("tileerror", () => onStatus(true));
    wms.on("tileload", () => onStatus(false));
    wms.addTo(map);
    return () => {
      wms.remove();
    };
  }, [map, layer.url, layer.attribution, onStatus]);
  return null;
}

/** Committed GeoJSON, drawn in its own pane below the spot markers and not clickable. */
function GeoJsonLayer({ layer }: { layer: Layer }) {
  const fc = useData<FeatureCollection>(layer.url);
  if (fc.status !== "ready") return null;
  const colour = layer.legend[0]?.colour ?? "#D95F02";
  return (
    <Pane name={`rc-risk-${layer.id}`} style={{ zIndex: 350 }}>
      <GeoJSON
        data={fc.data}
        interactive={false}
        attribution={layer.attribution}
        // One translucent fill per recorded flood and no outlines: overlaps add up, so land that
        // flooded in more of the recorded events shows darker.
        style={{ stroke: false, fillColor: colour, fillOpacity: 0.08 }}
      />
    </Pane>
  );
}

/** Renders children into a Leaflet control in the map's top-right corner. */
function MapPanel({ children }: { children: ReactNode }) {
  const map = useMap();
  const [el] = useState(() => {
    const div = L.DomUtil.create("div", "leaflet-bar");
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  });
  useEffect(() => {
    const ctl = new L.Control({ position: "topright" });
    ctl.onAdd = () => el;
    ctl.addTo(map);
    return () => {
      ctl.remove();
    };
  }, [map, el]);
  return createPortal(children, el);
}

const S = {
  head: {
    display: "block",
    width: "100%",
    padding: "4px 8px",
    border: 0,
    background: "#fff",
    font: "600 0.8rem system-ui, sans-serif",
    textAlign: "left",
    cursor: "pointer",
  },
  body: { background: "#fff", padding: "2px 8px 8px", maxWidth: 230, fontSize: "0.78rem", color: "#0b0b0b" },
  toggle: { display: "flex", gap: 6, alignItems: "center", marginTop: 4, cursor: "pointer" },
  legend: { borderTop: "1px solid rgba(11,11,11,0.1)", marginTop: 6, paddingTop: 2 },
  swatch: {
    display: "inline-block",
    width: 10,
    height: 10,
    marginRight: 5,
    verticalAlign: -1,
    border: "1px solid rgba(11,11,11,0.2)",
  },
  note: { margin: "6px 0 0", color: "#52514e" },
  warn: { margin: "6px 0 0", color: "#8a4b00" },
} satisfies Record<string, CSSProperties>;
