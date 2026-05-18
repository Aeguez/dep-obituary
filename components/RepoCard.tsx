"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { formatRelativeDate } from "@/lib/repo-utils";

interface RepoSnapshot {
  totalPackages?: number;
  criticalCount?: number;
  highCount?: number;
  overallHealth?: number;
}

interface RepoCardProps {
  id: string;
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string;
  lastScanAt: string | null;
  snapshot: RepoSnapshot | null;
}

export default function RepoCard({
  id,
  repoOwner,
  repoName,
  repoUrl,
  lastScanAt,
  snapshot,
}: RepoCardProps) {
  const [isPending, startTransition] = useTransition();
  const displayName = repoOwner && repoName ? `${repoOwner}/${repoName}` : repoUrl;
  const overallHealth = snapshot?.overallHealth ?? null;

  function scanNow() {
    startTransition(async () => {
      await fetch(`/api/repos/${id}/scan`, { method: "POST" });
      window.location.reload();
    });
  }

  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-sm font-semibold text-white hover:text-orange-300"
          >
            {displayName}
          </a>
          <p className="mt-2 text-sm text-zinc-400">Last scanned {formatRelativeDate(lastScanAt)}</p>
        </div>

        <button
          type="button"
          onClick={scanNow}
          disabled={isPending}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-orange-500 px-3 text-sm font-semibold text-zinc-950 transition-colors hover:bg-orange-400 disabled:cursor-wait disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} aria-hidden="true" />
          Scan now
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Packages" value={snapshot?.totalPackages ?? "—"} />
        <Metric label="Critical" value={snapshot?.criticalCount ?? "—"} tone="text-red-300" />
        <Metric label="High" value={snapshot?.highCount ?? "—"} tone="text-orange-300" />
        <Metric
          label="Health"
          value={overallHealth === null ? "—" : `${overallHealth}/100`}
          tone={overallHealth !== null && overallHealth < 60 ? "text-yellow-300" : "text-emerald-300"}
        />
      </div>
    </article>
  );
}

function Metric({
  label,
  value,
  tone = "text-zinc-100",
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2">
      <p className="text-xs uppercase text-zinc-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${tone}`}>{value}</p>
    </div>
  );
}
