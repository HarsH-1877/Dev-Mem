import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "./graph/index.js";
import { EventLog } from "./capture/log.js";
import { runExtraction } from "./extraction/index.js";
import { retrieveContext, adaptiveBudget } from "./retrieval/index.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "dev-mem-adv-"));
}

describe("Adversarial & Edge Cases (Core)", () => {
  it("Empty .dev-mem/ (first-ever run, no prior graph) initializes safely", () => {
    const cwd = tempProject();
    try {
      const log = new EventLog({ persistPath: join(cwd, ".dev-mem", "events.jsonl") });
      log.append({ type: "session_start", session_id: "s1", timestamp: Date.now(), adapter: "test", payload: {} } as any);
      
      const store = new GraphStore({ projectRoot: cwd });
      const nodes = store.queryByType("Discovery");
      expect(nodes.length).toBe(0);
      store.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("graph.sqlite present but zero-byte / truncated mid-write recovers or fails safely", () => {
    const cwd = tempProject();
    try {
      mkdirSync(join(cwd, ".dev-mem"));
      writeFileSync(join(cwd, ".dev-mem", "graph.sqlite"), ""); // 0 bytes

      let store: GraphStore | null = null;
      try {
         store = new GraphStore({ projectRoot: cwd });
         const count = store.queryByType("Discovery").length;
         expect(count).toBe(0); 
      } catch (err: any) {
         expect(err.message).toMatch(/database disk image is malformed|file is not a database/);
      } finally {
         if (store) store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("events.jsonl with a mix of valid and malformed JSON lines parses valid ones or throws clear signal", () => {
    const cwd = tempProject();
    try {
      mkdirSync(join(cwd, ".dev-mem"));
      const eventsPath = join(cwd, ".dev-mem", "events.jsonl");
      writeFileSync(eventsPath, 
        '{"type":"session_start","session_id":"s1","timestamp":100}\n' +
        '{malformed_json_here\n' +
        '{"type":"tool_call","session_id":"s1","timestamp":200}\n' +
        'just a random string\n'
      );

      try {
        const log = new EventLog({ persistPath: eventsPath });
        const events = log.getEvents().filter((e: any) => e.session_id === "s1");
        expect(events.length).toBe(2);
      } catch (err: any) {
        expect(err.message).toContain("Corrupt event log");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Extraction LLM call timing out or returning malformed/non-JSON output fails safe", async () => {
    const cwd = tempProject();
    try {
      mkdirSync(join(cwd, ".dev-mem"));
      const store = new GraphStore({ projectRoot: cwd });
      store.close();
      
      const log = new EventLog({ persistPath: join(cwd, ".dev-mem", "events.jsonl") });
      log.append({ type: "session_start", session_id: "s1", timestamp: Date.now(), adapter: "test", payload: {} } as any);

      const result = await runExtraction({
        projectRoot: cwd,
        sessionId: "s1",
        customLlmResponse: "I am not a JSON object { { broken",
        mockLlm: true
      });
      
      expect(result.success).toBe(false);
      expect(result.nodes.length).toBe(0);
      expect(result.error).toBeDefined();
      
      const store2 = new GraphStore({ projectRoot: cwd });
      expect(store2.queryByType("Discovery").length).toBe(0);
      store2.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Very large graph (synthetic: 500+ nodes) — adaptiveBudget clamps and handles scale gracefully", () => {
    const cwd = tempProject();
    try {
      const store = new GraphStore({ projectRoot: cwd });
      for (let i = 0; i < 500; i++) {
        store.createNode({
          type: "Discovery",
          title: "Node " + i,
          content: "Content " + i,
          evidence: { source: "test", commit: "test_commit", files: ["file.ts"], session_id: "s1", agent: "test", timestamp: new Date().toISOString(), confidence: 1.0 },
          files: ["file.ts"]
        });
      }
      
      // budget calculation requires nodeCount
      const budget = adaptiveBudget(500);
      expect(budget).toBe(2000);
      
      const t0 = Date.now();
      const context = retrieveContext({
        projectRoot: cwd,
        currentFiles: ["file.ts"],
        currentTask: "test"
      });
      const t1 = Date.now();
      
      expect(context.length).toBeGreaterThan(0);
      expect(context.length).toBeLessThan(500); 
      expect(t1 - t0).toBeLessThan(1000); 
      
      store.close();
    } finally {
      // Small timeout or retry if sqlite hasn't fully closed
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch (e) {
        setTimeout(() => rmSync(cwd, { recursive: true, force: true }), 100);
      }
    }
  });
});
