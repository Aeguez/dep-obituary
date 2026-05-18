export interface ParsedRepoUrl {
  repoUrl: string;
  repoOwner: string;
  repoName: string;
}

export function parseGitHubRepoUrl(input: string): ParsedRepoUrl | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  const match = trimmed.match(/github\.com[/:]([^/\s]+)\/([^/#?\s]+)/i);
  if (!match) return null;

  const repoOwner = match[1];
  const repoName = match[2];

  return {
    repoUrl: `https://github.com/${repoOwner}/${repoName}`,
    repoOwner,
    repoName,
  };
}

export function formatRelativeDate(value: string | null) {
  if (!value) return "Never";

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "Unknown";

  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
