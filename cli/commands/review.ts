import { createInterface } from "node:readline";
import { sanitizeText } from "../../core/capture/sanitize.js";
import { GraphStore } from "../../core/graph/index.js";
import type { KnowledgeNode } from "../../core/graph/types.js";
import { isLifecycleState, type LifecycleState } from "../../core/lifecycle/index.js";
import type { CommandResult } from "./manage.js";

export interface ReviewIoOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

function createLineReader(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
) {
  const rl = createInterface({ input, output, terminal: false });
  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    if (waiters.length > 0) {
      waiters.shift()!(line);
    } else {
      queue.push(line);
    }
  });

  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()!(null);
    }
  });

  async function ask(prompt: string): Promise<string | null> {
    output.write(prompt);
    if (queue.length > 0) {
      return queue.shift()!;
    }
    if (closed) {
      return null;
    }
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  return { ask, close: () => rl.close() };
}

function formatReviewCard(node: KnowledgeNode, index: number, total: number): string {
  const shortId = node.id.slice(0, 8);
  const files = node.evidence.files.length > 0 ? node.evidence.files.join(", ") : "(none)";
  const groundedLabel = node.evidence.grounded === false ? " [ungrounded]" : "";
  return [
    "",
    `[${index + 1}/${total}] [${shortId}] (${node.type} | ${node.lifecycle_state}${groundedLabel})`,
    `Title:    ${node.title}`,
    `Content:  ${node.content}`,
    `Files:    ${files}`,
    ...(node.evidence.commit ? [`Commit:   ${node.evidence.commit}`] : []),
  ].join("\n") + "\n";
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export async function runReview(
  cwd: string,
  args: string[],
  io: ReviewIoOptions = {},
): Promise<CommandResult> {
  const includeAll = args.includes("--all");
  const stateFlag = parseFlagValue(args, "--state");
  if (stateFlag !== undefined && !isLifecycleState(stateFlag)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Invalid lifecycle state: ${stateFlag}\n`,
    };
  }

  const targetState: LifecycleState = (stateFlag as LifecycleState | undefined) ?? "observed";

  // Non-interactive fallback when running in CI/pipes without injected test streams
  if (!io.input && !process.stdin.isTTY) {
    return {
      exitCode: 0,
      stdout:
        "Non-interactive terminal detected.\n" +
        "Review pending memories manually with:\n" +
        "  dev-memo list --state observed\n" +
        "  dev-memo approve <id>\n" +
        "  dev-memo edit <id> --title \"...\" --content \"...\"\n" +
        "  dev-memo forget <id>\n",
      stderr: "",
    };
  }

  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;

  const store = new GraphStore({ projectRoot: cwd });
  try {
    let nodes = store.queryAllNodes();
    if (includeAll && !stateFlag) {
      nodes = nodes.filter((n) => n.lifecycle_state === "observed" || n.lifecycle_state === "active");
    } else {
      nodes = nodes.filter((n) => n.lifecycle_state === targetState);
    }

    if (nodes.length === 0) {
      const msg = includeAll
        ? "No observed or active nodes to review.\n"
        : `No pending ${targetState} nodes to review.\n`;
      return { exitCode: 0, stdout: msg, stderr: "" };
    }

    const reader = createLineReader(input, output);
    let approved = 0;
    let edited = 0;
    let skipped = 0;
    let discarded = 0;

    try {
      for (let i = 0; i < nodes.length; i++) {
        let current = nodes[i];
        output.write(formatReviewCard(current, i, nodes.length));

        let doneWithNode = false;
        let shouldQuit = false;

        while (!doneWithNode) {
          const raw = await reader.ask(
            "Action [a]pprove / [e]dit / [s]kip / [d]iscard / [q]uit: ",
          );
          if (raw === null) {
            shouldQuit = true;
            break;
          }

          const choice = raw.trim().toLowerCase();
          if (choice === "a" || choice === "approve") {
            if (current.lifecycle_state !== "verified") {
              store.transitionLifecycleState(current.id, "verified");
            }
            approved++;
            doneWithNode = true;
          } else if (choice === "d" || choice === "discard") {
            if (current.lifecycle_state !== "superseded") {
              store.transitionLifecycleState(current.id, "superseded");
            }
            discarded++;
            doneWithNode = true;
          } else if (choice === "s" || choice === "skip" || choice === "") {
            skipped++;
            doneWithNode = true;
          } else if (choice === "q" || choice === "quit") {
            shouldQuit = true;
            doneWithNode = true;
          } else if (choice === "e" || choice === "edit") {
            const newTitle = await reader.ask("New title (enter to keep): ");
            if (newTitle === null) {
              shouldQuit = true;
              break;
            }
            const newContent = await reader.ask("New content (enter to keep): ");
            if (newContent === null) {
              shouldQuit = true;
              break;
            }
            const cleanTitle = newTitle.trim() ? sanitizeText(newTitle).trim() : current.title;
            const cleanContent = newContent.trim()
              ? sanitizeText(newContent).trim()
              : current.content;
            current = store.updateNode(current.id, {
              title: cleanTitle,
              content: cleanContent,
            });
            edited++;
            output.write(`Updated -> "${current.title}"\n`);
          } else {
            output.write("Unknown action. Enter a, e, s, d, or q.\n");
          }
        }

        if (shouldQuit) break;
      }
    } finally {
      reader.close();
    }

    const summary = `Review complete (approved: ${approved}, edited: ${edited}, skipped: ${skipped}, discarded: ${discarded}).\n`;
    return { exitCode: 0, stdout: summary, stderr: "" };
  } finally {
    store.close();
  }
}
