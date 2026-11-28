export * from "./types.js";

/** Flat lifecycle events registered in .agents/hooks.json without a matcher wrapper. */
export const ANTIGRAVITY_LIFECYCLE_EVENTS = [
  "SessionStart",
  "PreInvocation",
  "Stop",
] as const;

/** Tool lifecycle events registered in .agents/hooks.json with a matcher wrapper. */
export const ANTIGRAVITY_TOOL_EVENTS = [
  "PreToolUse",
  "PostToolUse",
] as const;

/** Installed Antigravity hook events written by `dev-memo install antigravity`. */
export const ANTIGRAVITY_INSTALLED_EVENTS = [
  ...ANTIGRAVITY_LIFECYCLE_EVENTS,
  ...ANTIGRAVITY_TOOL_EVENTS,
] as const;

/** All Antigravity lifecycle events accepted by the hook handler, including PostInvocation. */
export const ANTIGRAVITY_ALL_EVENTS = [
  ...ANTIGRAVITY_INSTALLED_EVENTS,
  "PostInvocation",
] as const;
