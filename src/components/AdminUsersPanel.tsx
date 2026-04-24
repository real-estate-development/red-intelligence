"use client";

import { useCallback, useEffect, useState } from "react";

type UserRow = {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
};

export function AdminUsersPanel() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/admin/users", { credentials: "include" });
    const data = (await res.json()) as { users?: UserRow[]; error?: string };
    if (!res.ok) {
      setError(data.error ?? "Failed to load users");
      return;
    }
    setUsers(data.users ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          isAdmin: newIsAdmin,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Create failed");
        return;
      }
      setNewUsername("");
      setNewPassword("");
      setNewIsAdmin(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(id: string) {
    if (!confirm("Remove this user?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE", credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Delete failed");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!users) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">User administration</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Create and remove accounts. Passwords are stored hashed (bcrypt).</p>
      </div>

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      <form onSubmit={createUser} className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
        <h2 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Add user</h2>
        <div className="flex flex-wrap gap-3">
          <input
            placeholder="Username"
            className="min-w-[10rem] flex-1 rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            pattern="[a-zA-Z0-9_-]{2,64}"
            required
          />
          <input
            placeholder="Password (min 8)"
            type="password"
            className="min-w-[10rem] flex-1 rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
            required
          />
          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input type="checkbox" checked={newIsAdmin} onChange={(e) => setNewIsAdmin(e.target.checked)} />
            Admin
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Add
          </button>
        </div>
      </form>

      <div>
        <h2 className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">Users</h2>
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-700 dark:border-zinc-700">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <div>
                <span className="font-medium text-zinc-900 dark:text-zinc-50">{u.username}</span>
                {u.isAdmin ? (
                  <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                    admin
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void removeUser(u.id)}
                className="text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
