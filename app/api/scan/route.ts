// app/api/scan/route.ts
// POST /api/scan — receives a package.json or requirements.txt and returns scores

import { NextRequest, NextResponse } from "next/server";
import {
  parsePackageJson,
  parseRequirementsTxt,
  fetchNpmMetrics,
  fetchPyPIMetrics,
  type ParsedDependency,
} from "@/lib/fetchers";
import { calculateScore, ScoreResult } from "@/lib/scorer";
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

async function scanDependency(dep: ParsedDependency, githubToken?: string): Promise<ScoreResult> {
  const cached = await getCachedPackageResult(dep);
  if (cached) return cached;

  const metrics =
    dep.type === "pypi"
      ? await fetchPyPIMetrics(dep.name, githubToken)
      : await fetchNpmMetrics(dep.name, githubToken);
  const result = calculateScore(metrics);

  await cachePackageResult(dep, result);
  return result;
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

    // Limit to 50 deps for MVP (avoid rate limits)
    const depsToScan = deps.slice(0, 50);
    const githubToken = process.env.GITHUB_TOKEN;

    // Fetch metrics in parallel with concurrency limit of 5
    const results: ScoreResult[] = [];
    const chunkSize = 5;

    for (let i = 0; i < depsToScan.length; i += chunkSize) {
      const chunk = depsToScan.slice(i, i + chunkSize);
      const chunkResults = await Promise.allSettled(
        chunk.map((dep) => scanDependency(dep, githubToken))
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
