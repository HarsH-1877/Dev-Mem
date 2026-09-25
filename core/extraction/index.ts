import { EventLog } from "../capture/log.js";
import { collectGitSnapshot } from "../capture/git.js";
import { GraphStore } from "../graph/index.js";
import type { CaptureEvent, FileTouchEvent, GitSnapshotEvent, ToolCallEvent } from "../capture/events.js";
import type { CreateNodeInput, KnowledgeNode, NodeType } from "../graph/types.js";
import { NODE_TYPES } from "../graph/types.js";
import { checkContradictions, checkStaleness } from "../consistency/index.js";
import { resolveProviderForProject } from "../llm/index.js";

export interface ExtractionOptions {
  projectRoot: string;
  sessionId: string;
  apiKey?: string;
  mockLlm?: boolean;
  customLlmResponse?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
}

export interface ExtractionResult {
  success: boolean;
  nodes: KnowledgeNode[];
  error?: string;
}

/**
 * Normalizes a raw string type into one of the 6 canonical §5.1 NodeTypes.
 */
function normalizeNodeType(rawType: string): NodeType | null {
  if (typeof rawType !== "string") return null;
  const cleaned = rawType.trim().toLowerCase().replace(/[-_ ]/g, "");
  for (const t of NODE_TYPES) {
    if (t.toLowerCase() === cleaned) {
      return t;
    }
  }
  return null;
}

/**
 * Batched LLM extraction (spec §7.2).
 * Reads deterministic events from .dev-mem/events.jsonl for the session,
 * makes a single batched LLM call, and inserts proposed typed nodes into GraphStore.
 *
 * New nodes start in lifecycle state 'observed' (§5.3).
 * Extraction failures log and skip gracefully — never throws to caller.
 */
export async function runExtraction(options: ExtractionOptions): Promise<ExtractionResult> {
  const { projectRoot, sessionId, apiKey, mockLlm, customLlmResponse, model } = options;

  try {
    // 1. Read events for this session from .dev-mem/events.jsonl
    const eventLog = new EventLog({ persistPath: `${projectRoot}/.dev-mem/events.jsonl` });
    const allEvents = eventLog.getEvents();
    const sessionEvents = allEvents.filter((e) => e.session_id === sessionId);

    if (sessionEvents.length === 0) {
      console.warn(`[dev-mem] No events found in log for session: ${sessionId}`);
      return { success: false, nodes: [], error: `No events found for session ${sessionId}` };
    }

    // 2. Discover context from events (commit, agent, touched files)
    let agent = "claude-code";
    let headCommit: string | null = null;
    const touchedFilesSet = new Set<string>();

    for (const event of sessionEvents) {
      if (event.agent) {
        agent = event.agent;
      }
      if (event.type === "git_snapshot") {
        const snap = event as GitSnapshotEvent;
        if (snap.head_commit) headCommit = snap.head_commit;
        if (Array.isArray(snap.status)) {
          for (const s of snap.status) {
            if (s.path) touchedFilesSet.add(s.path);
          }
        }
      } else if (event.type === "file_touch") {
        const touch = event as FileTouchEvent;
        if (touch.path) touchedFilesSet.add(touch.path);
      }
    }

    // Fallback to git repo HEAD commit if snapshot lacked it
    if (!headCommit) {
      try {
        const gitSnap = collectGitSnapshot(projectRoot);
        headCommit = gitSnap.head_commit;
      } catch {
        // Git lookup fallback failed, keep null
      }
    }

    // Fallback to allEvents for commit
    if (!headCommit) {
      const priorSnaps = allEvents.filter((e) => e.type === "git_snapshot") as GitSnapshotEvent[];
      const lastSnap = priorSnaps[priorSnaps.length - 1];
      if (lastSnap?.head_commit) {
        headCommit = lastSnap.head_commit;
      }
    }

    const fallbackCommit = headCommit || "0000000000000000000000000000000000000000";
    const fallbackFiles = touchedFilesSet.size > 0 ? Array.from(touchedFilesSet) : ["README.md"];

    // 2b. Fetch existing active nodes for contradiction detection
    let existingContextStr = "";
    try {
      const store = new GraphStore({ projectRoot, ephemeral: mockLlm || process.env.DEV_MEM_MOCK_LLM === "1" });
      const allNodes = store.queryAllNodes();
      store.close();

      const candidateNodes = allNodes.filter(n =>
        (n.type === "Decision" || n.type === "Constraint" || n.type === "Convention") &&
        n.lifecycle_state !== "stale" &&
        n.lifecycle_state !== "superseded"
      );

      if (candidateNodes.length > 0) {
        existingContextStr = "\nExisting Active Knowledge in Graph:\n" + candidateNodes.map(n =>
          `[ID: ${n.id}] [${n.type}] ${n.title}`
        ).join("\n") + "\n";
      }
    } catch (err) {
      // Ignore
    }

    // 3. Format prompt for single batched extraction pass
    const prompt = `You are an automated software architecture and memory extraction engine for coding agents.
Analyze the following chronological development session events and extract key durable knowledge.

Session ID: ${sessionId}
Agent: ${agent}
Repository commit: ${fallbackCommit}
${existingContextStr}
Extract nodes strictly belonging to these types (§5.1):
- "Decision": Architectural or technical decisions made and why
- "FailedApproach": Approaches or solutions attempted that did not work, including reasons/errors
- "Constraint": Non-negotiable technical, environment, or system constraints discovered
- "Discovery": Surprising codebase behavior, root causes, or architectural findings
- "Convention": Project-specific patterns, commands, or conventions established
- "OpenIssue": Unresolved problems, regressions, or follow-ups remaining

If any extracted node directly contradicts an existing active knowledge node listed above, include a contradicts_edges entry.

Output strictly a single valid JSON object with the following schema:
{
  "nodes": [
    {
      "type": "Decision" | "FailedApproach" | "Constraint" | "Discovery" | "Convention" | "OpenIssue",
      "title": "Concise summary statement",
      "content": "Detailed technical explanation and context",
      "files": ["relative/path/to/file1", ...],
      "confidence": 0.0 to 1.0,
      "diff_ref": "optional commit or diff reference",
      "test_ref": "optional test command or path"
    }
  ],
  "contradicts_edges": [
    {
      "node_title": "Exact title of the newly extracted node from above",
      "existing_node_id": "ID of the existing node it contradicts",
      "reason": "Short explanation"
    }
  ]
}

Session Log:
${sessionEvents.map((e) => JSON.stringify(e)).join("\n")}
`;

    // 4. LLM Call
    let responseText = "";

    if (customLlmResponse !== undefined) {
      responseText = customLlmResponse;
    } else if (mockLlm || process.env.DEV_MEM_MOCK_LLM === "1") {
      // Deterministic mock generation based on session events for reliable tests
      const hasFailedTool = sessionEvents.some(
        (e) => e.type === "tool_call" && (e as ToolCallEvent).exit_code !== 0,
      );
      const filesArr = Array.from(touchedFilesSet);
      const primaryFile = filesArr[0] || "core/graph/index.ts";

      const mockNodes: any[] = [
        {
          type: "Decision",
          title: "Use better-sqlite3 for graph store driver",
          content: "Switched the graph store SQLite driver to better-sqlite3 for broader Node.js version compatibility while preserving the public API.",
          files: [primaryFile],
          confidence: 0.95,
        },
      ];

      if (hasFailedTool) {
        mockNodes.push({
          type: "FailedApproach",
          title: "Shell execution syntax incompatibility",
          content: "Tool command failed with non-zero exit code during execution in the shell.",
          files: filesArr.length > 0 ? filesArr : [primaryFile],
          confidence: 0.88,
        });
      } else {
        mockNodes.push({
          type: "Convention",
          title: "Record session lifecycle boundaries and tool executions",
          content: "Development sessions deterministically capture tool invocations and working tree snapshots before session completion.",
          files: filesArr.length > 0 ? filesArr : [primaryFile],
          confidence: 0.92,
        });
      }

      responseText = JSON.stringify({ nodes: mockNodes });
    } else {
      const llm = resolveProviderForProject(projectRoot, {
        apiKey,
        provider: options.provider,
        model,
        baseUrl: options.baseUrl,
      });
      if (!llm) {
        console.warn("[dev-mem] No LLM provider available. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or DEV_MEM_LLM_BASE_URL. Skipping extraction.");
        return { success: false, nodes: [], error: "No LLM provider available — set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or DEV_MEM_LLM_BASE_URL" };
      }

      try {
        responseText = await llm.complete(
          "You extract structured development knowledge nodes from session event logs. Return JSON only.",
          prompt,
          4096,
        );
      } catch (llmErr: any) {
        const msg = `LLM call failed (${llm.name}): ${llmErr.message}`;
        console.error(`[dev-mem] ${msg}`);
        return { success: false, nodes: [], error: msg };
      }
    }

    // 5. Parse JSON output
    let parsed: any = null;
    try {
      // Strip markdown code fences if model enclosed JSON in ```json ... ```
      let jsonStr = responseText.trim();
      const codeFenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeFenceMatch) {
        jsonStr = codeFenceMatch[1].trim();
      } else {
        const start = jsonStr.indexOf("{");
        const end = jsonStr.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
          jsonStr = jsonStr.substring(start, end + 1);
        }
      }
      parsed = JSON.parse(jsonStr);
    } catch (parseErr: any) {
      const msg = `Failed to parse LLM JSON output: ${parseErr.message}`;
      console.error(`[dev-mem] ${msg}`);
      return { success: false, nodes: [], error: msg };
    }

    if (!parsed || !Array.isArray(parsed.nodes)) {
      const msg = "LLM output missing 'nodes' array";
      console.error(`[dev-mem] ${msg}`);
      return { success: false, nodes: [], error: msg };
    }

    // 6. Insert proposed nodes into GraphStore
    const store = new GraphStore({ projectRoot });
    const insertedNodes: KnowledgeNode[] = [];
    const timestamp = new Date().toISOString();

    for (const rawNode of parsed.nodes) {
      const nodeType = normalizeNodeType(rawNode.type);
      if (!nodeType) {
        console.warn(`[dev-mem] Skipping node with invalid type: ${rawNode.type}`);
        continue;
      }

      const title = typeof rawNode.title === "string" ? rawNode.title.trim() : "";
      if (!title) {
        console.warn("[dev-mem] Skipping node with empty title");
        continue;
      }

      const content = typeof rawNode.content === "string" ? rawNode.content : "";

      // Ensure files array has at least one valid path per §5.4
      let files = Array.isArray(rawNode.files)
        ? rawNode.files.filter((f: any) => typeof f === "string" && f.trim() !== "")
        : [];
      if (files.length === 0) {
        files = [...fallbackFiles];
      }

      // Confidence clamped to [0.0, 1.0] per §5.4
      let confidence = 0.8;
      if (typeof rawNode.confidence === "number" && !Number.isNaN(rawNode.confidence)) {
        confidence = Math.max(0.0, Math.min(1.0, rawNode.confidence));
      }

      const input: CreateNodeInput = {
        type: nodeType,
        title,
        content,
        lifecycle_state: "observed", // §5.3: New nodes start in 'observed'
        evidence: {
          commit: fallbackCommit,
          files,
          session_id: sessionId,
          agent,
          timestamp,
          confidence,
          symbols: [], // Per §10 non-goal, symbols remains empty array in V1
        },
      };

      if (typeof rawNode.diff_ref === "string" && rawNode.diff_ref.trim() !== "") {
        input.evidence.diff_ref = rawNode.diff_ref.trim();
      }
      if (typeof rawNode.test_ref === "string" && rawNode.test_ref.trim() !== "") {
        input.evidence.test_ref = rawNode.test_ref.trim();
      }

      try {
        const created = store.createNode(input);
        insertedNodes.push(created);
      } catch (insertErr: any) {
        console.error(`[dev-mem] Failed to insert node "${title}": ${insertErr.message}`);
      }
    }

    store.close();

    // §8.2 Consistency checks run after all nodes are inserted (store closed and
    // re-opened inside each check to avoid locking issues).
    for (const createdNode of insertedNodes) {
      try {
        await checkContradictions(createdNode, projectRoot);
      } catch (cErr: any) {
        console.error(`[dev-mem] Contradiction heuristic check failed for "${createdNode.title}": ${cErr.message}`);
      }
    }

    // Process LLM proposed contradictions from batched call
    if (Array.isArray(parsed.contradicts_edges) && parsed.contradicts_edges.length > 0) {
      try {
        const edgeStore = new GraphStore({ projectRoot, ephemeral: mockLlm || process.env.DEV_MEM_MOCK_LLM === "1" });
        for (const edge of parsed.contradicts_edges) {
          const srcNode = insertedNodes.find(n => n.title === edge.node_title);
          if (srcNode && edge.existing_node_id) {
            try {
              edgeStore.createEdge({
                from_id: srcNode.id,
                to_id: edge.existing_node_id,
                type: "contradicts"
              });
              console.warn(`[dev-mem] LLM Contradiction detected: "${srcNode.title}" ↔ [ID: ${edge.existing_node_id}]`);
            } catch (e) {
               // ignore duplicate edges or bad IDs
            }
          }
        }
        edgeStore.close();
      } catch (err) {
        // Ignore
      }
    }

    // Staleness: run once per extraction on existing graph state, excluding nodes just inserted
    try {
      const insertedIds = insertedNodes.map((n) => n.id);
      checkStaleness(projectRoot, undefined, insertedIds);
    } catch (sErr: any) {
      console.error(`[dev-mem] Staleness check failed: ${sErr.message}`);
    }

    return { success: true, nodes: insertedNodes };
  } catch (unexpectedErr: any) {
    // Top-level error safety: extraction must never crash the caller (SessionEnd hook)
    const msg = `Unexpected error during extraction: ${unexpectedErr.message}`;
    console.error(`[dev-mem] ${msg}`);
    return { success: false, nodes: [], error: msg };
  }
}
