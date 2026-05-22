/**
 * Ingest GWR **Level A** buildings from the BFS MADD **public** national supply
 * (ZIP + `gebaeude_batiment_edificio.csv`, tab-separated, LV95 coordinates).
 *
 * Source: https://www.housing-stat.ch/de/data/supply/public.html
 * Delivery ZIPs: https://public.madd.bfs.admin.ch/{scope}.zip  (e.g. `ch`, `tg`, …)
 *
 * Usage:
 *   npm run gwr:ingest
 *   npm run gwr:ingest -- --scope tg
 *   npm run gwr:ingest -- --zip /path/to/tg.zip
 *   npm run gwr:ingest -- --file /path/to/gebaeude_batiment_edificio.csv
 *   npm run gwr:ingest -- --append --file …   (merge without wiping DB)
 */

import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config as loadEnv } from "dotenv";
import { Open } from "unzipper";
import { PrismaClient } from "@prisma/client";
import { ingestGwrCsvStream } from "./gwr-ingest-core";

loadEnv({ quiet: true });

const prisma = new PrismaClient();

const BUILDING_CSV = "gebaeude_batiment_edificio.csv";
const BFS_TAB = "\t";

const DEFAULT_BASE = "https://public.madd.bfs.admin.ch";

/** Two-letter canton code or `ch` for all Switzerland (large download). */
const SCOPE_RE = /^(ch|[a-z]{2})$/;

type ParsedArgs = {
  append: boolean;
  scope: string;
  baseUrl: string;
  file?: string;
  zip?: string;
  zipUrl?: string;
};

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  let append = false;
  let scope = (process.env.GWR_BFS_SCOPE ?? "ch").trim().toLowerCase();
  let baseUrl = (process.env.GWR_BFS_PUBLIC_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
  let file: string | undefined;
  let zip: string | undefined;
  let zipUrl: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--append") {
      append = true;
    } else if (a === "--scope" && argv[i + 1]) {
      scope = argv[++i].trim().toLowerCase();
    } else if (a === "--file" && argv[i + 1]) {
      file = argv[++i];
    } else if (a === "--zip" && argv[i + 1]) {
      zip = argv[++i];
    } else if (a === "--url" && argv[i + 1]) {
      zipUrl = argv[++i];
    } else if (a === "--base" && argv[i + 1]) {
      baseUrl = argv[++i].replace(/\/+$/, "");
    }
  }

  if (!SCOPE_RE.test(scope)) {
    throw new Error(`Invalid --scope "${scope}": expected "ch" or a two-letter canton code (e.g. tg).`);
  }

  return { append, scope, baseUrl, file, zip, zipUrl };
}

async function streamToFile(body: ReadableStream<Uint8Array>, dest: string): Promise<void> {
  await pipeline(Readable.fromWeb(body as import("stream/web").ReadableStream), createWriteStream(dest));
}

async function downloadZipTo(url: string, dest: string): Promise<void> {
  console.log(`Downloading: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ZIP download failed (${res.status}): ${url}`);
  }
  if (!res.body) {
    throw new Error("ZIP response has no body");
  }
  await streamToFile(res.body, dest);
}

async function openBuildingCsvStream(
  args: ParsedArgs
): Promise<{ stream: NodeJS.ReadableStream; cleanup?: () => void }> {
  if (args.file) {
    if (!existsSync(args.file)) {
      throw new Error(`File not found: ${args.file}`);
    }
    return { stream: createReadStream(args.file) };
  }

  if (args.zip) {
    if (!existsSync(args.zip)) {
      throw new Error(`ZIP not found: ${args.zip}`);
    }
    const directory = await Open.file(args.zip);
    const entry = directory.files.find((f) => f.path === BUILDING_CSV && f.type === "File");
    if (!entry) {
      throw new Error(
        `ZIP does not contain ${BUILDING_CSV}. ` +
          `Expected BFS public MADD layout (see https://www.housing-stat.ch/de/data/supply/public.html).`
      );
    }
    return { stream: entry.stream() };
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "gwr-ingest-"));
  const zipPath = path.join(tempDir, "gwr.zip");
  const url = args.zipUrl ?? `${args.baseUrl}/${args.scope}.zip`;

  try {
    await downloadZipTo(url, zipPath);
    const directory = await Open.file(zipPath);
    const entry = directory.files.find((f) => f.path === BUILDING_CSV && f.type === "File");
    if (!entry) {
      throw new Error(`ZIP from ${url} does not contain ${BUILDING_CSV}.`);
    }

    return {
      stream: entry.stream(),
      cleanup: () => {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      },
    };
  } catch (e) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

async function main() {
  const args = parseArgs();
  const replace = !args.append;

  if (!args.file && !args.zip) {
    const url = args.zipUrl ?? `${args.baseUrl}/${args.scope}.zip`;
    console.log(`BFS public GWR ingest — scope "${args.scope}" (${replace ? "replace" : "append"} mode)`);
    console.log(`ZIP: ${url}`);
    console.log(`Inside ZIP: ${BUILDING_CSV} (tab-separated, LV95; see housing-stat public data docs).`);
  }

  const { stream, cleanup } = await openBuildingCsvStream(args);

  try {
    const stats = await ingestGwrCsvStream(prisma, stream, {
      replace,
      delimiter: BFS_TAB,
      bom: false,
    });
    console.log(`Done. Rows parsed: ${stats.seen}, buildings inserted: ${stats.inserted}, rows skipped: ${stats.skipped}`);
  } finally {
    cleanup?.();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
