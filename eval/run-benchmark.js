import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE_DIR = process.cwd();
const REPO_DIR = join(BASE_DIR, 'eval', 'sample-repo');
const CLI_PATH = join(BASE_DIR, 'dist', 'cli', 'index.js');
const HOOK_PATH = join(BASE_DIR, 'dist', 'adapters', 'claude-code', 'hook.js');

// Helper to invoke hook natively
function invokeHook(payload) {
  const res = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: REPO_DIR,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, DEV_MEM_MOCK_LLM: undefined }
  });
  return res.stdout || '';
}

// 15 Pairs Definition
const PAIRS = [
  // EXACT PATH PAIRS (1-8)
  { type: 'exact', id: 1, file: 'src/auth.js', failIdea: 'localStorage', trap: 'token refresh', regex: /localStorage/ },
  { type: 'exact', id: 2, file: 'src/db.js', failIdea: 'sqlite3', trap: 'connection pool', regex: /sqlite3/ },
  { type: 'exact', id: 3, file: 'src/config.js', failIdea: 'hardcoded secret', trap: 'add api key', regex: /secret_123/ },
  { type: 'exact', id: 4, file: 'src/math.js', failIdea: 'eval()', trap: 'calculator feature', regex: /eval\(/ },
  { type: 'exact', id: 5, file: 'src/parser.js', failIdea: 'readFileSync', trap: 'parse large CSV', regex: /readFileSync/ },
  { type: 'exact', id: 6, file: 'src/form.js', failIdea: 'missing CSRF token', trap: 'add new form', regex: /<form>/ },
  { type: 'exact', id: 7, file: 'src/component.js', failIdea: 'inline CSS', trap: 'add styling', regex: /style=/ },
  { type: 'exact', id: 8, file: 'src/fetcher.js', failIdea: 'XMLHttpRequest', trap: 'fetch external data', regex: /XMLHttpRequest/ },
  // NEAR MISS PAIRS (9-15)
  { type: 'near', id: 9, fileA: 'src/auth.js', fileB: 'src/cart.js', failIdea: 'localStorage', trap: 'cart persistence', regex: /localStorage/ },
  { type: 'near', id: 10, fileA: 'src/db.js', fileB: 'db/migrations/001.js', failIdea: 'sqlite3', trap: 'db migration', regex: /sqlite3/ },
  { type: 'near', id: 11, fileA: 'src/config.js', fileB: 'src/external/api.js', failIdea: 'hardcoded secret', trap: 'api connection', regex: /secret_123/ },
  { type: 'near', id: 12, fileA: 'src/parser.js', fileB: 'src/xml-parser.js', failIdea: 'readFileSync', trap: 'parse XML', regex: /readFileSync/ },
  { type: 'near', id: 13, fileA: 'src/form.js', fileB: 'src/checkout.js', failIdea: 'missing CSRF token', trap: 'checkout form', regex: /<form>/ },
  { type: 'near', id: 14, fileA: 'src/component.js', fileB: 'src/modal.js', failIdea: 'inline CSS', trap: 'modal styling', regex: /style=/ },
  { type: 'near', id: 15, fileA: 'src/fetcher.js', fileB: 'src/api-client.js', failIdea: 'XMLHttpRequest', trap: 'api client fetch', regex: /XMLHttpRequest/ },
];

async function callGemini(prompt, injection) {
  const config = readFileSync(join(BASE_DIR, '.dev-mem', 'config.yml'), 'utf8');
  const apiKeyMatch = config.match(/llm_api_key:\s*"([^"]+)"/);
  if (!apiKeyMatch) throw new Error("No Gemini API key found");
  
  const body = {
    contents: [{ parts: [{ text: `${injection ? 'Context:\n' + injection + '\n\n' : ''}Task: ${prompt}\nOutput only the raw code snippet implementing this.` }] }],
    generationConfig: { maxOutputTokens: 500 }
  };
  
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKeyMatch[1]}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  if (!res.ok) {
    const err = await res.text();
    if (err.includes('503')) return "RETRY";
    console.error("LLM ERR", err);
    return "";
  }
  
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function retryGemini(prompt, injection) {
  for (let i = 0; i < 5; i++) {
    const res = await callGemini(prompt, injection);
    if (res !== "RETRY") return res;
    await new Promise(r => setTimeout(r, 2000));
  }
  return "";
}

function wipeState() {
  rmSync(join(REPO_DIR, '.dev-mem'), { recursive: true, force: true });
  spawnSync('git', ['reset', '--hard'], { cwd: REPO_DIR });
  spawnSync('git', ['clean', '-fd'], { cwd: REPO_DIR });
}

async function runIteration(iter, mode) {
  wipeState();
  let hitsExact = 0;
  let hitsNear = 0;

  for (const pair of PAIRS) {
    const fileA = pair.file || pair.fileA;
    const fileB = pair.file || pair.fileB;
    const sidA = `iter${iter}-${mode}-A${pair.id}`;
    const sidB = `iter${iter}-${mode}-B${pair.id}`;
    
    // TASK A
    invokeHook({ hook_event_name: 'SessionStart', session_id: sidA, cwd: REPO_DIR });
    
    // Simulate Failure
    mkdirSync(join(REPO_DIR, dirname(fileA)), { recursive: true });
    writeFileSync(join(REPO_DIR, fileA), `// approach: ${pair.failIdea}`);
    spawnSync('git', ['add', '.'], { cwd: REPO_DIR });
    spawnSync('git', ['commit', '-m', `Task A: ${pair.failIdea}`], { cwd: REPO_DIR });
    
    invokeHook({
      hook_event_name: 'PostToolUse',
      session_id: sidA,
      cwd: REPO_DIR,
      tool_name: 'Bash',
      tool_input: { command: `node test.js` },
      tool_response: { exit_code: 1, stdout: `SECURITY/AUDIT FAILED. Approach: ${pair.failIdea}. This approach failed completely. Abandoning this failed approach.` }
    });
    
    // Extract
    spawnSync(process.execPath, [CLI_PATH, 'extract', sidA], { cwd: REPO_DIR, env: { ...process.env, DEV_MEM_MOCK_LLM: undefined } });
    
    // TASK B
    const startB = invokeHook({ hook_event_name: 'SessionStart', session_id: sidB, cwd: REPO_DIR });
    
    // Parse injection warning if Dev-Mem ON
    let injection = "";
    if (mode === 'ON') {
      try {
        const out = JSON.parse(startB);
        if (out.hookSpecificOutput?.additionalContext) {
          injection = out.hookSpecificOutput.additionalContext;
        }
      } catch (e) {}
    }
    
    // Ask LLM to do task B
    const prompt = `Implement ${pair.trap} in ${fileB}. If you aren't sure how, default to using ${pair.failIdea}.`;
    const code = await retryGemini(prompt, injection);
    mkdirSync(join(REPO_DIR, dirname(fileB)), { recursive: true });
    writeFileSync(join(REPO_DIR, fileB), code);
    
    // Evaluate if LLM avoided the trap
    const usedBadIdea = pair.regex.test(code);
    const avoided = !usedBadIdea;
    
    if (pair.type === 'exact' && avoided) hitsExact++;
    if (pair.type === 'near' && avoided) hitsNear++;
  }
  
  return { hitsExact, hitsNear };
}

async function main() {
  console.log("Starting Benchmark...");
  const results = {
    OFF: [],
    ON: []
  };

  for (let i = 1; i <= 3; i++) {
    console.log(`\nITERATION ${i} (OFF)`);
    results.OFF.push(await runIteration(i, 'OFF'));
    
    console.log(`ITERATION ${i} (ON)`);
    results.ON.push(await runIteration(i, 'ON'));
  }
  
  console.log("\n=== RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
