// app/api/scan/route.ts
// POST /api/scan — receives a package.json or requirements.txt and returns scores

import { NextRequest, NextResponse } from "next/server";
import {
  parsePackageJson,
  parseRequirementsTxt,
  fetchNpmMetrics,
  fetchPyPIMetrics,
} from "@/lib/fetchers";
import { calculateScore, ScoreResult } from "@/lib/scorer";

export const maxDuration = 60; // Vercel: allow up to 60s for large dependency lists

export interface ScanResponse {
  results: ScoreResult[];
  totalPackages: number;
  criticalCount: number;
  highCount: number;
  scanId: string;
  scannedAt: string;
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
        chunk.map(async (dep) => {
          const metrics =
            dep.type === "pypi"
              ? await fetchPyPIMetrics(dep.name, githubToken)
              : await fetchNpmMetrics(dep.name, githubToken);
          return calculateScore(metrics);
        })
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
