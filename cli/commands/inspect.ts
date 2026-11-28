import { GraphStore } from "../../core/graph/index.js";
import { generateInjectionString, retrieveContext } from "../../core/retrieval/index.js";

export function runQuery(cwd: string, text: string): { exitCode: number; stdout: string; stderr: string } {
  if (!text) {
    return { exitCode: 1, stdout: "", stderr: "Usage: dev-memo query \"<task description>\"\n" };
  }
  const nodes = retrieveContext({ projectRoot: cwd, currentTask: text });
  const out = generateInjectionString(nodes);
  if (!out) {
    return { exitCode: 0, stdout: "No relevant context found in graph.\n", stderr: "" };
  }
  return { exitCode: 0, stdout: out + "\n", stderr: "" };
}

export function runInspect(cwd: string, nodeId: string): { exitCode: number; stdout: string; stderr: string } {
  if (!nodeId) {
    return { exitCode: 1, stdout: "", stderr: "Usage: dev-memo inspect <node-id>\n" };
  }
  const store = new GraphStore({ projectRoot: cwd });
  try {
    let node;
    try {
      node = store.resolveNode(nodeId);
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    if (!node) {
      return { exitCode: 1, stdout: "", stderr: `Node not found: ${nodeId}\n` };
    }
    const history = store.listLifecycleHistory(node.id);
    const edges = store.listEdges(node.id);

    const lines: string[] = [];
    lines.push(`id:              ${node.id}`);
    lines.push(`type:            ${node.type}`);
    lines.push(`lifecycle_state: ${node.lifecycle_state}`);
    lines.push(`title:           ${node.title}`);
    lines.push(`content:         ${node.content || "(empty)"}`);
    lines.push(`created_at:      ${node.created_at}`);
    lines.push(`updated_at:      ${node.updated_at}`);
    lines.push("");
    lines.push("evidence:");
    lines.push(`  commit:     ${node.evidence.commit}`);
    lines.push(`  files:      ${node.evidence.files.join(", ")}`);
    if (node.evidence.diff_ref) lines.push(`  diff_ref:   ${node.evidence.diff_ref}`);
    if (node.evidence.test_ref) lines.push(`  test_ref:   ${node.evidence.test_ref}`);
    if (node.evidence.symbols?.length) lines.push(`  symbols:    ${node.evidence.symbols.join(", ")}`);
    lines.push(`  session_id: ${node.evidence.session_id}`);
    lines.push(`  agent:      ${node.evidence.agent}`);
    lines.push(`  timestamp:  ${node.evidence.timestamp}`);
    lines.push(`  confidence: ${node.evidence.confidence.toFixed(2)}`);

    lines.push("");
    lines.push("lifecycle_history:");
    for (const h of history) {
      const from = h.from_state ?? "(created)";
      lines.push(`  ${h.timestamp}  ${from} → ${h.to_state}`);
    }

    if (edges.length > 0) {
      lines.push("");
      lines.push("edges:");
      for (const e of edges) {
        const dir = e.from_id === node.id ? "→" : "←";
        const other = e.from_id === node.id ? e.to_id : e.from_id;
        lines.push(`  [${e.type}] ${dir} ${other}`);
      }
    }

    return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  } finally {
    store.close();
  }
}
