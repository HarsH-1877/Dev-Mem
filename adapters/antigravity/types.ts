import type { SafeHookPayload } from "../../core/hook-safety.js";

export type AntigravityHookEvent =
  | "SessionStart"
  | "PreInvocation"
  | "PreToolUse"
  | "PostToolUse"
  | "PostInvocation"
  | "Stop";

export interface AntigravityToolCallPayload {
  name?: string;
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
}

export interface AntigravityRawHookInput {
  conversationId?: string;
  session_id?: string;
  workspacePaths?: string[];
  cwd?: string;
  hook_event_name?: string;
  stepIdx?: number;
  prompt?: string;
  message?: string;
  toolCall?: AntigravityToolCallPayload;
  tool_call?: AntigravityToolCallPayload;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  toolOutput?: unknown;
  toolResponse?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  exitCode?: number;
  exit_code?: number;
  [key: string]: unknown;
}

export interface AntigravityNormalizedHookInput extends SafeHookPayload {
  hook_event_name: AntigravityHookEvent;
  cwd: string;
  conversationId?: string;
  workspacePaths?: string[];
  stepIdx?: number;
  prompt?: string;
  message?: string;
  toolCall?: AntigravityToolCallPayload;
  tool_call?: AntigravityToolCallPayload;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  toolOutput?: unknown;
  toolResponse?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  exitCode?: number;
  exit_code?: number;
}
