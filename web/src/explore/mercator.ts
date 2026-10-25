// Web Mercator, the same arithmetic as Leaflet's L.CRS.EPSG3857 (map perf).
const MERC_R = 6378137;
const MERC_MAX_LAT = 85.0511287798;
const MERC_K = 0.5 / (Math.PI * MERC_R);
/** A point's position on the Web Mercator square [0, 1] (multiply by crs.scale(zoom) for pixels). */
export function mercatorUnit(lat: number, lng: number): [number, number] {
  const d = Math.PI / 180;
  const sin = Math.sin(Math.max(Math.min(MERC_MAX_LAT, lat), -MERC_MAX_LAT) * d);
  return [MERC_K * (MERC_R * lng * d) + 0.5, -MERC_K * ((MERC_R * Math.log((1 + sin) / (1 - sin))) / 2) + 0.5];
}
