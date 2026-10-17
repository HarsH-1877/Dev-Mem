import { createInterface } from "node:readline";
import { GraphStore, NODE_TYPES, type NodeType } from "../graph/index.js";
import { retrieveContext } from "../retrieval/index.js";
import { checkRegressionRisk, formatRegressionWarning } from "../regression/index.js";
import { collectGitSnapshot } from "../capture/git.js";
import { sanitizeText } from "../capture/sanitize.js";

const MCP_TOOLS = [
  {
    name: "dev_mem_query",
    description: "Search project engineering memory (decisions, failed approaches, constraints, conventions, discoveries, open issues) for context relevant to a task or files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Task description or topic to search for" },
        files: { type: "array", items: { type: "string" }, description: "Optional relative file paths being worked on" },
      },
      required: ["query"],
    },
  },
  {
    name: "dev_mem_check_regression",
    description: "Check if the files you are about to modify overlap with any known FailedApproach in project history.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Relative file paths about to be modified" },
      },
      required: ["files"],
    },
  },
  {
    name: "dev_mem_remember",
    description: "Record a durable engineering knowledge node (Decision, FailedApproach, Constraint, Discovery, Convention, OpenIssue) directly into the local graph with zero LLM cost.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...NODE_TYPES], description: "Knowledge node type" },
        title: { type: "string", description: "Concise summary statement" },
        content: { type: "string", description: "Detailed technical explanation and rationale" },
        files: { type: "array", items: { type: "string" }, description: "Relative file paths grounded to this knowledge" },
        symbols: { type: "array", items: { type: "string" }, description: "Optional function/class names" },
      },
      required: ["type", "title", "content", "files"],
    },
  },
  {
    name: "dev_mem_resolve",
    description: "Transition an existing knowledge node (such as a fixed OpenIssue or replaced Decision) to 'superseded' or 'stale'.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "UUID of the node to transition" },
        to_state: { type: "string", enum: ["superseded", "stale", "active", "verified"], description: "Target lifecycle state" },
      },
      required: ["node_id", "to_state"],
    },
  },
];

export async function handleMcpRequest(request: any, projectRoot: string): Promise<any | null> {
  if (!request || typeof request !== "object") return null;
  const { id, method, params } = request;

  // Notifications have no id and expect no response
  if (id === undefined || id === null) return null;

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "dev-memo", version: "0.4.0" },
        },
      };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      if (toolName === "dev_mem_query") {
        const query = typeof args.query === "string" ? args.query : "";
        const files = Array.isArray(args.files) ? args.files.map(String) : undefined;
        const nodes = retrieveContext({ projectRoot, currentTask: query, currentFiles: files, budgetTokens: 1500 });
        const text = nodes.length > 0
          ? nodes.map((n) => `[${n.type}] (id: ${n.id}, state: ${n.lifecycle_state}, score: ${n.score.toFixed(2)})\nTitle: ${n.title}\nDetail: ${n.content}\nFiles: ${n.evidence.files.join(", ")}`).join("\n\n")
          : "No matching knowledge nodes found.";
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
      }

      if (toolName === "dev_mem_check_regression") {
        const files = Array.isArray(args.files) ? args.files.map(String) : [];
        const matches = checkRegressionRisk({ projectRoot, currentFiles: files, confidenceThreshold: 0.5 });
        const text = matches.length > 0 ? formatRegressionWarning(matches) : "No known regression risks for these files.";
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
      }

      if (toolName === "dev_mem_remember") {
        const type = args.type as NodeType;
        const title = sanitizeText(String(args.title ?? "").trim());
        const content = sanitizeText(String(args.content ?? "").trim());
        const files = Array.isArray(args.files) && args.files.length > 0 ? args.files.map(String) : ["README.md"];
        const symbols = Array.isArray(args.symbols) ? args.symbols.map(String) : [];

        let commit = "0000000000000000000000000000000000000000";
        try {
          commit = collectGitSnapshot(projectRoot).head_commit || commit;
        } catch {}

        const store = new GraphStore({ projectRoot });
        try {
          const node = store.createNode({
            type,
            title,
            content,
            lifecycle_state: "active",
            evidence: {
              commit,
              files,
              symbols,
              session_id: "mcp_direct",
              agent: "mcp",
              timestamp: new Date().toISOString(),
              confidence: 0.95,
            },
          });
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `Recorded [${node.type}] (id: ${node.id}): ${node.title}` }] },
          };
        } finally {
          store.close();
        }
      }

      if (toolName === "dev_mem_resolve") {
        const nodeId = String(args.node_id ?? "");
        const toState = args.to_state as any;
        const store = new GraphStore({ projectRoot });
        try {
          const updated = store.transitionLifecycleState(nodeId, toState);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `Transitioned node ${updated.id} ("${updated.title}") to ${updated.lifecycle_state}.` }] },
          };
        } finally {
          store.close();
        }
      }

      return {
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: `Unknown tool: ${toolName}` }] },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id,
      result: { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] },
    };
  }
}

export function startMcpStdioServer(projectRoot: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const req = JSON.parse(trimmed);
        const res = await handleMcpRequest(req, projectRoot);
        if (res) {
          process.stdout.write(JSON.stringify(res) + "\n");
        }
      } catch {
        // Ignore malformed JSON lines on stdin
      }
    });
    rl.on("close", () => resolve());
  });
}
