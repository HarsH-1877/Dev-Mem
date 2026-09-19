# Cursor Hooks Research Findings

## 1. Config Schema (`.cursor/hooks.json`)
The schema is **NOT** the same as Claude Code/Codex. It is a flatter structure, and natively uses `camelCase` event names rather than `PascalCase`.

*Claude Code / Codex:*
```json
{
  "hooks": {
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          { "command": "...", "type": "command" }
        ]
      }
    ]
  }
}
```

*Cursor Native:*
```json
{
  "version": 1,
  "hooks": {
    "sessionEnd": [
      {
        "command": "...",
        "matcher": "*",
        "timeout": 3
      }
    ]
  }
}
```
The adapter installer will need to generate this specific shape.

## 2. Event Coverage (CLI vs. IDE)
The CLI (`cursor-agent`) shares the underlying engine with the IDE, but its event coverage is limited to the conversational/tool execution loop. 
*   **Works in CLI:** `sessionStart`, `preToolUse`, `postToolUse`, `beforeShellExecution`, `stop` (fires at the end of an agent's "turn" / response).
*   **Fails/Unreliable in CLI:** `sessionEnd`, UI-specific events (`workspaceOpen`, etc.).

## 3. The `sessionEnd` Missing Event
The public reports are correct: `sessionEnd` in Cursor is fundamentally tied to the IDE's UI lifecycle (it fires when you close a composer tab or the main window). In the headless CLI mode, because there is no window to close, the process simply exits and `sessionEnd` **does not reliably fire**. 

## 4. Proposed Fallbacks for Extraction
Since we cannot rely on `sessionEnd` for our batched LLM extraction in CLI mode, I propose one of the following fallbacks. Please let me know which you prefer before I implement:

*   **Option A (Use `stop` hook):** Trigger extraction on the `stop` hook (which fires reliably after every agent turn). *Tradeoff:* Breaks the Milestone 3 rule of "one single batched LLM call per session." It will run extraction continuously, increasing LLM cost.
*   **Option B (Manual / Periodic Extraction):** Capture events silently during the session using `preToolUse`/`postToolUse`/`stop`, but do NOT trigger extraction automatically. Rely on the user to run `dev-mem extract <session_id>` explicitly when they are done, or schedule it as a cron job.
*   **Option C (CLI Wrapper):** Instead of relying on a Cursor hook to detect the end of the session, wrap the invocation: `dev-mem wrap cursor-agent ...`. This wrapper would spawn the CLI, capture its stdout, and natively trigger extraction the moment the child process exits.

Awaiting your decision on the fallback approach!
