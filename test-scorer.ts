// Run with: npx tsx test-scorer.ts
// Reads GITHUB_TOKEN from .env.local when present.

import { config } from "dotenv";
import { fetchNpmMetrics } from "./lib/fetchers";
import { calculateScore } from "./lib/scorer";

config({ path: ".env.local" });

const packages = ["moment", "axios", "lodash", "express", "left-pad"];

async function main() {
  for (const name of packages) {
    try {
      const metrics = await fetchNpmMetrics(name, process.env.GITHUB_TOKEN);
      const result = calculateScore(metrics);
      const worstBreakdown = Object.entries(result.breakdown)
        .sort(([, a], [, b]) => a.score - b.score)
        .slice(0, 2)
        .map(([key, item]) => `${key}: ${item.score}/100 - ${item.label}`);

      console.log({
        name: result.name,
        score: result.score,
        riskLevel: result.riskLevel,
        worstBreakdown,
      });
    } catch (error) {
      console.error({
        name,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}

void main();
