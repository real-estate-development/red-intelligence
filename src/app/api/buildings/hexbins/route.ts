import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { aggregateBuildingsIntoHexBins, parseBBox } from "@/lib/hexbins";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const bbox = parseBBox(url.searchParams);
  if (!bbox) {
    return NextResponse.json({ error: "Invalid or missing south, west, north, east query params" }, { status: 400 });
  }

  const cellsParam = url.searchParams.get("cells");
  const targetCells = Math.min(150, Math.max(40, cellsParam ? Number.parseInt(cellsParam, 10) : 100));
  if (!Number.isFinite(targetCells)) {
    return NextResponse.json({ error: "Invalid cells parameter" }, { status: 400 });
  }

  const [west, south, east, north] = bbox;
  const rows = await prisma.building.findMany({
    where: {
      lat: { gte: south, lte: north },
      lng: { gte: west, lte: east },
    },
    select: { lat: true, lng: true, yearBuilt: true },
  });

  const hexbins = aggregateBuildingsIntoHexBins(bbox, rows, targetCells);

  return NextResponse.json({
    hexbins: hexbins.map((h) => ({
      id: h.id,
      ring: h.ring,
      count: h.count,
      yearMean: h.yearMean,
      yearStdDev: h.yearStdDev,
    })),
    buildingCount: rows.length,
    targetCells,
  });
}
