/**
 * Spatial join: GWR `Building` centroids → swissTLMRegio generalised building polygons,
 * then upsert `BuildingFootprint` (WGS84 GeoJSON + bbox cache).
 *
 * swissTLMRegio is intended for regional / national overview; swisstopo documents use
 * at scales around 1:100'000 and smaller. Polygons do not carry EGID — matching is
 * point-in-polygon on each building's `lat`/`lng`. When several polygons contain the
 * same point (rare), the smallest-area polygon wins.
 *
 * Default source: BGDI STAC `ch.swisstopo.swisstlmregio` GeoPackage zip
 * (`swisstlmregio_<YEAR>_2056.gpkg.zip`) → `swissTLMRegio_Product_LV95.gpkg` →
 * layer `tlmregio_buildings_building`.
 *
 * Usage:
 *   npm run footprints:tlmregio-join -- --gpkg /path/to/swissTLMRegio_Product_LV95.gpkg
 *   npm run footprints:tlmregio-join -- --year 2025
 *   npm run footprints:tlmregio-join -- --zip /path/to/swisstlmregio_2025_2056.gpkg.zip
 *
 * Flags:
 *   --append     Upsert only; do not delete existing footprints first.
 *   (default)    Deletes all `BuildingFootprint` rows before upserting matches.
 */

import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { GeoPackageAPI } from "@ngageoint/geopackage";
import RBush from "rbush";
import { area, bbox, booleanPointInPolygon, point } from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import unzipper from "unzipper";

loadEnv({ quiet: true });

const prisma = new PrismaClient();

const STAC_ITEM = (year: string) =>
  `https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisstlmregio/items/swisstlmregio_${year}`;
const DEFAULT_PRODUCT_GPKG = "swissTLMRegio_Product_LV95.gpkg";
const BUILDINGS_TABLE = "tlmregio_buildings_building";

type BBoxItem = { minX: number; minY: number; maxX: number; maxY: number; i: number };

function parseArgs() {
  const argv = process.argv.slice(2);
  let gpkg: string | undefined;
  let zip: string | undefined;
  let year = process.env.SWISSTLMREGIO_YEAR ?? "2025";
  let append = false;
  let dataDir = process.env.SWISSTLMREGIO_DATA_DIR ?? "data/swisstlmregio";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gpkg" && argv[i + 1]) gpkg = argv[++i];
    else if (a === "--zip" && argv[i + 1]) zip = argv[++i];
    else if (a === "--year" && argv[i + 1]) year = argv[++i];
    else if (a === "--data-dir" && argv[i + 1]) dataDir = argv[++i];
    else if (a === "--append") append = true;
  }
  return { gpkg, zip, year, append, dataDir, replace: !append };
}

function collectCoords(coord: unknown, acc: [number, number][]) {
  if (!Array.isArray(coord)) return;
  if (coord.length >= 2 && typeof coord[0] === "number" && typeof coord[1] === "number") {
    acc.push([coord[0] as number, coord[1] as number]);
    return;
  }
  for (const nested of coord) collectCoords(nested, acc);
}

function computeBboxCoords(coordinates: unknown): { minLat: number; minLng: number; maxLat: number; maxLng: number } | null {
  const pairs: [number, number][] = [];
  collectCoords(coordinates, pairs);
  if (pairs.length === 0) return null;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of pairs) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) return null;
  return { minLat, minLng, maxLat, maxLng };
}

const FETCH_HEADERS = { "User-Agent": "red-intelligence/tlmregio-footprints-join" };

async function downloadZip(url: string, destPath: string): Promise<void> {
  if (existsSync(destPath)) {
    console.log(`Using existing zip: ${destPath}`);
    return;
  }
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream), createWriteStream(destPath));
}

async function resolveGpkgPath(args: {
  gpkg?: string;
  zip?: string;
  year: string;
  dataDir: string;
}): Promise<string> {
  if (args.gpkg) {
    if (!existsSync(args.gpkg)) throw new Error(`GeoPackage not found: ${args.gpkg}`);
    return args.gpkg;
  }
  mkdirSync(args.dataDir, { recursive: true });
  const zipPath = args.zip ?? join(args.dataDir, `swisstlmregio_${args.year}_2056.gpkg.zip`);
  if (!args.zip) {
    const stacUrl = `${STAC_ITEM(args.year)}`;
    const meta = (await fetch(stacUrl, { headers: FETCH_HEADERS }).then((r) => r.json())) as {
      assets?: Record<string, { href?: string }>;
    };
    const key = `swisstlmregio_${args.year}_2056.gpkg.zip`;
    const href = meta.assets?.[key]?.href;
    if (!href) {
      throw new Error(
        `STAC item ${stacUrl} has no asset "${key}". Try another --year or pass --zip / --gpkg.`
      );
    }
    await downloadZip(href, zipPath);
  } else if (!existsSync(zipPath)) {
    throw new Error(`Zip not found: ${zipPath}`);
  }

  const extractDir = join(args.dataDir, `extract_${args.year}`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await unzipper.Open.file(zipPath).then((d) => d.extract({ path: extractDir, concurrency: 4 }));
  const inner = join(extractDir, DEFAULT_PRODUCT_GPKG);
  if (!existsSync(inner)) {
    throw new Error(`Expected ${DEFAULT_PRODUCT_GPKG} inside zip — check swisstopo packaging.`);
  }
  return inner;
}

function isPoly(g: unknown): g is Polygon | MultiPolygon {
  if (!g || typeof g !== "object") return false;
  const t = (g as { type?: string }).type;
  return t === "Polygon" || t === "MultiPolygon";
}

async function loadBuildingIndex(gpkgPath: string): Promise<{
  tree: RBush<BBoxItem>;
  geometries: Array<Polygon | MultiPolygon>;
}> {
  const gp = await GeoPackageAPI.open(gpkgPath);
  gp.loadSpatialReferenceSystemsIntoProj4();
  const tables = gp.getFeatureTables();
  if (!tables.includes(BUILDINGS_TABLE)) {
    gp.close();
    throw new Error(`Missing layer ${BUILDINGS_TABLE}. Found: ${tables.join(", ")}`);
  }

  const geometries: Array<Polygon | MultiPolygon> = [];
  const boxes: BBoxItem[] = [];
  let n = 0;
  try {
    for (const f of gp.iterateGeoJSONFeatures(BUILDINGS_TABLE)) {
      const g = f.geometry;
      if (!isPoly(g)) continue;
      const b = bbox({ type: "Feature", properties: {}, geometry: g } as Feature);
      const i = geometries.length;
      geometries.push(g);
      boxes.push({ minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], i });
      n++;
      if (n % 50_000 === 0) console.log(`... indexed ${n} TLMRegio building polygons`);
    }
  } finally {
    gp.close();
  }

  const tree = new RBush<BBoxItem>();
  tree.load(boxes);
  console.log(`TLMRegio buildings loaded: ${geometries.length} polygons (R-tree ready).`);
  return { tree, geometries };
}

function matchPolygon(
  lng: number,
  lat: number,
  tree: RBush<BBoxItem>,
  geometries: Array<Polygon | MultiPolygon>
): Polygon | MultiPolygon | null {
  const pt = point([lng, lat]);
  const candidates = tree.search({ minX: lng, minY: lat, maxX: lng, maxY: lat });
  let best: Polygon | MultiPolygon | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const g = geometries[c.i];
    const feat = { type: "Feature" as const, properties: {}, geometry: g };
    if (!booleanPointInPolygon(pt, feat)) continue;
    const a = area(feat);
    if (a < bestArea) {
      bestArea = a;
      best = g;
    }
  }
  return best;
}

async function main() {
  const args = parseArgs();
  const gpkgPath = await resolveGpkgPath({
    gpkg: args.gpkg,
    zip: args.zip,
    year: args.year,
    dataDir: args.dataDir,
  });
  console.log(`GeoPackage: ${gpkgPath}`);

  const { tree, geometries } = await loadBuildingIndex(gpkgPath);

  if (args.replace) {
    const deleted = await prisma.buildingFootprint.deleteMany({});
    console.log(`Replace mode: removed ${deleted.count} existing BuildingFootprint rows.`);
  }

  const totalBuildings = await prisma.building.count();
  console.log(`Joining ${totalBuildings} GWR buildings to TLMRegio polygons…`);

  const batchSize = 8000;
  const writeChunk = 200;
  let lastEgid: string | undefined;
  let matched = 0;
  let noMatch = 0;
  let processed = 0;

  while (true) {
    const batch = await prisma.building.findMany({
      take: batchSize,
      ...(lastEgid ? { skip: 1, cursor: { egid: lastEgid } } : {}),
      orderBy: { egid: "asc" },
      select: { egid: true, lat: true, lng: true },
    });
    if (batch.length === 0) break;
    lastEgid = batch[batch.length - 1]!.egid;

    const upserts: Array<{
      egid: string;
      geometryJson: string;
      minLat: number;
      minLng: number;
      maxLat: number;
      maxLng: number;
    }> = [];

    for (const b of batch) {
      const poly = matchPolygon(b.lng, b.lat, tree, geometries);
      if (!poly) {
        noMatch++;
        continue;
      }
      const bboxDb = computeBboxCoords(poly.coordinates);
      if (!bboxDb) {
        noMatch++;
        continue;
      }
      upserts.push({
        egid: b.egid,
        geometryJson: JSON.stringify(poly),
        ...bboxDb,
      });
    }

    for (let i = 0; i < upserts.length; i += writeChunk) {
      const slice = upserts.slice(i, i + writeChunk);
      await prisma.$transaction(
        slice.map((u) =>
          prisma.buildingFootprint.upsert({
            where: { egid: u.egid },
            create: u,
            update: {
              geometryJson: u.geometryJson,
              minLat: u.minLat,
              minLng: u.minLng,
              maxLat: u.maxLat,
              maxLng: u.maxLng,
            },
          })
        )
      );
      matched += slice.length;
    }

    processed += batch.length;
    if (processed % 40_000 === 0 || processed === totalBuildings) {
      console.log(
        `... processed ${processed}/${totalBuildings} buildings; footprints ${matched}, no polygon ${noMatch}`
      );
    }
  }

  console.log(`Done. Buildings processed: ${processed}, footprints upserted: ${matched}, no match: ${noMatch}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
