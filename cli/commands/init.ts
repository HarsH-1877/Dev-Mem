import { existsSync } from "node:fs";
import { join } from "node:path";
import { bootstrapProject } from "../../core/bootstrap/index.js";
import { detectAvailableCliAgents, resolveProviderForProject } from "../../core/llm/index.js";
import { getBanner } from "../banner.js";
import { installHooks, registerMcpConfigs } from "./install.js";

function inferAgentsWhenEmpty(cwd: string): string[] {
  const hasAnyDir =
    existsSync(join(cwd, ".claude")) ||
    existsSync(join(cwd, ".codex")) ||
    existsSync(join(cwd, ".cursor")) ||
    existsSync(join(cwd, ".opencode")) ||
    existsSync(join(cwd, "opencode.json"));

  if (hasAnyDir) return [];

  const clis = detectAvailableCliAgents();
  const inferred: string[] = [];
  if (clis.includes("claude")) inferred.push("claude-code");
  if (clis.includes("codex")) inferred.push("codex");
  return inferred;
}

export async function runInit(
  cwd: string,
  args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const noMcp = args.includes("--no-mcp");
  const noBootstrap = args.includes("--no-bootstrap");
  const requestedAgents = args.filter((a) => !a.startsWith("-"));

  const agentsToInstall =
    requestedAgents.length > 0 ? requestedAgents : inferAgentsWhenEmpty(cwd);

  const { installedAgents } = installHooks(cwd, agentsToInstall);

  const lines: string[] = [
    getBanner(),
    "",
    `Hooks installed: ${installedAgents.join(", ")}`,
  ];

  if (!noMcp) {
    const mcpFiles = registerMcpConfigs(cwd, installedAgents);
    if (mcpFiles.length > 0) {
      lines.push(`MCP registered: ${mcpFiles.join(", ")}`);
    } else {
      lines.push("MCP registered: none (register `npx -y dev-memo mcp` in your agent's MCP config if desired)");
    }
  }

  const provider = resolveProviderForProject(cwd);
  if (provider) {
    lines.push(`Extraction backend: ${provider.name}`);
  } else {
    lines.push(
      "Extraction backend: none configured (authenticate claude/codex/gemini CLI, set an API key, or configure Ollama)",
    );
  }

  if (!noBootstrap) {
    const boot = await bootstrapProject({ projectRoot: cwd });
    const total = boot.revertsAdded + boot.rulesAdded;
    lines.push(
      `Bootstrapped ${total} starter memory node(s) (reverts: ${boot.revertsAdded}, rules: ${boot.rulesAdded}, skipped duplicates: ${boot.skippedDuplicates})`,
    );
  }

  lines.push("");
  lines.push("Ready. Start coding — Dev-Mem will inject context automatically and extract at session end.");

  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}
