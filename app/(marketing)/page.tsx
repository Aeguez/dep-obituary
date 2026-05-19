import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, FileJson, GitBranch, ShieldCheck } from "lucide-react";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const methodology = [
  {
    metric: "GitHub commits",
    weight: "30%",
    measured: "Commits in the last 90 days from the package repository.",
  },
  {
    metric: "Last release",
    weight: "25%",
    measured: "Days since the latest npm or PyPI release.",
  },
  {
    metric: "Maintainers",
    weight: "20%",
    measured: "Active maintainer and contributor count.",
  },
  {
    metric: "Issue health",
    weight: "15%",
    measured: "Open issues compared with closed issue volume.",
  },
  {
    metric: "Downloads",
    weight: "10%",
    measured: "Weekly downloads and recent download trend.",
  },
];

const testimonials = [
  {
    quote: "Dependency Obituary turned an invisible upgrade risk into a concrete migration list.",
    name: "Beta maintainer",
    role: "Open source project lead",
  },
  {
    quote: "The PR comment caught a deprecated package before it landed in production.",
    name: "Platform engineer",
    role: "SaaS team",
  },
  {
    quote: "The score breakdown made it easy to explain dependency risk to non-specialists.",
    name: "Security reviewer",
    role: "Internal tools",
  },
];

export default async function MarketingPage() {
  const { packagesAnalyzedToday, developerCount } = await getLandingMetrics();

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <section className="border-b border-zinc-900">
        <div className="mx-auto flex min-h-[88vh] w-full max-w-6xl flex-col justify-center px-4 py-16 sm:px-6 lg:px-8">
          <div className="max-w-4xl">
            <div className="text-7xl sm:text-8xl" aria-hidden="true">
              ⚰️
            </div>
            <p className="mt-8 text-sm font-semibold uppercase tracking-[0.22em] text-orange-400">
              Dependency Obituary
            </p>
            <h1 className="mt-4 max-w-4xl text-4xl font-semibold leading-tight text-white sm:text-6xl">
              Find out which dependencies are dying before they kill your project
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-400">
              Scan npm and pip dependency files, surface abandoned packages, and get a
              migration-ready health report before stale code becomes incident fuel.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href="/scan"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-orange-500 px-5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-orange-400"
              >
                Scan your package.json — free
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <p className="text-sm text-zinc-500">
                {packagesAnalyzedToday.toLocaleString()} packages analyzed today
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-zinc-900 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-2xl font-semibold text-white">How it works</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <Step
              icon={<FileJson className="h-5 w-5" aria-hidden="true" />}
              title="Upload your package.json"
              copy="Drop package.json or requirements.txt into the scanner."
            />
            <Step
              icon={<GitBranch className="h-5 w-5" aria-hidden="true" />}
              title="We check GitHub + npm"
              copy="Dependency Obituary reads releases, repository activity, issues, maintainers, and downloads."
            />
            <Step
              icon={<ShieldCheck className="h-5 w-5" aria-hidden="true" />}
              title="Get your health report"
              copy="Risky packages rise to the top with score breakdowns and migration signals."
            />
          </div>
        </div>
      </section>

      <section className="border-b border-zinc-900 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold text-white">Score methodology</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
                We score 0-100. Below 40 = plan migration.
              </p>
            </div>
          </div>

          <div className="mt-8 overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-zinc-900 text-zinc-300">
                <tr>
                  <th className="px-4 py-3 font-semibold">Metric</th>
                  <th className="px-4 py-3 font-semibold">Weight</th>
                  <th className="px-4 py-3 font-semibold">How it is measured</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 bg-zinc-950">
                {methodology.map((item) => (
                  <tr key={item.metric}>
                    <td className="px-4 py-4 font-medium text-zinc-100">{item.metric}</td>
                    <td className="px-4 py-4 text-orange-300">{item.weight}</td>
                    <td className="px-4 py-4 text-zinc-400">{item.measured}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-b border-zinc-900 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold text-white">Social proof</h2>
              <p className="mt-3 text-sm text-zinc-400">
                Used by {developerCount.toLocaleString()} developers
              </p>
            </div>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {testimonials.map((item) => (
              <figure key={item.name} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
                <blockquote className="text-sm leading-6 text-zinc-300">“{item.quote}”</blockquote>
                <figcaption className="mt-5">
                  <p className="text-sm font-semibold text-white">{item.name}</p>
                  <p className="mt-1 text-xs text-zinc-500">{item.role}</p>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <footer className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 text-sm text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>Built for Proof of Usefulness Hackathon</p>
          <div className="flex flex-wrap gap-4">
            <a
              href="https://github.com/Aeguez/dep-obituary"
              className="hover:text-orange-300"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            <a href="https://hackernoon.com/" className="hover:text-orange-300" target="_blank" rel="noreferrer">
              HackerNoon article
            </a>
            <Link href="/scan" className="hover:text-orange-300">
              Scan now
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Step({
  icon,
  title,
  copy,
}: {
  icon: ReactNode;
  title: string;
  copy: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-orange-500/15 text-orange-300">
        {icon}
      </div>
      <h3 className="mt-5 text-base font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{copy}</p>
    </div>
  );
}

async function getLandingMetrics() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return { packagesAnalyzedToday: 0, developerCount: 0 };
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const [scansResult, reposResult] = await Promise.all([
    supabase
      .from("scans")
      .select("total_packages")
      .gte("created_at", today.toISOString())
      .returns<Array<{ total_packages: number }>>(),
    supabase.from("monitored_repos").select("user_id").returns<Array<{ user_id: string }>>(),
  ]);

  const packagesAnalyzedToday =
    scansResult.data?.reduce((sum, row) => sum + (row.total_packages || 0), 0) || 0;
  const developerCount = new Set((reposResult.data || []).map((row) => row.user_id)).size;

  if (scansResult.error) {
    console.warn("Failed to load landing scan metrics:", scansResult.error.message);
  }
  if (reposResult.error) {
    console.warn("Failed to load landing developer metrics:", reposResult.error.message);
  }

  return { packagesAnalyzedToday, developerCount };
}
