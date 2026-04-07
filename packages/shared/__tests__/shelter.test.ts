import { describe, it, expect } from "vitest";
import { haversineKm, findNearestShelters, type Shelter } from "../src/shelter.js";

// Sample shelters around Tel Aviv center (32.08, 34.78)
const makeShelfter = (id: string, lat: number, lng: number, name = "מקלט"): Shelter => ({
  id,
  name,
  address: "Test St 1",
  lat,
  lng,
});

describe("haversineKm", () => {
  it("returns 0 for same point", () => {
    expect(haversineKm(32.08, 34.78, 32.08, 34.78)).toBe(0);
  });

  it("Tel Aviv → Jerusalem ~55km", () => {
    const dist = haversineKm(32.08, 34.78, 31.77, 35.21);
    expect(dist).toBeGreaterThan(50);
    expect(dist).toBeLessThan(65);
  });

  it("is symmetric", () => {
    const d1 = haversineKm(32.0, 34.8, 31.5, 35.0);
    const d2 = haversineKm(31.5, 35.0, 32.0, 34.8);
    expect(Math.abs(d1 - d2)).toBeLessThan(0.0001);
  });

  it("returns a positive value for nearby points", () => {
    const dist = haversineKm(32.08, 34.78, 32.081, 34.781);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(0.2);
  });
});

describe("findNearestShelters", () => {
  const origin = { lat: 32.08, lng: 34.78 };

  it("returns empty for empty list", () => {
    expect(findNearestShelters(origin.lat, origin.lng, [])).toEqual([]);
  });

  it("filters by maxDistanceKm", () => {
    const shelters = [
      makeShelfter("near", 32.081, 34.781),   // ~0.15km
      makeShelfter("far", 32.20, 35.00),        // >20km
    ];
    const result = findNearestShelters(origin.lat, origin.lng, shelters, 2);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("near");
  });

  it("sorts by distance ascending", () => {
    const shelters = [
      makeShelfter("mid", 32.085, 34.785),   // ~0.7km
      makeShelfter("close", 32.081, 34.781), // ~0.15km
      makeShelfter("far-ish", 32.10, 34.80), // ~2.2km
    ];
    const result = findNearestShelters(origin.lat, origin.lng, shelters, 5);
    expect(result[0].id).toBe("close");
    expect(result[1].id).toBe("mid");
  });

  it("limits results to maxResults", () => {
    const shelters = Array.from({ length: 10 }, (_, i) =>
      makeShelfter(String(i), 32.08 + i * 0.001, 34.78 + i * 0.001),
    );
    const result = findNearestShelters(origin.lat, origin.lng, shelters, 10, 3);
    expect(result).toHaveLength(3);
  });

  it("calculates walkingMinutes at 5km/h", () => {
    const shelters = [makeShelfter("s", 32.085, 34.785)]; // ~0.7km
    const result = findNearestShelters(origin.lat, origin.lng, shelters, 5);
    expect(result).toHaveLength(1);
    // ~0.7km / 5 km/h * 60min = ~8.4 → ceil = 9
    const expected = Math.ceil((result[0].distanceKm / 5) * 60);
    expect(result[0].walkingMinutes).toBe(expected);
    expect(result[0].walkingMinutes).toBeGreaterThan(0);
  });

  it("generates correct Google Maps URL", () => {
    const shelters = [makeShelfter("s", 32.085, 34.785)];
    const result = findNearestShelters(origin.lat, origin.lng, shelters, 5);
    expect(result[0].googleMapsUrl).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=32.085,34.785`,
    );
  });

  it("includes all shelter fields in result", () => {
    const shelters = [makeShelfter("id1", 32.081, 34.781, "הסתר מרכזי")];
    const result = findNearestShelters(origin.lat, origin.lng, shelters, 5);
    expect(result[0]).toMatchObject({
      id: "id1",
      name: "הסתר מרכזי",
      address: "Test St 1",
      lat: 32.081,
      lng: 34.781,
    });
    expect(result[0].distanceKm).toBeGreaterThan(0);
  });
});
