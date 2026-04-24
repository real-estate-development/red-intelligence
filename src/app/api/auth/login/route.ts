import { NextResponse } from "next/server";
import { z } from "zod";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { getSessionOptions, type SessionData } from "@/lib/session";

const bodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid credentials payload" }, { status: 400 });
  }
  const { username, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, getSessionOptions());
  session.userId = user.id;
  session.username = user.username;
  session.isAdmin = user.isAdmin;
  await session.save();

  return NextResponse.json({ ok: true, isAdmin: user.isAdmin });
}
