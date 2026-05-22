/**
 * GWR building rows → Prisma `Building` (LV95 → WGS84).
 * Supports BFS MADD **public** tab-delimited `gebaeude_batiment_edificio.csv` (housing-stat Level A).
 */

import { parse } from "csv-parse";
import proj4 from "proj4";
import type { PrismaClient } from "@prisma/client";
/** EPSG:2056 (CH1903+ / LV95) → WGS84 */
const LV95 =
  "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs";

const WGS84 = "EPSG:4326";

export type GwrRow = Record<string, string>;

/** BFS public CSV uses uppercase headers (`EGID`, …); normalize to lowercase GWR keys. */
export function normalizeGwrRow(row: Record<string, string>): GwrRow {
  const out: GwrRow = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.toLowerCase()] = v ?? "";
  }
  return out;
}

export function buildAddress(row: GwrRow): string {
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

function rowCanton(row: GwrRow): string | null {
  const raw = String(row.gdekt ?? "").trim().toUpperCase();
  if (!raw) return null;
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  return null;
}

export function rowToBuilding(
  row: GwrRow
): { egid: string; address: string; yearBuilt: number; lat: number; lng: number; canton: string | null } | null {
  const egid = String(row.egid ?? "").trim();
  if (!egid) return null;

  const yearBuilt = Number.parseInt(String(row.gbauj ?? "").trim(), 10);
  if (!Number.isFinite(yearBuilt) || yearBuilt < 1000 || yearBuilt > 2100) return null;

  const e = Number.parseFloat(String(row.gkode ?? "").replace(",", "."));
  const n = Number.parseFloat(String(row.gkodn ?? "").replace(",", "."));
  if (!Number.isFinite(e) || !Number.isFinite(n)) return null;

  const [lng, lat] = proj4(LV95, WGS84, [e, n]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 45.5 || lat > 48.2 || lng < 5.7 || lng > 10.9) return null;

  return {
    egid,
    address: buildAddress(row),
    yearBuilt,
    lat,
    lng,
    canton: rowCanton(row),
  };
}

export type IngestStats = { seen: number; inserted: number; skipped: number };

export type IngestCsvOptions = {
  replace: boolean;
  /** Field delimiter, e.g. `"\t"` (BFS public), `";"` (legacy). */
  delimiter: string;
  /** UTF-8 BOM (BFS public supply has none). */
  bom?: boolean;
};

export async function ingestGwrCsvStream(
  prisma: PrismaClient,
  input: NodeJS.ReadableStream,
  options: IngestCsvOptions
): Promise<IngestStats> {
  const batchSize = options.replace ? 120 : 40;
  const bom = options.bom ?? false;

  if (options.replace) {
    const deleted = await prisma.building.deleteMany({});
    console.log(`Replace mode: removed ${deleted.count} existing Building rows.`);
  }

  const parser = input.pipe(
    parse({
      columns: true,
      delimiter: options.delimiter,
      bom,
      relax_column_count: true,
      trim: true,
    })
  );

  let seen = 0;
  let inserted = 0;
  let skipped = 0;
  let batch: NonNullable<ReturnType<typeof rowToBuilding>>[] = [];

  async function flush() {
    if (batch.length === 0) return;
    const dedup = new Map(batch.map((b) => [b.egid, b]));
    const data = [...dedup.values()];

    if (options.replace) {
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
              canton: d.canton,
            },
          })
        )
      );
      inserted += data.length;
    }
    batch = [];
  }

  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    seen++;
    const b = rowToBuilding(normalizeGwrRow(row));
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

  return { seen, inserted, skipped };
}
