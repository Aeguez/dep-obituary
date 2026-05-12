// lib/scorer.ts
// Core scoring engine for Dependency Obituary
// Scores each dependency 0-100 (higher = healthier)
 
export interface PackageMetrics {
  name: string;
  repoOwner: string | null;
  repoName: string | null;
  commitsLast90Days: number;
  daysSinceLastRelease: number;
  maintainersCount: number;
  openIssues: number;
  closedIssues: number;
  weeklyDownloads: number;
  downloadTrend: number; // % change last 4 weeks vs previous 4 weeks
  isArchived: boolean;
  isDeprecated: boolean;
  lastReleaseDate: string | null;
  alternativeSuggestion: string | null;
}
 
export interface ScoreResult {
  name: string;
  score: number; // 0-100
  riskLevel: "critical" | "high" | "medium" | "low" | "healthy";
  breakdown: ScoreBreakdown;
  metrics: PackageMetrics;
  summary: string;
  alternativeSuggestion: string | null;
}
 
export interface ScoreBreakdown {
  commits: { score: number; weight: number; label: string };
  lastRelease: { score: number; weight: number; label: string };
  maintainers: { score: number; weight: number; label: string };
  issueRatio: { score: number; weight: number; label: string };
  downloads: { score: number; weight: number; label: string };
}
 
// Known deprecated packages and their alternatives
const KNOWN_ALTERNATIVES: Record<string, string> = {
  moment: "dayjs or date-fns",
  request: "axios or node-fetch",
  "node-fetch": "native fetch (Node 18+)",
  lodash: "lodash-es or native JS methods",
  underscore: "lodash or native JS methods",
  grunt: "vite or esbuild",
  gulp: "vite or esbuild",
  bower: "npm or yarn",
  "coffee-script": "TypeScript",
  jade: "pug",
  "babel-polyfill": "@babel/preset-env with useBuiltIns",
  unirest: "axios or got",
  superagent: "axios or got",
  "node-uuid": "uuid",
  crypto: "node:crypto (built-in)",
  mkdirp: "fs.mkdirSync with recursive option",
  rimraf: "fs.rmSync with recursive option",
  "cross-env": "native cross-platform env in Node 20+",
};
 
export function calculateScore(metrics: PackageMetrics): ScoreResult {
  // Instant critical for archived or deprecated
  if (metrics.isArchived || metrics.isDeprecated) {
    return buildCriticalResult(metrics);
  }
 
  const breakdown: ScoreBreakdown = {
    commits: scoreCommits(metrics.commitsLast90Days),
    lastRelease: scoreLastRelease(metrics.daysSinceLastRelease),
    maintainers: scoreMaintainers(metrics.maintainersCount),
    issueRatio: scoreIssueRatio(metrics.openIssues, metrics.closedIssues),
    downloads: scoreDownloads(metrics.weeklyDownloads, metrics.downloadTrend),
  };
 
  const totalScore = Object.values(breakdown).reduce((sum, item) => {
    return sum + item.score * item.weight;
  }, 0);
 
  const finalScore = Math.round(totalScore);
  const riskLevel = getRiskLevel(finalScore);
  const alternative =
    metrics.alternativeSuggestion ||
    KNOWN_ALTERNATIVES[metrics.name.toLowerCase()] ||
    null;
 
  return {
    name: metrics.name,
    score: finalScore,
    riskLevel,
    breakdown,
    metrics,
    summary: buildSummary(metrics, riskLevel),
    alternativeSuggestion: alternative,
  };
}
 
// --- Sub-scorers (each returns 0-100) ---
 
function scoreCommits(commits: number): { score: number; weight: number; label: string } {
  let score: number;
  if (commits >= 30) score = 100;
  else if (commits >= 15) score = 80;
  else if (commits >= 5) score = 55;
  else if (commits >= 1) score = 30;
  else score = 0;
 
  return {
    score,
    weight: 0.3,
    label:
      commits === 0
        ? "No commits in 90 days"
        : `${commits} commits in last 90 days`,
  };
}
 
function scoreLastRelease(days: number): { score: number; weight: number; label: string } {
  let score: number;
  if (days <= 90) score = 100;
  else if (days <= 180) score = 80;
  else if (days <= 365) score = 60;
  else if (days <= 730) score = 30;
  else score = 5;
 
  const years = (days / 365).toFixed(1);
  return {
    score,
    weight: 0.25,
    label:
      days <= 90
        ? `Released ${days} days ago`
        : days <= 365
        ? `Last release ${Math.round(days / 30)} months ago`
        : `Last release ${years} years ago`,
  };
}
 
function scoreMaintainers(count: number): { score: number; weight: number; label: string } {
  let score: number;
  if (count >= 5) score = 100;
  else if (count >= 3) score = 85;
  else if (count === 2) score = 65;
  else if (count === 1) score = 40; // Bus factor risk
  else score = 0;
 
  return {
    score,
    weight: 0.2,
    label:
      count === 1
        ? "1 maintainer (bus factor risk)"
        : `${count} maintainers`,
  };
}
 
function scoreIssueRatio(open: number, closed: number): { score: number; weight: number; label: string } {
  if (open === 0 && closed === 0) {
    return { score: 70, weight: 0.15, label: "No issue data available" };
  }
  const total = open + closed;
  const closeRate = total > 0 ? closed / total : 0;
  let score: number;
  if (closeRate >= 0.8) score = 100;
  else if (closeRate >= 0.6) score = 75;
  else if (closeRate >= 0.4) score = 50;
  else if (closeRate >= 0.2) score = 25;
  else score = 10;
 
  return {
    score,
    weight: 0.15,
    label: `${Math.round(closeRate * 100)}% issues closed (${open} open)`,
  };
}
 
function scoreDownloads(weekly: number, trend: number): { score: number; weight: number; label: string } {
  let baseScore: number;
  if (weekly >= 1_000_000) baseScore = 100;
  else if (weekly >= 100_000) baseScore = 85;
  else if (weekly >= 10_000) baseScore = 65;
  else if (weekly >= 1_000) baseScore = 45;
  else baseScore = 20;
 
  // Adjust for trend
  const trendAdjustment = trend > 20 ? 10 : trend > 0 ? 5 : trend < -30 ? -15 : trend < -10 ? -8 : 0;
  const score = Math.max(0, Math.min(100, baseScore + trendAdjustment));
 
  const trendLabel =
    trend > 10
      ? `↑ growing ${Math.round(trend)}%`
      : trend < -10
      ? `↓ declining ${Math.round(Math.abs(trend))}%`
      : "→ stable";
 
  return {
    score,
    weight: 0.1,
    label: `${formatNumber(weekly)}/week ${trendLabel}`,
  };
}
 
// --- Helpers ---
 
function getRiskLevel(score: number): ScoreResult["riskLevel"] {
  if (score >= 80) return "healthy";
  if (score >= 60) return "low";
  if (score >= 40) return "medium";
  if (score >= 20) return "high";
  return "critical";
}
 
function buildSummary(
  metrics: PackageMetrics,
  risk: ScoreResult["riskLevel"]
): string {
  if (metrics.isArchived) return "This repository is archived. No further development expected.";
  if (metrics.isDeprecated) return "This package is officially deprecated by its author.";
  if (risk === "healthy") return "Actively maintained with strong community engagement.";
  if (risk === "low") return "Reasonably maintained, but monitor for slowdowns.";
  if (risk === "medium") return "Signs of reduced activity. Consider evaluating alternatives.";
  if (risk === "high") return "Low maintenance activity. High risk of abandonment.";
  return "Effectively abandoned. Plan migration as soon as possible.";
}
 
function buildCriticalResult(metrics: PackageMetrics): ScoreResult {
  const alternative =
    metrics.alternativeSuggestion ||
    KNOWN_ALTERNATIVES[metrics.name.toLowerCase()] ||
    null;
  return {
    name: metrics.name,
    score: 0,
    riskLevel: "critical",
    breakdown: {
      commits: { score: 0, weight: 0.3, label: "Repository archived/deprecated" },
      lastRelease: { score: 0, weight: 0.25, label: "No future releases expected" },
      maintainers: { score: 0, weight: 0.2, label: "No active maintainers" },
      issueRatio: { score: 0, weight: 0.15, label: "Issues not being addressed" },
      downloads: { score: 0, weight: 0.1, label: "Downloads declining" },
    },
    metrics,
    summary: metrics.isArchived
      ? "This repository is archived. No further development expected."
      : "This package is officially deprecated by its author.",
    alternativeSuggestion: alternative,
  };
}
 
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}
