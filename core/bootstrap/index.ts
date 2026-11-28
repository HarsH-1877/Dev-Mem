import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { sanitizeText } from "../capture/sanitize.js";
import { GraphStore, type NodeType } from "../graph/index.js";

export interface BootstrapOptions {
  projectRoot: string;
  /** Max recent git commits to inspect for reverts (default: 100). */
  commitLimit?: number;
  /** Max FailedApproach nodes mined from git reverts (default: 10). */
  maxReverts?: number;
  /** Max rule nodes mined per markdown/rules file (default: 15). */
  maxRulesPerFile?: number;
  /** Extra instruction/memory file paths (e.g. ~/.claude/projects/.../MEMORY.md). */
  fromFiles?: string[];
}

export interface BootstrapResult {
  revertsAdded: number;
  rulesAdded: number;
  skippedDuplicates: number;
  sourcesScanned: string[];
}

const DEFAULT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  join(".claude", "CLAUDE.md"),
  ".cursorrules",
  join(".github", "copilot-instructions.md"),
];

const REVERT_SUBJECT_RE = /^(?:revert\s+"(.+?)"|revert:\s*(.+))$/i;
const RULE_SIGNAL_RE =
  /\b(never|must\s+not|do\s+not|don't|avoid|prohibit\w*|forbid\w*|always|must|prefer|use|require\w*|ensure|run|keep)\b/i;
const RULE_HEADING_RE =
  /\b(rule|constraint|convention|guideline|invariant|standard|command)\b/i;
const PROHIBITION_RE =
  /\b(never|must\s+not|do\s+not|don't|avoid|prohibit\w*|forbid\w*)\b/i;

function normalizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
  } catch {
    return null;
  }
}

function cleanMarkdownInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateTitle(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

interface ParsedRule {
  type: Extract<NodeType, "Constraint" | "Convention">;
  title: string;
  content: string;
}

function extractRulesFromMarkdown(raw: string, relSource: string, maxRules: number): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const lines = raw.split(/\r?\n/);

  let inCodeFence = false;
  let inManagedBlock = false;
  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    if (trimmed.includes("<!-- dev-mem:start -->")) {
      inManagedBlock = true;
      continue;
    }
    if (trimmed.includes("<!-- dev-mem:end -->")) {
      inManagedBlock = false;
      continue;
    }
    if (inManagedBlock) continue;

    const headingMatch = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      currentSection = cleanMarkdownInline(headingMatch[1]);
      continue;
    }

    const bulletMatch = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
    if (!bulletMatch) continue;

    const cleaned = sanitizeText(cleanMarkdownInline(bulletMatch[1]));
    if (cleaned.length < 15 || cleaned.length > 320) continue;

    const hasSignal = RULE_SIGNAL_RE.test(cleaned) || RULE_HEADING_RE.test(currentSection);
    if (!hasSignal) continue;

    const type: ParsedRule["type"] = PROHIBITION_RE.test(cleaned) ? "Constraint" : "Convention";
    const prefix = currentSection ? `[${relSource} > ${currentSection}] ` : `[${relSource}] `;
    rules.push({
      type,
      title: truncateTitle(cleaned),
      content: `${prefix}${cleaned}`,
    });

    if (rules.length >= maxRules) break;
  }

  return rules;
}

function discoverInstructionFiles(projectRoot: string, extraFiles: string[]): Array<{ absPath: string; relPath: string; insideRepo: boolean }> {
  const seenAbs = new Set<string>();
  const results: Array<{ absPath: string; relPath: string; insideRepo: boolean }> = [];

  const pushIfExists = (absPath: string) => {
    if (seenAbs.has(absPath) || !existsSync(absPath)) return;
    seenAbs.add(absPath);
    const rel = relative(projectRoot, absPath).replace(/\\/g, "/");
    const insideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    results.push({ absPath, relPath: insideRepo ? rel : absPath.replace(/\\/g, "/"), insideRepo });
  };

  for (const rel of DEFAULT_INSTRUCTION_FILES) {
    pushIfExists(join(projectRoot, rel));
  }

  const cursorRulesDir = join(projectRoot, ".cursor", "rules");
  if (existsSync(cursorRulesDir)) {
    try {
      const files = readdirSync(cursorRulesDir)
        .filter((f) => f.endsWith(".md") || f.endsWith(".mdc"))
        .sort();
      for (const f of files) pushIfExists(join(cursorRulesDir, f));
    } catch {}
  }

  for (const custom of extraFiles) {
    if (!custom || !custom.trim()) continue;
    const abs = isAbsolute(custom) ? custom : join(projectRoot, custom);
    pushIfExists(abs);
  }

  return results;
}

/**
 * Deterministic ($0 LLM) project cold-start bootstrap:
 * 1. Mines recent git revert commits into `FailedApproach` nodes.
 * 2. Mines repo instruction files (AGENTS.md, CLAUDE.md, .cursorrules, etc.) into
 *    `Constraint` and `Convention` nodes.
 * Idempotent: deduplicates by normalized title against existing GraphStore nodes.
 */
export async function bootstrapProject(options: BootstrapOptions): Promise<BootstrapResult> {
  const {
    projectRoot,
    commitLimit = 100,
    maxReverts = 10,
    maxRulesPerFile = 15,
    fromFiles = [],
  } = options;

  let revertsAdded = 0;
  let rulesAdded = 0;
  let skippedDuplicates = 0;
  const sourcesScanned: string[] = [];

  const now = new Date().toISOString();
  const headCommit = tryGit(projectRoot, ["rev-parse", "HEAD"]) || "0000000000000000000000000000000000000000";

  const store = new GraphStore({ projectRoot });
  try {
    const existingNodes = store.queryAllNodes();
    const seenTitles = new Set<string>(existingNodes.map((n) => normalizeTitleKey(n.title)));

    // 1. Mine git revert commits -> FailedApproach
    const rawLog = tryGit(projectRoot, [
      "log",
      `-n${commitLimit}`,
      "--format=%H%x1f%s%x1f%b%x1e",
    ]);

    if (rawLog) {
      sourcesScanned.push("git-history");
      const records = rawLog.split("\x1e").filter((r) => r.trim() !== "");
      for (const rec of records) {
        if (revertsAdded >= maxReverts) break;
        const [sha = "", subject = "", body = ""] = rec.split("\x1f").map((s) => s.trim());
        if (!sha || !subject) continue;

        const match = subject.match(REVERT_SUBJECT_RE);
        if (!match) continue;

        const originalSubject = sanitizeText((match[1] || match[2] || subject).trim());
        const title = truncateTitle(`Reverted: ${originalSubject}`);
        const key = normalizeTitleKey(title);
        if (seenTitles.has(key)) {
          skippedDuplicates++;
          continue;
        }

        const touchedRaw = tryGit(projectRoot, ["show", "--name-only", "--format=", sha]) || "";
        const files = touchedRaw
          .split(/\r?\n/)
          .map((f) => f.trim())
          .filter(Boolean)
          .slice(0, 10);

        const grounded = files.length > 0;
        const cleanBody = sanitizeText(body.replace(/\s+/g, " ").trim());
        const content = cleanBody
          ? `Commit ${sha.slice(0, 7)} reverted "${originalSubject}". ${cleanBody}`
          : `Commit ${sha.slice(0, 7)} reverted "${originalSubject}".`;

        store.createNode({
          type: "FailedApproach",
          title,
          content,
          lifecycle_state: "observed",
          evidence: {
            commit: sha,
            files: grounded ? files : ["(ungrounded)"],
            ...(grounded ? {} : { grounded: false }),
            session_id: "bootstrap",
            agent: "bootstrap",
            timestamp: now,
            confidence: 0.85,
          },
        });
        seenTitles.add(key);
        revertsAdded++;
      }
    }

    // 2. Mine instruction & rules files -> Constraint / Convention
    const filesToScan = discoverInstructionFiles(projectRoot, fromFiles);
    for (const file of filesToScan) {
      let content = "";
      try {
        content = readFileSync(file.absPath, "utf8");
      } catch {
        continue;
      }

      sourcesScanned.push(file.relPath);
      const parsed = extractRulesFromMarkdown(content, file.relPath, maxRulesPerFile);
      for (const rule of parsed) {
        const key = normalizeTitleKey(rule.title);
        if (seenTitles.has(key)) {
          skippedDuplicates++;
          continue;
        }

        store.createNode({
          type: rule.type,
          title: rule.title,
          content: rule.content,
          lifecycle_state: "observed",
          evidence: {
            commit: headCommit,
            files: [file.relPath],
            ...(file.insideRepo ? {} : { grounded: false }),
            session_id: "bootstrap",
            agent: "bootstrap",
            timestamp: now,
            confidence: 0.85,
          },
        });
        seenTitles.add(key);
        rulesAdded++;
      }
    }
  } finally {
    store.close();
  }

  return {
    revertsAdded,
    rulesAdded,
    skippedDuplicates,
    sourcesScanned,
  };
}
