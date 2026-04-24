import { NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { getSessionOptions, type SessionData } from "@/lib/session";

export async function POST() {
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, getSessionOptions());
  session.destroy();
  return NextResponse.json({ ok: true });
}
