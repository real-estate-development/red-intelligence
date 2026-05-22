/**
 * Ingest building footprint geometry into Prisma `BuildingFootprint`.
 *
 * Input: GeoJSON FeatureCollection or GeoJSONSeq of Polygon/MultiPolygon features.
 * Each feature must expose EGID in one of:
 *   egid, EGID, eidg_gebaeudeidentifikator, gebaeudeidentifikator
 *
 * Usage:
 *   npm run footprints:ingest -- --file /path/to/footprints.geojsonseq
 *   npm run footprints:ingest -- --file /path/to/footprints.geojson
 *   npm run footprints:ingest -- --url https://example.invalid/footprints.geojson
 *   npm run footprints:ingest -- --file /path/to/footprints.geojson --srid 2056
 *   npm run footprints:ingest -- --file /path/to/footprints.geojson --append
 */

import { createReadStream, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { config as loadEnv } from "dotenv";
import proj4 from "proj4";
import { PrismaClient } from "@prisma/client";
import { featureCollection, multiPolygon, polygon, union } from "@turf/turf";

loadEnv({ quiet: true });

const prisma = new PrismaClient();

const LV95 =
  "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs";
const WGS84 = "EPSG:4326";

type AnyGeometry = {
  type: string;
  coordinates?: unknown;
};

type AnyFeature = {
  type: "Feature";
  geometry: AnyGeometry | null;
  properties?: Record<string, unknown> | null;
};

type FeatureCollection = {
  type: "FeatureCollection";
  features: AnyFeature[];
};

type PolygonCoords = number[][][];
type MultiPolygonCoords = PolygonCoords[];

function parseArgs() {
  const argv = process.argv.slice(2);
  let file: string | undefined;
  let url: string | undefined;
  let append = false;
  let srid = "4326";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" && argv[i + 1]) {
      file = argv[++i];
    } else if (a === "--url" && argv[i + 1]) {
      url = argv[++i];
    } else if (a === "--append") {
      append = true;
    } else if (a === "--srid" && argv[i + 1]) {
      srid = argv[++i];
    }
  }
  const resolvedUrl = url ?? process.env.FOOTPRINTS_GEOJSON_URL;
  if (!file && !resolvedUrl) {
    throw new Error(
      "Missing footprint source. Provide one of:\n" +
        "- --file /path/to/footprints.geojson\n" +
        "- --url https://.../footprints.geojson\n" +
        "- FOOTPRINTS_GEOJSON_URL in .env"
    );
  }
  return { file, url: resolvedUrl, replace: !append, srid };
}

function extractEgid(properties: Record<string, unknown> | null | undefined): string | null {
  if (!properties) return null;
  const candidates = [
    properties.egid,
    properties.EGID,
    properties.eidg_gebaeudeidentifikator,
    properties.gebaeudeidentifikator,
  ];
  for (const c of candidates) {
    const v = String(c ?? "").trim();
    if (v) return v;
  }
  return null;
}

function isPolygonLike(geom: AnyGeometry | null): geom is { type: "Polygon" | "MultiPolygon"; coordinates: unknown } {
  if (!geom || !geom.coordinates) return false;
  return geom.type === "Polygon" || geom.type === "MultiPolygon";
}

function projectCoord(coord: unknown, sourceSrid: string): unknown {
  if (!Array.isArray(coord)) return coord;
  if (coord.length >= 2 && typeof coord[0] === "number" && typeof coord[1] === "number") {
    const [x, y] = coord as [number, number];
    if (sourceSrid === "4326") return [x, y];
    if (sourceSrid === "2056") return proj4(LV95, WGS84, [x, y]);
    throw new Error(`Unsupported --srid ${sourceSrid}. Use 4326 or 2056.`);
  }
  return coord.map((nested) => projectCoord(nested, sourceSrid));
}

function collectCoords(coord: unknown, acc: [number, number][]) {
  if (!Array.isArray(coord)) return;
  if (coord.length >= 2 && typeof coord[0] === "number" && typeof coord[1] === "number") {
    acc.push([coord[0], coord[1]]);
    return;
  }
  for (const nested of coord) collectCoords(nested, acc);
}

function computeBbox(coordinates: unknown): { minLat: number; minLng: number; maxLat: number; maxLng: number } | null {
  const pairs: [number, number][] = [];
  collectCoords(coordinates, pairs);
  if (pairs.length === 0) return null;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of pairs) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) return null;
  return { minLat, minLng, maxLat, maxLng };
}

function toMultiPolygonCoords(geom: AnyGeometry): MultiPolygonCoords | null {
  if (!geom.coordinates) return null;
  if (geom.type === "Polygon") return [geom.coordinates as PolygonCoords];
  if (geom.type === "MultiPolygon") return geom.coordinates as MultiPolygonCoords;
  return null;
}

function dissolvePolygons(polygons: MultiPolygonCoords): { type: "Polygon" | "MultiPolygon"; coordinates: unknown } | null {
  const polygonFeatures = polygons
    .filter((coords) => Array.isArray(coords) && coords.length > 0)
    .map((coords) => polygon(coords));
  if (polygonFeatures.length === 0) return null;
  if (polygonFeatures.length === 1) {
    return {
      type: polygonFeatures[0].geometry.type,
      coordinates: polygonFeatures[0].geometry.coordinates,
    };
  }
  try {
    const merged = union(featureCollection(polygonFeatures));
    if (merged?.geometry && (merged.geometry.type === "Polygon" || merged.geometry.type === "MultiPolygon")) {
      return {
        type: merged.geometry.type,
        coordinates: merged.geometry.coordinates,
      };
    }
  } catch {
    // Fallback below preserves all parts if robust dissolve fails.
  }
  return {
    type: "MultiPolygon",
    coordinates: multiPolygon(polygons).geometry.coordinates,
  };
}

function parseFeatureCollection(raw: string): AnyFeature[] {
  const data = JSON.parse(raw) as FeatureCollection;
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error("Input must be a GeoJSON FeatureCollection or GeoJSONSeq.");
  }
  return data.features;
}

async function* readGeoJsonFeatures(args: { file?: string; url?: string }): AsyncGenerator<AnyFeature> {
  if (args.file) {
    if (!existsSync(args.file)) {
      throw new Error(`Footprint file not found: ${args.file}`);
    }
    if (args.file.endsWith(".geojsonseq")) {
      const rl = createInterface({
        input: createReadStream(args.file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed) yield JSON.parse(trimmed) as AnyFeature;
      }
      return;
    }

    for (const feature of parseFeatureCollection(readFileSync(args.file, "utf8"))) {
      yield feature;
    }
    return;
  }
  const target = args.url!;
  const res = await fetch(target);
  if (!res.ok) {
    throw new Error(`Failed to download footprint GeoJSON (${res.status}): ${target}`);
  }
  if (!res.body) {
    throw new Error("Footprint response has no body");
  }
  const stream = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  for (const feature of parseFeatureCollection(Buffer.concat(chunks).toString("utf8"))) {
    yield feature;
  }
}

async function main() {
  const args = parseArgs();

  if (args.replace) {
    const deleted = await prisma.buildingFootprint.deleteMany({});
    console.log(`Replace mode: removed ${deleted.count} existing BuildingFootprint rows.`);
  }

  let seen = 0;
  let upserted = 0;
  let skipped = 0;
  const byEgid = new Map<string, MultiPolygonCoords>();

  for await (const f of readGeoJsonFeatures(args)) {
    seen++;
    if (!isPolygonLike(f.geometry)) {
      skipped++;
      continue;
    }

    const egid = extractEgid(f.properties);
    if (!egid) {
      skipped++;
      continue;
    }

    const projectedCoordinates = projectCoord(f.geometry.coordinates, args.srid);
    const normalizedGeom = toMultiPolygonCoords({
      type: f.geometry.type,
      coordinates: projectedCoordinates,
    });
    if (!normalizedGeom || normalizedGeom.length === 0) {
      skipped++;
      continue;
    }
    const existing = byEgid.get(egid) ?? [];
    existing.push(...normalizedGeom);
    byEgid.set(egid, existing);

    if (seen % 10_000 === 0) {
      console.log(`... ${seen} features read, ${byEgid.size} EGIDs aggregated, ${skipped} skipped`);
    }
  }

  for (const [egid, polygons] of byEgid) {
    const dissolved = dissolvePolygons(polygons);
    if (!dissolved) {
      skipped++;
      continue;
    }
    const bbox = computeBbox(dissolved.coordinates);
    if (!bbox) {
      skipped++;
      continue;
    }
    const geometryJson = JSON.stringify(dissolved);
    await prisma.buildingFootprint.upsert({
      where: { egid },
      create: {
        egid,
        geometryJson,
        minLat: bbox.minLat,
        minLng: bbox.minLng,
        maxLat: bbox.maxLat,
        maxLng: bbox.maxLng,
      },
      update: {
        geometryJson,
        minLat: bbox.minLat,
        minLng: bbox.minLng,
        maxLat: bbox.maxLat,
        maxLng: bbox.maxLng,
      },
    });
    upserted++;
  }

  console.log(`Done. Features parsed: ${seen}, EGIDs aggregated: ${byEgid.size}, footprints upserted: ${upserted}, skipped: ${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
