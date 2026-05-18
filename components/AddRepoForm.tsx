"use client";

import { useState, useTransition } from "react";
import { GitBranch, Plus } from "lucide-react";

export default function AddRepoForm() {
  const [repoUrl, setRepoUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submitRepo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    startTransition(async () => {
      const response = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setMessage(payload.error || "Could not save repository.");
        return;
      }

      setRepoUrl("");
      window.location.reload();
    });
  }

  return (
    <form onSubmit={submitRepo} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-white">
        <GitBranch className="h-4 w-4 text-orange-400" aria-hidden="true" />
        Add repository
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          value={repoUrl}
          onChange={(event) => setRepoUrl(event.target.value)}
          placeholder="https://github.com/owner/repo"
          className="h-10 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-orange-500"
        />
        <button
          type="submit"
          disabled={isPending || repoUrl.trim().length === 0}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-orange-500 px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Save repo
        </button>
      </div>

      <button
        type="button"
        disabled
        className="mt-3 inline-flex h-9 items-center justify-center rounded-md border border-zinc-800 px-3 text-sm text-zinc-500"
      >
        GitHub repo selector coming next
      </button>

      {message && <p className="mt-3 text-sm text-red-300">{message}</p>}
    </form>
  );
}
