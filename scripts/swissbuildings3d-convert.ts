/**
 * Convert downloaded swissBUILDINGS3D FileGDB tiles into one footprint GeoJSONSeq
 * (newline-delimited features; low RAM) and optionally ingest into Prisma.
 *
 * Prerequisites:
 *   - EITHER local GDAL tools in PATH (`ogr2ogr`, `ogrinfo`)
 *     OR Docker with access to a GDAL image (auto-detected).
 *   - Default docker fallback prefers:
 *       ghcr.io/osgeo/gdal:ubuntu-small-latest
 *   - Optional override:
 *       SWISSBUILDINGS3D_GDAL_DOCKER_IMAGE=<your-image>
 *   - a manifest produced by `swissbuildings3d-pipeline.ts`
 *
 * Example:
 *   npm run swissbuildings3d:convert -- --manifest data/swissbuildings3d/manifest.json --ingest
 *   npm run swissbuildings3d:convert -- --manifest data/swissbuildings3d/manifest.json --concurrency 3
 *   npm run swissbuildings3d:convert -- --resume
 */

import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

type Geometry = {
  type: string;
  coordinates?: unknown;
};

type Feature = {
  type: "Feature";
  geometry: Geometry | null;
  properties?: Record<string, unknown> | null;
};

type ManifestItem = {
  itemId: string;
  sourceUrl: string;
  localFile: string;
};

type Manifest = {
  items: ManifestItem[];
};

const DEFAULT_EGID_KEYS = [
  "egid",
  "EGID",
  "eidg_gebaeudeidentifikator",
  "EIDG_GEBAEUDEIDENTIFIKATOR",
  "gebaeudeidentifikator",
  "gwr_egid",
];

type GdalRuntime = {
  mode: "local" | "docker";
  run: (tool: "ogrinfo" | "ogr2ogr", args: string[]) => Promise<string>;
};

function parseArgs() {
  const argv = process.argv.slice(2);
  let manifestPath = process.env.SWISSBUILDINGS3D_MANIFEST ?? "data/swissbuildings3d/manifest.json";
  let outGeoJson = process.env.SWISSBUILDINGS3D_GEOJSON_OUT ?? "data/swissbuildings3d/footprints.geojsonseq";
  let workDir = process.env.SWISSBUILDINGS3D_WORK_DIR ?? "data/swissbuildings3d/work";
  let clipBbox = process.env.SWISSBUILDINGS3D_CLIP_BBOX;
  let forcedLayer: string | undefined;
  let ingest = false;
  let append = false;
  let concurrency = Number.parseInt(process.env.SWISSBUILDINGS3D_CONVERT_CONCURRENCY ?? "4", 10);
  let resume = false;
  let allowPartial = process.env.SWISSBUILDINGS3D_ALLOW_PARTIAL === "1";
  let progressPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest" && argv[i + 1]) {
      manifestPath = argv[++i];
    } else if (a === "--out" && argv[i + 1]) {
      outGeoJson = argv[++i];
    } else if (a === "--work-dir" && argv[i + 1]) {
      workDir = argv[++i];
    } else if (a === "--clip-bbox" && argv[i + 1]) {
      clipBbox = argv[++i];
    } else if (a === "--layer" && argv[i + 1]) {
      forcedLayer = argv[++i];
    } else if (a === "--ingest") {
      ingest = true;
    } else if (a === "--append") {
      append = true;
    } else if (a === "--concurrency" && argv[i + 1]) {
      concurrency = Number.parseInt(argv[++i], 10);
    } else if (a === "--resume") {
      resume = true;
    } else if (a === "--allow-partial") {
      allowPartial = true;
    } else if (a === "--progress" && argv[i + 1]) {
      progressPath = argv[++i];
    }
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    concurrency = 1;
  }
  return {
    manifestPath,
    outGeoJson,
    workDir,
    clipBbox,
    forcedLayer,
    ingest,
    append,
    concurrency,
    resume,
    allowPartial,
    progressPath: progressPath ?? `${outGeoJson}.progress.jsonl`,
  };
}

function commandExists(name: string): boolean {
  const which = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  return which.status === 0 && Boolean(which.stdout.trim());
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr || stdout}`));
    });
  });
}

function getGdalRuntime(): GdalRuntime {
  const hasOgr2ogr = commandExists("ogr2ogr");
  const hasOgrinfo = commandExists("ogrinfo");
  if (hasOgr2ogr && hasOgrinfo) {
    return {
      mode: "local",
      run(tool, args) {
        return runCommand(tool, args);
      },
    };
  }

  if (!commandExists("docker")) {
    throw new Error(
      "Missing required GDAL tools. Neither local ogr2ogr/ogrinfo nor docker are available.\n" +
        "Install GDAL locally, or install Docker so this script can use a GDAL container fallback."
    );
  }

  const workDir = process.cwd();
  const imageCandidates = process.env.SWISSBUILDINGS3D_GDAL_DOCKER_IMAGE
    ? [process.env.SWISSBUILDINGS3D_GDAL_DOCKER_IMAGE]
    : [
        "ghcr.io/osgeo/gdal:ubuntu-small-latest",
        "ghcr.io/osgeo/gdal:alpine-normal-latest",
        "ghcr.io/osgeo/gdal:latest",
        "osgeo/gdal:ubuntu-small-latest",
        "osgeo/gdal:latest",
        "osgeo/gdal:alpine-normal-latest",
      ];

  let image: string | null = null;
  for (const candidate of imageCandidates) {
    const probe = spawnSync(
      "docker",
      ["run", "--rm", candidate, "ogrinfo", "--version"],
      { encoding: "utf8" }
    );
    if (probe.status === 0) {
      image = candidate;
      break;
    }
  }
  if (!image) {
    throw new Error(
      "Docker is available, but no usable GDAL image was found.\n" +
        "Tried: " +
        imageCandidates.join(", ") +
        "\nSet SWISSBUILDINGS3D_GDAL_DOCKER_IMAGE to a valid image containing ogr2ogr/ogrinfo."
    );
  }
  console.log(`Using GDAL docker image: ${image}`);
  return {
    mode: "docker",
    run(tool, args) {
      return runCommand("docker", [
        "run",
        "--rm",
        "-v",
        `${workDir}:/work`,
        "-w",
        "/work",
        image,
        tool,
        ...args,
      ]);
    },
  };
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function findGdbDir(unzipDir: string): string {
  const candidates = readdirSync(unzipDir).filter((s) => s.toLowerCase().endsWith(".gdb"));
  if (candidates.length === 0) {
    throw new Error(`No .gdb directory found in ${unzipDir}`);
  }
  return join(unzipDir, candidates[0]);
}

async function listLayers(gdbPath: string, gdal: GdalRuntime): Promise<string[]> {
  const out = await gdal.run("ogrinfo", [gdbPath]);
  const layers: string[] = [];
  for (const line of out.split("\n")) {
    const numeric = line.match(/^\s*\d+:\s+(.+?)\s+\(/)?.[1]?.trim();
    if (numeric) {
      layers.push(numeric);
      continue;
    }
    const grouped = line.match(/^\s*Layer:\s+(.+?)\s+\(/)?.[1]?.trim();
    if (grouped) {
      layers.push(grouped);
    }
  }
  return layers;
}

function pickLayer(layers: string[], forced?: string): string {
  if (forced) return forced;
  if (layers.length === 0) throw new Error("No layers found in GDB.");
  // Prefer 2D-equivalent base footprints over roof surfaces for map polygons.
  const heuristics = ["floor", "grundriss", "footprint", "building", "gebaeude", "roof", "solid"];
  for (const token of heuristics) {
    const hit = layers.find((l) => l.toLowerCase().includes(token));
    if (hit) return hit;
  }
  return layers[0];
}

function extractEgid(properties: Record<string, unknown> | null | undefined): string | null {
  if (!properties) return null;
  for (const key of DEFAULT_EGID_KEYS) {
    const v = String(properties[key] ?? "").trim();
    if (v) return v;
  }
  return null;
}

function geometryBbox(
  coordinates: unknown
): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      const lng = node[0];
      const lat = node[1];
      minLng = Math.min(minLng, lng);
      minLat = Math.min(minLat, lat);
      maxLng = Math.max(maxLng, lng);
      maxLat = Math.max(maxLat, lat);
      return;
    }
    for (const child of node) walk(child);
  };

  walk(coordinates);
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null;
  return { minLng, minLat, maxLng, maxLat };
}

function intersectsClipBbox(
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  clip: [number, number, number, number]
): boolean {
  const [west, south, east, north] = clip;
  return !(bbox.maxLng < west || bbox.minLng > east || bbox.maxLat < south || bbox.minLat > north);
}

function normalizeFeature(
  f: Feature,
  clip?: [number, number, number, number]
): Feature | null {
  if (!f.geometry) return null;
  if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") return null;
  if (clip) {
    const bbox = geometryBbox(f.geometry.coordinates);
    if (!bbox || !intersectsClipBbox(bbox, clip)) return null;
  }
  const egid = extractEgid(f.properties);
  if (!egid) return null;
  return {
    type: "Feature",
    geometry: f.geometry,
    properties: { EGID: egid },
  };
}

async function writeFeatureLine(stream: WriteStream, feature: Feature): Promise<void> {
  const line = `${JSON.stringify(feature)}\n`;
  if (stream.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function downloadFile(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download (${res.status}) ${url}`);
  }

  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(outPath);
    const body = res.body as unknown as AsyncIterable<Uint8Array>;
    (async () => {
      try {
        for await (const chunk of body) {
          ws.write(chunk);
        }
        ws.end();
        ws.on("finish", resolve);
      } catch (error) {
        reject(error);
      }
    })().catch(reject);
  });
}

function isUnzipBackslashWarning(message: string): boolean {
  return message.includes("backslashes as path separators");
}

async function unzipTile(item: ManifestItem, unzipDir: string): Promise<void> {
  const extractZip = async () => {
    try {
      await runCommand("unzip", ["-o", item.localFile, "-d", unzipDir]);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isUnzipBackslashWarning(message)) {
        // unzip exits 1 on Linux for Windows-style paths, but extraction usually succeeds.
        findGdbDir(unzipDir);
        return;
      }
      throw error;
    }
  };

  try {
    await extractZip();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("End-of-central-directory signature not found")) {
      throw error;
    }
  }

  console.warn(`[retry] Re-downloading corrupt zip for ${item.itemId}`);
  rmSync(item.localFile, { force: true });
  await downloadFile(item.sourceUrl, item.localFile);
  await extractZip();
}

async function appendGeoJsonSeqFile(
  path: string,
  out: WriteStream,
  clip?: [number, number, number, number]
): Promise<number> {
  let kept = 0;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Feature;
    try {
      parsed = JSON.parse(trimmed) as Feature;
    } catch {
      continue;
    }
    const normalized = normalizeFeature(parsed, clip);
    if (!normalized) continue;
    await writeFeatureLine(out, normalized);
    kept += 1;
  }
  return kept;
}

function tileGeoJsonSeqPath(workDir: string, itemId: string): string {
  return join(workDir, `${itemId}.geojsonseq`);
}

/** Serializes writes to one output stream when multiple workers finish tiles concurrently. */
class SerializedFeatureWriter {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly stream: WriteStream) {}

  appendGeoJsonSeqFile(path: string, clip?: [number, number, number, number]): Promise<number> {
    const run = this.tail.then(() => appendGeoJsonSeqFile(path, this.stream, clip));
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  close(): Promise<void> {
    return this.tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.stream.end(() => resolve());
          this.stream.on("error", reject);
        })
    );
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const limit = Math.min(Math.max(1, concurrency), items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) break;
        await worker(items[index], index);
      }
    })
  );
}

type ConvertContext = {
  workDir: string;
  clip?: [number, number, number, number];
  forcedLayer?: string;
  gdal: GdalRuntime;
  writer: SerializedFeatureWriter;
};

function loadCompletedItems(progressPath: string): Set<string> {
  const completed = new Set<string>();
  if (!existsSync(progressPath)) return completed;
  for (const line of readFileSync(progressPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { itemId?: string; status?: string };
      if (row.itemId && row.status === "ok") completed.add(row.itemId);
    } catch {
      // Ignore partial/corrupt progress lines from interrupted runs.
    }
  }
  return completed;
}

function recordProgress(progressPath: string, itemId: string, status: "ok" | "warn", kept: number, error?: string): void {
  appendFileSync(progressPath, `${JSON.stringify({ itemId, status, kept, error, finishedAt: new Date().toISOString() })}\n`);
}

async function restoreCompletedTileOutputs(
  items: ManifestItem[],
  completedItems: Set<string>,
  writer: SerializedFeatureWriter,
  ctx: Pick<ConvertContext, "workDir" | "clip">
): Promise<{ restoredKept: number; reusableCompletedItems: Set<string> }> {
  let restoredKept = 0;
  const reusableCompletedItems = new Set<string>();

  for (const item of items) {
    if (!completedItems.has(item.itemId)) continue;
    const tilePath = tileGeoJsonSeqPath(ctx.workDir, item.itemId);
    if (!existsSync(tilePath)) continue;

    restoredKept += await writer.appendGeoJsonSeqFile(tilePath, ctx.clip);
    reusableCompletedItems.add(item.itemId);
  }

  return { restoredKept, reusableCompletedItems };
}

async function convertTile(item: ManifestItem, ctx: ConvertContext): Promise<number> {
  const zipPath = item.localFile;
  if (!existsSync(zipPath)) {
    throw new Error(`Missing downloaded tile zip: ${zipPath}`);
  }
  const unzipDir = join(ctx.workDir, item.itemId);
  ensureDir(unzipDir);
  await unzipTile(item, unzipDir);
  const gdbPath = findGdbDir(unzipDir);
  const layers = await listLayers(gdbPath, ctx.gdal);
  const layer = pickLayer(layers, ctx.forcedLayer);

  const tileGeoJsonSeq = tileGeoJsonSeqPath(ctx.workDir, item.itemId);
  const ogrArgs = [
    "-skipfailures",
    "-f",
    "GeoJSONSeq",
    "-dim",
    "2",
    "-nlt",
    "PROMOTE_TO_MULTI",
    tileGeoJsonSeq,
    gdbPath,
    layer,
    "-t_srs",
    "EPSG:4326",
  ];
  await ctx.gdal.run("ogr2ogr", ogrArgs);

  return ctx.writer.appendGeoJsonSeqFile(tileGeoJsonSeq, ctx.clip);
}

async function main() {
  const args = parseArgs();
  const gdal = getGdalRuntime();
  console.log(`Using GDAL runtime: ${gdal.mode}`);
  if (!existsSync(args.manifestPath)) {
    throw new Error(`Manifest not found: ${args.manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(args.manifestPath, "utf8")) as Manifest;
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    throw new Error(`No items in manifest: ${args.manifestPath}`);
  }

  ensureDir(args.workDir);
  ensureDir(dirname(args.outGeoJson));

  const clipParts = args.clipBbox
    ? args.clipBbox.split(",").map((x) => Number.parseFloat(x.trim()))
    : null;
  if (clipParts && (clipParts.length !== 4 || clipParts.some((v) => !Number.isFinite(v)))) {
    throw new Error(`Invalid --clip-bbox value: ${args.clipBbox}`);
  }

  const clip = clipParts
    ? ([clipParts[0], clipParts[1], clipParts[2], clipParts[3]] as [number, number, number, number])
    : undefined;

  if (!args.resume) {
    writeFileSync(args.progressPath, "");
  }
  const completedItems = args.resume ? loadCompletedItems(args.progressPath) : new Set<string>();
  const outStream = createWriteStream(args.outGeoJson, { encoding: "utf8", flags: "w" });
  const writer = new SerializedFeatureWriter(outStream);
  const ctx: ConvertContext = {
    workDir: args.workDir,
    clip,
    forcedLayer: args.forcedLayer,
    gdal,
    writer,
  };

  const { restoredKept, reusableCompletedItems } = args.resume
    ? await restoreCompletedTileOutputs(manifest.items, completedItems, writer, ctx)
    : { restoredKept: 0, reusableCompletedItems: new Set<string>() };
  const itemsToConvert = manifest.items.filter((item) => !reusableCompletedItems.has(item.itemId));

  let totalKept = restoredKept;
  let failedTiles = 0;
  let completedTiles = reusableCompletedItems.size;
  const totalTiles = manifest.items.length;

  if (args.resume) {
    console.log(
      `Resuming from ${args.progressPath}: restored ${reusableCompletedItems.size}/${totalTiles} completed tile outputs.`
    );
  }
  console.log(`Converting ${itemsToConvert.length} remaining tiles (total ${totalTiles}, concurrency ${args.concurrency})…`);

  await runWithConcurrency(itemsToConvert, args.concurrency, async (item) => {
    try {
      const kept = await convertTile(item, ctx);
      totalKept += kept;
      completedTiles += 1;
      recordProgress(args.progressPath, item.itemId, "ok", kept);
      console.log(`[ok] ${item.itemId}: kept ${kept} features (${completedTiles}/${totalTiles})`);
    } catch (error) {
      failedTiles += 1;
      completedTiles += 1;
      recordProgress(args.progressPath, item.itemId, "warn", 0, (error as Error).message);
      console.warn(
        `[warn] Skipping tile ${item.itemId} (${completedTiles}/${totalTiles}): ${(error as Error).message}`
      );
    }
  });

  await writer.close();

  console.log(`Wrote merged footprint GeoJSONSeq: ${args.outGeoJson}`);
  console.log(`Features kept (Polygon/MultiPolygon with EGID): ${totalKept}`);
  if (failedTiles > 0) {
    const message =
      `Tiles failed conversion: ${failedTiles}/${manifest.items.length}. ` +
      "Fix GDAL/Docker and rerun with --resume so failed tiles are retried.";
    if (!args.allowPartial) {
      throw new Error(`${message} Use --allow-partial only for a knowingly incomplete extract.`);
    }
    console.warn(`${message} Continuing because --allow-partial was set.`);
  }

  if (args.ingest) {
    const ingestArgs = ["scripts/footprints-ingest.ts", "--file", args.outGeoJson];
    if (args.append) ingestArgs.push("--append");
    const proc = spawnSync("npx", ["tsx", ...ingestArgs], { stdio: "inherit", encoding: "utf8" });
    if (proc.status !== 0) {
      throw new Error("footprints:ingest failed after conversion");
    }
  } else {
    console.log("Next step:");
    console.log(`npm run etl:process`);
    console.log(`# or ingest to DB: npm run footprints:ingest -- --file "${args.outGeoJson}" --srid 4326`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
