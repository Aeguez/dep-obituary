// app/api/scan/route.ts
// POST /api/scan — receives a package.json or requirements.txt and returns scores

import { NextRequest, NextResponse } from "next/server";
import {
  parsePackageJson,
  parseRequirementsTxt,
  type ParsedDependency,
} from "@/lib/fetchers";
import { parseGitHubRepoUrl } from "@/lib/repo-utils";
import { calculateScore, ScoreResult } from "@/lib/scorer";
import type { PackageMetrics } from "@/lib/scorer";

export const maxDuration = 60; // Vercel: allow up to 60s for large dependency lists

export interface ScanResponse {
  results: ScoreResult[];
  totalPackages: number;
  criticalCount: number;
  highCount: number;
  scanId: string;
  scannedAt: string;
}

const MAX_PACKAGES_PER_SCAN = 5;
const FAST_FETCH_TIMEOUT_MS = 1_500;
const GITHUB_FETCH_TIMEOUT_MS = 3_000;

interface DependencyFile {
  filename: string;
  content: string;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FAST_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      new Promise<Response>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function scanDependency(dep: ParsedDependency): Promise<ScoreResult> {
  // Public upload scans must return quickly on Vercel. Use registry data here and
  // reserve Supabase/GitHub-heavy scans for the GitHub App and repo monitor flows.
  const metrics = await fetchQuickMetrics(dep).catch((error) => {
    console.warn(`Quick scan failed for ${dep.type}:${dep.name}; using fallback metrics.`, error);
    return buildFallbackMetrics(dep);
  });
  const result = calculateScore(metrics);

  return result;
}

async function fetchQuickMetrics(dep: ParsedDependency): Promise<PackageMetrics> {
  return dep.type === "pypi" ? fetchQuickPyPIMetrics(dep.name) : fetchQuickNpmMetrics(dep.name);
}

async function fetchQuickNpmMetrics(packageName: string): Promise<PackageMetrics> {
  const encoded = encodeURIComponent(packageName);
  const registryRes = await fetchWithTimeout(`https://registry.npmjs.org/${encoded}`, {
    headers: { Accept: "application/json" },
  });

  if (!registryRes.ok) {
    throw new Error(`Package "${packageName}" not found on npm`);
  }

  const registry = await registryRes.json();
  const latestVersion = registry["dist-tags"]?.latest;
  const latestMeta = registry.versions?.[latestVersion] || {};
  const lastReleaseDate = latestVersion ? registry.time?.[latestVersion] || null : null;
  const daysSinceLastRelease = lastReleaseDate
    ? Math.floor((Date.now() - new Date(lastReleaseDate).getTime()) / 86400000)
    : 9999;

  const repoUrl: string = registry.repository?.url || latestMeta.repository?.url || "";
  const ghMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);

  return {
    name: packageName,
    repoOwner: ghMatch?.[1] || null,
    repoName: ghMatch?.[2]?.replace(/\.git$/, "") || null,
    commitsLast90Days: 15,
    daysSinceLastRelease,
    maintainersCount: registry.maintainers?.length || 1,
    openIssues: 0,
    closedIssues: 0,
    weeklyDownloads: 0,
    downloadTrend: 0,
    isArchived: false,
    isDeprecated: !!latestMeta.deprecated,
    lastReleaseDate,
    alternativeSuggestion: null,
  };
}

function buildFallbackMetrics(dep: ParsedDependency): PackageMetrics {
  return {
    name: dep.name,
    repoOwner: null,
    repoName: null,
    commitsLast90Days: 0,
    daysSinceLastRelease: 9999,
    maintainersCount: 1,
    openIssues: 0,
    closedIssues: 0,
    weeklyDownloads: 0,
    downloadTrend: 0,
    isArchived: false,
    isDeprecated: false,
    lastReleaseDate: null,
    alternativeSuggestion: null,
  };
}

async function fetchRepoDependencyFiles(repoUrl: string): Promise<DependencyFile[]> {
  const parsedRepo = parseGitHubRepoUrl(repoUrl);
  if (!parsedRepo) {
    throw new Error("Enter a valid GitHub repository URL.");
  }

  const files = await Promise.all(
    ["package.json", "requirements.txt"].map(async (filename) => {
      const content = await fetchGitHubFile(
        parsedRepo.repoOwner,
        parsedRepo.repoName,
        filename
      );
      return content ? { filename, content } : null;
    })
  );

  return files.filter((file): file is DependencyFile => file !== null);
}

async function fetchGitHubFile(owner: string, repo: string, path: string): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { headers },
    GITHUB_FETCH_TIMEOUT_MS
  ).catch(() => null);

  if (!response || response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Could not read ${path} from GitHub (${response.status}).`);
  }

  const payload = await response.json();
  if (Array.isArray(payload) || payload.type !== "file" || typeof payload.content !== "string") {
    return null;
  }

  return Buffer.from(payload.content, "base64").toString("utf8");
}

function parseDependencyFile({ filename, content }: DependencyFile): ParsedDependency[] {
  return filename.endsWith("requirements.txt") || filename.endsWith(".txt")
    ? parseRequirementsTxt(content)
    : parsePackageJson(content);
}

async function fetchQuickPyPIMetrics(packageName: string): Promise<PackageMetrics> {
  const encoded = encodeURIComponent(packageName);
  const res = await fetchWithTimeout(`https://pypi.org/pypi/${encoded}/json`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Package "${packageName}" not found on PyPI`);
  }

  const data = await res.json();
  const info = data.info || {};
  const latestVersion = info.version;
  const releaseFiles = latestVersion ? data.releases?.[latestVersion] || [] : [];
  const lastReleaseDate =
    releaseFiles
      .map((file: { upload_time_iso_8601?: string; upload_time?: string }) =>
        file.upload_time_iso_8601 || file.upload_time
      )
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  const daysSinceLastRelease = lastReleaseDate
    ? Math.floor((Date.now() - new Date(lastReleaseDate).getTime()) / 86400000)
    : 9999;

  const maintainers = [info.maintainer, info.author]
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  const githubUrl = [
    ...Object.values((info.project_urls || {}) as Record<string, string>),
    info.home_page,
  ]
    .filter(Boolean)
    .find((url) => /github\.com/i.test(String(url)));
  const ghMatch = String(githubUrl || "").match(/github\.com[/:]([^/\s]+)\/([^/#?\s.]+)/i);

  return {
    name: packageName,
    repoOwner: ghMatch?.[1] || null,
    repoName: ghMatch?.[2]?.replace(/\.git$/, "") || null,
    commitsLast90Days: 15,
    daysSinceLastRelease,
    maintainersCount: Math.max(1, new Set(maintainers).size),
    openIssues: 0,
    closedIssues: 0,
    weeklyDownloads: 0,
    downloadTrend: 0,
    isArchived: false,
    isDeprecated: false,
    lastReleaseDate,
    alternativeSuggestion: null,
  };
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const textContent = formData.get("content") as string | null;
    const repoUrl = String(formData.get("repoUrl") || "").trim();

    let deps: ParsedDependency[];

    if (repoUrl) {
      const dependencyFiles = await fetchRepoDependencyFiles(repoUrl);
      if (dependencyFiles.length === 0) {
        return NextResponse.json(
          { error: "No package.json or requirements.txt file found at the repo root." },
          { status: 404 }
        );
      }
      deps = dependencyFiles.flatMap(parseDependencyFile);
    } else if (file) {
      deps = parseDependencyFile({ filename: file.name, content: await file.text() });
    } else if (textContent) {
      deps = parseDependencyFile({
        filename: (formData.get("filename") as string) || "package.json",
        content: textContent,
      });
    } else {
      return NextResponse.json({ error: "No file or GitHub repo URL provided" }, { status: 400 });
    }

    if (deps.length === 0) {
      return NextResponse.json({ error: "No dependencies found" }, { status: 400 });
    }

    const productionDeps = deps.filter((dep) => !dep.isDev);
    const depsToScan = (productionDeps.length > 0 ? productionDeps : deps).slice(
      0,
      MAX_PACKAGES_PER_SCAN
    );
    // Fetch metrics in parallel with concurrency limit of 5
    const results: ScoreResult[] = [];
    const chunkSize = 5;

    for (let i = 0; i < depsToScan.length; i += chunkSize) {
      const chunk = depsToScan.slice(i, i + chunkSize);
      const chunkResults = await Promise.allSettled(
        chunk.map((dep) => scanDependency(dep))
      );

      for (const result of chunkResults) {
        if (result.status === "fulfilled" && result.value !== null) {
          results.push(result.value);
        }
      }
    }

    // Sort by score ascending (worst first)
    results.sort((a, b) => a.score - b.score);

    const criticalCount = results.filter((r) => r.riskLevel === "critical").length;
    const highCount = results.filter((r) => r.riskLevel === "high").length;

    const response: ScanResponse = {
      results,
      totalPackages: results.length,
      criticalCount,
      highCount,
      scanId: crypto.randomUUID(),
      scannedAt: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Scan error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
