import crypto from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { fetchNpmMetrics, parsePackageJson } from "@/lib/fetchers";
import { calculateScore, type ScoreResult } from "@/lib/scorer";

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

  after(async () => {
    try {
      await scanPullRequestAndComment(payload, installationId);
    } catch (error) {
      console.error("GitHub webhook scan failed:", error);
    }
  });

  return NextResponse.json({ ok: true, queued: true });
}

async function scanPullRequestAndComment(payload: PullRequestWebhookPayload, installationId: number) {
  try {
    const installationToken = await createInstallationAccessToken(installationId);
    const packageJson = await fetchPackageJson(
      payload.pull_request.head.repo?.full_name || payload.repository.full_name,
      payload.pull_request.head.sha || payload.pull_request.head.ref,
      installationToken
    );

    if (!packageJson) {
      return;
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

    if (packageNames.length === 0) {
      return;
    }

    const results = await scanDependencies(packageNames, installationToken);
    const riskyPackages = results
      .filter((result) => result.riskLevel === "critical" || result.riskLevel === "high")
      .sort((a, b) => a.score - b.score);

    if (riskyPackages.length === 0) {
      return;
    }

    await postPullRequestComment(payload, installationToken, buildRiskComment(riskyPackages));
  } catch (error) {
    console.error("GitHub PR scan failed:", error);
  }
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

async function scanDependencies(packageNames: string[], githubToken: string) {
  const results: ScoreResult[] = [];
  const chunkSize = 5;

  for (let i = 0; i < packageNames.length; i += chunkSize) {
    const chunk = packageNames.slice(i, i + chunkSize);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (packageName) => calculateScore(await fetchNpmMetrics(packageName, githubToken)))
    );

    for (const result of chunkResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      }
    }
  }

  return results;
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
