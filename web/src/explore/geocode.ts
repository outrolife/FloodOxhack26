// Explore (#118): find UK postcodes and addresses, and name a clicked point.
// Pure (no React). Free, keyless, CORS-friendly services only:
//   postcodes   -> postcodes.io (autocomplete, then a bulk lookup for coordinates)
//   addresses   -> Photon (komoot), biased to Oxford, GB results only
//                  (not Nominatim: its usage policy forbids autocomplete)
//   reverse     -> Photon reverse, then postcodes.io nearest postcode, then the
//                  nearest named place from the app's own data ("(offline)")
// Every request has a ~4 s timeout; results are kept in a small LRU cache.
// Errors are GeocodeError with a friendly message the UI can show as is.
// If the caller's signal aborts, the promise rejects with an AbortError
// (name === "AbortError"): ignore those, they are not failures.
import type { Feature, FeatureCollection, Point } from "geojson";
import type { Spot, Station } from "../contracts";
import { loadData } from "../data";
import { shortSpotName } from "../ui/clockData";
import { haversineM } from "./risk";
import { GeocodeError, type Geocoder, type Place } from "./types";

export const OXFORD = { lat: 51.752, lon: -1.258 };
export const MIN_QUERY = 3;
const POSTCODES = "https://api.postcodes.io";
const PHOTON = "https://photon.komoot.io";

/** A named place from the app's own data, for the offline fallback. */
export interface LocalPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface GeocoderOptions {
  /** Per-request timeout (ms). Default 4000. */
  timeoutMs?: number;
  /** LRU cache size. Default 50. */
  cacheSize?: number;
  /** Default: navigator.onLine (true when unknown). */
  isOnline?: () => boolean;
  /** Named places for the offline fallback. Default: spots, gauges and towns via loadData. */
  localPlaces?: () => Promise<LocalPlace[]>;
}

// Full or partial UK postcode: "OX2", "OX2 0", "OX20HA", "ox2 0ha", "SW1A 1AA".
const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{0,2})?$/i;
const FULL_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

export const looksLikePostcode = (q: string): boolean => POSTCODE_RE.test(q.trim());

const MSG = {
  offline: "You seem to be offline. Search needs the internet, but you can still click the map.",
  rate: "Too many searches just now. Please wait a few seconds and try again.",
  slow: "The address search took too long. Please try again.",
  network: "We couldn't reach the address search. Please try again in a moment.",
  nothing: "We couldn't find a name for this spot.",
};

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";
const abortError = () => {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
};

/** Tiny LRU: Map keeps insertion order, so the first key is the oldest. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private size: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value as string);
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

type PhotonProps = {
  name?: string;
  housenumber?: string;
  street?: string;
  city?: string;
  town?: string;
  village?: string;
  district?: string;
  locality?: string;
  county?: string;
  postcode?: string;
  countrycode?: string;
};

/** "12 Botley Road, Oxford OX2 0HA" from Photon's address parts. */
export function photonLabel(p: PhotonProps): string {
  const line1 =
    p.housenumber && p.street
      ? `${p.housenumber} ${p.street}`
      : p.name && p.street && p.name !== p.street
        ? `${p.name}, ${p.street}`
        : (p.name ?? p.street ?? "");
  const town = p.city ?? p.town ?? p.village ?? p.locality ?? p.district ?? p.county ?? "";
  const tail = [town !== line1 ? town : "", p.postcode ?? ""].filter(Boolean).join(" ");
  return [line1, tail].filter(Boolean).join(", ");
}

function photonPlace(f: Feature<Point, PhotonProps>, at?: { lat: number; lon: number }): Place | null {
  const p = f.properties ?? {};
  const [lon, lat] = f.geometry?.coordinates ?? [];
  const label = photonLabel(p);
  if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const place: Place = {
    label,
    lat: at?.lat ?? lat,
    lon: at?.lon ?? lon,
    kind: p.street || p.housenumber ? "address" : "place",
  };
  if (p.postcode) place.postcode = p.postcode;
  return place;
}

type PostcodeResult = { postcode: string; latitude: number | null; longitude: number | null; admin_district?: string | null };

function postcodePlace(r: PostcodeResult): Place | null {
  if (r.latitude == null || r.longitude == null) return null;
  return {
    label: r.admin_district ? `${r.postcode}, ${r.admin_district}` : r.postcode,
    lat: r.latitude,
    lon: r.longitude,
    kind: "postcode",
    postcode: r.postcode,
  };
}

// ---------------------------------------------------------------------------
// Offline places from the app's own data
// ---------------------------------------------------------------------------

export async function defaultLocalPlaces(): Promise<LocalPlace[]> {
  const [spots, stations, base] = await Promise.allSettled([
    loadData<Spot[]>("spots.json"),
    loadData<Station[]>("stations.json"),
    loadData<FeatureCollection>("geo/catchment-base.geojson"),
  ]);
  const out: LocalPlace[] = [];
  if (spots.status === "fulfilled")
    for (const s of spots.value.value) out.push({ name: shortSpotName(s.name), lat: s.lat, lon: s.lon });
  if (stations.status === "fulfilled")
    for (const s of stations.value.value) out.push({ name: s.name, lat: s.lat, lon: s.lon });
  if (base.status === "fulfilled")
    for (const f of base.value.value.features ?? []) {
      const name = f.properties?.name;
      if (f.properties?.kind === "town" && typeof name === "string" && f.geometry?.type === "Point") {
        const [lon, lat] = f.geometry.coordinates;
        out.push({ name, lat, lon });
      }
    }
  return out.filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

export function nearestLocal(places: LocalPlace[], lat: number, lon: number): LocalPlace | undefined {
  let best: { p: LocalPlace; d: number } | undefined;
  for (const p of places) {
    const d = haversineM(lat, lon, p.lat, p.lon);
    if (!best || d < best.d) best = { p, d };
  }
  return best?.p;
}

// ---------------------------------------------------------------------------
// Geocoder
// ---------------------------------------------------------------------------

export function createGeocoder(fetchImpl: typeof fetch = (...a) => fetch(...a), opts: GeocoderOptions = {}): Geocoder {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const cache = new Lru<Place[] | Place>(opts.cacheSize ?? 50);
  const isOnline = opts.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  let localPromise: Promise<LocalPlace[]> | undefined;
  const local = (): Promise<LocalPlace[]> => {
    localPromise ??= (opts.localPlaces ?? defaultLocalPlaces)().catch(() => {
      localPromise = undefined; // retry next time
      return [];
    });
    return localPromise;
  };

  /** GET/POST JSON with a timeout. 404 → null. 429 → rate_limited. Caller abort → AbortError. */
  async function getJson<T>(url: string, signal?: AbortSignal, init?: RequestInit): Promise<T | null> {
    if (signal?.aborted) throw abortError();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    // Race the abort too, so a fetch that ignores its signal can't hang us.
    const aborted = new Promise<never>((_, reject) =>
      ctrl.signal.addEventListener("abort", () => reject(abortError()), { once: true }),
    );
    aborted.catch(() => {});
    try {
      const res = await Promise.race([fetchImpl(url, { ...init, signal: ctrl.signal }), aborted]);
      if (res.status === 404) return null;
      if (res.status === 429) throw new GeocodeError(MSG.rate, "rate_limited");
      if (!res.ok) throw new GeocodeError(MSG.network, "network");
      return (await Promise.race([res.json(), aborted])) as T;
    } catch (e) {
      if (e instanceof GeocodeError) throw e;
      if (signal?.aborted) throw abortError();
      if (timedOut) throw new GeocodeError(MSG.slow, "network");
      if (!isOnline()) throw new GeocodeError(MSG.offline, "offline");
      throw new GeocodeError(MSG.network, "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function suggestPostcodes(q: string, signal?: AbortSignal): Promise<Place[]> {
    // postcodes.io ignores the space, so "OX1 4" would also match OX14 1AA. With a
    // space the outward code is complete: ask for "OX1 4A" when only the sector digit
    // is typed, and keep only codes that start with what was typed.
    const spaced = /^[A-Z]{1,2}\d[A-Z\d]? (\d[A-Z]{0,2})$/i.exec(q);
    const ask = spaced && spaced[1].length === 1 ? `${q}A` : q;
    const ac = await getJson<{ result: string[] | null }>(
      `${POSTCODES}/postcodes/${encodeURIComponent(ask)}/autocomplete?limit=6`,
      signal,
    );
    let codes = ac?.result ?? [];
    if (spaced) codes = codes.filter((c) => c.toUpperCase().startsWith(q.toUpperCase()));
    if (!codes.length && FULL_POSTCODE_RE.test(q)) codes = [q.toUpperCase()]; // e.g. a postcode autocomplete misses
    if (!codes.length) return [];
    const bulk = await getJson<{ result: { query: string; result: PostcodeResult | null }[] }>(
      `${POSTCODES}/postcodes`,
      signal,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postcodes: codes.slice(0, 6) }) },
    );
    return (bulk?.result ?? [])
      .map((r) => (r.result ? postcodePlace(r.result) : null))
      .filter((p): p is Place => p !== null);
  }

  async function suggestAddresses(q: string, signal?: AbortSignal): Promise<Place[]> {
    const url = `${PHOTON}/api/?q=${encodeURIComponent(q)}&lat=${OXFORD.lat}&lon=${OXFORD.lon}&limit=6&lang=en`;
    const fc = await getJson<FeatureCollection<Point, PhotonProps>>(url, signal);
    const seen = new Set<string>();
    const out: Place[] = [];
    for (const f of fc?.features ?? []) {
      if (f.properties?.countrycode?.toUpperCase() !== "GB") continue;
      const p = photonPlace(f);
      if (p && !seen.has(p.label)) {
        seen.add(p.label);
        out.push(p);
      }
    }
    return out;
  }

  async function suggestOffline(q: string): Promise<Place[]> {
    const needle = q.toLowerCase();
    const hits = (await local()).filter((p) => p.name.toLowerCase().includes(needle)).slice(0, 6);
    if (!hits.length) throw new GeocodeError(MSG.offline, "offline");
    return hits.map((p) => ({ label: `${p.name} (offline)`, lat: p.lat, lon: p.lon, kind: "place" as const }));
  }

  async function suggest(query: string, signal?: AbortSignal): Promise<Place[]> {
    const q = query.trim().replace(/\s+/g, " ");
    if (q.length < MIN_QUERY) return [];
    if (!isOnline()) return suggestOffline(q);
    const key = `s:${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit) return hit as Place[];
    const places = looksLikePostcode(q) ? await suggestPostcodes(q, signal) : await suggestAddresses(q, signal);
    cache.set(key, places);
    return places;
  }

  async function reverseOffline(lat: number, lon: number, why?: GeocodeError): Promise<Place> {
    const near = nearestLocal(await local(), lat, lon);
    // "(offline)" only when we really are offline; a slow or rate-limited service while online reads "Near X".
    if (near) return { label: `Near ${near.name}${isOnline() ? "" : " (offline)"}`, lat, lon, kind: "place" };
    throw why ?? new GeocodeError(MSG.nothing, "not_found");
  }

  async function reverse(lat: number, lon: number, signal?: AbortSignal): Promise<Place> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new GeocodeError(MSG.nothing, "not_found");
    if (signal?.aborted) throw abortError();
    if (!isOnline()) return reverseOffline(lat, lon, new GeocodeError(MSG.offline, "offline"));
    const key = `r:${lat.toFixed(5)},${lon.toFixed(5)}`;
    const hit = cache.get(key);
    if (hit) return hit as Place;
    let lastError: GeocodeError | undefined;
    const keep = (e: unknown) => {
      if (isAbort(e)) throw e;
      if (e instanceof GeocodeError) lastError = e;
      else throw e;
    };

    // 1. Photon: the street address at the point.
    try {
      const fc = await getJson<FeatureCollection<Point, PhotonProps>>(`${PHOTON}/reverse?lat=${lat}&lon=${lon}&lang=en`, signal);
      const f = fc?.features?.find((x) => x.properties?.countrycode?.toUpperCase() === "GB");
      const place = f && photonPlace(f, { lat, lon });
      if (place) {
        cache.set(key, place);
        return place;
      }
    } catch (e) {
      keep(e);
    }
    // 2. postcodes.io: the nearest postcode.
    try {
      const r = await getJson<{ result: PostcodeResult[] | null }>(`${POSTCODES}/postcodes?lon=${lon}&lat=${lat}&limit=1`, signal);
      const pc = r?.result?.[0];
      if (pc?.postcode) {
        const place: Place = { label: `Near ${pc.postcode}`, lat, lon, kind: "postcode", postcode: pc.postcode };
        cache.set(key, place);
        return place;
      }
    } catch (e) {
      keep(e);
    }
    // 3. Offline: the nearest named place we know about. Not cached, so the next try goes online again.
    if (signal?.aborted) throw abortError();
    return reverseOffline(lat, lon, lastError);
  }

  return { suggest, reverse };
}

/** The app's shared geocoder. */
export const geocoder: Geocoder = createGeocoder();
