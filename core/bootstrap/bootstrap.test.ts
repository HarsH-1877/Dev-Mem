import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapProject } from "./index.js";
import { GraphStore } from "../graph/index.js";

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@dev-mem.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# Sample\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: initial commit"], { cwd: dir, stdio: "ignore" });
}

describe("Cold-start project bootstrap (core/bootstrap)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-bootstrap-"));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mines git revert commits into FailedApproach nodes with real commit and file evidence", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "cache.ts"), "export const v = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add global WeakMap cache"], { cwd: dir, stdio: "ignore" });
    const badSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    execFileSync("git", ["revert", "--no-edit", badSha], { cwd: dir, stdio: "ignore" });

    const res = await bootstrapProject({ projectRoot: dir });
    expect(res.revertsAdded).toBe(1);

    const store = new GraphStore({ projectRoot: dir });
    const failed = store.queryByType("FailedApproach");
    store.close();

    expect(failed).toHaveLength(1);
    expect(failed[0].title).toContain("add global WeakMap cache");
    expect(failed[0].evidence.files).toContain("src/cache.ts");
    expect(failed[0].lifecycle_state).toBe("observed");
  });

  it("mines CLAUDE.md and AGENTS.md rules into Constraint/Convention nodes and stays idempotent", async () => {
    writeFileSync(
      join(dir, "AGENTS.md"),
      [
        "# Agent Rules",
        "",
        "## Constraints",
        "- Never commit raw .env files or credentials to version control.",
        "- Always run npm test cleanly before opening a PR.",
        "",
        "```bash",
        "- Never inside code block should not become a rule",
        "```",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "- Prefer strict ESM imports with .js extensions across all TypeScript modules.\n",
      "utf8",
    );
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "docs: add agent instructions"], { cwd: dir, stdio: "ignore" });

    const first = await bootstrapProject({ projectRoot: dir });
    expect(first.rulesAdded).toBe(3);
    expect(first.sourcesScanned).toContain("AGENTS.md");
    expect(first.sourcesScanned).toContain("CLAUDE.md");

    const store = new GraphStore({ projectRoot: dir });
    const constraints = store.queryByType("Constraint");
    const conventions = store.queryByType("Convention");
    store.close();

    expect(constraints.some((c) => c.title.includes("Never commit raw .env"))).toBe(true);
    expect(conventions.some((c) => c.title.includes("Always run npm test"))).toBe(true);
    expect(conventions.some((c) => c.title.includes("Prefer strict ESM"))).toBe(true);
    expect([...constraints, ...conventions].some((c) => c.title.includes("inside code block"))).toBe(false);

    // Re-running bootstrap must deduplicate cleanly
    const second = await bootstrapProject({ projectRoot: dir });
    expect(second.rulesAdded).toBe(0);
    expect(second.skippedDuplicates).toBe(3);
  });

  it("supports custom --from markdown files and scrubs secrets", async () => {
    const customPath = join(dir, "NOTES.md");
    writeFileSync(
      customPath,
      "- Never leak tokens such as ANTHROPIC_API_KEY=" + "sk-ant-" + "api03-abcdef1234567890abcdef in logs.\n",
      "utf8",
    );

    const res = await bootstrapProject({ projectRoot: dir, fromFiles: [customPath] });
    expect(res.rulesAdded).toBe(1);

    const store = new GraphStore({ projectRoot: dir });
    const nodes = store.queryByType("Constraint");
    store.close();

    expect(nodes[0].content).toContain("[REDACTED_SECRET]");
    expect(nodes[0].content).not.toContain("sk-ant-");
  });
});
