import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

const patchSchema = z.object({
  password: z.string().min(8).max(256).optional(),
  isAdmin: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, context: RouteContext) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const session = await getSession();
  const data: { passwordHash?: string; isAdmin?: boolean } = {};
  if (parsed.data.password) {
    data.passwordHash = await hashPassword(parsed.data.password);
  }
  if (typeof parsed.data.isAdmin === "boolean") {
    if (target.id === session.userId && parsed.data.isAdmin === false) {
      const otherAdmins = await prisma.user.count({
        where: { isAdmin: true, id: { not: target.id } },
      });
      if (otherAdmins === 0) {
        return NextResponse.json({ error: "Cannot remove the last admin" }, { status: 400 });
      }
    }
    data.isAdmin = parsed.data.isAdmin;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No changes" }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, username: true, isAdmin: true, createdAt: true },
  });
  return NextResponse.json({ user });
}

export async function DELETE(_req: Request, context: RouteContext) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  const session = await getSession();
  if (id === session.userId) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (target.isAdmin) {
    const admins = await prisma.user.count({ where: { isAdmin: true } });
    if (admins <= 1) {
      return NextResponse.json({ error: "Cannot delete the last admin" }, { status: 400 });
    }
  }

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
