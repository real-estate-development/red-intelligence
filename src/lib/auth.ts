import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { getSessionOptions, type SessionData } from "@/lib/session";

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, getSessionOptions());
}

export async function requireUser() {
  const session = await getSession();
  if (!session.userId) return null;
  return session;
}

export async function requireAdmin() {
  const session = await getSession();
  if (!session.userId || !session.isAdmin) return null;
  return session;
}
