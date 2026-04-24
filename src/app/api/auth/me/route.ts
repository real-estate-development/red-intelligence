import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ user: null });
  }
  return NextResponse.json({
    user: {
      id: session.userId,
      username: session.username,
      isAdmin: Boolean(session.isAdmin),
    },
  });
}
