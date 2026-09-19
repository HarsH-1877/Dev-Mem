/**
 * Codex CLI hook payload types.
 *
 * Codex's hook mechanism is structurally identical to Claude Code's
 * (JSON over stdin, same hookSpecificOutput/additionalContext protocol),
 * with these differences:
 *
 *   - Config location: .codex/hooks.json (vs .claude/settings.json)
 *   - Config format: separate hooks.json file (vs embedded in settings.json)
 *   - Hook can be declared async (no blocking timeout issue)
 *   - Extra field: `model` on every event
 *   - Extra field: `turn_id` on turn-scoped events (PreToolUse, PostToolUse,
 *     UserPromptSubmit, Stop)
 *   - SessionEnd is present and uses detached-spawn for extraction to bypass
 *     Codex's strict 1-3 second synchronous timeout (async flag has no effect
 *     on SessionEnd).
 */

export interface CodexBaseHookInput {
  /** Unique session identifier — same purpose as Claude Code's session_id. */
  session_id: string;
  /** Working directory for the session. */
  cwd: string;
  /** Event name discriminator. */
  hook_event_name: string;
  /** Active model slug. */
  model?: string;
  /** Path to the session transcript, if present. */
  transcript_path?: string | null;
}

export interface CodexSessionStartInput extends CodexBaseHookInput {
  hook_event_name: "SessionStart";
  /** How the session was initiated (startup, resume, etc.) */
  source?: string;
}

export interface CodexPreToolUseInput extends CodexBaseHookInput {
  hook_event_name: "PreToolUse";
  turn_id?: string;
  tool_name: string;
  tool_use_id?: string;
  tool_input: Record<string, any>;
}

export interface CodexPostToolUseInput extends CodexBaseHookInput {
  hook_event_name: "PostToolUse";
  turn_id?: string;
  tool_name: string;
  tool_use_id?: string;
  tool_input: Record<string, any>;
  tool_response: Record<string, any>;
}

export interface CodexStopInput extends CodexBaseHookInput {
  hook_event_name: "Stop";
  turn_id?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

export interface CodexSessionEndInput extends CodexBaseHookInput {
  hook_event_name: "SessionEnd";
  reason?: string;
}

export type CodexHookInput =
  | CodexSessionStartInput
  | CodexPreToolUseInput
  | CodexPostToolUseInput
  | CodexStopInput
  | CodexSessionEndInput;
