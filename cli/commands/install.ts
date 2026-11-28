import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLocalDataDir, getDevMemDir, isLinkedWorktree } from "../../core/local-data.js";
import {
  ANTIGRAVITY_INSTALLED_EVENTS,
  ANTIGRAVITY_LIFECYCLE_EVENTS,
  ANTIGRAVITY_TOOL_EVENTS,
} from "../../adapters/antigravity/index.js";
import { buildResolverSource, HOOK_MARKER } from "../hook-resolver.js";

function adapterHook(adapter: "claude-code" | "codex" | "cursor" | "antigravity", eventArg?: string): string {
  const pushEvent = eventArg ? `  process.argv.push("--event", ${JSON.stringify(eventArg)});\n` : "";
  if (adapter === "antigravity" && eventArg === "PreToolUse") {
    return `${buildResolverSource()}
let handled = false;
if (distDir) {
${pushEvent}  try {
    await import(pathToFileURL(join(distDir, "adapters", "${adapter}", "hook.js")).href);
    handled = true;
  } catch {}
}
if (!handled) {
  process.stdout.write('{"decision":"allow"}\\n');
}
`;
  }
  return `${buildResolverSource()}
if (distDir) {
${pushEvent}  try { await import(pathToFileURL(join(distDir, "adapters", "${adapter}", "hook.js")).href); } catch {}
}
`;
}

function getHookScriptCode(_eventName: string): string { return adapterHook("claude-code"); }
function getCodexHookScriptCode(_eventName: string): string { return adapterHook("codex"); }
function getCursorHookScriptCode(_eventName: string): string { return adapterHook("cursor"); }
function getAntigravityHookScriptCode(eventName: string): string { return adapterHook("antigravity", eventName); }

function toKebabCase(name: string): string {
  return name.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
}

function getOpenCodeHookScriptCode(): string {
  return `import { spawnSync } from "node:child_process";
${buildResolverSource()}

export default async function DevMemPlugin(input, options) {
  if (!distDir) return input;
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(currentDir, "../.."); // up from .opencode/plugins/
  const hookPath = fileURLToPath(pathToFileURL(join(distDir, "adapters/opencode/hook.js")));

  function runHookSync(eventName, payload) {
    try {
      const res = spawnSync("node", [hookPath], {
        input: JSON.stringify({ hook_event_name: eventName, cwd: projectRoot, ...payload }),
        encoding: "utf8",
      });
      if (res.stdout) {
        try {
          const out = JSON.parse(res.stdout);
          return out.hookSpecificOutput;
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  return {
    "chat.message": async (pluginInput, output) => {
      const res = runHookSync("chat.message", { session_id: pluginInput.sessionID, message: pluginInput.message });
      if (res && res.additionalContext) {
        output.message.parts.push({ type: "text", text: "\\n\\n" + res.additionalContext });
      }
    },
    "tool.execute.after": async (pluginInput, output) => {
      const res = runHookSync("tool.execute.after", {
        session_id: pluginInput.sessionID,
        callID: pluginInput.callID,
        tool: pluginInput.tool,
        args: pluginInput.args,
        output: output.output,
        metadata: output.metadata,
      });
      if (res && res.additionalContext) {
        // Logged internally by hook
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.status" && (event.properties || event.data)?.status?.type === "idle") {
        runHookSync("session.idle", { session_id: event.properties?.sessionID || event.data?.sessionID || "unknown" });
      }
    }
  };
}
`;
}

function installClaudeCodeHooks(cwd: string): void {
  const claudeDir = join(cwd, ".claude");
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  const hooksDir = join(claudeDir, "hooks");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"];
  const hookConfigs: Record<string, any[]> = {};

  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, "-$1").replace(/^-/, "")}.js`;
    writeFileSync(join(hooksDir, scriptName), getHookScriptCode(event), "utf8");

    hookConfigs[event] = [
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/${scriptName}`],
          },
        ],
      },
    ];
  }

  const settingsPath = join(claudeDir, "settings.json");
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {}
  }

  if (!settings.hooks) settings.hooks = {};

  for (const event of events) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const existing = settings.hooks[event].find(
      (h: any) => h.hooks && h.hooks[0] && h.hooks[0].args && h.hooks[0].args[0].includes("dev-mem"),
    );
    if (!existing) {
      settings.hooks[event].push(hookConfigs[event][0]);
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

function installCodexHooks(cwd: string): void {
  const codexDir = join(cwd, ".codex");
  if (!existsSync(codexDir)) mkdirSync(codexDir, { recursive: true });

  const hooksDir = join(codexDir, "hooks");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const events = ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, "-$1").replace(/^-/, "")}.js`;
    writeFileSync(join(hooksDir, scriptName), getCodexHookScriptCode(event), "utf8");
  }

  const hooksJsonPath = join(codexDir, "hooks.json");
  let hooksJson: any = { hooks: {} };
  if (existsSync(hooksJsonPath)) {
    try {
      hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      if (!hooksJson.hooks) hooksJson.hooks = {};
    } catch {}
  }

  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, "-$1").replace(/^-/, "")}.js`;
    if (!hooksJson.hooks[event]) hooksJson.hooks[event] = [];

    const existing = hooksJson.hooks[event].find((h: any) => {
      const cmd: string = h.command ?? (Array.isArray(h.hooks) ? h.hooks[0]?.command : "");
      return cmd && cmd.includes("dev-mem");
    });

    if (!existing) {
      const entry: any = {
        type: "command",
        command: `node .codex/hooks/${scriptName}`,
        timeout: 3,
      };
      if (event === "SessionEnd") entry.async = true;
      hooksJson.hooks[event].push(entry);
    }
  }

  writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2), "utf8");
}

function installCursorHooks(cwd: string): void {
  const cursorDir = join(cwd, ".cursor");
  if (!existsSync(cursorDir)) mkdirSync(cursorDir, { recursive: true });

  const hooksDir = join(cursorDir, "hooks");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const events = ["sessionStart", "preToolUse", "postToolUse", "stop"];
  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase()}.js`;
    writeFileSync(join(hooksDir, scriptName), getCursorHookScriptCode(event), "utf8");
  }

  const hooksJsonPath = join(cursorDir, "hooks.json");
  let hooksJson: any = { version: 1, hooks: {} };
  if (existsSync(hooksJsonPath)) {
    try {
      hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      if (!hooksJson.hooks) hooksJson.hooks = {};
    } catch {}
  }

  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase()}.js`;
    if (!hooksJson.hooks[event]) hooksJson.hooks[event] = [];

    const existing = hooksJson.hooks[event].find((h: any) => {
      const cmd: string = h.command ?? "";
      return cmd && cmd.includes("dev-mem");
    });

    if (!existing) {
      hooksJson.hooks[event].push({
        command: `node .cursor/hooks/${scriptName}`,
        matcher: "*",
        timeout: 3,
      });
    }
  }

  writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2), "utf8");
}

function installOpenCodeHooks(cwd: string): void {
  const opencodeDir = join(cwd, ".opencode");
  if (!existsSync(opencodeDir)) mkdirSync(opencodeDir, { recursive: true });

  const pluginsDir = join(opencodeDir, "plugins");
  if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });

  writeFileSync(join(pluginsDir, "dev-mem.ts"), getOpenCodeHookScriptCode(), "utf8");

  const configPath = join(opencodeDir, "opencode.json");
  let config: any = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {}
  }

  if (!config.plugin) config.plugin = [];
  if (!Array.isArray(config.plugin)) config.plugin = [config.plugin];

  const hasPlugin = config.plugin.some(
    (p: any) =>
      p === "dev-mem" ||
      (Array.isArray(p) && p[0] === "dev-mem") ||
      p === "./.opencode/plugins/dev-mem.ts" ||
      (Array.isArray(p) && p[0] === "./.opencode/plugins/dev-mem.ts"),
  );

  if (!hasPlugin) {
    config.plugin.push("./.opencode/plugins/dev-mem.ts");
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

function installAntigravityHooks(cwd: string): void {
  const agentsDir = join(cwd, ".agents");
  const hooksDir = join(agentsDir, "hooks");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  for (const event of ANTIGRAVITY_INSTALLED_EVENTS) {
    const scriptName = `dev-mem-${toKebabCase(event)}.js`;
    writeFileSync(join(hooksDir, scriptName), getAntigravityHookScriptCode(event), "utf8");
  }

  mergeJsonFile(join(agentsDir, "hooks.json"), (hooksJson) => {
    const devMemoGroup: Record<string, any[]> = {};
    for (const event of ANTIGRAVITY_LIFECYCLE_EVENTS) {
      const scriptName = `dev-mem-${toKebabCase(event)}.js`;
      devMemoGroup[event] = [
        {
          type: "command",
          command: `node .agents/hooks/${scriptName}`,
          timeout: 5,
        },
      ];
    }
    for (const event of ANTIGRAVITY_TOOL_EVENTS) {
      const scriptName = `dev-mem-${toKebabCase(event)}.js`;
      devMemoGroup[event] = [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `node .agents/hooks/${scriptName}`,
              timeout: 5,
            },
          ],
        },
      ];
    }
    hooksJson["dev-memo"] = devMemoGroup;
  });
}

export function installHooks(cwd: string, requestedAgents: string[]): { installedAgents: string[]; defaultedToClaude: boolean } {
  const installedAgents: string[] = [];
  const validAgents = ["claude-code", "codex", "cursor", "opencode", "antigravity"];
  const agentAliases: Record<string, string> = { agy: "antigravity" };

  const explicitAgents = requestedAgents.map((a) => {
    const lower = a.toLowerCase();
    return agentAliases[lower] ?? lower;
  });
  for (const agent of explicitAgents) {
    if (!validAgents.includes(agent)) {
      throw new Error(`Invalid agent: ${agent}. Supported agents: ${validAgents.join(", ")}`);
    }
  }

  const explicit = explicitAgents.length > 0;
  const claudePresent = explicit ? explicitAgents.includes("claude-code") : existsSync(join(cwd, ".claude"));
  const codexPresent = explicit ? explicitAgents.includes("codex") : existsSync(join(cwd, ".codex"));
  const cursorPresent = explicit ? explicitAgents.includes("cursor") : existsSync(join(cwd, ".cursor"));
  const opencodePresent = explicit
    ? explicitAgents.includes("opencode")
    : existsSync(join(cwd, ".opencode")) || existsSync(join(cwd, "opencode.json"));
  const antigravityPresent = explicit
    ? explicitAgents.includes("antigravity")
    : existsSync(join(cwd, ".agents")) || existsSync(join(cwd, "GEMINI.md"));

  const defaultedToClaude =
    !explicit && !claudePresent && !codexPresent && !cursorPresent && !opencodePresent && !antigravityPresent;
  if (claudePresent || defaultedToClaude) {
    installClaudeCodeHooks(cwd);
    installedAgents.push("claude-code");
  }
  if (codexPresent) {
    installCodexHooks(cwd);
    installedAgents.push("codex");
  }
  if (cursorPresent) {
    installCursorHooks(cwd);
    installedAgents.push("cursor");
  }
  if (opencodePresent) {
    installOpenCodeHooks(cwd);
    installedAgents.push("opencode");
  }
  if (antigravityPresent) {
    installAntigravityHooks(cwd);
    installedAgents.push("antigravity");
  }

  ensureLocalDataDir(cwd);
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const distDir = join(currentDir, "../..").replace(/\\/g, "/");
    writeFileSync(join(getDevMemDir(cwd), "install-path.txt"), distDir, "utf8");
  } catch {}

  return { installedAgents, defaultedToClaude };
}

function uninstallOpenCodeHooks(cwd: string): void {
  const opencodeDir = join(cwd, ".opencode");
  const configPath = join(opencodeDir, "opencode.json");

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (Array.isArray(config.plugin)) {
        config.plugin = config.plugin.filter((p: any) => {
          const name = Array.isArray(p) ? p[0] : p;
          return name !== "dev-mem" && !name.includes("dev-mem.ts");
        });
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      }
    } catch {}
  }

  const pluginPath = join(opencodeDir, "plugins", "dev-mem.ts");
  if (existsSync(pluginPath)) rmSync(pluginPath);
}

function uninstallCodexHooks(cwd: string): void {
  const codexDir = join(cwd, ".codex");
  const hooksJsonPath = join(codexDir, "hooks.json");

  if (existsSync(hooksJsonPath)) {
    try {
      const hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      if (hooksJson.hooks) {
        for (const event of Object.keys(hooksJson.hooks)) {
          hooksJson.hooks[event] = hooksJson.hooks[event].filter((h: any) => {
            const cmd: string = h.command ?? "";
            return !cmd.includes("dev-mem");
          });
          if (hooksJson.hooks[event].length === 0) delete hooksJson.hooks[event];
        }
      }
      writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2), "utf8");
    } catch {}
  }

  const hooksDir = join(codexDir, "hooks");
  if (existsSync(hooksDir)) {
    const events = ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
    for (const event of events) {
      const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, "-$1").replace(/^-/, "")}.js`;
      const scriptPath = join(hooksDir, scriptName);
      if (existsSync(scriptPath)) rmSync(scriptPath);
    }
  }
}

function uninstallCursorHooks(cwd: string): void {
  const cursorDir = join(cwd, ".cursor");
  const hooksJsonPath = join(cursorDir, "hooks.json");

  if (existsSync(hooksJsonPath)) {
    try {
      const hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      if (hooksJson.hooks) {
        for (const event of Object.keys(hooksJson.hooks)) {
          hooksJson.hooks[event] = hooksJson.hooks[event].filter((h: any) => {
            const cmd: string = h.command ?? "";
            return !cmd.includes("dev-mem");
          });
          if (hooksJson.hooks[event].length === 0) delete hooksJson.hooks[event];
        }
      }
      writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2), "utf8");
    } catch {}
  }

  const hooksDir = join(cursorDir, "hooks");
  if (existsSync(hooksDir)) {
    const events = ["sessionStart", "preToolUse", "postToolUse", "stop"];
    for (const event of events) {
      const scriptName = `dev-mem-${event.toLowerCase()}.js`;
      const scriptPath = join(hooksDir, scriptName);
      if (existsSync(scriptPath)) rmSync(scriptPath);
    }
  }
}

function uninstallAntigravityHooks(cwd: string): void {
  const agentsDir = join(cwd, ".agents");
  const hooksJsonPath = join(agentsDir, "hooks.json");

  if (existsSync(hooksJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        delete parsed["dev-memo"];
        writeFileSync(hooksJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      }
    } catch {}
  }

  const hooksDir = join(agentsDir, "hooks");
  if (existsSync(hooksDir)) {
    for (const event of ANTIGRAVITY_INSTALLED_EVENTS) {
      const scriptName = `dev-mem-${toKebabCase(event)}.js`;
      const scriptPath = join(hooksDir, scriptName);
      if (existsSync(scriptPath)) rmSync(scriptPath);
    }
  }
}

export function uninstallHooks(cwd: string, purge: boolean): void {
  const claudeDir = join(cwd, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
          settings.hooks[event] = settings.hooks[event].filter(
            (h: any) => !(h.hooks && h.hooks[0] && h.hooks[0].args && h.hooks[0].args[0].includes("dev-mem")),
          );
          if (settings.hooks[event].length === 0) delete settings.hooks[event];
        }
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    } catch {}
  }

  const claudeHooksDir = join(claudeDir, "hooks");
  if (existsSync(claudeHooksDir)) {
    const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"];
    for (const event of events) {
      const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, "-$1").replace(/^-/, "")}.js`;
      const scriptPath = join(claudeHooksDir, scriptName);
      if (existsSync(scriptPath)) rmSync(scriptPath);
    }
  }

  if (existsSync(join(cwd, ".codex"))) uninstallCodexHooks(cwd);
  if (existsSync(join(cwd, ".cursor"))) uninstallCursorHooks(cwd);
  if (existsSync(join(cwd, ".opencode")) || existsSync(join(cwd, "opencode.json"))) uninstallOpenCodeHooks(cwd);
  if (existsSync(join(cwd, ".agents"))) uninstallAntigravityHooks(cwd);

  if (purge && !isLinkedWorktree(cwd)) {
    const devMemDir = getDevMemDir(cwd);
    if (existsSync(devMemDir)) rmSync(devMemDir, { recursive: true, force: true });
  }
}

export function findStaleHooks(cwd: string): string[] {
  const locations: Array<[string, RegExp]> = [
    [".claude/hooks", /^dev-mem-.*\.js$/],
    [".codex/hooks", /^dev-mem-.*\.js$/],
    [".cursor/hooks", /^dev-mem-.*\.js$/],
    [".opencode/plugins", /^dev-mem.*\.[jt]s$/],
    [".agents/hooks", /^dev-mem-.*\.js$/],
  ];
  const stale: string[] = [];
  for (const [rel, pattern] of locations) {
    const dir = join(cwd, rel);
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      try {
        if (!readFileSync(join(dir, name), "utf8").includes(HOOK_MARKER)) stale.push(`${rel}/${name}`);
      } catch {}
    }
  }
  return stale;
}

const MCP_ENTRY = {
  command: "npx",
  args: ["-y", "dev-memo", "mcp"],
};

function mergeJsonFile(filePath: string, updater: (current: Record<string, any>) => void): void {
  let obj: Record<string, any> = {};
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed;
      }
    } catch {}
  }
  updater(obj);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function registerStandardMcpServer(target: string): void {
  mergeJsonFile(target, (obj) => {
    if (!obj.mcpServers || typeof obj.mcpServers !== "object") obj.mcpServers = {};
    if (!obj.mcpServers["dev-memo"]) {
      obj.mcpServers["dev-memo"] = MCP_ENTRY;
    }
  });
}

/**
 * Idempotently registers `dev-memo mcp` in project MCP configuration files for
 * the installed agents. Returns relative config file paths written/verified.
 */
export function registerMcpConfigs(cwd: string, agents: string[]): string[] {
  const registered: string[] = [];

  if (agents.includes("claude-code")) {
    registerStandardMcpServer(join(cwd, ".mcp.json"));
    registered.push(".mcp.json");
  }

  if (agents.includes("cursor")) {
    registerStandardMcpServer(join(cwd, ".cursor", "mcp.json"));
    registered.push(".cursor/mcp.json");
  }

  if (agents.includes("antigravity")) {
    registerStandardMcpServer(join(cwd, ".agents", "mcp_config.json"));
    registered.push(".agents/mcp_config.json");
  }

  if (agents.includes("opencode")) {
    const rootCfg = join(cwd, "opencode.json");
    const rel = existsSync(rootCfg) ? "opencode.json" : ".opencode/opencode.json";
    const target = join(cwd, rel);
    mergeJsonFile(target, (obj) => {
      if (!obj.mcp || typeof obj.mcp !== "object") obj.mcp = {};
      if (!obj.mcp.servers || typeof obj.mcp.servers !== "object") obj.mcp.servers = {};
      if (!obj.mcp.servers["dev-memo"]) {
        obj.mcp.servers["dev-memo"] = MCP_ENTRY;
      }
    });
    registered.push(rel);
  }

  return registered;
}
