import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

const createSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(8).max(256),
  isAdmin: z.boolean().optional(),
});

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    orderBy: { username: "asc" },
    select: { id: true, username: true, isAdmin: true, createdAt: true },
  });
  return NextResponse.json({ users });
}

export async function POST(req: Request) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const { username, password, isAdmin } = parsed.data;
  try {
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
        isAdmin: isAdmin ?? false,
      },
      select: { id: true, username: true, isAdmin: true, createdAt: true },
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Username already exists" }, { status: 409 });
  }
}
