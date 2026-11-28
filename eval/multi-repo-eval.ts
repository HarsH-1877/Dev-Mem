import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapProject } from "../core/bootstrap/index.js";
import { GraphStore, type CreateNodeInput } from "../core/graph/index.js";
import { checkRegressionRisk } from "../core/regression/index.js";
import {
  calculateRelevance,
  filterUnseenWarnings,
  retrieveContext,
} from "../core/retrieval/index.js";

export interface EvalQueryCase {
  name: string;
  currentTask: string;
  currentFiles?: string[];
  expectedTitleMatch?: string; // undefined => negative query (expect 0 hits under minRelevance)
  regressionHubTest?: {
    file: string;
    unrelatedTask: string;
    relatedTask: string;
    noisyPartialTitle: string;
  };
}

export interface RepoEvalSummary {
  repoName: string;
  nodeCount: number;
  positiveQueries: number;
  negativeQueries: number;
  hybridHitAt1: number;
  baselineHitAt1: number;
  hybridRecallAt3: number;
  hybridMrr: number;
  baselineMrr: number;
  negativeLeakage: number;
  regressionNoiseSuppressed: number;
  regressionNoiseTotal: number;
  warningDedupVerified: number;
}

export interface MultiRepoBenchmarkReport {
  repos: RepoEvalSummary[];
  totals: {
    sessionsEvaluated: number;
    hybridHitAt1Rate: number;
    baselineHitAt1Rate: number;
    hybridRecallAt3Rate: number;
    hybridMrr: number;
    baselineMrr: number;
    negativeLeakageRate: number;
    regressionNoiseSuppressionRate: number;
  };
}

const EV = {
  commit: "1111111111111111111111111111111111111111",
  session_id: "eval-seed",
  agent: "claude-code",
  timestamp: new Date().toISOString(),
  confidence: 0.9,
};

function makeDevMemCorpus(): { nodes: CreateNodeInput[]; queries: EvalQueryCase[]; bootstrapFile?: string } {
  const nodes: CreateNodeInput[] = [
    {
      type: "Constraint",
      title: "Provider-neutral core forbids importing adapters or external LLM SDKs",
      content: "Keep core/ free of openai or anthropic SDKs and run ci-check before merge.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["scripts/ci-check.mjs", "core/llm/index.ts"], symbols: ["resolveProvider"] },
    },
    {
      type: "Decision",
      title: "Enable SQLite WAL mode with busy_timeout 5000ms for concurrent hooks",
      content: "Multiple hook child processes open graph.sqlite simultaneously without BUSY errors.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["core/graph/index.ts"], symbols: ["GraphStore"] },
    },
    {
      type: "FailedApproach",
      title: "Using Cursor SessionEnd hook alone dropped short-session knowledge",
      content: "Cursor CLI exits unpredictably without SessionEnd; N-event stop checkpoints and wrap compensate.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["adapters/cursor/hook.ts", "core/checkpoint.ts"], symbols: ["triggerExtractionIfThresholdMet"] },
    },
    {
      type: "Decision",
      title: "Sync team tombstones and edits using updated_at last-writer-wins",
      content: "shared.jsonl exports active, verified, superseded, and stale nodes deterministically.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["core/sync/index.ts"], symbols: ["importSharedGraph", "exportSharedGraph"] },
    },
    {
      type: "Constraint",
      title: "Prevent infinite recursion inside host CLI LLM extraction spawns",
      content: "Pass DEV_MEM_DISABLE_HOOKS=1 in env and set cwd to os.tmpdir() on spawn.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["core/llm/cli-agent.ts"], symbols: ["createCliAgentProvider"] },
    },
    {
      type: "Convention",
      title: "Scrub secrets and private blocks synchronously before writing events or nodes",
      content: "Redact API keys, Bearer tokens, and <private>...</private> tags in memory first.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["core/capture/sanitize.ts"], symbols: ["sanitizeText"] },
    },
    {
      type: "Discovery",
      title: "Composite prompt score leaked zero-relevance notes when currentFiles was omitted",
      content: "Always enforce raw minRelevance threshold before budget packing on UserPromptSubmit.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["core/retrieval/index.ts", "adapters/claude-code/hook.ts"], symbols: ["retrieveContext"] },
    },
    {
      type: "OpenIssue",
      title: "MCP initialize version was hardcoded instead of reading package.json",
      content: "Read live version dynamically via readMcpServerVersion helper.",
      lifecycle_state: "superseded",
      evidence: { ...EV, files: ["core/mcp/server.ts"], symbols: ["readMcpServerVersion"] },
    },
  ];

  const queries: EvalQueryCase[] = [
    { name: "s1-sqlite-wal", currentTask: "fix GraphStore SQLITE_BUSY lock under concurrent hooks", expectedTitleMatch: "WAL mode" },
    { name: "s2-cli-recursion", currentTask: "prevent infinite spawn loops in createCliAgentProvider", expectedTitleMatch: "infinite recursion" },
    { name: "s3-sync-tombstones", currentTask: "propagate superseded node deletions with importSharedGraph", expectedTitleMatch: "last-writer-wins" },
    { name: "s4-cursor-checkpoint", currentTask: "triggerExtractionIfThresholdMet fails when cursor exits early", currentFiles: ["adapters/cursor/hook.ts"], expectedTitleMatch: "Cursor SessionEnd" },
    { name: "s5-sanitize-tokens", currentTask: "mask leaked bearer credentials using sanitizeText", expectedTitleMatch: "Scrub secrets" },
    { name: "s6-prompt-relevance", currentTask: "stop unrelated memory leaks during UserPromptSubmit retrieval", expectedTitleMatch: "Composite prompt score" },
    {
      name: "s7-regression-hub",
      currentTask: "audit ci-check architectural policy boundaries",
      expectedTitleMatch: "Provider-neutral core",
      regressionHubTest: {
        file: "adapters/cursor/hook.ts",
        unrelatedTask: "Add TypeScript return type annotation",
        relatedTask: "Debug Cursor SessionEnd missing extraction flush",
        noisyPartialTitle: "Using Cursor SessionEnd hook alone",
      },
    },
    { name: "s8-negative-k8s", currentTask: "configure Kubernetes ingress TLS certificates", expectedTitleMatch: undefined },
  ];

  return { nodes, queries };
}

function makeSaasApiCorpus(): { nodes: CreateNodeInput[]; queries: EvalQueryCase[] } {
  const nodes: CreateNodeInput[] = [
    {
      type: "Constraint",
      title: "Revoke the entire refresh token family upon replay detection",
      content: "Invalidate token rotation chain immediately when duplicate jti arrives.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["src/auth/tokens.ts"], symbols: ["revokeTokenFamily", "rotateRefreshToken"] },
    },
    {
      type: "FailedApproach",
      title: "Storing Stripe idempotency keys in local RAM caused double charges across pods",
      content: "Always back payment retries with PostgreSQL idempotency ledger rows.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["src/billing/checkout.ts", "src/index.ts"], symbols: ["createPaymentIntent"] },
    },
    {
      type: "Decision",
      title: "Validate webhook signatures using raw unparsed Buffer body",
      content: "Express JSON parser mutates whitespace; keep rawBody on webhook route.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["src/billing/webhooks.ts"], symbols: ["verifyStripeSignature"] },
    },
    {
      type: "Convention",
      title: "All database schema changes must include reversible down migrations",
      content: "Never run hand-edited ALTER TABLE queries directly against staging.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["db/migrations/index.ts"], symbols: ["runMigration"] },
    },
    {
      type: "Discovery",
      title: "Redis pipelining reduces rate limiter p99 latency from 14ms to 2ms",
      content: "Batch INCR and EXPIRE into single MULTI pipeline command.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["src/middleware/ratelimit.ts"], symbols: ["checkRateLimit"] },
    },
    {
      type: "FailedApproach",
      title: "Unbounded Prisma include queries exhausted connection pool on org exports",
      content: "Use cursor pagination and explicit column select on bulk organization exports.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["src/exports/orgs.ts", "src/db/client.ts"], symbols: ["exportOrgCsv"] },
    },
    ...Array.from({ length: 8 }, (_, idx) => ({
      type: "Discovery" as const,
      title: `Background email digest worker note ${idx + 1}`,
      content: `SMTP batch retry jitter scheduling metric ${idx + 1}`,
      lifecycle_state: "active" as const,
      evidence: { ...EV, files: [`src/jobs/digest-${idx + 1}.ts`] },
    })),
  ];

  const queries: EvalQueryCase[] = [
    { name: "api1-token-replay", currentTask: "investigate revokeTokenFamily security incident", expectedTitleMatch: "refresh token family" },
    { name: "api2-stripe-sig", currentTask: "fix verifyStripeSignature mismatch after Express middleware", currentFiles: ["src/billing/checkout.ts"], expectedTitleMatch: "raw unparsed Buffer" },
    { name: "api3-double-charge", currentTask: "prevent duplicate Stripe charges across multiple pods", expectedTitleMatch: "idempotency keys" },
    { name: "api4-ratelimit", currentTask: "optimize checkRateLimit latency with pipelining", expectedTitleMatch: "Redis pipelining" },
    { name: "api5-migration", currentTask: "review database schema migration policy before release", expectedTitleMatch: "reversible down migrations" },
    { name: "api6-pool-oom", currentTask: "debug exportOrgCsv connection pool exhaustion", expectedTitleMatch: "Prisma include queries" },
    {
      name: "api7-regression-hub",
      currentTask: "refactor startup exports in src/index.ts",
      expectedTitleMatch: "idempotency keys",
      regressionHubTest: {
        file: "src/index.ts",
        unrelatedTask: "Sort barrel re-export alphabetical order",
        relatedTask: "Debug double charge Stripe idempotency pods",
        noisyPartialTitle: "Stripe idempotency keys",
      },
    },
    { name: "api8-negative-webgl", currentTask: "render WebGL shader canvas mesh pipeline", expectedTitleMatch: undefined },
  ];

  return { nodes, queries };
}

function makeMonorepoCorpus(): { nodes: CreateNodeInput[]; queries: EvalQueryCase[] } {
  const nodes: CreateNodeInput[] = [
    {
      type: "Constraint",
      title: "Alpine Docker images require python3 and make for native better-sqlite3 rebuilds",
      content: "Prefer node:22-bookworm-slim or install build toolchain before npm ci.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["infra/docker/Dockerfile"], symbols: ["buildImage"] },
    },
    {
      type: "FailedApproach",
      title: "Formatting localized timestamps during SSR caused React hydration mismatch #418",
      content: "Defer locale formatting inside client useEffect or pass deterministic ISO strings.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["apps/web/components/DateBadge.tsx", "apps/web/app/layout.tsx"], symbols: ["DateBadge"] },
    },
    {
      type: "Decision",
      title: "BullMQ worker jobs must remain idempotent with deterministic jobId keys",
      content: "At-least-once Redis delivery replays stalled jobs after worker restarts.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["packages/queue/src/worker.ts"], symbols: ["enqueueSyncJob"] },
    },
    {
      type: "FailedApproach",
      title: "Sorting batch row locks inconsistently triggered Postgres 40P01 deadlocks",
      content: "Always sort account IDs ascending prior to SELECT FOR UPDATE.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["packages/db/src/ledger.ts"], symbols: ["transferBalances"] },
    },
    {
      type: "Convention",
      title: "Workspace packages export ESM .js extensions cleanly under NodeNext",
      content: "Configure exports map in package.json and verify with typecheck.",
      lifecycle_state: "verified",
      evidence: { ...EV, files: ["packages/shared/package.json"], symbols: [] },
    },
    {
      type: "Discovery",
      title: "Turborepo remote cache hash missed NEXT_PUBLIC_* build-time env vars",
      content: "Declare all NEXT_PUBLIC variables inside turbo.json globalEnv.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["turbo.json", "apps/web/next.config.mjs"] },
    },
    ...Array.from({ length: 8 }, (_, idx) => ({
      type: "Discovery" as const,
      title: `Marketing landing telemetry experiment ${idx + 1}`,
      content: `Hero CTA button A/B impression event ${idx + 1}`,
      lifecycle_state: "active" as const,
      evidence: { ...EV, files: [`apps/marketing/exp-${idx + 1}.tsx`] },
    })),
  ];

  const queries: EvalQueryCase[] = [
    { name: "mono1-ssr-hydration", currentTask: "fix DateBadge React hydration mismatch errors", expectedTitleMatch: "hydration mismatch" },
    { name: "mono2-deadlock", currentTask: "investigate transferBalances PostgreSQL 40P01 lock contention", expectedTitleMatch: "deadlocks" },
    { name: "mono3-bullmq", currentTask: "make enqueueSyncJob safe under Redis restarts", expectedTitleMatch: "BullMQ worker" },
    { name: "mono4-docker-sqlite", currentTask: "fix native SQLite compile errors on Alpine Dockerfile", expectedTitleMatch: "Alpine Docker" },
    { name: "mono5-turbo-env", currentTask: "NEXT_PUBLIC environment variables missing in web build cache", expectedTitleMatch: "Turborepo remote cache" },
    { name: "mono6-esm-exports", currentTask: "resolve NodeNext workspace ESM import extensions", expectedTitleMatch: "NodeNext" },
    {
      name: "mono7-regression-hub",
      currentTask: "update global providers in apps/web/app/layout.tsx",
      expectedTitleMatch: "hydration mismatch",
      regressionHubTest: {
        file: "apps/web/app/layout.tsx",
        unrelatedTask: "Add analytics script tag to root HTML body",
        relatedTask: "Format SSR date timestamp inside layout",
        noisyPartialTitle: "React hydration mismatch",
      },
    },
    { name: "mono8-negative-ios", currentTask: "configure SwiftUI CoreData migrations for iOS", expectedTitleMatch: undefined },
  ];

  return { nodes, queries };
}

function evaluateCorpus(
  repoName: string,
  corpus: { nodes: CreateNodeInput[]; queries: EvalQueryCase[] },
): RepoEvalSummary {
  const dir = mkdtempSync(join(tmpdir(), `dm-eval-${repoName}-`));
  try {
    const store = new GraphStore({ projectRoot: dir });
    if (repoName === "dev-mem-cli") {
      // Also dogfood deterministic rule ingestion into same store
      const ruleFile = join(dir, "RULES.md");
      writeFileSync(ruleFile, "- Never emit unredacted credentials to disk.\n", "utf8");
      bootstrapProject({ projectRoot: dir, fromFiles: [ruleFile] });
    }
    for (const input of corpus.nodes) {
      store.createNode(input);
    }
    const allNodes = store.queryAllNodes().filter((n) => n.lifecycle_state !== "superseded");
    store.close();

    let positiveQueries = 0;
    let negativeQueries = 0;
    let hybridHitAt1 = 0;
    let baselineHitAt1 = 0;
    let hybridRecallAt3 = 0;
    let hybridMrrSum = 0;
    let baselineMrrSum = 0;
    let negativeLeakage = 0;
    let regressionNoiseSuppressed = 0;
    let regressionNoiseTotal = 0;
    let warningDedupVerified = 0;

    for (const q of corpus.queries) {
      const hybridHits = retrieveContext({
        projectRoot: dir,
        currentTask: q.currentTask,
        currentFiles: q.currentFiles,
        minRelevance: 0.08,
        budgetTokens: 2000,
      });

      // Pure Jaccard baseline ranking (no FTS5/BM25 signal, keeping identical minRelevance=0.08)
      const baselineRanked = [...allNodes]
        .map((node) => ({
          node,
          rel: calculateRelevance(node, q.currentTask, q.currentFiles),
        }))
        .filter((item) => item.rel >= 0.08)
        .sort((a, b) => b.rel - a.rel)
        .map((item) => item.node);

      if (q.expectedTitleMatch) {
        positiveQueries++;
        const matchNeedle = q.expectedTitleMatch.toLowerCase();
        const hybridRank = hybridHits.findIndex((n) => n.title.toLowerCase().includes(matchNeedle));
        if (hybridRank === 0) hybridHitAt1++;
        if (hybridRank >= 0 && hybridRank < 3) hybridRecallAt3++;
        if (hybridRank >= 0) hybridMrrSum += 1 / (hybridRank + 1);

        const baseRank = baselineRanked.findIndex((n) => n.title.toLowerCase().includes(matchNeedle));
        if (baseRank === 0) baselineHitAt1++;
        if (baseRank >= 0) baselineMrrSum += 1 / (baseRank + 1);
      } else {
        negativeQueries++;
        if (hybridHits.length > 0) negativeLeakage++;
      }

      if (q.regressionHubTest) {
        regressionNoiseTotal++;
        const unrelatedWarnings = checkRegressionRisk({
          projectRoot: dir,
          currentFiles: [q.regressionHubTest.file],
          currentTask: q.regressionHubTest.unrelatedTask,
        });
        const stillNoisy = unrelatedWarnings.some((m) =>
          m.node.title.includes(q.regressionHubTest!.noisyPartialTitle),
        );
        if (!stillNoisy) regressionNoiseSuppressed++;

        const relatedWarnings = checkRegressionRisk({
          projectRoot: dir,
          currentFiles: [q.regressionHubTest.file],
          currentTask: q.regressionHubTest.relatedTask,
        });
        const firstPass = filterUnseenWarnings(dir, `sess-${q.name}`, relatedWarnings);
        const secondPass = filterUnseenWarnings(dir, `sess-${q.name}`, relatedWarnings);
        if (firstPass.length > 0 && secondPass.length === 0) {
          warningDedupVerified++;
        }
      }
    }

    return {
      repoName,
      nodeCount: allNodes.length,
      positiveQueries,
      negativeQueries,
      hybridHitAt1,
      baselineHitAt1,
      hybridRecallAt3,
      hybridMrr: positiveQueries > 0 ? hybridMrrSum / positiveQueries : 0,
      baselineMrr: positiveQueries > 0 ? baselineMrrSum / positiveQueries : 0,
      negativeLeakage,
      regressionNoiseSuppressed,
      regressionNoiseTotal,
      warningDedupVerified,
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // ignore transient Windows SQLite lock
    }
  }
}

export function runMultiRepoBenchmark(): MultiRepoBenchmarkReport {
  const repos = [
    evaluateCorpus("dev-mem-cli", makeDevMemCorpus()),
    evaluateCorpus("ts-saas-api", makeSaasApiCorpus()),
    evaluateCorpus("fullstack-monorepo", makeMonorepoCorpus()),
  ];

  const totalPos = repos.reduce((s, r) => s + r.positiveQueries, 0);
  const totalNeg = repos.reduce((s, r) => s + r.negativeQueries, 0);
  const totalNoise = repos.reduce((s, r) => s + r.regressionNoiseTotal, 0);

  return {
    repos,
    totals: {
      sessionsEvaluated: totalPos + totalNeg,
      hybridHitAt1Rate: repos.reduce((s, r) => s + r.hybridHitAt1, 0) / totalPos,
      baselineHitAt1Rate: repos.reduce((s, r) => s + r.baselineHitAt1, 0) / totalPos,
      hybridRecallAt3Rate: repos.reduce((s, r) => s + r.hybridRecallAt3, 0) / totalPos,
      hybridMrr: repos.reduce((s, r) => s + r.hybridMrr * r.positiveQueries, 0) / totalPos,
      baselineMrr: repos.reduce((s, r) => s + r.baselineMrr * r.positiveQueries, 0) / totalPos,
      negativeLeakageRate: totalNeg > 0 ? repos.reduce((s, r) => s + r.negativeLeakage, 0) / totalNeg : 0,
      regressionNoiseSuppressionRate:
        totalNoise > 0 ? repos.reduce((s, r) => s + r.regressionNoiseSuppressed, 0) / totalNoise : 1,
    },
  };
}

export function formatBenchmarkMarkdown(report: MultiRepoBenchmarkReport): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines = [
    "# Multi-Repo FTS5/BM25 & Regression Guard Benchmark (v0.8.0)",
    "",
    `Evaluated **${report.totals.sessionsEvaluated} task/regression sessions** across **${report.repos.length} codebases** (zero LLM mocks; real SQLite + FTS5 + BM25 + ` + "`retrieveContext`" + ` + ` + "`checkRegressionRisk`" + `).`,
    "",
    "| Repository | Nodes | Pos/Neg Sessions | Baseline Hit@1 | Hybrid Hit@1 | Recall@3 | Baseline MRR | Hybrid MRR | Noise Leakage | Hub Warning Suppressed |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.repos.map(
      (r) =>
        `| \`${r.repoName}\` | ${r.nodeCount} | ${r.positiveQueries}/${r.negativeQueries} | ${pct(r.baselineHitAt1 / r.positiveQueries)} | ${pct(r.hybridHitAt1 / r.positiveQueries)} | ${pct(r.hybridRecallAt3 / r.positiveQueries)} | ${r.baselineMrr.toFixed(3)} | ${r.hybridMrr.toFixed(3)} | ${r.negativeLeakage}/${r.negativeQueries} | ${r.regressionNoiseSuppressed}/${r.regressionNoiseTotal} |`,
    ),
    "",
    "## Aggregate Results",
    `- **Hybrid Hit@1:** ${pct(report.totals.hybridHitAt1Rate)} (Jaccard baseline: ${pct(report.totals.baselineHitAt1Rate)})`,
    `- **Hybrid Recall@3:** ${pct(report.totals.hybridRecallAt3Rate)}`,
    `- **Mean Reciprocal Rank (MRR):** ${report.totals.hybridMrr.toFixed(3)} (Jaccard baseline: ${report.totals.baselineMrr.toFixed(3)})`,
    `- **Negative Query Leakage:** ${pct(report.totals.negativeLeakageRate)}`,
    `- **Hub-File False-Positive Regression Suppression:** ${pct(report.totals.regressionNoiseSuppressionRate)}`,
    "",
  ];
  return lines.join("\n");
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("multi-repo-eval.js") ||
    process.argv[1].endsWith("multi-repo-eval.ts"));

if (isDirectRun) {
  const report = runMultiRepoBenchmark();
  const md = formatBenchmarkMarkdown(report);
  console.log(md);
  if (process.argv.includes("--write")) {
    const out = resolve("eval/results/eval-v0.8-bm25-multi-repo.md");
    writeFileSync(out, md, "utf8");
    console.log(`Wrote report to ${out}`);
  }
}
