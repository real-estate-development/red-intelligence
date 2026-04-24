import type { SessionOptions } from "iron-session";

export type SessionData = {
  userId?: string;
  username?: string;
  isAdmin?: boolean;
};

function sessionPassword(): string {
  const p = process.env.SESSION_PASSWORD;
  if (!p || p.length < 32) {
    throw new Error(
      "SESSION_PASSWORD must be set to a random string of at least 32 characters (iron-session requirement)."
    );
  }
  return p;
}

export function getSessionOptions(): SessionOptions {
  return {
    password: sessionPassword(),
    cookieName: "red_intelligence_session",
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 14,
    },
  };
}
