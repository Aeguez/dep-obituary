import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { parsePackageJson } from "@/lib/fetchers";
import type { PackageMetrics, ScoreResult } from "@/lib/scorer";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const MAX_DEPENDENCIES = 50;

export const runtime = "nodejs";
export const maxDuration = 60;

interface PullRequestWebhookPayload {
  action: string;
  installation?: {
    id: number;
  };
  repository: {
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
  pull_request: {
    number: number;
    base: {
      sha: string;
    };
    head: {
      ref: string;
      sha: string;
      repo: {
        full_name: string;
      } | null;
    };
  };
}

interface GitHubAccessTokenResponse {
  token: string;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifyGitHubSignature(rawBody, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  if (event !== "pull_request") {
    return NextResponse.json({ ok: true, ignored: `Unsupported event: ${event || "unknown"}` });
  }

  let payload: PullRequestWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as PullRequestWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (payload.action !== "opened" && payload.action !== "synchronize") {
    return NextResponse.json({ ok: true, ignored: `Unsupported action: ${payload.action}` });
  }

  if (!payload.installation?.id) {
    return NextResponse.json({ error: "Missing GitHub App installation id" }, { status: 400 });
  }

  const installationId = payload.installation.id;

  try {
    const scanResult = await scanPullRequestAndComment(payload, installationId);
    return NextResponse.json({ ok: true, ...scanResult });
  } catch (error) {
    console.error("GitHub webhook scan failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Webhook scan failed" },
      { status: 500 }
    );
  }
}

async function scanPullRequestAndComment(payload: PullRequestWebhookPayload, installationId: number) {
  const installationToken = await createInstallationAccessToken(installationId);
  const packageJson = await fetchPackageJson(
    payload.pull_request.head.repo?.full_name || payload.repository.full_name,
    payload.pull_request.head.sha || payload.pull_request.head.ref,
    installationToken
  );

  if (!packageJson) {
    return { skipped: "No package.json found on PR branch" };
  }

  const basePackageJson = await fetchPackageJson(
    payload.repository.full_name,
    payload.pull_request.base.sha,
    installationToken
  );
  const packageNames = getChangedDependencyNames(packageJson, basePackageJson).slice(
    0,
    MAX_DEPENDENCIES
  );

  console.log("Dependency Obituary changed dependencies:", packageNames);

  if (packageNames.length === 0) {
    return { skipped: "No dependency changes found" };
  }

  const results = await scanDependencies(packageNames);
  const riskyPackages = results
    .filter((result) => result.riskLevel === "critical" || result.riskLevel === "high")
    .sort((a, b) => a.score - b.score);

  console.log(
    "Dependency Obituary risky packages:",
    riskyPackages.map((result) => `${result.name}:${result.riskLevel}:${result.score}`)
  );

  if (riskyPackages.length === 0) {
    return { skipped: "No high or critical packages found", scannedPackageCount: results.length };
  }

  await postPullRequestComment(payload, installationToken, buildRiskComment(riskyPackages));
  return {
    commented: true,
    scannedPackageCount: results.length,
    riskyPackageCount: riskyPackages.length,
  };
}

function verifyGitHubSignature(rawBody: string, signatureHeader: string | null) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const expectedSignature =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedSignature);
  const actual = Buffer.from(signatureHeader);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function createInstallationAccessToken(installationId: number) {
  const jwt = createGitHubAppJwt();
  const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(jwt),
  });

  if (!response.ok) {
    throw new Error(`Failed to create installation token (${response.status})`);
  }

  const data = (await response.json()) as GitHubAccessTokenResponse;
  return data.token;
}

function createGitHubAppJwt() {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = getGitHubPrivateKey();

  if (!appId || !privateKey) {
    throw new Error("Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    })
  );
  const unsignedToken = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsignedToken).sign(privateKey);

  return `${unsignedToken}.${base64Url(signature)}`;
}

function getGitHubPrivateKey() {
  return process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") || null;
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function githubHeaders(token: string, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "dependency-obituary",
  };
}

async function fetchPackageJson(repoFullName: string, ref: string, token: string) {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/contents/package.json?ref=${encodeURIComponent(ref)}`;

  const response = await fetch(url, {
    headers: githubHeaders(token, "application/vnd.github.raw+json"),
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch package.json (${response.status})`);
  }

  return response.text();
}

function getChangedDependencyNames(headPackageJson: string, basePackageJson: string | null) {
  const headDependencies = parsePackageJson(headPackageJson);
  if (!basePackageJson) return headDependencies.map((dep) => dep.name);

  const baseVersions = new Map(
    parsePackageJson(basePackageJson).map((dep) => [`${dep.type}:${dep.name}`, dep.version])
  );

  return headDependencies
    .filter((dep) => baseVersions.get(`${dep.type}:${dep.name}`) !== dep.version)
    .map((dep) => dep.name);
}

async function scanDependencies(packageNames: string[]) {
  const results: ScoreResult[] = [];

  for (const packageName of packageNames) {
    const result = await scanNpmPackageForPullRequest(packageName);
    if (result) results.push(result);
  }

  return results;
}

async function scanNpmPackageForPullRequest(packageName: string) {
  const registryResponse = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    }
  );

  if (!registryResponse.ok) return null;

  const registry = await registryResponse.json();
  const latestVersion = registry["dist-tags"]?.latest;
  const latestMeta = latestVersion ? registry.versions?.[latestVersion] || {} : {};
  const deprecatedMessage = latestMeta.deprecated;

  if (!deprecatedMessage) return null;

  const lastReleaseDate = latestVersion ? registry.time?.[latestVersion] || null : null;
  const daysSinceLastRelease = lastReleaseDate
    ? Math.floor((Date.now() - new Date(lastReleaseDate).getTime()) / 86400000)
    : 9999;

  const metrics: PackageMetrics = {
    name: packageName,
    repoOwner: null,
    repoName: null,
    commitsLast90Days: 0,
    daysSinceLastRelease,
    maintainersCount: registry.maintainers?.length || 1,
    openIssues: 0,
    closedIssues: 0,
    weeklyDownloads: 0,
    downloadTrend: 0,
    isArchived: false,
    isDeprecated: true,
    lastReleaseDate,
    alternativeSuggestion: null,
  };

  return {
    name: packageName,
    score: 0,
    riskLevel: "critical",
    breakdown: {
      commits: { score: 0, weight: 0.3, label: "Package is deprecated" },
      lastRelease: {
        score: 0,
        weight: 0.25,
        label: formatLastReleaseIssue(daysSinceLastRelease),
      },
      maintainers: { score: 0, weight: 0.2, label: "No active maintenance expected" },
      issueRatio: { score: 0, weight: 0.15, label: "Deprecated package" },
      downloads: { score: 0, weight: 0.1, label: "Migration recommended" },
    },
    metrics,
    summary: `This package is deprecated: ${deprecatedMessage}`,
    alternativeSuggestion: null,
  } satisfies ScoreResult;
}

function formatLastReleaseIssue(days: number) {
  if (days >= 9999) return "Last release unknown";
  if (days < 365) return `Last release ${days} days ago`;
  return `Last release ${(days / 365).toFixed(1)} years ago`;
}

async function postPullRequestComment(
  payload: PullRequestWebhookPayload,
  token: string,
  body: string
) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issueNumber = payload.pull_request.number;
  const response = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to post PR comment (${response.status})`);
  }
}

function buildRiskComment(results: ScoreResult[]) {
  const rows = results.map((result) => {
    const issue = getWorstIssue(result);
    return `| ${escapeMarkdownTable(result.name)} | ${result.score} | ${getRiskLabel(
      result.riskLevel
    )} | ${escapeMarkdownTable(issue)} |`;
  });

  return [
    "## 🪦 Dependency Obituary Report",
    "",
    "| Package | Score | Risk | Issue |",
    "| --- | ---: | --- | --- |",
    ...rows,
  ].join("\n");
}

function getRiskLabel(riskLevel: ScoreResult["riskLevel"]) {
  if (riskLevel === "critical") return "💀 Critical";
  if (riskLevel === "high") return "⚠️ High";
  return riskLevel;
}

function getWorstIssue(result: ScoreResult) {
  return Object.values(result.breakdown).sort((a, b) => a.score - b.score)[0]?.label || result.summary;
}

function escapeMarkdownTable(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
