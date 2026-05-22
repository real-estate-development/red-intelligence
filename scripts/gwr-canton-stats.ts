/**
 * Print mean / median building year and mean age (years since construction)
 * per canton from ingested `Building` rows. Requires `canton` populated (GWR `gdekt`).
 *
 * Usage: `tsx scripts/gwr-canton-stats.ts` [--year 2026]
 */

import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";

loadEnv({ quiet: true });

const prisma = new PrismaClient();

function parseYear(): number {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--year" && argv[i + 1]) {
      const y = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(y) && y >= 1900 && y <= 2200) return y;
    }
  }
  return new Date().getFullYear();
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return NaN;
  const m = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[m];
  return (sorted[m - 1] + sorted[m]) / 2;
}

async function main() {
  const refYear = parseYear();
  const rows = await prisma.building.findMany({
    where: { canton: { not: null } },
    select: { canton: true, yearBuilt: true },
  });

  const byCanton = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.canton) continue;
    const list = byCanton.get(r.canton) ?? [];
    list.push(r.yearBuilt);
    byCanton.set(r.canton, list);
  }

  if (byCanton.size === 0) {
    console.log(
      "No buildings with `canton` set. Run GWR ingest after schema includes `canton` (from `gdekt`), " +
        "or re-ingest existing data."
    );
    return;
  }

  const lines: { canton: string; n: number; meanYear: number; medianYear: number; meanAge: number }[] = [];
  for (const [canton, years] of byCanton) {
    const n = years.length;
    const meanYear = years.reduce((a, b) => a + b, 0) / n;
    const sorted = [...years].sort((a, b) => a - b);
    const medianYear = median(sorted);
    lines.push({
      canton,
      n,
      meanYear: Math.round(meanYear * 10) / 10,
      medianYear,
      meanAge: Math.round((refYear - meanYear) * 10) / 10,
    });
  }

  lines.sort((a, b) => a.canton.localeCompare(b.canton));

  console.log(`Reference year: ${refYear} (mean age ≈ ${refYear} − mean year built)\n`);
  console.log(
    ["canton", "buildings", "meanYear", "medianYear", "meanAge"].join("\t")
  );
  for (const l of lines) {
    console.log([l.canton, l.n, l.meanYear, l.medianYear, l.meanAge].join("\t"));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
