export * from "./types.js";

export const ANTIGRAVITY_LIFECYCLE_EVENTS = [
  "SessionStart",
  "PreInvocation",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

export const ANTIGRAVITY_ALL_EVENTS = [
  "SessionStart",
  "PreInvocation",
  "PreToolUse",
  "PostToolUse",
  "PostInvocation",
  "Stop",
] as const;
