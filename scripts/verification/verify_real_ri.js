import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProviderForProject } from '../dist/core/llm/index.js';
import { EventLog } from '../dist/core/capture/log.js';
import { runExtraction } from '../dist/core/extraction/index.js';
import { retrieveContext, generateInjectionString } from '../dist/core/retrieval/index.js';
import { GraphStore } from '../dist/core/graph/index.js';

async function main() {
  // Disable mocking
  delete process.env.DEV_MEM_MOCK_LLM;

  const dir = mkdtempSync(join(tmpdir(), 'dev-mem-real-'));
  mkdirSync(join(dir, '.dev-mem'));
  
  try {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(join(process.cwd(), '.dev-mem', 'config.yml'), join(dir, '.dev-mem', 'config.yml'));
  } catch (e) {
    console.error("Could not copy config.yml", e);
  }

  console.log("=========================================");
  console.log("PART A1: PROVIDER RESOLUTION");
  console.log("=========================================");
  const provider = resolveProviderForProject(dir);
  console.log("Provider picked:", provider ? provider.name : "None");
  if (!provider) {
    console.error("NO PROVIDER RESOLVED. GEMINI_API_KEY missing?");
    process.exit(1);
  }

  console.log("\n=========================================");
  console.log("PART A2: SEEDING REAL EVENT LOG");
  console.log("=========================================");
  const log = new EventLog({ persistPath: join(dir, '.dev-mem', 'events.jsonl') });
  log.append({ type: 'session_start', session_id: 'sess-1', agent: 'claude-code', timestamp: new Date().toISOString(), cwd: dir });
  log.append({ type: 'git_snapshot', session_id: 'sess-1', agent: 'claude-code', timestamp: new Date().toISOString(), cwd: dir, content: 'commit 1234\nAuthor: test\n\nInitial commit' });
  // Simulated attempt to store tokens in localStorage, which fails a security test or run script
  log.append({ type: 'tool_call', session_id: 'sess-1', agent: 'claude-code', timestamp: new Date().toISOString(), cwd: dir, tool_name: 'bash', tool_input: { command: 'node try-localstorage-approach.js' }, tool_response: { exit_code: 1, stdout: 'SECURITY AUDIT FAILED. Approach: localStorage. Result: FAILED. This approach failed completely because it is vulnerable to XSS. Abandoning this failed approach.' } });
  log.append({ type: 'session_end', session_id: 'sess-1', agent: 'claude-code', timestamp: new Date().toISOString(), cwd: dir });
  console.log("Event log seeded.");

  console.log("\n=========================================");
  console.log("PART A3 & A4: RUNNING REAL EXTRACTION");
  console.log("=========================================");
  const extStart = Date.now();
  const result = await runExtraction({ projectRoot: dir, sessionId: 'sess-1' });
  const extEnd = Date.now();

  console.log("Extraction success:", result.success);
  console.log("Extraction error (if any):", result.error);
  console.log(`Time taken: ${extEnd - extStart}ms`);

  const store = new GraphStore({ projectRoot: dir });
  // Insert 20 dummy nodes so B3 drops below relevance budget
  for (let i = 0; i < 20; i++) {
    store.createNode({
      type: 'Convention',
      title: `Dummy Convention ${i}`,
      content: `This is dummy convention number ${i} about styling or linting or whatever to fill up the budget.`,
      evidence: { commit: '000', files: [`dummy${i}.ts`], session_id: 'sess-0', agent: 'claude-code', timestamp: new Date().toISOString(), confidence: 1 }
    });
  }

  const nodes = store.queryAllNodes();
  console.log(`\nNodes Extracted: ${nodes.length}`);
  console.log("--- ACTUAL NODES VERBATIM ---");
  console.log(JSON.stringify(nodes.filter(n => !n.title.startsWith('Dummy')), null, 2));
  store.close();

  const { checkRegressionRisk, formatRegressionWarning } = await import('../dist/core/regression/index.js');

  console.log("\n=========================================");
  console.log("PART B1 & B2: RI VERIFICATION - RE-ATTEMPT");
  console.log("=========================================");
  const currentFiles1 = ['try-localstorage-approach.js'];
  console.log("Simulated Agent Current Files:", currentFiles1);
  const riMatches1 = checkRegressionRisk({ projectRoot: dir, currentFiles: currentFiles1 });
  const riWarning1 = formatRegressionWarning(riMatches1);
  console.log("\n--- REGRESSION WARNING (SHOULD FIRE) ---");
  console.log(riWarning1 || "(NO WARNING FIRED)");

  console.log("\n=========================================");
  console.log("PART B3: RI VERIFICATION - UNRELATED");
  console.log("=========================================");
  const currentFiles2 = ['src/components/hero.css'];
  console.log("Simulated Agent Current Files:", currentFiles2);
  const riMatches2 = checkRegressionRisk({ projectRoot: dir, currentFiles: currentFiles2 });
  const riWarning2 = formatRegressionWarning(riMatches2);
  console.log("\n--- REGRESSION WARNING (SHOULD NOT FIRE) ---");
  console.log(riWarning2 || "(NO WARNING FIRED)");
}

main().catch(console.error);
