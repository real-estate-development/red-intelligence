/**
 * One-command swissBUILDINGS3D pipeline:
 * download tiles from STAC -> convert -> ingest footprints.
 *
 * Example:
 *   npm run swissbuildings3d:full -- --bbox 7.55,47.53,7.63,47.58
 */

import { spawnSync } from "node:child_process";

const BASEL_STADT_BBOX = "7.53,47.52,7.64,47.60";

function parseArgs() {
  const argv = process.argv.slice(2);
  let bbox: string | undefined;
  let clipBbox: string | undefined;
  let year: string | undefined;
  let limit: string | undefined;
  let pageSize: string | undefined;
  let outDir: string | undefined;
  let layer: string | undefined;
  let append = false;
  let baselStadt = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bbox" && argv[i + 1]) bbox = argv[++i];
    else if (a === "--clip-bbox" && argv[i + 1]) clipBbox = argv[++i];
    else if (a === "--year" && argv[i + 1]) year = argv[++i];
    else if (a === "--limit" && argv[i + 1]) limit = argv[++i];
    else if (a === "--page-size" && argv[i + 1]) pageSize = argv[++i];
    else if (a === "--out-dir" && argv[i + 1]) outDir = argv[++i];
    else if (a === "--layer" && argv[i + 1]) layer = argv[++i];
    else if (a === "--append") append = true;
    else if (a === "--basel-stadt") baselStadt = true;
  }
  return { bbox, clipBbox, year, limit, pageSize, outDir, layer, append, baselStadt };
}

function runStep(step: string, args: string[]) {
  console.log(`\n== ${step} ==`);
  const proc = spawnSync("npx", ["tsx", ...args], { stdio: "inherit", encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(`Step failed: ${step}`);
  }
}

async function main() {
  const args = parseArgs();
  const effectiveBbox = args.baselStadt ? BASEL_STADT_BBOX : args.bbox;
  const effectiveClipBbox = args.baselStadt ? BASEL_STADT_BBOX : args.clipBbox;
  const effectiveYear = args.year ?? (args.baselStadt ? "2021" : undefined);
  const outDir = args.outDir ?? process.env.SWISSBUILDINGS3D_OUT_DIR ?? "data/swissbuildings3d";
  const manifestPath = `${outDir}/manifest.json`;

  const pipelineArgs = ["scripts/swissbuildings3d-pipeline.ts"];
  if (effectiveBbox) pipelineArgs.push("--bbox", effectiveBbox);
  if (effectiveYear) pipelineArgs.push("--year", effectiveYear);
  if (args.limit) pipelineArgs.push("--limit", args.limit);
  if (args.pageSize) pipelineArgs.push("--page-size", args.pageSize);
  if (args.outDir) pipelineArgs.push("--out-dir", args.outDir);
  runStep("Download STAC tiles", pipelineArgs);

  const convertArgs = ["scripts/swissbuildings3d-convert.ts", "--manifest", manifestPath, "--ingest"];
  if (effectiveClipBbox) convertArgs.push("--clip-bbox", effectiveClipBbox);
  if (args.layer) convertArgs.push("--layer", args.layer);
  if (args.append) convertArgs.push("--append");
  runStep("Convert + ingest footprints", convertArgs);

  console.log("\nDone. swissBUILDINGS3D full pipeline completed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
