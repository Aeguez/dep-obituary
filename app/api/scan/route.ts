// app/api/scan/route.ts
// POST /api/scan — receives a package.json or requirements.txt and returns scores

import { NextRequest, NextResponse } from "next/server";
import {
  parsePackageJson,
  parseRequirementsTxt,
  type ParsedDependency,
} from "@/lib/fetchers";
import { calculateScore, ScoreResult } from "@/lib/scorer";
import type { PackageMetrics } from "@/lib/scorer";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60; // Vercel: allow up to 60s for large dependency lists

export interface ScanResponse {
  results: ScoreResult[];
  totalPackages: number;
  criticalCount: number;
  highCount: number;
  scanId: string;
  scannedAt: string;
}

interface PackageCacheRow {
  score: number;
  risk_level: ScoreResult["riskLevel"];
  metrics: ScoreResult["metrics"];
  breakdown: ScoreResult["breakdown"];
  summary: string | null;
  alternative_suggestion: string | null;
}

const MAX_PACKAGES_PER_SCAN = 10;
const FAST_FETCH_TIMEOUT_MS = 4_000;

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FAST_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function scoreResultFromCache(packageName: string, row: PackageCacheRow): ScoreResult {
  return {
    name: packageName,
    score: row.score,
    riskLevel: row.risk_level,
    breakdown: row.breakdown,
    metrics: row.metrics,
    summary: row.summary || "",
    alternativeSuggestion: row.alternative_suggestion,
  };
}

async function getCachedPackageResult(dep: ParsedDependency): Promise<ScoreResult | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("package_cache")
      .select("score,risk_level,metrics,breakdown,summary,alternative_suggestion")
      .eq("package_name", dep.name)
      .eq("ecosystem", dep.type)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle<PackageCacheRow>();

    if (error) {
      console.warn(`Package cache lookup failed for ${dep.type}:${dep.name}:`, error.message);
      return null;
    }

    return data ? scoreResultFromCache(dep.name, data) : null;
  } catch (error) {
    console.warn(`Package cache lookup failed for ${dep.type}:${dep.name}:`, error);
    return null;
  }
}

async function cachePackageResult(dep: ParsedDependency, result: ScoreResult): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  try {
    const { error } = await supabase.from("package_cache").upsert(
      {
        package_name: dep.name,
        ecosystem: dep.type,
        score: result.score,
        risk_level: result.riskLevel,
        metrics: result.metrics,
        breakdown: result.breakdown,
        summary: result.summary,
        alternative_suggestion: result.alternativeSuggestion,
        cached_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      { onConflict: "package_name,ecosystem" }
    );

    if (error) {
      console.warn(`Package cache write failed for ${dep.type}:${dep.name}:`, error.message);
    }
  } catch (error) {
    console.warn(`Package cache write failed for ${dep.type}:${dep.name}:`, error);
  }
}

async function scanDependency(dep: ParsedDependency): Promise<ScoreResult> {
  const cached = await getCachedPackageResult(dep);
  if (cached) return cached;

  // Public upload scans must return quickly on Vercel. Use registry data here and
  // reserve full GitHub-heavy scans for the GitHub App and repo monitor flows.
  const metrics = await fetchQuickMetrics(dep);
  const result = calculateScore(metrics);

  await cachePackageResult(dep, result);
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

  let weeklyDownloads = 0;
  try {
    const downloadsRes = await fetchWithTimeout(
      `https://api.npmjs.org/downloads/point/last-week/${encoded}`,
      undefined,
      2_500
    );
    if (downloadsRes.ok) {
      const downloads = await downloadsRes.json();
      weeklyDownloads = downloads.downloads || 0;
    }
  } catch {
    weeklyDownloads = 0;
  }

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
    weeklyDownloads,
    downloadTrend: 0,
    isArchived: false,
    isDeprecated: !!latestMeta.deprecated,
    lastReleaseDate,
    alternativeSuggestion: null,
  };
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

async function saveScanSession(response: ScanResponse, fileName: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  try {
    const { error } = await supabase.from("scans").insert({
      scan_id: response.scanId,
      user_id: null,
      file_name: fileName,
      total_packages: response.totalPackages,
      critical_count: response.criticalCount,
      high_count: response.highCount,
      results: response.results,
      created_at: response.scannedAt,
    });

    if (error) {
      console.warn(`Scan session save failed for ${response.scanId}:`, error.message);
    }
  } catch (error) {
    console.warn(`Scan session save failed for ${response.scanId}:`, error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const textContent = formData.get("content") as string | null;

    let content: string;
    let filename: string;

    if (file) {
      content = await file.text();
      filename = file.name;
    } else if (textContent) {
      content = textContent;
      filename = (formData.get("filename") as string) || "package.json";
    } else {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Parse dependencies based on file type
    let deps;
    if (filename.endsWith("requirements.txt") || filename.endsWith(".txt")) {
      deps = parseRequirementsTxt(content);
    } else {
      deps = parsePackageJson(content);
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

    await saveScanSession(response, filename);

    return NextResponse.json(response);
  } catch (error) {
    console.error("Scan error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
