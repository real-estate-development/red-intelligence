/**
 * swissBUILDINGS3D 3.0 Beta pipeline (swisstopo STAC):
 * 1) query tiles by bbox
 * 2) download tiled FileGDB zips from data.geo.admin.ch
 * 3) emit a manifest for downstream conversion/ingest
 *
 * This script fetches data directly from swisstopo's STAC API:
 * https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissbuildings3d_3_0/items
 *
 * Example:
 *   npm run swissbuildings3d:pipeline -- --bbox 7.55,47.53,7.63,47.58
 */

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

type StacAsset = {
  href: string;
  type?: string;
};

type StacItem = {
  id: string;
  assets: Record<string, StacAsset>;
};

type StacFeatureCollection = {
  features: StacItem[];
  links?: Array<{ rel?: string; href?: string }>;
};

type ManifestEntry = {
  itemId: string;
  sourceUrl: string;
  localFile: string;
};

function parseArgs() {
  const argv = process.argv.slice(2);
  let bbox = process.env.SWISSBUILDINGS3D_BBOX;
  let outDir = process.env.SWISSBUILDINGS3D_OUT_DIR ?? "data/swissbuildings3d";
  let limit = Number.parseInt(process.env.SWISSBUILDINGS3D_ITEM_LIMIT ?? "200", 10);
  let pageSize = Number.parseInt(process.env.SWISSBUILDINGS3D_PAGE_SIZE ?? "100", 10);
  let year = process.env.SWISSBUILDINGS3D_YEAR;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bbox" && argv[i + 1]) {
      bbox = argv[++i];
    } else if (a === "--out-dir" && argv[i + 1]) {
      outDir = argv[++i];
    } else if (a === "--limit" && argv[i + 1]) {
      limit = Number.parseInt(argv[++i], 10);
    } else if (a === "--page-size" && argv[i + 1]) {
      pageSize = Number.parseInt(argv[++i], 10);
    } else if (a === "--year" && argv[i + 1]) {
      year = argv[++i];
    }
  }
  if (!bbox) {
    throw new Error(
      "Missing --bbox west,south,east,north (WGS84).\n" +
        "Example: --bbox 7.55,47.53,7.63,47.58"
    );
  }
  const parts = bbox.split(",").map((x) => Number.parseFloat(x.trim()));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new Error(`Invalid --bbox value: ${bbox}`);
  }
  const [west, south, east, north] = parts;
  if (!(west < east && south < north)) {
    throw new Error(`Invalid --bbox order. Expected west<south<east<north style: ${bbox}`);
  }
  if (!Number.isFinite(limit) || limit < 1) limit = 200;
  if (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > 500) pageSize = 100;
  if (year && !/^\d{4}$/.test(year.trim())) {
    throw new Error(`Invalid --year value: ${year}`);
  }
  return { bbox: `${west},${south},${east},${north}`, outDir, limit, pageSize, year: year?.trim() };
}

function pickGdbAsset(item: StacItem): string | null {
  for (const asset of Object.values(item.assets ?? {})) {
    const href = asset.href ?? "";
    if (href.toLowerCase().endsWith(".gdb.zip")) return href;
  }
  return null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }
  return (await res.json()) as T;
}

async function queryStacItems(bbox: string, itemLimit: number, pageSize: number): Promise<StacItem[]> {
  const base =
    "https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissbuildings3d_3_0/items";
  let url = `${base}?bbox=${encodeURIComponent(bbox)}&limit=${pageSize}`;
  const out: StacItem[] = [];
  while (url && out.length < itemLimit) {
    const page = await fetchJson<StacFeatureCollection>(url);
    for (const item of page.features ?? []) {
      out.push(item);
      if (out.length >= itemLimit) break;
    }
    const next = (page.links ?? []).find((l) => l.rel === "next")?.href;
    url = out.length >= itemLimit ? "" : next ?? "";
  }
  return out;
}

async function downloadFile(url: string, outPath: string): Promise<void> {
  if (existsSync(outPath)) return;
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        throw new Error(`Failed to download (${res.status}) ${url}`);
      }
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(outPath);
        const rs = res.body as unknown as AsyncIterable<Uint8Array>;
        (async () => {
          try {
            for await (const chunk of rs) {
              ws.write(chunk);
            }
            ws.end();
            ws.on("finish", () => resolve());
          } catch (e) {
            reject(e);
          }
        })().catch(reject);
      });
      return;
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        console.warn(`Download retry ${attempt}/${maxAttempts - 1}: ${url}`);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to download ${url}`);
}

async function main() {
  const args = parseArgs();
  mkdirSync(args.outDir, { recursive: true });
  const downloadsDir = join(args.outDir, "downloads");
  mkdirSync(downloadsDir, { recursive: true });
  const manifestPath = join(args.outDir, "manifest.json");

  console.log(`Querying swissBUILDINGS3D STAC for bbox ${args.bbox} ...`);
  const fetchLimit = args.year ? Math.max(args.limit * 10, 500) : args.limit;
  let items = await queryStacItems(args.bbox, fetchLimit, args.pageSize);
  if (args.year) {
    const before = items.length;
    items = items.filter((item) => item.id.includes(`_${args.year}_`));
    console.log(`Filtered by year ${args.year}: ${items.length}/${before} items`);
    if (items.length > args.limit) {
      items = items.slice(0, args.limit);
    }
  }
  if (items.length === 0) {
    console.log("No tiles found for bbox.");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          collection: "ch.swisstopo.swissbuildings3d_3_0",
          bbox: args.bbox,
          year: args.year ?? null,
          fetchedAt: new Date().toISOString(),
          downloaded: 0,
          skippedWithoutGdbAsset: 0,
          failedDownloads: 0,
          items: [],
          nextStep: "No matching tiles downloaded.",
        },
        null,
        2
      )
    );
    console.log(`Manifest: ${manifestPath}`);
    return;
  }
  console.log(`Found ${items.length} tile items (limit ${args.limit}).`);

  const manifest: ManifestEntry[] = [];
  let skipped = 0;
  let failed = 0;
  for (const item of items) {
    const gdbUrl = pickGdbAsset(item);
    if (!gdbUrl) {
      skipped++;
      continue;
    }
    const filename = basename(new URL(gdbUrl).pathname);
    const outPath = join(downloadsDir, filename);
    try {
      await downloadFile(gdbUrl, outPath);
    } catch (e) {
      failed++;
      console.warn(`Failed tile ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    manifest.push({
      itemId: item.id,
      sourceUrl: gdbUrl,
      localFile: outPath,
    });
    if (manifest.length % 10 === 0) {
      console.log(`... downloaded ${manifest.length} gdb.zip tiles`);
    }
  }

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        collection: "ch.swisstopo.swissbuildings3d_3_0",
        bbox: args.bbox,
        year: args.year ?? null,
        fetchedAt: new Date().toISOString(),
        downloaded: manifest.length,
        skippedWithoutGdbAsset: skipped,
        failedDownloads: failed,
        items: manifest,
        nextStep:
          "Convert downloaded .gdb.zip tiles to footprint GeoJSON (Polygon/MultiPolygon with EGID), then run npm run footprints:ingest -- --file /path/to/footprints.geojson --srid 2056",
      },
      null,
      2
    )
  );

  console.log(`Done. Downloaded ${manifest.length} tiles to ${downloadsDir}`);
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
