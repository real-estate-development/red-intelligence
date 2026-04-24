import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await prisma.building.findMany({
    orderBy: { egid: "asc" },
  });

  return NextResponse.json({
    buildings: rows.map((b) => ({
      id: b.id,
      egid: b.egid,
      address: b.address,
      yearBuilt: b.yearBuilt,
      lat: b.lat,
      lng: b.lng,
    })),
  });
}
