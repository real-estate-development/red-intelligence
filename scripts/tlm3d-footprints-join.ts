/**
 * Spatial join: GWR `Building` points (EGID + LV95-derived WGS84 coordinates) →
 * swissTLM3D building polygons (no EGID), then upsert `BuildingFootprint`.
 *
 * swissTLM3D is the large-scale landscape model from swisstopo; building footprints
 * must be linked to registry EGIDs with a GIS-style **point-in-polygon** join (or an
 * optional short-distance snap when the point sits just outside the polygon).
 *
 * The national GeoPackage is multi-gigabyte; this script **never loads all polygons at
 * once**. It partitions space into WGS84 grid tiles, for each tile queries the GeoPackage
 * spatial index for polygons overlapping an expanded bbox, builds a local R-tree, and
 * joins only buildings whose coordinates fall in that tile.
 *
 * Data: BGDI STAC `ch.swisstopo.swisstlm3d`, asset `<release>_2056_5728.gpkg.zip`
 * (see https://www.swisstopo.admin.ch/en/geodata/landscape/tlm3d.html).
 *
 * Usage:
 *   npm run footprints:tlm3d-join -- --gpkg /path/to/extracted.gpkg
 *   npm run footprints:tlm3d-join -- --release swisstlm3d_2025-03
 *   npm run footprints:tlm3d-join -- --zip /path/to/swisstlm3d_2025-03_2056_5728.gpkg.zip
 *
 * Flags:
 *   --table <name>   Feature table inside the GeoPackage (default: auto-detect *buildings_building*)
 *   --grid-deg <n>   Tile size in degrees (default 0.15, ~17 km at mid-latitudes)
 *   --buffer-deg <n> Expand each tile when querying the GeoPackage (default 0.002 ~220 m)
 *   --snap-m <n>     If no polygon contains the point, assign the nearest footprint within n metres (default 2; use 0 to disable)
 *   --append         Upsert without clearing footprints first
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { BoundingBox, GeoPackage, GeoPackageAPI } from "@ngageoint/geopackage";
import RBush from "rbush";
import {
  area,
  bbox,
  booleanPointInPolygon,
  point,
  pointToPolygonDistance,
} from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import unzipper from "unzipper";

loadEnv({ quiet: true });

const prisma = new PrismaClient();

const STAC_ITEM = (release: string) =>
  `https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisstlm3d/items/${release}`;

const FETCH_HEADERS = { "User-Agent": "red-intelligence/tlm3d-footprints-join" };

type BBoxItem = { minX: number; minY: number; maxX: number; maxY: number; i: number };

type Args = {
  gpkg?: string;
  zip?: string;
  release: string;
  dataDir: string;
  replace: boolean;
  table?: string;
  gridDeg: number;
  bufferDeg: number;
  snapM: number;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let gpkg: string | undefined;
  let zip: string | undefined;
  let table: string | undefined;
  let release = process.env.SWISSTLM3D_RELEASE ?? "swisstlm3d_2025-03";
  let dataDir = process.env.SWISSTLM3D_DATA_DIR ?? "data/swisstlm3d";
  let append = false;
  let gridDeg = Number.parseFloat(process.env.SWISSTLM3D_GRID_DEG ?? "0.15");
  let bufferDeg = Number.parseFloat(process.env.SWISSTLM3D_BUFFER_DEG ?? "0.002");
  let snapM = Number.parseFloat(process.env.SWISSTLM3D_SNAP_M ?? "2");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gpkg" && argv[i + 1]) gpkg = argv[++i];
    else if (a === "--zip" && argv[i + 1]) zip = argv[++i];
    else if (a === "--release" && argv[i + 1]) release = argv[++i];
    else if (a === "--data-dir" && argv[i + 1]) dataDir = argv[++i];
    else if (a === "--table" && argv[i + 1]) table = argv[++i];
    else if (a === "--grid-deg" && argv[i + 1]) gridDeg = Number.parseFloat(argv[++i]);
    else if (a === "--buffer-deg" && argv[i + 1]) bufferDeg = Number.parseFloat(argv[++i]);
    else if (a === "--snap-m" && argv[i + 1]) snapM = Number.parseFloat(argv[++i]);
    else if (a === "--append") append = true;
  }
  if (!Number.isFinite(gridDeg) || gridDeg <= 0) gridDeg = 0.15;
  if (!Number.isFinite(bufferDeg) || bufferDeg < 0) bufferDeg = 0.002;
  if (!Number.isFinite(snapM) || snapM < 0) snapM = 2;
  return {
    gpkg,
    zip,
    release,
    dataDir,
    replace: !append,
    table,
    gridDeg,
    bufferDeg,
    snapM,
  };
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

async function downloadZip(url: string, destPath: string): Promise<void> {
  if (existsSync(destPath)) {
    console.log(`Using existing zip: ${destPath}`);
    return;
  }
  console.log(`Downloading (multi-GB) ${url}`);
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream), createWriteStream(destPath));
}

async function extractPrimaryGpkgFromZip(zipPath: string, outGpkgPath: string): Promise<void> {
  if (existsSync(outGpkgPath)) {
    console.log(`Using existing extracted GeoPackage: ${outGpkgPath}`);
    return;
  }
  const directory = await unzipper.Open.file(zipPath);
  const files = directory.files.filter((f) => f.type === "File" && /\.gpkg$/i.test(f.path));
  if (files.length === 0) {
    throw new Error(`No .gpkg member found in ${zipPath}`);
  }
  const product =
    files.find((f) => /product/i.test(f.path) && !/boundar/i.test(f.path)) ??
    files.find((f) => !/boundar/i.test(f.path)) ??
    files[0];
  console.log(`Extracting ${product.path} → ${outGpkgPath}`);
  await pipeline(product.stream(), createWriteStream(outGpkgPath));
}

async function resolveGpkgPath(args: Pick<Args, "gpkg" | "zip" | "release" | "dataDir">): Promise<string> {
  if (args.gpkg) {
    if (!existsSync(args.gpkg)) throw new Error(`GeoPackage not found: ${args.gpkg}`);
    return args.gpkg;
  }
  mkdirSync(args.dataDir, { recursive: true });
  const assetKey = `${args.release}_2056_5728.gpkg.zip`;
  const zipPath = args.zip ?? join(args.dataDir, assetKey);
  if (!args.zip) {
    const stacUrl = STAC_ITEM(args.release);
    const meta = (await fetch(stacUrl, { headers: FETCH_HEADERS }).then((r) => r.json())) as {
      assets?: Record<string, { href?: string }>;
    };
    const href = meta.assets?.[assetKey]?.href;
    if (!href) {
      throw new Error(
        `STAC item ${stacUrl} has no asset "${assetKey}". Try another --release or pass --zip / --gpkg.`
      );
    }
    await downloadZip(href, zipPath);
  } else if (!existsSync(zipPath)) {
    throw new Error(`Zip not found: ${zipPath}`);
  }

  const outGpkg = join(args.dataDir, `${args.release}_Product.gpkg`);
  await extractPrimaryGpkgFromZip(zipPath, outGpkg);
  return outGpkg;
}

function pickBuildingsTable(tables: string[], explicit?: string): string {
  if (explicit) {
    if (!tables.includes(explicit)) {
      throw new Error(`Table "${explicit}" not in GeoPackage. Available:\n${tables.join("\n")}`);
    }
    return explicit;
  }
  const byPattern = tables.find((t) => /buildings_building$/i.test(t));
  if (byPattern) return byPattern;
  const fallback = tables.find((t) => /tlm3d/i.test(t) && /building/i.test(t) && !/named|name|poi/i.test(t));
  if (fallback) return fallback;
  throw new Error(
    `Could not auto-detect buildings polygon table. Pass --table <name>. Feature tables:\n${tables.join("\n")}`
  );
}

function isPoly(g: unknown): g is Polygon | MultiPolygon {
  if (!g || typeof g !== "object") return false;
  const t = (g as { type?: string }).type;
  return t === "Polygon" || t === "MultiPolygon";
}

function loadTilePolygons(gp: GeoPackage, table: string, q: BoundingBox) {
  const geometries: Array<Polygon | MultiPolygon> = [];
  const boxes: BBoxItem[] = [];
  for (const f of gp.iterateGeoJSONFeatures(table, q)) {
    const g = f.geometry;
    if (!isPoly(g)) continue;
    const b = bbox({ type: "Feature", properties: {}, geometry: g } as Feature);
    const i = geometries.length;
    geometries.push(g);
    boxes.push({ minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], i });
  }
  const tree = new RBush<BBoxItem>();
  if (boxes.length) tree.load(boxes);
  return { tree, geometries };
}

function matchPolygon(
  lng: number,
  lat: number,
  tree: RBush<BBoxItem>,
  geometries: Array<Polygon | MultiPolygon>,
  snapM: number
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
  if (best || snapM <= 0) return best;

  const deg = snapM / 111_000;
  const wider = tree.search({ minX: lng - deg, minY: lat - deg, maxX: lng + deg, maxY: lat + deg });
  let bestSnapDist = Number.POSITIVE_INFINITY;
  let bestSnapArea = Number.POSITIVE_INFINITY;
  let bestGeom: Polygon | MultiPolygon | null = null;
  for (const c of wider) {
    const g = geometries[c.i];
    const feat = { type: "Feature" as const, properties: {}, geometry: g };
    const d = pointToPolygonDistance(pt, g, { units: "meters", method: "geodesic" });
    const outsideDist = Math.max(0, d);
    if (outsideDist >= snapM) continue;
    const a = area(feat);
    if (outsideDist < bestSnapDist || (outsideDist === bestSnapDist && a < bestSnapArea)) {
      bestSnapDist = outsideDist;
      bestSnapArea = a;
      bestGeom = g;
    }
  }
  return bestGeom;
}

function* tileExtents(
  west: number,
  south: number,
  east: number,
  north: number,
  step: number
): Generator<{ w: number; s: number; e: number; n: number }> {
  for (let lat = south; lat < north; lat += step) {
    const ts = lat;
    const tn = Math.min(north, lat + step);
    for (let lng = west; lng < east; lng += step) {
      const tw = lng;
      const te = Math.min(east, lng + step);
      yield { w: tw, s: ts, e: te, n: tn };
    }
  }
}

function expandQueryBbox(w: number, s: number, e: number, n: number, buf: number) {
  return {
    w: Math.max(-180, w - buf),
    s: Math.max(-90, s - buf),
    e: Math.min(180, e + buf),
    n: Math.min(90, n + buf),
  };
}

async function main() {
  const args = parseArgs();
  const gpkgPath = await resolveGpkgPath({
    gpkg: args.gpkg,
    zip: args.zip,
    release: args.release,
    dataDir: args.dataDir,
  });
  console.log(`GeoPackage: ${gpkgPath}`);

  const gp = await GeoPackageAPI.open(gpkgPath);
  gp.loadSpatialReferenceSystemsIntoProj4();
  const tables = gp.getFeatureTables();
  const buildingTable = pickBuildingsTable(tables, args.table);
  console.log(`Buildings layer: ${buildingTable}`);

  if (args.replace) {
    const deleted = await prisma.buildingFootprint.deleteMany({});
    console.log(`Replace mode: removed ${deleted.count} existing BuildingFootprint rows.`);
  }

  const [agg, totalBuildings] = await Promise.all([
    prisma.building.aggregate({
      _min: { lat: true, lng: true },
      _max: { lat: true, lng: true },
    }),
    prisma.building.count(),
  ]);
  const west = agg._min.lng;
  const south = agg._min.lat;
  let east = agg._max.lng;
  let north = agg._max.lat;
  if (
    west == null ||
    south == null ||
    east == null ||
    north == null ||
    !Number.isFinite(west + south + east + north)
  ) {
    gp.close();
    throw new Error("No buildings in database (cannot derive spatial extent).");
  }
  east += 1e-7;
  north += 1e-7;
  console.log(
    `Joining ${totalBuildings} GWR buildings; grid ${args.gridDeg}°, query buffer ${args.bufferDeg}°, snap ${args.snapM} m…`
  );

  let matched = 0;
  let noMatch = 0;
  let tilesDone = 0;

  try {
    for (const tile of tileExtents(west, south, east, north, args.gridDeg)) {
      const buildingsHere = await prisma.building.findMany({
        where: {
          lat: { gte: tile.s, lt: tile.n },
          lng: { gte: tile.w, lt: tile.e },
        },
        select: { egid: true, lat: true, lng: true },
      });
      if (buildingsHere.length === 0) continue;

      const q = expandQueryBbox(tile.w, tile.s, tile.e, tile.n, args.bufferDeg);
      const bb = new BoundingBox(q.w, q.e, q.s, q.n);
      const { tree, geometries } = loadTilePolygons(gp, buildingTable, bb);
      if (geometries.length === 0) {
        noMatch += buildingsHere.length;
        tilesDone++;
        continue;
      }

      const upserts: Array<{
        egid: string;
        geometryJson: string;
        minLat: number;
        minLng: number;
        maxLat: number;
        maxLng: number;
      }> = [];

      for (const b of buildingsHere) {
        const poly = matchPolygon(b.lng, b.lat, tree, geometries, args.snapM);
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

      const writeChunk = 200;
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

      tilesDone++;
      if (tilesDone % 20 === 0) {
        console.log(
          `... tiles ${tilesDone}; footprints upserted ${matched}; no match so far ${noMatch}`
        );
      }
    }
  } finally {
    gp.close();
  }

  console.log(`Done. Footprints upserted: ${matched}, no match: ${noMatch} (tile passes: ${tilesDone})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
