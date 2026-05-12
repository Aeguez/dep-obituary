// lib/test-scorer.ts
// Run with: npx tsx lib/test-scorer.ts
// Make sure GITHUB_TOKEN is set in .env.local

import { config } from "dotenv";
config({ path: ".env.local" });

import { fetchNpmMetrics } from "./fetchers";
import { calculateScore } from "./scorer";

const TEST_PACKAGES = [
  "moment",      // Should be LOW/CRITICAL — deprecated
  "axios",       // Should be HEALTHY — actively maintained
  "lodash",      // Should be MEDIUM — slowing down
  "express",     // Should be LOW/MEDIUM — slow releases
  "react",       // Should be HEALTHY — very active
];

async function main() {
  console.log("\n⚰️  Dependency Obituary — Scorer Test\n");
  console.log("─".repeat(60));

  for (const pkg of TEST_PACKAGES) {
    try {
      process.stdout.write(`Scanning ${pkg}...`);
      const metrics = await fetchNpmMetrics(pkg, process.env.GITHUB_TOKEN);
      const result = calculateScore(metrics);

      const riskEmoji = {
        critical: "💀",
        high: "⚠️ ",
        medium: "🔶",
        low: "ℹ️ ",
        healthy: "✅",
      }[result.riskLevel];

      console.log(` ${riskEmoji} Score: ${result.score}/100 [${result.riskLevel.toUpperCase()}]`);
      console.log(`   └─ ${result.summary}`);

      // Show worst 2 breakdown items
      const sorted = Object.entries(result.breakdown).sort(
        ([, a], [, b]) => a.score - b.score
      );
      for (const [, item] of sorted.slice(0, 2)) {
        const bar = "█".repeat(Math.floor(item.score / 10)) + "░".repeat(10 - Math.floor(item.score / 10));
        console.log(`   └─ [${bar}] ${item.score}/100 — ${item.label}`);
      }

      if (result.alternativeSuggestion) {
        console.log(`   💡 Alternative: ${result.alternativeSuggestion}`);
      }

      console.log();
    } catch (err) {
      console.log(` ❌ Error: ${err instanceof Error ? err.message : "unknown"}\n`);
    }
  }

  console.log("─".repeat(60));
  console.log("Test complete. Check scores above for expected values.\n");
}

main();