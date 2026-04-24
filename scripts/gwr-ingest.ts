/**
 * Ingest GWR-style building CSV into SQLite (Prisma `Building`).
 *
 * Expected columns (Merkmalskatalog / cantonal CKAN exports, e.g. data.bs.ch):
 *   egid, gbauj, gkode, gkodn, ggdename, gebnr (optional), gbez (optional)
 * Delimiter: semicolon (;). LV95 coordinates in gkode (E) / gkodn (N).
 *
 * Default URL is the Kanton Basel-Stadt "Gebäude GWR" export (real register
 * data, not nationwide). Point GWR_CSV_URL or --file at a full extract when you have one.
 */

import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { config as loadEnv } from "dotenv";
import { parse } from "csv-parse";
import proj4 from "proj4";
import { PrismaClient } from "@prisma/client";

loadEnv({ quiet: true });

/** EPSG:2056 (CH1903+ / LV95) → WGS84 */
const LV95 =
  "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs";

const WGS84 = "EPSG:4326";

/** Example source: real GWR attributes, Kanton Basel-Stadt coverage only. */
const DEFAULT_GWR_CSV_URL =
  "https://data.bs.ch/api/explore/v2.1/catalog/datasets/100230/exports/csv?delimiter=%3B";

const prisma = new PrismaClient();

type Row = Record<string, string>;

function parseArgs() {
  const argv = process.argv.slice(2);
  let file: string | undefined;
  let url: string | undefined;
  let append = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" && argv[i + 1]) {
      file = argv[++i];
    } else if (a === "--url" && argv[i + 1]) {
      url = argv[++i];
    } else if (a === "--append") {
      append = true;
    }
  }
  return { file, url, replace: !append };
}

function buildAddress(row: Row): string {
  const place = (row.ggdename ?? "").trim();
  const nr = (row.gebnr ?? "").trim();
  const name = (row.gbez ?? "").trim();
  const parts: string[] = [];
  if (place) parts.push(place);
  if (nr) parts.push(`Geb. ${nr}`);
  if (name) parts.push(name);
  if (parts.length === 0) return `EGID ${row.egid}`;
  return parts.join(" · ");
}

function rowToBuilding(row: Row): { egid: string; address: string; yearBuilt: number; lat: number; lng: number } | null {
  const egid = String(row.egid ?? "").trim();
  if (!egid) return null;

  const yearBuilt = Number.parseInt(String(row.gbauj ?? "").trim(), 10);
  if (!Number.isFinite(yearBuilt) || yearBuilt < 1000 || yearBuilt > 2100) return null;

  const e = Number.parseFloat(String(row.gkode ?? "").replace(",", "."));
  const n = Number.parseFloat(String(row.gkodn ?? "").replace(",", "."));
  if (!Number.isFinite(e) || !Number.isFinite(n)) return null;

  const [lng, lat] = proj4(LV95, WGS84, [e, n]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  /* Rough Switzerland bounding box in WGS84 (excludes obvious projection mistakes) */
  if (lat < 45.5 || lat > 48.2 || lng < 5.7 || lng > 10.9) return null;

  return {
    egid,
    address: buildAddress(row),
    yearBuilt,
    lat,
    lng,
  };
}

async function openSourceStream(args: { file?: string; url?: string }): Promise<NodeJS.ReadableStream> {
  if (args.file) {
    if (!existsSync(args.file)) {
      throw new Error(
        `GWR CSV file not found: ${args.file}\n` +
          `Use a real path to your export, or omit --file to download the default Basel-Stadt CSV.`
      );
    }
    return createReadStream(args.file);
  }
  const target = args.url ?? process.env.GWR_CSV_URL ?? DEFAULT_GWR_CSV_URL;
  const res = await fetch(target);
  if (!res.ok) {
    throw new Error(`Failed to download GWR CSV (${res.status}): ${target}`);
  }
  if (!res.body) {
    throw new Error("Response has no body");
  }
  return Readable.fromWeb(res.body as import("stream/web").ReadableStream);
}

async function main() {
  const args = parseArgs();
  /** Smaller batches in append mode (each row is an `upsert`). */
  const batchSize = args.replace ? 120 : 40;
  const input = await openSourceStream(args);

  if (args.replace) {
    const deleted = await prisma.building.deleteMany({});
    console.log(`Replace mode: removed ${deleted.count} existing Building rows.`);
  }

  const parser = input.pipe(
    parse({
      columns: true,
      delimiter: ";",
      bom: true,
      relax_column_count: true,
      trim: true,
    })
  );

  let seen = 0;
  let inserted = 0;
  let skipped = 0;
  let batch: { egid: string; address: string; yearBuilt: number; lat: number; lng: number }[] = [];

  async function flush() {
    if (batch.length === 0) return;
    const dedup = new Map(batch.map((b) => [b.egid, b]));
    const data = [...dedup.values()];

    if (args.replace) {
      const res = await prisma.building.createMany({ data });
      inserted += res.count;
    } else {
      await prisma.$transaction(
        data.map((d) =>
          prisma.building.upsert({
            where: { egid: d.egid },
            create: d,
            update: {
              address: d.address,
              yearBuilt: d.yearBuilt,
              lat: d.lat,
              lng: d.lng,
            },
          })
        )
      );
      inserted += data.length;
    }
    batch = [];
  }

  for await (const row of parser as AsyncIterable<Row>) {
    seen++;
    const b = rowToBuilding(row);
    if (!b) {
      skipped++;
      continue;
    }
    batch.push(b);
    if (batch.length >= batchSize) {
      await flush();
    }
    if (seen % 50_000 === 0) {
      console.log(`… ${seen} rows read, ${inserted} inserted, ${skipped} skipped`);
    }
  }

  await flush();

  console.log(`Done. Rows parsed: ${seen}, buildings inserted: ${inserted}, rows skipped: ${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
