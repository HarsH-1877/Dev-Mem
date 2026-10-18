# Design Spec: Terminal Logo Banner Art

- **Status:** Approved
- **Date:** 2026-10-18
- **Topic:** Terminal ASCII Logo Banner for `dev-memo` CLI

---

## 1. Problem Statement
When developers install or first explore `dev-memo`, the CLI currently outputs a plain, unbranded text message or a terse one-line usage string (`Usage: dev-memo <commands>`). A professional, high-density ASCII logo banner adds brand identity and a polished onboarding experience without compromising developer productivity or context token limits.

---

## 2. Requirements & Constraints

### 2.1 Display Triggers
1. **`dev-memo install`**: Displayed at the very top of output upon successful or interactive installation of hooks.
2. **`dev-memo` (no arguments) / `dev-memo --help` / `dev-memo -h`**: Displayed above the formatted command usage menu.

### 2.2 Exclusions (Strict Non-Goals)
* **Never display during operational commands**: `status`, `query`, `inspect`, `doctor`, `prune`, `sync`, `extract`, `wrap`, `uninstall` must remain clean and script-friendly.
* **Never display inside agent hooks**: Internal hook execution (`SessionStart`, `PostToolUse`, `SessionEnd`) must NEVER emit the banner to avoid polluting agent context windows or burning tokens.

### 2.3 Visual Design (Variation 1: Bold Solid 3D)
```text
██████╗ ███████╗██╗   ██╗    ███╗   ███╗███████╗███╗   ███╗
██╔══██╗██╔════╝██║   ██║    ████╗ ████║██╔════╝████╗ ████║
██║  ██║█████╗  ██║   ██║    ██╔████╔██║█████╗  ██╔████╔██║
██║  ██║██╔══╝  ╚██╗ ██╔╝    ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║
██████╔╝███████╗ ╚████╔╝     ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║
╚═════╝ ╚══════╝  ╚═══╝      ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝
  Persistent Knowledge Graph for AI Coding Agents • v<version>
```

### 2.4 Technical Constraints
* **Zero external dependencies**: Use native Node.js ANSI escape sequences.
* **Dynamic Version**: Read version dynamically from project `package.json` with fallback.
* **Environment Aware**: Respect `NO_COLOR` environment variable or non-TTY stdout streams (`!process.stdout.isTTY`). Strip ANSI escape codes when colors are disabled.

---

## 3. Architecture & File Layout

### 3.1 New Module: `cli/banner.ts`
* `getBanner(options?: { noColor?: boolean; version?: string }): string`
  * Reads and caches version string from `package.json` (or accepts override for testing).
  * Returns the formatted ASCII art with cyan letters (`\x1b[36m`), bold badge, and dim tagline.
  * Honors `process.env.NO_COLOR` and `options.noColor`.

### 3.2 Updates to `cli/index.ts`
* In `runCli(args, options)`:
  * When `args.length === 0` or `args.includes("--help")` or `args.includes("-h")`:
    * Render `getBanner()` followed by formatted command descriptions and examples.
  * In `command === "install"`:
    * Prepend `getBanner() + "\n"` to the returned stdout.

### 3.3 New Unit Test: `cli/banner.test.ts`
* Tests `getBanner()` contains the exact ASCII letters `DEV-MEM`.
* Tests version string inclusion.
* Tests `NO_COLOR` ANSI suppression.

---

## 4. Verification Plan
1. `npm test` runs cleanly and all existing + new tests pass.
2. `npm run build` compiles `dist/` with no TypeScript errors.
3. Manual verification of `node dist/cli/index.js` and `node dist/cli/index.js install`.
