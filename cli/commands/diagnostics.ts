import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../core/graph/index.js";
import { resolveProviderForProject } from "../../core/llm/index.js";
import { getEventsLogPath, isLinkedWorktree, readLastExtractionLog, resolveStorageRoot } from "../../core/local-data.js";
import { collectStats } from "../../core/telemetry/index.js";
import { generateStaticReport } from "../../core/view/index.js";
import { buildResolverSource } from "../hook-resolver.js";
import { findStaleHooks } from "./install.js";

export function runStatus(cwd: string): string {
  let output = "";
  try {
    const store = new GraphStore({ projectRoot: cwd });
    output += "Nodes:\n";
    let totalNodes = 0;
    const lifecycleCounts: Record<string, number> = {};
    const types = ["Decision", "FailedApproach", "Constraint", "Discovery", "Convention", "OpenIssue"];
    for (const type of types) {
      const nodes = store.queryByType(type as any);
      totalNodes += nodes.length;
      if (nodes.length > 0) {
        output += `- ${type}: ${nodes.length}\n`;
      }
      for (const n of nodes) {
        lifecycleCounts[n.lifecycle_state] = (lifecycleCounts[n.lifecycle_state] || 0) + 1;
      }
    }
    output += `\nTotal Nodes: ${totalNodes}\n`;
    output += "\nLifecycle States:\n";
    for (const [state, count] of Object.entries(lifecycleCounts)) {
      output += `- ${state}: ${count}\n`;
    }
    store.close();
  } catch (e: any) {
    output += `GraphStore Error: ${e.message}\n`;
  }

  const logPath = getEventsLogPath(cwd);
  if (existsSync(logPath)) {
    const stat = statSync(logPath);
    output += `\nLast capture: ${stat.mtime.toISOString()}\n`;
  } else {
    output += "\nLast capture: None\n";
  }

  const lastExt = readLastExtractionLog(cwd);
  if (lastExt) {
    output += lastExt.success
      ? `Last extraction: ${lastExt.timestamp} — ok (${lastExt.nodes_created} nodes via ${lastExt.provider})\n`
      : `Last extraction: ${lastExt.timestamp} — FAILED (${lastExt.error || "unknown error"})\n`;
  } else {
    output += "Last extraction: None\n";
  }

  if (isLinkedWorktree(cwd)) {
    output += `Worktree storage: ${resolveStorageRoot(cwd)} (shared with main worktree)\n`;
  }

  const stale = findStaleHooks(cwd);
  if (stale.length > 0) {
    output +=
      `\n⚠ ${stale.length} Dev-Mem hook file(s) use the old format (machine-specific paths):\n` +
      stale.map((s) => `  - ${s}`).join("\n") +
      "\nRun `dev-memo install` to upgrade them.\n";
  }

  return output;
}

export async function runDoctor(cwd: string, opts: { live?: boolean } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const fail = (m: string) => {
    ok = false;
    lines.push(`✗ ${m}`);
  };

  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "ignore" });
    lines.push("✓ Git repository");
  } catch {
    fail("Not a git repository");
  }

  const agents = [
    ["claude-code", ".claude/hooks"],
    ["codex", ".codex/hooks"],
    ["cursor", ".cursor/hooks"],
    ["opencode", ".opencode/plugins"],
  ]
    .filter(([, rel]) => {
      try {
        return existsSync(join(cwd, rel)) && readdirSync(join(cwd, rel)).some((f) => f.startsWith("dev-mem"));
      } catch {
        return false;
      }
    })
    .map(([a]) => a);
  lines.push(agents.length ? `✓ Hooks: ${agents.join(", ")}` : "! No agent hooks installed — run dev-memo install");

  const stale = findStaleHooks(cwd);
  lines.push(stale.length ? `! ${stale.length} stale hook file(s) — run dev-memo install` : "✓ Hooks up to date");

  const probeDir = mkdtempSync(join(tmpdir(), "dm-doctor-"));
  let found = "";
  try {
    const probe = join(probeDir, "probe.mjs");
    writeFileSync(probe, `${buildResolverSource()}\nprocess.stdout.write(distDir);\n`);
    const res = spawnSync(process.execPath, [probe], { cwd, encoding: "utf8", timeout: 5000 });
    found = (res.stdout || "").trim();
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  if (found) lines.push(`✓ dev-memo found at ${found}`);
  else fail("Hooks cannot locate dev-memo");

  const provider = resolveProviderForProject(cwd);
  if (!provider) {
    fail("No LLM provider configured");
  } else {
    lines.push(`✓ LLM provider: ${provider.name}`);
    if (opts.live) {
      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error("timeout after 15s")), 15000);
        timer.unref?.();
      });
      try {
        await Promise.race([provider.complete("Reply with OK.", "OK", 5), timeoutPromise]);
        lines.push("✓ LLM reachable");
      } catch (e) {
        fail(`LLM call failed: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer!);
      }
    }
  }

  const lastExt = readLastExtractionLog(cwd);
  if (lastExt && !lastExt.success) {
    lines.push(`! Last extraction failed (${lastExt.timestamp}): ${lastExt.error || "unknown error"}`);
  }

  return { ok, lines };
}

export function runStats(cwd: string, args: string[] = []): { exitCode: number; stdout: string; stderr: string } {
  const stats = collectStats(cwd);
  if (args.includes("--json")) {
    return { exitCode: 0, stdout: JSON.stringify(stats, null, 2) + "\n", stderr: "" };
  }

  const verifiedPct =
    stats.totalNodes > 0
      ? Math.round(((stats.verifiedNodes + stats.activeNodes) / stats.totalNodes) * 100)
      : 0;

  const lines = [
    "Dev-Mem Knowledge & ROI Stats",
    "─────────────────────────────",
    `Nodes:                 ${stats.totalNodes} (verified: ${stats.verifiedNodes}, active: ${stats.activeNodes}, observed: ${stats.observedNodes}, stale: ${stats.staleNodes}, superseded: ${stats.supersededNodes})`,
    `Curated ratio:         ${verifiedPct}% verified/active | Grounded evidence: ${stats.groundedNodes}/${stats.totalNodes}`,
    `Edges:                 ${stats.edgeCount}`,
    `Sessions assisted:     ${stats.sessionsAssisted}`,
    `Memories injected:     ${stats.totalInjections}`,
    `Regression warnings:   ${stats.preventedRegressions}`,
    `Extractions run:       ${stats.extractions.total} (${stats.extractions.succeeded} ok, ${stats.extractions.failed} failed)`,
  ];

  if (isLinkedWorktree(cwd)) {
    lines.push(`Worktree storage:      ${resolveStorageRoot(cwd)} (shared)`);
  }

  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

export function runView(cwd: string, args: string[] = []): { exitCode: number; stdout: string; stderr: string } {
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : undefined;
  const res = generateStaticReport(cwd, { outPath });

  if (args.includes("--open")) {
    try {
      const child =
        process.platform === "win32"
          ? spawn("cmd", ["/c", "start", "", res.path], { detached: true, stdio: "ignore" })
          : spawn(process.platform === "darwin" ? "open" : "xdg-open", [res.path], {
              detached: true,
              stdio: "ignore",
            });
      child.unref();
    } catch {
      // ignore if headless / no browser available
    }
  }

  return {
    exitCode: 0,
    stdout: `Generated static explorer at ${res.path} (${res.nodeCount} node(s), ${res.edgeCount} edge(s)). Open in any browser.\n`,
    stderr: "",
  };
}
