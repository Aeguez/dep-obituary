"use client";

import { useMemo, useState } from "react";
import type { ScanResponse } from "@/app/api/scan/route";
import type { ScoreResult } from "@/lib/scorer";

interface Props {
  data: ScanResponse;
  onReset: () => void;
}

type Filter = "all" | ScoreResult["riskLevel"];

const filters: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "critical", label: "Critical" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
  { key: "healthy", label: "Healthy" },
];

const riskConfig = {
  critical: {
    badge: "💀 Critical",
    text: "text-red-300",
    border: "border-red-800",
    bg: "bg-red-950/35",
    circle: "bg-red-500/15 text-red-300 ring-red-500/30",
    bar: "bg-red-500",
  },
  high: {
    badge: "⚠️ High",
    text: "text-orange-300",
    border: "border-orange-800",
    bg: "bg-orange-950/30",
    circle: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
    bar: "bg-orange-500",
  },
  medium: {
    badge: "🔶 Medium",
    text: "text-yellow-300",
    border: "border-yellow-800",
    bg: "bg-yellow-950/25",
    circle: "bg-yellow-500/15 text-yellow-300 ring-yellow-500/30",
    bar: "bg-yellow-500",
  },
  low: {
    badge: "Low",
    text: "text-sky-300",
    border: "border-sky-800",
    bg: "bg-sky-950/20",
    circle: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
    bar: "bg-sky-500",
  },
  healthy: {
    badge: "✅ Healthy",
    text: "text-emerald-300",
    border: "border-emerald-800",
    bg: "bg-emerald-950/20",
    circle: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    bar: "bg-emerald-500",
  },
} satisfies Record<ScoreResult["riskLevel"], Record<string, string>>;

export default function ResultsDashboard({ data, onReset }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedName, setExpandedName] = useState<string | null>(null);

  const sortedResults = useMemo(
    () => [...data.results].sort((a, b) => a.score - b.score),
    [data.results]
  );
  const filteredResults =
    filter === "all"
      ? sortedResults
      : sortedResults.filter((result) => result.riskLevel === filter);

  const healthyCount = data.results.filter((result) => result.riskLevel === "healthy").length;

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-5xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-3">
              <span className="text-3xl" aria-hidden="true">
                ⚰️
              </span>
              <p className="text-sm font-semibold text-orange-400">Dependency Obituary</p>
            </div>
            <h1 className="text-2xl font-semibold text-white sm:text-4xl">Scan results</h1>
            <p className="mt-2 text-sm text-zinc-400">
              Worst packages are sorted first so you can triage the riskiest dependencies.
            </p>
          </div>

          <button
            type="button"
            onClick={onReset}
            className="inline-flex h-10 items-center justify-center rounded-md bg-orange-500 px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-orange-400"
          >
            Scan another file
          </button>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70">
          <div className="grid grid-cols-2 border-b border-zinc-800 sm:grid-cols-4">
            <SummaryItem label="Total packages" value={data.totalPackages} />
            <SummaryItem label="Critical" value={data.criticalCount} tone="text-red-300" />
            <SummaryItem label="High" value={data.highCount} tone="text-orange-300" />
            <SummaryItem label="Healthy" value={healthyCount} tone="text-emerald-300" />
          </div>

          {data.criticalCount > 0 && (
            <div className="m-4 rounded-md border border-red-800 bg-red-950/35 px-4 py-3 text-sm text-red-200">
              <strong className="font-semibold text-red-100">Critical packages found.</strong>{" "}
              {data.criticalCount} package{data.criticalCount === 1 ? " is" : "s are"} deprecated,
              archived, or effectively abandoned.
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-b border-zinc-800 px-4 py-4">
            {filters.map((item) => {
              const count =
                item.key === "all"
                  ? data.results.length
                  : data.results.filter((result) => result.riskLevel === item.key).length;
              const active = filter === item.key;

              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setFilter(item.key)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "border-orange-500 bg-orange-500 text-zinc-950"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white"
                  }`}
                >
                  {item.label} ({count})
                </button>
              );
            })}
          </div>

          <div className="divide-y divide-zinc-800">
            {filteredResults.map((pkg) => (
              <PackageRow
                key={pkg.name}
                pkg={pkg}
                expanded={expandedName === pkg.name}
                onToggle={() => setExpandedName(expandedName === pkg.name ? null : pkg.name)}
              />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function SummaryItem({
  label,
  value,
  tone = "text-zinc-100",
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="border-b border-zinc-800 px-4 py-4 even:border-l sm:border-b-0 sm:border-l sm:first:border-l-0">
      <p className="text-xs font-medium uppercase text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

function PackageRow({
  pkg,
  expanded,
  onToggle,
}: {
  pkg: ScoreResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  const config = riskConfig[pkg.riskLevel];

  return (
    <article className={expanded ? `${config.bg}` : "bg-transparent"}>
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[auto,1fr] gap-4 px-4 py-4 text-left transition-colors hover:bg-zinc-800/50 md:grid-cols-[auto,1fr,auto]"
      >
        <span
          className={`flex h-12 w-12 items-center justify-center rounded-full text-sm font-bold ring-1 ${config.circle}`}
        >
          {pkg.score}
        </span>

        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-zinc-100">{pkg.name}</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-medium ${config.border} ${config.bg} ${config.text}`}
            >
              {config.badge}
            </span>
          </span>
          <span className="mt-1 block text-sm text-zinc-400">{pkg.summary}</span>
        </span>

        <span className="col-span-2 flex items-center justify-between gap-4 text-sm text-zinc-400 md:col-span-1 md:block md:text-right">
          <span className="text-xs uppercase text-zinc-500 md:block">Last release</span>
          <span className="md:mt-1 md:block">{formatReleaseAge(pkg.metrics.daysSinceLastRelease)}</span>
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-5 md:pl-20">
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(pkg.breakdown).map(([metric, item]) => (
              <div key={metric}>
                <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                  <span className="capitalize text-zinc-400">{metric.replace(/([A-Z])/g, " $1")}</span>
                  <span className="font-medium text-zinc-300">{item.score}/100</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={`h-full rounded-full ${config.bar}`}
                    style={{ width: `${item.score}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-zinc-500">{item.label}</p>
              </div>
            ))}
          </div>

          {pkg.alternativeSuggestion && (
            <div className="mt-4 rounded-md border border-orange-800 bg-orange-950/25 px-4 py-3 text-sm text-orange-100">
              <span className="font-semibold">Alternative:</span> {pkg.alternativeSuggestion}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function formatReleaseAge(days: number) {
  if (days >= 9999) return "Unknown";
  if (days === 0) return "Today";
  if (days < 365) return `${days}d ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}
