# Contributing to Dev-Memo

First off, thank you for considering contributing to Dev-Memo! It's people like you that make open-source software such a great community.

## 🧠 Core Philosophy & Constraints
Before writing code, please understand the core architectural rules of this project:
1. **Zero External SDKs:** We do not use the `@anthropic-ai/sdk`, `openai`, or Google Cloud SDKs. All LLM calls are made using native Node.js `fetch`. This keeps the CLI lightweight.
2. **ESM Only:** This is a native ES Modules project. When importing local files in TypeScript, you **must** use the `.js` extension (e.g., `import { foo } from './foo.js'`).
3. **No Heavy Dependencies:** Before adding a new dependency to `package.json`, please open an issue to discuss it. We prefer native Node.js solutions wherever possible.

## 🛠️ Local Development Setup

### Prerequisites
- Node.js version 22 or higher
- Git

### 1. Fork and Clone
1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Dev-Mem.git
   cd Dev-Mem
   ```

### 2. Install Dependencies
```bash
npm install
```
*(Note: We only use devDependencies like TypeScript, Vitest, and Better-SQLite3 for local development).*

### 3. Build the Project
```bash
npm run build
```
This compiles the TypeScript files in `core/`, `cli/`, and `adapters/` into the `dist/` folder.

### 4. Test Your Local Build
To test the CLI command locally without publishing, you can run the compiled binary directly:
```bash
node dist/cli/index.js status
```
*Alternatively, you can run `npm link` to temporarily make the `dev-memo` command point to your local development folder.*

## 🧪 Testing

We use **Vitest** for unit and integration testing. Tests are co-located next to the files they test (e.g., `core/llm/llm.test.ts`).

Before submitting a pull request, ensure all tests pass:
```bash
npm test
```
To run tests in watch mode while you develop:
```bash
npm run test:watch
```

## 🚀 Pull Request Process

1. **Create a branch:** `git checkout -b feat/your-feature-name` or `fix/your-bug-fix`.
2. **Make your changes:** Write clean, documented TypeScript code.
3. **Write tests:** If you are fixing a bug or adding a feature, please add a corresponding test in the `.test.ts` files.
4. **Build and Test:** Ensure `npm run build` and `npm test` succeed.
5. **Commit:** Use clear, descriptive commit messages.
6. **Push:** `git push origin your-branch-name`.
7. **Open a PR:** Open a Pull Request on the main repository. Reference any open issues your PR resolves (e.g., "Fixes #1").

## ❓ Getting Help
If you get stuck, don't hesitate to ask for help in the issue thread you are working on. We are happy to guide you through the architecture!