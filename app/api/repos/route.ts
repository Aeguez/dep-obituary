import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { parseGitHubRepoUrl } from "@/lib/repo-utils";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  const parsedRepo = parseGitHubRepoUrl(String(body?.repoUrl || ""));

  if (!parsedRepo) {
    return NextResponse.json({ error: "Enter a valid GitHub repository URL." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("monitored_repos")
    .upsert(
      {
        user_id: userId,
        repo_url: parsedRepo.repoUrl,
        repo_owner: parsedRepo.repoOwner,
        repo_name: parsedRepo.repoName,
      },
      { onConflict: "user_id,repo_url" }
    )
    .select("id")
    .single();

  if (error) {
    console.warn("Failed to save monitored repo:", error.message);
    return NextResponse.json({ error: "Could not save repository." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, repoId: data.id });
}
