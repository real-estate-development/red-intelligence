import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

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

  console.log("Seed: admin user ensured. Load buildings with: npm run gwr:ingest");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
