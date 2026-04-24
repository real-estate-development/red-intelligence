"use client";

import Link from "next/link";

type Props = {
  username: string;
  isAdmin: boolean;
};

export function AppHeader({ username, isAdmin }: Props) {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-center gap-4">
        <Link href="/map" className="text-sm font-semibold text-zinc-900 hover:underline dark:text-zinc-50">
          Building stock map
        </Link>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{username}</span>
      </div>
      <nav className="flex items-center gap-3 text-sm">
        <Link className="text-zinc-700 underline-offset-4 hover:underline dark:text-zinc-300" href="/map">
          Map
        </Link>
        {isAdmin ? (
          <Link className="text-zinc-700 underline-offset-4 hover:underline dark:text-zinc-300" href="/admin/users">
            Users
          </Link>
        ) : null}
        <button
          type="button"
          onClick={() => void logout()}
          className="rounded border border-zinc-300 px-3 py-1 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Log out
        </button>
      </nav>
    </header>
  );
}
