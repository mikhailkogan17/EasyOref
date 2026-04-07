/**
 * Shelter search — finds nearest civil defense shelters via OpenStreetMap Overpass API.
 * Runtime query: small bbox around user location (~5km radius), ~0.4s latency.
 */

import { config } from "./config.js";

// ── Types ────────────────────────────────────────────────

export interface Shelter {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface NearShelter extends Shelter {
  distanceKm: number;
  walkingMinutes: number;
  googleMapsUrl: string;
}

// OSM Overpass API response element
interface OsmElement {
  type: string;
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

// ── Constants ────────────────────────────────────────────

/** Shelter types in OSM that represent civil defense / bomb shelters */
const BOMB_SHELTER_TYPES = new Set([
  "bomb",
  "bomb_shelter",
  "public_protection",
]);

/** Overpass API endpoint */
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/** Delta in degrees for ~5km bounding box around user */
const BBOX_DELTA = 0.045;

// ── Haversine ────────────────────────────────────────────

/**
 * Haversine formula — great-circle distance between two coordinates (km).
 */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── OSM → Shelter ────────────────────────────────────────

function osmToShelter(el: OsmElement): Shelter {
  const tags = el.tags ?? {};
  const name =
    tags["name:he"] ?? tags["name"] ?? tags["name:en"] ?? "מקלט ציבורי";
  const address = [
    tags["addr:street"],
    tags["addr:housenumber"],
    tags["addr:city"],
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: String(el.id),
    name,
    address: address || tags["addr:city"] || "Israel",
    lat: el.lat,
    lng: el.lon,
  };
}

// ── Geosearch ────────────────────────────────────────────

/**
 * Find nearest shelters from a pre-loaded list.
 * O(n) scan — suitable for datasets up to ~50K entries.
 */
export function findNearestShelters(
  lat: number,
  lng: number,
  shelters: Shelter[],
  maxDistanceKm?: number,
  limit?: number,
): NearShelter[] {
  const maxDist = maxDistanceKm ?? config.shelter.maxDistanceKm;
  const maxResults = limit ?? config.shelter.maxResults;

  const candidates: NearShelter[] = [];
  for (const s of shelters) {
    const distanceKm = haversineKm(lat, lng, s.lat, s.lng);
    if (distanceKm <= maxDist) {
      const walkingMinutes = Math.ceil((distanceKm / 5) * 60);
      candidates.push({
        ...s,
        distanceKm,
        walkingMinutes,
        googleMapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`,
      });
    }
  }

  return candidates
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, maxResults);
}

// ── Live Overpass fetch ──────────────────────────────────

/**
 * Fetch civil defense shelters near a location from OpenStreetMap Overpass API.
 * Queries a ~5km bounding box. Returns empty array on error (non-critical feature).
 */
export async function fetchNearestShelters(
  lat: number,
  lng: number,
): Promise<NearShelter[]> {
  const maxDist = config.shelter.maxDistanceKm;
  const maxResults = config.shelter.maxResults;

  const minLat = lat - BBOX_DELTA;
  const maxLat = lat + BBOX_DELTA;
  const minLon = lng - BBOX_DELTA;
  const maxLon = lng + BBOX_DELTA;

  const query = `[out:json][timeout:10];node["amenity"="shelter"](${minLat},${minLon},${maxLat},${maxLon});out body;`;

  let rawShelters: Shelter[];
  try {
    const body = new URLSearchParams({ data: query }).toString();
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { elements: OsmElement[] };
    const elements = json.elements ?? [];

    // Prefer known bomb-shelter types, fall back to all shelter types if none found
    const bombShelters = elements.filter((e) =>
      BOMB_SHELTER_TYPES.has(e.tags?.shelter_type ?? ""),
    );
    const toProcess = bombShelters.length > 0 ? bombShelters : elements;
    rawShelters = toProcess.map(osmToShelter);
  } catch {
    return [];
  }

  return findNearestShelters(lat, lng, rawShelters, maxDist, maxResults);
}
