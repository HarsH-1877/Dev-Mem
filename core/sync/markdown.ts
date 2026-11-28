import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sanitizeText } from "../capture/sanitize.js";
import { GraphStore } from "../graph/index.js";
import type { KnowledgeNode, NodeType } from "../graph/types.js";
import { ensureLocalDataDir, getMemoryMarkdownPath } from "../local-data.js";

export interface ExportMarkdownOptions {
  outPath?: string;
  agentsMd?: boolean;
  maxLines?: number;
  includeObserved?: boolean;
}

export interface ExportMarkdownResult {
  path: string;
  exportedNodes: number;
  totalCuratedNodes: number;
  agentsMdUpdated: boolean;
}

const SECTION_ORDER: Array<{ type: NodeType; heading: string }> = [
  { type: "Constraint", heading: "Constraints" },
  { type: "Decision", heading: "Decisions" },
  { type: "Convention", heading: "Conventions" },
  { type: "FailedApproach", heading: "Failed Approaches" },
  { type: "Discovery", heading: "Discoveries" },
  { type: "OpenIssue", heading: "Open Issues" },
];

const START_MARKER = "<!-- dev-mem:start -->";
const END_MARKER = "<!-- dev-mem:end -->";

function singleLineSummary(content: string, maxChars = 140): string {
  const clean = sanitizeText(content).replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars - 3).trimEnd() + "...";
}

function compareNodesForExport(a: KnowledgeNode, b: KnowledgeNode): number {
  const rank = (n: KnowledgeNode) => (n.lifecycle_state === "verified" ? 0 : 1);
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  const timeDiff = b.updated_at.localeCompare(a.updated_at);
  if (timeDiff !== 0) return timeDiff;
  const titleDiff = a.title.localeCompare(b.title);
  if (titleDiff !== 0) return titleDiff;
  return a.id.localeCompare(b.id);
}

function formatNodeBullet(node: KnowledgeNode): string {
  const shortId = node.id.slice(0, 8);
  const title = sanitizeText(node.title).replace(/\s+/g, " ").trim();
  const detail = singleLineSummary(node.content);
  const files = node.evidence.files.slice(0, 3).join(", ");
  const metaParts: string[] = [node.lifecycle_state];
  if (files) metaParts.push(files);
  const summarySuffix = detail && detail !== title ? ` — ${detail}` : "";
  return `- **[${shortId}]** **${title}**${summarySuffix} *(${metaParts.join(" · ")})*`;
}

function buildMarkdownDocument(
  nodes: KnowledgeNode[],
  maxLines: number,
): { markdown: string; shownCount: number } {
  const headerLines = [
    "# Project Memory (Dev-Mem)",
    "",
    "> Auto-generated git-diffable projection of curated local memory. Edit via `dev-memo review` / `edit` / `forget`, then run `dev-memo sync` or `dev-memo export --md`.",
    "",
  ];

  if (nodes.length === 0) {
    const empty = [
      ...headerLines,
      "_No curated memory nodes yet. Run `dev-memo review` or `dev-memo bootstrap`._",
      "",
    ];
    return { markdown: empty.join("\n"), shownCount: 0 };
  }

  // Reserve space for header and optional overflow footer
  const reserveFooter = 2;
  const budget = Math.max(8, maxLines);
  const outputLines = [...headerLines];
  let shownCount = 0;
  let truncated = false;

  for (const section of SECTION_ORDER) {
    const sectionNodes = nodes
      .filter((n) => n.type === section.type)
      .sort(compareNodesForExport);
    if (sectionNodes.length === 0) continue;

    // Need at least heading + 1 bullet + spacing
    if (outputLines.length + 2 + reserveFooter > budget) {
      truncated = true;
      break;
    }

    outputLines.push(`## ${section.heading}`);
    for (const node of sectionNodes) {
      if (outputLines.length + 1 + reserveFooter > budget) {
        truncated = true;
        break;
      }
      outputLines.push(formatNodeBullet(node));
      shownCount++;
    }
    outputLines.push("");
    if (truncated) break;
  }

  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === "") {
    outputLines.pop();
  }

  if (shownCount < nodes.length) {
    outputLines.push("");
    outputLines.push(
      `_Showing ${shownCount} of ${nodes.length} curated nodes. Run \`dev-memo list\` or \`dev-memo inspect <id>\` for full details._`,
    );
  }

  return { markdown: outputLines.join("\n") + "\n", shownCount };
}

function upsertAgentsMdPointer(projectRoot: string, curatedNodes: KnowledgeNode[]): boolean {
  const agentsPath = join(projectRoot, "AGENTS.md");
  const topRules = curatedNodes
    .filter((n) => n.type === "Constraint" || n.type === "Decision" || n.type === "FailedApproach")
    .sort(compareNodesForExport)
    .slice(0, 6);

  const blockLines = [
    START_MARKER,
    "## Dev-Mem Project Memory",
    "",
    "Curated project memory lives in `.dev-mem/MEMORY.md` (SQLite graph synced via `dev-memo sync`).",
    "Before changing architecture or debugging recurring failures, run `dev-memo query \"<task>\"` or query the `dev_mem_query` MCP tool.",
    "",
    ...(topRules.length > 0
      ? ["Top curated rules:", ...topRules.map((n) => `- **[${n.type}]** ${sanitizeText(n.title).trim()}`), ""]
      : []),
    END_MARKER,
  ];
  const block = blockLines.join("\n");

  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, `${block}\n`, "utf8");
    return true;
  }

  const current = readFileSync(agentsPath, "utf8");
  const startIdx = current.indexOf(START_MARKER);
  const endIdx = current.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = current.slice(0, startIdx);
    const after = current.slice(endIdx + END_MARKER.length);
    const updated = `${before}${block}${after}`;
    if (updated === current) return false;
    writeFileSync(agentsPath, updated, "utf8");
    return true;
  }

  const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(agentsPath, `${current}${separator}${block}\n`, "utf8");
  return true;
}

/**
 * Generates a deterministic, git-diffable Markdown summary of curated project memory
 * (verified + active nodes) at `.dev-mem/MEMORY.md` (or `--out <path>`).
 */
export function exportMemoryMarkdown(
  projectRoot: string,
  options: ExportMarkdownOptions = {},
): ExportMarkdownResult {
  ensureLocalDataDir(projectRoot);
  const outPath = options.outPath
    ? resolve(projectRoot, options.outPath)
    : getMemoryMarkdownPath(projectRoot);
  mkdirSync(dirname(outPath), { recursive: true });

  const allowedStates = options.includeObserved
    ? new Set(["verified", "active", "observed"])
    : new Set(["verified", "active"]);

  const store = new GraphStore({ projectRoot });
  let curated: KnowledgeNode[] = [];
  try {
    curated = store
      .queryAllNodes()
      .filter((n) => allowedStates.has(n.lifecycle_state));
  } finally {
    store.close();
  }

  const maxLines = options.maxLines ?? 60;
  const { markdown, shownCount } = buildMarkdownDocument(curated, maxLines);
  writeFileSync(outPath, markdown, "utf8");

  const agentsMdUpdated = options.agentsMd
    ? upsertAgentsMdPointer(projectRoot, curated)
    : false;

  return {
    path: outPath,
    exportedNodes: shownCount,
    totalCuratedNodes: curated.length,
    agentsMdUpdated,
  };
}
