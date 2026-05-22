import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  if (process.env.SEED_ADMIN_PASSWORD === undefined) {
    throw new Error("SEED_ADMIN_PASSWORD must be set for prisma db seed");
  }
  const password = process.env.SEED_ADMIN_PASSWORD;
  const username = process.env.SEED_ADMIN_USERNAME ?? "admin";
  const hash = await bcrypt.hash(password, 10);
  await prisma.user.upsert({
    where: { username },
    create: { username, passwordHash: hash, isAdmin: true },
    update: { passwordHash: hash, isAdmin: true },
  });

  console.log("Seed: admin user ensured. Load buildings with: npm run gwr:ingest (BFS public ZIP; try GWR_BFS_SCOPE=tg for a smaller first run)");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
