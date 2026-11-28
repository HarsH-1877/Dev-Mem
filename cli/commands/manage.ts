import { sanitizeText } from "../../core/capture/sanitize.js";
import { GraphStore } from "../../core/graph/index.js";
import { NODE_TYPES, type KnowledgeNode, type NodeType } from "../../core/graph/types.js";
import { isLifecycleState, type LifecycleState } from "../../core/lifecycle/index.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function resolveWithStore(
  store: GraphStore,
  idOrPrefix: string,
): { node?: KnowledgeNode; error?: CommandResult } {
  try {
    const node = store.resolveNode(idOrPrefix);
    if (!node) {
      return {
        error: {
          exitCode: 1,
          stdout: "",
          stderr: `Node not found: ${idOrPrefix}\n`,
        },
      };
    }
    return { node };
  } catch (error) {
    return {
      error: {
        exitCode: 1,
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      },
    };
  }
}

function formatNodeLine(node: KnowledgeNode): string {
  const shortId = node.id.slice(0, 8);
  const grounded = node.evidence.grounded === false ? " [ungrounded]" : "";
  return `[${shortId}] (${node.type} | ${node.lifecycle_state}${grounded}) ${node.title}`;
}

export function runList(cwd: string, args: string[]): CommandResult {
  const stateFilter = parseFlagValue(args, "--state");
  if (stateFilter !== undefined && !isLifecycleState(stateFilter)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Invalid lifecycle state: ${stateFilter}\n`,
    };
  }

  const typeFilter = parseFlagValue(args, "--type");
  if (typeFilter !== undefined && !(NODE_TYPES as readonly string[]).includes(typeFilter)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Invalid node type: ${typeFilter}. Valid types: ${NODE_TYPES.join(", ")}\n`,
    };
  }

  const limitRaw = parseFlagValue(args, "--limit");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Invalid --limit value: ${limitRaw}\n`,
      };
    }
    limit = parsed;
  }

  const store = new GraphStore({ projectRoot: cwd });
  try {
    let nodes = store.queryAllNodes();
    if (stateFilter) {
      nodes = nodes.filter((n) => n.lifecycle_state === (stateFilter as LifecycleState));
    }
    if (typeFilter) {
      nodes = nodes.filter((n) => n.type === (typeFilter as NodeType));
    }
    nodes.sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (limit !== undefined) {
      nodes = nodes.slice(0, limit);
    }

    if (nodes.length === 0) {
      return { exitCode: 0, stdout: "No knowledge nodes found.\n", stderr: "" };
    }

    const lines = nodes.map(formatNodeLine);
    lines.push(`\nTotal: ${nodes.length} node(s)`);
    return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  } finally {
    store.close();
  }
}

export function runSearch(cwd: string, args: string[]): CommandResult {
  const stateFilter = parseFlagValue(args, "--state");
  if (stateFilter !== undefined && !isLifecycleState(stateFilter)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Invalid lifecycle state: ${stateFilter}\n`,
    };
  }

  const typeFilter = parseFlagValue(args, "--type");
  if (typeFilter !== undefined && !(NODE_TYPES as readonly string[]).includes(typeFilter)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Invalid node type: ${typeFilter}. Valid types: ${NODE_TYPES.join(", ")}\n`,
    };
  }

  const queryParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--state" || arg === "--type") {
      i++;
      continue;
    }
    queryParts.push(arg);
  }
  const query = queryParts.join(" ").trim();
  if (!query) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: 'Usage: dev-memo search "<query>" [--state <state>] [--type <type>]\n',
    };
  }

  const needle = query.toLowerCase();
  const store = new GraphStore({ projectRoot: cwd });
  try {
    let nodes = store.queryAllNodes();
    if (stateFilter) {
      nodes = nodes.filter((n) => n.lifecycle_state === (stateFilter as LifecycleState));
    }
    if (typeFilter) {
      nodes = nodes.filter((n) => n.type === (typeFilter as NodeType));
    }

    const ftsRank = new Map(store.searchFts(query).map((h) => [h.id, h.score]));
    const matches = nodes.filter((n) => {
      if (ftsRank.has(n.id)) return true;
      const haystack = [
        n.id,
        n.title,
        n.content,
        n.type,
        n.evidence.files.join(" "),
        (n.evidence.symbols ?? []).join(" "),
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    });

    if (matches.length === 0) {
      return { exitCode: 0, stdout: `No nodes matching "${query}".\n`, stderr: "" };
    }

    matches.sort((a, b) => {
      const scoreDiff = (ftsRank.get(b.id) ?? 0) - (ftsRank.get(a.id) ?? 0);
      if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
      return b.created_at.localeCompare(a.created_at);
    });
    const lines = matches.map(formatNodeLine);
    lines.push(`\nMatched: ${matches.length} node(s)`);
    return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  } finally {
    store.close();
  }
}

export function runApprove(cwd: string, args: string[]): CommandResult {
  const idOrPrefix = args[0];
  if (!idOrPrefix) {
    return { exitCode: 1, stdout: "", stderr: "Usage: dev-memo approve <node-id>\n" };
  }

  const store = new GraphStore({ projectRoot: cwd });
  try {
    const { node, error } = resolveWithStore(store, idOrPrefix);
    if (error || !node) return error!;

    if (node.lifecycle_state === "verified") {
      return {
        exitCode: 0,
        stdout: `Node [${node.id.slice(0, 8)}] is already verified: ${node.title}\n`,
        stderr: "",
      };
    }

    store.transitionLifecycleState(node.id, "verified");
    return {
      exitCode: 0,
      stdout: `Approved [${node.id.slice(0, 8)}] -> verified: ${node.title}\n`,
      stderr: "",
    };
  } finally {
    store.close();
  }
}

export function runEdit(cwd: string, args: string[]): CommandResult {
  const idOrPrefix = args[0];
  if (!idOrPrefix) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: 'Usage: dev-memo edit <node-id> [--title "<title>"] [--content "<content>"]\n',
    };
  }

  const nextTitle = parseFlagValue(args, "--title");
  const nextContent = parseFlagValue(args, "--content");
  if (nextTitle === undefined && nextContent === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: 'Provide --title "<title>" and/or --content "<content>" to edit.\n',
    };
  }

  const store = new GraphStore({ projectRoot: cwd });
  try {
    const { node, error } = resolveWithStore(store, idOrPrefix);
    if (error || !node) return error!;

    const updated = store.updateNode(node.id, {
      ...(nextTitle !== undefined ? { title: sanitizeText(nextTitle).trim() } : {}),
      ...(nextContent !== undefined ? { content: sanitizeText(nextContent).trim() } : {}),
    });

    return {
      exitCode: 0,
      stdout: `Updated [${updated.id.slice(0, 8)}]: ${updated.title}\n`,
      stderr: "",
    };
  } finally {
    store.close();
  }
}

export function runForget(cwd: string, args: string[]): CommandResult {
  const idOrPrefix = args[0];
  if (!idOrPrefix) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: 'Usage: dev-memo forget <node-id> [--reason "<reason>"]\n',
    };
  }
  const reason = parseFlagValue(args, "--reason");

  const store = new GraphStore({ projectRoot: cwd });
  try {
    const { node, error } = resolveWithStore(store, idOrPrefix);
    if (error || !node) return error!;

    if (reason) {
      const cleaned = sanitizeText(reason).trim();
      const updatedContent = node.content
        ? `${node.content}\n\n[Forgotten: ${cleaned}]`
        : `[Forgotten: ${cleaned}]`;
      store.updateNode(node.id, { content: updatedContent });
    }

    if (node.lifecycle_state === "superseded") {
      return {
        exitCode: 0,
        stdout: `Node [${node.id.slice(0, 8)}] is already superseded: ${node.title}\n`,
        stderr: "",
      };
    }

    store.transitionLifecycleState(node.id, "superseded");
    return {
      exitCode: 0,
      stdout: `Forgot [${node.id.slice(0, 8)}] -> superseded: ${node.title}\n`,
      stderr: "",
    };
  } finally {
    store.close();
  }
}
