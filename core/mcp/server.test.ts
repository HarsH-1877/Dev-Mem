import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleMcpRequest } from "./server.js";
import { GraphStore } from "../graph/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Zero-Daemon MCP Server (stdio JSON-RPC)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-mcp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("responds to initialize and tools/list", async () => {
    const initRes = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      dir,
    );
    expect(initRes.result.serverInfo.name).toBe("dev-memo");

    const listRes = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      dir,
    );
    const names = listRes.result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "dev_mem_query",
      "dev_mem_check_regression",
      "dev_mem_remember",
      "dev_mem_resolve",
    ]);
  });

  it("records a node via dev_mem_remember, queries it via dev_mem_query, and resolves it via dev_mem_resolve", async () => {
    const remRes = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "dev_mem_remember",
          arguments: {
            type: "OpenIssue",
            title: "Webhook signature header is case-sensitive",
            content: "Stripe sends lowercase stripe-signature",
            files: ["src/webhooks.ts"],
          },
        },
      },
      dir,
    );
    expect(remRes.result.isError).toBeFalsy();
    const createdText = remRes.result.content[0].text;
    const idMatch = createdText.match(/id:\s*([0-9a-f-]+)/i);
    expect(idMatch).toBeTruthy();
    const nodeId = idMatch![1];

    const queryRes = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "dev_mem_query",
          arguments: { query: "webhook signature" },
        },
      },
      dir,
    );
    expect(queryRes.result.content[0].text).toContain("Webhook signature header is case-sensitive");

    const resolveRes = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "dev_mem_resolve",
          arguments: { node_id: nodeId, to_state: "superseded" },
        },
      },
      dir,
    );
    expect(resolveRes.result.content[0].text).toContain("superseded");

    const store = new GraphStore({ projectRoot: dir });
    expect(store.getNode(nodeId)?.lifecycle_state).toBe("superseded");
    store.close();
  });

  it("handles ping, unknown methods, and notifications appropriately", async () => {
    const pingRes = await handleMcpRequest(
      { jsonrpc: "2.0", id: 6, method: "ping" },
      dir,
    );
    expect(pingRes).toEqual({ jsonrpc: "2.0", id: 6, result: {} });

    // Notification without id should return null
    const notifyRes = await handleMcpRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      dir,
    );
    expect(notifyRes).toBeNull();

    // Unknown method
    const unknownRes = await handleMcpRequest(
      { jsonrpc: "2.0", id: 7, method: "unknown/method" },
      dir,
    );
    expect(unknownRes.error?.code).toBe(-32601);

    // Unknown tool
    const unknownToolRes = await handleMcpRequest(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "non_existent" } },
      dir,
    );
    expect(unknownToolRes.result.isError).toBe(true);
  });

  it("runs dev_mem_check_regression through MCP tools/call", async () => {
    // Record a FailedApproach
    await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "dev_mem_remember",
          arguments: {
            type: "FailedApproach",
            title: "Async local storage in web worker",
            content: "Worker threads don't share ALS context across postMessage",
            files: ["src/worker.ts"],
          },
        },
      },
      dir,
    );

    const checkRes = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "dev_mem_check_regression",
          arguments: { files: ["src/worker.ts"] },
        },
      },
      dir,
    );
    expect(checkRes.result.content[0].text).toContain("Async local storage in web worker");

    const cleanRes = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "dev_mem_check_regression",
          arguments: { files: ["src/other.ts"] },
        },
      },
      dir,
    );
    expect(cleanRes.result.content[0].text).toContain("No known regression risks");
  });

  it("communicates via stdio JSON-RPC when running dev-memo mcp", async () => {
    const { spawn, execFileSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const cliPath = join(process.cwd(), "dist", "cli", "index.js");
    if (!existsSync(cliPath)) {
      execFileSync("npm", ["run", "build"], { stdio: "ignore", shell: true });
    }

    const child = spawn(process.execPath, [cliPath, "mcp"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 100, method: "initialize", params: {} }) + "\n";
    child.stdin.write(initMsg);

    const res = await new Promise<any>((resolve, reject) => {
      let buffer = "";
      child.stdout.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("\n")) {
          try {
            const parsed = JSON.parse(buffer.trim());
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        }
      });
      child.on("error", reject);
    });

    expect(res.id).toBe(100);
    expect(res.result.serverInfo.name).toBe("dev-memo");

    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
  });
});
