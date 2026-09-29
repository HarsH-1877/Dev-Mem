import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';

// Helper to invoke hook
function invokeHook(adapter, cwd, payload) {
  const hookPath = join(process.cwd(), 'dist', 'adapters', adapter, 'hook.js');
  const res = spawnSync(process.execPath, [hookPath], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, DEV_MEM_MOCK_LLM: undefined }
  });
  return res;
}

async function main() {
  const baseDir = process.cwd();
  // Ensure the build is up to date
  spawnSync('npm', ['run', 'build'], { cwd: baseDir, stdio: 'inherit' });

  const dir = mkdtempSync(join(tmpdir(), 'dev-mem-hook-'));
  mkdirSync(join(dir, '.dev-mem'));

  // Copy config.yml
  copyFileSync(join(baseDir, '.dev-mem', 'config.yml'), join(dir, '.dev-mem', 'config.yml'));

  // 1. Initialize real Git repo
  spawnSync('git', ['init'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'test');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });

  console.log("=== RUNNING SESSION 1 (CAPTURE & EXTRACT) VIA HOOKS ===");

  // Session 1: Start
  const start1 = invokeHook('claude-code', dir, {
    hook_event_name: 'SessionStart',
    session_id: 'sess-1',
    cwd: dir
  });

  // Session 1: Tool Call (The failed approach)
  invokeHook('claude-code', dir, {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-1',
    cwd: dir,
    tool_name: 'Bash',
    tool_input: { command: 'node try-localstorage-approach.js' },
    tool_response: { exit_code: 1, stdout: 'SECURITY AUDIT FAILED. Approach: localStorage. Result: FAILED. This approach failed completely because it is vulnerable to XSS. Abandoning this failed approach.' }
  });

  let extRes;
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`Extraction attempt ${attempt}...`);
    extRes = spawnSync(process.execPath, [join(baseDir, 'dist', 'cli', 'index.js'), 'extract', 'sess-1'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, DEV_MEM_MOCK_LLM: undefined }
    });
    if (!extRes.stderr || !extRes.stderr.includes('503')) break;
    console.log('Got 503, retrying in 3 seconds...');
    spawnSync('node', ['-e', 'setTimeout(()=>{}, 3000)']);
  }
  
  if (extRes.stderr) console.error("Extraction CLI err:", extRes.stderr);

  const { pathToFileURL } = await import('node:url');
  const graphPath = pathToFileURL(join(baseDir, 'dist', 'core', 'graph', 'index.js')).href;
  const { GraphStore } = await import(graphPath);
  const store = new GraphStore({ projectRoot: dir });
  const nodes = store.queryAllNodes();
  store.close();
  
  console.log("\n=== EXTRACTED NODE VERBATIM ===");
  console.log(JSON.stringify(nodes, null, 2));

  console.log("\n=== RUNNING SESSION 2 (TRUE POSITIVE 100% OVERLAP) VIA HOOKS ===");
  const postTool2 = invokeHook('claude-code', dir, {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-2',
    cwd: dir,
    tool_name: 'Write',
    tool_input: { file_path: 'try-localstorage-approach.js' },
    tool_response: {}
  });
  console.log("\n--- HOOK STDOUT (SHOULD FIRE WARNING) ---");
  console.log(postTool2.stdout || "(NO STDOUT)");

  console.log("\n=== RUNNING SESSION 3 (UNRELATED FILE) VIA HOOKS ===");
  const postTool3 = invokeHook('claude-code', dir, {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-3',
    cwd: dir,
    tool_name: 'Write',
    tool_input: { file_path: 'src/components/hero.css' },
    tool_response: {}
  });
  console.log("\n--- HOOK STDOUT (SHOULD NOT FIRE WARNING) ---");
  console.log(postTool3.stdout || "(NO STDOUT)");

  console.log("\n=== RUNNING SESSION 4 (HARDER CASE: CONCEPTUALLY RELATED BUT DIFFERENT FILE) VIA HOOKS ===");
  const postTool4 = invokeHook('claude-code', dir, {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-4',
    cwd: dir,
    tool_name: 'Write',
    tool_input: { file_path: 'src/session-storage.js' },
    tool_response: {}
  });
  console.log("\n--- HOOK STDOUT (WOULD HOPE IT FIRES, BUT PROBABLY WON'T) ---");
  console.log(postTool4.stdout || "(NO STDOUT)");
}

main().catch(console.error);
