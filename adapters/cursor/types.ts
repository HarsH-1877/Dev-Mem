/**
 * Cursor CLI hook payload types.
 *
 * Cursor's hook mechanism differs from Claude Code/Codex:
 *   - Config location: .cursor/hooks.json
 *   - Config format: Flat hooks array with camelCase event names.
 *   - SessionEnd event does NOT reliably fire in the headless CLI (cursor-agent).
 *   - Checkpoint extraction uses N-accumulated-events on postToolUse or stop instead.
 */

export interface CursorBaseHookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  model?: string;
  transcript_path?: string | null;
}

export interface CursorSessionStartInput extends CursorBaseHookInput {
  hook_event_name: "sessionStart";
  source?: string;
}

export interface CursorPreToolUseInput extends CursorBaseHookInput {
  hook_event_name: "preToolUse";
  turn_id?: string;
  tool_name: string;
  tool_use_id?: string;
  tool_input: Record<string, any>;
}

export interface CursorPostToolUseInput extends CursorBaseHookInput {
  hook_event_name: "postToolUse";
  turn_id?: string;
  tool_name: string;
  tool_use_id?: string;
  tool_input: Record<string, any>;
  tool_response: Record<string, any>;
}

export interface CursorStopInput extends CursorBaseHookInput {
  hook_event_name: "stop";
  turn_id?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

export type CursorHookInput =
  | CursorSessionStartInput
  | CursorPreToolUseInput
  | CursorPostToolUseInput
  | CursorStopInput;
