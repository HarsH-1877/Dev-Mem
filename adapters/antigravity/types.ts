/**
 * Antigravity lifecycle hook payload types (camelCase protojson format).
 *
 * Configured via `.agents/hooks.json` under named hook entries:
 *   - SessionStart
 *   - PreToolUse
 *   - PostToolUse
 *   - Stop
 */

export interface AntigravityBaseHookInput {
  /** Unique conversation identifier (maps to Dev-Mem session_id). */
  conversationId: string;
  /** Event name discriminator. */
  hookEventName: string;
  /** Agent working directory. */
  cwd?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
}

export interface AntigravityToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface AntigravitySessionStartInput extends AntigravityBaseHookInput {
  hookEventName: "SessionStart";
}

export interface AntigravityPreToolUseInput extends AntigravityBaseHookInput {
  hookEventName: "PreToolUse";
  toolCall: AntigravityToolCall;
  stepIdx?: number;
}

export interface AntigravityPostToolUseInput extends AntigravityBaseHookInput {
  hookEventName: "PostToolUse";
  toolCall: AntigravityToolCall;
  stepIdx?: number;
  error?: string;
}

export interface AntigravityStopInput extends AntigravityBaseHookInput {
  hookEventName: "Stop";
  executionNum?: number;
  terminationReason?: string;
  error?: string;
  fullyIdle?: boolean;
  continuationActive?: boolean;
}

export type AntigravityHookInput =
  | AntigravitySessionStartInput
  | AntigravityPreToolUseInput
  | AntigravityPostToolUseInput
  | AntigravityStopInput;

