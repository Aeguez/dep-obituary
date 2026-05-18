import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { fetchNpmMetrics, parsePackageJson } from "@/lib/fetchers";
import { calculateScore, type ScoreResult } from "@/lib/scorer";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

interface RepoRow {
  id: string;
  user_id: string;
  repo_url: string;
  repo_owner: string | null;
  repo_name: string | null;
}

export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const { repoId } = await params;
  const { data: repo, error: repoError } = await supabase
    .from("monitored_repos")
    .select("id,user_id,repo_url,repo_owner,repo_name")
    .eq("id", repoId)
    .eq("user_id", userId)
    .maybeSingle<RepoRow>();

  if (repoError) {
    console.warn("Failed to load monitored repo:", repoError.message);
    return NextResponse.json({ error: "Could not load repository." }, { status: 500 });
  }

  if (!repo || !repo.repo_owner || !repo.repo_name) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }

  const packageJson = await fetchRepoPackageJson(repo.repo_owner, repo.repo_name);
  if (!packageJson) {
    return NextResponse.json({ error: "No package.json found in repository root." }, { status: 404 });
  }

  const deps = parsePackageJson(packageJson).slice(0, 50);
  const results: ScoreResult[] = [];

  for (let i = 0; i < deps.length; i += 5) {
    const chunk = deps.slice(i, i + 5);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (dep) => calculateScore(await fetchNpmMetrics(dep.name, process.env.GITHUB_TOKEN)))
    );

    for (const result of chunkResults) {
      if (result.status === "fulfilled") results.push(result.value);
    }
  }

  results.sort((a, b) => a.score - b.score);

  const criticalCount = results.filter((result) => result.riskLevel === "critical").length;
  const highCount = results.filter((result) => result.riskLevel === "high").length;
  const overallHealth =
    results.length > 0
      ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length)
      : 0;
  const scannedAt = new Date().toISOString();

  const snapshot = {
    totalPackages: results.length,
    criticalCount,
    highCount,
    overallHealth,
    scannedAt,
  };

  const { error: updateError } = await supabase
    .from("monitored_repos")
    .update({
      last_scan_at: scannedAt,
      last_score_snapshot: snapshot,
    })
    .eq("id", repo.id)
    .eq("user_id", userId);

  if (updateError) {
    console.warn("Failed to update monitored repo scan snapshot:", updateError.message);
  }

  if (results.length > 0) {
    const { error: historyError } = await supabase.from("score_history").insert(
      results.map((result) => ({
        user_id: userId,
        repo_id: repo.id,
        package_name: result.name,
        score: result.score,
        risk_level: result.riskLevel,
        recorded_at: scannedAt,
      }))
    );

    if (historyError) {
      console.warn("Failed to save score history:", historyError.message);
    }
  }

  return NextResponse.json({ ok: true, results, ...snapshot });
}

async function fetchRepoPackageJson(owner: string, repo: string) {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/contents/package.json`,
    {
      headers: {
        Accept: "application/vnd.github.raw+json",
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    }
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch repository package.json (${response.status})`);
  }

  return response.text();
}
