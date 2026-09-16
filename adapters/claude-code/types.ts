export interface BaseHookInput {
  session_id: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd: string;
  scratchpad_dir?: string;
  permission_mode?: string;
  effort?: { level: string };
  hook_event_name: string;
}

export interface SessionStartInput extends BaseHookInput {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact" | "fork";
  model?: string;
  agent_type?: string;
  session_title?: string;
  seconds_since_last_response?: number;
  context_tokens?: number;
  prompt_cache_likely_expired?: boolean;
  estimated_cache_write_usd?: number;
}

export interface PostToolUseInput extends BaseHookInput {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, any>;
  tool_response: Record<string, any>;
  tool_use_id: string;
  duration_ms?: number;
}

export interface StopInput extends BaseHookInput {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message: string;
  background_tasks: Array<Record<string, any>>;
  session_crons: Array<Record<string, any>>;
}

export interface SessionEndInput extends BaseHookInput {
  hook_event_name: "SessionEnd";
  reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other" | string;
}

export type ClaudeCodeHookInput = SessionStartInput | PostToolUseInput | StopInput | SessionEndInput;
