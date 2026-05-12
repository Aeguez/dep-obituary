// lib/fetchers.ts
// Fetches real data from GitHub API and npm Registry

import type { PackageMetrics } from "./scorer";

const GITHUB_API = "https://api.github.com";
const NPM_API = "https://registry.npmjs.org";
const NPM_DOWNLOADS_API = "https://api.npmjs.org/downloads";
const PYPI_API = "https://pypi.org/pypi";
const GITHUB_CONCURRENCY = 5;
const GITHUB_LOW_REMAINING_THRESHOLD = 100;
const githubMetricsCache = new Map<string, ReturnType<typeof fetchGitHubMetricsUncached>>();

let activeGithubRequests = 0;
const githubQueue: Array<() => void> = [];

function enqueueGithubRequest<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeGithubRequests += 1;
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      } finally {
        activeGithubRequests -= 1;
        githubQueue.shift()?.();
      }
    };

    if (activeGithubRequests < GITHUB_CONCURRENCY) {
      void run();
    } else {
      githubQueue.push(run);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGithubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubFetch(url: string, headers: Record<string, string>): Promise<Response> {
  return enqueueGithubRequest(async () => {
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await fetch(url, { headers });
      lastResponse = res;

      const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "9999");
      const resetSeconds = Number(res.headers.get("x-ratelimit-reset") ?? "0");

      if (remaining < GITHUB_LOW_REMAINING_THRESHOLD) {
        const resetDelay = resetSeconds > 0 ? resetSeconds * 1000 - Date.now() : 0;
        await sleep(Math.max(resetDelay, 5_000));
      }

      if (res.status !== 429 && res.status !== 403) {
        return res;
      }

      if (attempt < 2) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "0") * 1000;
        const backoff = retryAfter > 0 ? retryAfter : 2 ** attempt * 1_000;
        await sleep(backoff);
      }
    }

    return lastResponse as Response;
  });
}

// --- npm fetcher ---

export async function fetchNpmMetrics(
  packageName: string,
  githubToken?: string
): Promise<PackageMetrics> {
  const encoded = encodeURIComponent(packageName);

  // Fetch npm registry data (package info + repository link)
  const registryRes = await fetch(`${NPM_API}/${encoded}`, {
    headers: { Accept: "application/json" },
  });

  if (!registryRes.ok) {
    throw new Error(`Package "${packageName}" not found on npm`);
  }

  const registry = await registryRes.json();
  const latestVersion = registry["dist-tags"]?.latest;
  const latestMeta = registry.versions?.[latestVersion] || {};
  const isDeprecated = !!latestMeta.deprecated;

  // Extract GitHub repo from package.json repository field
  let repoOwner: string | null = null;
  let repoName: string | null = null;
  const repoUrl: string =
    registry.repository?.url ||
    latestMeta.repository?.url ||
    "";
  const ghMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (ghMatch) {
    repoOwner = ghMatch[1];
    repoName = ghMatch[2].replace(/\.git$/, "");
  }

  // Fetch weekly downloads
  const downloadsNow = await fetchNpmDownloads(encoded, "last-week");

  // Downloads trend: compare last 4 weeks vs 4 weeks before that
  const [recentWeeks, olderWeeks] = await Promise.all([
    fetchNpmDownloadsRange(encoded, 28, 0),
    fetchNpmDownloadsRange(encoded, 56, 28),
  ]);
  const downloadTrend =
    olderWeeks > 0 ? ((recentWeeks - olderWeeks) / olderWeeks) * 100 : 0;

  // Parse last release date
  const timeMap = registry.time || {};
  const lastReleaseDate = timeMap[latestVersion] || null;
  const daysSinceLastRelease = lastReleaseDate
    ? Math.floor(
        (Date.now() - new Date(lastReleaseDate).getTime()) / (1000 * 60 * 60 * 24)
      )
    : 9999;

  // Fetch GitHub data if we have a repo
  let commitsLast90Days = 0;
  let maintainersCount = registry.maintainers?.length || 1;
  let openIssues = 0;
  let closedIssues = 0;
  let isArchived = false;

  if (repoOwner && repoName) {
    const ghData = await fetchGitHubMetrics(repoOwner, repoName, githubToken);
    commitsLast90Days = ghData.commitsLast90Days;
    openIssues = ghData.openIssues;
    closedIssues = ghData.closedIssues;
    isArchived = ghData.isArchived;
    if (ghData.maintainersCount > 0) {
      maintainersCount = ghData.maintainersCount;
    }
  }

  return {
    name: packageName,
    repoOwner,
    repoName,
    commitsLast90Days,
    daysSinceLastRelease,
    maintainersCount,
    openIssues,
    closedIssues,
    weeklyDownloads: downloadsNow,
    downloadTrend: Math.round(downloadTrend),
    isArchived,
    isDeprecated,
    lastReleaseDate,
    alternativeSuggestion: null,
  };
}

// --- PyPI fetcher ---

export async function fetchPyPIMetrics(
  packageName: string,
  githubToken?: string
): Promise<PackageMetrics> {
  const encoded = encodeURIComponent(packageName);
  const res = await fetch(`${PYPI_API}/${encoded}/json`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Package "${packageName}" not found on PyPI`);
  }

  const data = await res.json();
  const info = data.info || {};
  const latestVersion = info.version;
  const releaseFiles = latestVersion ? data.releases?.[latestVersion] || [] : [];
  const latestUpload = releaseFiles
    .map((file: { upload_time_iso_8601?: string; upload_time?: string }) => file.upload_time_iso_8601 || file.upload_time)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const lastReleaseDate = latestUpload || null;
  const daysSinceLastRelease = lastReleaseDate
    ? Math.floor((Date.now() - new Date(lastReleaseDate).getTime()) / 86400000)
    : 9999;

  const maintainerNames = [info.maintainer, info.author]
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const maintainersCount = Math.max(1, new Set(maintainerNames).size);

  const githubUrl = findGithubUrl(info);
  const { repoOwner, repoName } = parseGithubRepo(githubUrl);

  let commitsLast90Days = 0;
  let openIssues = 0;
  let closedIssues = 0;
  let isArchived = false;
  let githubMaintainersCount = 0;

  if (repoOwner && repoName) {
    const ghData = await fetchGitHubMetrics(repoOwner, repoName, githubToken);
    commitsLast90Days = ghData.commitsLast90Days;
    openIssues = ghData.openIssues;
    closedIssues = ghData.closedIssues;
    isArchived = ghData.isArchived;
    githubMaintainersCount = ghData.maintainersCount;
  }

  return {
    name: packageName,
    repoOwner,
    repoName,
    commitsLast90Days,
    daysSinceLastRelease,
    maintainersCount: githubMaintainersCount || maintainersCount,
    openIssues,
    closedIssues,
    weeklyDownloads: 0,
    downloadTrend: 0,
    isArchived,
    isDeprecated: false,
    lastReleaseDate,
    alternativeSuggestion: null,
  };
}

async function fetchNpmDownloads(packageName: string, period: string): Promise<number> {
  try {
    const res = await fetch(`${NPM_DOWNLOADS_API}/point/${period}/${packageName}`);
    if (!res.ok) return 0;
    const data = await res.json();
    return data.downloads || 0;
  } catch {
    return 0;
  }
}

async function fetchNpmDownloadsRange(
  packageName: string,
  daysBack: number,
  daysEnd: number
): Promise<number> {
  try {
    const end = new Date(Date.now() - daysEnd * 86400000);
    const start = new Date(Date.now() - daysBack * 86400000);
    const fmt = (d: Date) => d.toISOString().split("T")[0];
    const res = await fetch(
      `${NPM_DOWNLOADS_API}/point/${fmt(start)}:${fmt(end)}/${packageName}`
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return data.downloads || 0;
  } catch {
    return 0;
  }
}

// --- GitHub fetcher ---

export async function fetchGitHubMetrics(
  owner: string,
  repo: string,
  token?: string
): Promise<{
  commitsLast90Days: number;
  openIssues: number;
  closedIssues: number;
  maintainersCount: number;
  isArchived: boolean;
}> {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = githubMetricsCache.get(key);
  if (cached) return cached;

  const request = fetchGitHubMetricsUncached(owner, repo, token);
  githubMetricsCache.set(key, request);

  try {
    return await request;
  } catch (error) {
    githubMetricsCache.delete(key);
    throw error;
  }
}

async function fetchGitHubMetricsUncached(
  owner: string,
  repo: string,
  token?: string
): Promise<{
  commitsLast90Days: number;
  openIssues: number;
  closedIssues: number;
  maintainersCount: number;
  isArchived: boolean;
}> {
  const headers = getGithubHeaders(token);

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const [repoRes, commitsRes, contributorsRes] = await Promise.allSettled([
    githubFetch(`${GITHUB_API}/repos/${owner}/${repo}`, headers),
    githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/commits?since=${since}&per_page=100`, headers),
    githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/contributors?per_page=30&anon=false`, headers),
  ]);

  let isArchived = false;
  let openIssues = 0;
  let closedIssues = 0;

  if (repoRes.status === "fulfilled" && repoRes.value.ok) {
    const repoData = await repoRes.value.json();
    isArchived = repoData.archived || false;
    openIssues = repoData.open_issues_count || 0;
    // Estimate closed issues (GitHub API doesn't give this directly without search)
    // Use a rough heuristic: fetch search count
    closedIssues = await fetchClosedIssuesCount(owner, repo, headers);
  }

  let commitsLast90Days = 0;
  if (commitsRes.status === "fulfilled" && commitsRes.value.ok) {
    const commits = await commitsRes.value.json();
    commitsLast90Days = Array.isArray(commits) ? commits.length : 0;
  }

  let maintainersCount = 1;
  if (contributorsRes.status === "fulfilled" && contributorsRes.value.ok) {
    const contributors = await contributorsRes.value.json();
    if (Array.isArray(contributors)) {
      // Count contributors with significant commits (top contributors)
      const significant = contributors.filter((c: { contributions: number }) => c.contributions >= 5);
      maintainersCount = Math.max(1, significant.length);
    }
  }

  return { commitsLast90Days, openIssues, closedIssues, maintainersCount, isArchived };
}

async function fetchClosedIssuesCount(
  owner: string,
  repo: string,
  headers: Record<string, string>
): Promise<number> {
  try {
    const res = await githubFetch(
      `${GITHUB_API}/search/issues?q=repo:${owner}/${repo}+type:issue+state:closed&per_page=1`,
      headers
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return data.total_count || 0;
  } catch {
    return 0;
  }
}

// --- File parser ---

export interface ParsedDependency {
  name: string;
  version: string;
  type: "npm" | "pypi";
  isDev: boolean;
}

export function parsePackageJson(content: string): ParsedDependency[] {
  try {
    const pkg = JSON.parse(content);
    const deps: ParsedDependency[] = [];

    const add = (obj: Record<string, string> | undefined, isDev: boolean) => {
      if (!obj) return;
      for (const [name, version] of Object.entries(obj)) {
        if (name.startsWith("@types/")) continue; // Skip type-only packages
        deps.push({ name, version: version.replace(/[\^~>=<]/g, ""), type: "npm", isDev });
      }
    };

    add(pkg.dependencies, false);
    add(pkg.devDependencies, true);
    return deps;
  } catch {
    throw new Error("Invalid package.json format");
  }
}

export function parseRequirementsTxt(content: string): ParsedDependency[] {
  const deps: ParsedDependency[] = [];
  const lines = content.split("\n");

  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    if (line.startsWith("git+") || line.includes("://")) continue;

    // Handle: package==1.0.0, package>=1.0, package~=1.0, Django>=3.2,<4.0
    const match = line.match(/^([a-zA-Z0-9_.-]+)\s*([>=<!~].+)?$/);
    if (match) {
      const name = match[1].trim();
      const version = match[2]?.replace(/[>=<!~]/g, "").split(",")[0].trim() || "latest";
      deps.push({ name, version, type: "pypi", isDev: false });
    }
  }

  return deps;
}

function findGithubUrl(info: {
  project_urls?: Record<string, string>;
  home_page?: string;
  package_url?: string;
  bugtrack_url?: string;
}): string {
  const candidates = [
    ...Object.values(info.project_urls || {}),
    info.home_page,
    info.package_url,
    info.bugtrack_url,
  ].filter(Boolean) as string[];

  return candidates.find((url) => /github\.com/i.test(url)) || "";
}

function parseGithubRepo(url: string): { repoOwner: string | null; repoName: string | null } {
  const match = url.match(/github\.com[/:]([^/\s]+)\/([^/#?\s.]+)(?:\.git)?/i);
  return {
    repoOwner: match?.[1] || null,
    repoName: match?.[2]?.replace(/\.git$/, "") || null,
  };
}
