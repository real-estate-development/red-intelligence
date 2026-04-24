import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

/** Representative Swiss coordinates — demo EGIDs until GWR pipeline lands. */
const DEMO_BUILDINGS = [
  { egid: "100000001", address: "Bahnhofstrasse 1, 8001 Zürich", yearBuilt: 1898, lat: 47.3769, lng: 8.5417 },
  { egid: "100000002", address: "Bundesgasse 1, 3003 Bern", yearBuilt: 1964, lat: 46.948, lng: 7.4474 },
  { egid: "100000003", address: "Rue du Rhône 1, 1204 Genève", yearBuilt: 1978, lat: 46.2044, lng: 6.1432 },
  { egid: "100000004", address: "Piazza della Riforma 1, 6900 Lugano", yearBuilt: 1922, lat: 46.0037, lng: 8.9511 },
  { egid: "100000005", address: "Marktplatz 1, 4051 Basel", yearBuilt: 1955, lat: 47.5596, lng: 7.5886 },
  { egid: "100000006", address: "Place de la Palud 1, 1003 Lausanne", yearBuilt: 2001, lat: 46.5197, lng: 6.6323 },
  { egid: "100000007", address: "Bahnhofplatz 1, 3900 Brig", yearBuilt: 1988, lat: 46.315, lng: 7.9881 },
  { egid: "100000008", address: "Hauptstrasse 10, 8645 Jona", yearBuilt: 1934, lat: 47.229, lng: 8.835 },
  { egid: "100000009", address: "Poststrasse 5, 9000 St. Gallen", yearBuilt: 2010, lat: 47.4245, lng: 9.3767 },
  { egid: "100000010", address: "Seestrasse 20, 8800 Thalwil", yearBuilt: 1967, lat: 47.294, lng: 8.563 },
  { egid: "100000011", address: "Avenue de la Gare 3, 1950 Sion", yearBuilt: 1945, lat: 46.2276, lng: 7.3595 },
  { egid: "100000012", address: "Neumarkt 1, 6000 Luzern", yearBuilt: 1912, lat: 47.0502, lng: 8.3093 },
];

async function main() {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error("SEED_ADMIN_PASSWORD must be set (min 8 characters) for prisma db seed");
  }
  const username = process.env.SEED_ADMIN_USERNAME ?? "admin";
  const hash = await bcrypt.hash(password, 10);
  await prisma.user.upsert({
    where: { username },
    create: { username, passwordHash: hash, isAdmin: true },
    update: { passwordHash: hash, isAdmin: true },
  });

  for (const b of DEMO_BUILDINGS) {
    await prisma.building.upsert({
      where: { egid: b.egid },
      create: b,
      update: {
        address: b.address,
        yearBuilt: b.yearBuilt,
        lat: b.lat,
        lng: b.lng,
      },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
