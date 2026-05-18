import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import AddRepoForm from "@/components/AddRepoForm";
import RepoCard from "@/components/RepoCard";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

interface MonitoredRepoRow {
  id: string;
  repo_url: string;
  repo_owner: string | null;
  repo_name: string | null;
  last_scan_at: string | null;
  last_score_snapshot: {
    totalPackages?: number;
    criticalCount?: number;
    highCount?: number;
    overallHealth?: number;
  } | null;
}

export default async function DashboardPage() {
  const { userId } = await auth();
  const repos = userId ? await getRepos(userId) : [];

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-5xl">
        <header className="mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-orange-400">Dependency Obituary</p>
            <h1 className="mt-2 text-3xl font-semibold text-white">Saved repositories</h1>
            <p className="mt-2 text-sm text-zinc-400">
              Save repos you want to monitor and run dependency health scans on demand.
            </p>
          </div>
          <UserButton />
        </header>

        <AddRepoForm />

        <div className="mt-6 grid gap-4">
          {repos.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-400">
              No saved repositories yet.
            </div>
          ) : (
            repos.map((repo) => (
              <RepoCard
                key={repo.id}
                id={repo.id}
                repoOwner={repo.repo_owner}
                repoName={repo.repo_name}
                repoUrl={repo.repo_url}
                lastScanAt={repo.last_scan_at}
                snapshot={repo.last_score_snapshot}
              />
            ))
          )}
        </div>
      </section>
    </main>
  );
}

async function getRepos(userId: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("monitored_repos")
    .select("id,repo_url,repo_owner,repo_name,last_scan_at,last_score_snapshot")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .returns<MonitoredRepoRow[]>();

  if (error) {
    console.warn("Failed to load monitored repos:", error.message);
    return [];
  }

  return data || [];
}
