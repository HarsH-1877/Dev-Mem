import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const errors = [];

function fail(message) {
  errors.push(message);
  console.error(`FAIL: ${message}`);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function walkTsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walkTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// 1. Dependency policy (CONTRIBUTING.md: no LLM provider SDKs, approved runtime deps only)
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
const devDeps = Object.keys(pkg.devDependencies ?? {});
const FORBIDDEN_LLM_SDKS = new Set([
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@google/genai",
  "ai",
  "langchain",
  "@langchain/core",
]);
const ALLOWED_RUNTIME_DEPS = new Set(["better-sqlite3"]);

for (const dep of [...runtimeDeps, ...devDeps]) {
  if (FORBIDDEN_LLM_SDKS.has(dep)) {
    fail(`Forbidden LLM provider SDK in package.json: ${dep}`);
  }
}
const unexpectedRuntime = runtimeDeps.filter((dep) => !ALLOWED_RUNTIME_DEPS.has(dep));
if (unexpectedRuntime.length > 0) {
  fail(`Unapproved runtime dependency in package.json: ${unexpectedRuntime.join(", ")}`);
} else {
  pass("Dependency policy verified (no LLM SDKs, only approved runtime dependencies)");
}

// 2. Architectural boundary checks (single LLM call site, provider-neutral core)
const sourceFiles = ["core", "adapters", "cli"].flatMap((d) => walkTsFiles(join(ROOT, d)));
const IMPORT_LLM_RE = /(?:from|import)\s*\(?\s*["'][^"']*\/(?:llm|extraction)(?:\/[^"']*)?["']/;
const IMPORT_ADAPTER_OR_CLI_RE = /(?:from|import)\s*\(?\s*["'][^"']*(?:\/adapters\/|\/cli\/)/;
const FETCH_OR_HTTP_RE = /\bfetch\s*\(|["']node:https?["']/;

for (const file of sourceFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const content = readFileSync(file, "utf8");

  if (!rel.startsWith("core/llm/") && FETCH_OR_HTTP_RE.test(content)) {
    fail(`Network call or HTTP client outside core/llm/: ${rel}`);
  }

  if (rel.startsWith("core/")) {
    if (IMPORT_ADAPTER_OR_CLI_RE.test(content)) {
      fail(`core/ module must not depend on adapters/ or cli/: ${rel}`);
    }
    const isExtractionOrLlm = rel.startsWith("core/extraction/") || rel.startsWith("core/llm/") || rel === "core/index.ts";
    if (!isExtractionOrLlm && IMPORT_LLM_RE.test(content)) {
      fail(`core/ module outside extraction/llm must not import llm/extraction: ${rel}`);
    }
  }
}
if (errors.length === 0) {
  pass("Architectural boundaries verified (single LLM site, provider-neutral core)");
}

// 3. Git hygiene check (no committed build artifacts, local state, or stray empty files)
try {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

  let hygieneOk = true;
  for (const rel of tracked) {
    if (rel.startsWith("dist/") || rel.startsWith(".dev-mem/") || rel.endsWith(".tgz")) {
      fail(`Generated/local artifact tracked in git: ${rel}`);
      hygieneOk = false;
    }
    if (!rel.endsWith(".gitkeep") && !rel.startsWith("eval/sample-repo/")) {
      const full = join(ROOT, rel);
      if (existsSync(full) && statSync(full).size === 0) {
        fail(`Empty tracked file (stray artifact?): ${rel}`);
        hygieneOk = false;
      }
    }
  }
  if (hygieneOk) {
    pass("Git tracked-file hygiene verified");
  }
} catch (err) {
  fail(`Git hygiene check failed: ${err.message}`);
}

// 4. Built CLI smoke test + npm pack check
const cliPath = join(ROOT, "dist", "cli", "index.js");
if (!existsSync(cliPath)) {
  fail("dist/cli/index.js not found — run `npm run build` first");
} else {
  for (const flag of ["--version", "--help"]) {
    const res = spawnSync(process.execPath, [cliPath, flag], { encoding: "utf8", timeout: 10_000 });
    if (res.status !== 0 || !res.stdout.trim()) {
      fail(`CLI ${flag} failed (status=${res.status}): ${res.stderr}`);
    }
  }

  const tempDir = mkdtempSync(join(tmpdir(), "dev-mem-ci-smoke-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ci@dev-mem.test"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "CI"], { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "README.md"), "# Smoke\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tempDir, stdio: "ignore" });

    for (const dir of [".claude", ".codex", ".cursor", ".opencode"]) {
      mkdirSync(join(tempDir, dir), { recursive: true });
    }

    const install = spawnSync(process.execPath, [cliPath, "install"], { cwd: tempDir, encoding: "utf8", timeout: 10_000 });
    if (install.status !== 0) {
      fail(`CLI install smoke test failed: ${install.stderr}`);
    }

    const status = spawnSync(process.execPath, [cliPath, "status"], { cwd: tempDir, encoding: "utf8", timeout: 10_000 });
    if (status.status !== 0) {
      fail(`CLI status smoke test failed: ${status.stderr}`);
    }

    const doctor = spawnSync(process.execPath, [cliPath, "doctor"], { cwd: tempDir, encoding: "utf8", timeout: 10_000 });
    if (!doctor.stdout.includes("Hooks:") || !doctor.stdout.includes("Hooks up to date")) {
      fail(`CLI doctor smoke test did not detect healthy hooks:\n${doctor.stdout}\n${doctor.stderr}`);
    }

    const uninstall = spawnSync(process.execPath, [cliPath, "uninstall"], { cwd: tempDir, encoding: "utf8", timeout: 10_000 });
    if (uninstall.status !== 0) {
      fail(`CLI uninstall smoke test failed: ${uninstall.stderr}`);
    }

    pass("CLI install/status/doctor/uninstall smoke test passed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  const pack = process.platform === "win32"
    ? spawnSync("npm.cmd pack --dry-run", {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 15_000,
        shell: true,
      })
    : spawnSync("npm", ["pack", "--dry-run"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 15_000,
      });
  const packOut = `${pack.stdout}\n${pack.stderr}`;
  if (pack.status !== 0 || !packOut.includes("dist/cli/index.js")) {
    fail(`npm pack --dry-run missing dist/cli/index.js (status=${pack.status}):\n${packOut}`);
  } else {
    pass("npm pack --dry-run verified");
  }
}

if (errors.length > 0) {
  console.error(`\nCI check failed with ${errors.length} error(s).`);
  process.exit(1);
}
console.log("\nAll CI architectural & smoke checks passed.");
