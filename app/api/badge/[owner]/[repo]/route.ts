import { NextRequest } from "next/server";
import { fetchNpmMetrics, parsePackageJson, type ParsedDependency } from "@/lib/fetchers";
import { calculateScore, type ScoreResult } from "@/lib/scorer";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const GITHUB_API = "https://api.github.com";
const MAX_BADGE_DEPENDENCIES = 20;
const BADGE_CACHE_SECONDS = 3600;

interface PackageCacheRow {
  score: number;
  risk_level: ScoreResult["riskLevel"];
  metrics: ScoreResult["metrics"];
  breakdown: ScoreResult["breakdown"];
  summary: string | null;
  alternative_suggestion: string | null;
}

export const maxDuration = 60;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  const { owner, repo } = await params;

  try {
    const packageJson = await fetchRepoPackageJson(owner, repo);
    if (!packageJson) {
      return svgResponse(renderBadge("dep health", "no package.json", "#9ca3af"), 404);
    }

    const dependencies = parsePackageJson(packageJson)
      .filter((dep) => dep.type === "npm")
      .slice(0, MAX_BADGE_DEPENDENCIES);

    if (dependencies.length === 0) {
      return svgResponse(renderBadge("dep health", "no deps", "#9ca3af"));
    }

    const results = await scanDependencies(dependencies);
    if (results.length === 0) {
      return svgResponse(renderBadge("dep health", "scan failed", "#e05d44"), 502);
    }

    const score = Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length);
    const health = getHealthLabel(score);
    const color = getScoreColor(score);

    return svgResponse(renderBadge("dep health", `${score} · ${health}`, color));
  } catch (error) {
    console.error("Badge generation failed:", error);
    return svgResponse(renderBadge("dep health", "error", "#e05d44"), 500);
  }
}

async function fetchRepoPackageJson(owner: string, repo: string) {
  const response = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/package.json`,
    {
      headers: {
        Accept: "application/vnd.github.raw+json",
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      next: { revalidate: BADGE_CACHE_SECONDS },
    }
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch package.json (${response.status})`);
  }

  return response.text();
}

async function scanDependencies(dependencies: ParsedDependency[]) {
  const results: ScoreResult[] = [];

  for (let i = 0; i < dependencies.length; i += 5) {
    const chunk = dependencies.slice(i, i + 5);
    const chunkResults = await Promise.allSettled(chunk.map((dep) => scanDependency(dep)));

    for (const result of chunkResults) {
      if (result.status === "fulfilled") results.push(result.value);
    }
  }

  return results;
}

async function scanDependency(dep: ParsedDependency) {
  const cached = await getCachedPackageResult(dep);
  if (cached) return cached;

  const metrics = await fetchNpmMetrics(dep.name, process.env.GITHUB_TOKEN);
  const result = calculateScore(metrics);
  await cachePackageResult(dep, result);
  return result;
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

    if (error || !data) return null;

    return {
      name: dep.name,
      score: data.score,
      riskLevel: data.risk_level,
      breakdown: data.breakdown,
      metrics: data.metrics,
      summary: data.summary || "",
      alternativeSuggestion: data.alternative_suggestion,
    };
  } catch {
    return null;
  }
}

async function cachePackageResult(dep: ParsedDependency, result: ScoreResult) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  try {
    await supabase.from("package_cache").upsert(
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
        expires_at: new Date(Date.now() + BADGE_CACHE_SECONDS * 1000).toISOString(),
      },
      { onConflict: "package_name,ecosystem" }
    );
  } catch {
    // Badge generation should not fail if the optional cache is unavailable.
  }
}

function svgResponse(svg: string, status = 200) {
  return new Response(svg, {
    status,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": `public, max-age=${BADGE_CACHE_SECONDS}`,
    },
  });
}

function renderBadge(label: string, value: string, valueColor: string) {
  const labelWidth = textWidth(label);
  const valueWidth = textWidth(value);
  const width = labelWidth + valueWidth;
  const labelTextX = labelWidth / 2;
  const valueTextX = labelWidth + valueWidth / 2;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escapeXml(
    `${label}: ${value}`
  )}">
  <title>${escapeXml(`${label}: ${value}`)}</title>
  <clipPath id="r">
    <rect width="${width}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${valueColor}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelTextX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelTextX}" y="14">${escapeXml(label)}</text>
    <text x="${valueTextX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${valueTextX}" y="14">${escapeXml(value)}</text>
  </g>
</svg>`;
}

function textWidth(value: string) {
  return Math.max(40, value.length * 7 + 10);
}

function getScoreColor(score: number) {
  if (score < 40) return "#e05d44";
  if (score < 70) return "#dfb317";
  return "#4c1";
}

function getHealthLabel(score: number) {
  if (score < 40) return "risky";
  if (score < 70) return "watch";
  return "healthy";
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
