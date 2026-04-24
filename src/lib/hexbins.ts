import * as turf from "@turf/turf";
import type { BBox, Feature, Polygon } from "geojson";

export type BuildingPoint = { lat: number; lng: number; yearBuilt: number };

export type HexBinResult = {
  id: string;
  /** Single ring, [lng, lat][] */
  ring: [number, number][];
  count: number;
  yearMean: number | null;
  yearStdDev: number | null;
};

const DEFAULT_TARGET = 100;

/** Approximate bbox area (km²) for hex sizing — flat-earth ok at CH latitudes. */
export function bboxAreaKm2(bbox: BBox): number {
  const [west, south, east, north] = bbox;
  const lat = (south + north) / 2;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.32 * Math.cos((lat * Math.PI) / 180);
  const widthKm = Math.abs(east - west) * kmPerDegLng;
  const heightKm = Math.abs(north - south) * kmPerDegLat;
  return Math.max(widthKm * heightKm, 1e-9);
}

/** Regular hexagon area from side length s (km): (3√3/2) s² */
function hexAreaKm2(sideKm: number): number {
  return ((3 * Math.sqrt(3)) / 2) * sideKm * sideKm;
}

/** Expected number of axis-aligned hex cells of side `s` covering a rectangle of area A (very rough). */
function estimatedHexCount(areaKm2: number, sideKm: number): number {
  return Math.ceil(areaKm2 / hexAreaKm2(sideKm));
}

/**
 * Turf hex grid over bbox, tuned to ~`target` cells.
 * Uses an area-based initial side length then a few `hexGrid` refinements (never dozens of huge grids).
 */
export function hexGridForTargetCount(bbox: BBox, target: number = DEFAULT_TARGET): Feature<Polygon>[] {
  const areaKm2 = bboxAreaKm2(bbox);
  let side = Math.sqrt(areaKm2 / (target * hexAreaKm2(1)));
  side = Math.max(0.002, Math.min(side, 800_000));

  /* Avoid generating millions of polygons on the first try */
  while (estimatedHexCount(areaKm2, side) > target * 3) {
    side *= 1.35;
  }

  let grid = turf.hexGrid(bbox, side, { units: "kilometers" });
  for (let i = 0; i < 14; i++) {
    const n = grid.features.length;
    if (n === 0) {
      side *= 0.55;
      grid = turf.hexGrid(bbox, side, { units: "kilometers" });
      continue;
    }
    if (Math.abs(n - target) <= 18) break;
    side *= Math.sqrt(n / target);
    side = Math.max(0.0015, Math.min(side, 2_000_000));
    grid = turf.hexGrid(bbox, side, { units: "kilometers" });
  }

  return grid.features as Feature<Polygon>[];
}

function meanStd(values: number[]): { mean: number | null; stdDev: number | null } {
  if (values.length === 0) return { mean: null, stdDev: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) return { mean, stdDev: 0 };
  const variance = values.reduce((a, y) => a + (y - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

export function aggregateBuildingsIntoHexBins(
  bbox: BBox,
  buildings: BuildingPoint[],
  targetCells: number = DEFAULT_TARGET
): HexBinResult[] {
  const hexFeatures = hexGridForTargetCount(bbox, targetCells);
  const hexBboxes = hexFeatures.map((f) => turf.bbox(f));
  const results: HexBinResult[] = [];

  for (let i = 0; i < hexFeatures.length; i++) {
    const poly = hexFeatures[i];
    const ring = poly.geometry.coordinates[0] as [number, number][];
    const [w, s, e, n] = hexBboxes[i];
    const years: number[] = [];
    for (const b of buildings) {
      if (b.lng < w || b.lng > e || b.lat < s || b.lat > n) continue;
      const pt = turf.point([b.lng, b.lat]);
      if (turf.booleanPointInPolygon(pt, poly)) {
        years.push(b.yearBuilt);
      }
    }
    const { mean, stdDev } = meanStd(years);
    results.push({
      id: `h${i}-${ring[0][0].toFixed(4)}-${ring[0][1].toFixed(4)}`,
      ring,
      count: years.length,
      yearMean: mean,
      yearStdDev: stdDev,
    });
  }

  return results;
}

export function parseBBox(searchParams: URLSearchParams): BBox | null {
  const south = Number(searchParams.get("south"));
  const west = Number(searchParams.get("west"));
  const north = Number(searchParams.get("north"));
  const east = Number(searchParams.get("east"));
  if (![south, west, north, east].every((v) => Number.isFinite(v))) return null;
  if (south >= north || west >= east) return null;
  if (north - south > 6 || east - west > 6) return null;
  return [west, south, east, north];
}
